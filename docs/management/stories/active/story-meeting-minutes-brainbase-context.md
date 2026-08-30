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
- [ ] AC15: 障害対応やrollbackでは、処理中runを中断せずに新規ファイル投入と保存先選択だけを先に停止できる。停止前後にQueueへ到達したrouterファイル・保存先選択・やり直しは、停止版でも再試行ループや通常処理へ流さずACKし、Slackへ停止理由と復旧後の操作案内を表示する。処理中runが0件になった後だけ、受付停止機構を保持した停止版を通常のDeployment Gateで配備し、再開は明示操作とする。
- [ ] AC16: 受付停止版は新規runを開始しない一方、検証済みの保存先設定を参照用に保持する。これにより、既存完了runのCanonical Task編集・取消と、保存済みの旧Project範囲から現行の正規範囲への安全な移行を停止中も継続できる。
- [ ] AC17: 生成結果はプロンプトの見本・説明文・型の選択肢を値として含まない。新規生成だけでなく既存runへ保存済みの見本出力も副作用前に再検証する。未共有なら同一再実行で破棄・再生成し、共有済みなら自動上書きせず理由と「保存先をやり直す」を表示して、安全に撤回・再生成できる。
- [ ] AC18: 「取り消して選び直す」の確認後は、同じSlack投稿を即座に「保存先をやり直しています」へ切り替える。GitHub・Canonical Task・共有Slackの取り消しをrunへ工程別に永続化し、途中失敗後の再実行は完了済み工程を重複させない。旧共有Slack投稿が既に存在しない場合は撤回済みとして工程を完了し、それ以外のSlackエラーは失敗として保持する。成功時は同じ投稿を保存先選択へ、失敗時は理由付きの再実行表示へ必ず切り替え、確認画面を残し続けない。
- [ ] AC19: 本番配備後、実Slack E2Eの前に、認証済み管理APIから本番と同じClaudeコマンド・設定・Judgment Hook・Receipt注入・監査行付きJSON解析を使う議事録生成プローブを実行できる。UserPromptSubmitとStopの成功Receiptを同一session・turn・event順序へ束縛し、Stop監査行と最終回答先頭が原文・順序・回数どおり一致しない場合は失敗とする。成功時は生成内容を返さず、失敗時は許可済みの診断コードだけを返す。プローブ成功を確認するまで利用者のSlack投稿を再実行させない。
- [ ] AC20: 保存済みrunのorganizationだけが現行設定と異なる場合、SlackチャンネルとGitHub保存先が一致するときに限り、organizationを現行の認証経路へ更新して再実行できる。SlackチャンネルまたはGitHub保存先が異なる場合は、従来どおり`meeting_minutes_destination_changed`で拒否する。同じSlackチャンネルを複数organizationへ割り当てた曖昧な設定と、現行設定に存在しないチャンネルの資格情報解決はfail closedにする。
- [ ] AC21: Claudeへ渡すBrainbase文脈は、100KB未満でも全量投入せず、プロジェクト不変条件などの必須アンカーと文字起こしに関連する証拠から決定的なworking setを構成する。入力順序が変わっても同じ証拠を保持し、100KBは品質目標ではなく搬送上限として扱う。選別後も上限を超える場合は無造作に本文を圧縮せず、生成前に明示的に拒否する。
- [ ] AC22: 議事録操作のユーザー向け失敗表示（スレッド特定、状態表示、選択、保存先やり直し、受付停止、ライフサイクル、Task編集・取消）は、Queueの`runId`または実行前routerイベントの`eventId`・失敗段階・固定エラーコードから決定的に導出した問い合わせIDを付ける。上流から相関IDを受け取れない同期表示は`channel`・`thread`または`channel`・`user`から構成する決定的なfallback seedを使い、空のシードやraw errorを問い合わせIDにしない。受付判定とTask write承認コールバックの拒否はraw errorを返さずHTTP 503の安全な失敗envelopeとし、資格条件を満たす`response_url`だけへ安全に投影する。遅延Taskのopen・edit・cancelはPromiseをraw rejectで残さず、固定診断ログと安全投影へ収束させ、scope不一致通知は維持する。

## 運用モード

`MEETING_MINUTES_CONTEXT_MODE=observe|required`を使う。observeでは欠落を記録して従来生成を継続し、requiredではfail closedにする。未設定はobserveとする。

## リリース条件

Brainbase側Receipt API/MCPの本番疎通後にobserveを配備する。Receipt利用率、identity一致、既存機能のreadbackを確認してrequiredへ切り替える。議事録runがactiveな間はDeployment Gateにより配備しない。
