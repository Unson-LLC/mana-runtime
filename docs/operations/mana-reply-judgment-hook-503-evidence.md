# mana-reply-judgment-hook-503 本番証拠

## 2026-09-04 監査不一致の診断証拠

### 再現と発生箇所

- 本番Worker `f5047245-ca0d-475d-97e9-5129c7ebfeeb` へ固定検証ID `e2e-20260904-worker-only-lifecycle-a7f3` のSlackメンションを1回だけ投入した。
- 初回trace `Ev0BUTUT4E5Q` はBrainbase制御呼び出しとHook HTTP 200の後、`reply_judgment_tool_audit_mismatch`で停止した。自動再試行trace `Ev0BUVT0FC73`も完了せず、Slack返信、`response_ts`、completed episodeは読戻せなかった。
- 発生箇所は `packages/cloud-runtime/src/reply-judgment.ts` の `parseReplyJudgmentStream` に限定した。同関数には実ストリームから到達可能で性質の異なる9個の監査不一致分岐があり、従来はすべて同じエラーコードへ圧縮されていた。

### 関係分析と前提確認

- データフロー、制御フロー、非同期フロー、モジュール境界、変更履歴を確認した。
- 未宣言変数、parser stateのretry間漏洩、await順序、初期化タイミング、settings生成、PostToolUse matcher、`--include-hook-events`、packaged assetsの意味的不一致は根因として棄却した。
- 既存の合成fixtureはproduction streamの複数block、replay、interleave、Stop repairを過少近似しており、保存済み証拠から実ストリームのunderlying mismatchを一意に確定することはできない。
- 実装、テスト、GitHub、Cloudflare readbackに必要な前提は確認済み。秘密値、tenant boundary handle、raw Claude JSONLは成果物へ保存しない。

### 確認済みの根本原因と修正

- 確認済みの根本原因は、到達可能な9種類の監査不一致が単一の `reply_judgment_tool_audit_mismatch` に圧縮され、安全な本番証拠から発火条件を特定できないこと。
- 各分岐へ固定語彙の非機密サブコードを割り当て、既存のfail-closed動作と `reply_judgment_tool_audit_mismatch` 接頭辞を維持した。代表サブコードが `mana_claude_failed`、`mana_reply_failed`、永続episodeの `failureCode` へ同値で伝播し、raw streamを残さないこともpipelineテストで固定した。
- raw stream、tool引数、回答本文、receipt ID、tenant情報はreason codeへ含めない。
- underlying mismatchとSlack無応答そのものの根本原因はまだ `unknown`。この変更の本番配備後、fresh E2Eで安全なサブコードを読戻して次の根本修正を決める。

### 配備前検証

- 監査分岐と返信pipelineの対象テスト: 2 files、88 tests 合格。
- cloud-runtime全テスト: 122 files、1238 tests 合格。
- cloud-runtime TypeScript型検査: 合格。
- JSON構文検査と `git diff --check`: 合格。
- 本番の同一Slack経路による再検証は未実施。配備後に新しい検証IDで1回だけ送信し、サブコードまたは正常返信をreadbackする。

## mana-reply-judgment-hook-503:ac:5 fresh Slack lifecycle

現行HEADの状態: `not_collected`

この文書に残る2026-09-02の結果は、実装commit `9098c6ea57fe22db332ccb77d9edceedbf01926b` に対する履歴証跡である。後続の2026-09-03 fresh E2Eではquota revision 4の適用とBrainbase取得までは成功したが、`reply_judgment_tool_audit_mismatch` によりSlack投稿前にfail closedした。その後のPostToolUse identity binding修正を含む現行HEADについて、本番配備後のfresh Slack mention、完了episode receipt、`response_ts`、同一thread表示の一連のreadbackはまだ収集していない。

したがって、以下の旧結果を現行HEADのAC5合格証拠には使用しない。現行HEADを配備後、同一fresh eventで一連のreadbackが揃った場合だけ `passed` へ更新する。

