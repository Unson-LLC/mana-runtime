# Architecture: 議事録タスクカードのrevision境界

## 決定

タスクカードのSlack `client_msg_id`は、revision 0では既存の`${runId}-task-card`を維持し、revision 1以降では`${runId}-revision-${revision}-task-card`の決定的UUIDから生成する。

## 理由

`MeetingMinutesRun.revision`はredoごとに外部冪等キーを一意化する契約である。親投稿、詳細投稿、Task APIはrevisionを含む一方、タスクカードだけがrunIdのみを使っていた。そのためredo後の新しいスレッドでも旧タスクカードと同じSlack重複排除キーとなる。

## 不変条件

- 同じrunId・revisionの再試行は同じ`client_msg_id`を使う。
- revisionが異なる投稿は異なる`client_msg_id`を使う。
- revision 0の配備前後では同じ`client_msg_id`を使い、応答喪失後の再試行で二重投稿を作らない。
- 投稿先channel、親thread、Block Kit本文、タスク操作値は変更しない。
- `taskCardTs`保存済みなら再投稿しない既存チェックポイントを維持する。
- `taskCardTs`未保存かつ投稿前提が不足する場合は、部分失敗を解除しない。

## テナント境界

適用対象は既存のCloudflare deploymentが固定したtenantとSlack workspace内の`MeetingMinutesRun`である。今回の変更はrunに保存済みの`runId`と`revision`だけをSlack冪等キーへ加え、request payloadからtenant、workspace、destinationを新たに受け取らない。既存のtenant分離と送信先検証を変更しない。

## 証拠境界

対象runにはredo履歴とタスクカード未完了があるが、保存済みDurable ObjectのSlackエラー本文は既存の読み取り経路から取得できない。したがって本番での衝突発生そのものは断定せず、コード上のrevision契約違反を再現テストで修正する。完了判定には、配備後の実タスク付きSlack E2E readbackを別途必要とする。

## 非対象

- Slack Block Kit本文の再設計。
- Task登録、Canvas修復、Brainbase正本文脈の契約変更。
- 読み取り専用のDurable Object管理API追加。
