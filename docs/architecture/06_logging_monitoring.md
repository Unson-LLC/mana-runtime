# ログ・監視設計

**最終更新**: 2026-07-30

## 1. ログ経路

| 経路 | 内容 |
|---|---|
| systemd journal（pilot） | gateway全ログ。`journalctl -u openryoko.service` が一次調査窓口 |
| logger INFO/WARN/ERROR | 受信イベント・エンジンspawn（`resume:`/model/geom）・ターン完了（所要時間・$コスト）・回復系の警告 |
| `security_event`（WARN, 構造化JSON） | 権限拒否の監査ログ。下記 |
| run receipt | pilotホスト上のsystemd timerがレシートを収集しbrainbaseへ配送（state/outbox/dead-letter）。**unit実体はpilot手置きでリポジトリ未管理**（回収対象、gap-analysis D） |
| pilot health | 5分毎のtimerで死活確認。**同じくpilot手置き・リポジトリ未管理** |

## 2. security_event（監査の正本）

```json
{"event":"capability","decision":"deny","reason":"mcp_denied",
 "placementId":"…","connector":"slack","channelId":"C…","sessionId":"…",
 "capability":"mcp","target":"brainbase","configRevision":"…","timestamp":"…"}
```

- `event`: `capability`（実行時の能力判定）/ `control_plane`（管理API・WS認証）/ `placement_resolution`（placement解決の拒否）/ `derived_session`（派生セッション認可の拒否）
- `control_plane` イベントは `target` にアクセス先（`METHOD /path` または `ws-upgrade`）を含む（発生源特定のため。2026-07-30追加）
- `configRevision` で「どの設定でその判定になったか」まで追える
- **秘密値は含めない**（フィールド固定）
- roadmap柱5の「エージェント台帳・監査の製品化」はこのイベントの可視化が土台

## 3. コスト計測

- ターンごとに `$コスト` と turn数を registry に累積（interactive はtranscriptから再構成）
- budget機構（gateway/budgets.ts）で上限管理

## 4. 調査レシピ（実績あり）

```bash
# 会話継続の確認（resume: none が続く=文脈喪失）
journalctl -u openryoko.service --since "-1h" | grep "spawning claude (resume:"

# 権限拒否の確認（placementの能力不足切り分け）
journalctl -u openryoko.service --since "-1h" | grep mcp_denied

# 設定hot-reloadの確認
journalctl -u openryoko.service | grep -E "config.yaml changed|Config reloaded"
```

チャンネルで「変な回答」が起きたら、まずこの2つ（resume喪失 / mcp_denied）を疑う。2026-07-30の事業運営チャンネル障害は両方が同時に起きていた（[ADR-0002](../adr/0002-placement-rebind-transcript-clearing.md)・[討議記録](../discovery/existing_project_audit.md)）。

## 5. TODO

- `operator_auth_missing` が約1分間隔で常時出続けている（正体未特定のポーラー。監査ログのS/N比を下げるため発生源を特定して認証を付けるか黙らせる）
- security_eventの可視化ダッシュボード（roadmap柱5）
- アラート方針（現状: pilot healthのfailedが放置されがち。通知先を決める）
