---
story_id: story-mana-configuration-visibility
title: Mana設定をWebで可視化しSlackから安全に到達できる
status: active
---

# Mana設定をWebで可視化しSlackから安全に到達できる

## Story metadata

- Story ID: `story-mana-configuration-visibility`
- Status: `active`
- Source: meeting-routerの誤配送と、mana-runtime移行後に失われたクロスワークスペース共有の復旧を受けた運用改善要求
- View: `business`
- Horizon: `month`
- Architecture docs: [ADR-0005](../../../adr/0005-read-only-configuration-topology.md)、[Architecture](../../../architecture/story-mana-configuration-visibility.md)、[Spec](../../../specs/story-mana-configuration-visibility.md)
- Related tasks: 未作成。Story合意後にVibeProのplan/taskへ分解する

## Story

Manaの運用者として、Slackで議事録の配送先や接続状態に疑問を持ったとき、
BotのApp Home、明示的なDMコマンド、またはエラーメッセージから該当するWeb設定へ移動し、
現在の実効設定と配送経路を安全に確認したい。

これにより、設定ファイルやサーバーへ直接入らなくても、
「どのworkspace・channelから、どのproject・destinationへ、通常配送または共有されるか」と、
その経路が現在利用可能かを判断できる。

## Background

- meeting-routerは一見動作していても、誤ったチャンネルへ議事録を送ることがあった。
- 旧manaで利用できていたクロスワークスペース共有が、mana-runtime移行後に失われていた。
- 復旧後も、設定値、実効値、Slack上のworkspace/channel、配送経路、実行時の接続状態が別々に存在し、運用者が全体像を確認しづらい。
- 現在のWeb Settingsは設定の読み書きを担うため、運用確認用の読み取り専用トポロジーとは責務を分ける必要がある。
- Slackで問題に気づくことが多いため、WebのサイドバーだけでなくSlackを主要な入口にする。

## Policy

### Entry points

1. Slack App HomeをSlack側の正規入口にし、状態概要と「Mana設定を開く」ボタンを表示する。
2. BotへのDMで `設定`、`mana設定`、`ルーティング`、`接続状態` の明示コマンドを受けた場合だけ、設定ページへのボタンを返す。
3. 一般DM応答の `respondTo.im: never` は維持し、設定コマンドを限定的な例外として扱う。
4. Webでは既存サイドバーの「設定」から「構成マップ」へ移動できる。
5. 誤配送、配送失敗、権限不足などのメッセージから、対象workspace・projectを含む詳細ページへdeep linkする。

### Web information architecture

- `/settings/topology`: workspace、connector、meeting-router、project、destination、共有先の全体マップ
- `/settings/connectors/slack`: Slack接続、workspace、Bot参加状態
- `/settings/meeting-minutes`: 通常配送とクロスワークスペース共有の経路
- `/settings/permissions`: 閲覧者、送信元、配送先に関する権限状態
- `/settings/history`: 設定変更履歴と、実効設定を観測した時刻

詳細ページは `workspace`、`project`、必要に応じて `channel` をquery parameterで受け取り、
対象ノードと経路を選択した状態で表示する。

### Safety boundary

- MVPは読み取り専用とし、WebやSlackから設定を変更、適用、修復しない。
- secret、token、credential、生の環境変数値をAPI、ログ、Slack、ブラウザへ返さない。
- 設定ファイル上の宣言値と、runtime/Slack APIで確認した状態を区別して表示する。
- 外部確認に失敗した状態は正常やゼロ件にせず、`未確認` と理由、最終確認時刻を表示する。
- 公開HTTPS URL、独立したWeb operator認証、operator allowlistをADRで確定する。SlackからWebへのURLに遷移tokenやcredentialは含めない。
- `settingsHome.webBaseUrl` にuserinfo（`username` または `password`）を含むURLは無効とし、Slackのbutton、deep link、Web originを生成しない。

### Out of scope and regression boundary

- 今回は既存のSlack event認可、session delegation、派生session検証、Gatewayのsession tool dispatchを変更しない。
- 設定可視化のrouteを既存ファイルへ追加しても、これらの分岐は継承動作として維持し、詳細条件はVibePro specのstructured `inherited_behaviors`で追跡する。

#### Code branch traceability

VibeProの要件ゲートが既存分岐を新しい要件と誤認しないよう、変更ファイル内で維持する条件式と方針を明示する。
これは受け入れ条件の追加ではなく、今回の変更対象と継承動作を結ぶ追跡表である。

