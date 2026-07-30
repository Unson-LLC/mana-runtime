# 非機能要件

**最終更新**: 2026-07-30

現状の実力値と設計上の制約を「事実」として書く。目標値が未設定の項目はTODOに落とす。

## 1. 可用性・構成

- **単一ホスト・単一プロセス**（pilot Lightsail、systemd `openryoko.service`）。HAなし
- 再起動耐性: セッション状態はSQLiteに永続化され、再起動後も会話・同時実行ロック（development runner）が維持される
- config hot-reload により設定変更は原則無停止
- 依存先障害時はfail-closed（Canonical Task書込不可なら登録失敗を明示。黙って別ストアに書かない）

## 2. 同時実行の制約（設計値）

| 対象 | 制約 |
|---|---|
| 1セッション（=Slackスレッド） | 同時1ターン。実行中の追加メッセージは拒否応答 |
| development runner | ゲートウェイ全体で同時1件（再起動をまたぐロック）。2件目は明示拒否 |
| セッション間 | 並列可（PTYはセッションごと） |

## 3. タイムアウト・上限（設計値）

| 項目 | 値 |
|---|---|
| インタラクティブターン期限 | 90分（エンジン活動中はスキップ、wedged検知用） |
| development runner | 90分（timeoutMs: 5400000）、プロセスグループへTERM→猶予→KILL |
| 自己開発リクエスト長 | 8000字 |
| hook body | サイズ上限あり（Content-Length + mid-stream両方で強制） |
| transient retryバックオフ | 30s / 2m / 5m |

## 4. 性能

- 応答レイテンシの支配項はLLM実行時間（実測: 軽い応答で7〜30秒/ターン、コスト$0.003〜$0.03程度）
- 議事録パイプライン実測: transcript→議事録→展開→タスク登録まで約50秒・人手ゼロ（2026-07-30）
- 性能改善の主張はVibePro performance evidence（server_side / user_perceived の分離）で行う

## 5. 運用

- デプロイ: main追従（pilot上で `git pull` → `pnpm --filter openryoko build` → `systemctl restart openryoko`）。ロールバックはgit revert + 再ビルド
- 設定変更: `config.yaml.bak-<date>-<intent>` バックアップ → 編集 → hot-reloadログ確認
- 課金: Claude Max課金経路（interactive PTY, cc_entrypoint=cli）。budget機構で上限管理

## 6. TODO

- 可用性目標（許容ダウンタイム）・復旧手順書（ホスト喪失時のregistry.db/config復元）が未定義
- デプロイの手作業をスクリプト化（現状はSSH手順）
- 負荷上限（同時セッション数の実用限界）が未計測
