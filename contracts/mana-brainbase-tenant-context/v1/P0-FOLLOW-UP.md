# P0 wire 差分別の期待修正表

比較対象は `source-lock.json` の3 HEADです。ここで示す変更先は追従 PR の期待値であり、PR #237ではプロダクションコードを変更しません。

| 差分 | 固定HEADで確認した非互換 | Brainbase PR #1229 の期待修正 | mana-runtime PR #236 の期待修正 | 共通fixture / 合格条件 |
|---|---|---|---|---|
| D-001 署名・envelope | Brainbase `tenant-context.js` は `alg/kid` header と base64url payloadを署名する。mana `envelope.ts` は `b64:false/crit/typ` とraw JCS payloadを署名する。header許容条件とtime検証も一致しない。 | `server/services/multitenant/tenant-context.js` と `canonical-json.js` を `reference/wire.mjs` と同じ RFC 8785 + RFC 7797 unencoded payload方式へ変更する。protected headerは `typ/alg/kid/b64/crit` の5項目だけを許可し、`expires_at > issued_at`、TTL 300秒、skew 30秒、文字列revisionを検証する。 | `packages/cloudflare-techknight-poc/src/multitenancy/envelope.ts` を exact-header と完全な RFC 8785 検証へ寄せる。独自 canonicalizer の edge case、追加header、`crit`追加要素、非canonical base64urlを拒否する。 | `positive/canonical-flow.json` の detached JWS が両者で同一。`tampered-payload`、`protected-header`、`revision-number`、`time-order`、`envelope-ttl` を期待codeで拒否。 |
| D-003 revision実経路 | Brainbase に connection registry / authority 草案、mana に runtime boundary 草案はあるが、受付からlease・write・replyの実経路で同じ revision 型とauthoritative recheckが未配線。 | `workspace-connection-registry.js` / `tenant-authority.js` に canonical string revision を導入し、expected revision付きauthoritative readを公開する。eventはcache無効化hintに限定する。 | `runtime-boundaries.ts` から ingress、credential lease直前、Brainbase write直前、Slack delivery直前の4地点へauthoritative readを配線する。unavailable / stale / revokedでfail closed。 | positiveの `connection_revision:"7"` を保持。number型を拒否。各副作用fixture testでrecheck callと business API / reply count 0または1を確認。 |
| D-004 protocol negotiation | Brainbase `protocol-contract.js` はrange中心、mana `protocol.ts` はversion配列中心で request/response shape が一致しない。required capability集合も不一致。 | request/responseとも `supported_range`、`supported_versions`、全required capability、optional capability status、`compatibility_until` をschemaどおり返す。 | 同じrequest/responseを読み、共通集合の最大minorを選ぶ。major不一致とrequired capability不足を明示codeで拒否し、downgrade/fallbackをしない。 | positiveで `1.0`。`protocol-major` は `PROTOCOL_VERSION_UNSUPPORTED`、`protocol-capability` は `PROTOCOL_CAPABILITY_UNSUPPORTED`。 |
| D-005 credential lease | Brainbase `credential-broker.js` は `lease_ref` で `contract_revision/max_uses` がない。mana `credentials.ts` は `lease_id` と別shape。binding・TTLの共通検証がない。 | responseを `lease_id`、`contract_revision`、`max_uses:1`、全binding、1〜60秒へ統一する。refresh CAS / credential materialはBrainbaseだけが所有する。 | request/responseをschemaどおりにし、全bindingをbyte-for-byte照合する。lease tokenだけをtrusted injectorへ渡し、queue/model/tool/log/Receiptへ保存しない。 | positive leaseを両者で受理。`credential-lease-legacy-shape`、`credential-lease-ttl`、`credential-lease-binding` を拒否。 |
| D-006 quota・Usage・Receipt・冪等性 | 両草案でフィールド、revision型、collection/outcome、claim ownerが揃わず、canonical ledgerへの実経路も未配線。 | `contract-usage-ledger.js` / repositoryで schemaどおりの QuotaDecision、UsageEvent、OperationReceipt と Brainbase-owned claimを保存し、同じkeyに別hashを拒否する。 | `accounting.ts` / `idempotency.ts` を同じ型・LP式へ統一する。manaは queue / Slack delivery claimだけを所有し、観測usageをBrainbaseへ提出する。 | positiveの4 UsageEventが `collected/partial/not_collected` と outcomeを独立保持。quota revision number、usage混同、owner/key不一致を期待codeで拒否。 |

## Gate の扱い

- **統合開始**: Brainbase producer と mana-runtime consumer の adapter test が同一 `fixture_set_sha256` で passするまで BLOCKED。
- **merge**: 両追従 PR の実経路配線、独立review、CIが揃うまで BLOCKED。
- **deploy / 本番E2E**: merge後の対象versionとSlack→Brainbase readback→Receipt→replyを同一correlationで確認するまで BLOCKED。

PR #237のconformance passだけで、上の3ゲートをPASSへ変更してはなりません。
