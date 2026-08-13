# Cloudflareタスク運用切替証跡（2026-08-13）

## 結論

Slackチャンネル `C0BKS6RL99T` のタスク検索・作成・更新・状態遷移・タスクボードはCloudflareへ完全移行した。Lightsailの `mana-accounting` Placementと同PlacementのtaskCanvasは現在も無効で、タスク操作の所有者はCloudflareだけである。

この文書は、切替時の書き込みE2Eと、後続配備後の現在状態を分けて記録する。機械可読な現在証跡は [cloudflare-task-migration-evidence-2026-08-13.json](./cloudflare-task-migration-evidence-2026-08-13.json) を正本とする。

議事録処理はタスク切替の対象外である。切替時はLightsailで継続していたが、その後、別タスクのPR #128でCloudflareへ移行した。現在はCloudflareの議事録機能が有効、Lightsailの `meetingMinutesPipeline` は無効である。この後続変更はタスク移行の完了判定には使わない。

## 現在のCloudflare配備

- Git SHA: `b2d461303332a96920d82dce68c60eb39832c02d`（PR #128までを含む現在のmain）
- Worker version: `cfe9ab6e-74a3-4046-8159-8f330f834236`、配分100%
- Worker設定のrelease tag: `git-b2d4613`
- Worker handlers: `fetch`、`queue`、`scheduled`
- 設定: search=`true`、write=`true`、board=`true`
- 所有境界: Placement=`mana-accounting`、project=`back-office`、channel=`C0BKS6RL99T`
- Queue: `unson-business-mana-task-board-repairs`
- Durable Object: `TASK_WRITE_BUDGETS`
- Container ID: `a0312218-7c5c-447a-a906-4e7e7030399b`、state=`ready`、healthy=1、failed=0
- Container digest: `sha256:e9c204b29e130ae387cd551260b302ad345a4598596c41dbf80f81c88ca4a985`

Workerのversion、bindings、Queue、cron、Durable Object、secret名、Containerのhealthとdigestを2026-08-13 22:38 JSTに読み戻した。secret値は表示していない。

## 切替時の同一Slackスレッド書き込みE2E

依頼: <https://unson-ops.slack.com/archives/C0BKS6RL99T/p1786620460252009?thread_ts=1786507594.889229&cid=C0BKS6RL99T>

応答: <https://unson-ops.slack.com/archives/C0BKS6RL99T/p1786620541481209?thread_ts=1786507594.889229&cid=C0BKS6RL99T>

- 実行時Git SHA: `d295c8660b5bd842125ffe7ce9e46b2ba171b7fa`（PR #126）
- 実行時Worker version: `38c2737b-2a91-4ebe-b9bf-714327830441`
- 実行時release tag: `git-d295c866`
- title: `CF-BOARD-CUTOVER-E2E-2026-08-13-D295C86`
- original task ID: `ecb21497-1378-4807-9ff8-387701c29040`
- create: version 1、`pending`
- update: version 2、description=`cloudflare-board-confirmed`
- transition: version 3、`completed`
- 失敗: なし

作成・更新・状態遷移の各段階でBrainbase正本を読み戻し、versionと内容が一致した。409を上書きする再試行は行っていない。

## 現在のSlack・Brainbase読み戻し

Lightsail停止後の依頼: <https://unson-ops.slack.com/archives/C0BKS6RL99T/p1786621060124339?thread_ts=1786507594.889229&cid=C0BKS6RL99T>

Cloudflareの応答: <https://unson-ops.slack.com/archives/C0BKS6RL99T/p1786621120419909?thread_ts=1786507594.889229&cid=C0BKS6RL99T>

- Cloudflare応答数: 1
- `CF-BOARD-VISIBILITY-2026-08-13-D295C86`: 1件、pending、version 1
- `CF-BOARD-CUTOVER-E2E-2026-08-13-D295C86`: 1件、completed、version 3
- `read_status=complete`、`has_more=false`、`next_cursor=null`
- 重複応答: 観測なし

さらにInfisicalの許可済みtarget `brainbase-mcp` からCanonical Task APIを直接検索し、2026-08-13 22:37 JST時点で次を確認した。

- `CF-BOARD-CUTOVER-E2E-2026-08-13-D295C86`: completed、version 3、description=`cloudflare-board-confirmed`、project=`back-office`
- `CF-BOARD-VISIBILITY-2026-08-13-D295C86`: pending、version 1、project=`back-office`
- 両検索とも `read_status=complete`、該当1件

API tokenは実行時注入だけに使い、値を出力・保存していない。

## 現在のタスクボード

- title: `タスクボード`
- subtitle: `Brainbase同期（読み取り専用） | 対象project: back-office`
- pending 7件、in_progress 0件、waiting 0件、completed 6件
- `CF-BOARD-VISIBILITY-2026-08-13-D295C86` を現在のCanvasで確認
- 画面readback: 2026-08-13 22:36 JST
- ローカル画面証跡: `/tmp/mana-current-task-board-2026-08-13.png`
- SHA-256: `5c8a3b3494986ae5720b485d073f411076dbe6629eb91b9b912db2e5d62cd674`

タスクボードは4 statusの上限付き取得を使い、全ページ取得には戻していない。CanvasはBrainbaseの可視性確認用Taskと一致する。

## 現在のLightsail所有権

- 設定Git SHA: `9139b37608b95df16e99cbaceb6bd880b422e12d`
- `mana-accounting.enabled=false`
- `slack-biz.taskCanvas.enabled=false`
- `openryoko.service`: active/running、PID `1292805`、`NRestarts=0`

Lightsailサービス全体は、タスク以外の責務があるため停止していない。タスクPlacementとtaskCanvasだけを無効にしている。現在の `slack-biz.meetingMinutesPipeline.enabled=false` は別タスクによる後続変更である。

## ロールバック

障害時はCloudflareを先にOFFにする。

1. 現在のGit SHAをsearch=`true`、write=`false`、board=`false`で再配備する。
2. Cloudflareの設定を読み戻し、副作用が止まったことを確認する。
3. Lightsailの `mana-accounting.enabled=true` と同Placementの `taskCanvas.enabled=true` を同じ設定変更で戻す。
4. Lightsailを再起動し、両設定とサービス状態を読み戻す。

壊れた旧Worker versionへ単純に戻さない。Cloudflareを止める前にLightsailを有効化しない。

## 証拠境界

- 完了: Cloudflareのタスク検索・作成・更新・状態遷移・Canvas、Brainbase一致、単独所有、復旧順序。
- 別タスクで完了: 議事録生成、GitHub保存、議事録Slack投稿、`GITHUB_TOKEN`、Cloudflareへの議事録移行。PR #128の結果は本タスクの完了根拠へ混ぜない。
- スコープ外: Lightsailサービス全体の停止。
- この証跡はsecret値を含まない。Wrangler tailは署名済みcapabilityを表示し得るため使用していない。
