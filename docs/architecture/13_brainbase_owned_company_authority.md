# 13. Brainbase-owned Company Authority

## 1. 目的

MANAを、会社権限を推測・作成するruntimeではなく、Brainbaseが正本解決した署名済み権限を実行するruntimeへ限定する。

既存のマルチテナント基盤は、tenant、workspace connection、revision、credential、Usage、Operation Receipt、Queue／Containerの分離を担う。この文書は、その上に次を追加する。

- canonical person
- active membership
- organization、project、resource ownership
- RACI、delegation、policy
- Personal KG owner
- `auto / approval / human_action / deny`

## 2. 現在の設計ずれ

現在の経路には、MANA側がSlack requesterからactorを組み立て、required project／capabilityからauthorizationを組み立て、Brainbaseがtenant・connection・contractを確認して署名する形が残る。

この形は、次を保証する。

- tenant contextが転送中に改ざんされていない
- workspace connectionとrevisionが有効である
- credentialとUsage／Receiptがtenantへ帰属する

一方、次は保証しない。

- Slack requesterがGraph上のどのcanonical personか
- そのpersonが対象organization／projectのactive memberか
- 対象resourceへどのRACIで関与するか
- 自動実行・承認・本人行動・拒否のどれか
- Personal KG ownerが誰か

MANAが組み立てた不完全な権限へBrainbaseが署名する構造を廃止する。

## 3. 責務境界

### Brainbase

Brainbaseは次の正本ownerである。

- external subject → canonical person mapping
- membership、organization、project、resource ownership
- RACI、delegation、policy、stop condition
- Personal KG owner
- authority decision
- authority resolution receipt
- 署名済みCanonical Execution Context

### MANA

MANAは次だけを行う。

- provider署名を検証する
- 観測したexternal subjectとrequested actionをBrainbaseへ送る
- 署名済みCanonical Execution Contextを検証する
- contextの範囲内で実行する
- 必要な人間へ判断packetまたは行動依頼を送る
- 結果、readback、Usage、Operation ReceiptをBrainbaseへ返す

MANAはperson、owner、organization、project、RACI、approver、policy、placementを補完・推測・上書きしない。

## 4. 入力契約

MANAからBrainbaseへ送るものは、観測事実と要求に限定する。

```ts
interface ObservedExecutionRequestV1 {
  provider_identity: {
    provider: "slack" | "codex" | "claude_code" | "service";
    authenticated_subject_id: string;
    app_id?: string;
    workspace_id?: string;
    enterprise_id?: string;
  };
  requested_action: {
    capability_id: string;
    resource_ref: string;
    project_hint?: string;
    desired_effect: "read" | "write" | "external_side_effect";
  };
  delivery?: {
    event_id?: string;
    channel_id?: string;
    thread_ts?: string;
  };
  correlation_id: string;
}
```

禁止する入力:

- canonical person IDの自己申告
- organization／project／ownerの認可用指定
- Responsible／Accountable／Approverの指定
- `auto`その他のauthority decision指定
- policy／RACI revisionのruntime指定
- credential本文

`project_hint`は候補を狭めるhintであり、Brainbaseの解決結果と一致しなければ拒否する。

## 5. 出力契約

Brainbaseは既存TenantContextを包含する署名済みcontextを返す。

```ts
interface CanonicalExecutionContextV1 {
  schema_version: "1.0";
  tenant_context: TenantContextEnvelopeV1;
  actor: {
    external_subject_id: string;
    canonical_person_id: string;
    membership_id: string;
    membership_revision: string;
  };
  scope: {
    organization_id: string;
    project_id: string;
    resource_ref: string;
    owner_person_id: string | null;
    placement_id: string;
  };
  authority: {
    decision: "auto" | "approval" | "human_action" | "deny";
    capability_id: string;
    responsible_person_id: string | null;
    accountable_person_id: string | null;
    approver_person_id: string | null;
    delegated_by_person_id: string | null;
    policy_revision: string;
    raci_revision: string;
    resource_revision: string;
    allowed_effects: Array<"read" | "write" | "external_side_effect">;
    stop_conditions: string[];
  };
  evidence: {
    identity_resolution_receipt_id: string;
    authority_resolution_receipt_id: string;
  };
  issued_at: string;
  expires_at: string;
  integrity: SignedIntegrity;
}
```

既存TenantContextのactor／authorizationも、移行後はBrainbase解決値から作る。MANAの入力値をコピーしない。

