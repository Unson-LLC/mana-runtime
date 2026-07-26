# Channel Placement Profiles

Status: Accepted — Phase 1 implemented

Scope: brainbase-mana / OpenRyoko Slack runtime

Last updated: 2026-07-26

## 1. Purpose

OpenRyokoを単一の汎用エージェントとして全チャンネルへ露出させるのではなく、Slack上の配置ごとに対象者、職務、利用可能な能力、参照可能な正本、送信先を定義する。

基本方針は次のとおり。

- 同じ信頼境界では、1つのOpenRyokoランタイム上に複数のChannel Placement Profileを置く。
- チャンネルごとのプロファイルで論理分離する。
- 顧客、社外、機密区分など信頼境界が異なる場合は、ランタイム、OSユーザー、Slackアプリ、必要に応じてホストも物理分離する。
- Graph SSOTを事実の正本とし、Ryoko固有メモリを第二の正本にしない。
- 権限制御はプロンプトへのお願いではなく、実行前後の認可として強制する。

ただし、同一ランタイム・同一OSユーザー内のPlacementはアプリケーション認可であり、OSサンドボックスではない。Claude子プロセスが任意コードを実行できる配置を敵対的な信頼境界として扱ってはならない。prompt injection耐性や顧客間隔離が必要な場合は、別OSユーザーまたは別ランタイムへ分離する。

## 2. Baseline before Phase 1

現在のパイロットは「ランタイム1つ、実質的な配置1つ」である。

- Slackの利用者は`allowFrom`で限定している。
- 配信先チャンネルはcronやSlackイベントの文脈に設定されている。
- Employee YAMLでpersona、model、MCPの一部を切り替えられる。
- 朝ブリーフィングはcronのprompt、employee、model、delivery channelとして設定されている。
- Graphの参照範囲や読み取り専用条件は、主にプロンプトで指示している。
- channel、audience、project、skills、tools、Graph scopeを一つに束ねる正式な設定単位はなかった。

Phase 1ではChannel Placement Profile、入力時のfail-closed解決、従業員・モデル・出力先の認可、既存セッションの権限再束縛を実装した。Graphクエリのサーバー側scope強制、cron/skillのplacement統合、監査記録の永続化は後続フェーズで扱う。

## 3. Target architecture

```text
Slack event / cron trigger
          |
          v
Placement Resolver (workspace + channel + trigger)
          |
          v
Audience Authorization (user / role / membership)
          |
          v
Capability Resolver (employee / model / skills / tools)
          |
          v
Data Scope Enforcement (Graph / repository / secrets)
          |
          v
Agent execution (Sonnet by default, Opus by escalation)
          |
          v
Output Authorization (destination / operation / approval)
          |
          v
Slack response + audit record
```

重要なのは、入力時の認可だけでなく、ツール実行時と出力時にも同じプロファイルを再検証することである。

## 4. Placement Profile

Placement Profileは、Slack上の配置とRyokoの職務・権限を結び付ける最小単位である。原則として必須の`workspaceId + channelId`で解決する。DMや定期実行は後続Storyで明示的なplacement IDを持たせる。

```yaml
placements:
  - id: mana-test
    connector: slack
    workspaceId: T01234567
    channelId: C01234567
    audience:
      type: operator
      allowedUsers: [U01234567]
    agent:
      employee: ryoko
      defaultModel: sonnet
      escalationEmployee: critical-reviewer
    projects: [brainbase, mana, brainbase-mana]
    capabilities:
      mcp: [brainbase, gateway]
      gatewayTools: [list_sessions, create_child_session]
      allowedDelivery:
        - connector: slack
          channel: C01234567
    dataScopes:
      graph:
        mode: read-only
        scopes: [project:brainbase, context:philosophy]
      repositories:
        mode: read-only
        allow: [Unson-LLC/brainbase-mana]

```

環境固有IDはInfisicalラッパーが完成済みYAMLへ投影する。OpenRyokoの`loadConfig`自体は`${VAR}`を展開しないため、placeholderを含むYAMLを直接置かない。secretはProfileへ含めず、従来どおりプロセス環境へ注入する。

Placementを1件以上設定する場合、localhostの管理APIとWebSocketも信頼しない。Gatewayプロセスにはoperator tokenそのものではなくSHA-256だけを`OPENRYOKO_OPERATOR_TOKEN_SHA256`として注入し、UIブラウザには元tokenを`localStorage["openryoko.operatorToken"]`へ設定する。UIは管理mutationと`/api/status`以外のread APIへ`x-openryoko-operator-token`を付け、Gatewayがhashを比較する。`/ws`と`/ws/pty/:sessionId`はURLへtokenを含めず、WebSocket subprotocol metadataで同じtokenを提示する。元tokenをGateway設定、ログ、Claude子プロセスへ渡してはならない。hash未設定時はこれらのcontrol-plane操作をfail closedにする。Placement未設定のlegacy modeでは従来動作を保つ。

