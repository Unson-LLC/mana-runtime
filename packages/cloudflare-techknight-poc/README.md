# 会社別Cloudflare mana-runtime

会社ごとに独立デプロイするCloudflare実行環境です。Slack Events APIで受けたイベントを
署名・workspace境界で検証し、Queue、Durable Object、`@cloudflare/computer` Workspaceへ
冪等に保存します。許可したチャンネルのメンションは会社別SandboxのClaude Codeで
処理し、各社の八雲まなSlack Appから元スレッドへ返信します。Anthropic OAuthとSlack Bot
tokenはContainerへ保存せず、会社別Worker Secretの境界内でだけ使用します。

一般返信のタスク検索は、Sandbox内の検索専用stdio MCPから合成host
`task-search.internal`だけを呼び、Workerが固定のBrainbase検索APIへ中継します。
Brainbase URL、Token、project bindingはSandbox、MCP設定、promptへ渡しません。

一般返信のタスク書き込みは、Sandbox内の専用stdio MCPから合成host
`task-write.internal`だけを呼びます。WorkerがSlack依頼者、workspace、`mana-accounting`
Placement、`back-office` project、操作、期限、最大回数を署名し、Brainbase認証と冪等キーを
再構築します。Sandboxへ署名鍵やBrainbase Tokenは渡しません。

同じ実装を次の完全に分離されたdeploymentで利用します。

- `wrangler.jsonc`: TechKnight
- `wrangler.unson-business.jsonc`: 雲孫事業運営

Worker、Queue、DLQ、Durable Object、Container、Slack認証、Anthropic OAuth、Brainbase認証は
deploymentごとに分離します。内部のbinding/class名に残る`TECHKNIGHT_`は後方互換名であり、
Cloudflare resource自体を共有するものではありません。

Slack Appもdeploymentごとに分離します。LightsailでSocket Modeを使う既存Appの接続方式は
変更せず、Cloudflareには同じ表示名「八雲まな」の専用Appを新設してHTTP Events APIだけを
接続します。Slackのイベント配送方式はApp単位なので、同じAppをLightsailとCloudflareで
共用しません。

既存Lightsail、Slack Socket Modeはこのパッケージから自動変更しません。Cloudflare側では、明示的に
「議事録」と「タスク」を含むメンションをClaudeで候補化し、設定済みprojectへ
Brainbaseの正規タスクとして登録します。tenant、workspace、channel、projectの境界は
Worker設定から決定し、Slack本文やClaude出力からは受け付けません。

## Local verification

```bash
pnpm --filter @openryoko/cloudflare-techknight-poc test
pnpm --filter @openryoko/cloudflare-techknight-poc typecheck
pnpm --filter @openryoko/cloudflare-techknight-poc build
pnpm --filter @openryoko/cloudflare-techknight-poc build:unson-business
```

`build`は`wrangler deploy --dry-run`であり、Cloudflare resourceを作成しません。

## 一般返信の追跡ログ

雲孫deploymentはWorkers Logsを100%保存し、一般返信の各工程を構造化JSONで記録します。
Slack本文、thread context、検索語、人名、task本文、token、認証headerは記録しません。

最初にSlack URLから`channelId`と`messageTs`を取り、CloudflareのObservabilityで検索します。

```text
channelId = "<SLACK_CHANNEL_ID>" AND messageTs = "<SLACK_MESSAGE_TS>"
```

見つかった`traceId`（Slackのevent ID）で絞ると、同じターンの次のeventを確認できます。

- `mana_turn_received`: Workerが受理した実行version、model、effort
- `mana_placement_resolved`: placement、許可project、書き込み可否
- `mana_identity_context`: Slack actorをClaudeへ渡したかどうか
- `mana_thread_context_hydrated`: thread contextの有無と文字数
- `mana_claude_started` / `mana_claude_completed` / `mana_claude_failed`: 実効model、effort、所要時間、結果
- `mana_task_search_started` / `mana_task_search_completed` / `mana_task_search_failed`: 検索回数、件数、完全性、実効project範囲
- `mana_slack_reply_posted`: Slack返信timestamp
- `mana_turn_completed` / `mana_turn_failed`: ターン全体の最終結果

```text
traceId = "Ev..."
```

