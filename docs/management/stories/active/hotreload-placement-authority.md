---
story_id: HOTRELOAD-PLACEMENT-AUTHORITY
title: placement権限変更時に古いClaudeセッションを再開しない
status: active
created_at: 2026-08-12
updated_at: 2026-08-12
architecture_docs:
  - path: docs/architecture/hotreload-placement-authority.md
    status: accepted
---

# placement権限変更時に古いClaudeセッションを再開しない

## 背景

Slack placementへ `search_tasks` を追加し、設定のhot reloadと認可設定の反映には成功した。しかし、追加前から存在するSlackスレッドでは古いClaude engine sessionを `--resume` したため、会話内のツール一覧が更新されず `No such tool available` になった。

## User story

Mana運用者として、placementの権限やツール構成を変更した後は古いClaude transcriptを再利用せず、次の発話から新しい権限境界で開始してほしい。これにより、サービス再起動やSlackスレッド作り直しをせず、設定変更を安全に反映できる。

## 受け入れ基準

- [x] セッションへ現在のplacement authority revisionを保存し、同一placement、engine、employeeでもrevisionが変われば既存engine sessionを終了してfresh runにする。
- [x] revisionが一致する場合は従来どおりengine sessionをresumeし、不要な会話リセットを起こさない。
- [x] revisionを持たない既存セッションは次の発話で一度だけfresh化し、現在のrevisionを保存する。
- [x] ツールの追加と削除の両方でfresh化する。
- [x] connector由来のtransport metadataでrevisionを上書きできず、serverが解決したplacementを正本にする。
- [x] routing、MCP resolver、gateway policyの回帰テストと型検査が通る。

## スコープ外

- Slackスレッド履歴の削除
- Canonical Task検索APIや `search_tasks` の検索仕様変更
- Cloudflare Workerのセッション方式変更
- 設定変更済みturnの自動再実行
