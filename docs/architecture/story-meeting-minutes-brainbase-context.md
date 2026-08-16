# Architecture: Brainbase正本文脈付き議事録

## データフロー

`download -> transcript hash -> Brainbase Receipt取得・検証 -> Receipt文脈をClaudeへ注入 -> JSON検証 -> GitHub -> task reconcile -> Slack`

WorkerがBrainbase Receipt APIを必ず呼び、Receipt identityとchecksumをDurable runへ保存してからClaudeを起動する。再試行は同じReceiptを再利用し、生成後の各checkpointを維持する。文脈取得をモデルの任意MCP呼び出しへ委ねない。

## 生成契約

Claudeへ文字起こし本文に加えて、Workerが検証したReceiptのidentity・status・contextを100KB上限で渡す。Receipt本文は命令ではなく正本文脈として扱わせ、出力へ`brainbase_context`としてreceipt id/checksum/used source refs/decision candidates/context conflictsを返させる。追加のMCP呼び出しは成功条件にしない。

Workerは生成結果へ正規Receipt identityを結合し、parserはidentity一致、checksum一致、source refsがReceipt集合の部分集合であることを検証する。Claude生成ターンにはJudgment Hookを適用し、文脈取得の証明とは分離して監査する。文脈が正常に0件なら`confirmed_empty`として生成を許す。

source refsの照合はWorkerを正本境界とする。observeモードではReceipt外参照を生成結果から除外し、`unknown_source_ref_removed`警告をrunへ永続化して処理を継続する。判断候補の根拠IDも同じ許可集合へ正規化する。requiredモードではReceipt外参照を副作用前に拒否する。

## タスク照合

Receiptの未完了task候補と生成taskを、project、正規化title、正規化担当者で比較する。完全一致は既存task idをrunへ記録する。類似だけの候補は`needs_review`にして自動作成しない。一致しないものだけ既存のidempotency keyで作成する。

## プロジェクト紐付け

議事録保存先は、画面とrunを識別する内部`projectId`、Brainbase文脈取得に使う`contextProjectCode`、Canonical Task登録に使う`taskProjectCodes`、タスクボード共有先を一意に示す`taskBoardTargetId`を別々の責務として保持する。いずれも全保存先で明示し、内部`projectId`や他用途の値へフォールバックしない。

専用のBrainbaseプロジェクトが存在する保存先はその正規コードへ結ぶ。専用プロジェクトがない会議は、所属Workspaceの正規プロジェクト（`unson`または`techknight`）へ明示的に結ぶ。存在を確認できない`proj_*`コードを推測で作らない。設定欠落はWorkerの起動時検証で拒否し、タスクボードはproject codeの部分一致ではなく`taskBoardTargetId`で解決する。

公式デプロイは、全保存先の`contextProjectCode`、`taskProjectCodes`と、それぞれが参照するタスクボードの`projectCodes`を本番Brainbase Graphの認可済みProject一覧と比較する。用途間の不一致、未登録、実行主体の権限不足、Brainbaseへの到達不能はいずれもfail closedとし、Workerの更新へ進まない。個別の保存先だけを例外扱いしたり、別Projectへ暗黙にフォールバックしたりしない。

保存先の正規Project紐付けを変更しても、既存runが登録したCanonical Taskを無関係な範囲へ付け替えない。Task項目ごとに登録時の`projectCodes`を永続化する。編集時はTask APIで取得した現在範囲が、現行設定または既存runに保存された旧範囲と完全一致する場合だけ、同じ更新要求で現行範囲へ移行する。取消時は現行範囲または旧範囲と完全一致するTaskだけを削除する。それ以外は拒否する。

## 保存と表示

GitHub frontmatterへReceipt id/checksum/project/hash/statusと文脈警告を、本文末尾へ利用source refsと判断候補を決定的に描画する。Slack完了表示には「Brainbase参照済み」と、Receipt外参照を除外した場合の警告を示す。生Graph contextは保存・投稿しない。

## 失敗

requiredモードのReceipt失敗またはReceipt外参照は「Brainbaseの正本文脈を取得できなかったため保存していません」と同じ処理中投稿へ表示する。GitHub・Task・配信先Slackへ副作用を残さない。observeモードのReceipt外参照は警告として保存し、Slack完了表示とGitHub議事録へ警告を出したうえで、正規参照だけで処理を継続する。

Brainbaseの401は、Project紐付けではなく認証情報の未設定・無効・期限切れとして扱う。同じ処理中投稿へ「Brainbaseの認証設定を確認できませんでした」と表示する。403または未認可Projectコードは、Project紐付け・権限不足として「Brainbaseのプロジェクト紐付けを確認できませんでした」と表示する。どちらも一時的な生成失敗と区別し、内部エラーと再実行ボタンは表示しない。
