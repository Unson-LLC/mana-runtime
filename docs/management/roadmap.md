# mana-runtime ロードマップ（正本）

- **初版**: 2026-07-29
- **最終更新**: 2026-08-19
- **現在地の基準**: `main` `72cb64169e083610ab8c29110250ac52c93e313e`
- **統合計画**: [組織版・マルチテナント・経営実行ループ統合計画](../plans/2026-08-19-organization-edition-and-multitenant-rollout.md)

**維持**: 方針変更はこのファイルを更新してからStory・Spec・Canonical Taskへ展開する。会議・Slackでの発言は、ここへ反映されるまでロードマップの正本ではない。

## 1. 北極星

「会社の脳」をBrainbaseに置き、Slack上の単一窓口AI社員「マナ」が、判断後の仕事を成果確認まで回す。

mana-runtimeの目的は、AIとの会話量や利用ツール数を増やすことではない。人間がトレードオフ判断・創造・例外対応に集中できるように、マナが次の循環を閉じることである。

```text
Decision（人間が決める）
  → Work（マナが担当・期限・次の行動を進める）
  → Ship（成果物と本番結果を確認する）
  → Learn（結果を次の判断・仕組みへ戻す）
```

北極星指標は、週次の **「人間の判断介入1回あたりに完了した成果数」** とする。AI実行回数、会話数、登録タスク数は補助指標であり、成功判定には使わない。

マナの行動原則は次で固定する。

- 会社・プロジェクト・人物・責任・権限・過去判断をBrainbaseから解決してから動く。
- 権限内の仕事は、下書きではなく実行・外部readback・証拠取得まで自律的に進める。
- 人間にしかできない仕事は、担当者、必要な判断または行動、推奨、期限、未実行の影響を示して働きかける。
- 通知しただけで責任を終えず、再確認、代替案、RACIに基づくエスカレーションまで追跡する。
- 完了は自己申告ではなく、成果物、API readback、顧客反応、実行receiptなどの証拠で確定する。

## 2. 正本と責務の境界

mana-runtimeに第二の業務正本を作らない。

| 対象 | 正本 | mana-runtimeの責務 |
|---|---|---|
| 顧客・プロジェクト・人物・RACI・意思決定 | Brainbase Graph SSOT | 実行前に参照し、候補をBrainbaseへ返す |
| 作業項目・担当・期限・状態 | Brainbase Canonical Task | 作成・更新・検索・リマインド・Slack投影 |
| 手順・分岐・承認・実行履歴・証跡 | Brainbase DAG / Automation Run | イベント受付、実行、承認UI、結果表示 |
| 会話・チャンネル・一時セッション | mana-runtime | tenant境界内で保持し、業務事実の正本にしない |
| Personal KG | Brainbase上の本人所有領域 | 本人認証に基づいて参照・候補送信し、組織管理者へ本文を開示しない |
| 監査・停止・予算 | placement policy / canonical Usage・Receipt | 実行時に強制し、状態と理由を可視化する |

## 3. 製品能力と配備形態

製品能力と配備形態を分離して管理する。マルチテナントを個人版・組織版とは別の機能階層にしない。

### 3.1 製品能力

| 能力 | 定義 |
|---|---|
| 個人版OSS | 個人の目的、判断、記憶、Task、Shipを進める共通Core |
| 組織版 | 個人版の全能力に、組織Graph、組織目標、RACI、共有Task・Ship、承認、監査、複数人への働きかけを加えた能力上の上位互換 |

組織版は**能力上の上位互換**であり、個人データへのアクセス権上の上位互換ではない。組織管理者であっても、本人のPersonal KG本文を当然には閲覧できない。組織版でも個人モードをそのまま利用でき、共有は本人同意と組織レビューを経た正規化済みの事実・判断・関係と根拠ポインタに限定する。

### 3.2 配備形態

| profile | 定義 |
|---|---|
| `customer_managed_oss` | 利用者が管理する環境で個人版または互換組織版を動かす |
| `dedicated_cloud` | 1 tenant専用のWorker、Queue、Container、credential境界で動かす |
| `shared_cloud` | 複数tenantを同じサービス基盤へ安全に収容し、実行ごとにcanonical tenantを解決する |

