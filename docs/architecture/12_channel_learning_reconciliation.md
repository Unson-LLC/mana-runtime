# チャンネル学習候補の復旧

## Decision

チャンネルの直近会話は既存のSQLite projectionから毎ターン参照する。長期的な業務記憶はBrainbase Graphを正本とし、mana-runtimeはreview-required candidateを送るだけにする。

正常応答の完了フックだけに依存すると、プロセス停止・ユーザー中断・エンジン異常の直前に保存済みの重要な依頼が候補台帳へ入らない。そこでgateway起動時に永続会話台帳を再走査し、各sessionの最終user発話と直後のassistant発話を候補化する。対象は`OPENRYOKO_LEARNING_RECONCILE_PLACEMENTS`で明示したplacementだけであり、未設定時は復旧を行わない。`transportMeta`のspeakerは最終入力者だけを表すため、過去の別話者へ誤帰属しないよう最終turnに限定する。assistantがなければ未完了の証跡として候補化する。

候補IDは既存の`LearningCandidateService`がsession ID、user message ID、assistant message IDから決定論的に生成する。未回答時は`missing:<userMessageId>`を使うため、再起動しても同じIDとなりSQLite outboxの一意制約で重複しない。

## Security boundary

- 復旧処理はgateway起動コードだけが実行する。
- placementセッションのWrite/Edit/Bash denyは変更しない。
- 復旧結果は`requiresReview: true`のcandidateであり、Graphへの昇格はBrainbaseの承認ゲートを通る。
- workspaceまたはchannelを確定できないセッションはfail closedで除外する。
- placement allowlistにないセッションは除外し、初回deployで全履歴を送信しない。
- placementのprojectは設定済みplacement IDから導出し、会話本文から推測しない。

## Failure behavior

candidate-storeが未設定、identity unresolved、または一時障害の場合もSQLite outboxへ残し、既存retry機構に委ねる。起動時drainは最大100件をclaimし、pilot対象24sessionと既存pendingを1回で処理できる上限にする。候補送信失敗を「記憶なし」と解釈しない。
