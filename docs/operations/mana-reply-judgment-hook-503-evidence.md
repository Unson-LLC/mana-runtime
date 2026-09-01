# mana-reply-judgment-hook-503 本番証拠

## mana-reply-judgment-hook-503:ac:5 fresh Slack lifecycle

現状: `passed`

2026-09-02、雲孫事業運営workspaceの `#0240-mana-dev` でfresh Slack mentionを投入し、同じthreadへの回答とJudgment監査行をAPI readbackした。

## 配備前の検証

- cloud-runtime全テスト: 121 files、1193 tests 合格
- workspace全体のTypeScript型検査: 合格
- 雲孫事業運営向けWorkerとcontainerのdry-run build: 合格
- container build readback: `/opt/mana/reply-claude-settings.json` のCOPYを確認

## 本番readback

- implementation commit: `b23cd352e40cd514e6f7acd9b82825831ada20f5`
- deployment version: `382f9ff6-38e5-4bbf-9051-86e0d7b40ba0`
- fresh correlation: `mana-receipt-e2e-20260902-0058`
- runtime trace / event ID: `Ev0BUAJ62LR2`
- Slack message/thread ts: `1788278305.966519`
- Slack response_ts: `1788278376.743039`
- UserPromptSubmit: Judgment Host呼出し成功。同じ実行の最終回答に判断参照監査行あり
- PostToolUse: Brainbase実呼出し0回として監査行へ記録（この入力では非該当）
- Stop: Judgment Host呼出し成功。監査行を含む本文を同じthreadへ投稿
- Slack API readback: Bot user `U0BPM8B1JTU` の返信本文に相関IDと2監査行を確認
- runtime terminal: `mana_claude_completed outcome=success` と `mana_slack_reply_posted outcome=success` を同じtraceで確認
- 永続episode readback: tenant / workspace / channel / threadを完全指定した管理用readbackで、attempt `9372a7db-8e4f-47c6-902d-e2b7266de3a9` の `status=completed`、`userPromptSubmit=completed`、`stop=completed`、上記 `responseTs` との一致を確認
- Host receipt: `jr_13993384-e46b-4fd2-be51-190e475060d3`
- completedAt: `2026-09-01T15:59:36.970Z`

## 能力別の同run判定

- 合格: Slack受信、通常メンション返信、同一thread投稿、Judgment UserPromptSubmit / Stop、Task API transport、NocoDB transport
- 不合格: Brainbase MCP transport（`/doctor` で HTTP 406）、Google Drive MCP（connection failure。個別呼出しでは `CREDENTIAL_LEASE_SCOPE_MISMATCH`）
- 未確認: Graphの実操作、タスク検索の正常結果。Task検索は `task_search_upstream_unavailable` のため0件扱いにしない

## 同じrunで判明した別障害

- Google Drive MCPは `CREDENTIAL_LEASE_SCOPE_MISMATCH`。通常返信の復旧とは分離し、Drive能力は合格にしない。
- Brainbase MCPはtrusted provider forwarder経路でHTTP 406。通常返信とJudgment lifecycleの復旧とは分離し、Brainbase検索能力は合格にしない。
- 監査フォールバック配備前の入力ではJCS hash不一致と監査行欠落を再現した。両方に回帰テストを追加し、上記fresh runで通常返信を再実証した。
- 最初のepisode readback実装は論理tenant名をDurable Object keyへ使用し、canonical tenant IDで保存されたepisodeを読めなかった。readback URLに明示したtenant IDを完全scope検証後に使用するよう修正し、上記fresh runで再実証した。
