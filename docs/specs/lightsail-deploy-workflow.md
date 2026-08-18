# Lightsail deploy workflow specification

> 状態: 2026-08-18に廃止。本文は過去の仕様記録であり、実装対象ではない。

Story: `story-lightsail-deploy-workflow`

## Authority boundary

| Actor | May | Must not |
| --- | --- | --- |
| GitHub collaborator | `workflow_dispatch`でmain上のSHAを指定する | SSH鍵やruntime secretを見る、任意commandを送る |
| Production reviewer | GitHub Environmentで実行を承認・拒否する | 未reviewのcommitをmain外から許可する |
| GitHub Actions | pinned host keyでforced-command SSHを呼ぶ | root shell、interactive shell、secret更新を行う |
| Deploy principal | `deploy <40-hex-sha> <control-plane-sha256>`を受ける | その他のSSH command、port forwarding、PTYを使う、installed deployerの版ずれを許す |
| Root deploy script | fetch、検証、build、atomic activate、restart、rollbackを行う | main外commit、同時deploy、開発runner中のrestartを許す |

## Input contract

- `commit_sha`は省略可能。省略時はworkflow開始時にfetchした`origin/main`のHEADを使う。
- 指定時は40文字の16進SHAで、workflowとserverの双方が`origin/main`のancestorであることを確認する。
- branch名、tag、short SHA、shell fragmentは受け付けない。
- `LIGHTSAIL_DEPLOY_HOST`と`LIGHTSAIL_DEPLOY_KNOWN_HOSTS`はGitHub Environment variables、秘密鍵はEnvironment secretに置く。

## Deployment sequence

```mermaid
sequenceDiagram
  participant U as Collaborator
  participant E as production Environment
  participant A as GitHub Actions
  participant S as Restricted SSH
  participant H as Lightsail deploy script
  U->>A: Resolve main commit and control-plane digest
  A->>E: Exact immutable outputs awaiting review
  E->>A: Reviewer approval for displayed outputs
  A->>S: deploy FULL_SHA CONTROL_PLANE_SHA256
  S->>H: Validated SHA and digest arguments
  H->>H: Fetch, verify, build, guard
  H->>H: Atomic activation and health checks
  alt activation check fails
    H->>H: Restore previous pointer and restart
  end
```

1. secretを持たないprepare jobが対象SHAを確定し、workflow commit上のdeploy script 2本からcontrol-plane digestを計算して、対象SHA・control-plane SHA/digestをjob outputとsummaryへ固定する。
2. production reviewerがprepare summaryの固定値とPR/CIを確認して承認する。承認後のdeploy jobはmainをcheckout・再解決せず、prepare job outputとpinned known_hosts、専用秘密鍵だけを使って`openryoko-deploy`へ`deploy <target-sha> <digest>`を送る。target SHAとcontrol-plane SHAは独立させる。
3. forced-command wrapperが入力を完全一致で検証し、installed script 2本のdigestが一致した場合だけroot deploy scriptへSHAとdigestを別々のargvとして渡す。root deploy scriptもbuild前にdigestを再検証する。
4. root deploy scriptがlockを取得し、pilot上のcanonical cloneで`origin/main`をfetchする。
5. `$HOME/releases/openryoko/<sha>-<run-id>`へsingle-use detached worktreeを作り、frozen installとbuildを実行する。Lightsail runtimeが参照するworkspace依存を先にbuildし、既存成果物は再利用しない。
6. development runner guardがidle/staleになるまで待つ。
7. `/home/ryoko/current`を新releaseへatomicに切り替え、`openryoko.service`をrestartする。
8. systemd active、active entrypoint、MainPIDのcommand lineがrelease pointerを使うことを確認する。失敗時は直前symlinkへ戻してrestartする。成功時は対象SHA、control-plane digest、MainPID、resolved entrypointをworkflow summaryへ伝播する。

## Failure contract

- invalid/main外SHA、build失敗、lock競合、guard timeout、restart失敗はworkflow失敗として返す。
- build失敗時は未完成worktreeを削除し、active symlinkとserviceを変更しない。
- activation後の失敗は直前releaseが存在する場合に自動rollbackする。
- activation成功後の古いworktree整理失敗はwarningとして記録し、成功したdeployをfailureへ反転しない。
- rollback自体の機能結果は別途確認する。service activeだけでSlack/Web outcomeを保証しない。

