---
story_id: story-brainbase-owned-company-authority-runtime-adapter-v1
title: "MANAの実行境界をBrainbase署名済み会社権限へ接続する"
status: active
source:
  type: program-work-package
  id: T0
architecture_reason: "A0で固定した会社権限consumer契約を、既存TenantContext境界を壊さず7つのruntime surfaceへfail-closedで接続する。"
architecture_docs:
  - docs/architecture/story-brainbase-owned-company-authority-runtime-adapter-v1.md
  - docs/architecture/13_brainbase_owned_company_authority.md
spec_docs:
  - .vibepro/spec/story-brainbase-owned-company-authority-runtime-adapter-v1/draft.json
related_stories:
  - story-brainbase-owned-company-authority-consumer
  - story-mana-multitenant-runtime
---

# MANAの実行境界をBrainbase署名済み会社権限へ接続する

## 背景

A0は、Brainbase producerのexact source lock、`ObservedExecutionRequestV1`、署名済み`CanonicalExecutionContextV1`、fixture consumerのfail-closed受理境界を固定した。しかし現行runtimeは、Slack入力から旧`TenantContextIssueRequest`を組み立て、`/api/v1/runtime/tenant-context:resolve`へ送っている。A0 consumerはproduction call siteへ未接続で、Worker、Queue、Durable Object、Container、MCP、Brainbase proxy、Slack deliveryの実行証拠は`not_collected`である。

このStoryはT0の最小実装sliceとして、会社権限resolutionを注入可能なadapter portへ分離し、旧認可へ戻らないfail-closed境界を先に成立させる。Brainbase側のlive endpoint、production trust store、鍵rotation／revocation、本番デプロイは別の実証段階とし、未収集を成功へ丸めない。

## 利用者の成果

利用者のSlack操作は、Brainbaseが本人・所属・対象resource・RACI・policyを解決して署名した権限が受理された場合だけ実行される。Brainbaseへ到達できない、本人やscopeを確定できない、署名が不正、contextが古い場合は、モデル・書き込み・外部作用・Slack配送の前に安全に停止する。

## Acceptance criteria

- [ ] AC-001: 認証済みSlack ingressだけから`ObservedExecutionRequestV1`を作る。canonical person、organization、project、RACI、approver、policy revision、tenant、connection、credentialをrequestへ自己申告しない。
- [ ] AC-002: `desired_effect`はcapabilityごとの明示mappingから決める。未知capabilityを`read`へ既定化せず、authority取得前に安定した拒否codeで止める。
- [ ] AC-003: `CompanyAuthorityClient`をadapter portとして注入し、transport endpoint未定義でもfixture transportと取得不能を同じproduction adapter境界で検証できる。live endpointの存在を仮定しない。
- [ ] AC-004: responseはA0 exact source lockの`acceptCompanyAuthorityResponse`で外側・nested署名、audience、deployment、TTL、tenant、connection、membership、resource、RACI、policyを検証する。MANA独自の権限判定を足さない。
- [ ] AC-005: authority取得が`no_data / unknown / partial / not_collected / unavailable`、またはresponseが不正な場合、`AUTHORITY_UNAVAILABLE`またはproducer由来の安定codeで停止し、business callbackとlegacy authorization fallbackを各0回にする。
- [ ] AC-006: 受理した`CanonicalExecutionContextV1`をWorker、Queue、Durable Object、Container、MCP、Brainbase proxy、Slack deliveryへ変更せず伝播し、各境界で再検証する。既存`TenantContextEnvelope`検証は置換せず内側のtenant safetyとして維持する。
- [ ] AC-007: `auto / approval / human_action / deny`を変更しない。`deny`は全business effect前に拒否し、`approval`と`human_action`を`auto`として実行しない。
- [ ] AC-008: `company_authority_v1`へopt-inしたoperationは、Brainbase unavailable、schema rejection、dual-read不一致、stale context時に旧`authorization.data_scopes`へfallbackしない。
- [ ] AC-009: 現行v1はSlack providerだけを受理する。service、Codex、Claude CodeをSlackへ偽装せず、provider固有契約ができるまで`not_implemented`で拒否する。
- [ ] AC-010: 最初のRED testは、authority endpoint取得不能時のWorker ingressで`AUTHORITY_UNAVAILABLE`、business callback 0、legacy fallback 0を観測する。live endpointやsecretを必要としない。
- [ ] AC-011: duplicate／redeliveryでは、model、Brainbase write、external side effect、Slack deliveryを各1回以下にし、OperationReceipt、UsageEvent、authority receipt、readbackを同一correlation IDへ結ぶ。
- [ ] AC-012: 本番完了判定には、2 tenant × 2 person、7 runtime surface、read／write／approval／deny、negative effect 0、exactly-once、same-correlation、鍵rotation／revocation、exact deploy readbackの同一run証拠を要求する。

## 依存関係

- Program T0のhard dependencyであるR0
- A0 exact producer／consumer source lock（元HEAD `167116c8b4aa92a9d2a50b70c8222f0336ffd792`、最新mainへのpatch-equivalent取込）
- `story-mana-multitenant-runtime`の既存TenantContextと7 surface境界
- Brainbase側company-authority live endpoint契約（現時点`not_defined`）
- production trust storeとkey rotation／revocation運用（現時点`not_implemented`）

## 実装境界

最初の実装対象:

- Slack observationから公開requestへの純粋mapping
- 明示的なdesired-effect mappingと未知capability拒否
- transportを注入する`CompanyAuthorityClient` port
- A0 reference consumerを使うresponse acceptance
- Worker入口の取得不能fail-closed test
- 7 surfaceへ外側company authorityを伝播するための型と検証境界

このStoryだけでは完了にしない対象:

- Brainbase live endpointのURL／service binding確定
- production JWK配布、rotation、revocation
- production DB schema、bridge、secret、OAuth、deploy変更
- 本番2×2、7 surface同一run、negative E2E、exactly-once、same-correlation readback
- service、Codex、Claude Code provider対応

## Evidence ceiling

ローカルfixture・unit・integration testが成功しても、証明できるのはadapterの入力変換、fail-closed、署名受理、境界伝播だけである。live Brainbase resolution、production trust、production runtime、外部作用readbackは`not_collected`を維持する。`acceptance-e2e-runtime-flow-not-collected`は、同一runの本番証跡を収集するまでcloseしない。
