---
story_id: story-lightsail-deploy-workflow
title: 共同開発者がGitHub ActionsからMana Runtimeを安全にLightsailへデプロイできる
status: active
pr_scope_strategy: atomic_single_pr
pr_scope_reason: "本Storyは、GitHub workflow、restricted SSH principal、server-side main再検証、isolated build、guarded activation、automatic rollback、検証fixture、権限正本、運用runbookを一つのデプロイ契約として出荷する。workflowだけを先行するとサーバー側の制限とrollbackを欠き、runtimeだけを先行すると承認・監査可能な入口を欠くため、同一HEADで初めて安全条件が成立する。"
pr_scope_review_facets:
  - repo-control
  - requirements-ssot
  - runtime-behavior
  - e2e-gate
  - misc-follow-up
pr_scope_dependency_boundaries:
  - "repo-control -> runtime-behavior"
  - "repo-control -> e2e-gate"
  - "requirements-ssot -> runtime-behavior"
  - "runtime-behavior -> e2e-gate"
  - "misc-follow-up -> requirements-ssot"
  - "misc-follow-up -> runtime-behavior"
  - "misc-follow-up -> e2e-gate"
---

# 共同開発者がGitHub ActionsからMana Runtimeを安全にLightsailへデプロイできる

## Story metadata

- Story ID: `story-lightsail-deploy-workflow`
- Status: `active`
- Source: mana-runtimeのデプロイを梅田さんも実施できるようにしたい、という運用要求
- View: `dev`
- Horizon: `month`
- Architecture: [Architecture](../../../architecture/story-lightsail-deploy-workflow.md)
- Spec: [Spec](../../../specs/lightsail-deploy-workflow.md)

## Story

Mana Runtimeの共同開発者として、個人の端末や汎用SSH/root権限を共有せず、GitHub上で対象commit、実行者、承認、結果を確認できる経路からLightsailへデプロイしたい。

これにより、特定の運用者だけが知る手順を減らしつつ、main以外のコード、任意コマンド、secret閲覧をデプロイ権限へ含めずに済む。

## Acceptance Criteria

- AC-01: GitHub Actionsの手動workflowで、空欄なら現在の`main`、指定時は`origin/main`に含まれる完全SHAだけを対象にできる。
- AC-02: workflowはGitHub `production` Environmentを使用し、Environment gateを通過するjob内でのみSSH接続する。required reviewerの実設定と承認停止はマージ後R-01で確認する。
- AC-03: installerとforced-command wrapperは、Lightsailの専用SSH principalに`deploy FULL_COMMIT_SHA`以外を許さない設定を生成する。実機への導入状態はマージ後R-02で確認する。
- AC-04: サーバー側でも対象SHAが`origin/main`に含まれることを再検証し、GitHub側だけの検証を信頼しない。
- AC-05: buildは稼働中releaseと別のworktreeで行い、成功後だけactive symlinkを切り替える。
- AC-06: restart前にdevelopment runner guardを待ち、実行中のVibePro開発runnerをkillしない。
- AC-07: serviceがactiveにならなければ、直前releaseへsymlinkを戻してrestartする。
- AC-08: SSH秘密鍵、host key、runtime secretをrepository、workflow log、引数へ含めない。
- AC-09: workflowの成功はsystemd activeとMainPIDがrelease pointer経由のentrypointを実行する確認までとし、Slack/Webでの利用結果をrelease完了と誤認しない。
- AC-10: shell syntax、forced-commandの拒否条件、workflow security contract、activation失敗時rollbackを自動テストできる。

## Non-goals

- 梅田さんまたは共同開発者への汎用SSH、`ubuntu`、`ryoko`、root shellの付与
- PRの自動merge、mainへの自動deploy
- GitHub Actionsからのruntime secret閲覧・更新
- database migrationの自動実行
- systemd active以外の機能別release verificationの自動完了扱い

## Completion evidence

- workflow、server script、forced-command wrapper、installerが同じPRでreviewされる。
- shell syntax、arbitrary command/short SHA拒否、workflow contract、rollbackのテストが現在HEADでpassする。
- GitHub `production` Environment、required reviewers、Environment secret/variablesの設定手順がある。
- Lightsailへの導入とrollback drillの手順がある。

### Evidence boundary

- PR前の`test:e2e:deploy`は、Playwright runnerからworkflow YAML、入力配線、summary、commit resolver、forced command、installer生成物、rollback fixtureを再生するheadless contract testである。
- このテストはGitHubの`workflow_dispatch`画面、Environment承認待ち、Actions job遷移、SSH接続、Lightsail実機、Slack/Webの利用結果を観測しないため、それらのE2E成功証跡として扱わない。
- GitHub／Lightsailのproduction journeyは、マージ後にR-01〜R-03を実行して初めて完了とする。

## Release completion gate

- R-01: merge後、production Environmentのrequired reviewerが梅田さんの手動workflowを承認できる。
- R-02: workflow logに対象SHAが記録され、Lightsailの`/home/ryoko/current`とsystemd稼働releaseが一致する。
- R-03: 対象変更の機能別runbookで本番利用結果を確認する。
- R-01〜R-03が未確認なら、workflow実装やPR mergeだけでは運用移行完了としない。
