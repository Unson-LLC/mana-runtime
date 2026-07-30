# 会社の脳との接続（境界と目標アーキテクチャ）

**最終更新**: 2026-07-30
**性格**: 01〜09が「現在地」を書くのに対し、この章は**目標**を書く。根拠は2026-07-29の2会議（ユニバーサルアーツ・グローウィン）で言語化された思想と [roadmap.md](../management/roadmap.md) の柱1〜3・5。

**責務境界（この章の前提）**: 「会社の脳」——SSOT（事実）・グラフ（関係性）・オントロジー（意味・判断基準）の3層——の設計・定義・育成方針は**brainbaseの領域**であり、その正本はbrainbase側に置く（mana-runtimeでは定義しない）。この章が定義するのは、**実行系であるmana-runtimeが脳とどう接続するか**（読む・学習候補を送る・権限写像を受ける）のインターフェースだけである。ランタイムに脳を複製しない（[02_data_design.md](./02_data_design.md)の原則）。

## 1. 読む — 実行時参照（mana→brainbase）

**目標**: マナは応答・判断の**前に**脳を読みに行く。固有名詞・RACI・過去の意思決定・そのチャンネルの業務文脈をGraph SSOTから取得してから動く。

**現在地とのギャップ**: 現在はplacementの`capabilities.mcp`でbrainbase MCPを許可し、モデルが必要と判断した時に読む「任意参照」。毎ターンの前提として文脈を注入する経路（roadmap柱1「チャンネル文脈の注入強化」・柱2「実行時Graph参照」）は未実装。[context.ts](../../packages/jimmy/src/sessions/context.ts)のplacement文脈注入がその挿入点。

## 2. 送る — 学習候補の検出と提案（mana→brainbase）

**目標**: 各チャンネルのマナは日々の会話・作業ログから「今後の業務遂行のために覚えるべきこと」の**候補を検出して送る**。mana-runtimeの責務はここまで:

```
チャンネルの会話・作業ログ（mana-runtime側）
  → 学習候補の検出（夜間バッチ）
  → 振り分け:
      機微・判断が必要 → 人間にSlackで確認（HITL、§4）
      自明な学び       → 候補として自動送信
  ── ここから先はbrainbaseの領域 ──
  → candidate-store → 昇格判断（人間承認） → Graph SSOT正本化
```

原則（接続契約として守るもの）: 候補はGraph真理へ直接書き込まず**candidate-store経由**で渡す。昇格の判断・承認フロー・オントロジー化はbrainbase側の設計に従う。機微データ（財務・人事）は候補の段階で明示的にフラグする。

**現在地とのギャップ**: 検出・送信は未実装（roadmap柱2「昇格フック」）。現在の学習は佐藤の手動運用に依存している。

## 3. 受ける — 権限写像（brainbase→mana）

**目標**: 「誰が何を承認できるか・どのデータに触れてよいか」の正本はGraphのオントロジー（RACI・権限定義）であり、placement設定は**その写像（生成物）**になる:

```
Graph SSOT（RACI・権限のオントロジー）
  → 写像・生成
placement設定（config.yaml: audience / capabilities / dataScopes / 停止条件）
```

これにより権限の二重管理（Graphと config.yaml に別々の正義がある状態）を排す。

**現在地とのギャップ**: 現在は逆で、config.yamlの手書きが権限の正本（[04_auth_permission.md](./04_auth_permission.md)）。04の記述は**暫定の現在地**であり最終形ではない。写像を実装するまでは、Graph側のRACIと placement設定の食い違いを定期監査でしか検出できない。roadmap柱2・優先順位5（brainbase側との共同設計が必要）。

## 4. Human-in-the-loopプリミティブ

**目標**: 「AIが動き、人間は確認だけ」を量産可能にするため、HITLをワークフローごとの個別実装ではなく**ランタイムの型**として持つ:

- 承認待ち → Slackで選択肢カード提示（選択肢・帰結・推奨を明記）→ 承認で続行 / 却下で停止
- 承認者はGraphのRACIから解決する（`ApproverResolver`が既にこの差し替え点として抽象化済み）
- 承認・却下は監査可能に記録し、判断理由は学習候補（§2）として脳に還流する

