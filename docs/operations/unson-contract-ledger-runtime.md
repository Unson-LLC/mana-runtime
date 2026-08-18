# 雲孫契約台帳の自動同期

## 運用境界

mana-runtimeは平日9:00（日本時間）にinfo@unson.jpのDocuSign本番Envelopeを取得し、雲孫契約台帳と照合する。自動署名、法的判断、契約送信は行わない。

専用経路は次のとおり。

- Cron: `0 0 * * 1-5`（UTC。日本時間の平日9:00）
- Queue: `unson-business-contract-ledger-syncs`
- DLQ: `unson-business-contract-ledger-syncs-dlq`
- Durable Object: `CONTRACT_LEDGER_STATE`
- 法務チャンネル: `CONTRACT_LEDGER_LEGAL_CHANNEL_ID`

既存行はEnvelope IDで照合し、状態と最終更新日時だけを更新する。未登録の破棄済みEnvelopeとテストEnvelopeは除外する。未登録の有効なEnvelopeは法務チャンネルへ通知し、許可された担当者が承認するまで台帳へ追加しない。

## 秘密情報

次の値はGitや平文のWorker変数へ置かず、Infisicalの雲孫本番環境を正本にする。デプロイ時にCloudflare Worker secretへ注入する。

- `DOCUSIGN_INTEGRATION_KEY`
- `DOCUSIGN_USER_ID`
- `DOCUSIGN_RSA_PRIVATE_KEY_BASE64`（PKCS#8）
- `DOCUSIGN_ACCOUNT_ID`（固定する場合）
- `DOCUSIGN_BASE_URI`（固定する場合）
- `GOOGLE_DRIVE_MCP_TOKEN`
- `SLACK_BOT_TOKEN`

DocuSignは初回だけ`signature impersonation`の同意が必要。秘密値と短期アクセストークンはログ、Receipt、Slack通知へ出さない。

Google Sheetsへのアクセスは`contract-ledger.ts`内で、設定済みのSpreadsheet ID、`契約台帳`シート、`A:O`の読取り、既存行の`F:G`更新、承認後の1行追加に制限する。基盤側のGoogle Drive MCP権限も対象スプレッドシートへ制限すること。

## 段階的な有効化

配備時の初期値は`CONTRACT_LEDGER_ENABLED=false`、`CONTRACT_LEDGER_WRITE_MODE=audit`である。

1. 必要なWorker secretを注入し、DocuSignのimpersonation同意を済ませる。
2. `CONTRACT_LEDGER_ENABLED=true`にして監査モードを2回以上実行する。
3. CLIの`sync-ledger --dry-run`と、Receiptの取得件数・更新候補・承認候補・除外・失敗を照合する。
4. 差分解消後に`existing`へ進め、既存行だけが更新されることを再読込で確認する。
5. `full`へ進め、候補通知後も承認前には行が増えず、承認後に一度だけ増えることを確認する。
6. 連続2営業日のReceipt、DocuSign、契約台帳、Slackを照合して本運用とする。

認証失敗、台帳ヘッダー変更、API失敗は失敗Receiptとして保持し、法務チャンネルへ通知する。再試行上限に達したイベントはDLQ Consumerが通知する。
