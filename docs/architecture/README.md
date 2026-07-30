# Architecture

このディレクトリは、mana-runtime全体で共通する技術設計を管理します。

- 番号章（`01`〜`09`）= **システム全体設計の正本**。実装と食い違ったら、コードを直すかこの章を直すかを明示的に選ぶ
- `story-*.md` = VibePro機能単位のアーキテクチャ文書（Story→Spec→Gateの系統）。全体設計と矛盾したら新しい方に正本を寄せ、ADRに残す
- 後から理由を知る必要がある設計判断は [docs/adr/](../adr/) に記録する

## ファイル一覧

| ファイル | 目的 |
|---|---|
| `01_system_overview.md` | システム全体の構成と主要コンポーネント |
| `02_data_design.md` | データストア設計（セッションregistry・transcript・外部正本） |
| `03_api_design.md` | gateway API・内部フック・外部API契約 |
| `04_auth_permission.md` | 認証・権限設計（placement境界・ソフト/ハード境界の原則） |
| `05_error_design.md` | fail-closed方針・エンジン障害の自動回復設計 |
| `06_logging_monitoring.md` | ログ・security_event・監視・調査レシピ |
| `07_non_functional_requirements.md` | 性能・可用性・同時実行・コスト管理 |
| `08_security_design.md` | 守るべき情報・脅威モデル・実装時の注意点 |
| `09_directory_structure.md` | リポジトリ構成と責務分離 |
