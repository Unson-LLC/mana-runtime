---
architecture_id: arch-cross-channel-task-name-resolution
story_id: story-cross-channel-task-name-resolution
title: 設定済みSlackチャンネル名のfail-closed解決
status: proposed
date: 2026-08-15
---

# 設定済みSlackチャンネル名のfail-closed解決

## 決定

各Runtime placementに任意の `channelName` を持たせる。横断toolは `channel_ids` または `channel_names` のどちらか一方を受け、名前入力の場合はRuntime Gatewayが正規化後の完全一致で一意なplacementへ解決する。Slack APIは呼ばず、認可と名前解決を同じデプロイ設定で再現可能にする。

## 解決と認可

1. 署名済みcapability、workspace、呼出元placement、actor、toolを既存どおり検証する。
2. `channel_ids` と `channel_names` のどちらか一方だけが1〜10件指定されたことを検証する。
3. 名前はtrimし、先頭の `#` を1つ除き、小文字化する。正規化後の重複を拒否する。
4. 各名前に一致するplacementがちょうど1件であることを検証し、channel IDへ変換する。
5. 解決済みIDに対して、呼出元 `taskInventoryChannelIds` と対象 `taskInventoryAllowedUserIds` の積集合を既存どおり検証する。
6. 対象placementからproject和集合を導出し、scope外応答を拒否する。

未知名、IDとの同時指定、設定重複、未許可対象が一つでもあればupstreamを呼ばず全体を拒否する。名前は認可の代替ではなく、認可対象IDを特定する入力補助に限定する。

## 契約

- MCP schemaは `channel_ids` と `channel_names` の `oneOf` とする。検索はこれに加えて `query` を必須とする。
- `channel_names` はSlackの正規名として使用できる文字だけを許容し、1件あたり80文字までとする。
- 応答の `scope.channel_ids` は解決済みID、`scope.channel_names` は正規名を返す。
- `scope.channels` は `{ channel_id, channel_name, project_codes }` を返す。
- 既存のID入力と現在チャンネルtoolは変更しない。

## 設定と切戻し

`mana-dev-biz` に `0240-mana-dev`、`mana-accounting` に `9960-back-office` を設定する。問題時は `channelName` を除去すれば名前入力だけがfail closedになり、ID入力と現在チャンネル取得は維持される。

ローカル成功は本番成功へ丸めない。デプロイ後、チャンネル名だけの依頼がID再質問なしで成功し、返却scopeとCanonical Task件数が一致することを確認する。
