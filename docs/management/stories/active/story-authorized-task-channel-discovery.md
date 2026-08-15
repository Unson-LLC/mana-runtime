---
story_id: story-authorized-task-channel-discovery
title: AIが許可済みタスクチャンネルを自動選択する
status: active
created_at: 2026-08-15
updated_at: 2026-08-15
source:
  type: operator-decision
  id: slack-authorized-channel-discovery-2026-08-15
depends_on:
  - story-authorized-cross-channel-task-inventory
architecture_docs:
  - path: docs/architecture/story-authorized-task-channel-discovery.md
    status: proposed
---

# AIが許可済みタスクチャンネルを自動選択する

## 背景

利用者が「他チャンネルも含めて全部」と依頼しても、現在は対象チャンネル名の列挙を求められる。Runtimeはすでに利用者ごとの横断参照範囲を保持しており、利用者にその設定を再入力させる必要はない。

## User story

複数チャンネルにタスクを持つ利用者として、チャンネル名を覚えて列挙せずに「許可された全チャンネルのタスク」を取得したい。これにより、AIが取得可能な範囲を確認して適切な横断取得を実行できる。

## 受け入れ基準

- [x] `AC-1`: AIは、現在の利用者がタスクを取得できるチャンネルのID、正規名、projectを一覧できる。
- [x] `AC-2`: 一覧は呼出元の `taskInventoryChannelIds` と対象側の `taskInventoryAllowedUserIds` の積集合だけを返す。
- [x] `AC-3`: 未設定・対象利用者不一致は開示せず、取得可能な対象だけを返す。重複placementの設定不整合は一覧全体をfail closedで拒否する。
- [x] `AC-4`: Slack promptは「全て」「他チャンネルも含めて」のように対象名が省略された場合、一覧を取得してから横断toolを使い、利用者へチャンネル名を質問しない。
- [x] `AC-5`: 一覧が空なら横断toolを呼ばず取得不能として説明し、タスク0件とは扱わない。明示的なチャンネル名・IDによる既存の横断取得と、現在チャンネル取得を維持する。
- [ ] `AC-6`: unit、integration、型検査、buildを通し、デプロイ後のSlack依頼が再質問なしで完了する。

## スコープ外

- Slack workspace全体のチャンネル一覧
- 横断参照権限の追加
- 部分一致や別名検索

## ADR判断

既存placement認可の読み取り専用投影をGateway toolとして追加する局所変更であり、新しい正本・認証方式・永続化を導入しないため独立ADRは不要とする。
