# Spec Drift

- Status: drift_detected
- Story: story-mana-multitenant-runtime
- Evaluated at: 2026-08-17T02:42:20.591Z

| Axis | Count |
|------|-------|
| spec_code_drift | 0 |
| spec_test_drift | 3 |
| code_test_drift | 0 |
| spec_pr_drift | 4 |

## Items

### DRIFT-2U4KVF [high] (spec_test)
- Clause: C-018
- Title: C-018.test_pattern[0].must_cover が満たされていない
- Detail: must_cover "production Slack ingress and queue fail closed without tenant fallback planned Red" が packages/cloudflare-techknight-poc/src/__tests__/multitenant-runtime-contract.test.ts のテストで参照されていない
- Suggested action: テストを追加するか、clause の verifiable_by.test_pattern を見直す

### DRIFT-5EYFXZ [high] (spec_test)
- Clause: C-019
- Title: C-019.test_pattern[0].must_cover が満たされていない
- Detail: must_cover "mock server preserves timeout error and not_collected semantics planned Red" が packages/cloudflare-techknight-poc/src/__tests__/multitenant-runtime-contract.test.ts のテストで参照されていない
- Suggested action: テストを追加するか、clause の verifiable_by.test_pattern を見直す

### DRIFT-2LN9U7 [high] (spec_test)
- Clause: C-020
- Title: C-020.test_pattern[0].must_cover が満たされていない
- Detail: must_cover "two adapter instances share one Durable Object state and execute duplicate once planned Red" が packages/cloudflare-techknight-poc/src/__tests__/multitenant-runtime-contract.test.ts のテストで参照されていない
- Suggested action: テストを追加するか、clause の verifiable_by.test_pattern を見直す

### DRIFT-FEPCYS [medium] (spec_pr)
- Clause: C-001
- Title: C-001 が参照するコードが PR で変更されている
- Detail: packages/cloudflare-techknight-poc/src/slack.ts が codex/mana-multitenant-stories と比べて変更されている。Spec の見直しが必要かもしれない
- Suggested action: Spec を再生成 (vibepro spec fingerprint → write) し、clause の有効性を確認する

### DRIFT-GLUW4S [medium] (spec_pr)
- Clause: INV-001
- Title: INV-001 が参照するコードが PR で変更されている
- Detail: packages/cloudflare-techknight-poc/src/slack.ts が codex/mana-multitenant-stories と比べて変更されている。Spec の見直しが必要かもしれない
- Suggested action: Spec を再生成 (vibepro spec fingerprint → write) し、clause の有効性を確認する

### DRIFT-TND6U8 [medium] (spec_pr)
- Clause: C-019
- Title: C-019 が参照するコードが PR で変更されている
- Detail: packages/cloudflare-techknight-poc/src/multitenancy/runtime-boundaries.ts が codex/mana-multitenant-stories と比べて変更されている。Spec の見直しが必要かもしれない
- Suggested action: Spec を再生成 (vibepro spec fingerprint → write) し、clause の有効性を確認する

### DRIFT-WGZG37 [medium] (spec_pr)
- Clause: C-020
- Title: C-020 が参照するコードが PR で変更されている
- Detail: packages/cloudflare-techknight-poc/src/multitenancy/idempotency.ts, packages/cloudflare-techknight-poc/src/multitenancy/accounting.ts が codex/mana-multitenant-stories と比べて変更されている。Spec の見直しが必要かもしれない
- Suggested action: Spec を再生成 (vibepro spec fingerprint → write) し、clause の有効性を確認する
