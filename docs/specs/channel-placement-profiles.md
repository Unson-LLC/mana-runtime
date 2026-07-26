---
story_id: channel-placement-profiles
title: Channel Placement Profiles Spec
status: accepted
architecture_docs:
  - docs/architecture/channel-placement-profiles.md
diagrams:
  - kind: threat_model
    mermaid: |
      flowchart LR
        U[Slack user] --> E[Slack event]
        E --> R{Placement resolver}
        R -->|unmatched or ambiguous| X[Reject before agent execution]
        R -->|unique match| A[Audience authorization]
        A -->|user denied| X
        A --> C[Capability resolver]
        C --> M[Allowed MCP and Gateway tools]
        M --> G[Agent execution]
        G --> O{Output authorization}
        O -->|destination denied| X
        O -->|allowed| S[Slack response]
        G --> D{Derived session request}
        D -->|missing parent or override attempt| X
        D -->|allowed employee| P[Inherit parent Placement]
    rationale: Placement解決、派生セッション、外部送信の各境界で権限拡張をfail closedにする。
---

# Channel Placement Profiles Spec

Story: `channel-placement-profiles`

## User story

Slack運用責任者として、同じOpenRyokoランタイムを複数の社内チャンネルで使う際に、チャンネルごとに利用者、担当Employee、モデル、MCP、Gateway tools、参照文脈、投稿先を制限したい。これにより、一つのチャンネルへ付与した能力や情報が別チャンネルへ暗黙に広がらないようにする。

## Acceptance criteria

1. `placements`が未設定の場合は既存の単一Slack配置として動作する。
2. `placements`が設定されている場合、Slackメッセージはconnector、workspace、channel、userが一致する一意なPlacementだけにルーティングされる。
3. 未登録チャンネル、許可されていない利用者、曖昧に複数一致する設定はfail closedになる。
4. Placementは担当Employee、通常モデル、重要レビュー担当を上書きできる。
5. PlacementのMCP設定はdeny-by-defaultであり、明示したMCPだけをClaudeへ渡す。
6. Gateway MCPはPlacementで明示したtoolだけを公開・実行できる。
7. `send_message`はPlacementで許可したconnector/channel以外へ投稿できない。
8. system promptにはplacement ID、audience、projects、data scopeが実行文脈として含まれる。
9. Placement判定と能力解決には秘密値を含めず、ログにも秘密を出さない。
10. resolver、MCP制限、送信制限、Slack reaction、子委譲とcross-requestのPlacement継承について正常系と拒否系の自動テストがある。
11. 子セッションとcross-requestは実在する親セッションを必須とし、親Placementを継承して許可外Employeeへの委譲を拒否する。Placement子でEmployeeを省略した場合は親Employeeを継承し、engine/model/effortのリクエスト上書きは拒否する。
12. Placement有効時のlocalhost管理mutationはoperator tokenで認証し、token原文を設定API、ログ、Claude子プロセスへ公開しない。
13. Discord remote proxyは専用service principalを必須とし、missing/wrong tokenを拒否する。

## Configuration contract

```yaml
placements:
  - id: mana-test
    connector: slack
    workspaceId: T01234567
    channelId: C01234567
    audience:
      type: operator
      allowedUsers:
        - U01234567
    agent:
      employee: ryoko
      defaultModel: sonnet
      escalationEmployee: critical-reviewer
    projects:
      - brainbase
      - brainbase-mana
    capabilities:
      mcp:
        - brainbase
        - gateway
      gatewayTools:
        - create_child_session
      allowedDelivery:
        - connector: slack
          channel: C01234567
    dataScopes:
      graph:
        mode: read-only
        scopes:
          - project:brainbase
          - context:philosophy
```

## Boundary

このStoryではOpenRyoko内部のSlack、Employee、MCP、Gateway tool、delivery境界を強制する。Graph APIそのものの行・ノード単位認可はGraph側の別Storyとし、本Storyではdata scopeを実行文脈へ渡して監査可能にする。社外・顧客間の強い隔離は別ランタイムを使用する。

`workspaceId`は必須で、空の`placements`は未設定と同じlegacy modeである。重要案件やGateway toolから作る子セッションは親Placementを継承し、委譲先Employee、実行engine/model/effort、MCP、tool、delivery、dataScopesの境界を緩めない。Employee省略時は親の実行設定を継承し、明示した許可Employeeへの委譲時はEmployee定義から実行設定をサーバー側で決める。Slack reaction経路もイベントのworkspace IDを使う。

環境固有IDはInfisicalラッパーが完成済みYAMLへ投影する。OpenRyokoは`${VAR}`のplaceholder展開を行わない。cron/briefing、Skills、Graph/repositoryのサーバー側scope、詳細監査は後続Storyで扱い、Phase 1の完了条件には含めない。

Placement有効時は、operator tokenのSHA-256を`OPENRYOKO_OPERATOR_TOKEN_SHA256`へ注入する。ブラウザは元tokenを`localStorage["openryoko.operatorToken"]`だけに保持し、管理mutationへ`x-openryoko-operator-token`として送る。hash未設定または不一致はfail closedとする。Discord remote proxyの`proxyToken`は別credentialであり、設定APIではredactする。
