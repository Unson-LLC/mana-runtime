# 人格・スキル・記憶の管理（目標アーキテクチャ）

**最終更新**: 2026-08-04
**性格**: 10章と同じく「目標」を書く章。マナの人格（CLAUDE.md・SOUL.md・IDENTITY.md）、スキル（skills/）、記憶（memory/・knowledge/）という**振る舞いを永続的に変える資産**の管理方針を定める。

> **更新（2026-07-30）**: §1の境界の穴は [PR #29](https://github.com/Unson-LLC/mana-runtime/pull/29) で closed — placementセッションは`--disallowedTools`のdenyルール（bypassPermissionsでも有効）で人格・スキル・記憶ファイルへのWrite/Edit不可となり、自己改変促し文言・Self-evolution節もplacement時は注入されない。
> **更新（2026-07-31）**: Bash経由のシェル書込も closed — PreToolUseガードhook（`assets/placement-guard.mjs`、`permissionDecision: deny`）で保護パスへの代表的シェル書込パターンを決定論的に拒否（残余は [08章§2.1](./08_security_design.md)）。§3の可視性フィルタ（読取側）も中間段階をStory `placement-read-filters` で実装済み（§3.3参照）。
> **更新（2026-08-04）**: repo template → runtime `CLAUDE.md` の決定論的projection（atomic write、0600、SHA-256 read-back検証）と、共通人格をCWDに依存せず各ターンへ明示注入する経路を実装。connector/cron/webは同じTurnPromptProviderを使用し、warm PTYはsystem prompt hash変更時にcold respawnする。global `MEMORY.md` はplacementへ注入しない。
> **更新（2026-08-04）**: 人格はworkspace共通のまま、チャンネル固有の業務文脈だけを`connector + workspace + channel + placement`で分離して各ターンへ注入する。別スレッドのengine transcriptは統合しない。Graph取得と実効ツール状態も毎ターン解決し、失敗は`未確認`として表示する。

## 1. 当初の問題（historical fact）

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
- **会話の文脈** → 現スレッドはengine transcript、別スレッドの直近業務文脈は同一workspace/channel/placementに限定したSQLite projection。ファイルに退避せず、Graphの正本とも混同しない

## 3. 権限モデル — 第二の権限体系を発明しない

**大原則**: 権限の構造（誰が・何を・どこまで）はbrainbaseが既に持っている（RACI・project・scope）。ランタイムはこれと別の権限分類を発明せず、**スコープの語彙をbrainbaseから借り**、自分は「どの層に置くか」と「セッション組立時のフィルタ」だけを担う。ランタイム独自の権限台帳を育て始めたら、それは脳との二重管理（敗れた仮説と同型）である。

### 3.1 記憶の権限 — 3層でシンプルに保つ

| 層 | 置き場所 | 可視範囲 | 権限の強制者 |
|---|---|---|---|
| 業務の記憶 | **brainbase（Graph）** | brainbaseのRACI・projectスコープに従う | **brainbase側**（サービストークンのscope + placementの`dataScopes`宣言）。ランタイムは判定しない |
| placementローカル記憶 | `memory/placements/<placementId>/` | **そのplacementのセッションのみ**（チャンネル固有の決まりごと・進行文脈） | gateway。セッション組立時に自placement分だけを注入し、他placement分はパスごと遮断（ハード境界） |
| ランタイム共通記憶 | `memory/`（直下） | 全placement | なし（全公開）。**よって機微・業務事実・チャンネル固有情報の書込を禁止** — 「全チャンネルに見せてよいか？」がここに置く唯一の判定基準 |

ポイントは、ランタイムローカルに残る権限判定が「自placementか否か」の1個だけになること。中間の細かい権限（このプロジェクトの人だけ・この役職だけ）が必要な記憶は、それはもう業務の記憶なのでbrainbaseに置き、RACIに判定させる。

### 3.2 スキルの権限 — capabilitiesから導出する

スキルの可視性を独立に管理すると、roadmap柱1が指摘する「ツール追加のたびに3箇所登録」の4箇所目になる。そうしない:

- スキルはfrontmatterで**必要能力を宣言**する: `requiredMcp`（例: nocodb）・`requiredTools`（例: create_task）・`scope`（project名 or placement id。省略時はglobal）
- あるセッションで見えるスキル = **そのplacementのcapabilitiesで実行可能なもの ∧ scopeが合致するもの**。gatewayがセッション組立時にスキルマニフェストを生成して注入する
- スキルは能力を**付与しない**（手順の記述にすぎない。能力の正本はあくまでplacementのcapabilities）。導出フィルタの目的は2つ: (1) 使えないスキルを見せて迷わせない、(2) スキル本文に業務手順が書かれる以上、**見えること自体が情報開示**なので、能力・スコープ外のチャンネルには本文ごと隠す
- `scope`の語彙はplacementの`projects`と同じ（=brainbaseのproject）。将来「オントロジー→placement写像」（[10章§3](./10_company_brain.md)）が実装されたら、スキル可視性もGraphから一括導出される

### 3.3 強制の実装段階

| 段階 | 内容 |
|---|---|
| 中間（**現状**、Story `placement-read-filters`で実装） | gatewayがセッションごとにスキルマニフェスト・記憶ビューを生成して注入。スキルはfrontmatterの`requiredMcp`/`requiredTools`/`scope`とplacementのcapabilities/projectsの突き合わせで可視性を導出し、記憶は`memory/placements/<placementId>/`を自placement分だけ注入・他placement分をRead/Glob/Grepのdenyルールで遮断する。残ギャップ: Bash経由のシェル読取と、セッション走行中に新設されたplacementディレクトリ（denyルールはセッション開始時の列挙。次セッションから遮断される） |
| 最終 | placementごとに実行ホームを分離（自placementのビューしかファイルシステム上に存在しない状態）。業務データはMCP経由なので、分離しても脳への参照は損なわれない |

## 4. 書込は境界イベントとして扱う

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

## 5. 人格の層構造

全チャンネル共通の人格と、チャンネル固有の文脈を混ぜない:

| 層 | 内容 | 実装 |
|---|---|---|
| ランタイム共通人格 | マナの性格・応答規律・言語 | CLAUDE.md/SOUL.md（repo正本・deploy配布） |
| チャンネル文脈 | そのチャンネルの業務・プロジェクト・判断基準 | placement設定 + 毎ターンのBrainbase Graph取得 + 同一scopeの永続化済み別スレッド発話をsystem promptへ注入 |
| 会話文脈 | 現スレッドの完全な経緯 | engine transcript（スレッド単位で分離） |
| 実効ツール状態 | そのターンで実際に構成されたMCP能力 | MCP allowlist・設定・credentialを解決してsystem promptへ注入。Gateway内の許可ツール名はplacement policyとして同時注入され、そのMCP自体の状態と合わせて判断する。snapshotを`/status`/Session APIへ表示 |

チャンネル固有の指示をCLAUDE.mdへ書き足すことは、全チャンネルへの漏えいであり禁止。行き先はplacement設定（またはGraph）。

### 5.1 runtime適用契約

1. repoの `packages/jimmy/template/CLAUDE.md` を唯一のauthoring sourceとする。
2. gateway起動時にportal変数を展開し、`~/.ryoko/CLAUDE.md`へatomic projectionする。canonical template欠落・read-back不一致はfail closed。
3. 各ターンでprojectionを再検証し、`CLAUDE.md`・`IDENTITY.md`・`SOUL.md`を共通人格として明示注入する。非placementだけglobal `MEMORY.md`も含める。
4. 共通人格の後にsession・speaker・placement・実効capabilityを注入し、競合時は後者を優先する。workspace-local `CLAUDE.md`は共通人格やplacement境界を上書きしない。
5. interactive Claudeのwarm PTYはsystem prompt hashをspawn identityに含め、変化時はresume付きcold respawnで新しい指示を適用する。
6. runtime `CLAUDE.md`を直接編集するwriterは持たない。onboardingはconfigを更新し、同じprojectorでprojectionを更新する。

## 6. スキルの台帳統合

スキルは「マナが何をできるか」の一部なので、エージェント台帳（10章§6）の管理対象に含める:

- skills/ の一覧（名前・目的・使用ツール）を台帳ビューに出す
- スキルがMCP・外部送信を伴う場合、その実行は従来どおりplacementの`capabilities`で制限される（スキルは能力を付与しない。手順を記述するだけ。能力の正本はあくまでplacement）
- 新設前の重複調査（既存スキル検索）も台帳の役割

## 7. 現在地とのギャップまとめ

| 項目 | 現状 | 目標 |
|---|---|---|
| 人格・スキルの正本 | `CLAUDE.md`はrepo template正本 + 検証済みruntime projection。SOUL/IDENTITY/skillsの完全なrepo配布は残課題 | 全人格・スキルをrepo template正本 + deploy配布 |
| 実行時の自己改変 | placementは禁止。生成物`CLAUDE.md`の直接編集指示は除去。非placementの他ファイルはcapability・ユーザー意図で制限 | HITL提案 + PR着地への完全置換 |
| placementからの書込 | denyルール（PR #29）+ Bashガードhookで遮断済み（残余は08章§2.1） | OSレベル分離による完全遮断 |
| 記憶の行き先 | 業務会話はreview-required候補としてdurable outboxへ記録しcandidate-storeへ送信。別スレッド文脈はscope付きSQLite projection、運用記憶の完全なHITL/git化は残課題 | 3分類ルール（§2）: 運用記憶/業務事実/会話文脈 |
| 毎ターンの文脈 | Graph + 同一チャンネル業務文脈をconnector/cron/webでhydrate。失敗は`未確認`。人格はworkspace共通 | Graph RACIによる最終scope強制とproduction E2E |
| 実効ツールの安定性 | MCPをallowlist・設定・credentialから毎ターン解決し、利用可否と理由をprompt/API/statusへ表示。Gateway tool allowlistはplacement policyとして表示・実行時強制 | 外部サービス自体の可用性監視とproduction E2E |
| 記憶の読取権限 | global `MEMORY.md`は非placementのみ。placementローカル層（`memory/placements/`）は自placement分のみ注入+他placementはdeny遮断 | 3層モデル（§3.1）: 脳=RACI / placementローカル=自placementのみ / 共通=全公開かつ機微禁止 |
| スキルの可視性 | capabilities+scopeの導出フィルタ実装済み（マニフェスト注入。Story `placement-read-filters`。本文のファイル読取遮断は最終段階） | capabilities+scopeからの導出フィルタ（§3.2）+実行ホーム分離 |
| 変更管理 | `CLAUDE.md`はgit履歴 + SHA-256検証。SOUL/IDENTITY/skills/memoryの台帳統合は残課題 | git履歴 + 台帳統合 |

§1の境界の穴（placementセッションからの人格・記憶書込）はPR #29（Write系denyルール）とBashガードhook（冒頭の更新注記参照）で遮断済み。残るは読取側フィルタと、ガードの検査限界（[08_security_design.md](./08_security_design.md) §2.1に明記）。攻撃面としては08章2.1（信頼できないSlack入力）の具体例として扱う。
