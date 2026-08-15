---
architecture_id: arch-authorized-cross-channel-task-inventory
story_id: story-authorized-cross-channel-task-inventory
title: 明示認可されたチャンネル横断タスク取得
status: proposed
date: 2026-08-15
---

# 明示認可されたチャンネル横断タスク取得

## 決定

既存の現在チャンネル用toolとは別に、読み取り専用の `list_tasks_across_channels` と `search_tasks_across_channels` を追加する。横断範囲は利用者入力のprojectではなく、deploymentのplacement設定から導出する。

呼出元placementは `taskInventoryChannelIds` で横断可能なチャンネルを明示する。さらに、各対象placementの横断参照専用 `taskInventoryAllowedUserIds` に依頼者が含まれることを必須とする。通常返信用 `audience` とは分離し、呼出元の許可と対象側の横断参照許可の積集合により、片側だけの設定ミスで情報が開示されないようにする。

## 認可アルゴリズム

1. 署名済みcapability、workspace、現在placement、依頼者、tool、capability project集合を既存どおり検証する。
2. `channel_ids` が1〜10件で重複しないことを検証する。
3. 全channelが呼出元placementの `taskInventoryChannelIds` に含まれることを検証する。
4. channelごとに一意な対象placementを解決し、その `taskInventoryAllowedUserIds` に依頼者が含まれることを検証する。
5. 対象placementの `projectCodes` を和集合にし、Task APIへ一度だけ渡す。
6. upstreamの全taskについて、すべての `project_codes` が許可集合内か検証する。

いずれか一つでも失敗した場合はupstreamを呼ばず、部分的な結果も返さない。複数placementが同じchannelを宣言する不整合も曖昧に選ばず拒否する。

## MCP契約

- `list_tasks_across_channels`: `channel_ids`、status、priority、assignee、cursor、limitを受ける。
- `search_tasks_across_channels`: 上記に加えて空でないqueryを必須とする。
- `channel_ids` は1〜10件、重複不可。project入力はschemaに持たない。
- limitは既定20、最大20。全ページ走査はしない。

既存の `list_tasks` と `search_tasks` は変更せず、現在placementだけを対象にする。利用者が明示的に複数または他のチャンネルを求めた場合だけ新toolを選ぶ。

## 応答契約

既存の件数・完全性契約に加えて次を返す。

- `scope.mode`: `authorized_channels`
- `scope.channel_ids`: 正規化済み対象channel ID
- `scope.project_codes`: サーバー側で導出したproject和集合
- `scope.channels`: `{ channel_id, project_codes }` の対応表

`items` は最大20件。`has_more`、`total_count`、`count_status`、`read_status` の意味は現在チャンネル取得と同じとする。対象projectが同じ複数channelに紐づく場合でもTask APIへのprojectは重複排除し、taskを重複させない。

## 設定境界

`mana-dev-biz` だけに横断toolと `taskInventoryChannelIds` を付与し、現在チャンネルと `mana-accounting` を対象にする。両placementには対象利用者を示す横断参照専用 `taskInventoryAllowedUserIds` を設定する。`mana-accounting` には横断toolや呼出元scopeを付与しないため逆方向には利用できず、通常返信用 `audience` も変更しない。

`biz-meeting-router` と `unson` projectは許可集合へ含めない。

## データフロー

```text
Slack reply Sandbox
  -> Gateway MCP cross-channel tool
  -> 呼出元capabilityとplacementを検証
  -> 許可channelと対象audienceの積集合を検証
  -> 対象placementからproject和集合を導出
  -> shared TaskApiClientへ1回の境界付きquery
  -> scope・件数・完全性・task projectを検証して返却
```

## リリースと切戻し

横断検索は既存の `RUNTIME_TASK_SEARCH_ENABLED=false` で停止する。横断一覧に問題がある場合は `mana-dev-biz` の `gatewayTools` から新toolを外し、`taskInventoryChannelIds` を削除する。既存の現在チャンネルtoolは維持される。

ローカルテスト成功は本番成功へ丸めない。デプロイ後、許可済み2チャンネルの和集合、未許可channel拒否、返却scope、Brainbase Canonical Taskとの件数整合を同じ依頼者で確認して完了とする。
