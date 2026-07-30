---
story_id: placement-read-filters
title: Placement Read Filters Spec
status: accepted
architecture_docs:
  - docs/architecture/11_persona_skills_memory.md
diagrams:
  - kind: threat_model
    mermaid: |
      flowchart LR
        S[Session assembly] --> P{Placement session?}
        P -->|no| ALL[Skill manifest: all skills]
        P -->|yes| F[Filter: capabilities + scope]
        F --> M[Skill manifest: allowed subset only]
        S --> MV[Memory view: own placement dir only]
        P -->|yes| D[disallowedTools Read/Glob/Grep deny for other placements' memory dirs]
        D --> HB[Hard boundary even in bypassPermissions]
        MEM[memory/ root shared memory] -->|visible to all placements| S
    rationale: スキルは「見えること自体が情報開示」なのでマニフェストから隠し、記憶はdenyルールでパスごと遮断する。共通記憶は全公開のまま（機微を書かない規律は文書側）。
---

# Placement Read Filters Spec

Story: `placement-read-filters`

## User story

AIガバナンス責任者として、placementセッションが「そのチャンネルに見せてよいスキルと記憶だけ」を読める状態にしたい。設計の正本は `docs/architecture/11_persona_skills_memory.md` §3。本Specは§3.3の「中間段階」（gatewayがセッションごとにスキルマニフェスト・記憶ビューを生成して注入し、パス制限で遮断する）を実装する。

## Acceptance criteria

1. スキルの`SKILL.md` frontmatterは任意フィールド`requiredMcp`（MCPサーバー名の配列）・`requiredTools`（gatewayツール名の配列）・`scope`（brainbaseのproject名。placementの`projects`と同一語彙）を持てる。パーサはインライン配列（`[a, b]`）とYAMLリスト、単一文字列を受け付ける。宣言のないスキルは`scope`なし（=global）・要求能力なしとして扱う（後方互換）。
2. `GET /api/skills`は各スキルについて`name`/`description`に加え`requiredMcp`/`requiredTools`/`scope`を返す。
3. セッション組立（`buildContext`）はスキルマニフェスト（名前・説明・scope）をシステムプロンプトへ注入する。placementセッションでは以下を**すべて**満たすスキルだけが載る:
   - `requiredMcp`の全要素がplacementの`capabilities.mcp`（配列）に含まれる。`capabilities.mcp`が`false`または未設定のとき、`requiredMcp`を持つスキルは載らない
   - `requiredTools`の全要素がplacementの`capabilities.gatewayTools`に含まれる
   - `scope`が未設定（global）、またはplacementの`projects`に含まれる
4. placement外セッションのマニフェストは全スキルを列挙する（従来の可視性を変えない）。
5. `memory/placements/<placementId>/`をplacementローカル記憶層とする。placementセッションのコンテキストには自placementのディレクトリ配下のファイル一覧（記憶ビュー）だけが注入され、他placementの記憶はビューに現れない。
6. placementセッションの`--disallowedTools`に、Read/Glob/Grepの読取denyルールが追加される。対象は「設定済み全placementのIDから導かれる`memory/placements/<id>/`」と「ディスク上に実在する`memory/placements/`直下のディレクトリ」の和集合から自placementを除いたもの。denyルールはbypassPermissionsでも有効なハード境界である（`placementWriteDenyRules`と同じ機構）。
7. `memory/`直下の共通記憶ファイルは読取denyの対象にしない（全placement可視のまま。機微を書かない規律は11章§3.1が定める文書側の責務）。
8. webのスキル台帳ビューは、各スキルのscope（未設定はglobal表示）とrequiredMcpを一覧列として表示する。
9. 追加挙動（frontmatterパース、マニフェストフィルタ、記憶ビュー注入、読取deny）に自動テストがあり、`packages/jimmy`のvitest全件とtypecheckが通る。

## Skill frontmatter contract

```markdown
---
name: salestailor-weekly-sync
description: SalesTailor専用。直近1週間の差分をNocoDBへ最新化する。
requiredMcp: [nocodb]
requiredTools: [create_task]
scope: salestailor
---
```

- `scope`の語彙はplacementの`projects`と同一（=brainbaseのproject名）。ランタイム独自の分類を新設しない（11章§3、ADR 0004）。
- スキルは能力を**付与しない**。能力の正本はplacementの`capabilities`であり、フィルタは「使えないスキルを見せない」「scope外チャンネルへ本文の存在を開示しない」ための導出に過ぎない。

## Design decisions

- **denyルールは列挙式**: Claude Codeのpermissionは「自placementだけ許可し他を拒否」という例外つき許可を表現できないため、他placementのパスを列挙してdenyする。列挙は設定済みplacement（config）とディスク実在ディレクトリの和集合で、セッション開始時点に存在するものをfail closedに覆う。
- **残ギャップ**: セッション開始後に新設されたplacementのディレクトリは、走行中の既存セッションからは遮断されない（次セッションから遮断される）。placement新設はconfig編集を要する管理操作であり、Bash残ギャップ（08章）と同様に最終段階（実行ホーム分離）で解消する。
- **スキル本文のファイル読取は遮断しない**: 中間段階のスキル側はマニフェスト（可視性の導出）のみ。本文の物理遮断は最終段階の実行ホーム分離で行う。

## Non-goals

- Bash経由のシェル読取・書込の遮断（08章の既知残ギャップ）
- placementごとの実行ホーム分離（11章§3.3最終段階）
- 業務記憶のRACI判定（brainbase側サービストークンscopeの責務。ランタイムは判定しない）
- placementセッションからの記憶書込の許可（書込はPR #29のdeny + HITL提案経路のまま）
