# mana-dev-biz Cloudflare完全移行票

- 完了日時: 2026-08-15 01:11 JST
- 対象: Slack workspace `T0882T8N9UH` / channel `C0BMNSP6C80` (`#0240-mana-dev`)
- placement: `mana-dev-biz`
- project: `mana` (`prj_01KGHVCMA35JHSMXTSWQAS04PS`)
- Git SHA: `0b3147a70124f6fa5f26a6f83ce2e24033120cf6`
- Cloudflare Worker version: `701a24c3-631c-4e75-a607-a32b318daa22`
- model: `sonnet`（実行モデル `claude-sonnet-4-6`）
- requester canonical person ID: `per_01KGYC7NNS0VXADK7NP48W4VR5`

## 完了判定

Lightsail版 `mana-dev-biz` の機能、権限、データ境界、会話継続、Slack入口、MCP・gateway・コマンドをCloudflareへ移行した。全回帰、型検査、本番Slack E2E、正本readback、Cloudflare単独配送を確認後、Lightsail設定から当該placementだけを削除した。他placementとOpenRyokoサービスは稼働を継続している。

## 機能台帳

| 区分 | 移行した契約 | 検証 |
| --- | --- | --- |
| placement | workspace、channel、project=`mana`、operator 2名、Sonnet、delivery自己channel、Graph read-only scope | 本番ログのplacement解決、許可外利用者拒否、別project拒否 |
| 人物 | Slack profile、`workspace ID + Slack user ID`、canonical person ID、未登録・曖昧・障害時fail-closed | 「私のタスク」、別利用者、人物単体・統合テスト |
| タスク | list/search/get/create/update/transition、pagination、project境界、canonical actor、議事録担当者 | 本番create→update→completedとTask API readback、議事録task readback |
| 会話 | workspace/channel/thread単位DO、Slack履歴、Claude session resume、model/人物/transport metadata、権限revision rotation | 2ターン継続、`/new` 後に過去検証語を参照しないことを本番確認 |
| 記憶 | Graph context、philosophy、共有memory、placement memory、取得不能と空の区別、placement間分離 | 単体・統合テストと本番turn trace |
| Slack入口 | app mention、DM、engaged thread、通常message triage、添付、thread reply、reaction、処理中表示 | DM・非mention返信・reaction・silent・添付の各本番E2E |
| 冪等性 | Slack再送、Queue再試行、処理中重複を原子的にclaim | 同一Slack eventの再配送を`already_processing`、投稿1件をログで確認 |
| MCP | Brainbase、NocoDB、Google Drive、gatewayをplacement allowlistから生成しproxyでも再検証 | 本番のTask、NocoDB実データ、Drive実データ、gateway実行 |
| gateway | send_message、task CRUD/transition、sessions、employees | 各本番E2E、send_messageのchannel/ts readback |
| コマンド | `/new`、`/status`、`/model`、`/doctor`、`/cron`、`/develop`、`/vibepro`、native `/ryoko-develop` | 決定論的handlerのテストと本番応答 |
| persona等 | persona、employee、skills、runtime instructions、critical-reviewer設定 | 配置設定・prompt wiringテスト、本番status/response |
| Canvas | placement単位project集合だけを表示 | 本番CanvasとTask APIの一致、修復Queueログ |
| 議事録 | Slack file→保存先→生成→GitHub→Brainbase task→Slack通知、担当者共通resolver | 本番ファイルE2E、GitHub/Task/Slack readback |
| credentials | Cloudflare secrets/bindingsのみ。値はコード・ログ・本票に非記載 | deployment contract、secret presence test、ログredaction test |

## 本番E2E証跡

### 人物・タスク・会話

- 「私のタスク」: `assignee_person_id=per_01KGYC7NNS0VXADK7NP48W4VR5` と `project=mana` を強制し、名前・person IDを聞き返さず検索。
- タスク正本readback: `ct1.eyJ2IjoiMS4wLjAiLCJzIjoicG9zdGdyZXMiLCJyIjoiOTkxZGU2MGUtNDY3NC00N2NkLTg2OWEtN2QwMmRmY2I5OTQzIn0.aqaS7bJYEhj-KOvpowAQ-FOIxRX_D6tSP3I-OxtXilg` をcreate→update→completedし、Brainbase Canonical Task APIで同一version/statusを確認。
- `/new` 前後の検証語: `紫電カモメ-1786717820607`。generation更新後は過去Slack本文を再注入しないことを確認。
- DM: request `https://unson-ops.slack.com/archives/D0BPK9TFZU6/p1786721787541349`、reply `https://unson-ops.slack.com/archives/D0BPK9TFZU6/p1786721820499449?thread_ts=1786721787.541349&cid=D0BPK9TFZU6`。
- engaged thread非mention: request `https://unson-ops.slack.com/archives/C0BMNSP6C80/p1786721865172909?thread_ts=1786717821.085969&cid=C0BMNSP6C80`、reply `https://unson-ops.slack.com/archives/C0BMNSP6C80/p1786721886365099?thread_ts=1786717821.085969&cid=C0BMNSP6C80`。

### 通常message・triage・添付

