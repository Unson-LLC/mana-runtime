# Story: 議事録ボタンの失敗原因をSlackへ表示する

## 利用者価値

Slackで議事録の保存先ボタンを押した利用者として、失敗時に安全なエラーコードと問い合わせIDを元メッセージ上で確認したい。これにより、再認証、管理者対応、再試行のどれが必要かを判断できる。

## 受け入れ条件

- [x] AC-1: テナント解決、キュー投入、スレッド座標、redo、状態投影の失敗を、元のSlackメッセージへ処理ID・失敗段階・公開エラーコードとともに表示する。
- [x] AC-2: 生の例外、スタック、Bearer token、内部テナント情報をSlack、HTTP応答、構造化ログ、非同期rejectへ露出しない。
- [x] AC-3: テナント境界の失敗を `installation_required`、`reauthentication_required`、`administrator_action_required`、`usage_limit_reached`、`temporary_failure` の5種類へ安定分類する。
- [x] AC-4: 議事録以外の共有interaction入口でも、従来のHTTP 503を維持しつつ同じ安全な失敗envelopeを返し、認証済みの通常処理は既存のtenant-scoped delivery境界を通す。
- [x] AC-5: `response_url` がない、または安全性検査に通らない場合は認証前Slack更新を行わず、HTTP応答の公開コードと問い合わせIDを診断面として残す。
- [x] AC-6: `TENANT_UNKNOWN`、`TENANT_AMBIGUOUS`、`WORKSPACE_OR_APP_MISMATCH` では `response_url` を通知に使わず、既知の一時障害・インストール不足・再認証要求だけを明示的なeligibility gateで許可する。
- [x] AC-7: intake停止中・組織選択・戻る操作の状態投影は主経路1回と `STATUS_PROJECTION_FAILED` fallback 1回に制限し、即時状態表示と選択確認の複合失敗コードを固定する。stale recoveryはfallback結果をdurable markerへ記録して再配信による重複投影を防ぎ、元の処理エラーを保持する。

## セキュリティ境界

- Slack署名、時刻、workspace、app、action payloadを検証した後に限り、署名済みpayload内の`response_url`を単回利用のSlack capabilityとして認証前の失敗通知に使う。operator認可はtenant解決後の業務処理に対して行い、認証前通知は固定された失敗情報だけに限定する。
- 認証前通知は固定された公開文面だけを送る。tenantデータ、内部エラー、副作用命令を含めない。
- `response_url`はHTTPS、`hooks.slack.com`、443番、userinfoなし、redirectなしを必須とする。URL自体からworkspace/appを再導出できないため、署名済みpayloadとの結合を認証根拠とし、通常の業務副作用には利用しない。
- tenant解決がworkspace/appの所有関係を確定できない失敗（`TENANT_UNKNOWN`、`TENANT_AMBIGUOUS`、`WORKSPACE_OR_APP_MISMATCH`）は、署名済みpayloadにresponse_urlがあっても通知しない。未分類の境界コードはfail-closedとし、既知の一時障害・認証/インストール状態だけを通知対象にする。

## リリース条件

- cloud-runtime全テスト、型検査、差分検査、VibeProの必須レビューをexact HEADで通す。
- コードPRをマージ後、source-lockだけを更新する認可PRを分離して本番配備する。
- 本番でSlackボタンを1回押し、同一操作のSlack表示、公開コード、問い合わせID、Worker versionをreadbackする。未実施の間はユーザー可視の本番完了と扱わない。
