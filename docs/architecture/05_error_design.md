# エラー設計

**最終更新**: 2026-07-30

方針は2本柱: **権限系はfail-closed（黙って拒否し、security_eventに残す）**、**実行系は自動回復（ユーザーに再送を求めるのは最後の手段）**。

## 1. 権限・解決系 — fail-closed

| 状態 | 挙動 |
|---|---|
| placement不一致・曖昧一致・許可外ユーザー | エージェント実行前に拒否 |
| MCP/ツールが許可リスト外 | 拒否 + `security_event`（`mcp_denied`） |
| operator token欠落 | 管理API拒否 + `security_event`（`operator_auth_missing`） |
| development runnerの各種検証NG（config不正・入力過長・スキーマ外の結果・timeout・非零exit） | プロセス起動せず/結果破棄。**汎用の安全な失敗**をSlackへ（raw出力は流さない） |
| 派生セッションの親不在・上書き試行 | 拒否 |

原則: 拒否理由の詳細はログに、ユーザーには行動可能な短文だけ。

## 2. エンジン実行系 — 自動回復の階層

[manager.ts](../../packages/jimmy/src/sessions/manager.ts) のターン実行は、失敗の種類を判別して段階的に回復する:

| 失敗 | 検知 | 回復 |
|---|---|---|
| **Dead session**（engineSessionId失効） | エラーパターン判定 | stale IDをクリアし、**新規エンジンセッションで同一プロンプトを自動再実行**（1回）。ユーザーのメッセージを黙って失わない |
| **Poisoned transcript**（履歴破損、resume毎に400） | パターン判定 | engineSessionIdをクリア。**自動再実行はしない**（前回runが副作用を持つ可能性があるため）。ユーザーへ「リセットしたので再送してほしい」と明示 |
| **Transient server error**（Anthropic 5xx/529） | パターン判定 | 「自動リトライする」と通知し、バックオフ（30s/2m/5m）後に**同一セッションへ継続プロンプト**で再駆動。待機中はheartbeatでstuck判定を回避 |
| **Rate limit / usage limit** | result.rateLimit | waiting状態にして再開時刻を通知（Discord通知含む）。設定によりフォールバックエンジンへ切替 — ただし**placement下ではフォールバック禁止**（権限境界を跨ぐため） |
| **PTY死亡・Stop hook喪失** | watchdog（procの生死・ターン期限）+ lost-Stop recovery（5分経過+60秒静穏+transcript新着でtranscriptから結果を回収） | ターンを必ず決着させる（zombie "running" を作らない）。結果テキスト喪失時はtranscriptからバックフィル |
| **中断（interrupt）** | ユーザー操作・engine切替 | エラー扱いにせずidleへ |

## 3. ユーザー向け表示の原則

- 中間状態（切替中・リトライ中）を必要以上に露出しない。安定した状態と次の行動だけを伝える
- 内部エラー文字列・スタックトレース・他所のURLを外部チャンネルへ出さない
- 成功を偽装しない: スキップ・未検証があるなら結果にそう書く

### Slack interactionの認証前失敗通知

Slack interactionでは、署名、時刻、workspace、app、action payloadを検証した後、テナント解決だけが失敗する場合がある。この場合に限り、署名済みpayload内の`response_url`を単回利用の通知capabilityとして使い、元メッセージへ固定された公開エラーコードと問い合わせIDを表示してよい。operator認可はtenant解決後の業務処理に適用し、認証前通知に業務副作用を持たせない。

この経路はtenant-scoped deliveryの例外であり、業務副作用には使わない。通知本文へtenant情報、生の例外、認証情報を含めず、HTTPSの`hooks.slack.com`、443番、userinfoなし、redirectなしを満たすURLだけを許可する。`response_url`がない、または検査に通らない場合はSlack更新を行わず、HTTP 503の安全な失敗envelopeを診断面として残す。Slackの`response_url`からworkspace/appを独立に再導出できないため、検証済み署名payloadとの結合をcapabilityの根拠とする。

ただし、テナント解決がworkspace/appの所有関係を確定できなかった場合は、このcapabilityを使わない。`TENANT_UNKNOWN`、`TENANT_AMBIGUOUS`、`WORKSPACE_OR_APP_MISMATCH` はresponse_url通知の対象外とし、未分類の新しい境界コードも同じくfail-closedで扱う。既知の一時障害、インストール不足、再認証要求など、署名済みpayloadと既知の接続境界に結び付く失敗だけを明示的なeligibility gateで許可する。

状態投影は主経路1回、`STATUS_PROJECTION_FAILED`への安全なfallback 1回までとする。intake停止中・組織選択・戻る操作の非同期投影も同じガードを通し、fallback自身の失敗を非同期rejectとして残さない。即時状態表示と選択確認が同時に失敗した場合の公開コードは`STATUS_PROJECTION_FAILED`に固定する。stale recoveryはfallback実行前にclaim markerをdurableに保存し、fallback後の成否を`recoveryFallbackOutcome`へ最大2回の保存試行で記録する。保存不能時は`MEETING_MINUTES_RECOVERY_OUTCOME_PERSIST_FAILED`を運用エラーとして返し、claim markerにより再配信時の投影重複を防ぐ。保存成功時は元の処理・投影エラーを保持してQueueの処理契約を変えない。

すべてのユーザー向け失敗表示には、`runId`または実行前イベントの`eventId`・失敗段階・固定エラーコードから決定的に導出した`問い合わせID`を付ける。上流から相関IDを受け取れない同期表示は、channel・threadまたはchannel・userから構成する決定的なfallback seedを使い、再表示・再試行で同じ失敗を追跡できるようにする。空のシードやraw errorは問い合わせIDにしない。受付停止判定とTask write承認コールバックの拒否は、raw errorを返さずHTTP 503の安全な`UserFailure` envelopeへ変換し、署名検証済みで利用資格のある`response_url`に限って同じ問い合わせID付きの固定文言を投影する。

議事録Taskの遅延open・edit・cancelは、作業失敗を呼び出し元のPromiseへraw rejectとして残さない。reporterは`processingId`・固定`stage`（`task_action`）・公開`code`・決定的な`correlationId`・`retryable`を一つの失敗envelopeへ確定し、構造化ログと安全なSlack投影へ同じ値を渡す。Slack投影は別の段階や問い合わせIDを再導出せず、再試行可能な失敗には再試行案内を、scope不一致（`TASK_SCOPE_MISMATCH`）には再試行せず管理者が紐付けを確認する案内を表示する。旧形式・信頼できないカードは副作用の前に`TASK_ACTION_EXPIRED`として停止し、カードとHTTP応答へ処理ID・失敗段階・公開コード・問い合わせID・再試行可否を表示する。通知自体が失敗した場合も安全な投影失敗ログへ閉じ込める。

## 4. TODO

- エラーパターン判定（isDeadSessionError等）の判定文字列一覧をこの文書に転記し、Claude CLI更新時の追従チェックリストにする