- 通常message reply: `https://unson-ops.slack.com/archives/C0BMNSP6C80/p1786722574784589`、trace `Ev0BQCJDBUJV`。
- 短い謝辞はreactionのみ: `https://unson-ops.slack.com/archives/C0BMNSP6C80/p1786722663176659`、trace `Ev0BQEAZD2MS`。
- 雑談はsilent: `https://unson-ops.slack.com/archives/C0BMNSP6C80/p1786722689130159`、trace `Ev0BQEB2F37W`。
- 通常添付: root `https://unson-ops.slack.com/archives/C0BMNSP6C80/p1786723439147139`、reply `https://unson-ops.slack.com/archives/C0BMNSP6C80/p1786723475038999?thread_ts=1786723439.147139&cid=C0BMNSP6C80`、file `F0BPVCQPK47`、trace `Ev0BPVCT357Z`。triageが添付名を認識し、reply pipelineが添付本文を読み取った。

### 境界・gateway・コマンド

- 許可外利用者: `operator_not_allowed` でprocess前にACKし、reply/writeなし。
- 別project要求: root `https://unson-ops.slack.com/archives/C0BMNSP6C80/p1786723647471869`、reply `https://unson-ops.slack.com/archives/C0BMNSP6C80/p1786723674993179?thread_ts=1786723647.471869&cid=C0BMNSP6C80`、trace `Ev0BQ7560HV3`。`back-office` を検索せず `mana` scopeで拒否。
- `/cron list`: root `https://unson-ops.slack.com/archives/C0BMNSP6C80/p1786723550283059`、reply `https://unson-ops.slack.com/archives/C0BMNSP6C80/p1786723554129859?thread_ts=1786723550.283059&cid=C0BMNSP6C80`。このplacementに実行可能jobなしと決定論的に返答。
- gateway `send_message`: root `https://unson-ops.slack.com/archives/C0BMNSP6C80/p1786723579809959`、実投稿 `https://unson-ops.slack.com/archives/C0BMNSP6C80/p1786723624067789?thread_ts=1786723579.809959&cid=C0BMNSP6C80`、confirmation `https://unson-ops.slack.com/archives/C0BMNSP6C80/p1786723627686829?thread_ts=1786723579.809959&cid=C0BMNSP6C80`。delivery先は `C0BMNSP6C80` のみ。
- `/vibepro status`: `https://unson-ops.slack.com/archives/C0BMNSP6C80/p1786720929481149`。
- native `/ryoko-develop status`: `https://unson-ops.slack.com/archives/C0BMNSP6C80/p1786720947346429`。

### 議事録・Drive・NocoDB・Canvas

- 入力file: `F0BQ449CH51` / `https://unson-ops.slack.com/files/U088D1HBY6L/F0BQ449CH51/cloudflare-migration-e2e-20260815-0007.txt`
- router root: `https://unson-ops.slack.com/archives/C0BKTFQ9V38/p1786720343038209`
- 保存先選択: 雲孫 / Unson Board
- GitHub正本: `https://github.com/Unson-LLC/Drive/blob/main/meetings/unson-board/minutes/2026-08-15_cloudflare-migration-e2e-20260815-0007.md`
- 通知root: `https://unson-ops.slack.com/archives/C0BKXCVSDCH/p1786720611265799`
- 詳細: `https://unson-ops.slack.com/archives/C0BKXCVSDCH/p1786720611817349?thread_ts=1786720611.265799&cid=C0BKXCVSDCH`
- task card: `https://unson-ops.slack.com/archives/C0BKXCVSDCH/p1786720612090589?thread_ts=1786720611.265799&cid=C0BKXCVSDCH`。担当者 `梅田 遼`、期限 `2026-08-15`、タイトル `移行証跡を確認する` を正本で照合。
- Google Drive、NocoDB、Task Canvasは同一placementから実データを読み、各正本と表示内容を照合。

## 最終切り替え

- Lightsail backup: `/home/ryoko/.ryoko/config.yaml.pre-cloudflare-mana-dev-biz-20260815-0111`
- Lightsail config readback: `mana-dev-biz` block 0件、次の `biz-unson-member` block 1件。
- OpenRyoko: restart後 `active`、PID `1337593`。他Slack connectors・cron・file watcherも正常起動。
- 切り替え後request: `https://unson-ops.slack.com/archives/C0BMNSP6C80/p1786723842234539`
- Cloudflare reply: `https://unson-ops.slack.com/archives/C0BMNSP6C80/p1786723878362209?thread_ts=1786723842.234539&cid=C0BMNSP6C80`
- Cloudflare trace: `Ev0BR56EMKSL`。`placementId=mana-dev-biz`、`projectCodes=[mana]`、`model=sonnet`、`workerVersion=701a24c3-631c-4e75-a607-a32b318daa22`、`mana_slack_reply_posted` 1件。
- Slack再配送: 同一requestの別event variantは `already_processing`。利用者に見えるreplyは1件。
- Lightsail: 同じmessage ts `1786723842.234539` を受信したが `respondTo gate -> silent`。再起動後ログに `mana-dev-biz` 実行0件。Slack threadのreplyはCloudflare bot `U0BPM8B1JTU` の1件のみ。

## 自動検証

実行ディレクトリはGit SHA `0b3147a` のclean worktree。

```text
Test Files  64 passed (64)
Tests       487 passed (487)
TypeScript  tsc --noEmit passed
```

配備readback:

```text
Created: 2026-08-14T16:02:12.762Z
Version: 701a24c3-631c-4e75-a607-a32b318daa22 (100%)
```

以上をもって、部分実装、health、デプロイ成功、返信1件だけではなく、全機能の本番E2E、Cloudflare単独配送、Lightsail当該placement停止、正本readbackを完了条件として満たした。
