# TechKnight Cloudflare Computer PoC

TechKnight専用のCloudflare境界を検証するPoCです。Slack Events APIで受けたイベントを
署名・workspace境界で検証し、Queue、Durable Object、`@cloudflare/computer` Workspaceへ
冪等に保存します。

既存Lightsail、Slack Socket Mode、Brainbase task pipelineは変更しません。

## Local verification

```bash
pnpm --filter @openryoko/cloudflare-techknight-poc test
pnpm --filter @openryoko/cloudflare-techknight-poc typecheck
pnpm --filter @openryoko/cloudflare-techknight-poc build
```

`build`は`wrangler deploy --dry-run`であり、Cloudflare resourceを作成しません。

## Deployment gate

デプロイ前に、次を実施します。

1. `npx wrangler whoami`でTechKnight所有のCloudflare accountであることを確認する。
2. `wrangler.jsonc`の`SLACK_EXPECTED_TEAM_ID`をTechKnight Slack team IDに置き換える。
3. TechKnight accountで`npx wrangler secret put SLACK_SIGNING_SECRET`を実行する。
4. Queue、Durable Object、WorkerがTechKnight accountに作られることをdry-run出力で確認する。
5. `npx wrangler deploy`を実行し、Slack URL verificationと重複eventの永続化を確認する。

WranglerがUnson accountを示す場合はデプロイしません。secret値は設定ファイル、ログ、
テストfixture、永続Workspaceへ書き込みません。

## Next phase

Cloudflare Computerはプレビュー段階のため、このPoCでは永続Workspaceだけを利用します。
実Cloudflare上で境界と永続性を確認した後、TechKnight専用ContainerにClaude CLIを置き、
Anthropic OAuthがUnson側と共有されないことを検証します。
