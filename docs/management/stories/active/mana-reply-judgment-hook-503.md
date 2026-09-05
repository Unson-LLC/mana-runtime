---
story_id: mana-reply-judgment-hook-503
title: "Slack通常返信のJudgment Hook lifecycleを復旧する"
status: active
contract_type: bug_fix
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
- 通常返信用settingsへ切り替えた後も、Judgment Hostが返したStop修復要求をcontainer wrapperが破棄して固定文へ置換したため、runtimeは `reply_judgment_hook_failed` としてfail closedした。
- 2026-09-03のfresh E2Eではquota revision 4の判定とBrainbase取得は成功したが、PostToolUse受領票を呼び出し件数順だけで照合したため `reply_judgment_tool_audit_mismatch` でSlack投稿前にfail closedした。元streamは保存していないため、重複Hook応答が直接原因だったかは未確定とする。
- 2026-09-05の本番`--resume` retryでは、当該attemptのPostTool受領票は7件すべて結合できた一方、再開streamに残った前attemptの3呼び出しも監査対象に数え、`expected=10 / receipt=7 / bound=7 / missing=3`でfail closedした。監査の開始境界を当該attemptの`UserPromptSubmit`に固定する。
- 同日の修正配備後のfresh E2Eでは、最新attemptだけに限定しても`expected=9 / receipt=7 / bound=7 / missing=2`でfail closedした。Claude Code 2.1.195で同じ実行前拒否を再現すると、PreToolUseで拒否された呼び出しにもエラーの`tool_result`が出る一方、PostToolUseFailureは発火せず、terminal resultの`permission_denials`だけに拒否した`tool_use_id`と`tool_name`が残った。parserがエラー`tool_result`だけで実行済みと判定したことが残る2件の欠落原因である。

## 受け入れ基準

- [x] AC1: `reply` purposeでJudgment Hook eventを要求するClaude commandは、通常返信専用settingsを指定する。
- [x] AC2: 通常返信専用settingsは `UserPromptSubmit`、Brainbase MCPの成功を対象とする`PostToolUse`、失敗を対象とする`PostToolUseFailure`、`Stop`を `brainbase-judgment-hook.mjs` へ接続する。
- [x] AC3: `meeting-minutes` purposeは従来の議事録専用settingsを使い続け、通常返信用settingsへ混線しない。
- [x] AC4: container imageは通常返信専用settingsを `/opt/mana` へ読み取り専用で同梱する。
- [ ] AC5: 対象の単体テストと既存の関連テストが通り、本番配備後のfresh Slack mentionで同一threadの回答と完了したJudgment lifecycleを確認する。
- [x] AC6: 全PostToolUse/PostToolUseFailure受領票に`tool_use_id`と`tool_name`を必須とし、当該attemptの`UserPromptSubmit`以降に現れた各Brainbase受領票だけを実呼び出しへ結合する。PreToolUseで拒否された呼び出しは、terminal resultの`permission_denials`にある`tool_use_id`と`tool_name`が呼び出しおよびエラー`tool_result`へ厳密一致し、Post Tool受領票が存在しない場合だけ実行済みから除外する。成功の`tool_result`はPostToolUse、拒否以外のエラー`tool_result`はPostToolUseFailureと厳密に照合し、エラー呼び出しも記録する。同一受領票の再掲だけを1件として扱い、開始境界以降の異なる内容・識別子欠落・受領票欠落・監査欠落・未完了監査・成功失敗種別の不一致、拒否情報と結果・受領票の矛盾はfail closedする。
- [x] AC7: 監査不一致はfail closedを維持したまま固定語彙の非機密サブコードで分類し、raw stream、tool引数、回答本文、receipt IDを保存せずに本番の発火条件をreadbackできる。
- [ ] AC8: A0の外部効果照合が同一Slack messageのruntime claimを保持している間でも、T0がQueueをackできるのは、署名検証済みのtenant contextと同一tenant / effect / delivery / claim tokenへ結合された未完了reconciliation jobをDurable Objectから読めた場合だけとする。jobの欠落・不一致・読取不能、pre-send失敗、通常の`in_progress` claimは従来どおりQueue再試行を維持する。

## 非対象

- Brainbase Judgment Resolverの判断規則を変更しない。
- A0の照合保持claimを除き、Queueの再試行・エラー分類を変更しない。
- 議事録生成のHook契約を変更しない。
- `autonomy-agent`は同じ`reply` purposeを使うが、`includeJudgmentHookEvents`を指定しない別経路であり、このSlack通常返信専用settings切替の対象外とする。

## 最小の検証可能な変更

通常返信専用settingsファイルを追加し、`reply` commandとDockerfileから参照する。加えて、Slack配送payloadのJCS正規化、Stop修復要求の透過、Host receiptの回答digest検証、tenant / workspace / channel / thread scopeを必須にしたredacted episode readbackを境界テスト付きで行う。PostToolUse/PostToolUseFailure受領票は実呼び出しの識別子で結合し、成功/エラーの`tool_result`とHook種別を照合したうえで、同一受領票の再掲だけを安全に吸収する。PreToolUse拒否はCLI terminal resultの`permission_denials`にあるID・名前とエラー結果が完全一致し、Post Tool受領票が無い場合だけ実行済みから除外する。拒否情報の欠落や矛盾を推測で補完しない。未完了または空のStop監査、識別子不一致は補完せずfail closedする。監査不一致のreason codeには固定語彙の分岐サブコードだけを含め、入力値や受領票内容は含めない。A0が外部効果照合のために保持したclaimでも、T0はDurable Objectから読んだ未完了jobが署名検証済みcontext、tenant / effect / delivery / claim tokenと完全一致するときだけ同一messageのQueue配送をackする。それ以外はpre-send失敗を含め再試行する。議事録経路は変更しない。