## Security contract

- `authorized_keys`は`restrict`とroot-owned forced commandを使う。
- sshdがforced commandを`-c`で起動できるようdeploy userのshellは`/bin/bash`とする。新規・既存accountのpasswordをinstallerが明示的にlockしてshadow上のlock状態も検証し、Actions鍵は`restrict,command="..."`へ固定してinteractive commandを許可しない。
- workflowは`permissions: contents: read`のみを要求する。
- prepare jobはEnvironmentやsecretへアクセスせず、deploy jobは承認前に固定されたjob outputだけを消費する。承認待ちの間にmainが進んでも対象SHAを変更しない。
- Actions dependencyはfull commit SHAでpinする。
- host key checkingを無効化しない。
- workflow log、GitHub summary、server outputへ鍵、token、environment file内容を出さない。
- deploy scriptを変更したworkflow commitは、setup administratorがそのcontrol-plane SHAからinstallerを再実行するまでfail closedとする。旧installed control planeで新しいrepository testだけが通る状態を成功扱いしない。
- アプリのrollback対象SHAから古いinstallerを実行しない。workflow commitの現行control planeでmain上のknown-good SHAをbuild/activateし、control-plane digest不一致時だけsetup administratorがworkflow commitから再installする。

## Diagrams

### threat_model

```mermaid
flowchart LR
  C[GitHub collaborator] -->|workflow dispatch| E[production Environment]
  E -->|required reviewer approval| A[GitHub Actions]
  A -->|full SHA and pinned host key| F[restricted SSH forced command]
  F -->|validated SHA and digest argv| D[root deploy script]
  D -->|main ancestry verified| R[single-use release]
  X[Arbitrary command or malformed SHA] -->|reject| F
  Y[Main-external commit] -->|reject| D
  Z[Activation failure] -->|restore previous pointer| P[known-good release]
  A -. no access .-> S[runtime secrets]
  C -. no shell .-> D
```

Trust boundaryはGitHub `production` Environment、restricted SSH principal、root deploy scriptの3段階である。各段階は前段の判断を信頼せず、SHA形式・main包含・実行commandを再検証する。

## Verification

- `pnpm test:e2e:deploy`はGitHub UIやLightsail実機のE2Eではなく、Playwrightをrunnerとして使うheadless contract replayである。production journeyの証跡はStoryのR-01〜R-03へ分離する。
- `bash -n`で3本のserver-side scriptを検証する。
- forced commandがarbitrary commandとshort SHAを拒否する。
- valid-form SHAとcontrol-plane digestが別々のargvとしてdeploy scriptへ渡り、digest欠落・不一致をbuild前に拒否することを確認する。
- GitHub workflow YAMLをparseし、`workflow_dispatch`、prepare jobのEnvironment非使用、固定job output、deploy jobの`environment: production`とprepare依存、承認後checkout禁止、read-only permissions、non-cancelling concurrency、strict host key checkingを確認する。
- activation失敗fixtureで直前release pointerへのrollbackと元のfailure status保持を確認する。
- main外commit、lock競合、build失敗、guard timeout、systemd active-check失敗、entrypoint不一致、MainPID command不一致をcaller経路へ注入し、active pointerがknown-good releaseから変わらないことを確認する。
- build失敗時に未完成releaseが削除され、service restartが呼ばれないことを確認する。
- Lightsail用buildがWeb、Jimmy、およびJimmyが実行時に参照する共有Slack文脈packageを含むことを確認する。
- activation成功後のworktree prune失敗がwarningに留まり、deploy成功を反転しないことを確認する。
- control-plane再installが既存の`/home/ryoko/current`を保持し、初回install時だけsource cloneへのpointerをseedすることを確認する。
- 本番導入時はcurrent SHA、installed control-plane digest、deploy account password lock、restricted `authorized_keys`、限定sudoers、arbitrary/short command拒否、systemd MainPID/entrypoint、workflow run URLを記録する。
