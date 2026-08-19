# M0: Brainbase-owned Company Authority

- **状態**: active
- **開始日**: 2026-08-19
- **対象**: mana-runtime、Brainbase、個人版OSS、組織版、TechKnight shared-cloud
- **MANA設計**: [`13_brainbase_owned_company_authority.md`](../../architecture/13_brainbase_owned_company_authority.md)
- **Brainbase設計**: `Unson-LLC/brainbase-unson`の`ADR-023-brainbase-owned-company-authority.md`

## 1. Milestone correction

これまでの計画は、tenant context、credential、Queue、Container、Usage／Receiptの安全境界を先に構築した点では正しい。一方、会社データを扱うruntimeとして必要なcanonical person、membership、RACI、policyの解決を、組織版CLI・オンボーディング・本番canaryより前の明示的なGateにしていなかった。

この順序を修正する。

```text
M0  Brainbase-owned Company Authority
M1  Personal Identity / no-fallback / two-stage promotion
M2  Umeda Organization E2E
M3  TechKnight Shared-cloud Production E2E
M4  Management Execution Loop
M5  OSS / Organization Superset completion
```

インフラprovisioningとtenant isolation試験はM0と並行できる。ただし、会社データのread／write、Personal KG、外部side effectはM0を通過するまで開放しない。

## 2. M0 objective

MANAが会社権限を推測せず、Brainbaseが次を正本解決して署名する状態を作る。

- external subject → canonical person
- active membership → organization
- project membershipとresource ownership
- RACI、delegation、policy、stop condition
- Personal KG owner
- `auto / approval / human_action / deny`

MANAは署名済みcontextのconsumerとして、権限内の実行、承認依頼、人間行動依頼、拒否、readback、Receiptを担う。

## 3. Work packages

### M0-1. Cross-repo contract

- `ObservedExecutionRequestV1`を固定
- `CanonicalExecutionContextV1`を固定
- `company_authority_v1` required capabilityを追加
- Brainbase producerとMANA consumerで同じfixtureを使用
- source-lock、protocol negotiation、互換期間を定義

合格条件:

- actor／authorizationのruntime自己申告fixtureが拒否される
- unknown／ambiguous／stale／cross-scope fixtureが揃う
- positive、negative、non-applicableの意味が両repoで一致する

### M0-2. MANA ingress simplification

- Slack／Codex／Claude Code／service identityの観測値だけを取得
- MANA側のcanonical actor生成を削除
- MANA側のorganization／project／owner／RACI補完を削除
- requested action、resource、desired effectだけをBrainbaseへ渡す

合格条件:

- MANA単独ではcompany authorityを発行できない
- Brainbase unavailable時にmodel、tool、credential leaseへ到達しない
- default tenant／placement／person／projectへのfallbackが0件

### M0-3. Boundary propagation

- Worker ingress
- Queue consumer
- Durable Object
- Container launch
- MCP gateway
- Brainbase proxy
- Slack delivery
- Usage／Operation Receipt

各境界で次を再検証する。

- signature
- issuer／audience
- TTL
- deployment
- tenant／connection revision
- membership revision
- resource revision
- RACI／policy revision
- capability／allowed effect

合格条件:

- contextの一部欠落や古いrevisionで処理が止まる
- retry時も同じauthorityとidempotency ownershipを維持
- newer claimをold workerが上書きしない

### M0-4. Authority decision execution

- `auto`: allowed effect内で実行し、readbackまで進める
- `approval`: Brainbase指定approverへ判断packetを送る
- `human_action`: Brainbase指定personへ行動依頼を送り追跡する
- `deny`: LLM／tool／Graph／Task／credential／external effectを実行しない

合格条件:

- モデルの自信度で権限を変更しない
- 指定approver以外の承認を拒否
- authority decisionと実行結果を同一Receiptへ関連付ける

### M0-5. Workspace hint de-authoritization

- runtime hintを非権威cacheへ降格
- revision、expiry、source digestを保持
- Brainbase readback不一致時に破棄
- hint単独で業務処理を開始しない

