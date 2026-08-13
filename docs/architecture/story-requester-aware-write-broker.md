---
architecture_id: arch-requester-aware-write-broker
story_id: story-requester-aware-write-broker
title: Cloudflareタスク運用完全移行アーキテクチャ
status: accepted
date: 2026-08-13
---

# Cloudflareタスク運用完全移行アーキテクチャ

## 決定

Canonical Taskの型とAPI clientは `@openryoko/task-runtime-core` を共通正本にする。Cloudflare Workerへ、依頼者単位の署名capabilityを検証する書き込みproxyと、上限付きCanvas投影adapterを追加する。Sandboxは合成host以外からBrainbaseへ到達できず、API token・署名鍵・Slack tokenを保持しない。

## 書き込み経路

```text
Slack event
  -> Workerがactor/workspace/placement/project/operation/budgetを署名
  -> Claude Sandbox + 専用stdio MCP
  -> task-write.internal/api/task-write
  -> Workerがcapabilityを検証しproject/auth/idempotencyを再構築
  -> TaskApiClientでcreate / update / transition
  -> 成功時だけCanvas修復Queueへ投入
```

- `placementId` はSlack channel IDではなく信頼済み設定 `RUNTIME_PLACEMENT_ID=mana-accounting` を使う。
- capabilityは3分で失効し、Slack actor、workspace、Placement、project、許可操作、最大3回を固定する。
- 作成のprojectはWorker設定から強制する。更新と状態遷移は対象Taskを先に取得し、projectと `expected_version` を確認する。
- 合成hostは固定POST pathだけを受ける。実Brainbase hostをSandboxの許可hostへ追加しない。
- Claudeへ公開する操作は作成・更新・状態遷移だけとし、削除や任意HTTPを公開しない。

## タスクボード経路

```text
書き込み成功 / 15分cron / 手動修復
  -> Cloudflare Queue
  -> pending / in_progress / waiting / completed を各1回取得
  -> 各statusは表示上限+1、cursor追跡なし
  -> project再検証、重複除去、全体最大20件
  -> Slack Canvasを作成または置換
```

件数が上限を超えた場合は総数を推測せず、「20件以上（続きあり）」と表示する。修復失敗はQueueの再試行とDLQへ委ね、書き込み自体は成功のまま保持する。

## 本番設定と移行

1. Workerを `RUNTIME_TASK_WRITE_ENABLED=false`、`RUNTIME_TASK_BOARD_ENABLED=false` で配備する。
2. 専用Queue/DLQを作成し、`TASK_WRITE_CAPABILITY_SECRET` をCloudflare secretとして設定する。
3. PR #120を含むLightsail releaseの`GITHUB_TOKEN`と`meetingMinutesPipeline.destination.github`をreadbackし、議事録GitHub保存pipelineを維持する。
4. 限定channelで書き込みとCanvasをONにし、同一Slackスレッドで検索・作成・更新・状態遷移・Canvasを照合する。あわせてLightsailの議事録GitHub保存が継続していることを確認する。
5. E2E成功後、Lightsailの `mana-accounting.enabled=false` と同Placementの `taskCanvas.enabled=false` を一つの設定変更として反映する。
6. Worker version、Container image digest、Git SHA、Brainbase task ID/version、Canvas更新時刻、Lightsail release SHA、GitHub保存設定のreadbackを記録する。

rollbackは、まずCloudflareの書き込みとCanvasをOFFにし、次にLightsailのPlacementとCanvasを同時にONへ戻す。保持版に機能がない場合は単純なWorker version rollbackだけに依存せず、現在のreleaseをフラグOFFで再配備する。

## セキュリティ不変条件

- project、actor、Placement、operationはユーザー文やLLM出力から拡張しない。
- Worker内部のsecretをSandbox入力、MCP応答、ログへ出さない。
- 外部応答のTaskはprojectを再検証し、projectless/cross-projectなら全体を拒否する。
- 409 conflictを自動で上書き・再試行しない。
- feature flagがOFFなら副作用を起こさない。
- CloudflareとLightsailの同時所有期間をE2E前の限定時間に留め、切替後は一方だけを有効にする。

## 変更しないもの

Brainbase Canonical Task API、既存meeting-task proposal、TechKnight tenant、Lightsailの汎用connector設計、PR #120の議事録GitHub保存pipelineは変更しない。
