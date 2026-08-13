---
story_id: story-policy-driven-write-approval-broker
title: 依頼者と操作に応じて書き込みを自動実行・承認待ち・拒否へ分岐する
status: proposed
created_at: 2026-08-13
updated_at: 2026-08-13
source:
  type: operator-decision
  id: requester-aware-write-policy
depends_on:
  - story-shared-task-runtime-core
  - story-requester-aware-write-broker
architecture_docs:
  - path: docs/architecture/policy-driven-write-approval-broker.md
    status: proposed
spec_docs:
  - docs/specs/policy-driven-write-approval-broker-test-design.md
---

# 依頼者別の書き込み判断を共通化する

## 背景

現行の書き込み経路は、署名された依頼者・配置先・プロジェクト・操作・回数上限を検証できる。一方で、同じ操作でも「誰からの依頼か」「どの対象か」によって、自動実行してよい場合、人の承認が必要な場合、拒否すべき場合を分けられない。

## User story

mana-runtimeの運用責任者として、依頼者・配置先・プロジェクト・操作・対象に応じた書き込み判断を共通ルールで行いたい。これにより、低リスク操作は止めず、高リスク操作は承認と監査を経て、権限外操作は実行前に拒否できる。

## 受け入れ基準

- [ ] `AC-1`: 同じ依頼でも、依頼者・配置先・プロジェクト・操作・対象が異なれば、`auto`、`approval`、`deny`を独立して判定できる。
- [ ] `AC-2`: ルールが存在しない、依頼者を確定できない、対象プロジェクトが曖昧、または権限証明とルールが一致しない場合は、自動実行しない。
- [ ] `AC-3`: `approval`は元の依頼内容を固定したまま保留し、権限のある承認者が期限内に一度だけ再開できる。
- [ ] `AC-4`: 承認後も、依頼者・承認者・配置先・プロジェクト・操作・対象・予算・期限を再検証し、条件が変わっていれば実行しない。
- [ ] `AC-5`: 予算枠は実行前に確保し、成功時に確定、拒否・期限切れ・失敗時に解放する。承認は予算超過を上書きしない。
- [ ] `AC-6`: 判断から実行結果まで、依頼者、承認者、適用ルール、入力内容の同一性、変更前後、結果を追跡できる。
- [ ] `AC-7`: 最初の対象操作はCanonical Taskの作成・更新に限定し、削除、外部送信、公開、本番変更は自動実行しない。
- [ ] `AC-8`: Slack固有の承認画面が停止・再起動しても、共通の保留状態と実行判断を失わない。

## スコープ外

- Canonical Task以外の実ツール追加
- Slack画面の具体的な表示設計
- 削除・外部送信・公開・本番変更の自動実行
- 既存の署名付きcapabilityをポリシー判断そのものとして扱うこと

## 完了条件

全受け入れ基準がテスト設計へ追跡され、実装開始前に判断の正本、保留状態の正本、監査の正本、予算予約の境界が合意されていること。本Storyでは実装・本番設定・Slack投稿を行わない。
