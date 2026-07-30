# 目標アーキテクチャと実装のギャップ調査（2026-07-30）

**基準**: docs/architecture 01〜11 + ADR 0001〜0004 をあるべき姿とし、main（f99ee13）の実装を3領域並列で検証した。進行中の [PR #29](https://github.com/Unson-LLC/mana-runtime/pull/29)（書込遮断）・[PR #30](https://github.com/Unson-LLC/mana-runtime/pull/30)（台帳）は「進行中の埋め戻し」として区別する。

## A. 原則違反（fail-closed宣言と実装が矛盾している穴）— 最優先

### A-1. placement境界がSlackコネクタ限定【重大・未着手】

placement解決（`resolvePlacement`）を通るのはSlackの3経路のみ。**Discord / Telegram / WhatsApp は `RouteOptions = {}` で直接routeされ、placement無し＝全MCP付与・gatewayTools無制限・配信先無制限・strictMcpConfigなし**で同じJINN_HOMEに到達する（server.ts:414-724）。04章・ADR-0001のdeny-by-default宣言と正面から矛盾し、placementを何重に固めても他コネクタが迂回路になる。

**対策方針**: placements有効時は非Slackコネクタもfail-closed（placement必須化 or 受信拒否）。

### A-2. ファイル書込のハード境界ゼロ + 書込を促す文言の同居【PR #29で解消見込み】

- read-only指示はプロンプト1文のみ（対象もconfig.yaml/org/cronの3つ）。`--disallowedTools`はAskUserQuestion等のみ、`seedTrust`がJINN_HOMEを事前信頼化し書込摩擦も除去済み
- 同じプロンプト内に「You can read, write, and modify any of these files」（context.ts:432）と「persistent feedbackがあれば`~/.jinn/CLAUDE.md`を更新せよ」（context.ts:692,782）という**書込を促す文言が同居**
- PR #29は`--disallowedTools`へのdenyルール注入（bypassPermissionsでも有効・denyルール変更時cold-respawn）で塞ぐ。**マージ後、上記の促し文言の削除/条件化も必要**（PR #29のスコープ外なら追加対応）

### A-3. fail-open既定値が2箇所

- `placements`未設定時は`legacy`全許可（placement-profile.ts:113）— 移行措置として意図的だが文書未記載
- `JINN_ALLOWED_GATEWAY_TOOLS` / `JINN_ALLOWED_DELIVERY_TARGETS` の**env欠落時allow-all**（gateway-policy.ts:21,36）。placement文脈を持たない経路からgateway MCPサーバが起動されると無制限になる

### A-4. delegation tokenが子プロセスenvに渡る

`JINN_SESSION_DELEGATION_TOKEN`がClaude子プロセスenvに存在（mcp/resolver.ts:149）。session→placement引きのため単体で権限昇格はしないが、04章「シークレット非継承」原則の未明文化の例外。ADRまたは04章に例外として明記すべき。

### A-5. その他の境界所見

- `containsSecret`のキー名判定が広く、`dataScopes`に`apiKeyRotationPolicy`のような無害キーを書くと**チャンネルが丸ごと沈黙**する（症状が「無反応」になる設定ミスモード。文書未記載）
- gatewayツール追加には placement設定・TOOLS配列・route対応表（api.ts:304-324ハードコード）の**3箇所同期が既に必要** — 11章§3.2が警告した問題がgatewayツールで現実化している

## B. エージェント台帳（10章§6）— ほぼ未実装、PR #30が大半をカバー

| 項目 | main実態 | PR #30 |
|---|---|---|
| owner/purpose/enabled | 型に存在しない | 対応 |
| placement単位コスト | **sessionsにplacement_idカラム無し**。transport_meta JSON内のみ（要json_extract・索引なし・過去分バックフィル問題） | 対応（レビューでカラム昇格の有無を確認） |
| kill switch | 無し（budget pauseはemployee設定+budget設定の**二重条件付き**でしか発火しない） | 対応 |
| 変更管理 | コード支援ゼロ。さらに`PUT /api/config`という**スナップショット無しの変更経路**が存在 | 運用文書で対応 |
| 台帳ビュー | web panelにplacement画面なし（skills画面はある） | 対応（placements画面追加） |

追加発見: `cron/jobs.json`（時間トリガー定義）も同じ変更管理外で、実行時に履歴なしで上書きされる。台帳のスコープに「時間トリガー定義」を含めるべき。

## C. 脳接続・HITL・ルーティング（10章§1〜5）— 文書の過小評価が複数

- **§1 実行時Graph参照**: 対話セッションでは未実装だが、**Graphクライアントは実在し議事録パイプラインで運用実績あり**（person/project/brand/decisionの4型取得・5分キャッシュ）。技術的障壁は`buildContext`が同期関数であること
- **§2 学習ループ**: 未実装。ただし**非placement経路にのみ「knowledge/を自己更新せよ」という野良学習経路**が存在（Graph正本に繋がらないGraph直書きに近い副作用。placement=Slackマナには注入されない）。廃止か正規動線への置換が必要
- **§4 HITL**: 「個別実装1件」は数え落としで**2系統**ある。(a)議事録タスク=**register-first補償型**（先に正本登録、事後取消。「承認で続行」ではない）、(b)議事録宛先選択=**ブロッキング型**（LLM分類失敗→人間が選択→処理再開）。**型化の参照実装は(b)**。`ApproverResolver`は両パイプラインでDI共有済みで、Graph RACI実装を1本書けば両方が同時に切り替わる（残作業は文書の見積りより小さい）
- **§5 ルーティング層**: 「未実装」ではなく「**単一宛先のみ実装**」。critical-routingは決定論正規表現分類器+子セッション委譲+fail-closed+重複抑止まで動作。欠けるのは複数宛先への分類。なお既存委譲はHTTP自己呼び出し（127.0.0.1のchildren API）であり、「SessionManagerとengineの間に挿入」する設計図は実態と整合を取る必要がある

## D. 監視・可観測性

- `operator_auth_missing`毎分ポーラー: **リポジトリ内に発生源なし**（/api/statusは保護対象外なので死活監視説は棄却）。pilotホスト上の外部プロセスの可能性が高いが、**control_plane系security_eventはリクエストパスもplacementIdもconfigRevisionも持たない**ため、ログから特定できない＝可観測性のギャップ。イベントへのパス追加が先
- run receipt / pilot health timer: **リポジトリに実体なし、pilotに手置き**（systemd unitはpilot上に実在するがscripts/systemd/には無い）。配布物管理外＝脱属人化違反として回収が必要

## E. docs側の修正が必要な箇所（実装と食い違う記述）

1. 06章: event種別は2種ではなく4種（placement_resolution・derived_session追加）。run receipt/health timerは「pilot手置き・リポジトリ未管理」へ訂正
2. 10章§6: 「placementIdは既にあるので集計クエリのみ」を訂正（カラム無し・JSON内のみ）。「監査ログ✅」はcapability系限定と注記（control_planeはコンテキスト無し）。PUT /api/config経路とcron/jobs.jsonを変更管理リスクに追加
3. 10章§7表: §5を「未実装」→「単一宛先のみ実装」へ。§4に2系統（補償型/ブロッキング型）の区別を追記
4. 04章: placement境界がSlack限定である事実（A-1）、fail-open既定値（A-3）、delegation token例外（A-4）を追記
5. 11章§2: 野良学習経路（knowledge/自己更新指示）の存在と廃止方針を追記

## 推奨アクション順

1. **PR #29 merge**（書込遮断）+ 書込促し文言の削除
2. **PR #30 レビュー&merge**（台帳。placement_idカラム昇格の有無を確認）
3. **A-1修正**（非Slackコネクタのfail-closed化）— 未着手の中で最重大
4. A-3（env欠落時allow-allの既定値反転）
5. E（docs訂正）+ D（security_eventへのパス追加 → operator_auth_missing犯人特定）

---

## 対応状況（2026-07-30 追記）

| 項目 | 状態 |
|---|---|
| A-1 非Slackコネクタの迂回路 | ✅ [PR #34](https://github.com/Unson-LLC/mana-runtime/pull/34) — 全コネクタをresolveRouteOptions経由に統一 |
| A-2 書込境界 + 促し文言 | ✅ [PR #29](https://github.com/Unson-LLC/mana-runtime/pull/29) — denyルール（bypassでも有効）+ プロンプト条件化。残: Bash経由書込 |
| A-3 policy env fail-open | ✅ PR #34 — env欠落=deny-all、legacy=明示`"*"` |
| A-4 delegation token例外 | ✅ 04章に例外として明文化 |
| B 台帳 | ✅ [PR #30](https://github.com/Unson-LLC/mana-runtime/pull/30)。残: 変更管理のコード支援・placement単位budget |
| D security_eventパス | ✅ control_plane系にtarget（METHOD /path / ws-upgrade）追加。operator_auth_missingの発生源はpilotで次回観測時に特定可能 |
| E docs訂正 | ✅ 04/06/10/11章を実装に合わせ更新 |
| 未着手 | placements未設定時のlegacy全許可の文書化のみ（意図的仕様として04章に記載済み）、run receipt/health timerのリポジトリ回収、containsSecretの誤爆モード文書化 |
