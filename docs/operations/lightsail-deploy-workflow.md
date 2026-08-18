# Lightsailデプロイ経路（廃止済み）

mana-runtimeのLightsail向け通常デプロイは2026-08-18に廃止した。
正規実行環境は会社別Cloudflare Workerであり、この文書に通常デプロイ手順は置かない。

- GitHub Actionsの`Deploy Mana Runtime to Lightsail`は2026-08-18 10:44 JSTに手動無効化した。
- `.github/workflows/deploy-lightsail.yml`は削除した。
- `LIGHTSAIL_DEPLOY_*`のEnvironment secret/variableは、ホスト停止証跡とロールバック保持期間を確認してから別途削除する。値は記録しない。
- `scripts/deploy/`と既設のrestricted SSH principalは緊急復旧資材としてのみ残す。通常の配備や検証に使わない。

停止前状態、残存責務、停止ゲート、復旧判断は
[Lightsail版mana-runtime廃止記録](./lightsail-runtime-decommission-2026-08-18.md)を正本とする。
復旧は障害対応責任者の明示判断と、Cloudflare側入口停止の確認なしには開始しない。
