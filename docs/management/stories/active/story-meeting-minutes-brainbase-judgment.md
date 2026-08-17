# Story: 議事録生成をBrainbase判断ライフサイクルへ接続する

## 利用者価値

Slackへ議事録ファイルを投稿した利用者として、Cloudflare Workerが取得・検証したBrainbase Receiptを正本としてClaudeへ渡し、Container内の生成もCodexと同じBrainbase Judgment Resolverによる判断と終了監査を必須にしたい。これによりモデルがBrainbaseを再取得して認証や参照先を取り違えることなく、管理外の生成を防ぐ。

## 受け入れ条件

- [x] AC1: 議事録用Claudeは専用command Hook settingsとWorkerが検証したBrainbase Receiptで起動し、モデルからBrainbase MCPを呼び出せない。
- [x] AC2: `UserPromptSubmit`と`Stop`をcommand HookでBrainbaseの正規入口へ送り、将来明示的に許可したBrainbase toolを呼ぶ場合だけ`PostToolUse`も同じepisodeへ記録する。
- [x] AC3: Hook入口または判断処理が失敗した場合、Claude実行はfail closedとなり、管理外の議事録を保存・共有しない。
- [x] AC4: 同じClaude session内のHookは同じ`turn_id`を利用する。
- [x] AC5: SandboxへBrainbase bearer tokenを渡さず、Workerのsynthetic-host proxyだけがHook認証情報と`mana-runtime` project bindingを付与する。
- [x] AC6: 既存の議事録JSON解析、GitHub保存、タスク登録、Slack共有、および議事録以外のClaude実行契約を変更しない。
- [x] AC7: Receipt取得前の保存先自動判定も同じ議事録用Claude実行境界を使い、モデル用Brainbase MCPを公開せず、候補外・判定不能時は既存の手動選択へ戻す。

## 成功指標

- 議事録用Claude呼び出しの100%がBrainbase判断ライフサイクルを通過する。
- 議事録生成中のモデル起点Brainbase MCP呼び出しは0件である。
- Brainbase障害時に管理外の議事録が保存・共有される件数は0件である。

## リリース条件

- Brainbase側の正規Hook APIを先にマージ・配備し、本番疎通を確認する。
- その後にmana側を配備し、実際の議事録で判断ライフサイクルからGitHub保存までのE2Eを行う。
