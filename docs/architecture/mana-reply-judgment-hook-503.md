# Architecture: Slack通常返信のJudgment Hook復旧

## 決定

Brainbaseの各実呼び出しとPostToolUse監査受領票を、配列上の件数・順序ではなくClaude Codeが発行した`tool_use_id`と`tool_name`で結合する。container wrapperはHost受領票へこの2項目を追加し、stream parserは実行済みのBrainbase callごとに同一識別子の受領票を要求する。

同じ`tool_use_id`、`tool_name`、Host receipt、監査行を持つPostToolUseの再掲は配送上の重複として1件に畳む。識別子が同じで内容が異なる場合、対応する受領票が欠ける場合、監査が未完了の場合はfail closedする。古い受領票だけで構成されたstreamは従来の順序照合を維持し、新旧受領票が混ざるstreamは受理しない。

## 検証境界

- unit: 受領票へのtool identity埋込み、同一受領票再掲の重複排除、内容不一致・欠落・未完了監査の拒否
- regression: Judgment lifecycle、Stop修復、議事録専用経路、episode receipt
- production: fresh Slack eventでquota許可、Brainbase実呼び出し、完了episode、Slack `response_ts`、同一threadの可視返信を同一eventへ結合して読む

本番で元streamを保存していないため、重複Hook応答を既発障害の確定原因とは扱わない。この変更は、現在の件数順照合が持つ識別不能性を除き、再発時にも不一致を呼び出し単位で判定できる契約修正とする。