`mana_task_search_*`の`scopeMatches=false`は、placementが期待したproject範囲とWorker proxyが
実際に検索したproject範囲が一致していないことを示します。0件応答の調査では
`resultCount`だけでなく、`expectedProjectCodes`、`effectiveProjectCodes`、`readStatus`を
必ず一緒に確認します。

## タスク検索の段階展開

`RUNTIME_TASK_SEARCH_ENABLED`は未設定または`false`ならOFFです。次の二段階を崩さず、
Worker version、Container image digest、Git SHAを各段階の記録へ残します。

1. `RUNTIME_TASK_SEARCH_ENABLED=false`のままWorkerと検索MCP入りContainerをデプロイする。
2. Containerがready/healthyであり、検索MCPを同梱したimageであることを確認する。
   フラグOFF中はWorker proxyが検索を拒否するため、検索成功を要求しない。
3. 対象deploymentだけを`RUNTIME_TASK_SEARCH_ENABLED=true`へ変更して再デプロイする。
4. ON切替後の最初の境界付き`search_tasks` probeを記録し、本番Slackで既知タスク、
   複数project、0件、部分結果をBrainbase正本と照合する。

異常時は最初にフラグを`false`へ戻し、MCPなしの一般返信へ切り戻します。必要なら記録済みの
known-good Worker versionへrollbackします。rollbackが完了するまで以前のContainer imageを
削除しません。テストやContainer healthだけをSlack E2E完了とは扱いません。

2026-08-13の雲孫deployment記録は
[`docs/operations/cloudflare-task-search-rollout-2026-08-13.md`](../../docs/operations/cloudflare-task-search-rollout-2026-08-13.md)
を参照してください。

## タスク書き込みとCanvasの段階展開

`RUNTIME_TASK_WRITE_ENABLED` と `RUNTIME_TASK_BOARD_ENABLED` は既定OFFです。

1. `unson-business-mana-task-board-repairs` とDLQを作成する。
2. 32 byte以上のランダム値を `TASK_WRITE_CAPABILITY_SECRET` としてWrangler Secretへ設定する。
   値は設定ファイル、ログ、Sandboxへ出さない。
3. 両フラグOFFのままWorkerとContainerを配備し、health、Worker version、Container image digest、Git SHAを記録する。
4. `RUNTIME_TASK_WRITE_ENABLED=true` だけを先に反映し、同一Slackスレッドで検索、作成、更新、状態遷移を1件ずつ実行する。各結果をBrainbaseのtask ID/versionと照合する。
5. `RUNTIME_TASK_BOARD_ENABLED=true` を反映し、Queue修復後のCanvasを確認する。20件を超える場合は「20件以上（続きあり）」と表示し、全ページ取得しない。
6. E2E成功後、Lightsailの `mana-accounting.enabled=false` と同Placementの `taskCanvas.enabled=false` を同じ設定変更で反映する。

異常時はCloudflareの書き込みとCanvasを先にOFFにし、その後LightsailのPlacementとCanvasを
同時にONへ戻します。CloudflareとLightsailを同時に主系として動かしません。

## デプロイ前確認

最初に対象会社とWrangler設定を固定します。

| 対象 | Cloudflare account | Wrangler設定 | Anthropic OAuth |
| --- | --- | --- | --- |
| TechKnight | TechKnight所有account | `wrangler.jsonc` | TechKnight専用 |
| 雲孫事業運営 | 雲孫所有account | `wrangler.unson-business.jsonc` | 雲孫専用 |

`npx wrangler whoami`のaccountと上表が一致しない場合はデプロイしません。会社間でSlack、
Anthropic OAuth、BrainbaseのTokenを流用しません。そのうえで次を実施します。

1. 対象設定の`SLACK_EXPECTED_TEAM_ID`と`SLACK_ALLOWED_CHANNEL_ID`を確認する。
   雲孫pilotではさらに`SLACK_EXPECTED_APP_ID`を必須とする。既存TechKnight deploymentは
   後方互換のためこのStoryではApp ID固定の対象外とし、専用App ID確認後に有効化する。
2. 対象deployment専用Slack AppのSigning Secretを
   対象のWrangler設定を`--config`で明示した`wrangler secret put`で設定する。
   既存Socket Mode Appは流用しない。
