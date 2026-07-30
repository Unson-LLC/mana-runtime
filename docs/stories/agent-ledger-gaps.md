---
story_id: agent-ledger-gaps
title: エージェント台帳の不足を埋める（owner/purpose・placement月次コスト・kill switch・台帳ビュー・config変更管理）
status: active
pr_scope_strategy: atomic_single_pr
pr_scope_reason: >-
  本Storyは「エージェント台帳」という単一のガバナンス境界を成立させる変更であり、
  台帳フィールド（owner/purpose/enabled）・placement単位コスト集計・kill switchの
  fail-closed境界・台帳API/ビュー・運用手順は相互に参照し合う一体のリリース単位である。
  分割するとkill switchだけが先行して台帳ビューに表示されない等、レビューアが
  境界全体の整合を検証できなくなるため、1 PRで原子的にレビューする。
pr_scope_review_facets:
  - repo-control
  - requirements-ssot
  - runtime-behavior
  - misc-follow-up
pr_scope_dependency_boundaries:
  - "repo-control -> requirements-ssot"
  - "requirements-ssot -> runtime-behavior"
  - "runtime-behavior -> misc-follow-up"
---

# エージェント台帳の不足を埋める

## User story

AIガバナンス責任者として、社内チャンネルに配置した各エージェント（placement）について「誰が所有し、何のためにあり、月にいくら使い、どう止めるか」を台帳として一元的に把握・統制したい。これにより、作りっぱなしのplacementの放置、費用の不可視、停止手段の欠如、設定変更履歴の欠落をなくす。

## Background

ギャップ分析の正本は `docs/architecture/10_company_brain.md` §7（PR #27 / branch `docs/architecture-restructure`）。Microsoft Entra / AWSの管理水準と突き合わせ、所有者・目的・placement単位費用・kill switch・変更管理・廃止フロー・台帳一覧が欠落と判定された。実装仕様は [docs/specs/agent-ledger-gaps.md](../specs/agent-ledger-gaps.md)、権限設計は [docs/architecture/channel-placement-profiles.md](../architecture/channel-placement-profiles.md)。

## Acceptance criteria

1. `PlacementProfile`が任意フィールド`owner`/`purpose`を持ち、未設定の既存configは後方互換で動作する。
2. placement単位の月次コスト集計が`sessions.transport_meta.placementId`から取得でき、未紐付けセッションは`(unplaced)`として漏れなく可視化される。
3. `enabled: false`のplacementは解決・配信・派生セッション・session実行の各境界でfail closedに拒否される。`enabled`未設定は有効。
4. 無効化による拒否は`security_event`（`placement_disabled`）として監査ログに記録される。
5. `GET /api/placements`が台帳項目と当月コスト・セッション数・最終利用を返し、secret様の値はredactされ、operator token認可に従う。
6. web panelの台帳ビューでowner/purpose未設定・budget対象外・無効化済みplacementが識別できる。
7. placement廃止手順とpilot config.yamlのgit変更管理手順が運用文書として存在する。
8. 追加挙動に自動テストがあり、既存sessions/gatewayテストとtypecheckが通る。

## Scope

- 対象: `packages/jimmy`のplacement境界・コスト集計・台帳API、`packages/web`の台帳ページ、運用文書、pilot configのgit管理化（運用作業）。
- 非対象: placement単位budget上限・自動pause、dataScopesのサーバー側強制、台帳の外部公開。
