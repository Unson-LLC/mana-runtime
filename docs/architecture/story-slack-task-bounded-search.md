---
architecture_id: arch-slack-task-bounded-search
story_id: story-slack-task-bounded-search
title: Slack会話向けCanonical Task境界付き検索アーキテクチャ
status: accepted
date: 2026-08-12
---

# Slack会話向けCanonical Task境界付き検索アーキテクチャ

## 決定

会話からの存在確認は `list_tasks` の全ページ走査ではなく、新しい `search_tasks` を使う。MCP handlerはGatewayの `/api/tasks/search` を呼び、GatewayはBrainbaseの `/api/companion/tasks/search` へ境界付き条件だけを転送する。

## 読み取りスコープ

placement認証では、placement IDから同じconnector、workspace、channelに属する有効placementのproject code和集合を導出する。この値を `project_code` としてGatewayが強制注入し、クライアント入力で広げたり外したりできない。0件に解決した場合はfail closedする。operator認証だけは明示project_codeを利用できる。

## MCP契約

`search_tasks` は `query` を必須、limitを既定20・最大20とする。status、priority、assignee_person_id、cursorを任意で受け付ける。応答の `next_cursor` と `has_more` はそのまま返す。

`list_tasks` は一覧の1ページを返す道具として残し、cursorと絞り込み条件を公開する。説明文で `next_cursor` が非nullなら未取得ページがあるため、不在を断定してはいけないことを明記する。

## データフロー

```text
MCP search_tasks
  -> Gateway GET /api/tasks/search
  -> placement project scopeを強制
  -> BrainbaseTaskClient.searchTasks
  -> Brainbase GET /api/companion/tasks/search
```

Gatewayのrouteとplacement gatewayTools allowlistには `search_tasks` を追加する。標準自動作成placementにも同じcapabilityを付与する。

## リリース順序

Brainbaseのスキーマ移行と検索APIを先にリリースし、その疎通確認後にManaをリリースする。既存placementの `gatewayTools` は自動作成時の既定値更新だけでは変わらないため、対象placementへ `search_tasks` を明示追加してから利用を開始する。追加前は認可がfail closedし、旧 `list_tasks` の全ページ走査へはフォールバックしない。

対象placementの更新前にconfig-historyのスナップショットを残し、更新後はoperatorの保護readで `gatewayTools` に `search_tasks` があること、対象channelの検索が許可され、未許可channelと無スコープ要求が拒否されることを確認する。この本番確認が終わるまでリリース完了とは扱わない。

ロールバックは、まず対象placementから `search_tasks` を外して新しい呼び出しをfail closedさせ、次にManaを直前releaseへ戻す。Brainbaseの検索APIと追加済み索引は読み取り専用かつ後方互換なので残す。Brainbase側も戻す必要がある場合だけ、Mana停止確認後に戻す。placement全体の無効化や `placements` 削除による認可緩和はロールバックに使わない。

## 変更しないもの

Canvasの表示取得、Task mutation、Slack配送、Brainbase認証方式は変更しない。
