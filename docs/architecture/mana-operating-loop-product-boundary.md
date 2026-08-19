---
title: Mana Operating Loop と Brainbase の製品境界
status: accepted
date: 2026-08-19
scope: mana-runtime
---

# Mana Operating Loop と Brainbase の製品境界

## 決定

Mana は Brainbase の有償版ではなく、Brainbase の状態・記憶・権限を使って継続的に **理解・判断・実行する常駐Agent Runtime** とする。

Brainbase が Memory Loop を所有し、Mana が Operating Loop を所有する。

```text
Brainbase = Remember / Organize / Retrieve / Learn
Mana      = Understand / Decide / Act / Follow-through
```

ManaはBrainbaseなしでも技術的には起動できる構造を許容するが、Brainbase連携時に最も高い価値を出す。BrainbaseをMana内部のprivate databaseにはしない。

## Manaの責務

Manaは次の状態を継続的に理解する。

- user / organization goal
- milestone
- sprint
- task
- ship / outcome
- role / RACI / authority
- project state
- decision / episode / knowledge
- human availability / responsibility
- blocker / dependency / deadline

その上で、次の4種類のtriggerから判断を開始する。

```text
time trigger
  朝・夜・週次など

event trigger
  meeting ended / task changed / PR merged / message received など

state trigger
  overdue / blocked / goal at risk / missing owner / stale decision など

human trigger
  Slack / UI / API / command からの依頼
```

Manaは、判断結果を「返答」で終わらせず、権限の範囲で実行へ進める。

```text
Observe
  -> Understand
  -> Decide
  -> Act
  -> Verify outcome
  -> Record result to Brainbase
  -> Continue or escalate
```

## Mana Operating Loop

### `ohayo`: 今日、何を進めるべきか

Manaの朝ルーティンは、BrainbaseのMorning Memory Loopを材料の1つとして使い、目的から今日の実行計画を決める。

入力例:

- Brainbase Memory Loopの結果
- Goal / Milestone / Sprint
- Task / Ship status
- owner / RACI
- deadline / blocker
- calendar / meetings
- recent decisions
- human / agent capacity

出力:

- today outcome
- top priorities
- immediate decisions
- Mana自身が今すぐShipする項目
- 人間へ依頼する項目
- reminder / escalation対象
- risks / blockers
- evidence / rationale

重要なのは「今日思い出す情報」ではなく「今日会社・本人をどこまで前進させるか」を決定すること。

### `oyasumi`: 今日の成果は十分だったか

入力:

- 朝に立てたoutcome / priority
- 今日のShip
- task transitions
- human / agent actions
- meeting decisions
- blockers / failures
- Brainbase Night Memory Loop

出力:

- achieved outcomes
- unfinished but still valid
- stale / unnecessary work to drop
- accountability gaps
- tomorrow top priority
- decisions to persist
- escalation required

Manaは単に記憶を圧縮するのではなく、目的に対して実行が進んだかを評価する。

### `retro`: 来週、何を変えるべきか

入力:

- goal progress
- ships / outcomes
- repeated blockers
- human / agent execution history
- decision quality
- Brainbase Memory Retro
- process / role / authority friction

出力:

- repeated operational patterns
- system changes
- role / responsibility changes to propose
- automation opportunities
- process deletion / simplification candidates
- stories / PRs / operational ships
- human approval requirements

ManaのRetroはMemory Systemの品質改善ではなく、成果を出すシステム全体の改善を扱う。

## Brainbaseとの呼び分け

ユーザー向け名称は同じでもよい。

```text
without Mana

/ohayo
  -> Brainbase Morning Memory Loop

with Mana

/ohayo
  -> Mana Morning Operating Loop
       -> Brainbase Morning Memory Loop
       -> Brainbase organization / personal state
       -> external sources as permitted
       -> decision
       -> execution
```

ManaがBrainbaseのルーティンをoverrideするのではなくcomposeする。

## Runtime architecture

Manaはschedulerそのものではなく、複数triggerを受けてAgent executionを継続するruntimeである。

