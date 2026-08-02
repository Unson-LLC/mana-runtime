---
story_id: mcp-readonly-vocabulary
title: capabilities.mcpのread-only語彙とMCPカタログのツール分類（G2+G6: freee手書きdeny列挙の置換）
status: active
pr_scope_strategy: atomic_single_pr
pr_scope_reason: "本Storyは『カタログがツールのread/write分類を宣言し、placementがread-onlyモードを指定し、境界導出がwrite denyを生成する』という単一の権限語彙を導入する変更である。カタログ宣言（G6）・capabilities.mcpのエントリ形式拡張（G2）・暫定PLACEMENT_MCP_TOOL_DENYからのfreee書込5ツール削除は、いずれも『read-only指定されたMCPサーバーの書込ツールが全permission modeで拒否される』という同一権限境界を構成し、分割すると暫定denyだけ外れてread-only導出が届かない（またはカタログ宣言だけ先行して指定語彙が無い）中途半端な権限状態がmergeされる。よって1 PRで原子的にレビューする。"
pr_scope_review_facets:
  - catalog-tool-classification
  - readonly-mode-derivation
  - interim-deny-replacement
pr_scope_dependency_boundaries:
  - "catalog-tool-classification -> readonly-mode-derivation"
  - "readonly-mode-derivation -> interim-deny-replacement"
---

# capabilities.mcpのread-only語彙とMCPカタログのツール分類

## User story

AIガバナンス責任者として、placementごとにMCPサーバーのread/write粒度を宣言的に変えたい（例: 経理チャンネルはfreeeを参照のみ、将来の経理担当placementは書込も可）。現状のfreee read限定は`PLACEMENT_MCP_TOOL_DENY`にfreee書込5ツールを固定列挙する暫定実装（PR #52で「G2の語彙が入るまでの暫定」と明記）で、全placement一律にしか効かず、ツール名の手書き列挙という「第二の正本」を運用者が保守している。カタログ（`mcp.custom.<name>`）が自サーバーのツール分類を宣言し（G6、スキルfrontmatterと同じ「資産側が自分の性質を宣言する」型）、placementの`capabilities.mcp`が`{name: freee, mode: read-only}`という1語の粒度指定を書けば（G2）、境界導出が書込ツールdenyを自動生成する状態にする（ADR-0004「第二の権限体系を発明しない」、ADR-0001 deny-by-default）。

## Background

背景の正本は [docs/discovery/gap-analysis-capability-config-2026-07-31.md](../discovery/gap-analysis-capability-config-2026-07-31.md) のG2・G6（G1/G3/G4は対応済み）。導出はPR #52の`placementAllowedTools`とdeny precedence（denyは常にallowに勝つ）の機構にそのまま載せる。`mcp__brainbase__search_personal_kg`の恒常denyは語彙ではなく機微の既定（G7）なので`PLACEMENT_MCP_TOOL_DENY`に残す。

## 受け入れ基準

- カタログの`mcp.custom.<name>.tools.writeTools`にそのサーバーの書込ツール名（bareツール名）を宣言できる。宣言はスキルfrontmatter（requiredMcp/scope）と同型の「資産側の自己宣言」である（catalog tool classification）。
- `capabilities.mcp`のエントリを従来の文字列（サーバー全ツール許可）に加えて`{name: <server>, mode: read-only}`形式で書ける。read-only指定されたサーバーは、カタログの`writeTools`が`mcp__<server>__<tool>`形式の--disallowedToolsへ導出され、deny precedenceにより全permission modeで書込ツールが拒否される（read-only mode derivation）。
- カタログにツール分類（`tools.writeTools`）宣言のないサーバーへのread-only指定はfail-closed拒否される: そのサーバーはallowedToolsにもMCP設定にも含まれず、セッションから一切使えない（undeclared classification fail-closed）。
- `PLACEMENT_MCP_TOOL_DENY`からfreee書込5ツール（freee_api_post/put/delete/patch/freee_file_upload）が削除され、カタログの`writeTools`宣言+placement側`{name: freee, mode: read-only}`の組で従来と同一のdeny集合が導出されることがテストで保証される。`mcp__brainbase__search_personal_kg`の恒常denyは維持される（interim deny replacement）。
- 既存の文字列形式`capabilities.mcp`エントリは無変更で従来どおり動く: サーバー全体許可（`mcp__<server>__*`）が導出され、スキル可視性・MCP設定解決・能力宣言生成の挙動が変わらない（backward compatibility）。
- 台帳ビュー（GET /api/placements・web placements画面）に各MCPサーバーのmode（full / read-only）が表示される（ledger mode visibility）。
- system promptの能力宣言（capabilities由来の自動生成）にread-onlyサーバーのmodeと拒否される書込ツールが併記され、fail-closed拒否されたサーバーは利用不能と明示される（capability declaration accuracy）。
- docs/architecture/04_auth_permission.mdのcapabilities例・gap-analysisのG2/G6対応状況・template/config.default.yamlのカタログ例（freeeのwriteTools宣言）が更新される（docs updated）。
- 追加・変更した挙動に自動テストがあり、`packages/jimmy`のvitest全件とtypecheckが通る。

## シナリオ

- MCPRO-STORY-S-001: カタログ`mcp.custom.freee.tools.writeTools`にfreee書込5ツールを宣言し、placementの`capabilities.mcp`に`{name: freee, mode: read-only}`を書くと、そのplacementのspawn引数には`mcp__freee__*`のallowと書込5ツールの`mcp__freee__<tool>` denyが含まれ、`PLACEMENT_MCP_TOOL_DENY`固定列挙時代と同一のdeny集合になる。
- MCPRO-STORY-S-002: カタログにツール分類宣言のないサーバーを`{name: <server>, mode: read-only}`で指定すると、そのサーバーはallowedTools・MCP設定から除外され（fail-closed）、能力宣言に利用不能と明示される。

## Scope

- 対象: `packages/jimmy`のplacement境界（shared/placement-profile.ts）・型（shared/types.ts）・MCP解決（mcp/resolver.ts呼び出し側）・能力宣言（sessions/context.ts）・台帳（gateway/placements.ts）・engine呼び出し点（sessions/manager.ts / gateway/api.ts）、`packages/web`のplacements画面、docs（04章・gap-analysis）・template/config.default.yaml。
- 非対象: gatewayツールroute対応表の生成化（G5）、pilot本番config.yamlの適用（PR本文に移行手順のみ明記し、適用は人間/別セッション）、freee以外のサーバー（brainbase/nocodb等）のwriteTools初期整備。
