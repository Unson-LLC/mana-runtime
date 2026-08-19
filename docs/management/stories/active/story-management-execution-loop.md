---
story_id: story-management-execution-loop
title: "MANAが人間の見張りなしに意思決定を証拠付きShipまで閉じる"
status: active
source:
  type: product-direction
  id: story-management-execution-loop
architecture_reason: "タスク作成や通知ではなく、Goal/Outcome、Ship、Task、RACI、期限、権限、外部readbackを一つの制御ループへ接続し、人間の判断介入あたりの完了成果を増やす。"
architecture_docs:
  - docs/architecture/10_company_brain.md
  - docs/architecture/story-meeting-task-proposal.md
spec_docs: []
related_tasks:
  - docs/plans/2026-08-19-organization-edition-and-multitenant-rollout.md
---

# MANAが人間の見張りなしに意思決定を証拠付きShipまで閉じる

## Background

MANAの価値は、AIとの会話数、タスク登録数、資料生成数ではない。Brainbaseに記録された会社の目的、優先順位、人物、責任、権限、過去判断を参照し、会社の意思決定を外部へ届いた成果まで前進させることである。

既存のmana-runtimeには、Canonical Task、期限リマインド、Graph文脈取得、Judgment lifecycle、議事録、承認、cron、Receiptの土台がある。しかし、プロジェクト全体を見て「次に進まない理由」を検出し、MANA自身ができる仕事を実行し、人間にしかできない仕事を適切な責任者へ働きかけ、外部readbackで完了を確定する共通ループは未完成である。

単なるリマインド機能にしない。人間側に残ったボトルネックを、最小限の認知帯域で解除する制御ループとして実装する。

## Operating Loop

```text
Context Resolution
  → Gap Detection
  → Next Best Action Selection
  → Authority Resolution
  → Auto Execute / Approval / Human Action / Deny
  → Follow-up / Escalation
  → Ship Verification
  → Learn
```

### Context Resolution

Brainbaseから次を解決する。

- Goal / Outcome / Shipと成功条件
- Project、Task DAG、期限、依存関係
- Responsible、Accountable、Approver、Consulted
- 過去の判断、制約、停止条件
- placement capability、budget、connection status
- 成果物、readback、Operation Receipt

取得失敗は「事実なし」に丸めず、`未確認`または`not_collected`として残す。

### Gap Detection

少なくとも次を決定論的に検出する。

- 期限超過
- 担当不在
- 判断待ち
- 依存先停止
- 完了報告はあるが証拠不足
- Taskは進んでいるがShipに近づいていない
- Shipは出たがOutcomeの外部結果を確認できていない

### Next Best Action

タスク一覧の上から処理せず、次を使って最も価値の高い停滞を解除する。

- Outcomeへの寄与
- 緊急性
- 他Taskを止めている度合い
- 自律実行可能性
- 人間の判断待ち時間
- 失敗時の損失と可逆性

### Authority Resolution

```text
auto
  policyとRACIの範囲内でMANAが実行する

approval
  MANAが実行案と影響を準備し、指定承認者の選択後に続行する

human_action
  人間本人の行為、信頼形成、法務・契約・対外責任が必要

deny
  権限外、情報不足、停止条件該当のため実行しない
```

分類はLLMの自信度ではなく、Graph、policy、connection revision、capabilityから決定論的に解決する。

## Human Decision Packet

人間へは、次を一つの決定可能な単位として提示する。

```text
必要な判断または行動
推奨案
選択肢と帰結
根拠となる事実・証拠
判断期限
未実行時の事業影響
回答方法
次のエスカレーション先
```

「進捗どうですか」「対応お願いします」「期限を過ぎています」だけの通知を成功扱いにしない。

## Acceptance Criteria

