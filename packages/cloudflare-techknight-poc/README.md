# TechKnight Cloudflare Computer PoC

TechKnight専用のCloudflare実行環境です。Slack Events APIで受けたイベントを
署名・workspace境界で検証し、Queue、Durable Object、`@cloudflare/computer` Workspaceへ
冪等に保存します。許可したチャンネルのメンションはTechKnight専用SandboxのClaude Codeで
処理し、既存の八雲まなSlack Appから元スレッドへ返信します。Anthropic OAuthとSlack Bot
tokenはContainerへ保存せず、Worker Secretの境界内でだけ使用します。

既存Lightsail、Slack Socket Modeはこのパッケージから自動変更しません。Cloudflare側では、明示的に
「議事録」と「タスク」を含むメンションをClaudeで候補化し、設定済みprojectへ
Brainbaseの正規タスクとして登録します。tenant、workspace、channel、projectの境界は
Worker設定から決定し、Slack本文やClaude出力からは受け付けません。

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
12. 正式なBrainbase project codeを確認し、`RUNTIME_PROJECT_CODES`へカンマ区切りで設定する。
    未設定時はタスク登録を行わず`project_binding_missing`で停止する。
13. BrainbaseのタスクAPI URLを`BRAINBASE_TASK_API_BASE_URL`、サービスTokenを
    `BRAINBASE_TASK_API_TOKEN` Secretとして設定する。Token値はWrangler設定へ書かない。
14. 許可チャンネルで「議事録」と「タスク」を含むメンションを送り、Brainbase正本の
    `project_codes`とSlackの同一スレッドへの登録結果を照合する。

### 議事録タスク処理の所有権切替

`RUNTIME_EXECUTION_MODE`が`meeting_tasks`と完全一致するまで、Cloudflareは議事録タスク依頼を
処理しません。この値は二重実行を避けるため、次の順序で最後に設定します。

1. 対象workspace/channelを記録し、LightsailのplacementまたはSlack App購読から同じ入口を外す。
2. Lightsail側で対象channelの新規イベントが処理されないことをログで確認する。
3. `RUNTIME_PROJECT_CODES`と3種類の会社別secretを確認する。
4. `RUNTIME_EXECUTION_MODE=meeting_tasks`を設定してCloudflareをデプロイする。
5. 新しいevent IDで1件だけ実機確認し、Brainbase task IDとSlack返信を照合する。

切戻しは逆順で、先にCloudflareの`RUNTIME_EXECUTION_MODE`を削除してからLightsailの入口を
戻します。両runtimeを同時に有効化しません。現在の`wrangler.jsonc`は安全側の
`RUNTIME_EXECUTION_MODE=reply_only`なので、コードをデプロイしただけでは議事録タスク登録を開始しません。

WranglerがUnson accountを示す場合はデプロイしません。secret値は設定ファイル、ログ、
テストfixture、永続Workspaceへ書き込みません。

## Sandbox security boundary

Sandboxの一般インターネット接続は無効で、Anthropic APIだけを許可します。OAuth Tokenと
検証用TokenはContainerの環境変数・ファイル・応答に出しません。検証APIは固定コマンドだけを
実行し、任意shellや任意promptは受け付けません。検証のたびにContainerを破棄します。
