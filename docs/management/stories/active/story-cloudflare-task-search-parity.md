---
story_id: story-cloudflare-task-search-parity
title: Cloudflare版でも境界付きタスク検索を利用できる
status: active
created_at: 2026-08-13
updated_at: 2026-08-13
architecture_docs:
  - path: docs/architecture/story-cloudflare-task-search-parity.md
    status: accepted
---

# Cloudflare版でも境界付きタスク検索を利用できる

## 背景

Lightsail版は会話から `search_tasks` を使えるが、Cloudflare版の一般返信はClaudeへ文章を渡すだけで、Brainbase検索へ到達する手段がない。同じSlackチャンネルでも実行runtimeによって回答能力が変わる状態を解消する。

## User story

Slack利用者として、Cloudflare版の八雲まなにもタスク名・状態・担当者を尋ね、Lightsail版と同じBrainbase正本の境界付き検索結果を得たい。これにより、どちらのruntimeが応答しても同じ業務判断ができる。

## 受け入れ基準

- [x] Cloudflare一般返信がread-onlyの `search_tasks` をClaudeのtoolとして利用できる。
- [x] 検索は必須query、任意status・priority・assignee・cursor、既定20件・最大20件を扱い、全ページ取得しない。
- [x] 複数projectはdeploymentの正規bindingから導出し、一回のBrainbase検索へ渡して結合集合全体へlimit・cursorを適用する。
- [x] Sandbox由来のproject・認証・上流URLを信用せず、Workerが固定host・GET・固定path・許可query・project・Bearer認証を再構築する。
- [x] Brainbase tokenと実URLをprompt、MCP設定、Sandbox環境、標準出力、Slack、永続化へ露出しない。
- [x] 0件・部分結果・API障害を区別し、部分結果や障害から「存在しない」と断定しない。
- [x] 機能フラグを既定OFFとし、Cloudflare Container更新後に対象deploymentだけONへ切り替え、即時OFFへ戻せる。
- [x] MCP JSON-RPC、Worker proxy、一般返信配線、project越境拒否、secret非露出、既存返信の単体・統合テストが通る。
- [x] Cloudflare packageの型検査とWorker/Container dry-runが通り、デプロイversion・image digest・切戻し手順を記録する。
- [ ] 本番Slackで既知タスクを検索し、title・status・担当者・projectがBrainbase正本と一致するまで完了扱いにしない。

## スコープ外

- Taskの作成・更新・削除tool
- Canvasの全ページ取得方式の変更
- Brainbaseの検索API・索引・データ移行
- Sandboxの一般インターネット開放
