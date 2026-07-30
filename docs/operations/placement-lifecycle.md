# Placement Lifecycle — kill switch と廃止手順

Story: `agent-ledger-gaps`（docs/specs/agent-ledger-gaps.md AC9）

エージェント台帳の統制対象は「作る」だけでなく「止める・消す」まで。placementは以下のライフサイクルで管理する。

## 1. 新設前の重複調査

1. 台帳一覧（web panelのPlacementsビュー、または `GET /api/placements`）で既存placementの owner / purpose / capabilities を確認する。
2. 同じ目的・同じチャンネル系統のplacementが既にあれば、新設ではなく既存の`purpose`更新・audience拡張を検討する。
3. 新設する場合は `owner` と `purpose` を必ず設定する。台帳ビューでは未設定placementが警告表示される。

## 2. kill switch（即時停止）

該当placementに `enabled: false` を設定して設定を反映する（pilotではconfig.yaml編集 → ランタイム再起動）。

```yaml
placements:
  - id: mana-test
    enabled: false   # kill switch
    ...
```

効果（すべてfail-closed、`security_event` reason `placement_disabled` が記録される）:

- 新規メッセージ: `resolvePlacement` が `denied` を返し、エージェント実行前に止まる。
- 既存セッション経由の実行・継続: session実行前のplacement再解決で止まる。
- `send_message` 等の配信: 配信認可で拒否される。
- 派生セッション・cross-request: 親placementの再解決で拒否される。

`enabled` を未設定に戻す（または `true`）と再開する。employee budget pauseと異なり、placement単位で即時・可逆に止められる。

## 3. 廃止手順（decommission）

1. **kill switch**: `enabled: false` を設定して反映する。configからいきなり削除しない（削除は`unmatched`となり、無効化の意図が監査ログから読めなくなる）。
2. **観察期間**（推奨1〜2週間）: `security_event` の `placement_disabled` 発生を監視し、まだ利用者がいるかを確認する。利用があればownerへ通知して移行先を案内する。
3. **config削除**: 観察期間で利用が止まったことを確認後、該当placementブロックをconfig.yamlから削除してcommitする（変更管理は `docs/operations/pilot-config-change-management.md` に従う）。
4. **台帳からの消滅確認**: `GET /api/placements` に該当idが出ないこと、当月コスト集計で新規セッションが発生していないことを確認する。
5. **Slack側の後始末**: 必要ならbotをチャンネルから外し、チャンネルtopicの案内を更新する。

## 4. 責任

- 各placementの `owner` が停止・廃止の判断責任を持つ。
- owner不在（未設定）のplacementは台帳ビューで検出し、運用責任者が引き取るか廃止する。
