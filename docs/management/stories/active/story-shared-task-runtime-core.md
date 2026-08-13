---
story_id: story-shared-task-runtime-core
title: "CloudflareとLightsailでCanonical Task業務コアを共有する"
status: active
source:
  type: operator-decision
  id: story-shared-task-runtime-core
architecture_reason: "Cloudflareへ機能を複製せず、Task業務能力を純粋な共通パッケージへ縦切りし、CloudflareとLightsailを薄い実行アダプターにする。"
architecture_docs:
  - docs/architecture/story-shared-task-runtime-core.md
spec_docs:
  - docs/specs/story-shared-task-runtime-core.vibepro.json
---

# CloudflareとLightsailでCanonical Task業務コアを共有する

## 背景

LightsailのJimmyはCanonical Taskの作成・検索・更新・状態遷移を一つのclientで扱う一方、
Cloudflare版は検索proxyと議事録タスク登録で同じBrainbase APIを個別実装している。このまま
Cloudflareへ機能を足すと、入力、エラー、project境界、ページングの契約がruntimeごとに分岐する。

移行の最初の単位として、Canonical Taskの型、HTTP契約、query生成、エラー表現、信頼済み
project scopeの適用をplatform非依存の共通パッケージへ移す。JimmyとCloudflareの既存経路を
そのパッケージへ載せ替え、動作を変えずに次のCloudflare書き込みツール実装の土台を作る。

## 受入条件

- [x] `AC-1`: Canonical Taskの型、API client、query生成、エラー表現、project scope適用を、
  Node、Cloudflare、Slack、process.envへ依存しない共通パッケージとして提供する。
- [x] `AC-2`: Jimmyの既存task clientは環境変数とUUID生成だけを担う薄いadapterとなり、作成、一覧、
  検索、取得、更新、状態遷移、削除のHTTP契約を共通パッケージへ委譲する。
- [x] `AC-3`: Cloudflareの境界付き検索は共通clientと共通project scopeを使い、検索結果の0件、部分結果、
  API障害を混同せず、SandboxへBrainbase tokenを渡さない。
- [x] `AC-4`: Cloudflareの議事録タスク登録は共通clientを使い、deployment bindingのproject code和集合と
  Slack event由来の決定的Idempotency-Keyを維持する。
- [x] `AC-5`: project codeは信頼済みruntime bindingから強制し、Slack本文、AI出力、Sandbox requestで
  追加・置換できない。
- [x] `AC-6`: JimmyとCloudflareのadapter契約テストが、同じURL、method、body、認証、冪等性、
  エラーcodeを確認する。
- [x] `AC-7`: 既存のCloudflare検索と議事録タスク登録、Jimmy task toolsの回帰テスト、型検査、buildが通る。
- [x] `AC-8`: Canvasの全件取得、議事録生成、Cloudflare会話からの汎用更新・状態遷移の公開、
  runtime所有権切替、本番deployはこのStoryに含めない。

## シナリオ

- `SHAREDTASK-S-001`: Jimmyからタスクを操作すると、共通clientが従来と同じBrainbase endpointと
  payloadを使い、Jimmy adapterがNode環境の設定だけを注入する。
- `SHAREDTASK-S-002`: Cloudflare検索ではSandboxのqueryにproject codeがなくても、Workerが
  deployment bindingのproject和集合を一回の検索へ強制する。
- `SHAREDTASK-S-003`: Cloudflare議事録タスク登録では候補にprojectがなくても、共通scopeが
  deployment bindingのproject和集合を付け、同一event再試行を冪等にする。
- `SHAREDTASK-S-004`: BrainbaseがJSON errorを返した場合、共通errorへ変換した後に各adapterが
  現行の利用者向けerror codeへ写像する。
- `SHAREDTASK-S-005`: 共通パッケージへNode APIまたはCloudflare bindingを直接参照する実装を
  追加すると、型検査または契約テストが失敗する。

## 対象外と次Story

- Cloudflare会話への`create_task`、`update_task`、`transition_task`公開は、署名付きevent capability、
  event単位の書き込み上限、project外taskの事前検査を設計する次Storyで扱う。
- Task Canvasは、全ページ走査を移植せず、上限付きprojection APIまたはchange feedを先に設計する。
- Lightsail停止とCloudflareへの所有権切替は、機能同等性と同一Slack E2Eが揃った後のrelease Storyで扱う。
