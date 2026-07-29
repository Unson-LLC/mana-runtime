# mana-runtime ロードマップ（正本）

**策定日**: 2026-07-29
**根拠**: ユニバーサルアーツ安部様・グローウィン様との2会議（2026-07-29抽出）で語られたビジョンと、mana-runtimeの現在地のギャップ分析
**維持**: 方針変更はこのファイルを更新してからタスク化する。会議・Slackでの発言はこのファイルに反映されるまで正本ではない

---

## ビジョン（上位目標）

「会社の脳」（SSOT→グラフ→オントロジー）を作り、Slack上の単一窓口AI社員「マナ」で全業務を回す。

- 表の窓口はマナ1体。裏でサブエージェント・モデル・権限を振り分ける（専門エージェント乱立の否定）
- チャンネル単位で見える範囲・使えるツール・権限を分ける
- 定常業務はイベント/時間トリガーでAIが勝手に動き、人間は確認だけ
- 仕事が生まれる場所（会議・Slack）でタスク登録→リマインドまで完結
- 質の証明は「自社でやって数字を出す」。その型を安部様（人柱導入）・グローウィン様（商品化）へ展開

## 現在地（2026-07-29時点、実装済みの土台)

- チャンネル単位の権限境界: placement profiles 実効状態（PR #10で復元、PR #11でtask route束縛追加）。3層ゲート = コード内route束縛 → placement `gatewayTools` → `interactiveAllowedTools`
- タスク正本接続: Canonical Task（Brainbase PostgreSQL）の create/list/update がSlackから動作。エージェントにdelete権限なし（E2E確認済み）。Slack Canvasミラーあり（PR #8/#9）
- Slack常駐挙動: 空気読みトリアージ / 自然言語`/goal` / Agents Canvas / 発言者認識 / コスト・予算計測 / cronコネクタ / セキュリティイベント（`mcp_denied`等）

---

## 5本柱

### 1. 「マナ=単一窓口」の完成 — 表は1体、裏で振り分け

- **裏側ルーティング層**: 依頼内容→適切なサブエージェント/モデル/effortを裏で選ぶ動的ディスパッチ（経理系依頼→freee系サブエージェント、開発依頼→/ryoko-develop 等）。窓口の人格は1つのまま
- **placement設定の一元化**: 現状はツール追加のたびに3箇所への登録が必要。設定1箇所から派生させる仕組みに変え、権限・文脈作りをスケールさせる
- **チャンネル文脈の注入強化**: ツール面に加え、そのチャンネルの業務文脈（プロジェクト・顧客・判断基準）をplacementごとにsystem promptへ注入する層

### 2. 「会社の脳」との接続 — Graph SSOT/オントロジーを実行時に読む

- **実行時Graph参照**: 返答・判断の前にGraph SSOT（固有名詞・RACI・意思決定）を引く経路をランタイムに組み込む
- **オントロジー→placementの写像**: 「誰が何を承認できるか」の定義からplacementの権限・停止条件を生成し、二重管理を排す
- **個人KG→会社オントロジー昇格のフック**: 会話・作業ログから昇格候補を検出しSlackで提案する入口

### 3. 定常業務ワークフローの量産基盤 — 「人間は確認だけ」

- **イベントトリガーの受け口拡張**: cronに加え、イベント駆動（Gmail着信・freee締め日・会議終了・Canonical Task期限到来）で発火
- **人間確認ステップの型化**: 承認待ち→Slackで選択肢カード提示→承認で続行、のhuman-in-the-loopプリミティブを内蔵
- **ワークフロー定義の量産フォーマット**: 1業務=1定義（トリガー・placement・手順・確認ポイント）。第1号は月次経理

### 4. 会議→タスク→リマインドの動線完結

- **議事録→タスク自動抽出→ワンタップ登録**: 会議後にSlackへ議事録とタスク候補が届き、「登録して」で正本入り
- **期限リマインド**: canonical storeを定期クエリし、期限接近・超過をチャンネルへ通知（cron + Canonical Task API）
- **Canvasミラーの運用定着**: タスクCanvasを「見える正本ビュー」として磨く

