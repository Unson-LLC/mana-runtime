---
story_id: story-slack-mention-brainbase-judgment
title: "Slackの通常メンション回答をBrainbase判断・正本参照・監査ライフサイクルへ接続する"
status: active
source:
  type: user-request
  id: story-slack-mention-brainbase-judgment
related_stories:
  - story-techknight-cloudflare-slack-reply
  - story-meeting-minutes-brainbase-judgment
---

# Slackの通常メンション回答をBrainbase判断・正本参照・監査ライフサイクルへ接続する

## 利用者価値

Slackでまなへメンションする利用者として、どの配置先・チャンネル・質問でも、回答前の判断、必要な正本参照、回答後の監査がBrainbaseの同じ判断episodeとして完結してほしい。

これにより、Brainbaseを通らない回答や、参照していない情報を参照済みと見せる回答を防ぎ、回答の根拠と実行経路を後から確認できる。

## 現状とのギャップ

- 通常の`app_mention`回答は、議事録生成で使っているBrainbase Judgment Hook設定を読み込まずにClaudeを起動している。
- Brainbase Graph文脈の事前注入とBrainbase MCP capabilityは存在するが、Judgment Resolverが選んだ経路の実行を必須にしていない。
- 通常回答には、判断開始、実際のBrainbase tool call、終了判定を結ぶ永続的なepisode receiptがない。
- Graph取得失敗時の停止はあるが、Judgment Resolver、必要な正本取得、Stop監査の未完了を理由にSlack返信を止める契約がない。
- 議事録生成には同じ問題を解くHook、proxy、turn identity、fail-closedの先行実装があるが、通常回答へは適用されていない。

## 受け入れ基準

- [ ] AC1: mana-runtimeが通常のモデル回答対象と判定したすべてのSlack `app_mention`は、モデル生成前にBrainbase Judgment Hostの`UserPromptSubmit`を実行し、Hostが確定した初期routeと分類を同じepisodeの不変入力として扱う。
- [ ] AC2: 特定tenantだけの例外実装にせず、通常の`reply`経路を利用するすべての有効なplacement profileで同じJudgment lifecycleを適用する。
- [ ] AC3: active DAGがBrainbase知識参照を要求した場合は、`brainbase_knowledge_resolve`を正本ルーティングとして実行し、そのreceiptが示す取得capabilityまで完了する。route receiptだけを検索・取得済みとは扱わず、必要なら同じepisodeで複数回参照する。
- [ ] AC4: active nodeを指定順に完了し、clarification receiptの場合は指定された確認を利用者へ返す。必須node、取得、または監査が未完了のまま通常回答を生成・投稿しない。
- [ ] AC5: Brainbaseのtimeout、非2xx、不正receipt、identity不一致、必須取得失敗、またはStop未完了時はfail closedとし、根拠のない通常回答をSlackへ投稿しない。再試行可能な失敗状態を保存する。
- [ ] AC6: 最終回答にはHostが生成した判断監査行と、実際に発生したBrainbase tool callの監査行を記録順・記録回数どおり表示する。実呼び出しが0回の場合だけHost指定の未参照行を表示し、mana-runtime側で監査文言を生成・要約・補完しない。
- [ ] AC7: `Slack event_id`、workspace、channel、thread、Claude session、Brainbase turn、route resolution、tool journal、Stop結果、Slack `response_ts`を同じ永続的episode receiptで追跡できる。secretとSlack本文はreceiptへ保存しない。
- [ ] AC8: 同一Slack eventの再配送・Queue retryでは完了済みepisodeと返信を重複作成しない。失敗episodeの再試行は履歴を保持した新しいattemptとして識別できる。
- [ ] AC9: 既存の議事録Judgment lifecycle、Brainbase proxyの認証境界、通常回答のplacement認可、Slack thread返信、Queue retry契約を退行させない。
- [ ] AC10: 本番配備後に新しいSlackメンションを1件以上発生させ、利用者に見える返信、Judgment開始、必要なBrainbase取得、Stop完了、永続receipt、Slack `response_ts`の結合を同一eventでreadbackする。未取得の証拠は`not_collected`として残す。

## 成功指標

- mana-runtimeが投稿した通常メンション回答の100%に、完了したBrainbase Judgment episode receiptが対応する。
- 必須のBrainbase取得またはStop監査を欠いたまま投稿された通常回答は0件である。
- episode receiptからSlack返信までを同一eventとして結合できる割合は100%である。
- retryまたは再配送による重複回答は0件である。

## 代表シナリオ

- `SMBJ-S-001`: 正本知識が必要な質問では、判断開始、Knowledge Resolver、返された取得capability、回答、Stopが同じepisodeで完結する。
- `SMBJ-S-002`: 実際のBrainbase tool callを必要としない質問では、Hostの判断と0回である理由を監査し、架空の参照監査行を表示しない。
- `SMBJ-S-003`: 複数の正本参照が必要な質問では、各tool callを同じepisodeへ記録し、全必須参照の完了後に回答する。
- `SMBJ-S-004`: clarification receiptでは通常回答を作らず、Hostが選んだ確認だけを利用者へ返す。
- `SMBJ-S-005`: Brainbaseまたは監査処理が失敗した場合はSlackへ通常回答を投稿せず、再試行可能な失敗receiptを残す。
- `SMBJ-S-006`: 同一eventの再配送では、完了済み返信とepisodeを再作成しない。

## 非対象

- Brainbase Judgment Resolverの判断規則や正本ルーティング規則をmana-runtimeへ複製すること。
- BrainbaseのGraph、Wiki、Drive、repository間の正本責務を変更すること。
- このStoryだけで全tenantへ無条件に本番配備すること。
- Slackメンション以外の議事録、定期処理、手動CLIを新しい応答経路へ移行すること。
- モデルを呼ばず決定的に処理するruntime control commandを、通常の質問回答へ置き換えること。

## リリース条件

- Brainbase Hostとmana-runtimeの契約テストで、identity、event順序、監査行、fail-closed、retryの境界を確認する。
- 通常`reply`経路の単体・結合テストでAC1からAC9をStory ID付きケースとして固定する。
- 対象placementごとに設定readbackを行い、Brainbase endpointと認証bindingの存在だけをE2E成功の証拠にしない。
- 最新デプロイ後のfresh Slack eventでAC10を確認するまで、本番利用者成果は完了扱いにしない。
