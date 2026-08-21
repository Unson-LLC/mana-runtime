---
story_id: story-slack-mana-brainbase-multitenant-e2e
title: SlackからBrainbaseまでテナントを越境せず完了する
status: active
created_at: 2026-08-16
updated_at: 2026-08-16
horizon: quarter
view: product
source:
  type: business-design
  repository: Unson-LLC/brainbase-project
  path: docs/business/brainbase-mana-multitenant-v1/05-story-boundaries.md
architecture_reason: "ADR必須。Brainbaseとmana-runtimeをまたぐtenant authority、相関ID、失敗分類、Receipt、rollback、運用責任を固定する統合契約のため。"
architecture_docs:
  - path: docs/architecture/story-slack-mana-brainbase-multitenant-e2e.md
    status: accepted
spec_docs:
  - path: docs/specs/story-slack-mana-brainbase-multitenant-e2e.vibepro.json
    status: validation_blocked
depends_on:
  - Unson-LLC/brainbase-unson:story-brainbase-multitenant-platform
  - story-mana-multitenant-runtime
related:
  - https://github.com/Unson-LLC/vibepro/issues/466
---

# SlackからBrainbaseまでテナントを越境せず完了する

## User Story

Slackで八雲まなを利用する顧客として、依頼が自組織のBrainbaseだけを参照・更新し、結果、失敗理由、監査可能な証拠を元のSlackスレッドで受け取りたい。そうすれば、共有サービスでも他顧客との混線を心配せず業務を完了できる。

## Why This Story Exists

Brainbaseとmana-runtimeの個別unit testやdeploy成功だけでは、Slack event、tenant解決、AI実行、tool、Brainbase書込み、Slack返信が同じtenantで完結したことを証明できない。このStoryは両製品Storyの成果を、利用者が実際に通る縦断経路と正本readbackで検証する。

## Authority and Boundary

- canonical tenantとworkspace connectionはBrainbaseを正本とする。
- Slack受信後のtenant context伝播と実行分離はmana-runtimeが所有する。
- workspace ID、channel ID、project code、表示名からtenantを推測しない。
- mana-runtimeのcacheや設定値はBrainbaseのconnection revisionを上書きしない。
- 失敗時は別tenant、別credential、別deployment、default projectへfallbackしない。

## Acceptance Criteria

- [ ] `AC-001`: Slack event IDからinstallation、workspace connection、tenant、requester、placement、Brainbase operation、replyまで同一correlation IDで追跡できる。
- [ ] `AC-002`: Tenant AのreadはTenant Aの許可projectだけを検索し、Brainbase正本と結果を照合できる。
- [ ] `AC-003`: Tenant Aの承認付きwriteはactor、tenant、project、idempotency keyを保持し、作成・更新後の正本をreadbackできる。
- [ ] `AC-004`: Tenant A/Bを同時処理しても、session、file、credential、tool、結果、replyが混線しない。
- [ ] `AC-005`: Tenant Aのcredential、connection、requesterを使ってTenant Bのresourceへ到達できない。
- [ ] `AC-006`: 未登録workspace、失効connection、古いrevision、別appのeventをBrainbase業務APIより前に拒否する。
- [ ] `AC-007`: Tenant Aの利用上限到達はAだけを停止し、Tenant Bの正常処理を維持する。
- [ ] `AC-008`: Brainbase unavailable、partial、timeoutを0件または成功返信へ変換しない。
- [ ] `AC-009`: Slack再送、Queue retry、Container retryでもBrainbase writeとSlack replyを最大1回にする。
- [ ] `AC-010`: Cloud標準API、顧客OAuth、顧客APIの各経路で課金主体と失敗表示が契約どおりになる。
- [ ] `AC-011`: Cloud Brainbaseと互換OSSの双方で共通contract E2Eを通し、任意機能の差を明示する。
- [ ] `AC-012`: Cloudflare単独配送時は1 eventにつきCloudflareが1回返信し、旧runtimeや別deploymentが返信しない。

## Required E2E Matrix

1. Tenant Aの正常なtask／Graph read
2. Tenant Aの承認付きtask create、update、transitionと正本readback
3. Tenant A/Bの同時処理と同名user／channel／projectの分離
4. cross-tenant ID、credential、connection revision改ざんの拒否
5. 未登録workspaceの拒否
6. connection失効直後およびcache残存時の拒否
7. Tenant Aだけのquota warning／hard stop
8. Brainbase 5xx、timeout、partial response時の非成功表示
9. Slack retry／Queue retryによる二重write・二重reply防止
10. Cloud標準API、顧客OAuth、顧客APIのcredential／課金経路
11. shared Cloudflareとdedicated deploymentのcontract parity
12. Brainbase Cloudと互換OSSのcontract parity

## Evidence Receipt

各本番E2Eは次を秘密値なしで固定する。

- Git SHA、Worker version、Container image digest、Brainbase version
- Slack URL、event ID、team/workspace ID、app ID
- tenant ID、workspace connection IDとrevision、placement ID、requester person ID
- correlation ID、idempotency key、resolved credential mode
- Brainbase request scopeとwrite結果のcanonical readback
- usage／quota／billing Receipt IDとevidence state
- Slack reply timestampとreply count
- 旧runtimeまたは別deploymentのreply count

token、secret、OAuth credential本文、会話の不要な個人情報はReceiptへ含めない。

## Failure Semantics

- `not_found`、`ambiguous`、`revoked`、`scope_mismatch`、`quota_exceeded`、`upstream_unavailable`、`partial`、`retry_exhausted`を区別する。
- 未確認、未計測、timeout、部分取得を0件・0円・成功に丸めない。
- Slack返信に内部IDや秘密値を露出せず、管理者が次に行う再認証、契約確認、再試行を示す。

## Rollout and Rollback

1. fixtureとstagingでTenant A/Bのpositive／negative matrixを通す。
2. production canary tenantでread-only E2Eを通す。
3. 承認付きwriteとquota／credential経路を段階的に有効化する。
4. 同一eventの単独配送を確認してから旧runtimeを停止する。
5. 失敗時は該当tenantまたは機能flagだけを停止し、別tenantの正常経路を維持する。

rollbackはデータ越境や二重writeを起こさないことを優先し、未知の状態で別tenant／別credentialへ切り替えない。

## Completion Definition

次を別々に確認し、すべて揃った場合だけ完了とする。

- 文書: Story、Architecture、Spec、運用runbookが一致する。
- コード: tenant境界、credential router、quota、Receiptが実装される。
- テスト: 正常系、越境否定、retry、concurrency、failure semanticsが通る。
- 配備: 対象deployment、version、secret binding名を確認する。
- 本番: 実Slack eventからBrainbase readbackとreplyまで同一correlation IDで確認する。
- 原価: tenant別の外部請求と内部usage Receiptを照合する。
- 利用者成果: 顧客が対象業務を完了できたことを確認する。

health、CI、deploy、unit test、Slack reply 1件だけでは完了としない。

## Out of Scope

- Slack Marketplace掲載
- 個別顧客との価格・SLA交渉
- Storyで未定義の自動fallback
