# ADR: Cloudflare RuntimeをManaの唯一の現行Runtimeとする

- Status: Accepted
- Date: 2026-08-20

## Context

Manaは当初、Jimmy/Jinn由来のOpenRyoko runtimeをLightsail上で運用していた。その後、Cloudflare Worker、Queue、Durable Objects、Cloudflare Computer / Sandboxを用いる会社別runtimeへ移行し、本番機能の主系もCloudflare側へ移った。

しかしrepository root、package名、README、CI、歴史資料には旧runtimeが現行であるかのような構造が残り、実運用とrepository architectureが一致していなかった。

## Decision

`mana-runtime` repositoryの現行runtimeはCloudflare-native実装だけとする。

- `packages/cloud-runtime/` をcanonical runtimeとする。
- `packages/jimmy/` を削除する。
- OpenRyoko/Jinn/Lightsail固有のdeployment scripts、assets、E2E、設計資料をactive treeから削除する。
- 旧実装はGit履歴でのみ保持する。
- Cloudflare runtimeは会社別deploymentを同一実装から生成する。
- Brainbaseをmemory / organizational state / authorityの正本とし、ManaはOperating Loopとruntime executionを担当する。

## Consequences

新規開発者・Agentはroot READMEと`packages/cloud-runtime/`だけを見れば現行runtimeへ到達できる。旧Lightsail runtimeを誤って修正・デプロイする経路をなくす。

Git履歴と過去に公開されたライセンス権利はこのADRでは変更しない。repository visibilityや将来コードのlicenseは別の経営・法務判断とする。