## 2026-09-02の履歴証拠（現行HEADには未適用）

2026-09-02、雲孫事業運営workspaceの `#0240-mana-dev` で修正版配備後にfresh Slack mentionを投入し、同じthreadへの回答とJudgment監査行をSlack APIとruntime logの両方でreadbackした。

## 原因と修正

- Judgment Hostは最初のStopで修復要求を正しく返していたが、container wrapperが`decision`と`reason`を破棄し、未完了監査の固定文へ置き換えていた。
- wrapperがHostの修復要求を保持するようにし、修復後StopではHost receiptの`answer_digest`と最終回答本文のSHA-256一致を必須化した。
- runtime parserはStopが監査未完了を明示した場合に、PostToolUseの証拠だけで回答を昇格させないfail-closed動作へ変更した。
- 永続episodeはtenant / workspace / channel / threadをすべて照合し、同一event IDのtenant間再利用も拒否する。

## 配備前の検証

- focused Judgmentテスト: 30 tests 合格。tenant境界追加後のreply-judgmentテスト: 16 tests 合格
- cloud-runtime全テスト: 121 files、1196 tests 合格
- cloud-runtime TypeScript型検査: 合格
- workspace全体のTypeScript型検査: 合格
- 雲孫事業運営向けWorkerとcontainerのdry-run build: 合格
- container build readback: `/opt/mana/reply-claude-settings.json` と `/opt/mana/brainbase-judgment-hook.mjs` のCOPY・権限を確認

## 本番readback

- implementation commit: `9098c6ea57fe22db332ccb77d9edceedbf01926b`
- deployment authorization commit: `49b2b65e527cd6e2b08f13ede4cbef886c303bc7`
- Worker version: `fe4d9e2c-a1a8-4bfe-9edd-736870932f34`
- container version / image: `117` / `sha256:77c93b8dd136334db80a1d6fcdb1a14534c7ecc9793f6988827cd1784620b1c2`
- container readback: 6 instances healthy、0 starting、0 failed
- fresh Slack message/thread ts: `1788280991.181929`
- runtime trace / event ID: `Ev0BU99B6BMX`
- Slack response_ts: `1788281019.500389`
- Slack API readback: Bot user `U0BPM8B1JTU` が同じthreadへ2監査行と`本番返信確認OK 0143`を1件返信
- runtime readback: 同じtraceで`mana_claude_completed outcome=success`、`mana_slack_reply_posted outcome=success`、`tenant_queue_completed`を確認
- Slack再送readback: 同じmessage/threadの再送は完了し、重複返信なし

## 能力別のfresh判定

同じWorker versionで `1788281050.877689` に `/doctor` を投入し、`1788281060.877249` の返信をSlack APIでreadbackした。

- 合格: Slack受信、通常メンション返信、同一thread投稿、Judgment UserPromptSubmit / Stop、Task API設定・tenant transport、Graph設定・tenant transport、NocoDB設定・tenant transport
- 不合格: Brainbase MCP transport（HTTP 406）、Google Drive MCP transport（接続失敗。通常返信実行時のruntime logでは`CREDENTIAL_LEASE_SCOPE_MISMATCH`）
- 未確認: Graphの実データ操作、NocoDBの実データ操作、タスク検索の正常結果。設定・transport正常を実操作成功へ読み替えない

## 残存障害

- Google Drive MCPは`CREDENTIAL_LEASE_SCOPE_MISMATCH`。通常返信の復旧とは分離し、Drive能力は合格にしない。
- Brainbase MCPはtrusted provider forwarder経路でHTTP 406。通常返信とJudgment lifecycleの復旧とは分離し、Brainbase検索能力は合格にしない。
- 修正前の能力確認入力ではTask検索が`task_search_upstream_unavailable`となった。今回のfresh `/doctor`は設定・tenant transportまでの検査なので、タスク検索の正常結果は未確認のままとする。
