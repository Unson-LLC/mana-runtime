# Mana Runtime Lightsail deploy runbook

## One-time setup

### 1. Create the deploy key locally

専用鍵を作成し、private keyをGitHub以外へ共有しない。

```bash
ssh-keygen -t ed25519 -C openryoko-github-actions -f ./openryoko-github-actions
```

### 2. Install the restricted principal on Lightsail

merge済みの対象SHAをpilotのisolated worktreeへ取得した後、public keyだけをpilotへ置き、そのworktreeのinstallerをrootで実行する。`TARGET_SHA`はGitHubのmerge commit full SHAへ置き換える。

```bash
TARGET_SHA=FULL_MERGED_COMMIT_SHA
sudo -u ryoko git -C /home/ryoko/src/OpenRyoko fetch --no-tags origin main
sudo -u ryoko git -C /home/ryoko/src/OpenRyoko merge-base --is-ancestor "$TARGET_SHA" origin/main
setup_dir="/home/ryoko/deploy-setup-$TARGET_SHA"
sudo -u ryoko git -C /home/ryoko/src/OpenRyoko worktree add --detach "$setup_dir" "$TARGET_SHA"
sudo "$setup_dir/scripts/deploy/install-pilot-deployer.sh" \
  --authorized-key-file /path/to/openryoko-github-actions.pub
sudo -u ryoko /home/ryoko/bin/ryoko status
sudo systemctl is-active openryoko.service
sudo systemctl show --property ExecStart --value openryoko.service
```

初回installerは`/home/ryoko/current`が存在しない場合だけ現行source cloneへpointする。再installでは既存のrelease pointerを変更しないため、control plane更新だけで稼働commitは変わらない。statusまたはservice確認が失敗した場合は、`/home/ryoko/bin/ryoko.pre-release-pointer`を戻してから原因を調査する。

installerが表示した`Control-plane digest`をsetup記録へ残す。deploy script 2本を変更したcommitを出す場合は、同じ対象SHAのisolated worktreeからinstallerを再実行してからworkflowを起動する。workflowは対象SHAのdigestとinstalled digestが違えばbuild前に停止する。

### 3. Configure GitHub Environment

Repository Settings → Environments → `production`で次を設定する。

- Required reviewers: 佐藤さんを最低1名の承認者として登録
- Deployment branches and tags: `Selected branches and tags`で`main`だけを許可
- Environment secret `LIGHTSAIL_DEPLOY_SSH_KEY`: 手順1のprivate key全文
- Environment variable `LIGHTSAIL_DEPLOY_HOST`: pilotの固定hostnameまたはIP
- Environment variable `LIGHTSAIL_DEPLOY_KNOWN_HOSTS`: `ssh-keyscan`結果を別経路でfingerprint照合したknown_hosts行

host keyはpilot上の`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`と、管理者が取得した公開鍵fingerprintを照合してから登録する。未照合の`ssh-keyscan`出力だけを信頼しない。

private keyはGitHub Environment secretへ保存後、作業端末から安全に削除する。削除前にGitHub登録とserver側public keyの一致を確認する。

## Access prerequisites

役割ごとの権限を分離する。

- Deploy operator（梅田さんを含む）: repositoryの`Write`権限が必要。Actionsからmanual workflowを起動できるが、Environment secretの値を閲覧する権限やLightsail shell accessは不要
- Production reviewer: `production` Environmentの承認者。対象SHA、PR、CIを確認し、deployの実行可否を決める
- Setup administrator: repository Environment、secret/variables、restricted deploy key、Lightsail側deploy principalを初期設定する。通常deployのたびに関与しない

Actionsに`Deploy Mana Runtime to Lightsail`または`Run workflow`が表示されない場合は、default branchが`main`であることと自分のrepository roleを確認し、mana-runtime repository administratorへ`Write`権限を依頼する。secret値やLightsail loginをdeploy operatorへ共有して解決しない。

## Deploy

1. GitHubのActions → `Deploy Mana Runtime to Lightsail` → `Run workflow`を開く。
2. 通常は`commit_sha`を空欄にして現在のmainを選ぶ。rollbackや再deploy時だけfull SHAを指定する。
3. production reviewerが対象SHAとPR/CIを確認して承認する。
4. workflow summaryのSHAとsuccessを確認する。
5. workflow summaryのcontrol-plane digest、MainPID、Entrypointが空でなく、対象SHAのreleaseを指すことを確認する。

## Release note and operator ownership

- Release owner: `production` Environmentで実行を承認したreviewer
- Deploy operator: workflowを起動したGitHub user
- Support owner: mana-runtime maintainers。失敗時はworkflow run URL、対象SHA、systemd状態を添えて連絡する
- Release note: 対象PR、from/to SHA、workflow run URL、承認者、実行者、systemd確認結果をdeployment recordへ残す
- Observability evidence: workflow summary、`readlink -f /home/ryoko/current`、`systemctl is-active`、MainPIDのcommand line、機能別runbookの結果を分けて記録する

このPRのmergeはreleaseではない。GitHub EnvironmentとLightsailのone-time setupが完了し、R-01〜R-03の本番証拠が揃うまで運用移行は未完了とする。

## Server-side verification

```bash
readlink -f /home/ryoko/current
sudo systemctl is-active openryoko.service
main_pid="$(sudo systemctl show --property MainPID --value openryoko.service)"
sudo tr '\0' ' ' < "/proc/$main_pid/cmdline"
sudo journalctl -u openryoko.service --since '10 minutes ago' --no-pager
sudo getent shadow openryoko-deploy | cut -d: -f2
sudo grep -F 'restrict,command="/usr/local/sbin/openryoko-deploy-command"' /home/openryoko-deploy/.ssh/authorized_keys
sudo visudo -cf /etc/sudoers.d/openryoko-pilot-deploy
sudo -u openryoko-deploy env SSH_ORIGINAL_COMMAND='uname -a' /usr/local/sbin/openryoko-deploy-command
sudo -u openryoko-deploy env SSH_ORIGINAL_COMMAND='deploy deadbeef' /usr/local/sbin/openryoko-deploy-command
```

shadowのpassword fieldは`!`または`*`で始まるlock状態であること、最後の2 commandはどちらもexit 64で拒否されることを確認する。実機のcontrol-plane digestはinstaller出力とworkflow summaryで照合し、値が違う場合は対象SHAのinstallerを再実行する。これらが揃わない限りR-02は未確認とする。

ログを共有するときはtoken、message本文、環境変数値、raw errorを含めない。各Storyのrelease gateに従いSlack/Webの利用結果を別途確認する。

## Rollback

直前のknown-good SHAを同じworkflowへ指定する。対象SHAのdeploy script digestがworkflow summaryに記録された現在のinstalled control-plane digestと同じなら、そのまま実行できる。異なる場合は、setup administratorが上記one-time setupと同じisolated worktree手順で対象known-good SHAからinstallerを再実行し、release pointerが変わっていないことと新しいdigestを確認してからworkflowを実行する。digest不一致を無視または回避してはならない。

通常のrollbackでも、対象SHAから新しいsingle-use releaseをbuildし、検証後にcurrent symlinkを切り替えてrestartする。既存releaseは再利用しない。rollback後に新しい版へ戻す場合は、その版のmerged SHAからcontrol planeを再installしてからdeployする。

Rollback ownerはrelease ownerとする。ただしversion-skew時のcontrol-plane再installはsetup administratorが担当する。release ownerが対応できない場合はmana-runtime maintainerが引き継ぎ、開始前に対象known-good SHA、deploy script digest、installed digest、直前の成功runを照合する。

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
