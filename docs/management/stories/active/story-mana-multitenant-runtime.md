---
story_id: story-mana-multitenant-runtime
title: 八雲まなをテナント分離されたSlackランタイムとして提供する
status: active
created_at: 2026-08-16
updated_at: 2026-08-16
horizon: quarter
view: product
source:
  type: business-design
  repository: Unson-LLC/brainbase-project
  path: docs/business/brainbase-mana-multitenant-v1/05-story-boundaries.md
architecture_reason: "ADR必須。Slack installation、Cloudflare Worker／Queue／Durable Object／Container、credential routing、課金帰属、shared／dedicated deploymentの信頼境界を変更するため。"
architecture_docs:
  - path: docs/architecture/story-mana-multitenant-runtime.md
    status: accepted
spec_docs:
  - path: docs/specs/story-mana-multitenant-runtime.vibepro.json
    status: required_not_started
related:
  - https://github.com/Unson-LLC/vibepro/issues/466
  - Unson-LLC/brainbase-unson:story-brainbase-multitenant-platform
  - story-slack-mana-brainbase-multitenant-e2e
---

# 八雲まなをテナント分離されたSlackランタイムとして提供する

## User Story

八雲まなを導入する顧客管理者として、非掲載Slackアプリを自組織のBrainbaseへ安全に接続し、他顧客の会話、session、ファイル、credential、利用量と混ざらない状態で利用したい。そうすれば、共有Cloudflare基盤を利用しても専用環境と同等のデータ境界を保ち、契約に応じたAI認証方式と利用上限を選べる。

## Business Context

現行Cloudflare実装はworkspace、channel、placementを主な配置境界としているが、契約主体としてのcanonical tenant、workspace connection、tenant別credential、利用量帰属を一貫して伝播するcontractがない。単一のsecretや`.credentials.json`を共有SaaS経路で使うと、顧客別の失効、課金、障害、専用環境への切替を安全に表現できない。

## Delivery Boundary

このStoryはmana-runtimeが所有する次の5領域を完了させる。

1. 非掲載Slackアプリ導入
2. Tenant Context伝播
3. テナント分離実行面
4. AI Credential Router
5. 利用上限・原価計測

Brainbaseのcanonical tenant、workspace connection正本、契約、共通Cloud／OSS APIはBrainbase Storyが所有する。両システムをまたぐ利用者成果は別Story `story-slack-mana-brainbase-multitenant-e2e`で完了判定する。

## Success Metrics

- 受信イベントの100%でtenant、workspace connection、placement、requester、correlation IDを確定または明示拒否する。
- cross-tenant fallback、session混線、credential混線、二重writeを0件にする。
- AI、tool、Container、retry原価のtenant帰属率を100%にする。未計測は別状態として残す。
- shared Cloudflareとdedicated deploymentで同じ外部contract testを通す。
- installation、再認証、失効、アンインストールの運用Receiptを残す。

## Acceptance Criteria

**非掲載Slackアプリ導入**

- [ ] `AC-001`: OAuth installationをBrainbaseの`workspace_connection`へ登録し、tenantをworkspace IDから推測しない。
- [ ] `AC-002`: app ID、team/workspace ID、enterprise ID、installer、scope、revision、statusを検証する。
- [ ] `AC-003`: 再認証、scope変更、アンインストール、connection失効を処理する。
- [ ] `AC-004`: 未契約、未登録、失効、別app、scope不足のworkspaceをLLM実行前に拒否する。
- [ ] `AC-005`: token本文を設定ファイル、Queue、DO、Container入力、通常ログ、Receiptへ出さない。

**Tenant Context伝播**

- [ ] `AC-101`: Slack入口でBrainbaseのworkspace connectionからcanonical tenantを解決する。
- [ ] `AC-102`: tenant ID、connection ID/revision、workspace、channel、placement、requester、correlation IDを型付きenvelopeで伝播する。
- [ ] `AC-103`: Worker、Queue consumer、Durable Object、Container、MCP、Brainbase proxy、Slack deliveryの各境界でenvelopeを再検証する。
- [ ] `AC-104`: tenant未解決、不一致、改ざん、古いrevision、複数一致でdefault tenantや別placementへfallbackしない。
- [ ] `AC-105`: Queue再送時も同一tenant・event・operation単位で冪等性を維持する。

