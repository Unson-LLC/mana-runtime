# SlackからOpenRyoko自身を安全に開発する分離ランナー

## Story

OpenRyokoの開発手法を佐藤だけの暗黙知にせず、梅田を含むallowlist済みの担当者がSlack上で要求、進捗、検証、PRを観察できるようにする。

稼働中gatewayは受付と結果通知だけを担当し、実装は別Unixユーザーの隔離worktreeでVibeProが行う。PR作成、merge、deployは人間の明示操作として残す。

## Acceptance criteria

- `/develop <request>`はSlack connectorかつ明示的に有効化された場合だけ受理される。
- gatewayから開発ランナーへ渡す入力はstdinのJSONだけで、SlackやClaudeのsecret環境変数を継承しない。
- 開発ランナーの出力は固定JSON schemaと対象forkのPR URLだけを受理する。
- 同時実行はgateway再起動をまたいでも1件で、2件目は実行せず利用者へ通知する。
- timeout時は子プロセス群の終了を確認してから実行中状態を解除する。
- 通常のClaude PTYは`plan`のままで、稼働中checkoutを変更しない。
- VibeProはStory、Spec、検証、レビューを記録し、PR作成またはmergeの直前で停止する。

## Explicit scenarios

- S-001: Given the feature is absent or disabled, when Slack sends `/develop`, then it returns disabled and starts no process.
- S-002: Given a non-Slack connector, when it receives `/develop`, then it does not expose the command and starts no process.
- S-003: Given an empty request, when Slack sends `/develop`, then it returns usage guidance and starts no process.
- S-004: Given a request longer than 8000 characters, when `/develop` validates it, then it is rejected before process creation.
- S-005: Given one request is active or its restart-safe lock remains, when a second request arrives, then it is rejected rather than silently queued.
- S-006: Given a valid request, when the gateway starts the runner, then it sends one JSON line on stdin to an absolute executable with fixed arguments.
- S-007: Given the gateway starts the development child, when it constructs the child environment, then only runtime essentials are present and Slack credentials are not inherited.
- S-008: Given an oversized, malformed, foreign-URL, extra-field, timed-out, non-zero, invalid-status, or missing-Story result, when the gateway parses it, then it returns a generic safe failure.
- S-009: Given the child times out or ignores termination, when shutdown begins, then the process group receives termination, closure is awaited, and `SIGKILL` is used after the grace period when required.
- S-010: Given a valid guarded run, when it completes, then it returns a Story ID and `pr_ready` without creating, merging, or deploying a PR.

The root-owned `runnerVersion` must also match the running wrapper before Git,
worktree, or VibePro mutation; a mismatch fails closed.

## Pilot metric

- 梅田がSlackから開始した最初の3件について、要求からDraft PR候補までの工程と停止理由をSlackで追跡できること。
- 本番checkoutへの直接変更件数が0件であること。

## Explicitly out of scope

- 自動merge、自動deploy、Graph SSOT書込み、任意リポジトリへのアクセス。
- OpenRyokoプロセスと同じUnixユーザーでの書込み実行。
