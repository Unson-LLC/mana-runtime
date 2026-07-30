---
story_id: agent-ledger-gaps
title: Agent Ledger Gaps Spec
status: accepted
architecture_docs:
  - docs/architecture/channel-placement-profiles.md
diagrams:
  - kind: threat_model
    mermaid: |
      flowchart LR
        E[Slack event] --> R{Placement resolver}
        R -->|unmatched or ambiguous| X[Reject before agent execution]
        R -->|enabled: false| K[placement_disabled security_event] --> X
        R -->|enabled placement| A[Audience authorization]
        A --> G[Agent execution]
        G --> O{Delivery authorization}
        O -->|placement disabled| X
        O -->|allowed| S[Slack response]
        Cfg[config.yaml placements] --> L[GET /api/placements ledger]
        DB[(sessions.transport_meta.placementId)] --> L
        L -->|operator token required| V[Web panel ledger view]
    rationale: kill switchは解決・配信の両境界でfail closedにし、台帳ビューはoperator認可の内側だけに公開する。
---

# Agent Ledger Gaps Spec

Story: `agent-ledger-gaps`

## User story

AIガバナンス責任者として、社内チャンネルに配置した各エージェント（placement）について「誰が所有し、何のためにあり、月にいくら使い、どう止めるか」を台帳として一元的に把握・統制したい。これにより、作りっぱなしのplacementの放置、費用の不可視、停止手段の欠如、設定変更履歴の欠落をなくす。

正本ギャップ分析: `docs/architecture/10_company_brain.md` §7（PR #27 / branch `docs/architecture-restructure`）。

## Acceptance criteria

1. `PlacementProfile`は任意フィールド`owner`（所有者・スポンサーのSlack user IDまたは人名）と`purpose`（目的・説明文）を持つ。未設定の既存configはそのまま動作する（後方互換）。
2. placement単位の月次コスト集計が取得できる。集計は`sessions.transport_meta`のJSON `placementId`をキーとし、placementに紐付かないセッションのコストは`(unplaced)`として漏れなく可視化される。
3. `enabled: false`を設定したplacementは、channel/workspace一致で解決されても`resolvePlacement`が`denied`（reason: `disabled`）を返し、エージェント実行前にfail closedで止まる。`enabled`未設定は有効として扱う。
4. 無効化されたplacementは`send_message`等の配信認可・派生セッション認可でも拒否される。既存セッション経由の継続実行もplacement再解決で止まる。
5. placementの無効化・拒否は`security_event`（`placement_disabled`相当のreason）として監査ログに記録される。
6. 台帳一覧API `GET /api/placements` が、configの全placementについて id / connector / workspaceId / channelId / audience type / owner / purpose / enabled / 担当employee / defaultModel / capabilities概要 / 当月コスト / 当月セッション数 / 最終利用時刻 を返す。secret様の値は既存のredaction機構で`[REDACTED]`化され、生のtokenを含まない。
7. `GET /api/placements`はlocalhost管理APIの既存operator token認可規則（機密read API扱い）に従う。
8. web panelに台帳一覧ビューがあり、owner/purpose未設定のplacement、budget対象外（agent.employee未設定）のplacement、enabled: falseのplacementが一目で識別できる。
9. placementの廃止手順（kill switch → 観察期間 → config削除 → 台帳からの消滅確認）と、pilot `~/.ryoko/config.yaml`のgit変更管理手順（secretはInfisical/env注入のままcommit対象へ含めない）が運用文書として存在する。
10. 追加・変更した挙動（owner/purpose透過、placementコスト集計、disabled fail-closed、台帳API redaction）に自動テストがあり、既存のsessions/gatewayテストとtypecheckが全て通る。

## Configuration contract

```yaml
placements:
  - id: mana-test
    connector: slack
    workspaceId: T01234567
    channelId: C01234567
    # --- agent ledger fields (all optional, backward compatible) ---
    owner: U01234567        # 所有者・スポンサー。放置placementの責任者を特定する
    purpose: "brainbase運用のoperator対話"  # 目的。idの命名頼みをやめる
    enabled: true           # false で即fail-closed（kill switch）。未設定は有効
    audience:
      type: operator
      allowedUsers: [U01234567]
    agent:
      employee: ryoko       # budget集計の紐付け先。未設定だとemployee budget対象外
```

## Non-goals

- placement単位のbudget上限・自動pause（employee budgetの既存機構を置き換えない）
- dataScopesのサーバー側強制（ソフト境界のままとする。別Story）
- 台帳の外部公開・他社向けガバナンス診断商品化（roadmap柱5の後続）
