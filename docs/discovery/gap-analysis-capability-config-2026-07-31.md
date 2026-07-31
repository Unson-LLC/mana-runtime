# 能力設定の一元化 — あるべき姿と現状のギャップ調査（2026-07-31）

**契機**: freee MCP接続（2026-07-31）で、能力を1つ追加するのに**4箇所の登録+gateway再起動**が必要で、1箇所欠けるごとに異なる症状（無言拒否→don't askブロック→モデルの自主拒否→再びブロック)で3連続の障害になった。roadmap柱1「placement設定の一元化」の実地調査。

## あるべき姿（1行）

**能力の正本はplacementの`capabilities`ただ1箇所。ツール許可・ソフト境界宣言・エンジンへのバインドはすべてそこから導出され、設定変更は再起動なしで反映される。**

これはADR-0004（第二の権限体系を発明しない）のランタイム内への適用でもある: capabilitiesという正本があるのに、interactiveAllowedTools・dataScopes・route対応表という「第二・第三の正本」を手で同期している状態が現状。

## 現状: 能力追加時に触る場所のインベントリ（実測）

### MCPサーバーを1つ追加する場合（freeeで実測）

| # | 登録先 | 層 | バインド時点 | 欠けた時の症状 |
|---|---|---|---|---|
| 1 | `mcp.custom.<name>`（カタログ: command/env） | 存在定義 | セッション毎 | ツールが存在しない |
| 2 | placement `capabilities.mcp` | ハード境界 | セッション毎 | `mcp_denied`（監査ログのみ・応答は一般論） |
| 3 | `engines.claude.interactiveAllowedTools`（**グローバル**） | ツール許可 | **gateway起動時**（エンジンconstructor、server.ts:307-313） | 「don't ask modeでブロック」 |
| 4 | placement `dataScopes` 宣言 | ソフト境界 | セッション毎 | **モデルが自主拒否**（「このplacementのポリシーでは許可されていません」） |
| + | gateway再起動 | — | — | #3の変更がhot-reloadで反映されない |

### gatewayツールを1つ追加する場合（gap-analysis A-5で指摘済み）

①gateway-server.tsのTOOLS配列 ②api.tsの`gatewayToolMatchesRoute`ハードコード対応表 ③placement `capabilities.gatewayTools` の3箇所。

### 対照: スキル（PR #41）= 既にあるべき姿

スキル可視性は**frontmatter宣言 + capabilitiesからの導出**で1箇所化済み。placementに個別登録は不要。**この導出パターンを他の層へ広げるのが本調査の結論**。

## ギャップ表

| # | ギャップ | 現状 | あるべき姿 | 実現性 |
|---|---|---|---|---|
| G1 | **ツール許可がグローバルかつboot束縛** | `interactiveAllowedTools`は全placement共通・エンジンconstructor固定。placementごとの差（backofficeは将来freee書込可、他はread）が表現不能 | placementのcapabilitiesから**セッションごとに導出**し、spawn引数で渡す | **高**: `disallowedTools`は既にEngineRunOptsでspawn毎に渡している（PR #29/#41）。allowedToolsも同じ経路に載せるだけ。denyKey同様のcold-respawn対応も既存パターン |
| G2 | **read/write粒度の語彙がない** | freeeのread限定は「グローバルallowlistにreadツールだけ手で列挙」で表現（8ツール名の手書き） | `capabilities.mcp`を `freee: read-only` 形式に拡張し、ツール選別を導出 | 中: MCPごとのread/writeツール分類（G6のカタログメタデータ）が前提 |
| G3 | **dataScopes宣言が手書きで乖離する** | capabilitiesにfreeeを足してもdataScopesに書き忘れるとモデルが自主拒否。逆に能力の無いplacementに宣言だけ残る事故も実発生（mana-dev-biz巻き込み） | プロンプトに注入するソフト境界宣言を**capabilitiesから自動生成**（手書きdataScopesは補足追記のみ） | 高: context.tsの注入箇所は1つ。生成関数を挟むだけ |
| G4 | **hot-reloadがエンジンに届かない** | config reloadはconnector/sessionManagerのみ。エンジンのallowedToolsはboot時のまま（今回の4連目の原因） | G1でspawn時にconfigを参照する構造になれば自然解消 | 高（G1に包含） |
| G5 | **gatewayツールのroute対応表がハードコード** | TOOLS配列とapi.tsの対応表を手で同期（A-5） | TOOLS配列にroute定義（method/path）を同居させ、対応表を生成 | 高: 機械的な移動 |
| G6 | **MCPカタログにツールメタデータがない** | どのツールがread/writeかはコードや運用者の頭の中 | `mcp.custom.<name>.tools`にread/write分類（スキルfrontmatterと同型の宣言） | 中: 分類の初期整備が必要（freee/brainbase/nocodbの3つから） |
| G7 | **恒常denyの置き場** | `search_personal_kg`恒常denyはPR #47の`PLACEMENT_MCP_TOOL_DENY`定数（コード） | 現状維持でよい（機微の既定はコード固定が正しい）。G2のread-only導出はこの機構の上に載せる | — |

## 埋める順序の提案

1. **PR #47をマージ**（前提基盤: `placementDefaults`・`PLACEMENT_MCP_TOOL_DENY`・channel-members audience）
2. **G1+G4**: per-placementツール許可の導出とspawn時バインド — 再起動不要化と「3箇所目の登録」の廃止。今回の障害の直接原因を消す最小単位
3. **G3**: ソフト境界宣言の自動生成 — 「4箇所目」の廃止
4. **G2+G6**: read-only語彙とカタログメタデータ — freeeの手書き8ツール列挙を置換
5. **G5**: route対応表の生成化（独立・任意タイミング）

2〜4が完了すると、MCP追加は「①カタログ登録 ②capabilities.mcpに1語（+粒度）」の**2箇所・再起動不要**になり、目標UXに到達する。

## 関連

- 実地障害の記録: freee接続の4連続障害（memory: freee-mcp-pilot-wiring）
- 先行パターン: PR #41（スキル可視性導出）・PR #29/#39（spawn毎denyルール）・PR #47（placementDefaults）
- 原則: ADR-0001（deny-by-default）・ADR-0004（第二の権限体系を発明しない）
