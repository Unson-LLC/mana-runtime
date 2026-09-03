# Cloudflare CI/CD運用

## 結論

`unson-business-mana-runtime`の本番配備は、GitHub Actionsの「Cloudflare本番配備（unson-business）」から手動実行する。

個人のCloudflare OAuth認証やAPIトークンはCIへ持ち込まない。`production` Environmentに保存したCI専用のCloudflare Account API Tokenを使う。

## 配備できる状態

次の条件をすべて満たす必要がある。

1. 配備対象が`main`のHEADである。
2. HEADの変更が、既存スクリプトで許可された2つのsource lockだけである。
3. source lockの`deployment_authorization`が対象、レビュー済み親コミット、有効期限と一致する。
4. Brainbaseのプロジェクト束縛確認が成功する。
5. 議事録処理の配備ゲートに実行中処理がない。
6. GitHubの`production` Environmentで承認される。

ワークフローから直接`wrangler deploy`を呼ばず、正本の`pnpm deploy:unson-business`を使う。これにより、既存の事前確認と配備後ヘルスチェックを迂回しない。

## 必要なGitHub Environment secrets

`production` Environmentに次の名前で登録する。値はリポジトリ、ワークフロー、ログへ保存しない。

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `BRAINBASE_TASK_API_TOKEN`
- `BRAINBASE_GRAPH_API_TOKEN`
- `SANDBOX_PROBE_TOKEN`

Cloudflareトークンは`mana-runtime-github-actions-production`というAccount API Tokenとし、アカウント`788e556343893a7135c29b782c22fb24`だけを対象にする。請求、メンバー管理、APIトークン作成権限は付けない。

## 実行手順

1. 通常の変更をPRでレビューし、`main`へマージする。
2. Human Gateで配備対象と期限を承認し、2つのsource lockだけを変更する認可専用PRを作成する。
3. 認可専用PRをレビューして`main`へマージする。
4. GitHub Actionsから「Cloudflare本番配備（unson-business）」を選ぶ。
5. ブランチに`main`、配備理由に対象PRと判断理由を入力して実行する。
6. `production` Environmentの承認者が、対象コミットと認可期限を確認して承認する。
7. 実行結果にあるコミット、配備結果、配備後ヘルスチェックを確認する。

Workerコードだけを変更し、既知正常なContainerイメージを維持する復旧配備では、`Container更新を省略`を明示的に有効化できる。既定値は無効であり、通常配備では従来どおりWorkerとContainerを更新する。Dockerfile、Container内コード、依存関係を変更した配備では使用しない。

## 権限境界

- 梅田さんにはPR作成、Actions閲覧・実行、および必要に応じた`production`承認権限を付ける。
- 梅田さんを含む開発者へCIの秘密値そのものは共有しない。
- Pull Requestやfork由来のイベントでは本番配備を実行しない。
- 同じ環境への配備は直列化し、先行配備をキャンセルしない。

## 失敗と復旧

- 事前確認失敗: 配備されていない。エラー種別に応じてsource lock、Brainbase束縛、議事録ゲート、秘密情報を修正する。
- Wrangler配備失敗: Cloudflareのdeployment履歴とWorker状態を読み戻し、部分反映の有無を確認する。
- 配備後ヘルスチェック失敗: 配備成功とは扱わない。直前の既知正常コミットを新しい認可専用PRで再認可し、同じワークフローから再配備する。

GitHub Actionsの成功だけでは、Slack、Brainbase、重複防止を含む利用者E2Eの成功とは判定しない。必要な本番E2Eは配備証跡と分けて実施する。
