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

- [ ] AC-001: provider identityだけを観測する。MANAはSlack／Codex／Claude Code／serviceの認証済みexternal subjectを取得するが、それをcanonical person IDとして採用しない。
- [ ] AC-002: requested actionだけを送る。MANAはcapability、resource、desired effect、delivery、correlation IDをBrainbaseへ送る。canonical organization、project、owner、RACI、approver、authority decisionを送らない。
- [ ] AC-003: Brainbase contextを必須にする。会社データread／write、Personal KG、外部side effectは、署名済み`CanonicalExecutionContextV1`なしに実行できない。
- [ ] AC-004: 全runtime境界で再検証する。Worker、Queue、Durable Object、Container、MCP、Brainbase proxy、Slack deliveryでsignature、TTL、audience、deployment、tenant、connection、membership、resource、RACI、policy revisionを検証する。
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

AC-012のproduction E2Eは未収集である。将来の実行では、`.vibepro/spec/story-brainbase-owned-company-authority-consumer/production-e2e-plan.json`を正本test planとして使い、locked producer fixtureに存在するcanonical拒否code、利用者に見える拒否、side effect 0、同一correlation IDのReceipt/readback、未確認状態を収集する。再配送negative caseはrejected-first-deliveryだけを対象にし、original／redelivery／aggregate effectをすべて0に固定する。accepted-first-deliveryはこの8 negative caseの成功証拠に数えない。計画に記載した画面、Slack応答、CLI、log、Receiptは予定面であり、A0で実装済みとは扱わない。

## Release gate

本Story完了前に次を完了扱いにしない。

- TechKnight会社データcanary
- 梅田さん本番Personal KG
- MANA経営実行ループのRACI自律実行
- 組織版の上位互換完成
