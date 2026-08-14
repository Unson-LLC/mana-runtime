# Story: 議事録生成をBrainbase判断ライフサイクルへ接続する

## 利用者価値

Slackへ議事録ファイルを投稿した利用者として、Cloudflare Container内のClaudeが議事録を分類・生成するときも、Codexと同じBrainbase Judgment Resolverによる判断、必要なKnowledge Resolver参照、終了監査を必須にしたい。これによりBrainbaseを参照しない管理外の生成を防ぐ。

## 受け入れ条件

- [x] AC1: 議事録用ClaudeはBrainbase MCPだけを明示したstrict MCP configで起動する。
- [x] AC2: `UserPromptSubmit`、Brainbase MCPの`PostToolUse`、`Stop`をcommand HookでBrainbaseの正規入口へ送る。
- [x] AC3: Hook入口または判断処理が失敗した場合、Claude実行はfail closedとなり、管理外の議事録を保存・共有しない。
- [x] AC4: 同じClaude session内のHookは同じ`turn_id`を利用する。
- [x] AC5: SandboxへBrainbase bearer tokenを渡さず、Workerのsynthetic-host proxyだけが認証情報と`mana-runtime` project bindingを付与する。
- [x] AC6: 既存の議事録JSON解析、GitHub保存、タスク登録、Slack共有、および議事録以外のClaude実行契約を変更しない。

## 成功指標

- 議事録用Claude呼び出しの100%がBrainbase判断ライフサイクルを通過する。
- Brainbase障害時に管理外の議事録が保存・共有される件数は0件である。

## リリース条件

- Brainbase側の正規Hook APIを先にマージ・配備し、本番疎通を確認する。
- その後にmana側を配備し、実際の議事録で判断ライフサイクルからGitHub保存までのE2Eを行う。
