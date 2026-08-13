---
story_id: story-requester-aware-write-broker
title: Cloudflareへタスク運用を完全移行する
status: completed
created_at: 2026-08-13
updated_at: 2026-08-13
source:
  type: operator-decision
  id: cloudflare-full-task-migration
depends_on:
  - story-shared-task-runtime-core
architecture_docs:
  - path: docs/architecture/story-requester-aware-write-broker.md
    status: accepted
spec_docs:
  - docs/specs/story-requester-aware-write-broker.vibepro.json
---

# Cloudflareへタスク運用を完全移行する

## 背景

Cloudflare版は検索まで移行済みだが、会話からの作成・更新・状態遷移、Slack Canvasのタスクボード、同一スレッドの本番E2E、Lightsailからの所有権切替が残っている。Lightsail版とCloudflare版へ別々に機能を足す運用をやめ、共有task coreを正本としてCloudflareの境界adapterへ不足機能を実装する。

## User story

雲孫事業運営のSlack利用者として、同じチャンネルとスレッドでタスクの検索・作成・更新・状態遷移・一覧確認をCloudflare版だけで完結したい。これにより、タスク運用の所有者をCloudflareへ一本化しつつ、タスク移行と議事録移行の証拠を混同せず、安全に移行できる。

## 受け入れ基準

- [x] `AC-1`: WorkerがSlackの依頼者、workspace、`mana-accounting` Placement、`back-office` project、許可操作、期限、最大3回を署名したrequest capabilityを発行し、Sandboxへ署名鍵を渡さない。
- [x] `AC-2`: 一般返信は `create_task`、`update_task`、`transition_task` の専用MCPだけを公開し、明示依頼だけを書き込み、対象指定と `expected_version` が不足する更新を実行しない。
- [x] `AC-3`: Worker proxyは合成hostの固定method/pathだけを受け、認証、project、Placement、冪等キーをサーバー側で再構築し、改ざん・期限切れ・越境・回数超過をfail closedで拒否する。
- [x] `AC-4`: 作成はtrusted projectへ固定する。検索結果は正の整数versionを保持し、更新・状態遷移はそのversionを必須の`expected_version`として受け、対象Taskのprojectとversionを再検証する。409 conflictは非再試行エラーとして区別する。
- [x] `AC-5`: 書き込み成功後はタスクボード修復をQueueへ依頼する。タスクボード取得は4 statusを各1回、表示上限+1件で取得し、cursorを追わず、project越境を拒否して最大20件だけ表示する。
- [x] `AC-6`: Canvasは既存なら更新、未作成なら作成し、件数超過時は正確な総数ではなく「20件以上・続きあり」と表示する。Queue再試行と15分ごとの修復を備え、機能フラグで停止できる。
- [x] `AC-7`: Cloudflare本番は書き込みとタスクボードを既定OFFで配備し、Queue/DLQと`TASK_WRITE_CAPABILITY_SECRET`を揃えてから限定チャンネルだけONにする。タスク所有権切替時点ではLightsailの`meetingMinutesPipeline`を維持して変更対象から除外し、後続の議事録移行は別Storyとして扱う。
- [x] `AC-8`: 同一Slackスレッドで検索、作成、更新、状態遷移を実行し、Brainbase正本とCanvasの一致、Worker version、Container image digest、Git SHAを記録する。
- [x] `AC-9`: CloudflareのE2E成功後に、Lightsailの `mana-accounting.enabled=false` と同Placementの `taskCanvas.enabled=false` を同時に反映し、同一イベントの二重処理と空Canvas上書きを防ぐ。rollbackは逆順で行える。
- [x] `AC-10`: Cloudflareが対象チャンネルのタスク検索・作成・更新・状態遷移・Canvasを単独所有し、Lightsailの同PlacementとtaskCanvasが無効であることを本番証跡で確認してタスク運用の完全移行とする。後続の議事録移行状態は本Storyの完了証拠に使わない。

## スコープ外

- タスク削除
- 高リスク操作のSlack承認UI
- Brainbase Canonical Task以外の新しい業務正本
- TechKnight tenantへの書き込み機能展開
- PR #120の議事録生成・GitHub保存pipeline自体のCloudflare移植（後続の別Storyで実施済み）
- 議事録pipelineの本番E2E、GitHub保存先、`GITHUB_TOKEN`の検証（後続の別Storyで実施済み）

## 完了条件

AC-1〜AC-7をテスト・型検査・ビルドで固定し、AC-8〜AC-10を `docs/operations/cloudflare-task-migration-cutover-2026-08-13.md` の本番E2Eと所有権切替で閉じる。CloudflareとLightsailが同じタスク操作を同時に処理する状態では完了扱いにしない。Lightsail service全体の停止と議事録pipelineの検証・移行は別Storyで扱う。
