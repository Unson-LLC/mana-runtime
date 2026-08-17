---
architecture_id: arch-task-canvas-ownership
story_id: story-task-canvas-ownership
title: Mana管理Canvasの所有権境界
status: accepted
date: 2026-08-17
---

# Mana管理Canvasの所有権境界

## 決定

信頼済み設定は、Manaによるタスクボード作成を許可する `targetId`、`workspaceId`、`channelId` と世代だけを管理する。ManaがSlack APIで新規作成したCanvas IDはDurable Objectへ保存し、以後そのIDだけを更新する。Slackで最初に見つかったCanvasや既存Canvasは所有権の根拠にしない。

## 所有権境界

1. producerは、有効で正の `bindingRevision` を持ち、静的Canvas IDまたは `autoProvision` が設定されたtargetだけをQueueへ送る。
2. consumerはQueue payloadを信用せず、`targetId` から信頼済みtargetを再解決する。
3. tenant、workspace、channel、binding revisionが信頼済みtargetと一致しないイベントはackして変更しない。
4. `autoProvision` targetにbindingがなければ、Manaのworkspace別bot tokenで`canvases.create`へ信頼済み`channelId`を渡し、返却されたCanvas IDだけをDurable Objectへ保存する。
5. 保存済みCanvas IDはSlackの `conversations.info` で対象channelに結び付くことを確認した場合だけ全文置換する。
6. 作成予約をDurable Objectで直列化する。同時実行は1件だけが作成へ進み、応答が不明な失敗では予約を保持して二重作成を防ぐ。作成されていないと確定できる失敗だけ予約を解除して再試行する。
7. 静的IDで既に運用するtargetは後方互換として維持する。静的IDが消失・不一致の場合は自動再作成しない。
8. tenant、token、projectの既存分離は維持し、Canvas IDはQueue payloadやSlack上の並び順から採用しない。

## 移行

PMSとHP制作で自動作成・再利用・同期を本番確認した実装を、登録済みの全targetへ展開する。全targetを`autoProvision: true`、正の`bindingRevision`、`enabled: true`にし、初回Queue処理でMana botが参加済みのチャンネルにCanvasを作成する。作成できないtargetは既存Canvasを採用せず、対象別の失敗として残す。作成時に返されたIDだけを実行時bindingの正本にする。

## 切戻しと検証

対象別の `enabled` をfalseに戻せば、そのtargetのscheduled更新とタスク変更後更新を止められる。検証では、未binding時に`canvases.create`が1回だけ実行され、返却IDが保存され、再実行は同じIDへの`canvases.edit`だけになることを確認する。不一致・旧イベント・競合・作成結果不明時には追加のSlack書込みが0回であることも確認する。
