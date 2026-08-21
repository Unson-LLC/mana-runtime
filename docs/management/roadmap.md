# mana-runtime ロードマップ（正本）

- **初版**: 2026-07-29
- **最終更新**: 2026-08-19
- **現在地の基準**: `main` `66e8821f4020e6d35b5d2403127afe24012c27d4`
- **M0正本**: [Brainbase-owned Company Authority](milestones/M0-brainbase-owned-company-authority.md)
- **設計正本**: [Brainbase-owned Company Authority](../architecture/13_brainbase_owned_company_authority.md)
- **統合計画**: [組織版・マルチテナント・経営実行ループ統合計画](../plans/2026-08-19-organization-edition-and-multitenant-rollout.md)

**維持**: 方針変更はこのファイルを更新してからStory・Spec・Canonical Taskへ展開する。会議・Slackでの発言は、ここへ反映されるまでロードマップの正本ではない。日々の進捗はCanonical TaskまたはAutomation Runへ置き、本書へ重複保存しない。

**現在の依存順**: `M0 Company Authority → M1 Personal Boundary → M2 Umeda → M3 TechKnight → M4 Management Execution → M5 OSS/Organization Superset`。tenant infrastructureは並行できるが、会社データoperationはM0を通過するまで開放しない。

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

マナの行動原則を次で固定する。

- 会社・プロジェクト・人物・責任・権限・過去判断をBrainbaseから解決してから動く。
- MANAはcanonical person、organization、project、owner、RACI、approver、policyを自己生成しない。
- Brainbaseが外部subject、membership、resource、RACI、policyを正本解決し、署名済みCanonical Execution Contextを発行する。
- 権限内の仕事は、下書きではなく実行・外部readback・証拠取得まで自律的に進める。
- 人間にしかできない仕事は、Brainbaseが指定した担当者へ、必要な判断または行動、推奨、期限、未実行の影響を示して働きかける。
- 通知しただけで責任を終えず、再確認、代替案、RACIに基づくエスカレーションまで追跡する。
- 完了は自己申告ではなく、成果物、API readback、顧客反応、Operation Receiptなどの証拠で確定する。
- 未取得、部分取得、権限不足、timeoutを成功や0件へ丸めない。

## 2. 正本と責務の境界

mana-runtimeに第二の業務正本を作らない。

| 対象 | 正本 | mana-runtimeの責務 |
|---|---|---|
| canonical person・membership・organization・project・RACI・policy・authority decision | Brainbase Graph / Company Authority | provider identityとrequested actionを送り、署名済みcontextを実行する |
| 顧客・プロジェクト・人物・意思決定 | Brainbase Graph SSOT | 実行前に参照し、候補をBrainbaseへ返す |
| 作業項目・担当・期限・状態 | Brainbase Canonical Task | 作成・更新・検索・リマインド・Slack投影 |
| 手順・分岐・承認・実行履歴・証跡 | Brainbase DAG / Automation Run | イベント受付、実行adapter、承認UI、結果表示 |
| Personal KG | Brainbase上の本人所有領域 | Brainbase解決済みownerで参照・候補送信し、組織管理者へ本文を開示しない |
| tenant・workspace connection・quota・credential正本 | Brainbase control plane | 署名付きcontext・短命leaseを受け、実行時に強制する |
| 会話・チャンネル・一時セッション | mana-runtime | tenant境界内で保持し、業務事実の正本にしない |
| Queue・Slack deliveryの冪等性 | mana-runtime | runtime effectをclaimし、canonical Receiptへ関連付ける |

workspace connection hintは移行中の非権威cacheであり、Brainbase authoritative readbackより優先しない。hint単独でLLM、Graph、Task、credentialへ到達させない。

## 3. 製品能力と配備形態

製品能力と配備形態を分離して管理する。マルチテナントを個人版・組織版とは別の機能階層にしない。

### 3.1 製品能力

| 能力 | 定義 |
|---|---|
| 個人版OSS | 個人の目的、判断、記憶、Task、Shipを進める共通MANA Core |
| 組織版 | 個人版の全能力に、組織Graph、組織目標、RACI、共有Task・Ship、承認、監査、複数人への働きかけを加えた能力上の上位互換 |

