# Brainbase trusted provider forwarder source lock v1

`source-lock.json`は、Brainbase producer、tenant context契約、mana-runtime consumerが同じforwarder契約を読むための配備前正本です。

`merge_allowed`はコード統合の許可、`deploy_allowed`はレビュー済み候補を指定targetへ本番検証投入する期限付き許可です。`deploy_allowed: true`では、レビュー者とprovenance、レビュー対象commit、target、承認時刻、有効期限を`deployment_authorization`へ固定します。実Slack E2E、Safety／Value Gate、切替完了の証明には読み替えません。検証終了後は`deploy_allowed: false`と`deployment_authorization: null`へ戻します。
