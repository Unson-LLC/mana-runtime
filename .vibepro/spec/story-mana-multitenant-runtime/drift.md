# Spec Drift

- Status: drift_detected
- Story: story-mana-multitenant-runtime
- Evaluated at: 2026-08-17T00:54:32.808Z

| Axis | Count |
|------|-------|
| spec_code_drift | 0 |
| spec_test_drift | 0 |
| code_test_drift | 0 |
| spec_pr_drift | 2 |

## Items

### DRIFT-XZD2DD [medium] (spec_pr)
- Clause: C-001
- Title: C-001 が参照するコードが PR で変更されている
- Detail: packages/cloudflare-techknight-poc/src/slack.ts が codex/mana-multitenant-stories と比べて変更されている。Spec の見直しが必要かもしれない
- Suggested action: Spec を再生成 (vibepro spec fingerprint → write) し、clause の有効性を確認する

### DRIFT-YGMVUG [medium] (spec_pr)
- Clause: INV-001
- Title: INV-001 が参照するコードが PR で変更されている
- Detail: packages/cloudflare-techknight-poc/src/slack.ts が codex/mana-multitenant-stories と比べて変更されている。Spec の見直しが必要かもしれない
- Suggested action: Spec を再生成 (vibepro spec fingerprint → write) し、clause の有効性を確認する