Discord remote proxyは別のservice principalであり、`connectors.discord.proxyToken`をremoteとprimaryへ同一secretとして注入する。Placement有効時、missing/wrong tokenのproxy送信は拒否し、設定APIは`proxyToken`を常に`***`へ置換する。これはoperator tokenの代替ではない。

上記はPhase 1で実装する正本schemaである。Skills、Graph/repositoryのサーバー側scope、cron/briefing、詳細監査は後続Storyとし、`dataScopes`はPhase 1ではpromptへ渡す。session metadataには`placementId`だけを保存し、実行時に正本設定からscopeを再解決する。いずれも認可の代替にはしない。

## 5. Policy dimensions

### 5.1 Audience

「誰のためのRyokoか」を表す。単なるSlackユーザーIDだけでなく、利用目的と情報公開範囲を持つ。

- `operator`: 運用責任者個人
- `executive`: 経営メンバー
- `project-team`: 特定プロジェクトの参加者
- `client`: 顧客・社外参加者を含む境界

ユーザーがallowlistに含まれていても、配置のaudienceに合致しなければ実行しない。

### 5.2 Placement

どのworkspace、channel、DM、scheduled triggerで動くかを表す。受信したチャンネルからプロファイルが一意に解決できない場合はfail closedとする。

### 5.3 Capability

Employee、model、Skills、MCP、Tools、OS操作、開発Runnerを定義する。

- 未指定のSkillsやToolsは利用不可とするdeny-by-defaultを採用する。
- グローバルに有効なMCPを全Employeeへ暗黙付与しない。
- Sonnetを通常処理の既定値とし、重要案件だけ明示的な基準でOpusへ委譲する。
- Placementから派生する子セッションはEmployee省略時に親Employeeと実行設定を継承する。許可Employeeを明示した場合はそのEmployee定義からengine/model/effortをサーバー側で決定し、呼び出し側による任意overrideは拒否する。
- 開発Runnerは通常業務のツール群から分離し、許可された配置だけに付与する。

### 5.4 Data scope

Graph、repository、NocoDB、filesystem、secretごとに参照範囲と操作種別を定義する。

- Graphはproject、context、node typeなどでscopeを制限する。
- `read`、`propose-write`、`write-with-approval`、`write`を区別する。
- プロンプト上の「読み取り専用」だけに依存せず、MCP/API側でも操作を拒否する。
- 結果をローカルメモリへ保存してGraphの代替正本を作らない。

### 5.5 Delivery

返信、定期投稿、外部送信の許可先を定義する。受信元チャンネルが許可されていても、出力先が許可されていなければ送信しない。

## 6. Briefing Contract

ブリーフィングは長いcron promptではなく、誰向けの何の成果物かを表す契約として管理する。

最低限、次を持つ。

- audience
- purpose
- sources and data scopes
- schedule and timezone
- output channel
- model and escalation rule
- maximum size / item count
- sensitivity
- writes allowed
- failure reporting destination

同じ朝ブリーフィングでも、経営者向け、プロジェクトチーム向け、顧客向けでは情報源と出力内容を分離する。

## 7. Runtime separation policy

### One runtime is acceptable when

- 同一企業内である。
- 情報の機密区分が近い。
- 同じOSユーザーとsecret boundaryを共有できる。
- 設定不具合による影響範囲を許容できる。

### Separate runtime is required when

- 顧客または社外メンバーを含む。
- 顧客間・事業間でデータ隔離が必要である。
- 異なるSlack workspaceや異なるsecret ownershipを扱う。
- 一方だけが開発Runnerや書き込み権限を必要とする。
- 法務、契約、個人情報など強い隔離要件がある。

分離単位はリスクに応じて、別OpenRyokoプロセス、別OSユーザー、別Slackアプリ、別ホストの順に強くする。

## 8. Daily improvement loop

日次改善は配置の境界を維持したまま行う。

1. その日の会話から、人間が望む回答を一度で返せなかった事例を抽出する。
2. 原因をpersona、Skill、Tool、Graph context、routing、権限、正本不足に分類する。
3. Placement固有の改善と、全配置で再利用できる改善を分ける。
4. 変更案を生成し、人間の承認を得る。
5. Skill、CLAUDE.md、Placement Profile、Graphの適切な正本へ反映する。
6. 同じ失敗に対する回帰テストを追加する。