tenantは契約・データ分離・予算・監査の単位、organizationは業務上の組織Graph所有単位、workspace connectionはSlack等の外部接続、personは利用者、placementはマナの役割と権限である。Slack workspaceや会社名からtenantを暗黙推定しない。

### 3.3 検証先

| 検証先 | 主に証明すること |
|---|---|
| 個人版OSS | 共通Coreの単独利用、導入容易性、個人モードの互換性 |
| 梅田さん・雲孫バックオフィス | 同一organization内の人物分離、Personal KG境界、RACI、共有業務、組織版の実務Ship |
| TechKnight実運用 | `shared_cloud`の複数tenant分離、credential、冪等性、Usage・Receipt、障害分離、tenantごとの実務Ship |

梅田さん導入は組織内の縦方向、TechKnightは組織間の横方向を検証する。両方が成立して初めて、組織版を個人版の上位互換として提供できる。

## 4. 現在地

### リポジトリ上で確認できる実装

- Slack上の単一窓口、placementごとの権限・文脈・ツール境界
- Canonical Taskの作成・更新・遷移・検索、期限リマインド、Task Canvas投影
- 議事録の生成、保存先選択、タスク抽出・承認・登録、再実行・復旧
- 実行前のBrainbase Graph文脈取得と、取得失敗を`未確認`として残す境界
- Slack通常回答をBrainbase Judgment lifecycleへ接続し、回答前の判断・参照と実呼出を監査する境界
- 成功ターンをreview-required候補としてBrainbase Candidate Storeへ送るdurable outbox
- placement台帳、予算、kill switch、security event、実行receipt
- cron、Slackイベント、会議終了などを起点に処理を動かす土台
- TechKnightと雲孫を会社別Cloudflare deploymentとして分離する`dedicated_cloud`相当の土台

### 完了済みとして扱う旧ロードマップ項目

- Canonical Task writerのLightsail移設とBrainbase MCP task mutation
- 会議→議事録→タスク候補→承認→Canonical Task登録の基本動線
- 期限リマインドと複数workspaceのTask Canvas同期
- 実行前Graph文脈取得のランタイム実装
- 学習候補をGraphへ直接書かずCandidate Storeへ送る境界
- placement単位の台帳・予算・停止機構

### 未完・未確認

