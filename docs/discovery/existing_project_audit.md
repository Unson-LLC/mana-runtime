# 既存プロダクト棚卸し（2026-07-30）

## 1. 対象

| 項目 | 内容 |
|---|---|
| プロダクト名 | mana-runtime（パッケージ名 openryoko） |
| リポジトリ | Unson-LLC/mana-runtime（旧名 brainbase-mana からリダイレクト） |
| 対象branch / commit | main @ cac48b9（PR #25/#26 merge後） |
| 調査日 | 2026-07-30 |
| 調査者 | 佐藤 + Claude（事業運営チャンネル障害調査を起点とした実地棚卸し） |

## 2. 調査の経緯

事業運営チャンネル（unson-accounting C0BMNSP6C80）でmanaが文脈のない回答を繰り返す障害を調査し、その過程でシステム全体を実地に棚卸しした。設計文書はこの棚卸しを一次入力として起こした（architecture 01〜09・ADR 0001〜0003）。

## 3. 参照したもの

| 種別 | 参照先 | 分かったこと |
|---|---|---|
| コード | packages/jimmy/src（gateway/sessions/engines/mcp/shared/connectors） | コンポーネント責務・placement choke point・回復機構 |
| 稼働ログ | pilot `journalctl -u openryoko.service` | `resume: none`退行・`mcp_denied`・config hot-reload・コスト/所要時間 |
| 本番設定 | pilot `/home/ryoko/.ryoko/config.yaml` | placements 3枠・developmentRunner有効・バックアップ命名慣行 |
| 本番配置 | pilot ファイルシステム・systemd unit | checkout位置・runtime home・ryoko-devユーザー・root所有ラッパー |
| データ | `~/.ryoko/sessions/registry.db`・`~/.claude/projects/*.jsonl` | セッション永続化とtranscriptの二層構造 |
| git履歴 | `git log -L` ほか | 退行コミット000b1a3の特定・repo改名の経緯 |
| 既存docs | roadmap.md・specs/・architecture/story-*・plans/jimmy-design.md | 戦略層は鮮度高、全体設計は4ヶ月前で失効 |

## 4. アーキテクチャ理解

### Fact

- gateway単一プロセス（pilot Lightsail・systemd）。Slackはsocket modeのnamed instanceが2つ（雲孫WS・unson-accounting WS）
- placementはdeny-by-default。capabilities未設定の`mana-dev-biz`で全MCP拒否を`security_event`で確認
- 000b1a3以降、placement経由の全メッセージがengineSessionIdをクリアし毎ターン`resume: none`（transcriptファイルがターンごとに新規作成されるのを確認）→ PR #26で「権限バインド変更時のみクリア」に修正
- engineSessionIdはhook（SessionStart/Stop）到着時に`/api/internal/hook`側で即時永続化される
- development runner: `/usr/local/libexec/openryoko-development-runner`（root所有）・`ryoko-dev`ユーザー実在・config有効・許可はC0A2L9FEKEJ×1チャンネル/1ユーザー
- Canonical Taskはbb.unson.jp（Lightsail PG16）へ移設済み。エージェントにdelete権限なし
- 議事録パイプラインは本番切替済み（router=9940-meeting-router、destinations=10）

### Inference

- `operator_auth_missing`が約65秒間隔で常時発生 → 認証なしで管理APIを叩く定期ポーラーがいる（health timer系と推測。**発生源未特定**）
- jimmy-design.md（2026-03-06）はplacement・canonical task・議事録DAGを含まず、現在のアーキテクチャ理解には使えない

### Question

- [ ] `operator_auth_missing`ポーラーの正体（→ 06_logging_monitoring.md TODO）
- [ ] pilot喪失時の復旧手順（registry.db・config.yamlのバックアップ先）は決まっているか（→ 07 TODO）
- [ ] `openryoko`/`ryoko`命名の改名方針（残すのか段階的に消すのか）（→ 09に暫定記載）

### 反映先

- `docs/architecture/01`〜`09`（本棚卸しを元に起草済み）
- `docs/adr/0001`〜`0003`
- 機能単位の設計は既存VibePro系統（`docs/specs/`・`docs/architecture/story-*.md`）を継続

## 5. 運用理解

### Fact

- config変更は`config.yaml.bak-<date>-<intent>`でバックアップ→編集→hot-reloadログ確認、が実運用の型
- デプロイはpilot上で git pull → pnpm build → systemctl restart（手作業）
- 調査の入口はjournalctl（`resume:`と`mcp_denied`のgrepで文脈喪失/能力不足を数分で切り分けられる）

### Question

- [ ] デプロイのスクリプト化・自動化の優先度（→ 07 TODO）
