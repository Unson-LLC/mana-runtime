---
story_id: story-personal-organization-core-compatibility
title: "個人版OSSと組織版の共通Core互換性を固定する"
status: active
source:
  type: product-direction
  id: story-personal-organization-core-compatibility
architecture_reason: "組織版を個人版の別実装にせず、同じDecision→Work→Ship→Learn契約へ組織能力を追加することで、能力上の上位互換と個人データ境界を同時に保証する。"
architecture_docs:
  - docs/architecture/10_company_brain.md
  - docs/architecture/11_persona_skills_memory.md
spec_docs: []
related_tasks:
  - docs/plans/2026-08-19-organization-edition-and-multitenant-rollout.md
---

# 個人版OSSと組織版の共通Core互換性を固定する

## Background

mana-runtimeは個人版OSSと組織版の切り分けを進めている。組織版は、個人版の全能力に組織Graph、組織目標、RACI、共有Task・Ship、承認、監査、複数人への働きかけを追加した能力上の上位互換でなければならない。

一方、組織版の管理者権限を個人データの閲覧権へ読み替えると、Personal KGの所有権と組織知識の境界が崩れる。組織版は個人版より多くの能力を持つが、個人の私的知識を当然に読める製品にはしない。

個人版と組織版を別Coreへ分岐させず、共通契約、明示的なExecution Context、capability追加で実現する。

## Policy

製品能力と配備形態を分離する。

```text
product capability:
  personal | organization

deployment profile:
  customer_managed_oss | dedicated_cloud | shared_cloud
```

個人版と組織版は、次のCore契約を共有する。

- Decision → Work → Ship → Learn
- Task・Ship・Receipt
- connector interface
- memory / Personal KG interface
- authority / policy interface
- failure vocabulary
- idempotency
- evidence-backed completion

すべての実行は、少なくとも次を明示的に持つ。

```text
tenant_id
organization_id
actor_person_id
owner_person_id
workspace_connection_id
connection_revision
project_codes
placement_id
correlation_id
policy_revision
```

Slack本文、LLM出力、自由入力のCLI引数から本人・組織・tenantを採用しない。未解決、不一致、複数一致、古いrevisionはfail closedとし、佐藤さん、雲孫、TechKnight、default tenant、default placementへ暗黙fallbackしない。

## Acceptance Criteria

- [ ] AC-1: 組織版のCIで、個人版OSSの主要な会話、Personal KG、Task、Ship、Receipt契約テストを同一fixtureのまま実行し、すべて通る。
- [ ] AC-2: organization capabilityを無効にした組織版runtimeは、個人版OSSと同じ入力に対して同じ業務効果、failure vocabulary、Receiptを返す。
- [ ] AC-3: 組織版でも個人モードを利用でき、本人のPersonal KG本文は本人の認証済みscopeだけで検索・更新できる。
- [ ] AC-4: 組織管理者にはPersonal KG本文を開示せず、同期状態、件数、エラー、監査結果だけを表示する。
- [ ] AC-5: actor、owner、organization、tenant、project、placementを別フィールドとして保持し、全入口と書き込み境界で検証する。
- [ ] AC-6: owner、organization、tenant、workspace connection、placementが未解決または不一致のとき、モデル、MCP、外部toolを呼ばずに停止する。
- [ ] AC-7: `customer_managed_oss`、`dedicated_cloud`、`shared_cloud`を明示し、同じcapability名に暗黙の権限差を作らない。
- [ ] AC-8: 顧客名、人物名、workspace IDを条件分岐としてruntime coreへ追加せず、Graph、policy、adapter、configurationから解決する。
- [ ] AC-9: Personal KGから組織Graphへ共有する場合は、本人同意と組織採用を分離し、Personal本文ではなく正規化済み事実・判断・関係と根拠ポインタだけを昇格する。
- [ ] AC-10: 個人版または組織版の一方だけで成立する変更は、互換差分と移行方針をStory・Specへ明記しない限りmainへ統合しない。

## Scenarios

- `ORGCORE-S-001`: Given organization capabilityを無効にしたruntimeで、個人版fixtureを実行すると、個人版OSSと同じ業務効果とReceiptを返す。
- `ORGCORE-S-002`: Given 組織版の本人が個人モードを使うと、本人のPersonal KGだけを参照し、組織管理者や同僚へ本文を開示しない。
- `ORGCORE-S-003`: Given owner未指定またはowner詐称があると、既定人物へ寄せず、モデル実行前に拒否する。
- `ORGCORE-S-004`: Given tenantまたはorganizationが不一致のExecution Contextを受けると、外部toolを呼ばず、監査可能なfailureを返す。
- `ORGCORE-S-005`: Given 組織固有の要件があると、runtime coreの人物名分岐ではなく、Graph・policy・adapter・configurationで表現する。
- `ORGCORE-S-006`: Given 本人が組織共有へ同意しても、組織reviewerが採用するまではGraph SSOTへ確定しない。

## Completion Evidence

- 個人版OSSと組織版の契約テスト結果
- Execution Contextのpositive / negative fixture
- owner、organization、tenant未解決時のモデル非呼出証跡
- Personal KG相互非漏洩E2E
- capabilityとdeployment profileの設定readback
- Personal→Organization二段階昇格Receipt

## Out of Scope

- 課金・請求・reseller管理
- tenantセルフ申込UI
- 組織管理者によるPersonal KG本文の一括閲覧
- 個人版OSSと組織版の別Core化
- 顧客固有ロジックをruntime coreへ直接追加すること