## 6. 実行フロー

```text
Slack／Codex／Claude Code／service event
  → provider identityを検証
  → ObservedExecutionRequestを作る
  → Brainbaseへcompany authority resolution
  → signed CanonicalExecutionContextを受け取る
  → Worker ingressで検証
  → Queueへcontextを伝播
  → Queue／DO／Container／MCP／Brainbase proxyで再検証
  → authority decisionを実行
  → external readback
  → Usage／Operation Receipt／authority receiptを相関
```

Brainbaseが到達不能、identityが未解決、contextが古い場合は、モデル実行前に止める。

## 7. authority decisionの動作

### `auto`

- allowed effectとcapabilityの範囲内だけ実行
- 外部side effectはreadbackを必須とする
- 実行前後のrevision差分をReceiptへ残す

### `approval`

Brainbaseが返した`approver_person_id`へ判断packetを送る。

必須項目:

- 必要な判断
- 推奨案
- 根拠と帰結
- 期限
- 未回答時の事業影響
- correlation ID

指定approver以外の回答は採用しない。

### `human_action`

`responsible_person_id`またはBrainbaseが指定したpersonへ、人間本人の行為を要求する。通知しただけで完了にせず、期限、再確認、代替案、RACIエスカレーションを追跡する。

### `deny`

- tool、LLM、credential lease、Graph／Task read、外部side effectを実行しない
- 公開応答へ内部RACI・credential・tenant情報を漏らさない
- safe failure codeとauthority receiptだけを記録する

## 8. workspace connection hint

MANA側のworkspace connection一覧は、移行中の非権威routing cacheとする。

- Brainbase authoritative readbackより優先しない
- revision、expiry、source digestを持つ
- 0件または複数一致でfail closed
- stale時は破棄し、default tenantへ寄せない
- hintだけでLLM／Graph／Task／credentialへ到達しない

最終状態では、provider、app、workspace、enterpriseからBrainbaseがcanonical connectionを解決する。

## 9. Personal KG境界

Personal KG operationでは、contextの`owner_person_id`が必須である。

- ownerはBrainbaseが認証済みpersonまたはdelegationから解決する
- ownerなしは拒否
- request body、CLI引数、環境変数で別人を指定できない
- organization adminへPersonal本文を返さない
- service proxyはdelegation receiptとreasonを必須にする

MANAはPersonal KG本文を組織Graphへ転送しない。組織共有はBrainbaseの二段階review stateを進めるだけである。

## 10. 互換移行

既存`mana-brainbase-tenant-context` v1はtenant safety用として残す。

`company_authority_v1`がない間、許可するoperation:

- health
- protocol negotiation
- tenant／workspace connection provisioning
- connection revision診断
- credential本文を扱わないreadiness診断
- tenant isolation negative test

拒否するoperation:

- organization Graph／Canonical Taskのbusiness read／write
- Personal KG read／write
- organization knowledge promotion
- external side effect
- RACIに基づく承認・エスカレーション

移行順:

1. Brainbase schema／resolver／fixture
2. mana-runtime consumer／validator
3. dual-read診断
4. `company_authority_v1`をread-onlyで必須化
5. staging negative E2E
6. tenant単位でwrite有効化
7.旧runtime actor／authorization constructionを削除

## 11. Verification matrix

| Case | 期待結果 |
|---|---|
| unknown external subject | モデル前に拒否 |
| ambiguous person | モデル前に拒否 |
| inactive membership | 拒否 |
| scope外project | 拒否 |
| cross-organization resource | 拒否 |
| stale RACI／policy | 拒否 |
| approvalを別personが回答 | 拒否 |
| ownerなしPersonal KG | 拒否 |
| 佐藤→梅田Personal KG | 存在非開示で拒否 |
| Tenant A→B | 全state／credential／Receiptを拒否 |
| Queue再配送 | model／write／delivery各1回 |
| Brainbase unavailable | retryable fail closed、fallbackなし |
| 正常auto | external readbackとReceipt |
| 正常approval | 指定approver後だけ続行 |

## 12. 完了条件

- MANAがcanonical actor／authorizationを自己生成しない
- Brainbase署名contextが全境界で検証される
- identity、membership、RACI、policy、resource revisionがReceiptと相関する
- 2 tenant × 2 personのfresh E2Eが通る
- Personal owner fallbackが0件
- authority欠落時に会社データoperationが0件
- `not_collected`を成功へ丸めない
