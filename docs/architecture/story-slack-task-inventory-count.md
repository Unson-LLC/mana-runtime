---
architecture_id: arch-slack-task-inventory-count
story_id: story-slack-task-inventory-count
title: 現在チャンネルのタスク件数・検索契約
status: proposed
date: 2026-08-15
---

# 現在チャンネルのタスク件数・検索契約

## 決定

`list_tasks` と `search_tasks` をCloudflare Runtime Gatewayの同じ認可境界へ統合する。どちらも現在placementのproject和集合をサーバー側で強制し、応答へ取得範囲と完全性を付ける。

Manaは正確な件数を得るために全ページを走査しない。Canonical Task APIが返す `total_count` と `count_status` を検証して転送し、値がない場合は不明であることを明示する。

## 応答契約

一覧・検索は共通して次を返す。

- `items`: 最大20件の境界検証済みタスク
- `next_cursor`: 次ページがある場合のcursor
- `has_more`: `next_cursor` またはupstream値から判定した部分取得フラグ
- `total_count`: 正確な件数が提供された場合のみ非負整数。それ以外は `null`
- `count_status`: `exact | lower_bound | not_requested | unavailable`
- `scope.project_codes`: 現在placementから導出したproject和集合
- `scope.mode`: `current_channel`
- `read_status`: upstreamが示した取得状態。不在時は `complete` または `partial` をManaが安全側に導出する

`count_status=exact` の場合だけ `total_count` を正確な総数として利用する。`has_more=true` かつ正確な件数がない場合は、表示件数を総数として扱わない。

## 認可境界

Sandbox、Claude、MCP入力はprojectやchannelを拡張できない。Workerは署名済みcapabilityのplacement IDを検証し、現在の `RUNTIME_PLACEMENTS_JSON` からprojectを再解決する。capabilityのproject集合と一致しない場合は拒否する。

upstream taskの `project_codes` はすべて許可集合内であることを必須とする。複数projectを持つtaskにscope外projectが含まれる場合も拒否し、情報を部分開示しない。

## データフロー

```text
Slack reply Sandbox
  -> Gateway MCP list_tasks / search_tasks
  -> Runtime Gateway capability検証
  -> placement project和集合を強制
  -> shared TaskApiClient
  -> Brainbase Canonical Task API
  -> scope・件数・完全性を検証して返却
```

## リリース条件

コード、deployment config、移行証跡の3つが一致し、対象channelの検索成功、部分取得表示、scope越境拒否を本番で確認するまで完了にしない。

## 切戻し

既存の `RUNTIME_TASK_SEARCH_ENABLED=false` をRuntime Gatewayの `search_tasks` にも適用する。障害時はこの共通スイッチで検索呼び出しを停止し、一覧取得は維持する。
