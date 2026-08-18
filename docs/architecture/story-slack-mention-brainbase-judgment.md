# Architecture: Slack通常回答のBrainbase判断ライフサイクル

## 決定

通常のSlack `reply`実行にも、議事録で実績のあるBrainbase Judgment command Hooksとtrusted proxyを適用する。判断規則、active DAG、正本ルーティング、監査文言はBrainbase Hostを正本とし、mana-runtimeへ複製しない。

mana-runtimeはClaudeの`stream-json`を検証し、同じsession・turnに属する`UserPromptSubmit`、Brainbase tool journal、`Stop`、最終回答が揃ったときだけSlackへ投稿する。検証結果はWorkspace filesystemのepisode receiptへattempt履歴として保存し、投稿後にSlack `response_ts`を結合する。

## データフロー

1. Workerがplacement認可、依頼者identity、Graph文脈、thread文脈を従来どおり確定する。
2. Workerがpromptとplacement由来のMCP configを書き、通常回答用Claude commandをJudgment settings、`stream-json`、`--include-hook-events`付きで起動する。
3. `UserPromptSubmit` Hookがtrusted proxy経由でBrainbase Hostを呼び、Hostが初期route、active nodes、追加指示を同じturnへ束縛する。Hostが返すcanonical `hookSpecificOutput.additionalContext`、route receipt ID、route receipt SHA-256 digestをforwarderが検証し、digestを表示文から再生成せず同じturnへ引き継ぐ。
4. ClaudeはHostの指示に従って必要なBrainbase MCP toolと、そのrouting receiptが返した取得capabilityを実行する。各Brainbase tool call後の`PostToolUse`を同じturnへ記録する。
5. `Stop` Hookが必須node、取得、監査をBrainbase Hostで検証する。不足があればHook exit 2で停止または継続させ、未完了出力を通常回答として採用しない。
6. Workerがstreamを解析し、Hook event順序、session、turn、監査行、tool journal、最終resultを検証する。成功時だけepisode attemptを`audited`として保存する。
7. Slack投稿後、同じepisode attemptへ`response_ts`と完了時刻を追記し、既存reply completionも保存する。

## Episode receipt

`/judgment-episodes/<event_id>.json`に、本文とsecretを含めず次を保存する。

- Slack `event_id`、workspace、channel、thread
- attempt ID、開始・監査・失敗・完了時刻、状態、失敗理由
- Claude session ID、Brainbase turn ID
- Hostのroute resolution識別情報
- 記録順を保ったBrainbase tool journalとHost監査行
- `UserPromptSubmit`と`Stop`の検証結果
- Slack `response_ts`

同一eventの完了済みreceiptは再利用し、再配送でepisodeと返信を重複作成しない。失敗後のQueue retryは同じevent receiptへ新しいattemptを追加し、過去の失敗を上書きしない。

Slack投稿成功後にepisodeの完了保存が失敗した場合も、再試行ではSlack `event_id`から導出した同一の`client_msg_id`を再利用する。Slack側の重複排除結果として返る同一`response_ts`を新しいattemptへ結合し、可視返信を増やさずreceiptを収束させる。`client_msg_id`をattempt IDや乱数へ変更してはならない。

## 信頼境界

- SandboxへBrainbase tokenを渡さず、proxyが認証と`mana-runtime` project bindingを固定する。
- Hookのtimeout、非2xx、不正JSON、session・turn・event不一致、必要な監査行欠落、Stop未完了はfail closedとする。
- routing receiptは取得完了の証拠にしない。必要な取得capabilityの実tool callとHostのStop判定を完了条件にする。
- route receipt IDとdigestはBrainbase Hostを正本とし、欠落、不正digest、canonical `additionalContext`欠落はfail closedにする。
- 監査行はHost応答からそのまま取得し、mana-runtimeで生成、要約、重複排除、補完しない。
- receiptへSlack本文、prompt、tool入出力本文、token、secretを保存しない。

## 既存経路との互換性

- placement認可、Graph identity、thread hydration、session resume、Slack投稿、reply completionの境界は維持する。
- session消失・競合時のrecovery commandにも同じJudgment lifecycleを適用し、recoveryごとに独立したattemptとして検証する。
- 議事録のJudgment設定とproxy契約は共通化できる範囲だけ共有し、議事録固有のstructured output検証は変更しない。
- triageで`ignored`またはemoji reactionとなるイベントは通常回答を生成しないため、新しいepisodeの対象外とする。

## 配備と検証

1. unit・integration testでcommand、stream parser、receipt、retry、既存議事録非回帰を確認する。
2. VibeProのSpec verifyとPR gateをexact HEADで通す。
3. 最初は検証用Worker routeと`mana-dev-biz`の検証チャンネルだけへcanary配備する。通常回答をJudgment非経由へ戻す機能フラグは設けず、canary外の既存配備を維持する。
4. fresh Slack eventで返信、Judgment開始、必要な取得、Stop、episode receipt、`response_ts`を同一eventとしてreadbackする。投稿成功後のreceipt保存失敗を注入し、再試行時の可視返信が1件であることも確認する。
5. canaryで有効なメンションのHook失敗、監査欠落、episode欠落、二重返信のいずれかを1件でも観測した場合は全体展開を停止する。正常eventの応答時間も変更前基準から5秒以上悪化した場合は原因確認まで停止する。
6. canary合格後にplacement単位で展開し、各段階で同じreadbackを行う。未確認のplacementを成功へ丸めない。

## ロールバック

- 停止条件に該当した場合は新しいWorker versionの展開を止め、Cloudflareの直前versionへdeploymentを戻す。新version内でJudgment検証だけを無効化し、未監査回答を通す復帰方法は禁止する。
- 復帰後は対象routeのversion、fresh Slack eventの返信、二重返信がないことをreadbackする。新versionで開始済みのepisodeは削除せず、失敗attemptを監査証跡として保持する。
- 原因修正は新しいversionとしてcanaryからやり直す。既存receiptの手編集や成功状態への書換えで再開条件を満たしたことにしない。

本Storyの実装だけでは本番配備とAC10の利用者成果確認を完了扱いにしない。

## 非対象

- Brainbase Judgment Resolverの規則をmana-runtimeへ移植すること。
- routing receiptだけから正本取得済みと推測すること。
- Slack通常回答以外の新しい実行種別をJudgment lifecycleへ移行すること。
- この変更だけで本番へ配備すること。
