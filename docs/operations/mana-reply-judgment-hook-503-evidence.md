# mana-reply-judgment-hook-503 本番証拠

## mana-reply-judgment-hook-503:ac:5 fresh Slack lifecycle

現状: `not_collected`

本番配備前のため、fresh Slack eventに対する同一thread返信、Judgment lifecycle、episode receipt、`response_ts`はまだ取得していない。配備後、同じeventへ結合できる実測値だけを追記する。

## 配備前の検証

- cloud-runtime全テスト: 121 files、1186 tests 合格
- TypeScript型検査: 合格
- 雲孫事業運営向けWorkerとcontainerのdry-run build: 合格
- container build readback: `/opt/mana/reply-claude-settings.json` のCOPYを確認

## 本番readback

- fresh correlation: `not_collected`
- Slack message ts: `not_collected`
- Slack response_ts: `not_collected`
- UserPromptSubmit receipt: `not_collected`
- PostToolUse journal: `not_collected`
- Stop receipt: `not_collected`
- episode receipt: `not_collected`
