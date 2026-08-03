# 設定確認は独立したread-only topologyと固定URLで提供する

Story: `story-mana-configuration-visibility`

## Context

Mana Runtimeでは設定編集用API、Slack connectorの実行状態、meeting-minutesの通常配送・
cross-workspace共有が別々に存在する。Slackで異常に気づいた運用者が安全に現状を確認する
入口が必要だが、設定画面へSlack credentialを渡すことや、調査画面から設定を変更できる
ことは避けたい。また既存operator APIはplacement設定が空の場合に認証を省略する経路があり、
topologyの認証境界としてそのまま依存できない。

## Decision

- 設定確認は編集用 `/api/config` と分離した `GET /api/settings/topology` と5つのread-only Web viewで提供する。
- topology endpointはplacement有無にかかわらずoperator認証を必須とする。
- Slack App Homeとexact DMは固定HTTPS URLだけを返し、tokenやtransition credentialを付けない。
- Webは現行のoperator token方式を再利用する。credential未保存またはAPIが401/403を返した場合、
  同じread-only routeで再利用可能なpassword型promptを表示し、localStorageへ保存後に現在の
  path/queryのまま再取得する。login routeやserver sessionは新設しない。
- Slack設定入口は明示的な `allowFrom` がない場合もfail-closedとする。一般messageの既存semanticsは変えない。
- Slack外部状態はconnector起動後の非同期probe cacheから読み、HTTP request中にSlack APIを呼ばない。
- error producerが既知IDだけを含むdeep linkを生成し、受信画面側だけに責務を寄せない。

## Why

明示的なallowlist projectionと無条件operator認証により、config schemaの将来変更やplacement
有無に影響されずsecret非露出を守れる。固定URLと独立認証ならSlack URLの漏えいだけでは
設定を閲覧できない。非同期probe cacheは状態の鮮度とWeb可用性を分離できる。

## Alternatives

- 編集用Settingsへ状態を追加する案: mutationと調査が同じsurfaceになるため不採用。
- 期限付きtransition credentialをSlack URLへ付ける案: URL漏えい・log露出・失効管理が増えるため不採用。
- 新しいlogin route/server sessionを作る案: このMVPでは既存operator tokenとの二重認証体系に
  なりscopeが広がるため不採用。
- topology GETごとにSlack APIを呼ぶ案: 外部障害とrate limitがWeb表示へ直結するため不採用。
- channel probeを後続へ送る案: Story AC-07/08のMVP完了条件を満たさないため不採用。

## Consequences

projection、probe cache、安全なdeep-link builder、manifest更新を保守する必要がある。
operator tokenはSlack URL、query、server logへ出さず、既存と同じbrowser localStorageにだけ保存する。
本番の状態はコード・local test・deployとは別に、operatorが複数workspaceで確認し証跡化する。
