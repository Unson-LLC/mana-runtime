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

## Pilot metric

- 梅田がSlackから開始した最初の3件について、要求からDraft PR候補までの工程と停止理由をSlackで追跡できること。
- 本番checkoutへの直接変更件数が0件であること。

## Explicitly out of scope

- 自動merge、自動deploy、Graph SSOT書込み、任意リポジトリへのアクセス。
- OpenRyokoプロセスと同じUnixユーザーでの書込み実行。
