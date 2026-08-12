---
story_id: story-slack-task-bounded-search
title: Slack会話向けCanonical Task境界付き検索
status: active
created_at: 2026-08-12
updated_at: 2026-08-12
architecture_docs:
  - path: docs/architecture/story-slack-task-bounded-search.md
    status: accepted
---

# Slack会話向けCanonical Task境界付き検索

## 背景

Slack会話へ公開する `list_tasks` はCanonical APIの先頭50件だけを取得し、返された `next_cursor` を入力できない。そのため、Canvasでは見える2ページ目以降のタスクを「存在しない」と回答できた。全ページ取得はタスク数に比例して重くなるため恒久対応にしない。

## User story

Slack会話の利用者として、現在のチャンネルに紐づくプロジェクト内からタスク名を検索し、全タスクを読み込まずに候補を確認したい。これにより、タスク数が増えても応答時間と取得量を一定範囲に保ち、不在の誤断定を防げる。

## 受け入れ基準

- [x] MCPへ `search_tasks` を追加し、必須query、status、priority、assignee_person_id、cursor、limitをCanonical検索APIへ転送する。
- [x] placement認証の `list_tasks` と `search_tasks` は、要求値ではなく同一connector/workspace/channelの有効placementからproject_codeを導出して強制する。
- [x] project bindingを解決できないplacement要求は無制限検索へ広げず、明示的に拒否する。
- [x] operator認証では明示されたproject_codeを転送できる。
- [x] `list_tasks` はcursor、assignee_person_id、project_codeを入力でき、説明文で1ページのみ・`next_cursor` があれば部分結果であると明示する。
- [x] `search_tasks` は既定20件・最大20件で、全ページ取得を行わない。
- [x] gateway route/capability、MCP schema/handler、Brainbase client、標準placement capabilityを一貫して更新する。
- [x] client、gateway、MCP schema/handler、placement scopeのテストが通る。

## スコープ外

- Canvasの全ページ取得方式の変更
- 検索結果の自動更新・書き込み
- 意味検索、ランキング学習、全件数表示
