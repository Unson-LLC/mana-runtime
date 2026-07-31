---
story_id: placement-allowed-tools
title: ツール許可のplacement導出とspawn時バインド（G1+G4: グローバルallowlist・boot束縛の廃止）
status: active
pr_scope_strategy: atomic_single_pr
pr_scope_reason: "本StoryはplacementセッションのツールAllow境界を『capabilitiesからの導出+spawn毎バインド』という単一契約に置き換える変更である。導出関数・EngineRunOpts経路・warm PTYのcold-respawn鍵・freee書込系の恒常denyは、いずれも『どのセッションがどのツールを承認なしで実行できるか』の同一権限境界を構成し、分割すると導出だけ先行してspawnに届かない（またはdenyだけ先行してallowが壊れる）中途半端な権限状態がmergeされる。よって1 PRで原子的にレビューする。"
pr_scope_review_facets:
  - permission-derivation
  - engine-spawn-binding
  - deny-precedence
pr_scope_dependency_boundaries:
  - "permission-derivation -> engine-spawn-binding"
  - "permission-derivation -> deny-precedence"
---

# ツール許可のplacement導出とspawn時バインド

## User story

AIガバナンス責任者として、placementに能力（MCPサーバー・gatewayツール）を1つ追加したら、そのplacementのセッションが次のspawnから該当ツールを承認プロンプトなしで使える状態にしたい。現状は`engines.claude.interactiveAllowedTools`という**グローバル**設定がエンジンconstructorに**boot時**バインドされるため、placementごとのツール差が表現できず、変更のたびにgateway再起動が必要である（2026-07-31のfreee接続で「don't askブロック→再起動」の実障害）。能力の正本はplacementの`capabilities`ただ1箇所とし、ツール許可はそこから導出する（gap分析G1+G4、ADR-0004「第二の権限体系を発明しない」のランタイム内適用）。

## Background

背景の正本は [docs/discovery/gap-analysis-capability-config-2026-07-31.md](../discovery/gap-analysis-capability-config-2026-07-31.md) のG1・G4。`disallowedTools`はPR #29/#41/#47で既にEngineRunOpts経由でspawn毎に渡しており、allowedToolsも同じ経路・同じパターンに載せる。warm PTYへの反映は既存のdenyKeyパターン（claude-interactive.tsのspawnParams / cold-respawn）を拡張する。恒常denyは`PLACEMENT_MCP_TOOL_DENY`（PR #47）の機構をそのまま使う。原則はADR-0001（deny-by-default）。

## 受け入れ基準

- placementセッションのallowedToolsが`capabilities`から導出される: `capabilities.mcp`の各サーバー名（gatewayを除く）はサーバー全体許可（`mcp__<server>__*`形式。Claude Code公式のallowルールはリテラルなサーバー名プレフィックス+ツール名globをサポート）、`capabilities.gatewayTools`は`mcp__gateway__<tool>`の個別許可として導出される（capability-derived allow）。
- 導出されたallowedToolsはEngineRunOpts経由でspawnごとにエンジンへ渡され、placementEngineBoundary（shared/placement-profile.ts）が唯一の導出点である（spawn-time binding）。
- 恒常deny（`PLACEMENT_MCP_TOOL_DENY`）は従来どおり--disallowedToolsで渡され、allowに常に勝つ: 導出allowにサーバー全体許可が含まれていても、deny対象ツールはdisallowedToolsに残る（deny precedence）。
- freeeの書込系ツール（freee_api_post/put/delete/patch/freee_file_upload）が`PLACEMENT_MCP_TOOL_DENY`に追加され、全placementでdenyされる（read-only維持。G2のread-only語彙が入るまでの暫定）（freee write deny）。
- 非placementセッションは現状維持: グローバル`interactiveAllowedTools`がそのまま使われ、挙動変更がない（non-placement unchanged）。
- placementセッションはグローバル`interactiveAllowedTools`に依存しない: グローバル側に該当ツールが無くても`capabilities.mcp`にあれば導出される（「3箇所目の登録」の廃止）（global independence）。
- allowedToolsの変更はwarm PTYに対してcold-respawnを強制する: spawnParamsの境界鍵にallowedToolsが含まれ、鍵が変わったwarm PTYは再利用されない（cold respawn key）。
- config hot-reloadで次セッション（次spawn）から新しいcapabilitiesが反映され、gateway再起動を要しない（boot時固定の廃止）（hot reload effective）。
- 追加・変更した挙動に自動テストがあり、`packages/jimmy`のvitest全件とtypecheckが通る。

## シナリオ

- ALLOWTOOLS-STORY-S-001: mana-accounting/mana-backofficeのように`capabilities.mcp`に`freee`を持つplacementのセッションspawn引数には、グローバルinteractiveAllowedToolsにfreeeが無くても`mcp__freee__*`のサーバー許可が含まれ、同時にfreee書込系5ツールが--disallowedToolsに含まれる。

## Scope

- 対象: `packages/jimmy`のplacement境界（shared/placement-profile.ts）・EngineRunOpts（shared/types.ts）・インタラクティブエンジン（engines/claude-interactive.ts）・headlessエンジン（engines/claude.ts）、docs/architecture/04_auth_permission.mdの3層ゲート説明、gap分析の対応状況更新。
- 非対象: read/write粒度の語彙（G2）とMCPカタログメタデータ（G6）、dataScopesソフト境界の自動生成（G3）、gatewayツールroute対応表の生成化（G5）。サーバー単位許可の形式は公式ドキュメント（permissions - Tool name wildcards）で検証済み: allowルールは`mcp__<server>__*`（サーバー名リテラル+ツール名glob）を受け、denyルールはallowに常に優先する。
