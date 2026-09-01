# Brainbase-owned Company Authority Runtime Adapter

## 1. 目的

A0でsource lockしたBrainbase会社権限契約を、MANAの実runtimeへ安全に接続する。MANAは観測事実を送るconsumerであり、person、organization、project、RACI、approver、policy、authority decisionを生成しない。

## 2. 現在地

現行`createTenantRuntimeHttpClients`は旧`TenantContextIssueRequest`を`/api/v1/runtime/tenant-context:resolve`へ送り、runtime側でtenant、connection、expected revision、workspace／app、operation、project、authorizationを組み立てる。これはtenant safetyには使われているが、公開`ObservedExecutionRequestV1`とは非互換である。

A0の`acceptCompanyAuthorityResponse`はfixture conformance testからだけ呼ばれ、production call site、live endpoint、production trust storeはない。したがってadapterは、未定義のendpointを埋め込まず、transport portと検証を分離する。

## 3. 設計原則

1. **観測と権限を分離する**: Slack署名検証後のexternal subject、requested action、delivery、correlationだけを送る。
2. **権限解決はBrainbase owner**: canonical person、membership、scope、RACI、policy、decision、receiptは署名済みresponseからだけ取得する。
3. **二重の境界を維持する**: 外側`CanonicalExecutionContextV1`を検証し、その内側の既存`TenantContextEnvelope`検証も残す。
4. **失敗時は作用前に停止する**: unavailable、unknown、partial、not_collected、schema／signature／TTL／binding不一致ではbusiness callbackを呼ばない。
5. **opt-in後はfallbackしない**: 旧`authorization.data_scopes`、default tenant、default person、運営者credentialへ戻さない。
6. **証拠の範囲を分ける**: fixture／unitの成功をlive endpoint、production trust、production runtimeの成功として扱わない。

## 4. コンポーネント

### 4.1 Observation mapper

認証済みSlack ingressを`ObservedExecutionRequestV1`へ変換する純粋関数とする。

- `provider_identity.provider = "slack"`
- `authenticated_subject_id`は認証済みSlack user ID
- `workspace_id`、`app_id`、`enterprise_id`は観測値だけ
- `requested_action`はcapability、resource ref、任意のproject hint、明示desired effect
- `delivery`と`correlation_id`を保持

禁止fieldは型とruntime validationの両方で拒否する。未知capabilityは`read`に寄せない。

### 4.2 CompanyAuthorityClient port

```ts
interface CompanyAuthorityClient {
  resolve(request: ObservedExecutionRequestV1): Promise<CompanyAuthorityResolutionResponseV1>;
}
```

最初はfixture transportとunavailable transportを注入して検証する。HTTP path、service binding、authentication、retry policyはBrainbase側のlive endpoint契約が確定するまで未定義とする。portの存在はendpointの存在証明ではない。

### 4.3 Response acceptance

A0 source lockの`acceptCompanyAuthorityResponse`を唯一の受理入口にする。

- callerが供給するtrusted JWK setと`now`
- 外側responseとnested TenantContextの署名
- contract／schema version
- correlation、audience、deployment、tenant、connection
- membership、resource、RACI、policy revision
- expiryとdecision

独自の`data_scopes` markerや文字列一致をcompany authorityの代替にしない。

### 4.4 Runtime propagation

```text
signed Slack ingress
  -> ObservedExecutionRequestV1
  -> CompanyAuthorityClient
  -> acceptCompanyAuthorityResponse
  -> verified CanonicalExecutionContextV1
  -> Worker
  -> Queue
  -> Durable Object
  -> Container
  -> MCP
  -> Brainbase proxy
  -> Slack delivery
```

各境界は外側contextを再検証し、内側の既存`validateTenantBoundary`／`TenantRuntimeBoundaryVerifier`も実行する。outer contextからtenant IDなどを再生成せず、署名済みnested contextと一致することを確認する。

## 5. Failure semantics

| 状態 | 公開code | business callback | legacy fallback |
|---|---|---:|---:|
| transport unavailable | `AUTHORITY_UNAVAILABLE` | 0 | 0 |
| `no_data / unknown / partial / not_collected` | `AUTHORITY_UNAVAILABLE` | 0 | 0 |
| request schema不正／未知capability | 安定した入力拒否code | 0 | 0 |
| producer error response | producerのcanonical code | 0 | 0 |
| outer／nested署名不正 | producer contractの署名拒否code | 0 | 0 |
| TTL／audience／deployment／binding不一致 | producer contractのbinding拒否code | 0 | 0 |
| `deny` | `COMPANY_AUTHORITY_DENIED` | 0 | 0 |

内部のperson、RACI、credential、tenant情報をSlack利用者へ漏らさない。運用logとReceiptにはcorrelation ID、safe code、authority receipt参照だけを残す。

## 6. Decision handling

- `auto`: allowed effect内でのみ実行する。
- `approval`: protected effectを実行せず、Brainbase指定approverへの判断packet作成へ送る。
- `human_action`: protected effectを実行せず、Brainbase指定responsible personへの本人行動依頼へ送る。
- `deny`: tool、model、credential lease、Graph／Task read、外部作用、Slack delivery前に停止する。

decisionを上位へ昇格したり、approver／responsible personをMANA側で差し替えたりしない。

## 7. Cutover

1. A0 locked fixtureをproduction adapter port経由で受理する。
2. unavailable transportのWorker REDを追加し、effect 0／fallback 0を固定する。
3. Slack mapperと明示desired-effect mappingを追加する。
4. outer contextを7 surfaceへ伝播し、各境界のnegative testを追加する。
5. Brainbase live endpoint契約後にtransport bindingを追加する。
6. dual-readは比較だけに使い、company-authority opt-in operationの認可結果をlegacyへ委ねない。
7. tenant read-only canary、negative E2E、write、external side effectの順に進める。

rollbackはcompany-authority opt-in operationを拒否する。旧権限へ戻して業務を続行しない。

## 8. 初期テスト戦略

最初のRED:

```text
given: Worker ingressがcompany_authority_v1必須operationを受ける
and: CompanyAuthorityClientがunavailableを返す
when: operationを実行する
then: AUTHORITY_UNAVAILABLE
and: business callback = 0
and: legacy authorization fallback = 0
```

続いて、locked positive fixtureのrequest mapping／response acceptance、nested署名改竄、stale context、cross-tenant／connection、各decision、7 surface伝播を追加する。production endpointを必要とするtestは、endpoint確定前にfake successを作らず`not_collected`として別管理する。

## 9. Production evidence gate

以下はローカルadapter実装だけでは未達である。

- exact deploy version上の7 surface同一run receipt
- 2 tenant × 2 person × read／write／approval／deny
- unknown／ambiguous／inactive／cross-org／scope／stale／tamper／outageでeffect 0
- duplicate／redeliveryのmodel、write、external、Slack各exactly-once
- OperationReceipt、UsageEvent、authority receipt、external／Slack readbackのsame-correlation
- production trust key rotation／revocation
- production schema、bridge、secret、OAuth、PostgreSQL、deploy readback

これらは収集するまで`not_collected`とし、unit／fixture／typecheck／HTTP 200で代替しない。
