---
architecture_id: arch-task-canvas-ownership
story_id: story-task-canvas-ownership
title: Mana管理Canvasの所有権境界
status: proposed
date: 2026-08-16
---

# Mana管理Canvasの所有権境界

## 決定

タスクボード更新対象は、信頼済み設定で `targetId`、`workspaceId`、`channelId`、`manaCanvasId` が明示的に結び付けられ、かつ対象別に有効化されたCanvasだけとする。Slackで最初に見つかったCanvasを所有権の根拠にしない。

## 所有権境界

1. producerは、有効かつ `manaCanvasId` を持つtargetだけをQueueへ送る。
2. consumerはQueue payloadを信用せず、`targetId` から信頼済みtargetを再解決する。
3. workspace、channel、Canvasの三点が信頼済みtargetと一致しないイベントはackして変更しない。
4. Slackの `conversations.info` で対象channelに結び付くCanvas IDと `manaCanvasId` が一致する場合だけ全文置換する。
5. Canvas未設定、無効、不一致、消失では作成・採用・再作成をせず、構造化ログへ理由を残す。
6. tenant、token、projectの既存分離は維持し、Canvas IDはQueue payloadやSlack上の並び順から採用しない。

## 移行

既存targetは管理Canvas IDを持たないため、安全側で無効として扱う。運用者が対象Canvasの用途を確認し、IDを設定して対象別に有効化するまで自動更新しない。一括有効化はしない。

## 切戻しと検証

対象別の `enabled` をfalseに戻せば、そのtargetのscheduled更新とタスク変更後更新を止められる。検証では、明示ID一致時だけ `canvases.edit` が1回実行され、未設定・不一致・旧イベント・競合時にはSlack書込みが0回であることを確認する。
