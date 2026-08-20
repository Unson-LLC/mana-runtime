# Mana Cloud Runtime

`packages/cloud-runtime` は、Manaの現行Cloudflare-native実行基盤です。会社ごとに独立deploymentを作り、Slack Events API、Queue、Durable Objects、Cloudflare Computer / Sandbox、Claude Code、Brainbaseを接続します。

Jimmy / Jinn / OpenRyokoを基盤としたLightsail runtimeは廃止済みです。このpackageは移行互換レイヤーではなく、現行runtimeの正本です。

## Runtime flow

```text
Slack Events API / scheduled event / system event
                       |
                       v
               Cloudflare Worker
                       |
                 Queue / DLQ
                       |
                 Durable Objects
                       |
                       v
          Cloudflare Computer / Sandbox
                       |
                  Claude Code
                       |
                       v
          Brainbase APIs / trusted brokers
                       |
                       v
             action / Slack response
```

## Security boundary

- tenant / workspace / app / deployment境界はWorker設定とBrainbaseのcanonical contextから決定する。
- Slack本文やLLM出力からtenant/project/authorityを自己申告させない。
- provider credentialをWorkerやSandboxへ直接materializeしない。
- Anthropic OAuth、Slack Bot token等はBrainbase側のtrusted forwarding / credential boundaryを通す。
- Brainbase URL、token、署名鍵をSandbox promptやMCP設定へ露出しない。
- action authorityはBrainbaseのcompany authorityで確認し、不一致・取得不能はfail closedとする。

## Deployment profiles

同じruntime実装から独立したprofileを構築します。

- `wrangler.jsonc` — TechKnight deployment
- `wrangler.unson-business.jsonc` — 雲孫事業運営 deployment
- `wrangler.dedicated-cloud.jsonc` — dedicated cloud profile
- `wrangler.customer-managed-oss.jsonc` — customer-managed profile

会社間でSlack App、Queue/DLQ、Durable Object、Computer/Sandbox、provider credential、Brainbase authority contextを共有しません。

### 本番切替の安全境界

- `BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN` はBrainbase専用内部forward serviceの認証用Cloudflare secretとして設定し、設定ファイルやログへ出さない。
- task searchの初期値は `RUNTIME_TASK_SEARCH_ENABLED=false` とし、権限・テナント境界を確認してからONへ切り替える。
- ON切替後の最初の境界付き`search_tasks` probeを記録し、本番Slackで既知タスクを検索してBrainbase正本と照合する。
- 証跡にはWorker version、Container image digest、Git SHAを残す。テストやContainer healthだけをSlack E2E完了とは扱いません。
- Cloudflareを正本へ切り替えた後は、旧配置を `mana-accounting.enabled=false`、`taskCanvas.enabled=false` とし、二重応答・二重実行を防ぐ。
- `GITHUB_TOKEN` を除去する前に `meetingMinutesPipeline.destination.github` の残存利用を確認し、議事録pipelineを停止しない。
- secret設定、切替、旧runtime停止は別々に証跡を残し、Workerの配備成功だけで切替完了としない。

## Local verification

```bash
pnpm -C packages/cloud-runtime test
pnpm -C packages/cloud-runtime typecheck
pnpm -C packages/cloud-runtime build
pnpm -C packages/cloud-runtime build:unson-business
```

`build`系はWrangler dry-runを使用し、明示的なdeploy command以外では本番resourceを変更しません。

## Observability

Slack turnはPIIやcredential本文をログへ残さず、trace/event IDを軸に工程を追跡します。主要eventは次です。

- `mana_turn_received`
- `mana_placement_resolved`
- `mana_thread_context_hydrated`
- `mana_identity_context`
- `mana_claude_started` / `mana_claude_completed` / `mana_claude_failed`
- `mana_task_search_started` / `mana_task_search_completed` / `mana_task_search_failed`
- `mana_slack_reply_posted`
- `mana_turn_completed` / `mana_turn_failed`

本番rollout、task search/write、meeting minutes、credential broker、production verificationの具体的記録は `../../docs/operations/` を正本とします。

## Development runner

Cloudflare Computer内のdevelopment runnerはManaのworker executionであり、Mana自身の正本ではありません。VibePro / Claude Code等を用いて隔離worktreeで実装を行い、authorityとgateを越えたpush / merge / deployを自動許可しません。

## Product boundary

- Brainbase: memory、organization state、ontology、provenance、authority、Memory Loop
- Mana: prioritization、judgment、action、follow-through、Operating Loop
- Claude Code / Codex: Manaが必要に応じて起動するworker

詳細は [`../../docs/architecture/mana-operating-loop-product-boundary.md`](../../docs/architecture/mana-operating-loop-product-boundary.md) を参照してください。
