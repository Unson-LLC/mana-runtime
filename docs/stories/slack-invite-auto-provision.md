---
story_id: slack-invite-auto-provision
title: Slack招待によるplacement自動プロビジョニング（channel-members audience + 標準プロファイル）
status: active
pr_scope_strategy: atomic_single_pr
pr_scope_reason: "本Storyは「招待=権限判断済み」という単一の信頼境界を成立させる変更である。招待イベントでの自動生成・channel-members audience（Slackメンバーシップ委任）・標準プロファイル・退出時の無効化・挨拶投稿・個人KG恒常denyは、いずれも「招待されたチャンネルで誰が何を使えるか」の同一契約を構成し相互依存するため、分割すると自動生成だけ先行してメンバー判定が無い（または逆）中途半端な権限状態がmergeされ、レビューアが境界全体の整合を検証できない。よって1 PRで原子的にレビューする。"
pr_scope_review_facets:
  - requirements-ssot
  - runtime-behavior
  - misc-follow-up
  - e2e-gate
pr_scope_dependency_boundaries:
  - "requirements-ssot -> runtime-behavior"
  - "runtime-behavior -> misc-follow-up"
  - "runtime-behavior -> e2e-gate"
---

# Slack招待によるplacement自動プロビジョニング

## User story

AIガバナンス責任者として、Slackチャンネルにbotを招待したら（pilotでのconfig.yaml手編集なしに）そのチャンネルのメンバーが標準プロファイルの範囲で即座にエージェントを使える状態にしたい。招待できる人は権限判断を済ませており、チャンネルメンバーシップはSlack自身のアクセス制御である（[docs/adr/0004](../adr/0004-no-second-permission-system.md)「第二の権限体系を発明しない」の適用: メンバー管理をSlackに委任）。これにより「botを招待→config手編集→capabilities書き忘れで無言bot」という現状UXを「招待したらそのチャンネルのメンバーは基本使える」へ引き上げる。

## Background

設計の正本は [docs/architecture/04_auth_permission.md](../architecture/04_auth_permission.md)（deny-by-default / fail-closed）、[docs/architecture/10_company_brain.md](../architecture/10_company_brain.md) §6（エージェント台帳）、[docs/architecture/11_persona_skills_memory.md](../architecture/11_persona_skills_memory.md)。placementの解決は `shared/placement-profile.ts` の `resolvePlacement`（現状は静的 `audience.allowedUsers` のみ）、config.yamlのランタイム書込は `shared/config-history.ts` のスナップショット機構が正本。自動生成は既存のdeny-by-default原則（[docs/adr/0001](../adr/0001-placement-deny-by-default.md)）を破らない: placements運用中のインスタンスに限り、招待というSlack側の権限行為を根拠に「確定済み標準プロファイル」のplacementを追加するだけであり、未マッチのチャンネル・失敗時は従来どおり全拒否のままである。

## 受け入れ基準

- bot自身への `member_joined_channel` イベントで、そのチャンネルのplacementが標準プロファイルで自動生成されconfig.yamlへ永続化される。書込は必ずconfig-historyのスナップショット機構（`recordConfigChange`、source: "auto-provision"）を通る（auto-provision on invite）。
- 同一connector/workspace/channelのplacementが既に存在するチャンネル（enabled: falseを含む）では自動生成も上書きも行われない（idempotent no-op）。
- `placements:` キーが構成されていない（placement運用外の）インスタンスでは自動生成が発動しない — 初placement追加による他チャンネル全拒否への意図しない切替を防ぐ（placement-mode gate）。
- 標準プロファイルはコード内デフォルト+config.yamlの `placementDefaults` 上書きで1箇所に定義され、生成時に適用される: audience type "channel-members" / owner=招待者Slack userID / purpose="auto-provisioned (invited by <user>)" / agent.defaultModel sonnet・escalationEmployee critical-reviewer / capabilities.mcp [brainbase, gateway]・gatewayTools [send_message, create_task, list_tasks, search_tasks, update_task, transition_task]・allowedDelivery省略（自チャンネルのみフォールバック） / dataScopes graph read-only / monthlyBudgetUsd 10（standard profile）。
- audience type "channel-members" が新設され、静的allowedUsersではなくSlack `conversations.members` 照会（TTLキャッシュ付き）で発話者のメンバーシップを判定する。API失敗・判定不能・非対応connectorはfail-closed=拒否となる（channel-members audience）。
- brainbase MCPを許可する全placementセッション（自動生成に限らない恒常ルール）で `mcp__brainbase__search_personal_kg` が `--disallowedTools` の個別denyに追加される（personal KG deny）。
- 自動生成成功時にそのチャンネルへ1回だけ挨拶（標準プロファイルで動く旨・owner・できること3行・昇格はownerからoperatorへ依頼）が投稿される（greeting once）。
- botがチャンネルから外れたら該当placementが `enabled: false` へ更新される（削除しない=監査痕跡維持、config-history経由）（disable on leave）。
- 自動生成が失敗した場合はconfig.yamlに中途半端なplacementが書かれず、従来どおり全拒否のままである。公開チャンネルでも同一プロファイル（respondToはmention既定のまま）が適用される（fail-closed on error）。
- 台帳（`GET /api/placements` とweb placements画面）で自動生成placementがowner・purpose付きで確認できる（ledger visibility）。
- 追加・変更した挙動に自動テストがあり、`packages/jimmy` のvitest全件とtypecheckが通る。

## シナリオ

- AUTOPROV-STORY-S-001: webのplacements台帳画面で、自動生成されたplacementがowner（招待者）とpurpose（auto-provisioned (invited by <user>)）付きの行として確認できる。

## Scope

- 対象: `packages/jimmy` のSlackコネクタ（connectors/slack/index.ts: member_joined_channel / channel_left・group_left ハンドラ、conversations.membersメンバーシップ照会）、placement境界（shared/placement-profile.ts: channel-members audience解決とpersonal KG deny）、自動プロビジョニングモジュール（config.yaml読み書き+config-history、標準プロファイル定義）、routing gate（gateway/server.ts: メンバーシップ判定の受け渡し）、型定義（shared/types.ts: audience拡張・placementDefaults）、台帳表示互換（gateway/placements.ts）。
- 非対象: 昇格の承認フロー（nocodb・他チャンネル配信・cron・budget増額は既存どおりconfig手編集、HITL型化後に接続）、Slack以外のコネクタでのchannel-members対応（fail-closed拒否のまま）、triage/respondToポリシーの変更（mention既定のまま）、退出後の再招待での自動再有効化（手動re-enable運用）。

## 標準capability追加時の既存placement運用

`STANDARD_CAPABILITIES` の変更は新規自動作成placementにだけ適用され、既存placementは自動更新しない。`search_tasks` のような標準toolを追加する場合は、config-historyのスナップショットを作成し、対象placementの `gatewayTools` へ明示追加する。更新後はoperatorの保護readと対象channelの疎通で許可を確認し、未許可channelおよび無スコープ要求が引き続き拒否されることを確認する。

ロールバックはスナップショットを使って対象placementのtool追加だけを戻し、認可拒否を確認してからruntimeを直前releaseへ戻す。`placements` 全体の削除、空設定、audience拡張をロールバックに使わない。
