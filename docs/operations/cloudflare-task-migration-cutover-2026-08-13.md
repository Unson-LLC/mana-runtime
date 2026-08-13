# Cloudflareタスク運用切替証跡（2026-08-13）

## 結論

Slackチャンネル `C0BKS6RL99T` のタスク検索・作成・更新・状態遷移・タスクボードはCloudflareへ完全移行した。Lightsailの `mana-accounting` Placementと同PlacementのtaskCanvasは無効化し、タスク操作の所有者はCloudflareだけになった。

議事録処理はこの切替の対象外である。Lightsailの `meetingMinutesPipeline` は有効のまま維持し、そのGitHub保存、本番E2E、Cloudflare移行は別タスクで検証する。

## Cloudflare配備

- Git SHA: `d295c8660b5bd842125ffe7ce9e46b2ba171b7fa`（PR #126）
- Worker version: `38c2737b-2a91-4ebe-b9bf-714327830441`、配分100%
- Worker tag: `git-d295c866`
- Container image: tag `38c2737b`
- Container digest: `sha256:e9c204b29e130ae387cd551260b302ad345a4598596c41dbf80f81c88ca4a985`
- 設定: search=`true`、write=`true`、board=`true`、minutes=`false`
- 所有境界: Placement=`mana-accounting`、project=`back-office`、channel=`C0BKS6RL99T`
- Queue: `unson-business-mana-task-board-repairs`
- DLQ: `unson-business-mana-task-board-repairs-dlq`
- `TASK_WRITE_CAPABILITY_SECRET` はWorker secret名として存在することを確認した。値は表示していない。

Workerのversion、bindings、Queue producer/consumer、cron、Durable Object、secret名を配備後に読み戻した。Container digestは同配備のWranglerログから取得した。

## 同一Slackスレッドの書き込みE2E

依頼: <https://unson-ops.slack.com/archives/C0BKS6RL99T/p1786620460252009?thread_ts=1786507594.889229&cid=C0BKS6RL99T>

応答: <https://unson-ops.slack.com/archives/C0BKS6RL99T/p1786620541481209?thread_ts=1786507594.889229&cid=C0BKS6RL99T>

- title: `CF-BOARD-CUTOVER-E2E-2026-08-13-D295C86`
- task ID: `ecb21497-1378-4807-9ff8-387701c29040`
- create: version 1、`pending`
- update: version 2、description=`cloudflare-board-confirmed`
- transition: version 3、`completed`
- 最終検索: version 3、`completed`、読み取り状態complete
- 失敗: なし

作成・更新・状態遷移の各段階でBrainbase正本を読み戻し、versionと内容が一致した。409を上書きする再試行は行っていない。

## タスクボードE2E

- 可視性確認用title: `CF-BOARD-VISIBILITY-2026-08-13-D295C86`
- task ID: `fbc06c5f-eec0-424c-9e2f-5e0689e2e337`
- Brainbase: version 1、`pending`、該当1件
- Canvas: pendingが6件から7件へ更新され、同titleが表示された
- 切替後の再確認: pending 7件、completed 6件、可視性確認用titleを保持

タスクボードは4 statusの上限付き取得を使い、全ページ取得には戻していない。

## Lightsail所有権切替

- 設定commit: `77988b4`（`chore(config): Cloudflareへタスク所有権を切替`）
- `mana-accounting.enabled=false`
- 同Placementの `taskCanvas.enabled=false`
- `meetingMinutesPipeline.enabled=true` を維持
- `openryoko.service`: active、PID `1288558`、`NRestarts=0`

切替後、同じSlackスレッドから2件を検索し、CloudflareのMana Yakumo応答が1回だけ返った。

- `CF-BOARD-VISIBILITY-2026-08-13-D295C86`: 1件、pending、version 1
- `CF-BOARD-CUTOVER-E2E-2026-08-13-D295C86`: 1件、completed、version 3
- `has_more=false`、`next_cursor=null`
- 重複応答: 観測なし

## ロールバック

障害時はCloudflareを先にOFFにする。

1. 現在のGit SHAをsearch=`true`、write=`false`、board=`false`で再配備する。
2. Cloudflareの設定を読み戻し、副作用が止まったことを確認する。
3. Lightsailの `mana-accounting.enabled=true` と同Placementの `taskCanvas.enabled=true` を同じ設定変更で戻す。
4. Lightsailを再起動し、両設定とサービス状態を読み戻す。

壊れた旧Worker versionへ単純に戻さない。Cloudflareを止める前にLightsailを有効化しない。

## 証拠境界

- 完了: Cloudflareのタスク検索・作成・更新・状態遷移・Canvas、Brainbase一致、単独所有、復旧順序。
- 別タスク: 議事録生成、GitHub保存、議事録Slack投稿、`GITHUB_TOKEN`、Cloudflareへの議事録移行、Lightsailサービス全体の停止。
- この証跡はsecret値を含まない。Wrangler tailは署名済みcapabilityを表示し得るため使用していない。
