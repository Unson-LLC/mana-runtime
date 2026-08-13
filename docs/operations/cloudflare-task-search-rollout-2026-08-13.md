# Cloudflareタスク検索 本番展開記録（2026-08-13）

## 対象

- deployment: `unson-business-mana-runtime`
- Slack channel: `C0BKS6RL99T`
- project binding: `back-office`

## 第1段階: 検索OFFで互換WorkerとContainerを配備

- Git SHA: `de84bab23f375c5cc4383b6caf201e358ca347f8`
- Worker version: `1573deb0-a033-4c23-9dd7-87daa083714a`
- `RUNTIME_TASK_SEARCH_ENABLED`: `false`
- Container application: `a0312218-7c5c-447a-a906-4e7e7030399b`
- Container image digest: `sha256:4af91a165f068d7d304d53a9106b3da2ef52d0e3eed26642f05c7749da7f40ab`
- health: `healthy=1`, `failed=0`

## 第2段階: 雲孫deploymentだけ検索ON

- Git SHA: `d112ead7ccb8335666684eeefdf6f79cae787bad`
- Worker version: `1f4d9564-7509-4cbe-9e25-4214c6cf5c94`
- 配信割合: `100%`
- `RUNTIME_TASK_SEARCH_ENABLED`: `true`
- Container image digest: 第1段階と同一
- health: `healthy=1`, `failed=0`

## 検証済み

- Cloudflare package: 18 files / 127 tests
- 型検査
- WorkerとContainerのdry-run
- GitHub Actions: unit-tests、typecheck、build、deploy-contract
- 本番Workerのversion、binding、配信割合
- 本番Containerのimage digestとhealth

## 切戻し

最初に `RUNTIME_TASK_SEARCH_ENABLED=false` へ戻して再デプロイする。緊急時のknown-goodは、
第1段階のWorker version `1573deb0-a033-4c23-9dd7-87daa083714a` と同じContainer imageである。
旧Container imageは本番確認完了まで削除しない。

## 未確認

本番Slackからの `search_tasks` 実行とBrainbase正本の照合は未確認。Slack送信を伴うため、
実行許可を得てから既知タスク、0件、部分結果を確認する。これが完了するまでStoryのAC-10は閉じない。
