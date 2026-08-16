# Story: Brainbase正本文脈を使って議事録を生成する

## 利用者価値

Slackへ議事録ファイルを投稿した利用者として、選択したプロジェクトのBrainbase正本文脈が取得・利用されたことを確認できる議事録を作りたい。これにより、人物や用語の表記揺れ、過去判断との矛盾、既存タスクとの重複を減らす。

## 受け入れ条件

- [ ] AC1: 文字起こし取得とhash計算後、生成前に選択先projectのBrainbase context Receiptを取得してrunへ保存する。
- [ ] AC2: requiredモードではReceiptが`partial`、`unavailable`、identity不一致、checksum不正ならGitHub保存・タスク登録・Slack共有へ進まない。
- [ ] AC3: Workerは検証済みのBrainbase context Receiptを生成前に必ずClaudeへ渡し、生成結果は利用したsource refsと判断候補を返す。文脈取得をClaudeの任意MCP呼び出しに依存させない。
- [ ] AC4: 生成結果のsource refsはReceipt内の参照だけを許し、Receipt未使用または架空参照を拒否する。
- [ ] AC5: 既存タスクと正規化title・担当者・projectが完全一致する場合は既存taskを再利用し、類似候補は`needs_review`として自動登録しない。
- [ ] AC6: GitHubへReceipt metadataと参照を保存し、Slack完了表示でBrainbase利用を示す。Graph全文は保存しない。
- [ ] AC7: 配信先、生成本文、GitHub、Slack、redo、watchdog、task/Canvasの既存契約を維持する。
- [ ] AC8: Brainbase Receipt取得済みのrunは、Claudeが追加のBrainbase MCP呼び出しを行わなくても正本文脈を使って生成でき、Receipt identity・checksum・source refsの検証を通過する。
- [ ] AC9: ClaudeがReceipt外のsource refを返した場合、observeモードはReceipt内の参照だけへ正規化し、SlackとGitHubへ警告を表示して議事録生成を継続する。requiredモードは副作用前に拒否する。
- [ ] AC10: すべての議事録保存先は、Brainbase文脈参照コード、Canonical Task登録コード、タスクボード共有先をそれぞれ明示する。保存先の内部`projectId`をBrainbaseコードとして暗黙に代用せず、いずれかが欠けた設定は起動時検証で拒否する。
- [ ] AC11: Brainbaseの401は「認証情報が未設定、無効、または期限切れ」、403または未認可Projectコードは「プロジェクト紐付け・権限不足」とSlackへ区別して表示する。どちらも内部エラーを露出せず、設定修正まで成功しないため再実行ボタンを表示しない。
- [ ] AC12: 公式デプロイは全議事録保存先の文脈参照コード、Task登録コード、タスクボードコードを本番Brainbaseの認可済みProject集合と一括照合する。未登録・未許可・用途間不一致が1件でもあれば、Workerを更新せず失敗する。
- [ ] AC13: 保存先の正規Project紐付けを変更した場合、既存runに保存した旧Task範囲を信頼境界として保持する。編集時は同じTaskを現在の正規範囲へ更新し、取消時は旧範囲と完全一致するTaskだけを削除する。無関係な範囲のTaskは拒否する。
- [ ] AC14: `taskProjectCodes`導入前に内部`projectId`をTask範囲として保存した既存runも、その旧範囲と完全一致するTaskだけを現行の正規範囲へ移行できる。無関係な範囲は編集・取消せず、操作した利用者へSlackで理由を表示する。公式デプロイはTask APIとGraph APIの両方を本番資格情報で検証する。
- [ ] AC15: 障害対応やrollbackでは、処理中runを中断せずに新規ファイル投入と保存先選択だけを先に停止できる。停止中に受信済みのQueueイベントも通常処理へ流さず、停止理由をSlackへ表示する。処理中runが0件になった後だけ、受付停止機構を保持した停止版を通常のDeployment Gateで配備し、再開は明示操作とする。

## 運用モード

`MEETING_MINUTES_CONTEXT_MODE=observe|required`を使う。observeでは欠落を記録して従来生成を継続し、requiredではfail closedにする。未設定はobserveとする。

## リリース条件

Brainbase側Receipt API/MCPの本番疎通後にobserveを配備する。Receipt利用率、identity一致、既存機能のreadbackを確認してrequiredへ切り替える。議事録runがactiveな間はDeployment Gateにより配備しない。