| File | Condition fragment | Classification |
| --- | --- | --- |
| `packages/jimmy/src/connectors/slack/index.ts` | `!this.allowedUsers?.has(command.user_id` | 設定DMをallowlist済みoperatorだけに限定する今回の必須認可 |
| `packages/jimmy/src/connectors/slack/index.ts` | `!userId` | user IDを取得できないApp Home eventを拒否する既存認可を維持 |
| `packages/jimmy/src/connectors/slack/index.ts` | `!this.settingsHomeEnabled || !userId || !this.allowedUsers?.has(userId` | App Home公開条件とoperator allowlistの既存認可を維持 |
| `packages/jimmy/src/connectors/slack/index.ts` | `this.allowedUsers && !this.allowedUsers.has((event as any` | Slack event全般の既存allowlist認可を維持 |
| `packages/jimmy/src/connectors/slack/index.ts` | `channelType === "im" && this.settingsHomeEnabled && this.allowedUsers?.has(slackUserId` | 明示的な設定DMだけを先行処理する今回の限定例外 |
| `packages/jimmy/src/gateway/api.ts` | `pathname === "/api/sessions" || matchRoute("/api/sessions/:id/children", pathname` | 既存session API routeの認証境界を維持 |
| `packages/jimmy/src/gateway/api.ts` | `!session || !verifySessionDelegationToken(session.id, sessionDelegationToken(req` | 既存session delegation token検証を維持 |
| `packages/jimmy/src/gateway/api.ts` | `employeeName === parentSession.employee` | 派生sessionのemployee整合性検証を維持 |
| `packages/jimmy/src/gateway/api.ts` | `!parentSessionId` | Gateway session toolのparent session必須条件を維持 |
| `packages/jimmy/src/gateway/api.ts` | `!parentSession` | Gateway session toolのparent session存在検証を維持 |
| `packages/jimmy/src/gateway/api.ts` | `tool === "list_sessions"` | 既存のsession一覧dispatchを維持 |
| `packages/jimmy/src/gateway/api.ts` | `tool === "get_session"` | 既存のsession取得dispatchを維持 |
| `packages/jimmy/src/gateway/api.ts` | `tool === "send_to_session"` | 既存のsession送信dispatchを維持 |

## Acceptance Criteria

- AC-01: 固定HTTPS URLをsecretやcredentialなしで生成でき、operator認証後のread-only画面がredactedされた現在の実効設定を取得・表示する契約を、現在のHEADに紐付いたAPI・browser E2Eで証明する。
- AC-01a: Slackのdeep linkからoperator credential未設定または拒否状態で遷移した場合は同じread-only画面上にcredential promptを表示し、有効なcredential保存後に現在のpathと安全なquery selectionのまま再取得する。拒否時は設定dataを返さない。
- AC-02: Slack App Homeに状態概要と「Mana設定を開く」ボタンがあり、Webの構成マップへ遷移できる。
- AC-03: Botへの明示的な設定DMコマンドは、Slackが `thread_ts` を付与した場合は同じスレッド内に設定リンクを返す一方、その他の一般DMには応答せず `respondTo.im: never` の意味を維持する。
- AC-04: Webサイドバーの「設定」から「構成マップ」へ到達できる。
- AC-05: 配送エラーや権限エラーに含まれるリンクから、対象workspace・project・channelを選択した詳細表示へ到達できる。
- AC-06: 構成マップ上で通常配送とクロスワークスペース共有を異なるedgeとして識別できる。
- AC-07: workspace ID、channel ID、project ID、destinationの対応関係を名称付きで確認でき、名称解決不能時はIDと `未確認` 理由を表示する。
- AC-08: Bot未参加、channel archived、workspace不一致、権限不足、外部確認失敗を区別し、確認時刻を表示する。
- AC-09: 読み取りAPI、Webレスポンス、Slackレスポンス、アプリケーションログにsecret値が含まれないことを自動テストで証明する。
- AC-10: MVPのAPIとUIから設定変更処理を呼べないことを、権限テストとネットワーク契約テストで証明する。
- AC-11: App Home、DMコマンド、Webサイドバー、エラーdeep linkの各入口から目的の設定へ到達するE2Eシナリオがある。
- AC-12: Slack App Homeまたはエラーdeep linkから対象経路の詳細へ2操作以内で到達できる。
- AC-13: スマートフォン幅とデスクトップ幅で経路、状態、警告を判読でき、キーボード操作とスクリーンリーダー向けラベルを備える。
- AC-14: クロスワークスペース共有先のchannel probeは、送信元設定にあるconnectorInstanceIdからtarget connectorへ割り当てられ、reload後に削除済みchannelの古い観測値を残さない。
- AC-15: 履歴画面はtopology APIの無条件operator認証境界内にあるallowlist済みmetadataだけを使い、snapshot本文・名前、生configを取得しない。
- AC-16: `settingsHome.webBaseUrl` がuserinfoを含む場合は設定不足として扱い、Slackのbutton、error deep link、Web originへcredentialを含むURLを出力しない。

