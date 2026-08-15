# Story: Brainbase正本文脈を使って議事録を生成する

## 利用者価値

Slackへ議事録ファイルを投稿した利用者として、選択したプロジェクトのBrainbase正本文脈が取得・利用されたことを確認できる議事録を作りたい。これにより、人物や用語の表記揺れ、過去判断との矛盾、既存タスクとの重複を減らす。

## 受け入れ条件

- [ ] AC1: 文字起こし取得とhash計算後、生成前に選択先projectのBrainbase context Receiptを取得してrunへ保存する。
- [ ] AC2: requiredモードではReceiptが`partial`、`unavailable`、identity不一致、checksum不正ならGitHub保存・タスク登録・Slack共有へ進まない。
- [ ] AC3: Claude promptはrun/project/hash/receipt identityと専用MCP toolの必須利用を明示し、生成結果は利用したsource refsと判断候補を返す。
- [ ] AC4: 生成結果のsource refsはReceipt内の参照だけを許し、Receipt未使用または架空参照を拒否する。
- [ ] AC5: 既存タスクと正規化title・担当者・projectが完全一致する場合は既存taskを再利用し、類似候補は`needs_review`として自動登録しない。
- [ ] AC6: GitHubへReceipt metadataと参照を保存し、Slack完了表示でBrainbase利用を示す。Graph全文は保存しない。
- [ ] AC7: 配信先、生成本文、GitHub、Slack、redo、watchdog、task/Canvasの既存契約を維持する。

## 運用モード

`MEETING_MINUTES_CONTEXT_MODE=observe|required`を使う。observeでは欠落を記録して従来生成を継続し、requiredではfail closedにする。未設定はobserveとする。

## リリース条件

Brainbase側Receipt API/MCPの本番疎通後にobserveを配備する。Receipt利用率、identity一致、既存機能のreadbackを確認してrequiredへ切り替える。議事録runがactiveな間はDeployment Gateにより配備しない。
