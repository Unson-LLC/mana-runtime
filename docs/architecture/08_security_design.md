# セキュリティ設計

**最終更新**: 2026-07-30

権限モデルの詳細は [04_auth_permission.md](./04_auth_permission.md)。ここでは「何を守るか」と「攻撃面ごとの対策」をまとめる。

## 1. 守るべき情報

| 資産 | 所在 | 露出したときの被害 |
|---|---|---|
| Slack botトークン（複数WS） | gateway env / config | 全ワークスペースでの成りすまし投稿・読取 |
| Anthropic等エンジン資格情報 | ryokoユーザーのCLI認証 | 課金・データ持出し |
| companion/brainbase service token | systemd EnvironmentFile / Infisical | タスク正本・Graphの読み書き |
| operator token / hook secret | gateway.json・メモリ | 管理API・フック偽装 |
| 顧客・組織データ（Graph・タスク・議事録） | 外部正本（bb.unson.jp等） | 情報漏えい。**チャンネルaudience越しの閲覧が主リスク** |

## 2. 攻撃面と対策

### 2.1 信頼できないSlack入力（最重要）

チャンネルの発話者は準外部入力として扱う。プロンプトインジェクションを前提に:

- 能力はハード境界（MCP allowlist・gatewayTools・allowedDelivery）でのみ付与。プロンプト指示は防御とみなさない
- 外部送信は `allowedDelivery` の宛先検査を通ったものだけ
- ある権限で得た会話文脈を別権限へ持ち込まない（authority rebindでtranscriptクリア）
- 全権クレデンシャルはgateway所有のツール層に置き、モデルからはツールしか見えない（[ADR-0003](../adr/0003-broad-credential-with-tool-layer-enforcement.md)）
- 共有の人格・スキル・記憶（CLAUDE.md・skills/・memory/ 等）への書込は2層で遮断: Write/Edit/MultiEdit/NotebookEditは`--disallowedTools`のdenyルール（PR #29）、Bash経由のシェル書込はPreToolUseガードhook（`assets/placement-guard.mjs`、`permissionDecision: deny`）。両方ともbypassPermissions下でもCLI側で強制される決定論的境界であり、プロンプト指示ではない。ガード・relay・per-session settings・gateway.json自体も保護対象（強制機構の自己書換を防ぐ）
- **Bashガードの残余（正直な限界）**: ガードはシェルの完全パーサではなく、代表的書込パターン（リダイレクト・tee・cp/mv/rm・sed -i・dd等、`~`/`$HOME`/相対パス/`cd`追跡込み）の検査。**変数間接参照やコマンド置換で組み立てたパス**（`P=$(...)；echo x > "$P"`）、**インタプリタのワンライナー書込**（`python -c 'open(...,"w")'`・`node -e`）、**symlink経由の別名パス**、未知の書込系コマンドは検出できない。完全化はOSレベル分離（別Unixユーザー/コンテナ、§2.2と同型）でしか達成できず、それまでこの残余は既知ギャップとして扱う

### 2.2 自己開発経路（コード実行権限）

`/ryoko-develop` はSlack入力がコード変更に到達する唯一の経路。脅威モデルは[spec](../specs/slack-self-development-runner.md)のダイアグラム参照:

- 入力境界（長さ・JSON 1行）→ シェルなし固定argv → 別Unixユーザー`ryoko-dev` → リポジトリ限定クレデンシャル → VibeProは`pr_ready`で停止（PR作成・merge・deploy・secret変更・Graph書込は不可）
- 稼働中checkoutは変更されない（隔離worktree）。root所有ラッパーの`runnerVersion`不一致はfail-closed
- 出力は固定スキーマのみ。Slackへraw stdout/stderr・外部URLを中継しない

### 2.3 ローカルAPI・フック

- gatewayはlocalhost bind。hookはloopback + 共有シークレット + サイズ上限
- placement有効時の管理mutation・機密readはoperator token必須。tokenはログ・URL・子プロセスへ出さない

### 2.4 子プロセス境界

- Claude PTY・development runnerの子環境へgatewayシークレットを継承しない
- placement下のClaudeは`strictMcpConfig`で許可外MCPを構成不能。`--mcp-config`等のflag持込は明示拒否

## 3. 監査

- すべての権限拒否は`security_event`（構造化・configRevision付き）に残る → [06_logging_monitoring.md](./06_logging_monitoring.md)
- 「エージェント台帳=placement一覧 / 監査=security_event / 停止=budget・kill switch」が他社展開時のガバナンス3点セット（roadmap柱5）

## 4. 実装時の注意（レビュー観点）

- 新しいツール・MCPを足すとき: 制限をソフト境界だけに置いていないか。トークンが子プロセスへ漏れないか
- 新しい外部送信経路を足すとき: allowedDelivery相当の宛先検査があるか
- fail-openになっていないか: 設定欠落・解決不能時に「許可」へ倒れるコードは書かない
- 秘密値をログ・エラーメッセージ・Slack返信に含めない
