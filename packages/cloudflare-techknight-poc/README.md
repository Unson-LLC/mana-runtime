# TechKnight Cloudflare Computer PoC

TechKnight専用のCloudflare実行環境です。Slack Events APIで受けたイベントを
署名・workspace境界で検証し、Queue、Durable Object、`@cloudflare/computer` Workspaceへ
冪等に保存します。許可したチャンネルのメンションはTechKnight専用SandboxのClaude Codeで
処理し、既存の八雲まなSlack Appから元スレッドへ返信します。Anthropic OAuthとSlack Bot
tokenはContainerへ保存せず、Worker Secretの境界内でだけ使用します。

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
6. 推測されにくい値を`SANDBOX_PROBE_TOKEN` Secretとして設定する。
7. TechKnight側で`claude setup-token`を実行して得た値だけを
   `CLAUDE_CODE_OAUTH_TOKEN` Secretとして設定する。Unson側のTokenは流用しない。
8. 認証付き`POST /admin/sandbox/runtime-probe`でClaude Codeの起動を確認する。
9. 認証付き`POST /admin/sandbox/oauth-probe`を2回実行する。各回は新規Containerを使い、
   OAuthがWorker Secretから復帰することを確認する。
10. 八雲まなAppのBot tokenを`SLACK_BOT_TOKEN` Secretとして設定する。
11. `SLACK_ALLOWED_CHANNEL_ID`のチャンネルで八雲まなへメンションし、元スレッドへの返信と
    `techknight_slack_reply`の完了ログを確認する。

WranglerがUnson accountを示す場合はデプロイしません。secret値は設定ファイル、ログ、
テストfixture、永続Workspaceへ書き込みません。

## Sandbox security boundary

Sandboxの一般インターネット接続は無効で、Anthropic APIだけを許可します。OAuth Tokenと
検証用TokenはContainerの環境変数・ファイル・応答に出しません。検証APIは固定コマンドだけを
実行し、任意shellや任意promptは受け付けません。検証のたびにContainerを破棄します。
