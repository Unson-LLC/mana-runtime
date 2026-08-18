# Story: redo後も議事録のタスクカードを投稿できる

## 利用者価値

Slackで議事録の保存先をやり直した利用者として、新しい議事録スレッドへタスクカードが確実に投稿されてほしい。これにより、redo後に旧revisionのSlack重複排除キーを再利用する契約違反を防ぎ、タスクカードだけが未完了の場合は上流処理を重複させず再試行できる。

## 受け入れ条件

- [x] AC1: revision 0は配備前の`client_msg_id`を維持し、revision 1以降は`runId`と`revision`から決まり、同じrevisionの再試行では変わらない。
- [x] AC2: redoでrevisionが増えた後は、旧revisionとは異なる`client_msg_id`で新しい議事録スレッドへ投稿する。
- [x] AC3: 投稿先の`channel`と`thread_ts`、タスクカード本文・操作ボタンの契約を変更しない。
- [x] AC4: タスクカードのみ再試行では親投稿、詳細投稿、文脈解決、Task登録、Canvas修復を重複させず、投稿前提が不足する場合は部分失敗を解除しない。

## 成功指標

- redo後のタスクカード投稿が旧投稿のSlack重複排除キーと衝突する件数は0件である。
- 同一revisionの再試行によるタスクカード二重投稿は0件である。

## リリース条件

- Slackアダプタのrevision境界テスト、議事録パイプラインのタスクカード再試行テスト、型検査を通す。
- READMEの手順どおり受付停止、active run 0、停止状態での同一artifact配備、project preflight、有効化、設定readback、受付再開を行う。
- 本番でタスクを1件以上含むrunをrevision 0から1へredoし、同一runId・Worker versionで新parent配下のタスクカード、`taskCardTs`、Brainbase Task、Canvas、GitHub、source statusをreadbackする。親・本文・Task・カードに意図しない重複がないことも確認する。
- 対象run `Ev0BQK37TDD2_F0BR9NZ205N`の復旧は上記release E2Eと分けて確認し、保存済みSlack errorを取得できない間は元障害の原因を確定済みと扱わない。

## 現在地

コード上のrevision冪等性とカード専用再試行を修正対象とする。元の本番エラーは保存状態の安全な読み取り経路がないため未確定であり、配備後readbackが完了するまでインシデント解消とは判定しない。
