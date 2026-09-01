---
story_id: mana-reply-judgment-hook-503
title: "Slack通常返信のJudgment Hook lifecycleを復旧する"
status: active
source:
  type: production-e2e
  id: mana-cap-e2e-20260901-1788265044398
related_stories:
  - story-slack-mention-brainbase-judgment
---

# Slack通常返信のJudgment Hook lifecycleを復旧する

## 利用者価値

雲孫事業運営ワークスペースでまなへ通常の質問をメンションした利用者として、制御コマンドだけでなく通常回答でもBrainbase Judgment lifecycleが完了し、同じSlackスレッドで回答を受け取りたい。

## 確認済みの不具合

- 本番のfresh E2E `mana-cap-e2e-20260901-1788265044398` では `/status` と `/cron` は応答したが、通常質問、タスク、開発依頼は応答しなかった。
- 通常返信のClaude commandが `hooks` の空な議事録用settingsを指定していた。
- そのため `UserPromptSubmit` と `Stop` が発火せず、runtimeは `reply_judgment_hook_failed` としてfail closedした。

## 受け入れ基準

- [x] AC1: `reply` purposeでJudgment Hook eventを要求するClaude commandは、通常返信専用settingsを指定する。
- [x] AC2: 通常返信専用settingsは `UserPromptSubmit`、Brainbase MCPを対象とする`PostToolUse`、`Stop`を `brainbase-judgment-hook.mjs` へ接続する。
- [x] AC3: `meeting-minutes` purposeは従来の議事録専用settingsを使い続け、通常返信用settingsへ混線しない。
- [x] AC4: container imageは通常返信専用settingsを `/opt/mana` へ読み取り専用で同梱する。
- [x] AC5: 対象の単体テストと既存の関連テストが通り、本番配備後のfresh Slack mentionで同一threadの回答と完了したJudgment lifecycleを確認する。

## 非対象

- Brainbase Judgment Resolverの判断規則を変更しない。
- Queueの再試行・エラー分類を変更しない。
- 議事録生成のHook契約を変更しない。
- `autonomy-agent`は同じ`reply` purposeを使うが、`includeJudgmentHookEvents`を指定しない別経路であり、このSlack通常返信専用settings切替の対象外とする。

## 最小の検証可能な変更

通常返信専用settingsファイルを追加し、`reply` commandとDockerfileから参照する。加えて、Slack配送payloadのJCS正規化と、信頼済みStop監査行をモデルが本文へ転記しない場合の決定論的な補完を、境界テスト付きで行う。Queueの再試行方針と議事録経路は変更しない。
