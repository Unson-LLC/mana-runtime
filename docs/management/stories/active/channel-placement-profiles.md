---
story_id: channel-placement-profiles
title: Slackチャンネル別Placement ProfileでRyokoの権限と文脈を分離する
status: active
architecture_docs:
  - docs/architecture/channel-placement-profiles.md
spec_docs:
  - docs/specs/channel-placement-profiles.md
---

# Slackチャンネル別Placement Profile

## Background

単一のOpenRyokoランタイムを複数の社内Slackチャンネルで利用する際、あるチャンネルへ許可した利用者、Employee、モデル、MCP、Gateway tool、参照文脈、投稿先が別チャンネルへ暗黙に広がらない実行境界が必要である。

## Acceptance Criteria

- Placement未設定時は既存の単一Slack配置と互換である。
- Slackイベントはworkspace、channel、userが一致する一意なPlacementへだけルーティングされ、未登録、許可外、複数一致は実行前に拒否される。
- Placementは担当Employee、通常モデル、重要レビュー担当を明示的に選択できる。
- Placement適用時のMCPはdeny-by-defaultであり、明示したserverだけをClaudeへ渡す。
- Gateway MCPはPlacementで明示したtoolだけを公開・実行できる。
- `send_message`はPlacementで許可したconnector/channel以外へ投稿できない。
- system promptとsession metadataから適用Placementを監査できる。
- Placement判定、設定、ログ、Slack、監査証跡にsecret値を含めない。
- resolver、MCP制限、送信制限、Slack reaction、子委譲、cross-requestについて正常系と拒否系を自動検証する。
- 子セッションとcross-requestは実在する親を必須とし、親Placementを継承する。
- 許可外Employeeへの委譲、およびengine、model、effortの要求上書きを拒否する。Employee省略時は親Employeeを継承する。
- Placement有効時のlocalhost管理mutation、機密read API、WebSocketはoperator tokenで認証し、token原文を設定API、ログ、URL、Claude子プロセスへ公開しない。
- Discord remote proxyは専用service principalを必須とし、missing/wrong tokenを拒否する。

## Scenarios

- `PLACEMENT-STORY-S-001`: Given placementsが設定されているとき、Slackイベントを受信すると、connector、workspace、channel、userが一致する一意なPlacementへルーティングする。
- `PLACEMENT-STORY-S-002`: Given placementsが設定されているとき、未登録channel、許可外user、または複数のPlacementに一致するSlackイベントを受信すると、エージェント実行前に拒否する。
- `PLACEMENT-STORY-S-003`: Given Placementが適用されているとき、`send_message`が許可先以外のconnectorまたはchannelを指定すると、Gateway APIを呼ぶ前に拒否する。

## Done Evidence

- OpenRyoko全テスト、typecheck、buildが最終HEADで成功する。
- Placement resolver、Gateway/MCP認可、delivery、派生セッションの拒否テストが成功する。
- 独立した製品要件、アーキテクチャ、仕様、最終Gateレビューがpassする。
