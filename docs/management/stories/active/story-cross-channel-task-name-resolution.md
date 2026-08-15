---
story_id: story-cross-channel-task-name-resolution
title: チャンネル名だけで許可済みタスクを横断取得する
status: active
created_at: 2026-08-15
updated_at: 2026-08-15
source:
  type: operator-decision
  id: slack-channel-name-task-inventory-2026-08-15
depends_on:
  - story-authorized-cross-channel-task-inventory
architecture_docs:
  - path: docs/architecture/story-cross-channel-task-name-resolution.md
    status: proposed
---

# チャンネル名だけで許可済みタスクを横断取得する

## 背景

横断タスク取得は認可済みのSlack channel IDを受け付けるが、利用者が普段使うのはチャンネル名である。IDを調べて再入力させる導線は、取得機能があっても会話の中で完結しない。

## User story

複数チャンネルのタスクを確認する利用者として、`0240-mana-dev` や `9960-back-office` のような普段のチャンネル名だけで依頼したい。これにより、Slack channel IDを調べず、既存の認可境界を保ったまま横断一覧・検索を完了できる。

## 受け入れ基準

- [x] `AC-1`: 横断一覧・検索toolは、従来の `channel_ids` に加えて1〜10件の重複しない `channel_names` を受け、どちらか一方だけを必須とする。
- [x] `AC-2`: Runtime Gatewayは設定済みの正規チャンネル名を一意にIDへ解決し、その後は既存の呼出元scope、対象利用者、project和集合の認可を適用する。
- [x] `AC-3`: 名前は前後空白と先頭の `#` を正規化する。未知、重複、IDとの同時指定、曖昧な設定はupstreamを呼ばずfail closedで拒否する。
- [x] `AC-4`: 応答scopeは解決済みchannel IDと正規チャンネル名、project対応を返し、既存のID入力も後方互換で動作する。
- [x] `AC-5`: Slack返信promptは、利用者へchannel IDを要求せず、明示されたチャンネル名をそのまま横断toolへ渡す。
- [x] `AC-6`: 本番設定は `mana-dev-biz=0240-mana-dev`、`mana-accounting=9960-back-office` を一意に定義し、他placementや逆方向の許可を増やさない。
- [ ] `AC-7`: unit、integration、型検査、buildを通し、デプロイ後にチャンネル名だけのSlack依頼が再質問なしで成功し、Brainbase正本の件数・scopeと一致する。

## スコープ外

- Slack APIからのチャンネル一覧・所属情報の動的取得
- 表示名の部分一致、曖昧検索、別名管理
- 横断対象・利用者・projectの認可拡張

## ADR判断

既存placement設定と横断認可へ正規名の解決を追加する局所変更であり、新しい正本や認証方式を導入しないため独立ADRは不要とする。
