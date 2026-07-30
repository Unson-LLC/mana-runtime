# 認証・権限設計

**最終更新**: 2026-07-30

mana-runtimeの権限設計は一貫して **deny-by-default / fail-closed** である。未定義の能力は拒否され、解決不能な状態（placement不一致・config不正・親セッション不在）は権限昇格ではなく拒否に倒す。

## 1. 境界の2層構造 — ソフト境界とハード境界

この区別が本設計の中核。**新しい能力（MCP・ツール・データソース）を追加する時は、必ず「制限をどの層で強制するか」を先に決める。**

| | ソフト境界 | ハード境界 |
|---|---|---|
| 実装 | system promptへの注入（`projects` / `dataScopes`、[context.ts](../../packages/jimmy/src/sessions/context.ts)） | コードによる強制（MCP allowlist・route束縛・argv固定・スキーマ検証） |
| 守れる相手 | 素直なモデルの判断ミス | プロンプトインジェクション・モデルの誤動作を含むすべて |
| 用途 | 行動指針・参照範囲の宣言・文脈の限定 | 能力そのものの付与/剥奪・秘密・外部送信 |

**原則: 権限昇格が起きうる制限をソフト境界だけに置いてはならない。** 例: Drive全権トークンを渡してフォルダ制限をdataScopesに書くのは禁止。フォルダ許可リストはツール層（MCPプロキシ）でリクエストごとに検査する（[ADR-0003](../adr/0003-broad-credential-with-tool-layer-enforcement.md)）。

## 2. placement — チャンネル単位の権限プロファイル

Slackチャンネル1つにつき設定1枠（`~/.ryoko/config.yaml` の `placements:`、pilotが正本・hot-reload）。仕様の正本は [channel-placement-profiles spec](../specs/channel-placement-profiles.md)。

```yaml
- id: <placement-id>            # 管理用ラベル。ログ・security_eventに出る
  connector: slack
  workspaceId: T…
  channelId: C…
  audience:                     # 誰の発話に応じるか
    type: operator
    allowedUsers: [U…]
  agent:                        # 担当employee・モデル・重要レビュー担当の上書き
    defaultModel: sonnet
    escalationEmployee: critical-reviewer
  projects: [unson]             # ソフト境界: 担当範囲の宣言
  capabilities:                 # ハード境界: 明示したものだけ許可
    mcp: [brainbase, nocodb, gateway]
    gatewayTools: [create_task, list_tasks, …]
    allowedDelivery:            # 外部送信先の制限（これ以外へ投稿不可）
      - {connector: slack, channel: C…}
  dataScopes:                   # ソフト境界: 参照範囲の宣言
    graph: {mode: read-only, scopes: [org:unson]}
```

### 解決とfail-closed

- connector・workspace・channel・userが**一意に**一致するplacementだけにルーティング。未登録・曖昧一致・許可外ユーザーは実行前に拒否
- `capabilities` 未設定のplacementは**全MCP拒否**で動く（データ参照なしの一般論回答になる。これは仕様。2026-07-30の事業運営チャンネル初期不良の原因）
- 拒否はすべて `security_event`（`mcp_denied` 等）として構造化ログに残る

### 3層ゲート（ツール実行の多重防御）

1. **コード内route束縛** — タスク系routeはplacement文脈に束縛
2. **placement `gatewayTools`** — gateway MCPが明示リストだけを公開・実行
3. **`interactiveAllowedTools`** — Claude PTY起動時の`--allowedTools`

### エンジン境界

- placement下で実行できるエンジンは claude / mock のみ（`runPlacementBoundEngine` が唯一のchoke point）
- `strictMcpConfig: true` + `enableChrome: false` を強制。employee側cliFlagsの `--mcp-config` 等は明示拒否
- rate limit時のcodex等への自動フォールバックはplacement下では**行わない**（権限の異なるエンジンへ静かに切り替えない）

### 権限バインドの継続性（authority rebind）

同一placement・同一engine・同一employee・stale override metaなしの場合のみ、エンジン会話（engineSessionId）を継続する。バインドが変わった場合はengineをkillしtranscriptをクリアする（ある権限下で得た文脈を別権限へ持ち込まない）。経緯は [ADR-0002](../adr/0002-placement-rebind-transcript-clearing.md)。

### 派生セッション

子セッション・cross-requestは**実在する親セッションを必須**とし、親placementを継承。engine/model/effortのリクエスト上書きは拒否。許可外employeeへの委譲は拒否。

## 3. 認証方式

| 経路 | 認証 |
|---|---|
| Slack | socket mode（botトークンはenv-backed、named instanceごと） |
| gateway HTTP/WS（localhost:7777） | placement有効時、管理mutation・機密read・WebSocketは**operator token**必須。token原文は設定API・ログ・URL・Claude子プロセスに出さない |
| hook中継（`/api/internal/hook`） | loopback限定 + 共有シークレット（`x-jinn-hook-secret`）。ボディサイズ上限あり |
| companion task API | service token（`svc_*`、Infisical管理、期限付き）。エージェントにdelete権限なし |
| Discord remote proxy | 専用service principal必須。missing/wrong tokenは拒否 |

## 4. シークレット取り扱いの原則

- **子プロセス非継承**: Claude PTY・development runnerの子環境にSlackトークン等のgatewayシークレットを渡さない
- **placement解決・能力解決・ログに秘密値を含めない**（`security_event`は構造化フィールドのみ）
- 全権クレデンシャルを持つのはgateway所有のプロキシ層だけ。モデルには能力（ツール）だけを見せる

## 5. 自己開発の特権分離（/ryoko-develop）

Slackからの自己開発は通常の会話権限と完全に分離する（[spec](../specs/slack-self-development-runner.md)）:

- ユーザーallowlist + チャンネルallowlist（どちらも空ならfail-closed）
- gatewayはシェルを構成しない: 絶対パス+固定argvの`sudo -n -u ryoko-dev`、リクエストはstdinのJSON 1行のみ
- 実装は別Unixユーザー`ryoko-dev`の隔離worktreeでVibePro guarded実行。**PR作成・merge・deployは人間の明示操作**（`pr_ready`で停止）
- 結果は固定JSONスキーマのみ受理。raw stdout/stderr・任意URLはSlackへ中継しない

## 6. 運用ルール

- placement新設時は `capabilities`・`projects`・`agent` まで書く（雛形: 既存の `mana-backoffice` ブロック）。空のまま運用しない
- 能力追加時のチェック: 「この制限はどの層で強制されるか？」「チャンネルaudience全員に見せてよい範囲か？」
- 変更前バックアップ: `config.yaml.bak-<date>-<intent>`
