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

- S-001: Given the development runner is disabled, when Slack sends `/develop`, then no process starts and a disabled response is returned.
- S-002: Given a non-Slack connector, when it sends `/develop`, then the command is not exposed and no process starts.
- S-003: Given an empty or over-8000-character request, when `/develop` validates it, then the request is rejected before process creation.
- S-004: Given one development request is active or its restart-safe lock remains, when a second request arrives, then the second request is rejected without spawning another runner.
- S-005: Given an accepted Slack request, when the gateway starts the runner, then the request is encoded on stdin for an absolute executable with fixed arguments and Slack secrets are absent from the child environment.
- S-006: Given a malformed or foreign runner result, when the gateway parses it, then unsupported fields, invalid statuses, missing Story IDs, and foreign pull-request URLs are rejected.
- S-007: Given the gateway runner times out or exceeds its output limit, when termination starts, then TERM is followed by KILL when required and the lock remains held until the child closes.
- S-008: Given the root-owned configuration and running script expose different runner versions, when validation starts, then execution fails closed before Git, worktree, or VibePro mutation.
- S-009: Given a valid guarded run, when it completes, then it returns a Story ID and `pr_ready` without creating, merging, or deploying a PR.

## Pilot metric

- 梅田がSlackから開始した最初の3件について、要求からDraft PR候補までの工程と停止理由をSlackで追跡できること。
- 本番checkoutへの直接変更件数が0件であること。

## Explicitly out of scope

- 自動merge、自動deploy、Graph SSOT書込み、任意リポジトリへのアクセス。
- OpenRyokoプロセスと同じUnixユーザーでの書込み実行。
