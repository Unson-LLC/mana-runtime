# Brainbase-owned Company Authority Runtime Adapter

## 1. 目的

A0でsource lockしたBrainbase会社権限契約を、MANAの実runtimeへ安全に接続する。MANAは観測事実を送るconsumerであり、person、organization、project、RACI、approver、policy、authority decisionを生成しない。

## 2. 現在地

現行`createTenantRuntimeHttpClients`は旧`TenantContextIssueRequest`を`/api/v1/runtime/tenant-context:resolve`へ送り、runtime側でtenant、connection、expected revision、workspace／app、operation、project、authorizationを組み立てる。これはtenant safetyには使われているが、公開`ObservedExecutionRequestV1`とは非互換である。

A0の`acceptCompanyAuthorityResponse`はfixtureとローカルQueue consumerから呼ばれるが、live endpointはない。runtime環境変数からHTTPS endpoint、expected deployment ID、公開Ed25519 JWK、operationごとのdesired effect、既存audience、単一tenant verification keyをfail-closedで解釈するローカル設定境界は追加したが、本番値は設定していない。したがってadapterは、未定義のtransport・認証方式を埋め込まず、設定解釈、transport port、検証を分離する。

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

`requested_action.capability_id`と受理contextの`authority.capability_id`は業務operationを表す。nested TenantContextの`authorization.capability_ids`に含まれる`company_authority_v1`はprotocol markerであり、業務operationやrouting selectorではない。`handleTenantSlackRequest`は`opted_in_capability_ids`による明示selectorを持ち、選択時はCompany Authority専用の送信口を使って旧authorityへfallbackしない。実HTTP ingressはfail-closed parserからこのselectorを組み立てる。live transport／authenticationが未定義の間は、選択clientが`not_collected`を返して`AUTHORITY_UNAVAILABLE`で停止するため、Company Authority Queue、legacy Queue、旧authorityはいずれも呼ばれない。disabled設定は従来経路を維持し、partial設定はhandler前に拒否する。現行regression testはこの副作用0を固定するが、本番設定値、live解決、本番readbackは`not_collected`である。

Company Authority v1のrequestは単一`resource_ref`／`project_hint`だけを表すため、明示選択されたSlack placementの`projectCodes`が複数ならauthority retrieval前に`AUTHORITY_SCOPE_MISMATCH`で拒否する。先頭projectへ縮退しない。local routingの`RuntimePlacement.placementId`と署名contextのdeployment IDは別概念である。後者はtrusted runtime設定の`expected_deployment_id`とA0 consumerで照合し、local placement IDとは比較しない。

### 4.2 CompanyAuthorityClient port

```ts
type CompanyAuthorityResolution =
  | { state: "resolved"; response: unknown }
  | { state: "no_data" | "unknown" | "partial" | "not_collected" };

interface CompanyAuthorityClient {
  resolve(request: ObservedExecutionRequestV1): Promise<CompanyAuthorityResolution>;
}
```

`resolved.response`はtransport境界では`unknown`として受け、A0 source lockの`acceptCompanyAuthorityResponse`によるruntime validationを通過した値だけを採用する。schemaから導出したTypeScript型がまだ存在しないため、未検証値へ`CompanyAuthorityResolutionResponseV1`型を付けて安全性を装わない。`no_data | unknown | partial | not_collected`はconsumer retrieval stateであり、responseを捏造せず`AUTHORITY_UNAVAILABLE`へfail-closedする。最初はfixture transportとunavailable transportを注入して検証する。ローカル設定解釈は、会社権限固有の設定がすべてない場合だけ`disabled`とし、一部欠落、非HTTPS URL、credential・query・fragment付きURL、秘密鍵を含むJWK、曖昧なtenant JWKS、未知effectを`CONFIGURATION_INVALID`で拒否する。有効時は受理optionsとopt-in operationを実HTTP ingressへ渡すが、HTTP path、service binding、authentication、retry policyが未定義の間は`not_collected` clientを使い、Queue生成前に停止する。設定parserやportの存在は本番endpoint・trust値の存在証明ではない。transportがthrowした任意の内部codeは公開せず、adapter境界で`AUTHORITY_UNAVAILABLE`へ正規化する。producer canonical codeを維持するのは、transport成功後に受け取ったA0 responseを検証した結果だけである。

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

現時点のsurface別証拠は次のとおり。本表はローカル実装証拠と本番実証を分け、未接続を合格へ丸めない。

