---
story_id: story-requester-aware-write-broker
title: 依頼者と操作に応じて安全に書き込みを仲介する
status: proposed
created_at: 2026-08-13
updated_at: 2026-08-13
source:
  type: operator-decision
  id: requester-aware-write-broker
depends_on:
  - story-shared-task-runtime-core
architecture_docs:
  - path: docs/architecture/story-requester-aware-write-broker.md
    status: proposed
spec_docs:
  - docs/specs/story-requester-aware-write-broker.vibepro.json
---

# 依頼者と操作に応じて安全に書き込みを仲介する

## 背景

mana-runtimeはSlackの利用者ID、Placement、project binding、利用可能ツールを識別できるが、書き込み操作を依頼者・対象・操作種別ごとに `auto / approval / deny` へ分類し、実行と監査を一貫して扱う共通境界がない。MCPやGatewayの書き込みツールを直接公開すると、Placement単位の許可だけでは操作単位の制限、承認、冪等性、実行前後の監査を強制できない。

現在進行中の `story-shared-task-runtime-core` は、Canonical Taskの型、API契約、trusted project scope、冪等性契約をNode・Cloudflare非依存の共通コアへ抽出する。本Storyはその契約を利用し、共通コアをSlackや認可状態で汚さず、書き込み実行時の仲介境界を別レイヤーとして追加する。

## User story

組織のSlack利用者として、自分の役割と担当projectに許されたタスク作成・更新はその場で実行し、高リスクまたは権限不足の操作は承認待ちか拒否にしたい。これにより、mana-runtimeへ書き込み能力を持たせても、誰が何を依頼・承認・実行したかを追跡できる。

## 受け入れ基準

- [ ] `AC-1`: `WriteIntent` はrequest ID、actorのprovider/user/workspace、Placement、信頼済みproject、正規化operation、target、payload hash、冪等キー、署名付きcapability参照を保持し、自由文からprojectやactorを補完しない。
- [ ] `AC-2`: 署名付きevent capabilityはactor、audience、Placement、project、operation、target、期限、nonce、budget参照を改ざん不能に運び、「可能な操作の上限」だけを表現する。
- [ ] `AC-3`: write policyはcapabilityとは独立して `auto / approval / deny` を返し、規則欠落・actor不明・project不一致・operation不明は既定で拒否する。
- [ ] `AC-4`: write budgetは実行前に `evaluate -> reserve -> commit/release` し、上限超過を承認によって迂回できない。
- [ ] `AC-5`: write brokerだけが書き込みadapterを呼び、capability、policy、budget、冪等性のすべてが許可した場合だけ `task.create` または `task.update` を実行する。
- [ ] `AC-6`: `approval` は元payload hashを固定したpending actionを保存し、承認者ID、workspace、channel、Placement、TTL、single-use、再開時の権限を再検証する。
- [ ] `AC-7`: 実行結果はrequester、approver、policy version、capability hash、budget reservation、before/after参照、結果、時刻を持つ追記専用receiptとして保存する。
- [ ] `AC-8`: JimmyとCloudflareは同一のintent・decision・receipt契約テストを通し、Slack固有のUI・鍵管理・永続化を共通task coreへ持ち込まない。
- [ ] `AC-9`: task作成・更新について `auto / approval / deny`、期限切れ、二重承認、payload差し替え、nonce再利用、project越境、budget競合、再起動後resumeをテストで固定する。
- [ ] `AC-10`: 初期展開は限定Placement、機能フラグ既定OFF、shadow decision、kill switchを備え、低リスクのtask作成・更新以外は自動実行しない。

## 実施順

1. `story-shared-task-runtime-core` の契約を確定・統合する。
2. 署名付きevent capabilityと検証契約を実装する。
3. write budgetの予約・確定・解放契約を実装する。
4. write brokerを `task.create` / `task.update` の `auto / deny` から実装する。
5. Slack承認adapterと監査receiptを追加する。
6. shadow decisionから限定Placementの自動実行へ段階展開する。

## スコープ外

- Task以外のDrive、GitHub、外部送信、本番変更の自動実行
- Task削除の自動実行
- Slack表示名を権限の正本として使うこと
- capabilityをpolicy decisionとして扱うこと
- 承認時にLLMからpayloadを再生成すること
- Brainbase Canonical Task以外の新しい業務正本

## 現段階の停止点

本変更ではStory、Architecture、テスト契約だけを定義する。実装コード、テストコード、Placement設定、本番設定、Slack App設定、デプロイは変更しない。
