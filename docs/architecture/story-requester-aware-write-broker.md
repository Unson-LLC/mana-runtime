---
architecture_id: arch-requester-aware-write-broker
story_id: story-requester-aware-write-broker
title: 依頼者別書き込み仲介アーキテクチャ
status: proposed
date: 2026-08-13
---

# 依頼者別書き込み仲介アーキテクチャ

## 決定

`task-runtime-core` と書き込み実行adapterの間にwrite brokerを置く。AI、MCP、Slack handlerはBrainbaseの書き込みAPIを直接呼ばず、正規化済みの `WriteIntent` をbrokerへ渡す。brokerは署名付きcapability、write policy、budget、冪等性を実行時に検証し、`auto`、`approval`、`deny` のいずれかを確定する。

capabilityは「依頼者へ委譲された最大権限」、policyは「今回の依頼をどう扱うか」、budgetは「現在消費可能か」を表す。三者を同じ設定やtokenへ統合しない。

## 責務境界

### task-runtime-core

- Canonical Task型、API client、query、error、trusted project scope。
- operation名、`WriteIntent`、`MutationResult`、conflict、冪等性の純粋契約。
- Node、Cloudflare、Slack、環境変数、secret、Placement設定、永続化を参照しない。

### signed event capability

- issuer、audience、subject、workspace、Placement、project、operation、target、expiry、nonce、budget referenceをcanonical serializationして署名・検証する。
- 期限切れ、audience不一致、Placement/project/operation/target不一致、nonce再利用を拒否する。
- `auto / approval / deny` を決定しない。

### write broker

- `actor × Placement × project × operation × target` をpolicyへ入力する。
- capabilityの許可範囲とpolicy decisionの積集合を取る。
- budgetを実行前に予約し、成功時commit、非実行時releaseする。
- 同一冪等キーの再試行では一度だけ実行し、確定済み結果を返す。
- 書き込みadapterを呼べる唯一のアプリケーション境界とする。

### Slack approval adapter

- pending actionの作成、Block Kit、button、承認者再認可、TTL、single-use、resumeを担当する。
- Slack user IDとworkspace/team IDをactorの正本にし、表示名を使わない。
- 承認時は保存済みpayload hashを使い、LLMやSlack本文から操作内容を再生成しない。

### audit adapter

- decisionとexecutionを追記専用receiptとして保存する。
- requester、approver、policy version、capability hash、budget reservation、before/after参照、result、timestampを記録する。
- secret、署名鍵、Authorization header、元のcapability tokenを記録しない。

## 契約案

```ts
type WriteIntent = {
  requestId: string;
  actor: { provider: "slack"; id: string; workspace: string };
  placementId: string;
  projectId: string;
  operation: "task.create" | "task.update";
  target: { type: "task"; id?: string };
  payloadHash: string;
  idempotencyKey: string;
  capability: string;
};

type PolicyDecision =
  | { effect: "auto"; decisionId: string }
  | { effect: "approval"; decisionId: string; approverSet: string; expiresAt: string }
  | { effect: "deny"; decisionId: string; reasonCode: string };

type ExecutionReceipt = {
  decisionId: string;
  policyVersion: string;
  capabilityHash: string;
  budgetReservationId?: string;
  beforeRef?: string;
  afterRef?: string;
  result: "executed" | "denied" | "expired" | "failed";
  timestamps: { requestedAt: string; decidedAt: string; executedAt?: string };
};
```

名称と配置は `story-shared-task-runtime-core` の公開契約確定後に合わせる。ここでは意味境界を正本とする。

## 状態遷移

```text
received
  -> invalid capability ------------------------> denied + receipt
  -> policy deny -------------------------------> denied + receipt
  -> budget unavailable ------------------------> denied + receipt
  -> policy auto -> budget reserve -> execute --> commit/release + receipt
  -> policy approval -> pending
       -> expired ------------------------------> release + receipt
       -> unauthorized approver ----------------> pendingのまま + security event
       -> approved -> reauthorize -> execute ---> commit/release + receipt
```

## 重要な不変条件

- projectはPlacementと対象Taskの正規属性から決め、ユーザー文・LLM出力から拡張しない。
- 書き込みMCPのwildcardを直接公開せず、書き込みはbroker経由の専用toolに限定する。
- budget予約は実行前。承認はbudget超過を迂回しない。
- 承認後もcapability、policy、budget、target versionを再検証する。
- task更新はbefore versionを用いた楽観ロックを維持する。
- 同じrequest/idempotency keyから複数の副作用を発生させない。

## 段階展開

1. 機能フラグOFFでdecisionだけを記録するshadow mode。
2. 限定Placementで `task.create` の低リスク規則だけauto。
3. `task.update` を追加し、conflictとbefore/after照合を確認。
4. Slack approvalを有効化する。

異常時はbrokerの実行フラグをOFFにし、read-onlyへ戻す。pending actionは自動実行せず期限切れにする。

## 変更しないもの

本Story設計段階では、既存のPlacement認証、Task Canvas、meeting-task proposal、Brainbase API、本番設定、Slack App設定を変更しない。