3. Queue、Durable Object、Workerが対象会社のaccountに作られることをdry-run出力で確認する。
4. 対象会社のAnthropic OAuthだけを`CLAUDE_CODE_OAUTH_TOKEN` Secretとして設定する。
5. 対象のWrangler設定を明示したdeploy scriptを実行し、Slack URL verificationと
   重複eventの永続化を確認する。
6. 推測されにくい値を`SANDBOX_PROBE_TOKEN` Secretとして設定する。
7. 認証付き`POST /admin/sandbox/runtime-probe`でClaude Codeの起動を確認する。
8. 認証付き`POST /admin/sandbox/oauth-probe`を2回実行する。各回は新規Containerを使い、
   OAuthがWorker Secretから復帰することを確認する。
9. 対象会社の八雲まなAppのBot tokenを`SLACK_BOT_TOKEN` Secretとして設定する。
10. `SLACK_ALLOWED_CHANNEL_ID`のチャンネルで八雲まなへメンションし、元スレッドへの返信と
    `techknight_slack_reply`の完了ログを確認する。
11. 正式なBrainbase project codeを確認し、`RUNTIME_PROJECT_CODES`へカンマ区切りで設定する。
    未設定時はタスク登録を行わず`project_binding_missing`で停止する。
12. BrainbaseのタスクAPI URLを`BRAINBASE_TASK_API_BASE_URL`、サービスTokenを
    `BRAINBASE_TASK_API_TOKEN` Secretとして設定する。Token値はWrangler設定へ書かない。
13. 許可チャンネルで「議事録」と「タスク」を含むメンションを送り、Brainbase正本の
    `project_codes`とSlackの同一スレッドへの登録結果を照合する。
14. PR #120を含むLightsail releaseでは `GITHUB_TOKEN` をsecretとして設定し、
    `meetingMinutesPipeline.destination.github` のowner/repo/baseBranch/pathTemplateを確認する。
    GitHub保存の本番確認が終わるまで議事録pipelineを停止しない。タスク運用の切替では
    `mana-accounting` Placementとその `taskCanvas` だけを無効化し、議事録pipelineの
    Cloudflare移植または別所有者への移管は独立した完了証跡で閉じる。

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

Wranglerが対象設定と異なる会社のaccountを示す場合はデプロイしません。secret値は設定ファイル、ログ、
テストfixture、永続Workspaceへ書き込みません。

## 雲孫事業運営pilot

雲孫のCloudflare accountで`wrangler.unson-business.jsonc`を使用します。最初のbindingは
Slack workspace `T0882T8N9UH`、`9960-back-office` (`C0BKS6RL99T`)、Brainbase project
`back-office`です。初回は`reply_only`でデプロイし、署名検証、Queue、Sandbox、同一スレッド
返信を確認します。Slack AppはCloudflare専用App `A0BPM2J33SN`を使用し、Lightsailの
Socket Mode App `A0BLS5WEL2J`には変更を加えません。議事録タスクの所有権はLightsail入口の停止を確認した後だけ
`meeting_tasks`へ切り替えます。

```bash
pnpm --filter @openryoko/cloudflare-techknight-poc build:unson-business
npx wrangler secret put SLACK_SIGNING_SECRET --config wrangler.unson-business.jsonc
npx wrangler secret put CLAUDE_CODE_OAUTH_TOKEN --config wrangler.unson-business.jsonc
npx wrangler secret put SANDBOX_PROBE_TOKEN --config wrangler.unson-business.jsonc
npx wrangler secret put SLACK_BOT_TOKEN --config wrangler.unson-business.jsonc
npx wrangler secret put BRAINBASE_TASK_API_TOKEN --config wrangler.unson-business.jsonc
npx wrangler secret put TASK_WRITE_CAPABILITY_SECRET --config wrangler.unson-business.jsonc
pnpm --filter @openryoko/cloudflare-techknight-poc deploy:unson-business
```

## Sandbox security boundary

Sandboxの一般インターネット接続は無効で、Anthropic APIと固定の検索合成hostだけを許可します。OAuth Tokenと
検証用TokenはContainerの環境変数・ファイル・応答に出しません。検証APIは固定コマンドだけを
実行し、任意shellや任意promptは受け付けません。検証のたびにContainerを破棄します。
