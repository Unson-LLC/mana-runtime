---
story_id: story-cloudflare-primary-runtime
title: "CloudflareをOpenRyokoの主runtimeに移管する"
status: active
source:
  type: operator-decision
  id: story-cloudflare-primary-runtime
architecture_reason: "Lightsail版とCloudflare版を別製品として育てず、会社境界を保った共通runtimeをCloudflare側に置く。"
architecture_docs:
  - docs/architecture/story-cloudflare-primary-runtime.md
spec_docs:
  - docs/specs/story-cloudflare-primary-runtime.vibepro.json
---

# CloudflareをOpenRyokoの主runtimeに移管する

## 背景

現在は、Lightsail上のOpenRyokoが議事録・タスク・Canvasを担い、Cloudflare版は
TechKnight専用のSlack応答だけを担っている。このまま別々に機能追加すると、同じ
OpenRyokoが二つの実装へ分岐し、会社境界、認証、運用責任が分かりにくくなる。

Cloudflare側を今後の主runtimeとし、会社ごとに分離した実行環境と認証を持ちながら、
共通の業務機能を使える状態へ段階移行する。最初の移行単位は、Slackの議事録から
タスク候補を抽出し、信頼済みのチャンネル設定に基づいてBrainbaseへ登録し、結果を
元スレッドへ返す流れとする。

## 受入条件

- Cloudflare上の処理が、Slack workspaceとchannelに対応する会社・project設定を
  deployment設定から決定し、Slack本文やAI出力を権限情報として採用しない。
- 許可されたSlackスレッドで議事録のタスク化を依頼すると、候補がBrainbaseの
  Canonical Taskへ登録され、登録結果が同じスレッドへ通知される。
- 議事録タスク登録パイプライン（meeting-task-pipeline）で登録される全タスクへ、チャンネルに設定されたproject codeの和集合が付く。
- 同一Slack eventがQueueから再配送されても、BrainbaseタスクとSlack結果通知を
  重複作成しない。
- 会社ごとのSlack token、Brainbase token、Anthropic OAuthはCloudflare deploymentの
  secretとして分離し、Workspaceの永続ファイルやログへ保存しない。
- Lightsail側は移行中の互換経路として残すが、Cloudflareへ移したworkspace/channelでは
  同じ議事録タスク処理を二重実行しない。
- Cloudflare runtimeの業務ロジックはTechKnight固有名に依存せず、別会社deploymentでも
  同じテスト済み実装を設定差だけで利用できる。
- 雲孫事業運営とTechKnightは同じCloudflare runtime実装を使いながら、Worker、Queue、
  DLQ、Durable Object、Container、Slack、Anthropic OAuth、Brainbase認証を共有しない。
- Cloudflareはdeployment専用Slack AppのHTTP Events APIを使い、LightsailでSocket Modeを
  使用する既存Slack Appを共用または切り替えない。

- 実行担当が未移管の環境で議事録タスク登録を依頼した場合は、利用できない理由を元スレッドへ返す。
  タスクやAI処理は実行せず、実行記録を失敗として保存する。通知後の再配送や記録送信の再試行でも、
  失敗を成功へ変えず、通知を重複させない。

## シナリオ

- `CFPRIMARY-S-001`: 許可チャンネルの議事録タスク化依頼は、設定済みproject codeを
  継承したタスクをBrainbaseへ登録し、元スレッドへ件数と結果を返す。
- `CFPRIMARY-S-002`: 別workspace、別channel、project未設定の依頼は登録せず、理由を
  記録してfail closedする。
- `CFPRIMARY-S-003`: Slack本文やAI出力に別project codeが含まれても、deployment設定の
  project codeだけがBrainbaseへ送られる。
- `CFPRIMARY-S-004`: 同じevent IDの再配送は、完了記録を確認してClaude、Brainbase、
  Slack投稿を再実行しない。
- `CFPRIMARY-S-005`: Brainbase登録が一部失敗した場合、成功・失敗を区別して通知し、
  Queue再試行で成功済みタスクを増殖させない。
- `CFPRIMARY-S-006`: 雲孫Cloudflare accountへ雲孫事業運営deploymentを`reply_only`で追加しても、
  TechKnight deploymentのWorker、Queue、DLQ、workspace identityを参照しない。
- `CFPRIMARY-S-007`: 雲孫Cloudflare専用の八雲まなAppを追加しても、Lightsailの既存Appと
  イベント配送方式、token、Signing Secretを共有しない。

- `CFPRIMARY-S-008`: `reply_only`でタスク登録を依頼すると利用不可の返信を受け取り、
  実行記録には`failed / MEETING_TASKS_DISABLED`が残る。通知済み状態の読戻しと記録送信の再試行でも
  同じ失敗結果を保持し、記録送信が復旧した後はQueue再試行を終える。

## 対象外

- このStoryだけでLightsailの全機能を停止すること。
- Canvas、会議ファイルの自動取得、議事録生成本体を同時に移管すること。
- BrainbaseをCloudflare内へ複製すること。タスク正本は引き続きBrainbaseとする。
