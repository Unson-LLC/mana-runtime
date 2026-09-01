# mana-reply-judgment-hook-503 本番証拠

## mana-reply-judgment-hook-503:ac:5 fresh Slack lifecycle

現状: `passed`

2026-09-02、雲孫事業運営workspaceの `#0240-mana-dev` でfresh Slack mentionを投入し、同じthreadへの回答とJudgment監査行をAPI readbackした。

## 配備前の検証

- cloud-runtime全テスト: 121 files、1186 tests 合格
- TypeScript型検査: 合格
- 雲孫事業運営向けWorkerとcontainerのdry-run build: 合格
- container build readback: `/opt/mana/reply-claude-settings.json` のCOPYを確認

## 本番readback

- deployment version: `0121f04c-cf73-4326-b9d0-ac8357ba901b`
- fresh correlation: `mana-reply-e2e-20260902-0012`
- runtime trace: `Ev0BU6DKQ9M0`
- Slack message/thread ts: `1788275510.587029`
- Slack response_ts: `1788275557.462669`
- UserPromptSubmit: Judgment Host呼出し成功。同じ実行の最終回答に判断参照監査行あり
- PostToolUse: Brainbase実呼出し0回として監査行へ記録（この入力では非該当）
- Stop: Judgment Host呼出し成功。監査行を含む本文を同じthreadへ投稿
- Slack API readback: Bot user `U0BPM8B1JTU` の返信本文に相関IDと2監査行を確認
- runtime terminal: `mana_claude_completed outcome=success` と `mana_slack_reply_posted outcome=success` を同じtraceで確認

## 同じrunで判明した別障害

- Google Drive MCPは `CREDENTIAL_LEASE_SCOPE_MISMATCH`。通常返信の復旧とは分離し、Drive能力は合格にしない。
- 監査フォールバック配備前の入力ではJCS hash不一致と監査行欠落を再現した。両方に回帰テストを追加し、上記fresh runで通常返信を再実証した。