## Explicit scenarios

- S-001: Given an allowlisted operator on Slack App Home, when 「Mana設定を開く」を押す, then authenticated Web topology opens without exposing secrets.
- S-002: Given general IM responses are disabled, when an operator sends `ルーティング` in a Slack assistant thread, then only the settings shortcut is returned in that same thread and ordinary conversation remains disabled.
- S-003: Given a meeting delivery error for a known workspace and project, when the operator opens its link, then the matching route is selected and the failed node explains its status.
- S-004: Given a cross-workspace share destination, when topology is rendered, then the source route and share route are visually distinct and both endpoints are named.
- S-005: Given Slack API or runtime inspection fails, when status is rendered, then it is shown as `未確認` with reason and timestamp rather than healthy, empty, or zero.
- S-006: Given an unauthorized user or a rejected stored operator credential, when the Web URL is opened, then a credential prompt is shown without returning configuration data.
- S-007: Given an old replayed exact settings DM after connector restart, when Slack delivers the event, then no shortcut, message handler, session, or LLM side effect occurs.
- S-008: Given a share destination declared on a source connector, when probes are planned, then its channel is inspected only by the resolved target connector and a missing target is reported without fallback.
- S-009: Given `settingsHome.webBaseUrl` contains URL userinfo, when Slack App Home or a meeting-minute error is rendered, then no button, deep link, or credential-bearing origin is emitted and the safe unconfigured fallback is shown.

## Non-goals for MVP

- WebまたはSlackからの設定編集、保存、適用、rollback
- 配送先の自動修復や自動参加
- 一般的なBot DM会話の有効化
- secret値や生の環境変数の表示
- 過去の全配送ログを分析する監査製品化

## Tasks

- T-01: Slack App HomeからWebへ遷移する公開URL、独立したWeb operator credential prompt、allowlist、拒否時の再入力境界のADRを作る。
- T-02: 宣言設定、実効設定、外部確認状態、確認時刻を分離したredacted read modelを設計する。
- T-03: workspace、connector、meeting-router、project、通常配送先、共有配送先を返す読み取り専用APIを実装する。
- T-04: Slack workspace/channel名称、Bot参加、archived、権限を確認し、失敗を `未確認` として保持するprobeを実装する。
- T-05: Webの構成マップ、Slack connector、議事録経路、権限、履歴の画面とサイドバー導線を実装する。
- T-06: Slack App Homeの状態概要とWeb設定ボタンを実装する。
- T-07: 一般DM応答を有効化せず、明示的な設定DMコマンドだけを処理する。
- T-08: 配送・権限エラーから対象設定へ遷移するdeep link生成を実装する。
- T-09: secret非露出、認可、read-only契約、状態分類、通常配送と共有配送のテストを追加する。
- T-10: App Home、DM、サイドバー、エラーdeep linkのE2Eとレスポンシブ・アクセシビリティ検証を追加する。
- T-11: 本番反映後、複数workspaceの実効経路とSlackからの到達性を運用者が確認し、結果を証跡として残す。

## Completion evidence

- ADR、Architecture、SpecがStory IDで相互参照されている。
- 読み取り専用APIのschemaとsecret非露出テストがある。
- 4種類の入口から対象設定へ到達するE2E結果がある。
- 固定HTTPS URL、operator認証、現在の実効設定projection、2操作以内の導線を、mock HTTPS originを含む現在HEADの自動テストで確認している。

## Release completion gate

これはPRのAcceptance Criteriaではなく、deploy後にだけ閉じられるrelease条件である。

- R-01: 本番反映後、許可された運用者がlive production HTTPS URLへアクセスし、認証後にsecretを除外した現在の実効設定を取得できることを観測する。
- R-02: 本番環境で通常配送とクロスワークスペース共有の経路が名称付きで表示され、確認時刻と状態が記録されることを観測する。
- R-03: 運用者がApp Homeまたはエラーから対象経路へ2操作以内で到達できることを観測する。
- R-01〜R-03のいずれかが未観測または失敗なら、PRがmerge済みでもreleaseは未完了とする。
- 本分離は承認済みdecision `decision-1785719139292-b4b3940d` に基づく。
