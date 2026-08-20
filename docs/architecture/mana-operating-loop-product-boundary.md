---
title: Mana Operating Loop と Brainbase の製品境界
status: accepted
date: 2026-08-20
scope: mana-runtime
---

# Mana Operating Loop と Brainbase の製品境界

## 決定

Mana は Brainbase の上位有償版ではなく、Brainbase の状態・記憶・権限を利用して継続的に **理解・判断・実行・追跡する Operating Agent** とする。

```text
Brainbase = Remember / Organize / Retrieve / Learn
Mana      = Understand / Decide / Act / Follow-through
```

Brainbase が Memory Loop を所有し、Mana が Operating Loop を所有する。ManaはBrainbaseの正本を複製せず、Brainbaseが提供する組織状態・記憶・権限を実行時に利用する。

## 現行Runtimeの正本

Mana Runtimeの現行実装は **Cloudflare-native runtime** である。Jimmy / Jinn / OpenRyokoを基盤としたLightsail常駐runtimeは廃止済みであり、現行アーキテクチャの依存ではない。

```text
Slack Events API / timer / system event / human request
                         |
                         v
                 Cloudflare Worker
                         |
                  Queue / Durable Object
                         |
                         v
             Cloudflare Computer / Sandbox
                         |
                         v
                    Claude Code
                         |
                         v
               Brainbase APIs / brokers
                         |
                         v
              action / Slack response
```

現行コードの正本は `packages/cloud-runtime/` とする。会社別deploymentは同じruntime実装から生成し、Slack App、Worker、Queue/DLQ、Durable Object、Computer/Sandbox、credential boundaryをdeployment単位で分離する。

Git履歴には旧Jimmy/OpenRyoko実装が残るが、active source treeへ旧runtimeを残さない。

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

その上で次のtriggerから判断を開始する。

```text
time trigger   -> 朝・夜・週次など
event trigger  -> meeting ended / task changed / PR merged / message received
state trigger  -> overdue / blocked / goal at risk / missing owner / stale decision
human trigger  -> Slack / UI / API / command
```

Manaは判断結果を返答だけで終わらせず、Brainbaseから確認したauthorityの範囲で実行へ進める。

```text
Observe
  -> Understand
  -> Decide
  -> Authority check
  -> Act
  -> Verify outcome
  -> Record result to Brainbase
  -> Continue or escalate
```

## Mana Operating Loop

### `ohayo`: 今日、何を進めるべきか

BrainbaseのMorning Memory Loopを材料の1つとして、Goal / Milestone / Sprint / Task / Ship / RACI / deadline / blocker / calendar / recent decisions / capacityを読み、今日のoutcomeと優先順位を決める。

出力は、today outcome、top priorities、immediate decisions、Mana自身が今すぐShipする項目、人間へ依頼する項目、reminder/escalation、risks/blockers、evidence/rationaleを含める。

### `oyasumi`: 今日の成果は十分だったか

朝のoutcome、Ship、task transition、human/agent action、meeting decision、blocker/failure、Brainbase Night Memory Loopを照合し、achieved outcomes、持越し、drop対象、accountability gap、tomorrow top priority、persistすべきdecision、escalationを判断する。

### `retro`: 来週、何を変えるべきか

Goal progress、Ship/outcome、反復blocker、human/agent execution、decision quality、Brainbase Memory Retro、process/role/authority frictionを分析し、system change、role変更提案、automation、削除/簡素化候補、Story/PR/operational Ship、人間承認事項へ落とす。

## Brainbaseとのcompose

ユーザー向け名称は同じでもよい。

```text
without Mana
/ohayo -> Brainbase Morning Memory Loop

with Mana
/ohayo -> Mana Morning Operating Loop
             -> Brainbase Morning Memory Loop
             -> Brainbase organization / personal state
             -> permitted external observations
             -> decision
             -> authority check
             -> execution
```

ManaはBrainbase Routineをoverrideせずcomposeする。

## Workerの位置づけ

Claude Code、Codex、その他のagent runtimeはworkerであり、Manaの製品概念や正本ではない。

```text
Mana detects work
  -> Judgment
  -> authority check
  -> worker execution
  -> artifact / PR / task mutation / message
  -> verify
  -> Ship result
  -> Brainbase record
```

Cloudflare Computerはworkerを隔離実行する現行基盤であり、Manaの業務知識の正本ではない。

## Brainbaseが正本であるもの

- canonical entity identity
- organization / project context
- approved Graph
- Personal KG
- Episode / Decision memory
- RACI / authority contract
- task / sprint / ship SSOT（Brainbase側で管理する場合）
- audit / run evidence

## Mana Runtimeが保持するもの

runtime concernに限定する。

- active execution session
- worker lifecycle
- trigger/event processing state
- Queue / retry / backoff / DLQ state
- temporary execution context
- connector delivery state
- short-lived planning state
- Durable Object / Computer lifecycle state

長期業務知識、正式な役割、authority、decisionをMana独自memoryへ閉じ込めない。

## Authority boundary

```text
can_do != allowed_to_do
```

LLMは権限を生成しない。actor、resource、capability、desired effect、RACI/policy、evidenceをBrainbase側のcanonical company authorityで確認し、確認できなければfail closedする。

## Business boundary

Manaの有償価値は「より多く記憶できる」ことではない。

- proactive monitoring
- continuous prioritization
- autonomous execution
- human follow-through
- worker orchestration
- organization-wide Operating Loop
- managed channels / notifications
- reliability / audit / commercial support

Brainbase OSSが高品質でもManaの価値は失われない。Brainbaseが信頼できるほどManaが高精度に行動できる。

## Repository boundary

このリポジトリ `mana-runtime` はManaの現行Cloudflare実行基盤の正本とする。

- `packages/cloud-runtime/`: Cloudflare-native canonical runtime
- `packages/task-runtime-core/`: task execution primitives
- `packages/slack-thread-context/`: Slack context primitives
- `packages/write-broker/`: bounded write primitives
- `packages/web/`: Mana UI surfaces

旧Jimmy/OpenRyoko runtimeを別の現行product/coreとして扱わない。必要な由来・著作権情報はGit履歴と法的noticeで保持し、active architectureには持ち込まない。

ライセンスやrepository visibilityを変更する場合は、すでに公開済みのMITコードの権利を巻き戻せないことを前提に別ADRで判断する。これはruntime architectureとは別の経営・法務判断である。

## 実装ルール

1. 記憶の正規化・検索・保存ならBrainbase責務ではないか確認する。
2. 目的に対する判断・実行・追跡ならMana責務として扱う。
3. runtime stateをbusiness SSOT化しない。
4. Claude/Codex等の特定workerへ製品概念を結合しない。
5. time triggerだけでなくevent/state triggerへ一般化できるか確認する。
6. action authorityをLLM推測から作らない。
7. 人間が必要な仕事を表示だけで終わらせずfollow-throughする。
8. Lightsail/Jimmy/OpenRyokoを現行runtime dependencyとして復活させない。
