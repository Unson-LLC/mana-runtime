# 本人のDMから個人KGを利用する

## 利用者と目的

社員がManaとの本人DMで個人の記憶を登録し、後から自分の記憶を検索できる。別人や共有チャンネルへ公開せず、組織KGへの共有は既存の明示承認経路を使う。

## 接続契約

- 対象は `search_personal_kg` と `register_personal_kg`。
- Slackが検証したworkspace・app・requesterをBrainbaseの本人情報へ対応付ける。表示名やモデルが渡した人物IDから本人を決めない。
- DMのchannel IDは `D` で始まる形式だけを認める。共有チャンネル・グループDM・本人不明は拒否する。
- 各呼出しで、本人の `personal://<canonical person ID>/notes` に対する `personal_read/read` または `personal_write/write` の署名付き権限を取得する。
- 初期の `company_read` 権限は個人KGの権限として使わない。外部ID・組織・本人・配置・期限・操作が一致した権限だけをBrainbaseへ渡す。
- モデル引数にはowner・organization・authorityを含めない。登録項目はBrainbaseが永続化する項目に限定し、本文を必須とする。
- 検索は空でないquery（最大4000文字）と整数limit（1〜50、既定10）を受ける。
- 登録応答はevent ID・owner・organization・body hashを、検索応答は配列とevent IDを検証する。通信や権限の失敗を0件・登録成功へ変換しない。

## 反映と受入

Brainbaseの本人DM専用APIと組み合わせて反映する。既存identity・membershipを確認し、本人の検索・登録権限を既存の権限設定手順で付与する。コード反映、権限保存、本人DMでの登録後読戻しを別々に確認する。

本人Aの登録→Aの検索→本人Bからの非表示、共有面とグループDMでの拒否、read権限でのwrite拒否を受入条件とする。自動テストだけで本番の社員利用開始を宣言しない。

関連するBrainbase側の手順: `Unson-LLC/brainbase-unson` の `docs/runbooks/personal-kg-client-connection.md`。

## 有効化に必要な設定

- `BRAINBASE_PERSONAL_KNOWLEDGE_API_BASE_URL`: HTTPSのBrainbase API原点。パス・認証情報・query・fragmentは含めない。
- `MANA_COMPANY_AUTHORITY_OPERATIONS_JSON`: 既存操作を維持し、`personal_read: read` と `personal_write: write` を追加する。
- 既存のCompany Authority公開鍵・deployment・tenant context鍵設定を用いる。Slack rolloutを指定している場合、対象者本人のworkspace・DM・Slack userを一致させる。
- `RUNTIME_PLACEMENTS_JSON`: 本人DMの配置と`audience.allowedUserIds`に本人のみを指定し、`capabilities.gatewayTools`に2つの個人KGツールを追加する。共有面へは追加しない。
- Brainbaseの既存trusted provider設定へ `brainbase.personal_knowledge.search` と `brainbase.personal_knowledge.register` を追加する。応答は`utf8`で包んで配列を保持する。サービスJWTはBrainbase側に置き、Manaへ配布しない。

初期tenant contextのcredential leaseは通信の検証に用いる。個人KGの読書き権限は、毎回再取得する署名付きCompany AuthorityをBrainbase APIが別に検証する。初期の権限から個人権限へ昇格させる処理ではない。