### 5. 他社展開できる形にする — 安部様人柱・グローウィン様商品化の裏付け

- **Slack Connect対応**: 外部ワークスペースのユーザーを識別し、placementで外部者権限を絞る
- **オンボーディングの型化**: setup wizardに導入ヒアリング項目（チャンネル権限・停止条件・監査先）を組み込み、他社でも再現可能に。安部様導入をv1検証にする（次回定例 2026-08-25 15:00）
- **エージェント台帳・監査の製品化**: 台帳=placement一覧、監査=セキュリティイベントの可視化、停止=budget/kill switch。「AIエージェントガバナンス診断」の診断項目を自社でまず満たす
- **委任率ダッシュボード**: どの業務がどれだけAIに委任され、人間は何回確認しただけかを計測・表示

---

## 依存インフラの脱属人化（brainbase側、2026-07-29追記）

柱4以降をチーム運用に載せるための前提。着手時点では、Canonical Taskの**データ本体（MacローカルHomebrew PostgreSQL）とwriter**（launchd `com.brainbase.ui`、port 31013）の両方が佐藤ローカルMacにあり、pilotは`https://bb.brain-base.work`（Cloudflareトンネル経由で同Macに着地）へ書いていた。single-writer設計（writer lease・readiness・冪等・監査・他所fail-closed）は正しく維持し、置き場所だけをサーバーへ移す。

1. **writer移設** — ✅完了(2026-07-29): データ本体+writer leaseをLightsail（bb.unson.jp、PostgreSQL 16.14）へ移設。pilotの`BRAINBASE_TASK_API_BASE_URL`は`https://bb.unson.jp`へ切替済み、Mac側31013のmutationは`writer_migrated_to_lightsail_20260729`でfail-closed。移設後のSlack経由E2E作成も実証済み。Macのcloudflared ingressからの`bb.brain-base.work`除去も完了(2026-07-29、`~/.cloudflared/config.yml`から当該hostnameのみ削除、`line.mana-bot.win`は継続稼働を確認)。**残作業**: E2E検証行の削除
2. **Brainbase MCPへのtask mutationツール追加**: create/update/transitionを公開（deleteは非公開のまま）し、机上エージェントの正規登録経路を作る。サーバー側は`BRAINBASE_SERVICE_TOKEN_SECRET`が正規分離済みなので、サービスごとの`bbsvc_`トークン発行（`svc_mana_runtime`等）をこの経路に載せる

## 優先順位

| 順 | 項目 | 理由 |
|---|---|---|
| 1 | 柱4: タスク動線完結（リマインド・抽出提示） | 部品が揃っており最短で循環が閉じる。実タスク流入が始まった今が定着の勝負どころ |
| 2 | 柱3: ワークフロー量産の型 + 月次経理第1号 | 「人間は確認だけ」の実証が全提案の説得力の源泉 |
| 3 | 柱1: placement一元化と裏側ルーティング | 量産前に権限設定のスケール障害を除去 |
| 4 | 柱5: Slack Connect + オンボーディング型化 | 2026-08-25の安部様定例までに見せられる形へ |
| 5 | 柱2: Graph実行時参照 | 効果は大きいがbrainbase側との共同設計が必要で足が長い |

上位3項目と脱属人化2項目（writer移設・MCP taskツール追加）はCanonical Taskに登録済み（2026-07-29、冪等キー`mana-roadmap-2026-07-29-*`）。

### 進捗記録

- 2026-07-29: 柱4第1弾の期限リマインダー（`TaskReminderNotifier`）実装・pilot稼働・実投稿確認（PR #13）。柱4の残りは議事録→タスク候補提示→ワンタップ登録のmana-runtime移植（設計はmana `meeting-flow-integration.js` を参照実装として移す。manaのLambda版は移行後に凍結）
