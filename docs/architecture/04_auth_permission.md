# 認証・権限設計

**最終更新**: 2026-07-31

mana-runtimeの権限設計は一貫して **deny-by-default / fail-closed** である。未定義の能力は拒否され、解決不能な状態（placement不一致・config不正・親セッション不在）は権限昇格ではなく拒否に倒す。

## 1. 境界の2層構造 — ソフト境界とハード境界

この区別が本設計の中核。**新しい能力（MCP・ツール・データソース）を追加する時は、必ず「制限をどの層で強制するか」を先に決める。**

| | ソフト境界 | ハード境界 |
|---|---|---|
| 実装 | system promptへの注入（[context.ts](../../packages/jimmy/src/sessions/context.ts)）。**能力宣言は`capabilities`から自動生成**（MCPサーバー・gatewayTools・allowedDelivery、恒常denyツールの併記込み）。手書き`projects` / `dataScopes`は参照範囲の**補足**としてのみ注入 | コードによる強制（MCP allowlist・route束縛・argv固定・スキーマ検証） |
| 守れる相手 | 素直なモデルの判断ミス | プロンプトインジェクション・モデルの誤動作を含むすべて |
| 用途 | 行動指針・参照範囲の宣言・文脈の限定 | 能力そのものの付与/剥奪・秘密・外部送信 |

**原則: 権限昇格が起きうる制限をソフト境界だけに置いてはならない。** 例: Drive全権トークンを渡してフォルダ制限をdataScopesに書くのは禁止。フォルダ許可リストはツール層（MCPプロキシ）でリクエストごとに検査する（[ADR-0003](../adr/0003-broad-credential-with-tool-layer-enforcement.md)）。

## 2. placement — チャンネル単位の権限プロファイル

Slackチャンネル1つにつき設定1枠（`~/.ryoko/config.yaml` の `placements:`、pilotが正本・hot-reload）。仕様の正本は [channel-placement-profiles spec](../specs/channel-placement-profiles.md)。

> **注**: config.yaml手書きが権限の正本であるのは**暫定の現在地**。目標はGraphのオントロジー（RACI・権限定義）を正本とし、placement設定をその写像として生成すること（[10_company_brain.md §4](./10_company_brain.md)）。

```yaml
- id: <placement-id>            # 管理用ラベル。ログ・security_eventに出る
  connector: slack
  workspaceId: T…
  channelId: C…
  audience:                     # 誰の発話に応じるか
    type: operator              # 静的allowlist型（operator/executive/project-team/client）
    allowedUsers: [U…]          # または type: channel-members（下記）— allowedUsers不要
  agent:                        # 担当employee・モデル・重要レビュー担当の上書き
    defaultModel: sonnet
    escalationEmployee: critical-reviewer
  projects: [unson]             # ソフト境界: 担当範囲の宣言
  capabilities:                 # ハード境界: 明示したものだけ許可
    mcp: [brainbase, nocodb, gateway]
    gatewayTools: [create_task, list_tasks, …]
    allowedDelivery:            # 外部送信先の制限（これ以外へ投稿不可）
      - {connector: slack, channel: C…}
  dataScopes:                   # ソフト境界: 参照範囲の補足（能力の正本ではない）
    graph: {mode: read-only, scopes: [org:unson]}
```

**ソフト境界宣言の自動生成（2026-07-31, gap-analysis G3)**: system promptの「Placement policy」節に入る「利用できる能力」は`capabilities`から自動生成される — `capabilities.mcp`の各サーバー（`PLACEMENT_MCP_TOOL_DENY`で恒常denyされるツールは「except always-denied」を併記）・`gatewayTools`・配信可能先（`allowedDelivery`、未設定なら自チャンネル）。`dataScopes`は引き続き注入されるが、read-onlyモードやgraph scopesのような**参照範囲の補足**であり、能力を付与も剥奪もしないとプロンプト内で明示する。これにより「capabilitiesに足したがdataScopesに書き忘れてモデルが自主拒否」「能力の無いplacementに宣言だけ残る」という手書き同期の乖離事故（2026-07-31 freee接続障害）を構造的に防ぐ。

### 解決とfail-closed

- **全コネクタ**（Slack/Discord/Telegram/WhatsApp）が単一のルーティングゲート `resolveRouteOptions` を通る。placements設定時、どのコネクタでも一意なplacementに解決できないメッセージは実行前に拒否（2026-07-30まで非Slackコネクタが迂回路だった — gap-analysis A-1で閉鎖）
- connector・workspace・channel・userが**一意に**一致するplacementだけにルーティング。未登録・曖昧一致・許可外ユーザー・`enabled: false` は実行前に拒否
- `capabilities` 未設定のplacementは**全MCP拒否**で動く（データ参照なしの一般論回答になる。これは仕様。2026-07-30の事業運営チャンネル初期不良の原因）
- 拒否はすべて `security_event`（`mcp_denied` 等）として構造化ログに残る
- **`audience.type: channel-members`**（2026-07-31）: 静的allowedUsersの代わりに、発話者がそのSlackチャンネルのメンバーかを `conversations.members`（TTLキャッシュ付き）で判定する。メンバー管理をSlack自身のアクセス制御へ委任する（[ADR-0004](../adr/0004-no-second-permission-system.md)の適用）。API失敗・判定不能・membership照会を持たないコネクタはすべて拒否（fail-closed）
- **個人KGの恒常遮断**: 全placementセッションの `--disallowedTools` に `mcp__brainbase__search_personal_kg` が常に含まれる（[placement-profile.ts](../../packages/jimmy/src/shared/placement-profile.ts) `PLACEMENT_MCP_TOOL_DENY`）。brainbase MCPを許可するチャンネルでも佐藤個人のKGはどのチャンネルにも出さない

