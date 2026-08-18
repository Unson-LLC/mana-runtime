# Lightsail版mana-runtime廃止記録（2026-08-18）

## 結論

`9940-meeting-router`のLightsail入口は可逆的に無効化した。GitHub上のLightsail通常デプロイ経路も無効化した。

ただしLightsailの`openryoko.service`全体はまだ停止しない。旧Unsonワークスペース、Cloudflare未登録のbusiness配置、平日朝の定期実行がLightsailに残っており、Cloudflareへの移行または責任者による廃止判断が未完了だからである。

Cloudflare WorkerのHTTP 200やCI成功だけでは全体移行済みと判定しない。各残存責務を移行し、Queue、処理中run、Receipt、保存先、Slack応答、重複件数を同一runで読み戻した後にのみ、サービス停止へ進む。

## 対象と保護範囲

対象はLightsailインスタンス`openryoko-pilot-20260724`上のmana-runtime関連unit、設定、デプロイ経路だけである。

次は対象外とし、停止・再起動・設定変更を行わない。

- 別インスタンス`brainbase-nocodb`
- Brainbase、NocoDB、Infisicalなどmana-runtime以外のサービス
- Lightsailインスタンス自体、固定IP、ファイアウォール、DNS

## 停止前スナップショット

2026-08-18 10:33 JST時点の確認結果。秘密値とSlack本文は記録していない。

| 項目 | 確認結果 |
|---|---|
| インスタンス | `openryoko-pilot-20260724` / `18.178.86.244` / running |
| 主サービス | `openryoko.service` / enabled / active / PID `1421051` / 再起動0回 |
| 主プロセス | `/home/ryoko/bin/ryoko start` / `127.0.0.1:7777` |
| 自動再起動 | systemd `Restart=on-failure` |
| 稼働release | `/home/ryoko/releases/openryoko/9dd718fb18d5704cb819943630549684bd3abf24-20260817...` |
| 設定 | `/home/ryoko/.ryoko/config.yaml` |
| 変更前設定SHA-256 | `a0192b844912f3f5fb81ab4b5ffb31f8dbc65960a054024f7ecab8c94e06cd86` |
| 9940無効化後SHA-256 | `22906809248333bef8f34670c35e20835048c2914f07adc9a5f0b48884583bf1` |
| 変更前バックアップ | `/home/ryoko/.ryoko/config-history/2026-08-18T01-33-11Z-before-lightsail-meeting-router-disable.yaml` |
| 実行中セッション | `ryoko status`でactive 0 / running 0 |
| Lightsail Action | workflow ID `327103360`、最終成功run `32042941321` |
| workflow状態 | 2026-08-18 10:44 JSTに無効化。PR #265のmerge後、workflow ID `327103360`はGitHub APIで`deleted`を確認 |

関連unitは個別に扱う。

- `openryoko-development-bridge.service`: enabled / active / `127.0.0.1:31016`
- `openryoko-back-office-sync.timer`: enabled / active。対応serviceは確認時failed
- `openryoko-pilot-health.timer`: enabled / active。対応serviceは確認時failed
- `openryoko-run-receipt.timer`: enabled / active。1分ごとのoneshotは成功

rootおよび`ryoko`のcrontabはなかった。これらunitを`openryoko.service`と一括停止しない。

## 責務の分離

### Cloudflare移行済み

- `9940-meeting-router` (`C0BKTFQ9V38`) の議事録処理
- `mana-accounting` (`C0BKS6RL99T`) のCloudflare配置
- `mana-dev-biz` (`C0BMNSP6C80`) のCloudflare配置
- Slack Events API、Queue、Durable Object、議事録保存・応答のCloudflare経路

Lightsailでは次を設定readback済みである。

- `slack-biz.meetingMinutesPipeline.enabled=false`
- `slack-biz.meetingTaskProposal.enabled=false`
- `biz-meeting-router.enabled=false`

2026-08-18 10:51 JSTの入口無効化後readbackでは、Lightsailの対象チャンネルに関するログ行は15件あったが、turn / session / spawn / executeに該当する行は0件だった。`openryoko.service`は同じPIDで再起動0回、active session 0、running session 0を維持している。

同時刻にSlack APIをLightsailの正規token経路から本文を出さずに確認した。直近3親スレッドの計6返信はすべてCloudflare専用App `A0BPM2J33SN`、bot user `U0BPM8B1JTU`によるもので、Lightsail App `A0BLS5WEL2J`の返信は0件だった。各親スレッドの2返信が処理中通知と完了通知か、意味上の重複かはReceiptと本文種別を突き合わせるまで未確認とする。

### 未移行または廃止判断待ち

- 旧Unsonワークスペース`T07LL5WV7N1`のSocket Mode受信
- 同ワークスペースのtask canvas / task reminder
- 平日08:30 JSTの`pilot-morning-briefing`
- businessワークスペース`T0882T8N9UH`にある、Cloudflareの3配置以外のLightsail placement
- development bridge、health、sync、run-receiptのうち上記責務を支える部分

Cloudflareの`RUNTIME_CRON_JOBS_JSON`は空であり、scheduled handlerはtask board repairだけを実行する。したがって朝の定期実行は移行済みと扱わない。

Lightsail設定には24 placementがある。旧Unsonワークスペースが2件、businessワークスペースが22件である。businessのうち`mana-accounting`と`biz-meeting-router`は無効化済みだが、次の20件は既定有効のままでCloudflare配置には存在しない。