- [ ] AC-1: 1つの実プロジェクトで、Goal / Outcome→Ship→Task→RACI→期限→証拠→完了を同一correlation IDで追跡できる。
- [ ] AC-2: 期限超過、担当不在、判断待ち、依存停止、証拠不足を決定論的に検出し、reason codeと根拠を記録する。
- [ ] AC-3: 同じTaskでも、Execution Context、RACI、policy、connection revisionに基づき`auto / approval / human_action / deny`を決定論的に分類する。
- [ ] AC-4: `auto`の仕事は、MANAが調査・作成・外部実行・readback・Task更新・Receipt記録まで進め、下書き生成だけで停止しない。
- [ ] AC-5: `approval`または`human_action`では、適切なRACIへHuman Decision Packetを提示し、全Task一覧を送らない。
- [ ] AC-6: Human Decision Packetには推奨、選択肢ごとの帰結、根拠、期限、放置影響、回答方法を含める。
- [ ] AC-7: 期限までに解消しない場合、同じ文面を連打せず、状態再取得、判断コスト低減、代替案、RACIに基づくエスカレーションを行う。
- [ ] AC-8: 完了は成果物URI/hash、API readback、GitHub merge、顧客受領・反応、KPI差分、Operation Receiptのいずれかで検証し、証拠なしでは完了にしない。
- [ ] AC-9: AI・tool・接続が失敗した場合も、`partial`、`not_collected`、明示的failure codeを記録し、0件または成功へ丸めない。
- [ ] AC-10: 判断、実行、外部結果、停止理由、手戻りをBrainbase Candidate Storeへreview-required学習候補として関連付ける。
- [ ] AC-11: MANAが人間から指示される前に停滞を少なくとも1件検出し、適切な次の行動を開始する。
- [ ] AC-12: MANAが権限内の作業を少なくとも1件、人間の追加指示なしに外部readbackまで完了する。
- [ ] AC-13: 同じループ契約を、梅田さんの雲孫バックオフィス業務とTechKnightの少なくとも1実tenantで再利用する。
- [ ] AC-14: tenant、organization、person、project、placementの境界をまたいでTask、証拠、判断依頼、Receiptを混線させない。

## Scenarios

- `EXECLOOP-S-001`: Given 期限超過かつ担当者が存在するTaskを検出すると、MANAは最新状態を取得し、担当者へ次の行動・期限・影響を提示する。
- `EXECLOOP-S-002`: Given 人間のトレードオフ判断が必要なとき、MANAはA/B案、推奨、帰結、証拠をApproverへ提示し、承認前に不可逆処理を実行しない。
- `EXECLOOP-S-003`: Given policy範囲内の定型作業があると、MANAは自動実行し、外部readbackとReceiptを取得してTaskを更新する。
- `EXECLOOP-S-004`: Given 完了報告はあるが成果物またはreadbackがないと、状態を`未確認`に保ち、証拠取得を次の行動にする。
- `EXECLOOP-S-005`: Given 判断期限を過ぎると、MANAは同じ通知を再送するのではなく、最新状態、代替案、放置影響を再評価し、RACIに沿ってエスカレーションする。
- `EXECLOOP-S-006`: Given connection失効、権限不足、budget停止があると、別credentialや別tenantへfallbackせず、適切なhuman actionまたはdenyを返す。
- `EXECLOOP-S-007`: Given Shipが外部へ出たとき、MANAは顧客受領、API状態、merge、KPI等をreadbackし、結果をGoal / Outcomeへ関連付ける。
- `EXECLOOP-S-008`: Given 梅田さん業務とTechKnight tenantで同じ停滞種別が発生すると、同じループ契約を使い、人物名・tenant名のcore分岐なしで処理する。

## Minimum Vertical E2E

一つの実案件で次を同一correlation IDへ結び付ける。

```text
Goal / Outcome
  → Ship
  → Task DAG
  → RACI
  → MANAの自動実行
  → 人間への判断要求
  → 承認またはhuman action
  → 外部readback
  → 証拠付き完了
  → 学習候補
```

最低限、次を証明する。

1. MANAが人間から言われる前に停滞を1件検出する。
2. MANAが権限内の作業を1件、自律実行する。
3. 人間に必要な判断を推奨・期限・影響付きで1件提示する。
4. 未回答時に状態を再取得し、再介入またはエスカレーションする。
5. 実行後に外部システムから結果をreadbackする。
6. 証拠がなければ完了扱いにしない。
7. 判断・実行・結果をBrainbaseへ関連付けて戻す。
8. 人間がTask一覧を見張らなくてもShipが閉じる。

## Metrics

- 人間の判断介入1回あたりの完了成果数
- 無介入完了率
- 判断から実行までの時間
- 期限超過時間
- 証拠付き完了率
- 手戻り率
- 成果単位のAI費用
- Personal KG越境件数
- tenant境界事故件数

## Completion Evidence

- Goal / Outcome / Ship / Task / RACI / Receiptの相関readback
- 停滞検知reason codeと入力証拠
- `auto / approval / human_action / deny`の判断証跡
- Human Decision Packetと承認・却下actor
- 再通知・代替案・エスカレーション履歴
- 外部成果物、API readback、顧客反応、KPI差分
- Brainbase学習候補
- 梅田さん業務とTechKnight tenantの再利用証跡

## Out of Scope

- 全業務を一度に自動化すること
- LLMの自信度だけで権限や承認者を決めること
- Task完了フラグだけでShip完了とみなすこと
- 全Task一覧を定期通知するだけのダッシュボード
- 人間レビューなしの学習候補自動昇格
- 顧客名・人物名・tenant名をruntime coreへ埋め込むこと