顧客やプロジェクト固有の会話を、別Placementの学習材料として無条件に混ぜてはならない。全社共通化する知識は、機密性を確認したうえでBrainbaseの正本へ昇格させる。

## 9. Required enforcement and tests

最終構想の実装完了条件には正常系だけでなく、次の拒否テストを含める。Phase 1はuser/channel/workspace、MCP、Gateway tool、delivery、委譲継承を対象とし、それ以外は後続Storyで段階的に満たす。

- allowlist外ユーザーからの依頼を拒否する。
- 未登録チャンネルからの依頼を拒否する。
- Placement外のEmployee、Skill、MCP、Toolを利用できない。
- 許可されていないGraph projectまたはoperationを拒否する。
- 許可されていないrepositoryとfilesystem pathへアクセスできない。
- 出力をPlacement外のチャンネルへ送れない。
- 通常案件がOpusへ不要に委譲されない。
- 重要案件が定義済み基準に従ってOpusへ委譲される。
- 監査記録にplacement、audience、employee、model、tools、data scopes、delivery先が残る。
- secret値がログ、Slack、監査記録へ残らない。

## 10. Rollout order

1. Placement Profileのschemaとresolverを実装する。
2. 現在の`mana テスト`を最初の明示的なprofileへ移行する。
3. Skills、MCP、Toolsをdeny-by-defaultに変更する。
4. Graphとrepositoryのdata scope enforcementを追加する。
5. output authorizationと監査記録を追加する。
6. 拒否テストを実行する。
7. 社内プロジェクト用の2つ目のprofileを追加する。
8. 社外・顧客用途は別ランタイムとして設計・評価する。

### 10.1 Safe rollout and rollback contract

Placement有効化はbinaryと完成済みconfigを一組として扱う。適用前に両方の直前版を保存し、Slack受信を停止してから原子的に切り替える。再開前に、登録済み利用者・チャンネルの正常系、未登録利用者・チャンネル、operator tokenなしの管理API/WebSocket、許可外MCP・Gateway tool・delivery、許可外の派生sessionがそれぞれ期待どおり許可・拒否されることをprobeする。

rollbackは次の順序で行う。

1. Slack connectorの受信を停止し、新規セッションと返信を止める。
2. 直前のbinaryと、それに対応する完成済みconfigを一体で復元する。configだけを先に戻さない。
3. 少なくとも1件のrestrictive placementを維持した状態で、正常系と拒否系のprobeを再実行する。
4. probeがすべて期待値と一致した場合だけSlack受信を再開する。

稼働中のconnectorに対して`placements`を空または未設定にする操作をrollbackとして使ってはならない。それはlegacy modeへの移行であり、Placementによる入力、管理API、WebSocketの認可を解除するauthorization downgradeだからである。旧binaryがPlacementを理解しない場合は、Slack connectorを停止したまま旧runtimeへ切り替え、旧来の`allowFrom`と配信先制限を別途確認してから再開する。

### 10.2 Minimum Phase 1 observability contract

永続監査基盤は後続Storyとするが、Phase 1でも認可判断はsecretを含まない構造化security eventとして出力する。最低限の共通fieldは`event`、`decision`、`reason`、`placementId`（解決済みの場合）、`connector`、`workspaceId`、`channelId`、ハッシュ化した`actorId`、`sessionId`、`capability`、`target`、`configRevision`、`timestamp`とする。token、prompt、本文、secret、完全なGraph queryは記録しない。

区別可能なevent/reasonは次を最低限とする。

- placement解決: `unmatched`、`unauthorized_actor`、`ambiguous`、`placement_missing_after_config_change`
- control plane: `operator_auth_missing`、`operator_auth_invalid`、`operator_hash_missing`
- capability: `mcp_denied`、`gateway_tool_denied`、`delivery_denied`
- derived session: `parent_missing`、`parent_token_invalid`、`employee_denied`、`execution_override_denied`

health probeは`/api/status`のlivenessに加え、正しいoperator tokenでの保護read、tokenなしの403、登録Placementの正常入力、未登録channel/userの拒否、許可・拒否MCP/tool/delivery、派生sessionの親束縛を含む。rollout/rollback成功条件は、全probeが期待値と一致し、`ambiguous`、`operator_hash_missing`、予期しない`placement_missing_after_config_change`が0件で、拒否eventにsecretが含まれないことである。不一致が1件でもあればSlack受信を再開しない。

## 11. Non-goals

- Placement ProfileをGraph SSOTの代替にすること。
- personaやrankだけをセキュリティ境界として扱うこと。
- すべての顧客・事業を一つのランタイムへ集約すること。
- 日次改善ループによる無承認の権限拡張や自己改変。
- 現行mana Lambdaの受信・通知層を直ちに置き換えること。