`biz-unson-member`、`biz-zeims`、`biz-dialogai`、`biz-senrigan`、`biz-ncom`、`biz-brainbase`、`biz-nec`、`biz-growin`、`biz-smc`、`biz-vibepro`、`biz-hp-inquiries`、`biz-unson-sns`、`biz-legal-affairs`、`biz-unson-board`、`biz-unson-ops`、`biz-universal-arts`、`biz-attendance`、`biz-otawara-cursorvers`、`biz-general`、`biz-random`

これらはCloudflareの議事録・task board機能へ配置名だけ追加しても同等機能にならない。通常エージェント応答、tools、data scopeなどの能力差を責務ごとに確認する必要がある。

2026-07-19から2026-08-18までのLightsail journalをchannel ID単位で確認した。設定読込だけとは扱えない実利用があり、例として`mana-test`は471件、`mana-backoffice`は71件、`mana-accounting`は411件、`biz-ncom`は38件だった。`biz-ncom`の最新記録は2026-08-18 10:47 JSTである。したがって、20 placementと旧Unson 2 placementを利用実績なしとして廃止しない。

## Cloudflare本番E2E（2026-08-18 11:08-11:16 JST）

Cloudflare Worker Version `8d8e9077-37d4-442e-b4eb-3863ee561101`に対し、専用テストユーザーから`9940-meeting-router`へ一意なテキスト議事録を投入した。実際のBlock Kitからrun IDを取得し、署名済みinteractionで保存先Brainbaseを選択した。Slack UIからの実クリック配送はこの検証に含めていない。

| 項目 | readback |
|---|---|
| correlation | `mana-minutes-e2e-20260818T020853905Z` |
| run | `Ev0BQE5U8KCP_F0BQVFY9P5Y` |
| router thread | `1787018935.115339` |
| 入力 | 専用ユーザー`U088D1HBY6L` / file `F0BQVFY9P5Y` |
| 受信・返信App | Cloudflare `A0BPM2J33SN` / bot `B0BP5T7M5AT` |
| Lightsail返信 | 0件 |
| 終端 | 成功0件 / 理由付き失敗1件 |
| Receipt | `mmctx_400d955ca524ecce63c186105a3b0310` / `partial` / source refs 73件 |
| Receipt source status | Graph `resolved` / Canonical Task `unavailable` |
| 失敗理由 | `canonical_tasks_unavailable`。Brainbase project scopeとinternal clearanceが不足 |
| GitHub保存 | `Unson-LLC/brainbase-unson` `develop`でcorrelation一致0件 |
| 配信先Slack | Brainbase channelでcorrelation一致0件 |
| タスク副作用 | Canonical Task検索でrun ID一致0件、next cursorなし |
| 再送 | 同じinteractionを1回再送。同じrunで`meeting_minutes_context_partial`、追加の失敗終端なし |
| 配備ゲート | `allowed=true` / `activeRuns=0` / intake停止なし |

PR #267で、Brainbase文脈が`partial`または`unavailable`なら生成、GitHub保存、Slack配信、タスク作成へ進まないfail-closed版を配備した。このE2Eはその停止境界が本番で機能した証跡であり、議事録処理成功の証跡ではない。Canonical Task文脈の認可境界を修復し、同じ条件の新規runでReceipt `resolved`、GitHub保存1組、Slack親投稿1件、重複0件を確認するまで、9940の移行完了ゲートは未通過とする。

## 未確認のまま0件にしない項目

- Cloudflare QueueとDLQの滞留件数。bindingとconsumerの存在は確認したが、CLIからdepthを取得できていない。
- 旧UnsonワークスペースとCloudflare未登録placementの利用継続要否。
- Slackコネクタから対象チャンネルを読めず`channel_not_found`だった。これはチャンネル不存在や0件の証拠ではない。

## 残りの停止ゲート

以下をすべて満たすまで`openryoko.service`を停止しない。

1. 未移行責務ごとに、Cloudflare移行または責任者による廃止を記録する。
2. 対象Socket Mode App ID、workspace、channel、placementを実データで固定する。
3. Lightsailのactive/running session、未配信Queue、未保存Receiptを読み戻す。取得不能は未確認とする。
4. Cloudflareの配備ゲートが`allowed=true`かつ`activeRuns=0`であることを最新Versionに対して再確認する。
5. 入口停止後の観察窓で、Lightsailに新規runが発生せず、Cloudflareの同一runだけがReceipt・保存先・Slack応答を生成することを確認する。
6. 同じSlack入力に対するCloudflare/Lightsailの重複件数が0であることを確認する。

## 停止順序

ゲート通過後も、削除より回復可能な停止を先に行う。

1. 対象placementとSocket Mode入口を`enabled: false`にし、設定バックアップとSHA-256を記録する。
2. 新規runがない観察窓を置く。
3. `openryoko.service`をstopする。インスタンスは止めない。
4. `openryoko.service`をdisableし、自動再起動しないことを確認する。
5. mana-runtime専用timer/serviceを一つずつ停止・無効化し、他サービスへの依存を再確認する。
6. restricted deploy principal、GitHub Environmentの`LIGHTSAIL_DEPLOY_*`、release資材は保持期間後に個別削除する。

## 復旧判断

過去のLightsail版を直接再起動しない。復旧が必要な場合は、まずCloudflare障害の対象bindingを固定し、次を確認する。

1. Cloudflare側の同一workspace/channel入口を停止し、二重受信を防ぐ。
2. 復旧対象がこの記録の設定・release・App IDと一致することを確認する。
3. 未配信Queueと処理中runの所有者を決める。
4. 障害対応責任者が開始を明示承認する。
5. systemdをenableせず一時起動し、単一の検証runをReceipt・保存先・Slack応答まで確認する。

復旧後も恒久運用へ戻さず、Cloudflare復旧後に入口から逆順で停止する。
