# run receipt / pilot health units

pilotで稼働している運用ユニット2組の正本。2026-07-31にpilot手置き状態からリポジトリへ回収した（gap-analysis 2026-07-30 D「配布物管理外＝脱属人化違反」の解消）。

| unit | 間隔 | 役割 |
|---|---|---|
| `openryoko-run-receipt.{service,timer}` | 1分 | gateway `/api/sessions` をポーリングしてrun receiptを収集し、brainbase（`/api/run-receipts/ingest`）へ配送。state/outbox/dead-letter方式 |
| `openryoko-pilot-health.{service,timer}` | 5分 | openryoko/receipt timer/gatewayの死活・dead-letter滞留・disk/memoryを検査しJSONで報告。異常時exit 1 |

## 配置（pilot）

```text
/etc/systemd/system/                        ← *.service / *.timer
/home/ryoko/lib/openryoko-run-receipt/      ← openryoko-reporter.mjs / reporter-core.mjs
/home/ryoko/bin/openryoko-pilot-health      ← ヘルスチェックスクリプト
/home/ryoko/.config/openryoko/run-receipt.env  ← 環境変数（下記。リポジトリに置かない）
```

## run-receipt.env（値はInfisical/pilotで管理。ここには変数名のみ）

```text
BRAINBASE_PROJECT_ID=
BRAINBASE_RUN_RECEIPT_INGEST_URL=          # https://bb.unson.jp/api/run-receipts/ingest
BRAINBASE_RUN_RECEIPT_SERVICE_TOKEN=       # 統合トークン openryoko-pilot と同一を使用（2026-07-31統一）
OPENRYOKO_OPERATOR_TOKEN=                  # /api/sessions がoperator保護のため必須（2026-07-31追加）
```

## 運用メモ

- reporterは `OPENRYOKO_OPERATOR_TOKEN` を `x-openryoko-operator-token` ヘッダーで送る。未設定だとplacements有効時に403となり、毎分 `operator_auth_missing` を監査ログへ流す（2026-07-30に観測された監査ノイズの原因）
- ingestは同一run_idで内容が異なると `run_receipt_conflict`（retryable: false）を返す。dead-letterの機械的なredriveは重複を生むため、conflictはアーカイブ退避が正しい
- デプロイ: 現状は手動配置。install.shへの組み込みは変更管理コード支援（並行作業）と合わせて行う
