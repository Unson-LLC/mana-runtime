# 会社の脳との接続（境界と目標アーキテクチャ）

**最終更新**: 2026-08-04
**性格**: 01〜09が「現在地」を書くのに対し、この章は**目標**を書く。根拠は2026-07-29の2会議（ユニバーサルアーツ・グローウィン）で言語化された思想と [roadmap.md](../management/roadmap.md) の柱1〜3・5。

**責務境界（この章の前提）**: 「会社の脳」——SSOT（事実）・グラフ（関係性）・オントロジー（意味・判断基準）の3層——の設計・定義・育成方針は**brainbaseの領域**であり、その正本はbrainbase側に置く（mana-runtimeでは定義しない）。この章が定義するのは、**実行系であるmana-runtimeが脳とどう接続するか**（読む・学習候補を送る・権限写像を受ける）のインターフェースだけである。ランタイムに脳を複製しない（[02_data_design.md](./02_data_design.md)の原則）。

## 1. 読む — 実行時参照（mana→brainbase）

**目標**: マナは応答・判断の**前に**脳を読みに行く。固有名詞・RACI・過去の意思決定・そのチャンネルの業務文脈をGraph SSOTから取得してから動く。

**現在地**: [TurnPreparationService](../../packages/jimmy/src/sessions/turn-preparation-service.ts) がconnector/cron/webの各ターンで、engine実行前に次の2系統を並列取得してsystem promptへ注入する。

- Brainbase Graph: そのターンのproject・channel・発話をscopeにした直接取得。成功内容をランタイムへ恒久キャッシュせず、取得失敗は「事実なし」ではなく`未確認`として注入する
- 共有チャンネル文脈: SQLiteへ永続化済みの別engine sessionの直近発話。ただし`connector + workspace + channel + placement`が一致するものだけを使い、workspace不明時はfail closedする

engine transcript自体はスレッド単位のまま分離する。横断共有するのは上記の業務文脈だけで、人格やengine sessionをチャンネル単位に複製・統合しない。取得結果と実効ツール状態は`turn_context_snapshots`へ記録され、`/status`とSession APIから確認できる。

## 2. 送る — 学習候補の検出と提案（mana→brainbase）

**目標**: 各チャンネルのマナは日々の会話・作業ログから「今後の業務遂行のために覚えるべきこと」の**候補を検出して送る**。mana-runtimeの責務はここまで:

```
チャンネルの会話・作業ログ（mana-runtime側）
  → 成功した会話ターンをreview-required候補としてdurable outboxへ記録
  → HMAC署名付きでcandidate-store raw-ledgerへ送信（失敗時はpendingのまま再試行）
  ── ここから先はbrainbaseの領域 ──
  → candidate-store → 昇格判断（人間承認） → Graph SSOT正本化
```

原則（接続契約として守るもの）: 候補はGraph真理へ直接書き込まず**candidate-store経由**で渡す。すべて`requires_review=true`、turn/messageの証拠URI・SHA-256・idempotency key付きであり、mana-runtimeは自動昇格しない。Candidate Storeへ渡すraw-ledger envelopeは`retention_policy=envelope_only`で、outboxには会話本文全体ではなく最大8,000文字のbounded snippet・hash・message参照だけを保持する。昇格の判断・承認フロー・オントロジー化はbrainbase側の設計に従う。

**現在地**: [LearningCandidateService](../../packages/jimmy/src/learning/candidate-outbox.ts) と [Brainbase candidate submitter](../../packages/jimmy/src/learning/brainbase-candidate-store.ts) を実装済み。成功ターンはSQLite outboxへ冪等記録され、claim/CAS・指数backoff・startup drainで`/api/candidate-store/raw-ledger`へ送る。送信元の既定値は`mana_slack`。`BRAINBASE_CANDIDATE_STORE_BASE_URL`（または既存Brainbase API base URL）、`BRAINBASE_CANDIDATE_STORE_HMAC_SECRET`、およびSlack外部IDからBrainbase canonical person IDへの写像`BRAINBASE_SLACK_PERSON_MAP_JSON`（例: `{"T_WORKSPACE:U123":"per_..."}`）が必要で、未設定・未解決なら成功扱いせずpendingに保つ。現段階のextractorは成功ターンを境界付きraw evidence候補へ変換するところまでで、意味単位の分類と機微区分は残課題。承認・Graph昇格はBrainbase Candidate Store側の責務である。

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

