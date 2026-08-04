# Lightsailデプロイは承認付きGitHub Actionsと制限付きSSH principalに限定する

Story: `story-lightsail-deploy-workflow`

## Context

Mana RuntimeのpilotはLightsail上の単一systemd serviceとして稼働し、従来のデプロイは管理者がSSHしてsource checkoutを更新、build、restartする手作業だった。共同開発者もデプロイできるようにしたいが、個人へ`ubuntu`、`ryoko`、root shellやruntime secretの閲覧権限まで渡す必要はない。また、稼働中gatewayが起動したdevelopment runnerはservice cgroupに含まれるため、無条件restartは実行中の開発をkillする。

## Decision

- 人が開始する正規入口はGitHub Actionsの`workflow_dispatch`とする。
- GitHub `production` Environmentのrequired reviewerを本番承認境界とする。
- Environmentを持たないprepare jobで対象SHAとcontrol-plane SHA/digestを固定・表示し、承認後のdeploy jobはそのjob outputだけを使ってmainを再解決しない。
- 対象は`origin/main`に到達可能な完全40桁SHAだけとし、workflowとLightsailの双方で検証する。
- Actions用SSH keyは専用`openryoko-deploy` userへ割り当て、`restrict`付きforced commandで`deploy <target-sha> <control-plane-digest>`以外を拒否する。workflow commit上のdeploy scriptとinstalled copyのdigestが一致しない場合はbuild前に停止し、アプリのtarget SHAとは独立させる。
- root-owned deploy scriptだけがisolated releaseのbuild、guarded restart、atomic symlink切替、自動rollbackを行う。
- service activeに加えてMainPIDがrelease pointer経由のentrypointを実行していることを確認する。ただしprocess-level evidenceに限定し、各Storyの本番利用結果は別のrelease gateで確認する。

## Why

GitHub collaborator identity、Environment approval、workflow run、target SHAを一つの監査経路へまとめながら、共同開発者へ汎用server authorityを渡さずに済む。承認前にimmutable job outputを固定するため、承認待ち中にmainが進んでもreviewerが確認していないcommitへ対象が移らない。workflowとserverの二重検証は入力またはworkflow変更だけでmain外commitが反映されることを防ぐ。別releaseでのbuildとatomic切替により、build失敗は稼働中releaseへ影響せず、restart失敗時は直前releaseへ戻せる。

## Alternatives

- 共同開発者へ既存`ubuntu` SSH keyを渡す案: rootを含む権限とsecret閲覧範囲がデプロイ用途を超えるため不採用。
- GitHub-hosted runnerへAWS credentialsを渡してSSM/CodeDeployを使う案: pilotの現行構成にSSM agent、IAM role、deployment serviceを追加するscopeが大きいため今回は不採用。
- main pushごとの自動deploy案: 本番承認と実行タイミングの人間境界が失われるため不採用。
- 現行source checkout上で直接buildする案: build失敗や中間生成物が稼働中releaseへ混入するため不採用。

## Consequences

GitHub Environment、専用key、forced command、root-owned scriptsを一度だけ設定する必要がある。deploy keyのrotationとhost key変更時のknown_hosts更新が運用作業になる。GitHubまたはSSH経路が利用不能な緊急rollbackは引き続き管理者のserver accessを必要とし、実行後に監査記録を残す。
