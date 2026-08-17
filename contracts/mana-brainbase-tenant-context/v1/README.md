# Mana・Brainbase tenant context wire contract v1

このディレクトリは、Brainbase producer と mana-runtime consumer が同じ入力で検証する wire 契約の正本です。プロダクション実装ではありません。

## 固定入力

| 対象 | PR | 固定 HEAD |
|---|---:|---|
| 横断契約 | #237 | `ba1942e15935e00d1c603f57284439384bc95cac` |
| Brainbase producer 草案 | #1229 | `2c996d955609434e1ac205fe46a38f2920b815fd` |
| mana-runtime consumer 草案 | #236 | `b6c3fb5e46fe86e1cd77e02a5494151974a5a9e5` |

`source-lock.json` はこの比較基準を機械可読に固定します。以後の producer / consumer 追従は、このキットを変更せず同じ fixture を読んで行います。

## 規範ファイル

- `schema.json`: JSON Schema Draft 2020-12 の全 wire 型
- `reference/types.ts`: TypeScript 参照型。revision は JSON number ではなく `Revision` 文字列
- `reference/wire.mjs`: RFC 8785 canonicalization、Ed25519 detached JWS、時刻・revision・交渉・リース・usage の参照実装
- `fixtures/manifest.json`: producer / consumer が共有する実行ケース一覧
- `producer.contract.json`: Brainbase producer conformance の入出力契約
- `consumer.contract.json`: mana-runtime consumer conformance の受入・拒否契約
- `P0-FOLLOW-UP.md`: D-001、D-003〜D-006 の期待修正表

## 一意な署名方式

1. `integrity` を除いた envelope を RFC 8785 JSON Canonicalization Scheme (JCS) で UTF-8 byte 列へ正規化する。
2. protected header は次の5項目だけを持つ。欠落、追加、異なる値、異なる `crit` 配列は拒否する。

   ```json
   {"alg":"EdDSA","b64":false,"crit":["b64"],"kid":"fixture-ed25519-2026-08","typ":"application/mana-brainbase-tenant-context+jws"}
   ```

3. protected header 自体も JCS 化し、padding なし base64url にする。
4. RFC 7797 の unencoded payload を使う。署名入力は `BASE64URL(JCS(header)) + "." + JCS(unsigned_envelope)` の UTF-8 byte 列である。payload を base64url 化しない。
5. Ed25519 で署名し、compact serialization は `protected64..signature64` とする。
6. `integrity.key_id` と protected header の `kid` は byte-for-byte で一致させる。

この方式は、payload を base64url 化する detached JWS と互換ではありません。

## revision と時刻

- `Revision` は `"0"` または先頭ゼロなしの十進整数文字列です。全 `tenant_revision`、`connection_revision`、`contract_revision`、`quota_revision` に同じ型を使います。
- `expires_at` は必ず `issued_at` より後です。
- tenant context の TTL は 1〜300秒、credential lease の TTL は 1〜60秒です。
- 検証時刻に対する許容 skew は前後30秒です。`issued_at > now + 30秒` または `expires_at < now - 30秒` は拒否します。
- envelope は延長・書換えせず、必要なら Brainbase から新しく発行します。

## protocol negotiation

- `protocol_id`: `mana-brainbase-tenant-context`
- current version: `1.0`
- supported range: `>=1.0 <2.0`
- request / response は `supported_range` と列挙済み `supported_versions` の両方を持ちます。
- 両者の `supported_versions` の共通集合から、同一 major の最大 minor を選びます。
- `required_capabilities` が一つでも不足する場合、または major が一致しない場合は業務 API より前に拒否し、暗黙 downgrade や fallback をしません。

## credential lease

Brainbase が credential と refresh state の唯一の所有者です。request / response は `lease_id`、`contract_revision`、`max_uses: 1` を共有し、次を binding として byte-for-byte で一致させます。

`tenant_id + connection_id + connection_revision + contract_revision + operation_id + audience + credential_mode + credential_ref`

lease は最大60秒で、別 operation、別 audience、別 tenant、別 revision へ再利用できません。raw secret は fixture、queue、Durable Object、model/tool payload、disk、log、UsageEvent、Receipt に置きません。

## quota・usage・receipt・冪等性の所有権

| wire / claim | canonical owner | producer |
|---|---|---|
| contract、quota、credential lease | Brainbase | Brainbase |
| `UsageEvent`、`OperationReceipt`、business effect claim | Brainbase | mana-runtime が観測値を提出し、Brainbase が正規化・保存 |
| queue execution claim、Slack delivery claim | mana-runtime | mana-runtime |

冪等性キーは次の一式に固定します。

`ik1_ + base64url_no_padding(SHA-256(LP(protocol_id) || LP(protocol_major) || LP(tenant_id) || LP(connection_id) || LP(slack_event_id) || LP(operation_id)))`

`LP(v)` は `uint32be(UTF-8 byte length) || UTF-8(v)` です。retry は同じ operation に同じ key を再利用します。claim 後の payload hash / context hash 変更は `IDEMPOTENCY_CONFLICT` です。

## collection state と outcome

取得状態と処理結果を一つの enum に混ぜません。

- `collection_state`: `collected | partial | not_collected`
- `outcome`: `succeeded | failed | cancelled | timed_out`

`not_collected` の `quantity` は `null`、`partial` は `unknown_fields` を1件以上持ちます。取得済み0件は `collected + quantity: 0 + failure_code: "NO_DATA"` であり、`not_collected` ではありません。

## 共通 conformance の実行

```sh
node --test contracts/mana-brainbase-tenant-context/v1/test/*.test.mjs
```

Brainbase と mana-runtime の各 PR は、`source-lock.json` の kit commit と `fixtures/manifest.json` の SHA-256 を固定し、同じ manifest を読む adapter test を追加します。fixture の複製や期待値の独自変更は conformance ではありません。

このキットの pass は wire 契約の実行可能性だけを示します。統合開始、merge、deploy、本番 Slack E2E、Graph/Receipt readback の pass を意味しません。