台帳の思想（roadmap柱5「台帳=placement一覧、監査=security_event、停止=budget/kill switch」）は方向として正しい。初期ギャップの大半は [PR #30](https://github.com/Unson-LLC/mana-runtime/pull/30)（owner/purpose・placement単位月次コスト・`enabled` kill switch・`GET /api/placements` 台帳API・web台帳ビュー・運用文書 [placement-lifecycle](../operations/placement-lifecycle.md) / [config変更管理](../operations/pilot-config-change-management.md)）で解消済み（2026-07-30）。現状:

| 台帳項目 | 現状 | 評価 |
|---|---|---|
| ID・所属チャンネル・対話相手 | placement id / channelId / audience | ✅ |
| 権限（ツール・MCP・配信先） | capabilities | ✅ |
| モデル | agent.defaultModel | ✅ |
| 所有者・目的 | owner / purpose（PR #30） | ✅ |
| 月次費用（placement単位） | `getCostsByPlacement`（`transport_meta.placementId`の`json_extract`集計。**専用カラムではない**ため大規模化したらカラム昇格を検討）。unplaced/orphanコストも可視 | ✅ |
| kill switch | `enabled: false` で解決時・配信認可・派生セッションの3箇所fail-closed | ✅ |
| 台帳ビュー | `GET /api/placements` + web panel placements画面（owner未設定・budget対象外・無効placementを識別表示） | ✅ |
| 廃止フロー | [placement-lifecycle.md](../operations/placement-lifecycle.md)（削除ではなく`enabled: false`で監査痕跡を残す） | ✅ |
| 監査ログ | security_event（capability系はplacementId・configRevision付き。control_plane系は2026-07-30から`target`=アクセス先を含む） | ✅ |
| 参照データ範囲 | dataScopes | ⚠️ ソフト境界のみ（宣言であり強制ではない） |
| 変更管理 | ランタイムが `config.yaml` / `cron/jobs.json` を書き換える全経路で書込み前スナップショットを `~/.ryoko/config-history/`（0700/0600・直近100件ローテーション）へ自動保存。`index.jsonl` + 構造化ログ `config_change` に いつ・経路・operator認証の有無 を記録。`GET /api/config-history`（メタデータのみ・operator token保護）で一覧。運用手順は [pilot-config-change-management.md](../operations/pilot-config-change-management.md) | ✅ |
| budget連動 | placement単位の月次上限 `monthlyBudgetUsd`（2026-07-31実装）。超過時は`resolveRouteOptions`でkill switchと同じゲートをfail-closed（security_event reason=`placement_budget_exceeded`）、80%到達で月1回チャンネル警告（budget_events dedup）、消化額は短TTLキャッシュでホットパスのDB直撃を回避。台帳ビューに上限・消化率を表示。employee単位budgetは従来どおり併用 | ✅ |

## 7. まとめ — どの柱がどこを埋めるか

| 本章の節 | roadmapの柱 | 状態 |
|---|---|---|
| §1 読む（実行時参照） | 柱1（文脈注入）・柱2（実行時Graph参照） | ランタイム実装済み。production反映・実Graph E2Eは別途確認 |
| §2 送る（学習候補） | 柱2（昇格フック） | durable outbox + HMAC送信を実装。意味分類・機微区分・brainbase承認/昇格は残 |
| §3 受ける（権限写像） | 柱2 | 未実装（brainbase共同設計待ち） |
| §4 HITL | 柱3 | 2系統の個別実装あり（register-first補償型=タスク承認 / ブロッキング型=議事録宛先選択）。汎用プリミティブ化は未。`ApproverResolver`は両者でDI共有済み |
| §5 ルーティング層 | 柱1 | 単一宛先のみ実装（critical-routing: 決定論分類器+子セッション委譲+fail-closed）。複数宛先への動的ディスパッチは未 |
| §6 台帳 | 柱5 | 実装完了（PR #30 + placement単位budget上限 + 変更管理コード支援、2026-07-31） |

脳そのもの（3層の定義・グラフ/オントロジーの設計・candidate-storeからの昇格運用）はbrainbase側の設計文書が正本であり、本章はその**接続契約の受け口・送り口**だけを規定する。brainbase側の設計が変わったら本章のインターフェース記述を追従させる。
