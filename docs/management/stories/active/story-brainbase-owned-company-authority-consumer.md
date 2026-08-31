---
story_id: story-brainbase-owned-company-authority-consumer
title: "MANAがBrainbase署名済み会社権限だけを実行する"
status: active
source:
  type: product-direction
  id: company-authority-first-2026-08-19
architecture_reason: "MANAがcanonical actor、organization、project、RACI、approverを自己生成せず、Brainbaseが正本解決したauthorityだけを全runtime境界で実行する。"
architecture_docs:
  - docs/architecture/13_brainbase_owned_company_authority.md
  - docs/architecture/10_company_brain.md
  - docs/architecture/04_auth_permission.md
spec_docs:
  - .vibepro/spec/story-brainbase-owned-company-authority-consumer/spec.json
related_tasks:
  - docs/management/milestones/M0-brainbase-owned-company-authority.md
---

# MANAがBrainbase署名済み会社権限だけを実行する

## Background

MANAのtenant runtimeは、tenant、workspace connection、credential、Queue、Container、Usage、Receiptの安全境界を持つ。一方、会社の実務に必要なcanonical person、membership、organization、project、RACI、policy、Personal ownerをMANA側で補完すると、Brainbaseが会社の脳ではなくなる。

本Storyでは、MANAをauthority consumerへ限定する。

## User outcome

利用者は自分の権限や担当を毎回説明しなくても、Brainbase上の本人・所属・責任に沿ってMANAを使える。

MANAは権限内の仕事を自動実行し、人間判断が必要ならBrainbaseが指定した相手へ、推奨・期限・影響付きの判断packetを送る。

## Acceptance criteria

- [ ] AC-001: provider identityだけを観測する。現行`ObservedExecutionRequestV1`はSlackの認証済みexternal subjectだけを取得し、それをcanonical person IDとして採用しない。A0のverified範囲はlocked Slack fixture conformanceに限定する。Codex／Claude Code／serviceはprovider固有nested envelopeが契約化されるまで`future / not_implemented`であり、AC-001の成功証拠に含めない。
- [ ] AC-002: requested actionだけを送る。MANAはcapability、resource、desired effect、delivery、correlation IDをBrainbaseへ送る。canonical organization、project、owner、RACI、approver、authority decisionを送らない。
- [ ] AC-003: fixture consumer契約でBrainbase contextを必須にする。A0のconformance helperは署名済み`CanonicalExecutionContextV1`の検証・伝播だけを受理し、欠落・未確定contextをfail-closedで拒否する。このfixture検証は会社データread／write、Personal KG、外部side effectの実runtime接続証拠ではない。
- [ ] AC-004: 全runtime境界で再検証する。Worker、Queue、Durable Object、Container、MCP、Brainbase proxy、Slack deliveryへconsumerを接続し、signature、TTL、audience、deployment、tenant、connection、membership、resource、RACI、policy revisionを各境界で検証する。A0ではこれら7 surfaceの接続・実行証拠は`not_collected`であり、T0 runtime adapter後までunverifiedとする。
- [ ] AC-005: authority decisionに従う。`auto / approval / human_action / deny`をBrainbaseの結果どおりに扱い、モデルやruntimeがdecisionを昇格・変更しない。
- [ ] AC-006: approverを変更しない。`approval`ではBrainbase指定approverだけを受理する。別person、同名user、別workspaceの回答を拒否する。
- [ ] AC-007: no-fallbackを保証する。Brainbase unavailable、unknown person、ambiguous person、scope不一致、stale revision時にdefault tenant、default placement、default person、default project、運営者credentialへfallbackしない。
- [ ] AC-008: workspace hintをauthorityにしない。runtime hintは非権威cacheとしてだけ利用し、Brainbase authoritative readback不一致時に破棄する。hintだけでLLM／Graph／Task／credentialへ到達しない。
- [ ] AC-009: Personal ownerを上書きしない。Personal KGのownerはBrainbase contextから取得し、CLI引数、request body、環境変数、channel設定で変更しない。
- [ ] AC-010: Queue再配送を冪等に処理する。同一authority contextとidempotency keyで、model、Brainbase write、external side effect、Slack deliveryを各1回にする。
- [ ] AC-011: evidence-backed completionを行う。実行後、external readback、UsageEvent、OperationReceipt、identity／authority resolution receiptを同一correlation IDへ関連付ける。証拠なしを完了にしない。
- [ ] AC-012: 2 tenant × 2 personのnegative E2Eを通す。Tenant A／B、佐藤／梅田を使い、tenant越境、Personal越境、unknown／ambiguous person、stale RACI／policy、誤承認者、再配送をfresh E2Eで拒否する。
- [ ] AC-013: authority欠落時のoperationを限定する。`company_authority_v1`がない場合、health、protocol negotiation、provisioning、connection診断、tenant isolation testだけを許可する。

## Dependencies

- Brainbase `ADR-023`
- Brainbase `story-canonical-company-authority-context`
- canonical cross-repo fixture
- existing mana-brainbase tenant context v1

## A0 contract boundary

A0 company-authority contractはcredential lease固有fixture／negative caseを持たない。credential leaseのfail-closed検証は既存`mana-brainbase-tenant-context/v1`の責務であり、A0 company-authority contractのAcceptance Criteria外とする。

`assertCanonicalAuthorityRetrieval`はauthority retrievalの`no_data / unknown / partial / not_collected`を`AUTHORITY_UNAVAILABLE`へ落とすfixture conformance helperである。Worker／Queue／Durable Object／Container／MCP／Brainbase proxy／Slack deliveryへの接続証拠ではなく、AC-004のruntime integrationをverifiedへ昇格させない。

AC-010のduplicate delivery、各effect 1回、Receipt／correlation／idempotency identity同一性と、AC-011のOperationReceipt／UsageEvent／external readback／authority receiptの同一correlation結合は、T0 runtime adapter未実装のため未収集である。A0のfixture/mockはkey形式とreceipt参照を検証するだけで、この実行証拠やproduction proofへ昇格させない。両ACのexit conditionは`production-e2e-plan.json`に固定する。

AC-012のproduction E2Eは未収集である。将来の実行では、`.vibepro/spec/story-brainbase-owned-company-authority-consumer/production-e2e-plan.json`を正本test planとして使い、locked producer fixtureに存在するcanonical拒否code、利用者に見える拒否、side effect 0、同一correlation IDのReceipt/readback、未確認状態を収集する。再配送negative caseはrejected-first-deliveryだけを対象にし、original／redelivery／aggregate effectをすべて0に固定する。accepted-first-deliveryはこの8 negative caseの成功証拠に数えない。計画に記載した画面、Slack応答、CLI、log、Receiptは予定面であり、A0で実装済みとは扱わない。

## Release gate

本Story完了前に次を完了扱いにしない。

- TechKnight会社データcanary
- 梅田さん本番Personal KG
- MANA経営実行ループのRACI自律実行
- 組織版の上位互換完成
