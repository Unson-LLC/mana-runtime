---
story_id: story-techknight-cloudflare-computer-poc
title: "TechKnight専用Cloudflare Computer境界を検証する"
status: active
source:
  type: architecture-experiment
  id: story-techknight-cloudflare-computer-poc
architecture_reason: "会社を跨ぐSlackイベント、状態、実行環境、認証情報をCloudflare accountとtenant境界で分離できるかを本番移管前に検証する。"
architecture_docs:
  - docs/architecture/story-techknight-cloudflare-computer-poc.md
spec_docs:
  - docs/specs/story-techknight-cloudflare-computer-poc.vibepro.json
---

# TechKnight専用Cloudflare Computer境界を検証する

## Background

現行mana-runtimeは複数会社のSlack workspaceを一つの常駐runtimeで扱えるが、会社境界と
Anthropic OAuthの分離をCloudflare上の独立した実行単位として検証したい。既存Lightsailを
論理分割する中間手順は行わず、TechKnight限定のreversible PoCから開始する。

## Acceptance Criteria

- Slack Events APIのraw bodyを署名検証し、期限切れ、改ざん、別workspaceを拒否する。
- 正規化したイベントに固定tenant `techknight` を付与し、Cloudflare Queueへ非同期投入する。
- Queue consumerはtenant/channel/thread単位のDurable Objectへ配送する。
- Durable Objectは`@cloudflare/computer` WorkspaceのSQLite-backed filesystemへイベントを保存し、event IDで冪等化する。
- ログ、HTTP応答、永続ファイル名へSlack signing secretやAnthropic credentialを出さない。
- PoCは既存Lightsail、既存Slack Socket Mode、本番Brainbase task pipelineを変更しない。
- deploy前にWranglerのCloudflare accountがTechKnight所有であることを確認し、Unson accountならfail closedする。

## Scenarios

- `TKCF-S-001`: 正しい署名とTechKnight team IDのSlack eventはQueueへ1回送られ、HTTP 200になる。
- `TKCF-S-002`: 不正署名、期限切れtimestamp、別team IDはQueueへ送られずHTTP 401または403になる。
- `TKCF-S-003`: Slack `url_verification`は署名検証後にchallengeを返す。
- `TKCF-S-004`: 同じevent IDが再配送されてもWorkspaceには1件だけ保存される。
- `TKCF-S-005`: Queue処理失敗はackせずretry対象にする。

## Out of Scope

- 既存Lightsail runtimeの停止または移管。
- Unson Cloudflare accountへのTechKnight本番resource作成。
- Anthropic OAuth credentialの移行、Cloudflare Container上のClaude CLI実行。
- Slackへの返信、Brainbase task作成、Canvas更新。
