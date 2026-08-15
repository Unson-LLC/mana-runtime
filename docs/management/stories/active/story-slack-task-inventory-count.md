---
story_id: story-slack-task-inventory-count
title: Slackで現在チャンネルのタスク件数と取得範囲を正しく把握する
status: active
created_at: 2026-08-15
updated_at: 2026-08-15
source:
  type: operator-decision
  id: slack-task-inventory-gap-2026-08-15
depends_on:
  - story-shared-task-runtime-core
  - story-slack-task-bounded-search
architecture_docs:
  - path: docs/architecture/story-slack-task-inventory-count.md
    status: proposed
---

# Slackで現在チャンネルのタスク件数と取得範囲を正しく把握する

## 背景

Slack会話の `list_tasks` は最大20件の1ページだけを返し、正確な総件数、取得の完全性、対象projectを利用者へ示さない。さらに `mana-dev-biz` の移行証跡は検索対応を完了としているが、現行placementの `gatewayTools` とRuntime Gatewayには `search_tasks` が揃っていない。

この状態では「自分の未完了タスクは何件か」という質問に、先頭20件や部分結果を総数として答えたり、検索できない状態を移行済みとして扱う恐れがある。

## User story

現在のSlackチャンネルで仕事を確認する利用者として、条件に一致するタスクの件数、一覧、対象project、取得の完全性を一度に知りたい。これにより、部分取得を全件や0件と誤認せず、必要なら続きを取得または検索できる。

## 受け入れ基準

- [ ] `AC-1`: Runtime Gatewayの `list_tasks` は `has_more`、`count_status`、`total_count`、対象projectを返し、正確な件数がない場合は `null` と `not_requested` または `unavailable` を返す。
- [ ] `AC-2`: Runtime Gatewayに境界付き `search_tasks` を実装し、query、status、priority、assignee、cursor、最大20件を共有Task clientへ渡す。
- [ ] `AC-3`: `list_tasks` と `search_tasks` は、入力されたprojectを無視し、署名済みcapabilityと一致する現在placementのproject和集合を強制する。
- [ ] `AC-4`: upstreamが返したタスクにscope外projectが一つでも含まれる場合は、部分的に表示せず `gateway_scope_violation` で拒否する。
- [ ] `AC-5`: `mana-dev-biz` の `gatewayTools` に `search_tasks` を追加し、設定テストが移行証跡との一致を固定する。
- [ ] `AC-6`: 件数が正確、下限、一部取得、取得不能のどれかを機械判定でき、API障害を0件として返さない。
- [ ] `AC-7`: Gateway MCP schemaは件数・取得範囲の意味を説明し、「私のタスク」では依頼者に解決済みの担当者IDを使う既存契約を維持する。
- [ ] `AC-8`: unit、integration、型検査、buildを通し、対象Slackチャンネルで検索・件数・越境拒否の本番E2E証跡を残す。

## スコープ外

- 閲覧可能な複数チャンネルを横断する集約
- Brainbase Canonical Task以外を正本にした件数計算
- 全ページ走査による擬似的な正確件数
- タスク書き込み、削除、Canvas表示上限の変更

## ADR判断

既存のplacement強制、共有Task client、Runtime Gatewayを拡張する局所変更であり、新しいデータ正本や認証方式を導入しないためADRは不要。境界と応答契約はStory Architectureに固定する。
