# Pilot config.yaml 変更管理

Story: `agent-ledger-gaps`（docs/specs/agent-ledger-gaps.md AC9）

pilot（`ubuntu@18.178.86.244`、操作は `sudo -u ryoko`）の `~/.ryoko/config.yaml` は、2026-07-30からローカルgitリポジトリ（`~/.ryoko/.git`、branch `main`）で変更管理する。従来の `config.yaml.bak-*` コピー慣行は廃止する。

## 設計判断（secret境界）

- `config.yaml` にはsecret実値を置かない。Slack token等は **env注入（Infisical方針）** とし、configには `appTokenEnv` / `botTokenEnv` のようなenv変数**名**だけを書く（`docs/architecture/channel-placement-profiles.md` §4の既存方針どおり）。
- 2026-07-30時点のconfig.yamlをtoken実値パターン（xox*/sk-*/Bearer/JWT等）で検査し、0件であることを確認済み。
- 防御は2層:
  - `.gitignore` は **deny-all**（`*`）+ allowlist（`config.yaml` と `.gitignore` のみ追跡）。runtime state・backup・memoryファイルの誤commitを構造的に防ぐ。
  - `pre-commit` hookがstaged差分内のsecret様パターンを検出してcommitを拒否する。

## コード支援（ランタイム経由の変更）

ランタイム自身が `config.yaml` / `cron/jobs.json` を書き換える全経路
（`PUT /api/config`、`POST /api/onboarding`、STT設定、`PUT /api/budgets`、`/api/cron` CRUD、cron scheduler）には自動スナップショットが入っている（`packages/jimmy/src/shared/config-history.ts`）:

- **書込み前スナップショット**: 上書き直前の内容を `~/.ryoko/config-history/<ISO時刻>-<経路>.yaml|.json` へ保存。ディレクトリは `0700`、ファイルは `0600`（config.yamlのコピーであるため、手動編集分と同じsecret境界を適用）。
- **変更記録**: `config-history/index.jsonl` と構造化ログ `config_change`（gateway.log）に、いつ（`ts`）・どの経路（`source`）・operator認証の有無（`operatorAuthenticated`）を記録。placement無効時はoperator認証が強制されないため `operatorAuthenticated: false` として正直に記録される。
- **ローテーション**: 直近100件（`CONFIG_HISTORY_LIMIT`）を保持し、超過分はindexエントリとスナップショットファイルの両方を削除。
- **一覧API**: `GET /api/config-history`（`?n=<件数>`）。placement有効時は他の `GET /api/*` と同じくoperator token（`x-openryoko-operator-token`）必須。返すのは**メタデータのみ**でスナップショット内容は返さない — configコピーの閲覧経路をAPIに増やさないため、内容の確認・復元はSSH経由で行う。

```bash
# 変更履歴の確認（operator tokenはInfisical管理の実値を使用）
curl -s -H "x-openryoko-operator-token: $OPERATOR_TOKEN" \
  "http://localhost:7777/api/config-history?n=20" | jq

# スナップショットからの復元（pilot上で）
sudo -u ryoko -i
ls -t ~/.ryoko/config-history/ | head
diff ~/.ryoko/config-history/<snapshot> ~/.ryoko/config.yaml
cp ~/.ryoko/config-history/<snapshot> ~/.ryoko/config.yaml   # 復元後、下記git手順でcommit
```

## 変更手順（手動編集）

```bash
ssh -i ~/.ssh/openryoko-pilot-20260724.pem ubuntu@18.178.86.244
sudo -u ryoko -i
cd ~/.ryoko
$EDITOR config.yaml          # 変更（.bakコピーは作らない）
git diff                     # 差分確認（secretが入っていないこと）
git add config.yaml
git commit -m "<何を・なぜ変えたか（placement id・依頼者を含める）>"
# ランタイム反映（必要時）
```

ロールバックは `git revert` / `git checkout <commit> -- config.yaml`、またはconfig-historyスナップショットからの復元（上記）を使う。API経由の変更もgit履歴に取り込みたい場合は、変更後に同じ `git add config.yaml && git commit` を実行する（config-historyはgitの代替ではなく、ランタイム書込みの直前状態を機械的に確保する安全網）。

## 追跡対象の拡張

新しいファイルを追跡したい場合は `.gitignore` に `!<file>` を追記し、secretが含まれないことを確認してからcommitする。allowlist方式を崩さない。`config-history/` はruntime stateなのでdeny-all `.gitignore` の対象のまま（追跡しない）。

## 残課題（follow-up）

- リモート（private GitHub repo）への同期はまだ無い。ローカルgit履歴のみのため、ホスト喪失時は履歴も失われる。private repo化する場合はdeploy key + 定期pushを追加する。
- 既存の `config.yaml.bak-*` / `backups/` は参考として残置。次回の大掃除で削除してよい（履歴はgitが持つ）。
- CLI経路（`ryoko migrate` 等の `cli/migrate.ts` / `cli/interactive-config.ts`）はconfig-history対象外。operatorが対話的に実行するため手動編集と同じgit手順でカバーする。