- 個人版OSSと組織版の共通Core契約、および「組織版で個人版契約テストを通す」互換ゲートは未固定
- actor、owner、organization、tenant、project、placementを一貫して伝播する共通Execution Contextは未完成
- 所有者やtenant未解決時に佐藤さん・雲孫・default placementへ寄らないfail-closed保証は未完成
- 梅田さん本人JWT、Personal KG相互非漏洩、本人レビュー、二段階Graph昇格、実務Shipの縦断E2Eは未取得
- GraphのRACIからplacementの権限・承認者・停止条件を生成する写像は未実装
- 人間確認は個別フローに実装されており、汎用HITLプリミティブになっていない
- 複数の専門実行先を選ぶ動的ディスパッチは未実装
- 学習候補の意味分類・機微区分・成果との関連付けは未完成
- マルチテナントStory [#234](https://github.com/Unson-LLC/mana-runtime/pull/234)、runtime Spec [#236](https://github.com/Unson-LLC/mana-runtime/pull/236)、横断E2E Spec [#237](https://github.com/Unson-LLC/mana-runtime/pull/237) は未マージ
- TechKnightの現行PoCは固定tenant・会社別deploymentであり、同一`shared_cloud`基盤へ複数実tenantを収容した本番証拠ではない
- Slack通常回答のBrainbase Judgment lifecycle [#241](https://github.com/Unson-LLC/mana-runtime/pull/241) はmainへ統合済みだが、本番のfresh Slack E2Eは未取得
- Lightsail・Cloudflare・各Slack tenantの機能同等性は、Storyごとのfresh本番E2Eがない限り確認済みにしない

## 5. 優先成果

### P0-A. 経営実行ループ

**目的**: 人間が仕事の一覧を見張らなくても、マナが「次に進まない理由」を検知し、適切な人へ働きかけ、成果確認まで閉じる。

マナはプロジェクトごとに次を追跡する。

- 達成すべき成果と成功条件
- 責任者、実行担当、承認者
- 次の行動、期限、依存関係
- 判断待ち、担当不在、停滞理由
- 成果物、実行receipt、本番readback

通常時は自律的に進め、次の例外だけを適切なRACIへ上げる。

- 人間にしか決められないトレードオフ
- 顧客・契約・予算・権限へ影響する変更
- 期限超過、担当不在、依存先停止
- 完了報告はあるが成果物または本番結果を確認できない状態

**最小受入条件**:

1. 1つの実プロジェクトで、Goal/Outcome→Ship→Task→担当→期限→証拠→完了を同一correlation IDで追える。
2. 期限超過・担当不在・判断待ち・依存停止・証拠不足を決定論的に検出できる。
3. 行動を`auto / approval / human_action / deny`へ決定論的に分類できる。
4. 人間へは全件一覧ではなく、判断または例外対応が必要な項目だけを、推奨・期限・放置影響付きで提示する。
5. 通知後も状態を追跡し、未解消なら再通知、代替案、RACIに基づくエスカレーションを行う。
6. 完了は自己申告ではなく、成果物・API readback・顧客反応・receiptのいずれかで確認する。未取得は`未確認`のまま残す。
7. 判断・実行・結果をBrainbaseの学習候補へ関連付けて戻す。

### P0-B. 組織版の上位互換と梅田さん導入

**目的**: 個人版OSSのCoreを分岐させず、組織版でも個人モードを維持しながら、組織目標・RACI・共有Task・Shipを扱えるようにする。

**必須境界**:

- 個人版と組織版でDecision→Work→Ship→Learnの共通契約を使う
- 組織版CIで個人版OSSの契約テストをそのまま通す
- actor、owner、organization、tenant、project、placement、correlation IDを別フィールドとして保持する
- ownerまたはorganization未解決時に佐藤さんや雲孫へフォールバックしない
- Personal KG本文は本人だけが利用し、組織管理者には同期状態・件数・監査結果だけを見せる
- Personalから組織Graphへの共有は本人同意と組織採用の二段階承認にする
- 梅田さん固有の条件分岐をruntime coreへ追加しない

**梅田さん縦断受入条件**:

1. 梅田さん本人のJWTでCodex・Claude Codeから接続し、person・organization・project scopeをreadbackできる。
2. 佐藤さんと梅田さんのPersonal KGが相互に検索・更新できず、存在自体を推測できない。
3. `雲孫バックオフィス`の組織文脈と担当Taskは、梅田さんのRACI範囲で参照・更新できる。
4. 会話→Personal KG候補→本人編集・承認→次の会話で再利用を同一runで完走する。
5. 組織共有は、本人同意後に別の組織reviewerが採用し、Graphへは正規化した事実・判断と根拠ポインタだけを昇格する。
6. バックオフィスの実務Shipを1件、証拠付きで完了する。
7. 梅田さんが初回価値を`useful / not_useful`で評価し、receiptと関連付ける。

現行のauth grantと本番反映状態は未確認であり、ステージングE2E成功前に本番アクセス済みと扱わない。

### P0-C. TechKnight shared-cloudマルチテナント本番

**目的**: TechKnightの実運用要件として、複数実tenantを同じサービス基盤へ安全に収容し、tenantごとの実務成果まで閉じる。

実装の契約正本候補は [#234](https://github.com/Unson-LLC/mana-runtime/pull/234) → [#236](https://github.com/Unson-LLC/mana-runtime/pull/236) → [#237](https://github.com/Unson-LLC/mana-runtime/pull/237) とBrainbase側の対応契約である。契約が未マージのまま別仕様をruntime coreへ追加しない。

**Safety Gate**:

- Slack OAuth installationをBrainbase `workspace_connection`へ登録し、workspace IDや会社名からtenantを推測しない
- 未契約、未登録、失効、別app、scope不足、複数一致をQueue投入・LLM実行前にfail closedする
- 署名付きtenant contextをWorker、Queue、Durable Object、Container、MCP、Brainbase proxy、Slack delivery、Receiptへ伝播し、各境界で再検証する
- connection revisionをingress、credential lease直前、Brainbase write直前、Slack delivery直前に再確認する
- session、thread、file、cache、credential、MCP config、idempotency、Usage、Receipt、budget、retry状態をtenant分離する
- protocol v1ではcross-tenant Container再利用を行わず、tenant変更時は破棄する
- tenant A/Bの同時処理、同名workspace/channel/user、再配送、失効、予算超過、Container再生成の否定E2Eを通す
- Tenant Aのcredential失効・予算超過・Queue障害でTenant Bを停止させない

**Value Gate**:

1. TechKnightが運用する少なくとも2つの実tenantで、本番Slack成功経路と境界拒否をreadbackする。
2. 最初は一般返信・read-only検索をcanaryし、その後にTask write、議事録、外部操作を段階開放する。
3. 各tenantで少なくとも1件、依頼→文脈/RACI解決→実行または承認→外部Ship→readback→tenant付きReceiptを完走する。
4. 機能実装、CI、Container health、Slack HTTP 200だけを完了扱いにしない。
5. rollback時は対象tenantのwrite capabilityを先に停止し、既知の`dedicated_cloud`またはread-only経路へ戻せる。

### P1-A. 汎用ワークフロー・HITL

**目的**: 業務ごとの個別コードを減らし、「人間は確認だけ」の仕事を量産する。

```text
イベント
  → 正本から事実を取得
  → 実行案を作成
  → policyとRACIで auto / approval / human_action / deny を決定
  → 実行
  → readback
  → receipt
  → 失敗時の再試行・補償・差し戻し
```

手順・分岐・実行状態はBrainbase DAG / Automation Runを正本とし、mana-runtimeはSlack入力、実行adapter、承認表示を担う。mana-runtime内に別のDAG正本を作らない。

第1号は月次経理、第2号は顧客案件の週次進行管理とする。両者で同じ承認・再試行・readback契約を再利用できた時点で「量産可能」と判定する。

### P1-B. 顧客案件の共通運用テンプレート

**目的**: 案件を受けるほど、個別対応ではなく再利用可能なmana-runtime資産が増える状態を作る。

共通化する範囲:

- 導入ヒアリングとworkspace connection
- 顧客・プロジェクト・RACI・停止条件のGraph登録
- 会議・Slack・メールからの仕事の捕捉
- 週次の進行、停滞検知、判断依頼
- 成果物確認、顧客報告、継続・追加提案
- tenantごとのコスト・品質・委任実績

固有コードを追加する前に、共通Storyへ昇格できるかを確認する。1社だけに必要な処理はadapterまたは設定として隔離し、runtime coreへ混ぜない。

### P2-A. 成果から学ぶ仕組み

**目的**: 会話を大量保存するのではなく、成果につながった判断と失敗した実行を次の仕組みへ戻す。

- 判断と成果の関連付け
- 手戻り・失敗・停止理由の分類
- 委任先・ワークフロー・条件別の成功率
- 自動実行可能な条件の候補化
- 人間レビュー後のGraph、Skill、DAGへの昇格

候補は自動で真理や実行ルールへ昇格させない。証拠、機微区分、影響範囲、推奨を提示し、人間承認を必須とする。

### P2-B. 委任の経営指標

委任率ダッシュボードは表示だけで終わらせず、経営実行ループの改善判断へ接続する。

| 指標 | 意味 |
|---|---|
| 人間の判断介入1回あたりの完了成果数 | 北極星。認知帯域を成果へ変換できたか |
| 無介入完了率 | 定常業務が人間の見張りなしに閉じた割合 |
| 判断から実行までの時間 | 決定後の停滞を減らせたか |
| 期限超過時間 | 問題の長期放置を減らせたか |
| 証拠付き完了率 | 完了自己申告ではなく成果を確認できたか |
| 手戻り率 | 自動化が仕事を増やしていないか |
| 成果単位のAI費用 | 安い会話ではなく効率的な成果を出せたか |
| Personal KG越境件数 | 同一organization内の個人情報境界。目標は0件 |
| tenant境界事故件数 | 複数社提供の安全性。目標は0件 |

## 6. 実装レーンと順序

4レーンを並行させるが、同じ受入シナリオへ合流させる。

| Lane | 対象 |
|---|---|
| Core Compatibility | 個人版OSSと組織版の共通Core、Execution Context、互換契約 |
| Organization Capability | Person/Organization境界、Personal KG、RACI、共有Task・Ship、承認 |
| TechKnight Shared Cloud | workspace connection、tenant context、credential、隔離、Usage・Receipt、運用 |
| Value Validation | 梅田さんとTechKnightの実務で経営実行ループと証拠付きShipを閉じる |

| 順 | 成果 | 完了判定 |
|---|---|---|
| 1 | 製品・tenant横断契約を確定 | 本ロードマップ、統合計画、関連Story、#234→#236→#237の依存関係が整合し、契約上の未決事項が0件 |
| 2 | 共通Execution Contextとno-fallbackを固定 | actor/owner/organization/tenant/project/placementが全入口で解決され、未解決・不一致をモデル実行前に拒否 |
| 3 | 梅田さんステージング縦断 | 本人JWT、Personal KG相互非漏洩、会話学習、本人レビュー、組織共有候補、実務Ship、評価を同一runで確認 |
| 4 | TechKnight read-only canary | 少なくとも2実tenantで成功・拒否・再配送・credential分離・Usage/Receiptを本番readback |
| 5 | TechKnight write canary | tenant別にTask writeまたは議事録を段階開放し、二重実行なしで実務Shipを完了 |
| 6 | 経営実行ループを両検証先へ適用 | 停滞検知、働きかけ、承認、readback、証拠付き完了を梅田さん業務とTechKnight tenantで再利用 |
| 7 | 汎用HITLとAutomation Run接続 | 月次経理と顧客週次の2業務が同じ契約を再利用 |
| 8 | 顧客案件テンプレートと成果学習へ展開 | 固有コードを増やさず、導入から報告・改善候補まで再現 |

P0-A、P0-B、P0-Cは並行可能だが、次の依存を崩さない。

- 個人版・組織版の共通Coreを分岐させない。
- 梅田さん本番付与は、本人分離とステージングE2Eの後に行う。
- TechKnight write開放は、tenant contextと本番否定E2Eの後に行う。
- Safety Gateだけ、またはValue Gateだけを通して組織版・shared-cloud完了としない。

## 7. 今は優先しないもの

- 表に見える専門エージェントや人格の追加
- 顧客ごとの一回限りのコネクタをruntime coreへ追加すること
- 梅田さん・TechKnight tenant名を条件分岐へ埋め込むこと
- 成果との関係を説明できない会話メモリの拡大
- 人間レビューを経ない自己改変・自己開発
- 行動・承認・readbackへ接続しない閲覧専用ダッシュボード
- shared-cloudのSafety/Value Gateより先に課金、セルフサービス申込、reseller管理を作ること
- production evidenceのない「対応済み」「同等」「自動化済み」という表現

新機能は「人間の判断介入を減らしながら、証拠付きの成果を増やすか」「個人・組織・tenant境界を弱めないか」で採否を決める。

## 8. 進捗記録

- 2026-07-29: Canonical Task writerをLightsailへ移設し、Brainbase MCPへtask mutationを追加。
- 2026-07-30: 会議→議事録→タスク提案→承認→Canonical Task登録、期限リマインド、議事録パイプラインのpilotを成立。
- 2026-08-04: 実行前Graph文脈取得、学習候補outbox、人格・Skill・memory境界の現在地をアーキテクチャへ反映。
- 2026-08-14〜16: 複数workspaceのTask Canvas、権限内タスク横断取得、議事録のBrainbase文脈・証跡・停止境界、復旧動線をmainへ統合。
- 2026-08-17: 完了済みの旧優先順位を廃止。北極星を「判断介入1回あたりの完了成果数」とし、経営実行ループ、マルチテナント安全境界、汎用ワークフロー、顧客案件テンプレート、成果学習の順へ更新。
- 2026-08-19: 個人版OSSと組織版の上位互換関係、製品能力と配備形態の二軸、梅田さん導入とTechKnight実運用の検証分担、Safety GateとValue Gateを正本へ追加。

## 9. 更新時の証拠規則

- `main`へ存在すること、CI成功、デプロイ、process health、利用者成果を別々に記録する。
- 本番確認のない実装は「リポジトリ実装済み」と書き、「本番稼働済み」と書かない。
- timeout、権限不足、部分取得、接続失敗は0件や成功へ丸めず、`未確認`または`not_collected`として残す。
- 完了条件はStoryの利用者成果、実行receipt、本番readbackで固定する。
- Personal KG境界は本人同士の相互非漏洩E2E、tenant境界は異なる実tenant間の否定E2Eで証明する。
- Safety GateとValue Gateを別々に記録し、片方の成功をもう片方へ読み替えない。
- 進行状態はCanonical TaskまたはAutomation Runへ置き、この文書へ日々の状態を重複保存しない。
