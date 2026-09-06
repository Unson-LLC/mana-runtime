# Architecture: 議事録生成のBrainbase判断ライフサイクル

> 履歴文書：このHook経由の生成設計は後続の修正で廃止済みです。現行のWorker検証Receiptと工程再開の責務は[議事録の工程別再開](meeting-minutes-stage-resume.md)を参照してください。この文書の配備手順は現行手順ではありません。

## 決定

Claude Codeのcommand Hooksを薄い転送層としてContainerへ配置する。判断、知識参照要求、tool journal、Stop監査の正本はBrainbaseの既存`processHookPayload`に置き、manaへ複製しない。

## データフロー

0. Receipt取得前の保存先自動判定は、候補一覧と文字起こしだけを議事録用Claudeへ渡す。モデル用Brainbase MCPは公開せず、候補外・判定不能時は既存の手動選択へ戻す。
1. WorkerがBrainbaseから正規の議事録文脈Receiptを取得・検証し、その内容とidentityを議事録promptへ固定してSandboxへ書く。モデル用Brainbase MCP configは書かない。
2. Claude Codeは専用settingsを読み、`UserPromptSubmit`を転送する。
3. Sandboxのsynthetic host proxyがBearerと`mana-runtime` bindingを付け、Brainbaseへ送る。
4. Claudeはpromptへ注入された検証済みReceiptだけを文脈として使い、Brainbase MCPを直接呼ばない。
5. `Stop`で監査を検証する。将来明示的に許可したBrainbase toolを呼ぶ場合は`PostToolUse`も同じepisodeへ記録する。不足時はblockしてClaudeを継続させる。
6. completeな終了だけを既存JSON parserへ渡し、GitHub保存・タスク登録・Slack共有へ進む。

## 信頼境界

- SandboxへBrainbase tokenを渡さない。
- 議事録用ClaudeへBrainbase MCPを公開せず、文脈取得の認証・project binding・Receipt検証はWorkerで完結させる。
- synthetic hostは`/mcp`と`/host/judgment/hook`以外を拒否する。
- Sandbox由来のproject headerを削除し、Workerが`mana-runtime`へ固定する。
- Hook stdinは1 MiBを上限とする。redirect、timeout、非2xx、不正JSON、turn identity欠落はfail closedにする。
- Brainbase応答のversion、accepted marker、event、session、turnが要求と一致しない場合もfail closedにする。
- `PostToolUse`は非空の監査記録receiptがない応答を拒否し、未記録のtool useを成功扱いしない。

## 配備順序

1. Brainbase側の`POST /host/judgment/hook`を先にマージ・配備する。
2. 認証ありの正常応答、認証なしの拒否、既存MCPの非回帰を本番で確認する。
3. その確認後にmana側を配備する。順序を逆にするとHookが非2xxとなり、fail closedにより議事録生成は開始されない。
4. mana側で実際の議事録1件を使い、Worker Receipt取得、判断開始、モデル起点MCP呼び出し0件、終了監査、GitHub保存までをE2E確認する。

どちらの配備もこのPRの自動処理には含めない。

## 非対象

- Judgment Resolverの規則をmanaへ移植すること。
- 議事録以外のClaude実行へ今回のHookを広げること。
- 本変更だけで本番切替やLightsail停止を行うこと。
