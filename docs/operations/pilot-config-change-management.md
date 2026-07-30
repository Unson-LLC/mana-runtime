# Pilot config.yaml 変更管理

Story: `agent-ledger-gaps`（docs/specs/agent-ledger-gaps.md AC9）

pilot（`ubuntu@18.178.86.244`、操作は `sudo -u ryoko`）の `~/.ryoko/config.yaml` は、2026-07-30からローカルgitリポジトリ（`~/.ryoko/.git`、branch `main`）で変更管理する。従来の `config.yaml.bak-*` コピー慣行は廃止する。

## 設計判断（secret境界）

- `config.yaml` にはsecret実値を置かない。Slack token等は **env注入（Infisical方針）** とし、configには `appTokenEnv` / `botTokenEnv` のようなenv変数**名**だけを書く（`docs/architecture/channel-placement-profiles.md` §4の既存方針どおり）。
- 2026-07-30時点のconfig.yamlをtoken実値パターン（xox*/sk-*/Bearer/JWT等）で検査し、0件であることを確認済み。
- 防御は2層:
  - `.gitignore` は **deny-all**（`*`）+ allowlist（`config.yaml` と `.gitignore` のみ追跡）。runtime state・backup・memoryファイルの誤commitを構造的に防ぐ。
  - `pre-commit` hookがstaged差分内のsecret様パターンを検出してcommitを拒否する。

## 変更手順

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

ロールバックは `git revert` / `git checkout <commit> -- config.yaml` を使う。

## 追跡対象の拡張

新しいファイルを追跡したい場合は `.gitignore` に `!<file>` を追記し、secretが含まれないことを確認してからcommitする。allowlist方式を崩さない。

## 残課題（follow-up）

- リモート（private GitHub repo）への同期はまだ無い。ローカルgit履歴のみのため、ホスト喪失時は履歴も失われる。private repo化する場合はdeploy key + 定期pushを追加する。
- 既存の `config.yaml.bak-*` / `backups/` は参考として残置。次回の大掃除で削除してよい（履歴はgitが持つ）。