**現在地とのギャップ**: 議事録→タスク承認ボタン（roadmap柱4、実装済み）が個別実装として存在する唯一のHITL。型化（roadmap柱3「人間確認ステップの型化」）はこれを一般化する作業。

## 5. 裏側ルーティング層 — 窓口1体・裏で振り分け

**目標**: 利用者から見える窓口はマナ1体（専門エージェント乱立は認知負荷・たらい回し・重複開発を生むため採らない）。依頼内容に応じて裏側でサブエージェント・モデル・effortを動的に選ぶディスパッチ層を [SessionManager](../../packages/jimmy/src/sessions/manager.ts) とengineの間に挿入する:

```
Slack（窓口=マナ1体）
  → SessionManager
  → ルーティング層（依頼分類 → 経理系/開発系/調査系サブエージェント・モデル選択）★未実装
  → engine実行（placement権限内で）
```

ルーティングは決定論的コードを優先し、LLM判断は分類にのみ使う。専門性は裏で交換可能に、責任主体は表の1体に。

**現在地とのギャップ**: 現在はplacementの`agent.defaultModel`とcritical-routing（重要判断のレビュー委譲）のみ。動的ディスパッチはroadmap柱1。

## 6. エージェント台帳 — 目標水準と現状ギャップ

台帳の思想（roadmap柱5「台帳=placement一覧、監査=security_event、停止=budget/kill switch」）は方向として正しいが、会議で参照した管理水準（Microsoft Entra / AWSの警告）と突き合わせると**現状は台帳と呼ぶには不足がある**:

| 台帳項目 | 現状 | 評価 |
|---|---|---|
| ID・所属チャンネル・対話相手 | placement id / channelId / audience | ✅ |
| 権限（ツール・MCP・配信先） | capabilities | ✅ |
| モデル | agent.defaultModel | ✅ |
| 監査ログ | security_event（placementId・configRevision付き） | ✅ |
| 参照データ範囲 | dataScopes | ⚠️ ソフト境界のみ（宣言であり強制ではない） |
| **所有者・スポンサー** | フィールド自体が無い | ❌ |
| **目的・説明** | 無い（idの命名頼み） | ❌ |
| **月次費用（placement単位）** | budgetはemployee単位月次のみ。placementのemployee未設定だと**budget対象外** | ❌ |
| **停止条件・kill switch（placement単位）** | 無い（employeeのbudget pauseと、config手編集での無効化のみ） | ❌ |
| **変更管理** | pilotのconfig.yamlは**git管理外**。バックアップファイル慣行のみで、誰がいつ何を変えたかの履歴が無い | ❌ |
| **廃止フロー** | 未定義（作りっぱなし。空placementが放置される） | ❌ |
| **新設前の重複調査**（既存台帳から能力を検索してから作る） | 台帳の一覧ビュー自体が無い | ❌ |

**埋める順序の提案**:
1. **変更管理**: pilotの`~/.ryoko/config.yaml`をgit管理（privateリポジトリ）に移し、変更をコミット履歴にする — 実装ゼロで最大の欠落が埋まる
2. **owner / purpose フィールド追加** + placement単位の月次コスト集計（sessionsにplacementIdは既にあるため集計クエリのみ）
3. **placement単位のkill switch**（`enabled: false`で該当チャンネルを即fail-closed化）と廃止手順の文書化
4. 台帳一覧ビュー（web panel）— 他社展開時の「AIガバナンス診断」商品の土台（roadmap柱5）

## 7. まとめ — どの柱がどこを埋めるか

| 本章の節 | roadmapの柱 | 状態 |
|---|---|---|
| §1 読む（実行時参照） | 柱1（文脈注入）・柱2（実行時Graph参照） | 未実装 |
| §2 送る（学習候補） | 柱2（昇格フック） | 未実装・最難所 |
| §3 受ける（権限写像） | 柱2 | 未実装（brainbase共同設計待ち） |
| §4 HITL | 柱3 | 個別実装1件のみ、型化未 |
| §5 ルーティング層 | 柱1 | 未実装 |
| §6 台帳 | 柱5 | 骨格のみ、不足項目は§6の表 |

脳そのもの（3層の定義・グラフ/オントロジーの設計・candidate-storeからの昇格運用）はbrainbase側の設計文書が正本であり、本章はその**接続契約の受け口・送り口**だけを規定する。brainbase側の設計が変わったら本章のインターフェース記述を追従させる。
