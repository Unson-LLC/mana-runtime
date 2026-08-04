# Mana Runtime Lightsail deploy runbook

## One-time setup

### 1. Create the deploy key locally

専用鍵を作成し、private keyをGitHub以外へ共有しない。

```bash
ssh-keygen -t ed25519 -C openryoko-github-actions -f ./openryoko-github-actions
```

### 2. Install the restricted principal on Lightsail

現在のreview済みrepositoryをpilotへ反映した後、public keyだけをpilotへ置き、rootでinstallerを実行する。

```bash
sudo /home/ryoko/src/OpenRyoko/scripts/deploy/install-pilot-deployer.sh \
  --authorized-key-file /path/to/openryoko-github-actions.pub
sudo -u ryoko /home/ryoko/bin/ryoko status
sudo systemctl is-active openryoko.service
sudo systemctl show --property ExecStart --value openryoko.service
```

installerは現行checkoutを`/home/ryoko/current`へpointするため、この時点ではコードreleaseを変更しない。statusまたはservice確認が失敗した場合は、`/home/ryoko/bin/ryoko.pre-release-pointer`を戻してから原因を調査する。

### 3. Configure GitHub Environment

Repository Settings → Environments → `production`で次を設定する。

- Required reviewers: 佐藤さんを最低1名の承認者として登録
- Deployment branches and tags: `Selected branches and tags`で`main`だけを許可
- Environment secret `LIGHTSAIL_DEPLOY_SSH_KEY`: 手順1のprivate key全文
- Environment variable `LIGHTSAIL_DEPLOY_HOST`: pilotの固定hostnameまたはIP
- Environment variable `LIGHTSAIL_DEPLOY_KNOWN_HOSTS`: `ssh-keyscan`結果を別経路でfingerprint照合したknown_hosts行

host keyはpilot上の`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`と、管理者が取得した公開鍵fingerprintを照合してから登録する。未照合の`ssh-keyscan`出力だけを信頼しない。

private keyはGitHub Environment secretへ保存後、作業端末から安全に削除する。削除前にGitHub登録とserver側public keyの一致を確認する。

## Deploy

1. GitHubのActions → `Deploy Mana Runtime to Lightsail` → `Run workflow`を開く。
2. 通常は`commit_sha`を空欄にして現在のmainを選ぶ。rollbackや再deploy時だけfull SHAを指定する。
3. production reviewerが対象SHAとPR/CIを確認して承認する。
4. workflow summaryのSHAとsuccessを確認する。

## Server-side verification

```bash
readlink -f /home/ryoko/current
sudo systemctl is-active openryoko.service
main_pid="$(sudo systemctl show --property MainPID --value openryoko.service)"
sudo tr '\0' ' ' < "/proc/$main_pid/cmdline"
sudo journalctl -u openryoko.service --since '10 minutes ago' --no-pager
```

ログを共有するときはtoken、message本文、環境変数値、raw errorを含めない。各Storyのrelease gateに従いSlack/Webの利用結果を別途確認する。

## Rollback

直前のknown-good SHAを同じworkflowへ指定する。通常のrollbackでも、そのSHAから新しいsingle-use releaseをbuildし、検証後にcurrent symlinkを切り替えてrestartする。既存releaseは再利用しない。

workflowが利用不能でserviceも停止している緊急時だけ、管理者がpilot上で対象SHAに一致する既存release directoryを特定し、その実体とentrypointを確認してから切り替える。release名は`<full-sha>-<UTC timestamp>-<pid>`であり、SHAだけのdirectoryは存在しない。

```bash
release_dir="$(sudo find /home/ryoko/releases/openryoko \
  -mindepth 1 -maxdepth 1 -type d \
  -name 'FULL_KNOWN_GOOD_SHA-*' -print | sort | tail -1)"
test -n "$release_dir"
sudo test -f "$release_dir/packages/jimmy/dist/bin/jimmy.js"
sudo ln -s "$release_dir" /home/ryoko/current.next
sudo mv -Tf /home/ryoko/current.next /home/ryoko/current
sudo /usr/local/libexec/openryoko-guard-restart --wait 5400
sudo systemctl restart openryoko.service
sudo systemctl is-active openryoko.service
```

`FULL_KNOWN_GOOD_SHA`は40文字の確認済みcommit SHAへ置き換える。候補が複数ある場合は、時刻だけで決めず、対象directory内のGit metadataまたはdeploy記録でcommitを照合する。緊急rollback後は、実行者、時刻、from/to SHA、選択したrelease directory、理由、systemd結果、機能別確認結果をincident recordへ残す。
