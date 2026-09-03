# mana-reply-judgment-hook-503 本番証拠

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