### 招待による自動プロビジョニング（2026-07-31）

「招待できる人は権限判断を済ませている」を信頼境界として、bot自身への `member_joined_channel` でそのチャンネルのplacementを標準プロファイルで自動生成する（[placement-autoprovision.ts](../../packages/jimmy/src/shared/placement-autoprovision.ts)）:

- **標準プロファイル**: audience channel-members / owner=招待者 / purpose=`auto-provisioned (invited by <user>)` / sonnet + critical-reviewer / mcp [brainbase, gateway] / gatewayTools task系5種 / allowedDelivery省略（自チャンネルのみ） / dataScopes graph read-only / monthlyBudgetUsd 10。config.yamlの `placementDefaults` でフィールド単位に上書き可、`placementDefaults.autoProvision: false` で停止
- **書込経路**: 必ずconfig-historyスナップショット（source: `auto-provision`）→ 一時ファイル+アトミック置換。失敗時はconfig無変更で従来どおり全拒否（fail-closed）
- **ガード**: `placements:` キー未構成のインスタンスでは発動しない（初placement追加で他チャンネルが全拒否へ切り替わる事故防止）。既存placement（`enabled: false` 含む）のチャンネルでは何もしない（再招待で無効化を蘇生させない）
- **挨拶**: 生成成功時に1回だけ、標準プロファイルで動く旨・owner・できること3行・昇格経路（owner→operator）をチャンネルへ投稿
- **退出**: `channel_left` / `group_left` で該当placementを `enabled: false` へ（削除しない=監査痕跡維持）
- **昇格はスコープ外**: nocodb・他チャンネル配信・cron・budget増額は従来どおりconfig手編集（HITL型化後に接続予定）

### 3層ゲート（ツール実行の多重防御）

1. **コード内route束縛** — タスク系routeはplacement文脈に束縛
2. **placement `gatewayTools`** — gateway MCPが明示リストだけを公開・実行
3. **capabilities由来の`--allowedTools`**（2026-07-31、gap G1+G4解消） — placementセッションのallowルールは `capabilities` から**spawnごとに導出**される（[placement-profile.ts](../../packages/jimmy/src/shared/placement-profile.ts) `placementAllowedTools`）: `capabilities.mcp` の各サーバー → `mcp__<server>__*`（サーバー全体許可）、`capabilities.gatewayTools` → `mcp__gateway__<tool>`（個別許可）。グローバル設定 `engines.claude.interactiveAllowedTools` は**非placementセッション専用**となり、placementはこれに依存しない（能力の正本はcapabilitiesただ1箇所）。導出はrun毎の純関数なのでconfig hot-reloadが次spawnから反映され、gateway再起動は不要。warm PTYへはspawn境界鍵（allow+deny+Bashガード）の変化でcold-respawnして反映する。恒常deny（`PLACEMENT_MCP_TOOL_DENY`）は `--disallowedTools` としてallowに常に勝つ — freee書込系5ツール（`freee_api_post/put/delete/patch`・`freee_file_upload`）はここで全placement遮断（G2のread-only語彙導入までの暫定read-only）

### エンジン境界

- placement下で実行できるエンジンは claude / mock のみ（`runPlacementBoundEngine` が唯一のchoke point）
- `strictMcpConfig: true` + `enableChrome: false` を強制。employee側cliFlagsの `--mcp-config` 等は明示拒否
- rate limit時のcodex等への自動フォールバックはplacement下では**行わない**（権限の異なるエンジンへ静かに切り替えない）

### 権限バインドの継続性（authority rebind）

同一placement・同一engine・同一employee・stale override metaなしの場合のみ、エンジン会話（engineSessionId）を継続する。バインドが変わった場合はengineをkillしtranscriptをクリアする（ある権限下で得た文脈を別権限へ持ち込まない）。経緯は [ADR-0002](../adr/0002-placement-rebind-transcript-clearing.md)。

### 派生セッション

子セッション・cross-requestは**実在する親セッションを必須**とし、親placementを継承。engine/model/effortのリクエスト上書きは拒否。許可外employeeへの委譲は拒否。

### スキル・記憶の権限

placementが制御するのはツール・MCPだけではなく、**セッションに何を見せるか**（スキル・記憶）も含む。権限モデルは [11章§3](./11_persona_skills_memory.md) を正とする — 要点: ランタイムに独自の権限体系を作らず、業務の記憶はbrainbaseのRACI/projectに判定させ、ランタイム側は「記憶3層（脳/placementローカル/共通）」と「capabilities+scopeからのスキル可視性導出」のフィルタだけを持つ。現状はフィルタ未実装（全共有）であり、目標とのギャップは11章§7。

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
  - 明文化された例外: `JINN_SESSION_DELEGATION_TOKEN`（session→placement束縛の委譲トークン）は子プロセスenvに渡る。トークン単体では自セッションのplacement権限を超えられない設計だが、例外であることをここに記録する
- **gateway MCPのpolicy envはfail-closed**: resolverが常に`JINN_ALLOWED_GATEWAY_TOOLS`等を明示設定（placement=許可リスト、legacy=`"*"`）し、env欠落＝resolver外からの起動は全拒否（gap-analysis A-3で反転）
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
- **設定ミスの既知の症状**: placement定義のどこかに秘密値らしきものがあると`invalid_config`でチャンネルが**丸ごと無反応**になる。判定はキー名ベースで広く、`apiKeyRotationPolicy`のような無害キーでも発動する。manaが無言になったらまず `journalctl | grep placement_missing_after_config_change` を確認し、直近のconfig変更のキー名を疑う