| surface | 状態 | source／test証拠 | 本番証拠 |
|---|---|---|---|
| Worker | ローカル実装・検証済み | `executeCompanyAuthorityWorkerIngress`; `company-authority-runtime-adapter.integration.test.ts` | `not_collected` |
| Queue | ローカル実装・検証済み | `consumeCompanyAuthorityQueueMessage`; `company-authority-queue.integration.test.ts`; `tenant-slack-runtime-wiring.test.ts` | `not_collected` |
| Durable Object | ローカル実装・検証済み | `createDurableExternalEffectOutboxClient`; `createDurableCompanyAuthorityHumanHandoffClient`; 各専用test | `not_collected` |
| Container | 注入型selected operationからtenant-bound Durable registry登録までローカル接続・検証済み。production route未登録 | `createCompanyAuthoritySelectedContainerProviderRoute`; `executeTenantContainerOperation`; `company-authority-queue-runtime.test.ts`; `durable-tenant-boundary.integration.test.ts` | `not_collected` |
| MCP | selected operationのopaque handleを介した境界選択・再検証をローカル検証済み。実MCP呼び出し未接続 | `TenantBoundaryContextHandler`の`mcp_gateway`再検証; `sandbox-runtime-boundaries.test.ts`; `durable-tenant-boundary.integration.test.ts` | `not_collected` |
| Brainbase proxy | selected operationのopaque handleを介した境界選択・再検証をローカル検証済み。実Brainbase proxy呼び出し未接続 | `TenantBoundaryContextHandler`の`brainbase_proxy`再検証; `sandbox-runtime-boundaries.test.ts`; `durable-tenant-boundary.integration.test.ts` | `not_collected` |
| Slack delivery | exact `send_message`だけを選ぶ境界判定と再検証をローカル検証済み。実Slack送信未接続 | `resolveRuntimeGatewayBoundaries`; `sandbox-runtime-boundaries.test.ts`; `durable-tenant-boundary.integration.test.ts` | `not_collected` |

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
4. outer contextをQueue以降の6 surfaceへ伝播する共通opaque-handle primitiveをローカル実装し、Workerのpositive routingを含む各境界のnegative testを追加する。Queueは、envelopeをlegacy fallbackとしてACKしないfail-closed入口guard、outer／nested受理、payload binding、受理済みimmutable snapshotからのruntime依存解決、decision不変、redelivery重複抑止を担うconsumerを実`worker.queue`分岐へ接続済みとする。tenant verifierとownership storeは署名受理とpayload照合より前に選択しない。Slack ingressはJCS正規化した全`SlackQueueEvent`のSHA-256を署名対象の`requested_action.resource_ref`へ含め、Queueで完全一致を再検証する。これによりevent IDだけを維持した本文・時刻・種別・files・thread／attachment context差替えも作用前に拒否する。受理済みsnapshotは注入型selected operation routeからscope再束縛、Container実行、tenant-bound Durable registry登録へ接続済みである。opaque handle内のouter／nested／payloadは`container_launch`、`mcp_gateway`、`brainbase_proxy`、`slack_delivery`で再検証し、exact `send_message`だけが`slack_delivery`を追加する。`approval / human_action`は`require_auto` guardでstorage／effect前に拒否する。`auto`はexact capabilityの明示provider registryへだけ接続し、受理済みauthorityのcapabilityとallowed effectを実行直前に再照合する。production registryは空である。外部作用はtenant-bound durable-state outboxへprovider call前に`pending`を保存し、原子的なclaimを得た1処理だけがproviderを呼ぶ。成功、恒久拒否、`unknown_requires_reconcile`を分離し、期限切れ`in_flight`を自動再取得せず、元のclaim tokenなしに状態遷移できない。`approval / human_action`は、受理済みrequest/context/payload、確定済みexecution hash、署名済みapproverまたはresponsibleをtenant-bound Durable Objectへ`pending_approval / pending_human_action`として原子的に保存する。同一再配送は同じpending recordを再利用してACKし、対象差替え、cross-scope、同じidempotency keyでの内容競合は拒否する。通知、判断、完了、protected effectはこのsliceでは実行しない。runtime環境変数をfail-closedで解釈し、公開鍵と明示operation mappingだけから受理optionsを導出する。disabled・partial設定はclaim前にretryする。production設定値、live HTTP client／認証、production auto provider／reconciler、本番trust値、通知・承認完了、本番外部readbackは未定義・未設定または`not_collected`であり、production Queue成功と本番exactly-onceは`not_collected`を維持する。
5. Brainbase live endpoint契約後にtransport bindingを追加する。
6. `handleTenantSlackRequest`へ明示的なruntime routing selectorを追加し、現行regression testで選択時のno-fallbackとmarker単独非選択を固定する。nested TenantContextの`company_authority_v1` markerだけでopt-in判定しない。（同一runのpre-fix REDは一時観測。ローカル実装・negative test完了。本番設定は0件）
7. dual-readは比較だけに使い、company-authority opt-in operationの認可結果をlegacyへ委ねない。
8. tenant read-only canary、negative E2E、write、external side effectの順に進める。

rollbackはcompany-authority opt-in operationを拒否する。旧権限へ戻して業務を続行しない。

選択されたoperationのpositive fixtureを実HTTP handlerから専用送信口まで通す証拠はまだ`not_collected`である。注入型Queue providerからContainerのDurable登録、opaque handleを使う4境界の再検証、`approval`／`human_action`のstorage／effect前拒否はローカル検証済みだが、credential-backed production provider接続、production Queue、実MCP／Brainbase／Slack呼び出し、通知、owner-visibleな判断、完了、downstream effect、readbackは`not_collected`であり、局所テストから本番成功を推定しない。

## 8. 初期テスト戦略

最初のRED:

```text
given: Worker ingressが明示的なruntime routing selectorでCompany Authority必須と判定したoperationを受ける
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
