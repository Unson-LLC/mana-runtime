---
story_id: placement-read-filters
title: スキル・記憶のplacement読取フィルタ（11章§3中間段階: マニフェスト注入とdenyルール遮断）
status: active
pr_scope_strategy: atomic_single_pr
pr_scope_reason: "本Storyは11章§3の読取権限モデル（中間段階）という単一の境界を成立させる変更である。スキルfrontmatterの能力宣言・セッション組立時のマニフェストフィルタ・placementローカル記憶層とそのdeny遮断・台帳ビューの列追加は、いずれも「どのセッションが何を読めるか」の同一契約を構成し相互参照するため、分割するとフィルタだけ先行して遮断が無い（または逆）中途半端な権限状態がmergeされレビューアが境界全体の整合を検証できない。よって1 PRで原子的にレビューする。repo-controlの.gitignore追記行はvibepro CLIが全コマンドで強制追記するものであり、コミットしないとworktreeが恒常dirty化して証跡束縛が壊れるため本PRに同梱する。"
pr_scope_review_facets:
  - requirements-ssot
  - runtime-behavior
  - misc-follow-up
  - e2e-gate
pr_scope_dependency_boundaries:
  - "requirements-ssot -> runtime-behavior"
  - "runtime-behavior -> misc-follow-up"
  - "runtime-behavior -> e2e-gate"
---

# スキル・記憶のplacement読取フィルタ

## User story

AIガバナンス責任者として、社内チャンネルに配置した各エージェント（placement）のセッションが「そのチャンネルに見せてよいスキルと記憶だけ」を読める状態にしたい。スキル本文には業務手順が書かれる以上、見えること自体が情報開示であり、記憶のチャンネル固有文脈が他チャンネルへ漏れることは権限境界の破れである。これにより、全セッションが全スキル・全記憶を読める現状（読取フィルタなし）を、11章§3の中間段階（マニフェスト・ビュー注入 + パス制限）へ引き上げる。

## Background

設計の正本は [docs/architecture/11_persona_skills_memory.md](../architecture/11_persona_skills_memory.md) §3（権限モデル: 第二の権限体系を発明しない）。書込側はPR #29の`--disallowedTools` denyルールで遮断済みだが、読取側は未実装（§3.3「現状」）。スコープ語彙はbrainbaseのproject名（=placementの`projects`）を借用し、ランタイム独自の権限分類を新設しない（[docs/adr/0004](../adr/0004-placement-scoped-authority.md)の方針に従う）。

## 受け入れ基準

- スキルfrontmatterの`requiredMcp`/`requiredTools`/`scope`がパースされ、`/api/skills`とスキル台帳がこれらを返す。宣言のない既存スキルはglobal・要求能力なしとして後方互換で動作する（skill capability declaration）。
- placementセッションのシステムプロンプトには、そのplacementのcapabilities（`mcp`/`gatewayTools`）で実行可能かつ`scope`がplacementの`projects`に合致するスキルだけを列挙したスキルマニフェストが注入される（skill manifest filtering）。
- placement外セッションのスキルマニフェストは従来どおり全件を列挙する。
- `memory/placements/<placementId>/`がplacementローカル記憶層として存在し、placementセッションのコンテキストには自placement分の記憶ビューだけが注入される（placement-local memory view）。
- placementセッションは他placementの`memory/placements/`配下をRead/Glob/Grepで読取できない。遮断は`--disallowedTools` denyルール（bypassPermissionsでも有効なハード境界）で行い、設定済み全placementとディスク上の既存ディレクトリを列挙してfail closedに遮断する（memory read deny）。
- `memory/`直下の共通記憶は全placementから従来どおり可視である。
- webのスキル台帳ビューにscope/requiredMcpの列が表示され、スキルの可視範囲が一覧で確認できる（ledger view columns）。
- 追加・変更した挙動に自動テストがあり、`packages/jimmy`のvitest全件とtypecheckが通る。

## シナリオ

- SKILLVIS-STORY-S-001: webのスキル台帳ビューで、各スキルのscope（globalまたはproject名）とrequiredMcpが一覧列として確認できる。

## Scope

- 対象: `packages/jimmy`のスキルfrontmatterパース（cli/skills.ts）・`/api/skills`（gateway/api.ts）・セッション組立（sessions/context.ts）・placement境界（shared/placement-profile.ts）、`packages/web`のスキル台帳ページ、11章§3.3の現在地更新。
- 非対象: Bash経由のシェル読取・書込の遮断（08章の既知残ギャップ）、placementごとの実行ホーム分離（§3.3最終段階）、業務記憶のbrainbase RACI判定（brainbase側の責務）、スキル本文のファイルシステム読取遮断（最終段階で実行ホーム分離により解消）。