合格条件:

- 0件／複数一致／staleでfail closed
- default workspace／tenantへfallbackしない
- Brainbase authoritative connectionだけがcredentialとdeliveryへ到達する

### M0-6. 2 tenant × 2 person E2E

最低構成:

```text
Tenant A / Tenant B
佐藤さん / 梅田さん
Slack / CodexまたはClaude Code
read / write / approval / deny
```

必須証拠:

1. 正常auto実行とexternal readback
2. 正常approvalと指定approver
3. Tenant A→B、B→A越境拒否
4. 佐藤→梅田、梅田→佐藤Personal KG拒否
5. unknown／ambiguous person拒否
6. inactive membership拒否
7. scope外project／resource拒否
8. stale connection／RACI／policy拒否
9. Queue再配送でmodel／write／delivery各1回
10. authority receipt、Usage、Operation ReceiptのBrainbase readback

## 4. M1 objective

M0のcompany authorityをPersonal KGへ適用する。

- default ownerを削除
- ownerは認証済みpersonまたはdelegationから導出
- Personal本文を本人だけが利用
- owner personal approval、owner org consent、organization reviewを分離
- Graphへ正規化済みknowledgeとevidence pointerだけを昇格

M1完了前に梅田さんへ本番Personal KGを付与しない。

## 5. M2 objective: Umeda

梅田さん本人JWTで次を同一runに閉じる。

```text
会話
  → Personal candidate
  → 本人編集・承認
  → 次の会話で再利用
  → 組織共有同意
  → 組織reviewer採用
  → 雲孫バックオフィスの実務Ship
  → readback
  → useful / not_useful
```

## 6. M3 objective: TechKnight

TechKnight実運用で少なくとも2実tenantを使い、Safety GateとValue Gateを両方通す。

Safety:

- tenant、credential、session、file、cache、Usage、Receipt、budget、retry分離
- revision失効、再配送、障害分離
- cross-tenant Container reuse 0件

Value:

- 各tenantで会社文脈とauthorityを解決
- 各tenantで実務Shipを1件以上完了
- external readbackとtenant付きReceiptを取得

## 7. M4 objective: Management Execution Loop

MANAが人間に言われる前に停滞を検出し、Brainbase authorityに従って次を閉じる。

- Goal／Outcome／Ship／Task／RACI相関
- 期限超過、担当不在、判断待ち、依存停止、証拠不足
- Next Best Action
- auto／approval／human_action／deny
- 再通知、代替案、RACIエスカレーション
- evidence-backed completion
- 学習候補への還流

## 8. M5 objective: Superset

組織版は個人版の能力上の上位互換であり、個人データ閲覧権上の上位互換ではない。

完了条件:

- 組織版CIで個人版OSSの全contract testを実行
- organization capabilityを無効にすると個人版と同じ挙動
- CLI／MCP入口数だけでなく、安全契約と利用者成果が一致
- Personal KG、company authority、tenant境界のnegative E2Eが回帰しない

## 9. Immediate blocking rules

M0完了前に次を完了扱いにしない。

- TechKnightの会社データread/write canary
- 梅田さんの本番Personal KG付与
- MANAのRACIベース自律実行
- Personal→Organization本番昇格
- 組織版CLI／MCP 23/23完成宣言

M0前でも続行できるもの:

- tenant provisioning
- workspace connection lifecycle
- credential brokerの秘密非露出検証
- Usage／Receipt、Queue、Container、idempotencyのtenant isolation試験
- contract、fixture、runbook
- 外部接続も会社データも使わない静的CLI試作

## 10. Definition of done

M0はdocs、schema、CIだけでは完了しない。

- Brainbaseがcanonical company authorityを発行
- MANAが権限を自己生成しない
- 全境界で署名・revisionを検証
- 2 tenant × 2 personのfresh E2E
- authority、実行、readback、Usage、Receiptを同一correlation IDで追跡
- company authority欠落時の会社データoperation 0件
- fallback 0件
- 境界事故 0件
