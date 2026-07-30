# 人格・スキル・記憶の管理（目標アーキテクチャ）

**最終更新**: 2026-07-30
**性格**: 10章と同じく「目標」を書く章。マナの人格（CLAUDE.md・SOUL.md・IDENTITY.md）、スキル（skills/）、記憶（memory/・knowledge/）という**振る舞いを永続的に変える資産**の管理方針を定める。

## 1. 現状の問題（fact）

- runtime home（`~/.ryoko`）のCLAUDE.md・SOUL.md・skills/・memory/ は**pilot上の手編集が正本**になっている。repo側に [template](../../packages/jimmy/template/) が存在するのに、デプロイ後は乖離し続け、変更履歴がない（`CLAUDE.md.pre-model-routing-20260725` のようなバックアップファイル慣行のみ）
- system promptがエージェント自身に**自己改変を全面許可**している（[context.ts](../../packages/jimmy/src/sessions/context.ts)「You can read, write, and modify any of these files」）
- placementセッションのread-only指定は config.yaml・org/・cron/ のみで、**CLAUDE.md・skills/・memory/ は書込可能**。かつこれらは全placement共有（JINN_HOME単位）
- 帰結: あるチャンネルの会話（＝信頼できない入力を含む）が、全チャンネルの人格・スキル・記憶を永続的に書き換えられる。**authority rebindでtranscriptを消しても、ファイル経由で文脈・指示が境界を跨いで永続する**。これはプロンプトインジェクションの永続化経路であり、[04](./04_auth_permission.md)の境界設計の未カバー領域

## 2. 原則 — 3種類の資産を区別する

| 資産 | 性質 | 正本 | 変更経路 |
|---|---|---|---|
| **人格・スキル**（CLAUDE.md/SOUL/IDENTITY/skills/） | 配布物。全チャンネルの挙動を変える | **gitリポジトリ**（template） | PRレビュー → deploy。実行時書込は禁止 |
| **運用の記憶**（memory/） | インスタンスの動作上の学び | runtime home（git管理・履歴必須） | HITL承認を経た書込のみ。機微・業務事実は書かない |
| **業務の記憶**（事実・判断基準・顧客文脈） | 脳の領域 | **brainbase**（Graph SSOT） | candidate-store経由の昇格（[10章§2](./10_company_brain.md)）。**ランタイムのファイルに書かない** |

判定基準は「これは誰の記憶か」:
- マナという**ランタイムの動作**の学び（例: このAPIはlimit最大50）→ memory/
- **会社・顧客・業務**の事実や判断基準（例: この顧客の締め日、経理の承認ルール）→ brainbaseへ送る。ランタイムに置くと脳の複製・二重管理になる（[02](./02_data_design.md)の原則違反）
- **会話の文脈** → engine transcript（session-scoped、authority rebindでクリア）。ファイルに退避しない

## 3. 書込は境界イベントとして扱う

人格・スキル・記憶への書込は「その場の応答」ではなく**全チャンネル・全将来セッションへの永続的影響**なので、通常のツール実行より一段強いゲートを通す:

1. **placementセッションからの直接書込を禁止**する（ハード境界）。context.tsのread-onlyリストに CLAUDE.md・SOUL.md・IDENTITY.md・skills/・memory/・knowledge/ を追加し、可能なら`interactiveAllowedTools`/permission設定でも強制する
2. 自己改変の望ましい形は**提案**: マナは「このスキルを追加すべき」「これを記憶すべき」を検出したら、HITL（[10章§4](./10_company_brain.md)）で人間に提案する
3. 承認された変更は**gitコミット（人格・スキルはPR）として着地**する。これで変更管理・ロールバック・監査が台帳（[10章§6](./10_company_brain.md)）と同じ仕組みに乗る

```
チャンネルでの気づき（スキル候補・記憶候補）
  → HITL提案（Slackカード: 内容・影響範囲・推奨）
  → 承認
  → 人格/スキル: template修正PR → レビュー → merge → deploy
  → 運用記憶: memory/へコミット（git履歴つき）
  → 業務事実: candidate-store → brainbase（ランタイムには書かない）
```

## 4. 人格の層構造

全チャンネル共通の人格と、チャンネル固有の文脈を混ぜない:

| 層 | 内容 | 実装 |
|---|---|---|
| ランタイム共通人格 | マナの性格・応答規律・言語 | CLAUDE.md/SOUL.md（repo正本・deploy配布） |
| チャンネル文脈 | そのチャンネルの業務・プロジェクト・判断基準 | placementのsystem prompt注入（[context.ts](../../packages/jimmy/src/sessions/context.ts)）。将来はGraphから取得（10章§1） |
| 会話文脈 | スレッド内の経緯 | engine transcript |

チャンネル固有の指示をCLAUDE.mdへ書き足すことは、全チャンネルへの漏えいであり禁止。行き先はplacement設定（またはGraph）。

## 5. スキルの台帳統合

スキルは「マナが何をできるか」の一部なので、エージェント台帳（10章§6）の管理対象に含める:

- skills/ の一覧（名前・目的・使用ツール）を台帳ビューに出す
- スキルがMCP・外部送信を伴う場合、その実行は従来どおりplacementの`capabilities`で制限される（スキルは能力を付与しない。手順を記述するだけ。能力の正本はあくまでplacement）
- 新設前の重複調査（既存スキル検索）も台帳の役割

## 6. 現在地とのギャップまとめ

| 項目 | 現状 | 目標 |
|---|---|---|
| 人格・スキルの正本 | pilot手編集（履歴なし、templateと乖離） | repo template正本 + deploy配布 |
| 実行時の自己改変 | 全面許可（system promptで明示） | 禁止 → HITL提案 + PR着地 |
| placementからの書込 | CLAUDE.md/skills/memory書込可能（**境界の穴**） | read-onlyリストへ追加（ハード境界） |
| 記憶の行き先 | すべてJINN_HOME共有ファイル | 3分類ルール（§2）: 運用記憶/業務事実/会話文脈 |
| 変更管理 | バックアップファイル慣行 | git履歴 + 台帳統合 |

§1の境界の穴（placementセッションからの人格・記憶書込）は**セキュリティ修正として台帳実装より先に塞ぐ**べき項目。[08_security_design.md](./08_security_design.md)の攻撃面（2.1 信頼できないSlack入力）の具体例として扱う。
