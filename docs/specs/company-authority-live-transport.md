# 会社権限の実API接続仕様

対象Story: `story-company-authority-live-transport`（Program A0）

## 接続と認証

既存`TenantRuntimeHttpClients`へ`company_authority: CompanyAuthorityClient`を追加する。POST先は既存service binding内の`https://brainbase.internal/api/v1/runtime/company-authority:resolve`。network destinationと認証はprivate bridgeが所有し、Manaはservice JWTやAccess secretを保持しない。設定の`BRAINBASE_COMPANY_AUTHORITY_BASE_URL`は既存の有効化設定として検証を維持するが、public fetch先として使用しない。信頼は環境で固定した公開鍵・audience・deploymentと署名済みcontextで検証する。

既存のbody secret検査、timeout範囲、manual redirect、HTTP失敗処理を再利用する。成功JSONは`{ state: "resolved", response: unknown }`として返すが、これは通信結果であり権限受理ではない。外側・内側署名と全scopeの受理は既存adapterのみが行う。

## 入口

有効設定には専用clientを必須とし、欠落は`CONFIGURATION_INVALID`。disabled時はclientを呼ばず従来経路を維持する。Workerは既存`tenantRuntimeClients`の専用clientを渡す。専用取得後の失敗を旧tenant-context取得へ戻さない。

## 検証

HTTP clientテストで正しいroute/body/header、正常JSON、HTTP失敗、redirect、不正JSON、binding/timeout設定拒否を確認する。設定テストで注入clientの同一性と欠落拒否を確認する。Worker入口テストで専用取得と失敗時の旧authority/Queue各0回を確認する。既存署名adapter/Queueテストで受理後の隔離を回帰確認する。

ローカル成功は本番readbackではない。2 tenant × 2 person、7境界、duplicate delivery、Usage/Receipt相関、resource_refの正本解決、実secret/bindingとexact deployは本番完了前に確認する。