**テナント分離実行面**

- [ ] `AC-201`: DO key、session、thread history、file/object key、cache、workspace、MCP config、secret handleをtenantで分離する。
- [ ] `AC-202`: Container再利用時は前tenantのprocess、filesystem、environment、credential、transcriptを残さない。
- [ ] `AC-203`: shared、dedicated、customer-hostedのdeployment profileを明示し、暗黙の特権差を作らない。
- [ ] `AC-204`: tenant A/Bの同時処理、同名workspace/channel/user、再送、Container再利用による越境を否定テストする。
- [ ] `AC-205`: 添付ファイルと一時オブジェクトにtenant scope、size/MIME制限、保持期限、削除証跡を持たせる。

**AI Credential Router**

- [ ] `AC-301`: tenantの契約によりCloud標準API、顧客OAuth、顧客API credentialを決定論的に選択する。
- [ ] `AC-302`: credentialはtenant別secret storeのopaque handleとして解決し、モデルや通常ログへ渡さない。
- [ ] `AC-303`: OAuth資格情報をtenant単位で保存、更新、失効し、更新競合を監査する。
- [ ] `AC-304`: 認証失敗時に別方式、運営者credential、別tenantへfallbackしない。
- [ ] `AC-305`: 現行の単一`.credentials.json`前提を共有SaaS実行経路から除く。

**利用上限・原価計測**

- [ ] `AC-401`: token、model、tool、MCP、Container時間、storage、retryをcorrelation IDとtenantへ帰属させる。
- [ ] `AC-402`: 50%、80%、100%等の警告とhard stop／超過許可をBrainbase planから適用する。
- [ ] `AC-403`: Tenant Aの上限到達でTenant Bの処理を止めない。
- [ ] `AC-404`: AIやtoolが失敗した場合も実消費を記録し、未計測を0に丸めない。
- [ ] `AC-405`: Slackへは契約・credential・上限の内部情報を漏らさず、利用者が次の行動を選べる失敗表示を返す。

## Scenarios

- `MAMT-S-001`: 契約済みworkspaceをインストールすると、正しいworkspace connectionとtenantへ登録される。
- `MAMT-S-002`: 未登録workspaceのeventはQueue投入またはLLM起動前に拒否される。
- `MAMT-S-003`: Tenant A/Bが同時に同文を送っても、別DO/session/credential/Brainbase scopeで処理される。
- `MAMT-S-004`: Tenant Aの署名済みevent envelopeを書き換えてTenant Bを指定すると再検証で拒否される。
- `MAMT-S-005`: ContainerがTenant Aの後にTenant Bへ再利用されても、Aのfile、env、conversationを参照できない。
- `MAMT-S-006`: 顧客OAuthが失効した場合、Cloud標準APIへ自動fallbackせず再認証を案内する。
- `MAMT-S-007`: Tenant Aだけが利用上限へ到達した場合、Aを停止しBは継続する。

## Implementation Slices

1. Slack installation／uninstallation adapterとworkspace connection連携
2. tenant context envelopeと全boundary validator
3. DO、Queue、Container、object、sessionのpartitioning
4. tenant secret storeとAI Credential Router
5. usage meter、quota decision、Brainbase Receipt連携
6. shared／dedicated／customer-hosted deployment profiles
7. 運用監査、障害分類、回復runbook

## Evidence and Completion

- VibePro ArchitectureとSpecが全boundary、failure semantics、deployment variantを明記する。
- unit、integration、concurrency、retry、cross-tenant negative testが同一HEADで成功する。
- 対象Cloudflare deployment ID、Worker version、Container image digestをreadbackする。
- credential値を含まないinstallation、execution、usage Receiptを確認する。
- 実Slack E2EとBrainbase readbackは統合Storyで確認する。

## Out of Scope

- Slack Marketplaceへの一般公開
- Brainbaseのtenant schema、契約正本、Cloud／OSS API実装
- 個別顧客の価格決定