組織版は**能力上の上位互換**であり、個人データへのアクセス権上の上位互換ではない。組織管理者であっても、本人のPersonal KG本文を当然には閲覧できない。組織版でも個人モードをそのまま利用でき、組織共有は本人同意と組織レビューを経た正規化済みの事実・判断・関係と根拠ポインタに限定する。

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

梅田さん導入は組織内の縦方向、TechKnightは組織間の横方向を検証する。両方が成立して初めて、組織版を個人版の能力上の上位互換として提供できる。

## 4. 現在地

### 4.1 `main`へ統合済み

マルチテナント実装は旧umbrellaをそのまま入れず、責務別のR1〜R5へ分割して順次統合した。

| PR | 統合内容 | merge commit |
|---|---|---|
| [#294](https://github.com/Unson-LLC/mana-runtime/pull/294) | canonical tenant contract、schema、fixture、conformance | `b59171154be4042104175cc3c19292f4aac6203c` |
| [#295](https://github.com/Unson-LLC/mana-runtime/pull/295) | tenant runtime、Queue、Durable Object、idempotency、Usage・Receipt継続 | `56cb926352472644178c843fa16ba858b4af7cd8` |
| [#296](https://github.com/Unson-LLC/mana-runtime/pull/296) | Slack ingress、commands、OAuth installation、control-plane bridge | `9536956dd2add4de16e0fa8b49535dc2f8561e6a` |
| [#297](https://github.com/Unson-LLC/mana-runtime/pull/297) | 議事録、Slack操作、Task Canvasをtenant境界へ移行 | `eb3fb8cbd7f0e542cfc86d9405afa766725779e7` |
| [#298](https://github.com/Unson-LLC/mana-runtime/pull/298) | provider credential、tenant Container、配備profile、readiness/security | `701d71229ae7aa3b7c52a8659eb8e5fb3f8e6e5c` |

Brainbase producer側の対応契約 [#1257](https://github.com/Unson-LLC/brainbase-unson/pull/1257) も統合済みである。canonical source-lockは `merge_allowed: true`、`deploy_allowed: false` を維持する。`deploy_allowed: true` は、レビュー済み構成を本番検証へ投入してよいという許可であり、実Slack E2E、Safety／Value Gate、切替完了を意味しない。

既存機能として、以下もリポジトリ上に存在する。

- Slack上の単一窓口、placementごとの権限・文脈・ツール境界
- Canonical Taskの作成・更新・遷移・検索、期限リマインド、Task Canvas投影
- 議事録の生成、保存先選択、タスク抽出・承認・登録、再実行・復旧
- 実行前のBrainbase Graph文脈取得と、取得失敗を`未確認`として残す境界
- Slack通常回答とBrainbase Judgment lifecycleの接続
- 学習候補をCandidate Storeへ送るdurable outbox
- placement台帳、予算、kill switch、security event、実行receipt
- `customer_managed_oss | dedicated_cloud | shared_cloud`の配備profileとdry-run readiness
- [本番E2E採取runbook](../operations/mana-multitenant-production-e2e-runbook.md)

### 4.2 整理済みの旧PR

- [#234](https://github.com/Unson-LLC/mana-runtime/pull/234) は旧stackとしてsuperseded close。
- [#237](https://github.com/Unson-LLC/mana-runtime/pull/237) は親stackへ包含済みとしてclose。
- [#292](https://github.com/Unson-LLC/mana-runtime/pull/292) はR1〜R5へ分割済みとしてsuperseded close。
- Brainbase [#1229](https://github.com/Unson-LLC/brainbase-unson/pull/1229) は`develop`へ完全包含済みのためclose。

旧PRを再open、再merge、cherry-pickしない。実装正本は現在の`main`とcanonical contractである。

### 4.3 未完・未確認

- 現行tenant contextはtenant・connection・contractを正本確認する一方、runtimeが組み立てたactor／authorizationを署名する経路が残る。canonical person、membership、organization、project、RACI、policyをBrainbaseが正本解決する`company_authority_v1`は未実装。
- MANA側にSlack requesterからactorを作り、required project／capabilityからauthorizationを作る経路が残る。
- runtime workspace hintを非権威cacheとして強制する契約は未完成。
- Cloudflare本番配備、実Slack、Brainbase UsageEvent・Operation Receiptの横断readbackは`not_collected`。
- TechKnightの2つ以上の実tenantを使う成功・越境拒否・revision更新・再配送・障害分離E2Eは未取得。
- [#293](https://github.com/Unson-LLC/mana-runtime/pull/293) は横断E2E Story・SpecのDraftであり、本番証拠ゲートとして未完。
- source-lockの`deploy_allowed`は`false`であり、現時点ではレビュー済み構成の本番検証投入も未許可である。値が`true`になっても、コード統合を本番稼働、E2E、切替完了へ読み替えない。
- 個人版OSSと組織版の共通Core契約、および組織版CIで個人版契約テストを通す互換ゲートは未完成。
- actor、owner、organization、tenant、project、placementを、個人・組織・shared-cloud全経路で統一する上位Execution Contextは未完成。
- 所有者やorganization未解決時に佐藤さん・雲孫へ寄らないno-fallback保証は未完成。
- 梅田さん本人JWT、Personal KG相互非漏洩、本人レビュー、二段階Graph昇格、実務Shipの縦断E2Eは未取得。
- GraphのRACIからplacementの権限・承認者・停止条件を生成する写像は未実装。
- 人間確認は個別フローに実装されており、汎用HITLプリミティブになっていない。
- 複数の専門実行先を選ぶ動的ディスパッチは未実装。
- 学習候補の意味分類・機微区分・成果との関連付けは未完成。

## 5. 優先成果

### P0-0. Brainbase-owned Company Authority

**目的**: Brainbaseが会社権限を正本解決し、MANAが署名済みcontextだけを実行する。

M0の必須成果:

1. external subject→canonical person→active membershipをBrainbaseが解決する。
2. organization、project、resource ownershipをBrainbaseが解決する。
3. RACI、delegation、policyから`auto / approval / human_action / deny`を決定する。
4. `CanonicalExecutionContextV1`を署名し、identity／membership／resource／RACI／policy revisionを固定する。
5. MANA側のcanonical actor／authorization生成を削除する。
6. Worker、Queue、DO、Container、MCP、Brainbase proxy、Slack deliveryでcontextを再検証する。
7. company authority欠落時はhealth、provisioning、connection診断、tenant否定テスト以外の会社データoperationを拒否する。
8. 2 tenant × 2 personで正常・越境・stale・誤承認者・再配送E2Eを通す。

正本は[M0](milestones/M0-brainbase-owned-company-authority.md)と[設計](../architecture/13_brainbase_owned_company_authority.md)である。

### P0-A. 経営実行ループ

**依存**: P0-0とPersonal no-fallbackが完了してから、RACIに基づく実行を本番開放する。

**目的**: 人間が仕事の一覧を見張らなくても、マナが「次に進まない理由」を検知し、適切な人へ働きかけ、成果確認まで閉じる。

マナはプロジェクトごとに次を追跡する。

- Goal / Outcome / Shipと成功条件
- 責任者、実行担当、承認者
- 次の行動、期限、依存関係
- 判断待ち、担当不在、停滞理由
- 成果物、実行receipt、本番readback

**最小受入条件**:

1. Goal/Outcome→Ship→Task→担当→期限→証拠→完了を同一correlation IDで追える。
2. 期限超過・担当不在・判断待ち・依存停止・証拠不足を決定論的に検出できる。
3. 行動を`auto / approval / human_action / deny`へBrainbase authorityから取得する。
4. 人間へは判断または例外対応が必要な項目だけを、推奨・期限・放置影響付きで提示する。
5. 通知後も状態を追跡し、未解消なら代替案とRACIに基づくエスカレーションを行う。
6. 完了は成果物・API readback・顧客反応・Receiptで確認し、未取得は`not_collected`のまま残す。
7. 判断・実行・結果をBrainbaseの学習候補へ関連付けて戻す。

### P0-B. 組織版の上位互換と梅田さん導入

**依存**: P0-0、Personal owner no-fallback、二段階昇格。

**目的**: 個人版OSSのCoreを分岐させず、組織版でも個人モードを維持しながら、組織目標・RACI・共有Task・Shipを扱えるようにする。

**必須境界**:

- 個人版と組織版でDecision→Work→Ship→Learnの共通契約を使う。
- 組織版CIで個人版OSSの契約テストをそのまま通す。
- actor、owner、organization、tenant、project、placement、correlation IDを別フィールドとして保持する。
- ownerまたはorganization未解決時に佐藤さんや雲孫へフォールバックしない。
- Personal KG本文は本人だけが利用し、組織管理者には同期状態・件数・監査結果だけを見せる。
- Personalから組織Graphへの共有は本人同意と組織採用の二段階承認にする。
- 梅田さん固有の条件分岐をruntime coreへ追加しない。

**梅田さん縦断受入条件**:

1. 梅田さん本人のJWTでCodex・Claude Codeから接続し、canonical person、membership、organization、project scopeをreadbackできる。
2. 佐藤さんと梅田さんのPersonal KGが相互に検索・更新できず、存在自体を推測できない。
3. `雲孫バックオフィス`の組織文脈と担当TaskをBrainbase authorityの範囲で参照・更新できる。
4. 会話→Personal KG候補→本人編集・承認→次の会話で再利用を同一runで完走する。
5. 組織共有は、本人同意後に別の組織reviewerが採用し、Graphへは正規化した事実・判断と根拠ポインタだけを昇格する。
6. バックオフィスの実務Shipを1件、証拠付きで完了する。
7. 梅田さんが初回価値を`useful / not_useful`で評価し、Receiptと関連付ける。

### P0-C. TechKnight shared-cloud本番E2E

**目的**: `main`へ統合済みのマルチテナント実装を、TechKnightの実運用で安全性と価値の両面から検証し、証拠が揃った後だけdeploy gateを開く。

**並行可能範囲**: tenant provisioning、workspace connection、credential broker、Usage／Receipt、Queue／Container isolation、health、protocol、connection診断。

**P0-0前に禁止する範囲**: organization Graph／Task／Personal KGのbusiness read／write、外部side effect、RACI承認。

**Safety Gate**:

- 少なくとも2つの実tenantをBrainbase `workspace_connection`へ登録する。
- 未契約、未登録、失効、別app、scope不足、複数一致をQueue投入・LLM実行前にfail closedする。
- 署名付きtenant／company authority contextをWorker、Queue、Durable Object、Container、MCP、Brainbase proxy、Slack delivery、Receiptへ伝播し、各境界で再検証する。
- connection、membership、resource、RACI、policy revisionを副作用直前に再確認する。
- session、thread、file、cache、credential、MCP config、idempotency、Usage、Receipt、budget、retry状態をtenant分離する。
- protocol v1ではcross-tenant Container再利用を行わない。
- tenant A/Bの同時処理、同名workspace/channel/user、再配送、失効、予算超過、依存障害の否定E2Eを通す。
- Tenant Aの障害・失効・予算超過でTenant Bを停止させない。

**Value Gate**:

1. M0通過後、一般返信・company-authority付きread-only検索をtenant単位でcanaryする。
2. 成功、越境拒否、再配送、revision更新、credential・quota・accounting障害を同一runでreadbackする。
3. 安全性確認後にTask write、議事録、外部操作をtenant単位で段階開放する。
4. 各tenantで少なくとも1件、依頼→company authority解決→実行または承認→外部Ship→readback→tenant付きReceiptを完走する。
5. Cloudflare返信1件、旧runtime返信0件、UsageEventとOperation ReceiptのBrainbase正本readbackを確認する。
6. `deploy_allowed`はレビュー済み構成を本番検証へ投入するための前段ゲートとし、Safety Gate、Value Gate、実Slack／Brainbase readback、切替完了は後段の独立ゲートとして記録する。

### P1-A. 汎用ワークフロー・HITL

**目的**: 業務ごとの個別コードを減らし、「人間は確認だけ」の仕事を量産する。

```text
イベント
  → Brainbaseが事実とcompany authorityを解決
  → 実行案を作成
  → auto / approval / human_action / deny
  → 実行
  → readback
  → receipt
  → 失敗時の再試行・補償・差し戻し
```

手順・分岐・実行状態はBrainbase DAG / Automation Runを正本とし、mana-runtimeはSlack入力、実行adapter、承認表示を担う。第1号は月次経理、第2号は顧客案件の週次進行管理とする。両者で同じ承認・再試行・readback契約を再利用できた時点で「量産可能」と判定する。

### P1-B. 顧客案件の共通運用テンプレート

共通化する範囲:

- 導入ヒアリングとworkspace connection
- 顧客・プロジェクト・RACI・停止条件のGraph登録
- 会議・Slack・メールからの仕事の捕捉
- 週次の進行、停滞検知、判断依頼
- 成果物確認、顧客報告、継続・追加提案
- tenantごとのコスト・品質・委任実績

1社だけに必要な処理はadapterまたは設定として隔離し、runtime coreへ混ぜない。

### P2. 成果学習と委任指標

- 判断と成果の関連付け
- 手戻り・失敗・停止理由の分類
- 委任先・ワークフロー・条件別の成功率
- 自動実行可能な条件の候補化
- 人間レビュー後のGraph、Skill、DAGへの昇格

| 指標 | 意味 |
|---|---|
| 人間の判断介入1回あたりの完了成果数 | 北極星。認知帯域を成果へ変換できたか |
| 無介入完了率 | 定常業務が人間の見張りなしに閉じた割合 |
| 判断から実行までの時間 | 決定後の停滞を減らせたか |
| 期限超過時間 | 問題の長期放置を減らせたか |
| 証拠付き完了率 | 自己申告ではなく成果を確認できたか |
| 手戻り率 | 自動化が仕事を増やしていないか |
| 成果単位のAI費用 | 安い会話ではなく効率的な成果を出せたか |
| company authority不一致件数 | person／membership／RACI／policy境界。目標0件 |
| Personal KG越境件数 | 同一organization内の個人情報境界。目標0件 |
| tenant境界事故件数 | 複数社提供の安全性。目標0件 |

## 6. 実装レーンと順序

5レーンを並行させるが、M0を先に同じ受入シナリオへ合流させる。

| Lane | 対象 |
|---|---|
| Company Authority | external identity、canonical person、membership、RACI、policy、signed context |
| Core Compatibility | 個人版OSSと組織版の共通Core、上位Execution Context、互換契約 |
| Organization Capability | person/organization境界、Personal KG、共有Task・Ship、二段階承認 |
| TechKnight Shared Cloud | workspace connection、tenant context、credential、隔離、Usage・Receipt、本番運用 |
| Value Validation | 梅田さんとTechKnightの実務で経営実行ループと証拠付きShipを閉じる |

| 順 | 成果 | 完了判定 |
|---|---|---|
| 1 | M0 company authority契約を固定 | Brainbase producer、MANA consumer、schema、fixture、source-lockが一致 |
| 2 | canonical identity／scope／RACI／policy解決 | unknown／ambiguous／stale／cross-scopeを業務処理前に拒否 |
| 3 | MANAをauthority consumerへcutover | MANA側のcanonical actor／authorization生成0件、全境界再検証 |
| 4 | M1 Personal境界 | default owner 0件、相互非漏洩、本人同意と組織採用の二段階昇格 |
| 5 | M2 梅田さんステージング縦断 | 本人JWT、会話学習、本人レビュー、二段階共有、実務Ship、評価 |
| 6 | M3 TechKnight read-only canary | 2実tenantでcompany authority、成功・拒否・再配送・Usage/Receiptをreadback |
| 7 | TechKnight write canary | tenant別にTask write／議事録を段階開放し、二重実行なしで実務Shipを完了 |
| 8 | M4 経営実行ループを両検証先へ適用 | 停滞検知、働きかけ、承認、readback、証拠付き完了を同じ契約で再利用 |
| 9 | 汎用HITLとAutomation Run接続 | 月次経理と顧客週次の2業務が同じ契約を再利用 |
| 10 | M5 Supersetと成果学習 | 組織版CIで個人版contract全通過、CLI／MCP公開面と価値が一致 |

次の依存を崩さない。

- MANAはBrainbase解決前にcanonical actor、organization、project、owner、RACIを決めない。
- 個人版・組織版の共通Coreを分岐させない。
- 梅田さん本番付与は、M0、Personal分離、ステージングE2Eの後に行う。
- TechKnight本番deployのインフラ準備は並行できるが、会社データoperationはM0後に開放する。
- TechKnight write開放は、company-authority付きread-only canaryと本番否定E2Eの後に行う。
- Safety Gateだけ、またはValue Gateだけを通して組織版・shared-cloud完了としない。

## 7. 今は優先しないもの

- M0を通さずに組織版CLI／MCPの入口数を増やすこと
- company authority証拠なしの23/23上位互換宣言
- 表に見える専門エージェントや人格の追加
- 顧客ごとの一回限りのコネクタをruntime coreへ追加すること
- 梅田さん・TechKnight tenant名を条件分岐へ埋め込むこと
- 成果との関係を説明できない会話メモリの拡大
- 人間レビューを経ない自己改変・自己開発
- 行動・承認・readbackへ接続しない閲覧専用ダッシュボード
- shared-cloudのSafety/Value Gateより先に課金、セルフサービス申込、reseller管理を作ること
- production evidenceのない「対応済み」「同等」「自動化済み」という表現

## 8. 進捗記録

- 2026-07-29: Canonical Task writerをLightsailへ移設し、Brainbase MCPへtask mutationを追加。
- 2026-07-30: 会議→議事録→タスク提案→承認→Canonical Task登録、期限リマインド、議事録pilotを成立。
- 2026-08-04: 実行前Graph文脈取得、学習候補outbox、人格・Skill・memory境界をアーキテクチャへ反映。
- 2026-08-14〜16: 複数workspaceのTask Canvas、権限内タスク横断取得、議事録のBrainbase文脈・証跡・復旧動線を統合。
- 2026-08-17: 北極星を「判断介入1回あたりの完了成果数」とし、経営実行ループを優先成果へ変更。
- 2026-08-19: Brainbase producer契約とmana-runtime R1〜R5を`main`へ統合。旧stackをsuperseded closeし、本番E2Eを#293とrunbookへ集約。コード統合とdeploy gateを分離。
- 2026-08-19: 個人版OSSと組織版の上位互換関係、製品能力と配備形態の二軸、梅田さん導入とTechKnight実運用の検証分担、Safety GateとValue Gateを追加。
- 2026-08-19: tenant safetyとcompany authorityを分離し、Brainbase-owned Company AuthorityをM0へ昇格。MANAを署名済み権限のconsumerへ限定し、CLI、梅田さん、TechKnight会社データcanary、経営実行ループの依存順を修正。

## 9. 更新時の証拠規則

- `main`へ存在すること、PR exact-head CI、main CI、デプロイ、process health、利用者成果を別々に記録する。
- 本番確認のない実装は「リポジトリ実装済み」と書き、「本番稼働済み」と書かない。
- timeout、権限不足、部分取得、接続失敗は0件や成功へ丸めず、`partial`または`not_collected`として残す。
- 完了条件はStoryの利用者成果、Operation Receipt、本番readbackで固定する。
- company authorityはunknown／ambiguous person、inactive membership、cross-scope resource、stale RACI／policy、誤承認者の否定E2Eで証明する。
- Personal KG境界は本人同士の相互非漏洩E2E、tenant境界は異なる実tenant間の否定E2Eで証明する。
- company authority、Personal、tenantの3境界を別々に記録し、片方の成功を他方へ読み替えない。
- Safety GateとValue Gateを別々に記録し、片方の成功をもう片方へ読み替えない。
- source-lockの`merge_allowed`と`deploy_allowed`を別ゲートとして扱う。`deploy_allowed`はレビュー済み構成の本番検証投入許可であり、E2E・Safety／Value Gate・切替完了の証明ではない。
- 旧superseded PRを実装正本へ戻さない。
