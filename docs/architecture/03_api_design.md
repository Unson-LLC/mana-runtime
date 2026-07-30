# API・インターフェース設計

**最終更新**: 2026-07-30

mana-runtimeの「API」は3系統ある: (1) gateway HTTP/WS（管理・内部連携）、(2) Slack上の対話インターフェース、(3) 外部APIのクライアント契約。

## 1. Gateway HTTP/WS（`127.0.0.1:7777`）

実装: [gateway/api.ts](../../packages/jimmy/src/gateway/api.ts)（ルーティング1本 + operator-auth）

| 系統 | 代表 | 認証 |
|---|---|---|
| 管理API | `/api/config`（GET/PUT, hot-reload連動）・`/api/sessions/*`・`/api/sessions/:id/children`（派生セッション） | placement有効時はoperator token必須（mutation・機密read） |
| 内部フック | `POST /api/internal/hook` | **loopback限定 + `x-jinn-hook-secret`**。Claude Code hookをhook-relay.mjsが中継。SessionStart/Stopの`session_id`をこの層でengineSessionIdとして即時永続化 |
| PTYビュー | WebSocket（xterm） | operator token |
| Web panel | `dist/web`（Next.js静的出力）を同portで配信 | — |

原則: 公開ポートにしない（localhost bind）。外部からはSSHトンネル/同居プロセスのみ。

## 2. Slack対話インターフェース

| 面 | 仕様 |
|---|---|
| 通常会話 | `respondTo` gate（channel: mention / im・mpim設定 / engagedThreads）。スレッド=セッション |
| コマンド | `/new` `/status` `/model` `/doctor` `/cron` `/develop`（テキスト先頭一致、[manager.ts](../../packages/jimmy/src/sessions/manager.ts) `SLASH_COMMANDS`） |
| Slashコマンド | `/ryoko-develop <依頼>` → 内部`/develop`へ正規化（3秒以内ack、認可→有効判定→チャンネル判定の順で全部ephemeral拒否） |
| ボタン/モーダル | 議事録タスク候補の承認・編集（Slack Blocks）。承認で冪等キー付き登録 |
| 返信規律 | 配信前にnormalizeDelivery（operator向け注記の剥離、「addressed ⇒ never silent」）。配信先は placement `allowedDelivery` を検査 |

## 3. 外部APIクライアント契約

| 相手 | 契約の要点 |
|---|---|
| companion task API（bb.unson.jp） | service token。list `limit`最大50。`assignee_person_id`はトークン可視範囲のGraphで検証（scope不足は422）。エージェントにDELETEなし |
| brainbase MCP / NocoDB MCP | placement `capabilities.mcp` で許可された場合のみ子プロセスに公開 |
| development runner | stdin: `{"request": "…"}` 1行。stdout: `{status, storyId?, prUrl?, summary}` 固定スキーマのみ受理（status: queued/pr_ready/needs_input/failed、prUrlは自repoのPRのみ、summary≤1000字）。詳細は[spec](../specs/slack-self-development-runner.md) |

## 4. 設計原則

- 内部エンドポイントは「loopback + シークレット + サイズ上限」を揃える（hookが実例）
- 外部から受け取るものは固定スキーマで検証し、通らないものは**汎用の安全な失敗**に落とす（raw出力をSlackへ流さない）
- APIの後方互換より正本の単純さを優先（利用者はこのリポジトリ内のコードとweb panelのみ）

## 5. TODO

- gateway HTTP APIのエンドポイント一覧表（`api.ts`から機械的に抽出して転記）
- operator token の発行・ローテーション手順の文書化
