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

- S-001: 無効時または非Slack connectorからの`/develop`はプロセスを開始しない。
- S-002: 空または8000文字超の要求はプロセス生成前に拒否する。
- S-003: 実行中およびgateway再起動後のロック保持中は、2件目を開始しない。
- S-004: 受理した要求は固定argvの絶対パス実行ファイルへstdin JSONで渡し、gateway secretを継承しない。
- S-005: 余分なfield、不正status、Story ID欠落、対象外PR URLを含む結果は拒否する。
- S-006: timeoutまたは出力上限超過時はプロセス群をTERM後にKILLし、closeまでロックを解放しない。
- S-007: root所有設定の`runnerVersion`と実行スクリプトのversionが一致しない場合はfail closedする。
- S-008: guarded runは`pr_ready`で停止し、PR作成・merge・deployを実行しない。

## Pilot metric

- 梅田がSlackから開始した最初の3件について、要求からDraft PR候補までの工程と停止理由をSlackで追跡できること。
- 本番checkoutへの直接変更件数が0件であること。

## Explicitly out of scope

- 自動merge、自動deploy、Graph SSOT書込み、任意リポジトリへのアクセス。
- OpenRyokoプロセスと同じUnixユーザーでの書込み実行。
