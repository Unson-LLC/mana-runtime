# A0 Company Authority Consumer Task

- Program: `brainbase-program-master-roadmap-v1`
- Story: `story-brainbase-owned-company-authority-consumer`
- Architecture: `docs/architecture/13_brainbase_owned_company_authority.md`
- Accepted Spec: `.vibepro/spec/story-brainbase-owned-company-authority-consumer/spec.json`
- Owner branch: `codex/a0/company-authority-consumer-reconcile`
- Status ceiling: `contract_ready`（`done=false`）

| Task | 目的 | 変更範囲 | 完了条件 | 状態 |
|---|---|---|---|---|
| A0-TASK-001 | Brainbase-owned company authorityをManaが独自生成せず検証・伝播するconsumer fixture契約と証拠を固定する | A0 Story、Architecture、accepted Spec、source-lock/vendor fixture、consumer helper/conformance test、VibePro証拠 | producer 10 artifact hash一致、positive 9 / negative 52、current HEAD/baseのunit・evidence・typecheck、production/runtime 4 caseは`not_collected`のまま、独立review準備 | implementing |

## 実施順序

1. StoryとArchitectureでBrainbase owner / Mana verify-and-propagate-only境界を確認する。
2. accepted SpecとTaskをsource-lock、fixture、consumer helper、testへ結ぶ。
3. current HEAD/baseで決定論的検証とVibePro証拠を再生成する。
4. owner自身でGateをpassにせず、current exact HEADを独立reviewへ渡す。

## 禁止境界

- producer semantics、Mana runtime/API/UI/DB、T0、credential lease責務を拡張しない。
- fixture/mock/docs/testをproduction proofへ昇格しない。
- production deploy、schema migration、secret/customer data、外部送信、push、PR作成、PR mergeを行わない。
- 2 tenant×2 person production E2Eとruntime 4 caseは、実証されるまで`not_collected`を維持する。
