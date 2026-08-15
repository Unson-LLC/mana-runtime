# Architecture: Brainbase正本文脈付き議事録

## データフロー

`download -> transcript hash -> Brainbase Receipt -> Claude専用MCP取得 -> JSON検証 -> GitHub -> task reconcile -> Slack`

Receipt identityとchecksumをDurable runへ保存してからClaudeを起動する。再試行は同じReceiptを再利用し、生成後の各checkpointを維持する。

## 生成契約

Claudeへ文字起こし本文に加えて、run id・project code・transcript hash・receipt idを渡す。`brainbase_get_meeting_minutes_context`の呼び出しを必須とし、出力へ`brainbase_context`としてreceipt id/checksum/used source refs/decision candidates/context conflictsを返させる。

parserはidentity一致、checksum一致、source refsがReceipt集合の部分集合であることを検証する。文脈が正常に0件なら`confirmed_empty`として生成を許す。

## タスク照合

Receiptの未完了task候補と生成taskを、project、正規化title、正規化担当者で比較する。完全一致は既存task idをrunへ記録する。類似だけの候補は`needs_review`にして自動作成しない。一致しないものだけ既存のidempotency keyで作成する。

## 保存と表示

GitHub frontmatterへReceipt id/checksum/project/hash/statusを、本文末尾へ利用source refsと判断候補を決定的に描画する。Slack完了表示には「Brainbase参照済み」を示す。生Graph contextは保存・投稿しない。

## 失敗

requiredモードのReceipt失敗は「Brainbaseの正本文脈を取得できなかったため保存していません」と同じ処理中投稿へ表示する。GitHub・Task・配信先Slackへ副作用を残さない。
