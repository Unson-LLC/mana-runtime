# Brainbase trusted provider forwarder source lock v1

`source-lock.json`は、Brainbase producer、tenant context契約、mana-runtime consumerが同じforwarder契約を読むための配備前正本です。

`merge_allowed`はコード統合の許可、`deploy_allowed`はレビュー済み候補を指定targetへ本番検証投入する期限付き許可です。デプロイ候補は二つのcommitで構成します。Aはレビュー済みのコード／設定commit、BはAを直接の親とし、次の二つの`source-lock.json`だけに期限付き認証を追加するauthorization-only commitです。

- `contracts/brainbase-trusted-provider-forwarder/v1/source-lock.json`
- `contracts/mana-brainbase-tenant-context/v1/source-lock.json`

Bの`deployment_authorization.reviewed_commit_sha`はAを指し、`MANA_DEPLOY_CANDIDATE_COMMIT`はBを指します。デプロイ前にA→Bの直接親関係と変更ファイル集合を機械検査し、コード・設定の変更を含む候補は拒否します。実Slack E2E、Safety／Value Gate、切替完了の証明には読み替えません。検証終了後はBの両source-lockを`deploy_allowed: false`と`deployment_authorization: null`へ戻します。
