# mana-runtime ドキュメント

このディレクトリは mana-runtime（Slack常駐AI社員「マナ」のランタイム）の設計・運営文書の正本です。
構成は [tech-knight-dev-playbook](https://github.com/Tech-Knight-inc/tech-knight-dev-playbook) の章立てを部分採用しています（採用判断は 2026-07-30、product/design/features 章は不採用 — 下記参照）。

## ディレクトリ構成と正本の所在

| ディレクトリ | 役割 | 備考 |
|---|---|---|
| `architecture/` | **システム全体の技術設計**（番号章 `01`〜`09`） | playbook章立て。`story-*.md` はVibePro機能単位の設計でこれとは別系統 |
| `adr/` | 後から理由を知る必要がある設計判断の記録 | |
| `discovery/` | 既存実装からドキュメントを起こす際の棚卸し | 確認済み内容だけを `architecture/` へ昇華する |
| `management/` | **プロダクト層の正本 = [roadmap.md](management/roadmap.md)**（ビジョン・5本柱・優先順位・進捗） | playbookの `product/` 章はこれで代替（二重管理しない） |
| `specs/` | VibePro Spec（機能単位、`*.vibepro.json` 含む） | 機能フローはVibePro（Story→Architecture→Spec→Gate）が正本。playbookの `features/` 章は不採用 |
| `contracts/` / `responsibility-authority/` | VibeProの機械可読アーティファクト | |
| `plans/` | 歴史資料（初期設計・移植計画） | [jimmy-design.md](plans/2026-03-06-jimmy-design.md) はplacement導入以前の姿。現在地は `architecture/01` を正とする |
| `superpowers/` / `upstream-port/` | upstream（jinn）由来の歴史資料 | |

## 読み方

- プロダクト理解: `management/roadmap.md`
- 技術理解: `architecture/01_system_overview.md` → `04_auth_permission.md` → 必要な章へ
- 機能単位の仕様: `management/stories/active/` → `architecture/story-*.md` → `specs/`
- 設計判断の経緯: `adr/`
