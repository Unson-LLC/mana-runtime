---
story_id: story-company-authority-user-route-parity
title: Company Authorityの利用者別経路を統一する
status: active
created_at: 2026-09-14
updated_at: 2026-09-14
source:
  type: user-request
  id: slack-cursorvers-company-authority-route-parity-2026-09-14
architecture_reason: "既存の設定と配備前検証を補完する局所修正であり、新しい認証境界や実行経路を追加しない。"
---

# Company Authorityの利用者別経路を統一する

## 背景

Cursorversチャンネルでは、大田原さんだけがCompany Authorityの新経路へ選択される一方、正規権限IDからJudgmentプロジェクトへの対応が欠けていたため、返信生成時に停止していた。佐藤さんは同チャンネルのrollout対象外だったため旧経路に残り、同じ質問でもこの障害が表面化しなかった。

さらに全rollout対象を照合すると、`mana-autonomy`にもplacementから正規権限IDへの対応漏れがある。利用者やチャンネルごとの個別修正では再発するため、既存の3設定を一つの配備前不変条件として検証する。

## User story

許可されたSlack利用者として、同じチャンネルでは誰が質問してもCompany Authorityの同じ新経路で処理され、権限設定の片側だけが欠けた配備によって無応答にならない。

## 受け入れ基準

- [x] `AC-1`: CursorversチャンネルのCompany Authority rolloutに佐藤さんと大田原さんのSlack IDが含まれる。
- [x] `AC-2`: Cursorvers placementのoperator audienceに佐藤さんと大田原さんのSlack IDが含まれる。
- [x] `AC-3`: Cursorversの正規権限IDがJudgmentの`unson`プロジェクトへ対応する。
- [x] `AC-4`: `mana-autonomy`を含む全rollout対象で、チャンネルに対応するplacement、単一の正規権限ID、Judgmentプロジェクト対応が揃う。
- [x] `AC-5`: operator audienceを持つplacementの利用者rolloutは、そのaudienceにも含まれる。
- [ ] `AC-6`: 上記のどれかが欠けた設定は配備前検証で失敗し、実設定、単体テスト、型検査、build、本番readbackを通す。

## スコープ外

- 新しい認証方式、権限サービス、Slack Appの追加
- Cursorvers以外の利用者追加
- 既存のCompany Authority外の経路変更

## ADR判断

既存のrollout、placement、権限ID対応を統合検証するだけでシステム境界は変わらないため、ADRは不要。
