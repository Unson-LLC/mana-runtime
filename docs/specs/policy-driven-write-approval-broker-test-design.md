---
title: ポリシー駆動書き込み承認の仕様・テスト設計
story: docs/management/stories/active/story-policy-driven-write-approval-broker.md
architecture: docs/architecture/policy-driven-write-approval-broker.md
status: proposed
---

# ポリシー駆動書き込み承認の仕様・テスト設計

## 共通契約

### WriteIntent

依頼ID、依頼者（provider・workspace・ID）、配置先、プロジェクト、正規化された操作、対象、入力内容のhash、冪等キー、capability参照を持つ。表示名と自然言語の推測結果を認可キーに含めない。

### PolicyDecision

- `auto`: 実行候補。capability検証と予算予約の成功が別途必要。
- `approval`: 承認者集合と期限を伴う保留候補。
- `deny`: 安定した理由コードを伴う拒否。

### PendingApproval

判断ID、固定済みWriteIntent、入力内容のhash、適用ポリシーversion、承認者集合、期限、状態を持つ。状態は`pending`から`executing`、`executed`、`rejected`、`expired`のいずれかへ一方向に遷移する。

### ExecutionReceipt

判断ID、依頼者、承認者、ポリシーversion、capability hash、予算予約ID、変更前後の参照、結果、各時刻を持つ。失敗・拒否・期限切れも記録対象とする。

## 操作と初期方針

| 操作 | 初期方針 |
|---|---|
| `task.create` | 限定Placement・trusted project・低リスク依頼者だけ`auto`候補。それ以外は`approval`または`deny` |
| `task.update` | 対象projectとversion確定時だけ`auto`候補。曖昧または競合時は実行しない |
| `task.delete` | `deny` |
| 外部送信・公開・本番変更 | `deny`または将来の明示承認Story |

## テスト設計

### 1. ポリシー単体テスト

- 依頼者、workspace、配置先、project、operation、targetの組合せを表駆動で検証する。
- 一致ルールなし、複数project、未知のactor、未知のoperationは`deny`になる。
- 具体ルールと包括ルールが競合した場合の優先順位を固定する。
- 同じ入力と同じポリシーversionは常に同じ判断になる。
- Story追跡: `AC-1`、`AC-2`、`AC-7`。

### 2. capability交差テスト

- ポリシーが`auto`でも、期限切れ、改ざん、audience・actor・placement・project・operation・target不一致なら拒否する。
- nonce再利用と同じcall slotへの異なる入力を拒否する。
- capabilityの許可範囲をポリシーが拡張できないことを確認する。
- Story追跡: `AC-2`、`AC-4`。

### 3. 承認状態遷移テスト

- 権限外承認者、期限切れ、二重クリック、拒否後の再開を拒否する。
- 保留後の入力差替え、hash差替え、ポリシーversion変更、承認者権限変更を拒否する。
- 再起動後も同じ保留を再開でき、実行は一度だけになる。
- Slack payloadからWriteIntentを再生成しないことを確認する。
- Story追跡: `AC-3`、`AC-4`、`AC-8`。

### 4. 予算競合テスト

- 並行する二つの実行が上限を越えて同時予約できない。
- 成功時はcommit、拒否・期限切れ・実行失敗時はreleaseされる。
- 承認済みでも予約失敗時は実行しない。
- 同じ冪等キーの再試行で二重消費しない。
- Story追跡: `AC-5`。

### 5. broker統合テスト

- `capability ∩ policy ∩ budget`が全て許可した場合だけTask adapterを呼ぶ。
- `auto`、`approval`、`deny`の各経路でreceiptが残る。
- `task.create`と`task.update`で依頼者・project・operation・targetの越境を拒否する。
- 更新競合は再承認で隠さず、非再試行の競合結果として返す。
- Story追跡: `AC-1`〜`AC-7`。

### 6. adapter契約テスト

- JimmyとCloudflareが同一WriteIntentに対して同じPolicyDecisionとreceipt形を扱える。
- Slack adapterは承認者ID、channel、期限、単回性を再検証する。
- Slack停止・再起動後もbrokerの保留状態が正本として残る。
- 追記専用監査に依頼者、承認者、ルールversion、入力hash、変更前後、結果が揃う。
- Story追跡: `AC-3`、`AC-6`、`AC-8`。

### 7. 本番前E2E

- shadow判定では書き込み結果を変えず、想定判断との差だけを記録する。
- 限定Placementで`task.create`と`task.update`の`auto / approval / deny`を各1件確認する。
- kill switch後は新規実行を止め、処理中・保留中の扱いが定義どおりになる。
- Canonical Taskの最終状態とExecutionReceiptが一致する。

## 実装開始ゲート

- ポリシーの正本とversion更新規則が決まっている。
- PendingApprovalとExecutionReceiptの永続先が決まっている。
- 予算の予約・確定・解放に原子的な契約がある。
- 書き込み可能なMCP・gateway toolのbroker迂回経路が列挙され、遮断方針が決まっている。
- 上記テストを先に失敗させる単位へTaskが分割されている。

## 今回実施しないこと

テストコード、broker実装、Slack承認画面、DB migration、設定変更、デプロイは行わない。
