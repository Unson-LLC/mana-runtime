---
architecture_id: arch-authorized-task-channel-discovery
story_id: story-authorized-task-channel-discovery
title: 認可済みタスクチャンネルの安全な投影
status: proposed
date: 2026-08-15
---

# 認可済みタスクチャンネルの安全な投影

## 決定

Runtime Gatewayに、署名済みactorが現在のplacementからタスクを横断取得できるチャンネルだけを返す読み取り専用toolを追加する。Slack APIやタスクAPIは呼ばず、デプロイ済みplacement設定を認可の正本として投影する。

## 認可境界

1. 署名済みcapability、workspace、呼出元placement、actor、tool公開可否を既存どおり検証する。
2. 呼出元 `taskInventoryChannelIds` の各IDを、全placementから一意に解決する。
3. 対象placementの `taskInventoryAllowedUserIds` にactorが含まれる対象だけを返す。
4. 同じchannel IDを複数placementが宣言する場合は、そのchannelを返さない。
5. 返却値は `channel_id`、`channel_name`、server-derivedな `project_codes` に限定する。

これは認可の追加ではなく既存認可範囲の投影である。モデル入力、Slack APIの可視範囲、通常返信用audienceを認可根拠にしない。

## AIの利用手順

- 利用者が対象チャンネル名を明示した場合は、既存の横断toolへその名前を渡す。
- 「全て」「他チャンネルも含めて」など対象を省略した場合は、まず認可済み一覧を取得し、その全channel IDを既存の横断toolへ渡す。
- 一覧が空なら取得不能として説明し、0件のタスクとは扱わない。

## 切戻しと検証

問題時はsource placementの `gatewayTools` から新toolを除去する。既存のID・名前指定横断取得と現在チャンネル取得には影響しない。ローカル成功を本番成功へ丸めず、デプロイ後にSlackの自然文依頼が再質問なしで完了することを確認する。