```text
                    +------------------+
cron / timer ------>|                  |
event bus --------->|   Mana Runtime   |----> Claude / Codex / other worker
Brainbase event --->|                  |----> Slack / Email / external actions
human request ----->|                  |----> human reminder / approval
                    +--------+---------+
                             |
                             v
                       Brainbase API
                    state / memory / audit
```

Codex Automationは利用可能なtrigger / workerの1つであり、Manaの製品概念にしない。

### Codexの位置づけ

Codexは coding worker として利用できる。

```text
Mana detects required code change
  -> Judgment
  -> authority check
  -> start Codex worker
  -> PR / test / artifact
  -> verify
  -> Ship result
  -> Brainbaseに結果記録
```

Mana自身がコード生成モデルになる必要はない。Manaは仕事の割当・継続・確認を担う。

## Brainbaseが正本であるもの

- canonical entity identity
- organization / project context
- approved Graph
- Personal KG
- Episode / Decision memory
- RACI / authority contract
- task / sprint / ship SSOT（Brainbase側で管理する場合）
- audit / run evidence

## Manaが正本であるもの

Manaは原則として業務SSOTを複製しない。

Mana Runtimeが保持する正本はruntime concernに限定する。

- active execution session
- worker lifecycle
- trigger subscription
- temporary execution context
- retry / backoff
- action attempt state
- runtime connector state
- short-lived planning state

長期の業務知識や正式な役割・判断を `~/.mana` の独自memoryだけへ閉じ込めない。

## Authority boundary

Manaの能力と権限を分ける。

```text
can_do != allowed_to_do
```

各actionは最低限次を持つ。

- actor
- target
- action_type
- required_authority
- approval_mode
- evidence
- result

例:

- 情報収集: 自動許可可能
- 下書き: 自動許可可能
- internal task update: roleによって自動許可
- external send: policy次第で承認
- purchase / contract / production deploy: 明示されたauthority gate

BrainbaseにあるRACI / policyを利用し、LLMが「やってよさそう」と推測して権限を生成しない。

## Business boundary

Manaの有償価値は「より多く記憶できる」ことではない。

課金対象は次。

- proactive monitoring
- continuous prioritization
- autonomous execution
- human follow-through
- multi-agent / worker orchestration
- organization-wide Operating Loop
- managed channels / notifications
- reliability / audit / commercial support

Brainbase OSSが高品質でもManaの価値は失われない。むしろBrainbaseが信頼できるほどManaが高精度で動ける。

## Repository / licensing note

このリポジトリは2026-08-19時点でpublicかつMITで、READMEもOpenRyokoとして公開配布を前提にしている。

Manaを商用プロプライエタリな差別化層として販売する場合、現在のライセンス・公開範囲は別途経営判断が必要。

選択肢は混同しない。

### Option A: runtime OSS + managed Mana有償

- runtime自体はOSSを維持
- hosted control plane、managed connectors、organization policy、reliability、cloud executionを有償化
- OSS採用をdistributionとして使う

### Option B: OpenRyoko core OSS + Mana commercial layer private

- upstream由来のgateway/runtime coreは公開
- Mana固有のOperating Loop、organization reasoning、commercial connector / policy layerを別private repositoryへ分離

### Option C: Mana runtime自体を今後proprietary化

既にMIT公開された過去コードの権利を巻き戻すことはできない。将来追加部分のlicense / repository visibilityは変更できるが、既公開部分との差別化を前提に設計する必要がある。

現時点の推奨は **Option B**。OpenRyoko/Jinn由来の汎用Agent gatewayを無理に囲い込むより、Mana固有のOperating LoopとBrainbase Organization integrationを商用資産として明確に分離する。

## 実装ルール

今後Manaへ機能を追加する際は次を確認する。

1. これは記憶の正規化・検索・保存か。ならBrainbase側ではないか。
2. これは目的に対する判断・実行・追跡か。ならMana側である。
3. runtime固有状態をbusiness SSOT化していないか。
4. Codex / Claude等の特定workerへ製品概念を結合していないか。
5. time triggerだけでなくevent/state triggerとして一般化できないか。
6. action authorityをLLM判断だけで作っていないか。
7. 人間が必要な仕事を「表示」で終わらせずfollow-throughできるか。
