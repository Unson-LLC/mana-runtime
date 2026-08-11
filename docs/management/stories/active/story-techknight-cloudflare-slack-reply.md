---
story_id: story-techknight-cloudflare-slack-reply
title: "TechKnightのSlackメンションにCloudflare上のClaudeが返信する"
status: active
source:
  type: user-request
  id: story-techknight-cloudflare-slack-reply
architecture_reason: "会社境界をTechKnightのCloudflare account、Slack workspace、Queue、Sandbox、Anthropic OAuthで固定したまま、受信だけのPoCを実際の会話応答まで進める。"
architecture_docs:
  - docs/architecture/story-techknight-cloudflare-slack-reply.md
spec_docs:
  - docs/specs/story-techknight-cloudflare-slack-reply.vibepro.json
---

# TechKnightのSlackメンションにCloudflare上のClaudeが返信する

## Background

TechKnight専用Cloudflare Workerは、Slack Events APIの署名検証、Queue投入、
Durable Object Workspaceへの保存までは行う。しかしQueue consumerからClaudeを呼び出さず、
Slack Web APIで返信もしないため、`#manaテスト`で八雲まなへメンションしても利用者には反応が見えない。

AWS Lambdaは廃止済みであり、既存の八雲まなSlack AppをCloudflare側の送信主体として引き継ぐ。

## Acceptance Criteria

- TechKnight workspaceの許可チャンネルで受信した`app_mention`だけをClaude応答対象にする。
- Queue consumerは受信イベントを永続化した後、TechKnight専用SandboxでClaude CLIを実行する。
- Anthropic OAuthはWorker secretからHTTPS proxyで注入し、Slack本文や永続ファイルへ保存しない。
- Claudeの空でない応答を、八雲まなSlack Appから元メッセージのスレッドへ投稿する。
- Slack Bot tokenはWorker secretとして保持し、Container、ログ、応答本文へ露出しない。
- 同じSlack event IDが再配送されても、Slackへの返信は完了後に再実行しない。
- 別workspace、別channel、Bot投稿、対応外イベントはClaudeとSlack送信を呼ばずに終了する。
- ClaudeまたはSlack APIが失敗した場合はQueue retry対象とし、成功した場合だけ完了記録を残す。
- 本番デプロイ後、TechKnightの`#manaテスト`でClaude生成返信が元スレッドに表示されることを確認する。

## Scenarios

- `TKREPLY-S-001`: 許可された`app_mention`はClaudeを1回呼び、元メッセージtsを`thread_ts`として返信する。
- `TKREPLY-S-002`: 同一event IDの完了済み再配送はClaudeもSlack APIも呼ばない。
- `TKREPLY-S-003`: 別channel、別workspace、Bot投稿、対応外eventは処理しない。
- `TKREPLY-S-004`: Claude失敗、空応答、Slack API失敗は完了扱いにせずretryする。
- `TKREPLY-S-005`: ログとWorkspace記録にはOAuth token、Bot token、Slack本文を含めない。

## Out of Scope

- Brainbase task、議事録、CanvasのTechKnight移管。
- Slackスレッド履歴全体の取得と長期会話メモリ。
- 雲孫事業運営workspaceのLightsail停止。
- 複数TechKnightチャンネルへの展開。今回の本番確認は`#manaテスト`に限定する。
