# Manaマルチテナント本番E2E証跡の採取手順

## 現在の証跡状態

- Story: `story-mana-multitenant-runtime`
- 本番実行状態: `not_collected`
- この文書の位置づけ: 採取手順。実行receiptではない。
- ローカル自動検証: `packages/cloudflare-techknight-poc/src/__tests__/production-multitenancy.integration.test.ts`

ローカル統合テストはQueue consumer、権威スナップショット、quota、Slack配送ownership、
UsageEvent、OperationReceiptを実装経路で結合する。ただし、実Cloudflare配備、実Slack、
Brainbase正本、旧runtime無返信は証明しない。本番実行前後とも、receiptが作成されて
readbackされるまでは `not_collected` を維持する。

## 実行前に固定する値

次の値を同一runの識別子として固定する。secretやtoken本文は記録しない。

- Git SHA、Cloudflare Worker version、Container image digest
- deployment profile、deployment ID、contract revision
- Tenant A/Bのtenant ID、workspace connection ID、connection revision
- Slack workspace ID、App ID、channel ID、request event ID、thread URL
- actor principal ID、project ID、capability ID
- correlation ID、operation ID、idempotency key
- Brainbase authority、quota、credential broker、accountingの公開endpoint識別子

## 本番E2E行列

1. Tenant Aの許可済み操作をSlackから1回実行する。
2. 同じeventをQueue再送し、副作用とSlack返信が増えないことを確認する。
3. Tenant Bの署名済みcontextをTenant Aの期待scopeへ流し、処理前にfail-closedすることを確認する。
4. workspace connection revisionを更新し、旧revisionを拒否して新revisionだけを受理する。
5. authority、quota、credential broker、accountingを個別に到達不能へし、`no_data`や成功へ丸めず再試行または終端失敗になることを確認する。
6. Cloudflare WorkerだけがSlackへ1返信し、旧runtimeは0返信であることを確認する。
7. Brainbaseから同じoperationのUsageEventとOperationReceiptをreadbackする。

## receiptに必須のreadback

本番runごとに、改変不能なreceiptへ次を保存する。

- `status`: `collected`、`partial`、`not_collected` のいずれか
- 実行開始・完了時刻、実行者、Git SHA、Worker version、image digest
- Tenant A/Bとworkspace connectionの公開識別子、revision
- Slack request URL、event ID、reply URL、reply count、legacy reply count
- quota decisionとquota revision（利用量が未取得なら数量は`null`）
- credential lease IDとcredential mode（secret本文は保存しない）
- correlation ID、operation IDs、idempotency keys
- UsageEvent IDs、OperationReceipt ID、Brainbase readback結果
- Cloudflare reply count `1`、旧runtime reply count `0`
- 失敗ケースのerror code、retry/ack結果、副作用件数
- 未確認項目と未確認理由

一部のreadbackだけ取得できた場合は `partial` とし、不明値を0件や成功へ置換しない。
本番を未実行、またはreceiptをreadbackできない場合は `not_collected` のままとする。

## 完了判定

以下が同一runで揃った場合だけ、本番E2Eを`collected`として扱う。

- Tenant A成功、Tenant B拒否、revision更新、依存障害の全ケース
- Slack返信1件、旧runtime返信0件
- UsageEventとOperationReceiptのBrainbase正本readback
- Git SHA、Worker version、Slack event ID、operation IDの相互一致
- secret非露出

ローカルテスト成功、CI成功、デプロイ成功、Slack返信1件のいずれか単独では完了にしない。
