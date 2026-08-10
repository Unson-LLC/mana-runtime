---
story_id: slack-split-surrogate-safe
title: Slack分割・切り詰めでサロゲートペアを分断しない
status: active
---

# Slack分割・切り詰めでサロゲートペアを分断しない

## User story

議事録をSlackへ配送する運用者として、絵文字や拡張漢字（サロゲートペア文字）を含む長文議事録でも、分割・切り詰め境界で文字が壊れずに投稿されてほしい。現状の `fitSlackOverview` と `splitForSlack`（`packages/jimmy/src/connectors/slack/meeting-minutes-generator.ts`）は、境界付近に改行・空白がない場合に `String.prototype.slice` を任意のUTF-16インデックスで適用するため、サロゲートペアの中間で切断し得る。日本語議事録は空白をほぼ含まないためこのフォールバック経路に入りやすく、切断されると lone surrogate がJSON化時に U+FFFD 化し、Slack上の文字化けやAPIエラーの原因になる。

## 受け入れ基準

- `fitSlackOverview` は上限超過時の強制切り詰めでサロゲートペアを分断しない（切り詰め位置がハイサロゲート直後に当たる場合はペアの前まで戻す）。
- `splitForSlack` はチャンク境界でサロゲートペアを分断しない（境界にペアがまたがる場合はペアの前で分割する）。
- 既存の分割優先順位（改行 > 空白 > 強制位置）と上限値の挙動は維持され、既存テストがすべて通る。

## Scope

- 対象: `packages/jimmy/src/connectors/slack/meeting-minutes-generator.ts` の `fitSlackOverview` / `splitForSlack` と対応テスト。レビューで発見された同種の生slice（`meeting-minutes-pipeline.ts` の成功通知カード overview切り詰めと宛先名75字切り詰め）も `truncateSurrogateSafe` で対象に含める。
- 非対象: Slack上限値の変更、書記素クラスタ（結合絵文字ZWJ列）単位の分割保証、他コネクタの分割処理。
