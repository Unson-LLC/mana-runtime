---
story_id: story-authorized-cross-channel-task-inventory
title: 権限のある複数チャンネルを横断してタスクを取得する
status: active
created_at: 2026-08-15
updated_at: 2026-08-15
source:
  type: operator-decision
  id: slack-cross-channel-task-inventory-2026-08-15
depends_on:
  - story-slack-task-inventory-count
architecture_docs:
  - path: docs/architecture/story-authorized-cross-channel-task-inventory.md
    status: proposed
---

# 権限のある複数チャンネルを横断してタスクを取得する

## 背景

現在の `list_tasks` と `search_tasks` は、署名済みcapabilityに対応する現在チャンネルのprojectだけを取得する。この境界は安全だが、利用者が閲覧を許可された会計チャンネルと開発チャンネルのタスクをまとめて確認したい場合でも、チャンネルごとに質問し直す必要がある。

projectを直接入力できる横断検索は認可境界を壊す。そこで、deployment設定で明示的に許可したチャンネルと利用者だけを対象に、サーバー側でproject和集合を再構築する読み取り専用の横断取得を追加する。

## User story

複数の業務チャンネルを担当する利用者として、閲覧を許可されたチャンネルを明示してタスク件数・一覧・検索結果を一度に取得したい。これにより、認可されていないチャンネルへ越境せず、担当範囲全体の仕事をSlack上で把握できる。

## 受け入れ基準

- [ ] `AC-1`: Gateway MCPは `list_tasks_across_channels` と `search_tasks_across_channels` を公開し、1〜10件の重複しない `channel_ids`、既存フィルター、cursor、最大20件を受ける。
- [ ] `AC-2`: Runtime Gatewayは、呼出元placementの `taskInventoryChannelIds` に全対象チャンネルが含まれ、各対象placementの横断参照専用 `taskInventoryAllowedUserIds` に依頼者が含まれる場合だけ横断取得を許可する。通常返信用 `audience` は変更しない。
- [ ] `AC-3`: 未知、重複、未許可、対象利用者ではないチャンネルが一つでもあれば、upstreamを呼ばずfail closedで拒否する。
- [ ] `AC-4`: Task APIへ渡すprojectは対象placementからサーバー側で導出・重複排除し、MCP入力からprojectを指定または拡張できない。
- [ ] `AC-5`: 応答は最大20件、件数・完全性、`authorized_channels` scope、対象channelとprojectの対応を返し、scope外projectを含む応答は全体を拒否する。
- [ ] `AC-6`: 既存の `list_tasks` と `search_tasks` は `current_channel` のまま変えず、横断検索にも既存の `RUNTIME_TASK_SEARCH_ENABLED` 切戻しスイッチを適用する。
- [ ] `AC-7`: `mana-dev-biz` から現在チャンネルと `mana-accounting` を横断できる設定を追加する。`unson` を含む他チャンネルや逆方向の横断は許可しない。
- [ ] `AC-8`: unit、integration、型検査、buildを通し、デプロイ後に許可済み横断、未許可越境拒否、件数・scopeをSlackとBrainbase正本で照合する。

## スコープ外

- タスクの作成、更新、削除
- Slackのチャンネル所属情報を実行時に自動取得して認可へ利用すること
- 全ページ走査による擬似的な正確件数
- `mana-accounting` から他チャンネルへの逆方向横断
- `unson` projectまたは会議ルーターのタスク取得

## ADR判断

既存placement認可と共有Task clientを拡張する局所変更で、新しい認証方式やデータ正本は導入しない。認可の積集合とfail-closed条件はStory Architectureに固定するため、独立ADRは不要とする。
