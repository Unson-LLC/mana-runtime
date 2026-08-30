# Story: 議事録生成をBrainbase判断ライフサイクルへ接続する

## 利用者価値

Slackへ議事録ファイルを投稿した利用者として、Cloudflare Workerが取得・検証したBrainbase Receiptを正本としてClaudeへ渡し、Container内の生成もCodexと同じBrainbase Judgment Resolverによる判断と終了監査を必須にしたい。これによりモデルがBrainbaseを再取得して認証や参照先を取り違えることなく、管理外の生成を防ぐ。

## 受け入れ条件

- [x] AC1: 議事録用Claudeは専用command Hook settingsとWorkerが検証したBrainbase Receiptで起動し、モデルからBrainbase MCPを呼び出せない。
- [x] AC2: `UserPromptSubmit`と`Stop`をcommand HookでBrainbaseの正規入口へ送り、将来明示的に許可したBrainbase toolを呼ぶ場合だけ`PostToolUse`も同じepisodeへ記録する。
- [x] AC3: Hook入口または判断処理が失敗した場合、Claude実行はfail closedとなり、管理外の議事録を保存・共有しない。
- [x] AC4: 同じClaude session内のHookは同じ`turn_id`を利用する。
- [x] AC5: SandboxへBrainbase bearer tokenを渡さず、Workerのsynthetic-host proxyだけがHook認証情報と`mana-runtime` project bindingを付与する。
- [x] AC6: 既存の議事録JSONは必須6キー、未知キー拒否、型・列挙値・長さ上限を決定的に検証し、GitHub保存、タスク登録、および議事録以外のClaude実行契約を変更しない。Slack共有の先頭にはHostが生成した監査行を原文・順序・回数どおり表示する。
- [x] AC7: Receipt取得前の保存先自動判定も同じ議事録用Claude実行境界を使い、モデル用Brainbase MCPを公開せず、候補外・判定不能時は既存の手動選択へ戻す。
- [x] AC8: Judgment Stopが要求する監査行とJSON Schemaを同じ最終回答へ強制しない。生成はHook event付きstreamを使い、最終回答先頭の監査行がStop応答と完全一致した場合だけ、後続JSONを決定的に解析して保存・共有する。新規生成と保存済みrunの再開のどちらでも、欠落・改変・重複回数差・余分な監査行は外部副作用より前にfail closedにする。

## 成功指標

- 議事録用Claude呼び出しの100%がBrainbase判断ライフサイクルを通過する。
- 議事録生成中のモデル起点Brainbase MCP呼び出しは0件である。
- Brainbase障害時に管理外の議事録が保存・共有される件数は0件である。

## リリース条件

- Brainbase側の正規Hook APIを先にマージ・配備し、本番疎通を確認する。
- その後にmana側を配備し、実際の議事録で判断ライフサイクルからGitHub保存までのE2Eを行う。
