# Spec Drift

- Status: drift_detected
- Story: story-mana-multitenant-runtime
- Evaluated at: 2026-08-18T17:49:35.103Z

| Axis | Count |
|------|-------|
| spec_code_drift | 0 |
| spec_test_drift | 1 |
| code_test_drift | 0 |
| spec_pr_drift | 19 |

## Items

### DRIFT-ZRC85R [medium] (spec_test)
- Clause: C-006
- Title: C-006.test_pattern[0].must_cover が満たされていない
- Detail: must_cover "CredentialDecisionV1 selection and injection planned Red" が packages/cloudflare-techknight-poc/src/__tests__/multitenant-runtime-contract.test.ts のテストで参照されていない
- Suggested action: テストを追加するか、clause の verifiable_by.test_pattern を見直す

### DRIFT-N4UJ29 [medium] (spec_pr)
- Clause: C-001
- Title: C-001 が参照するコードが PR で変更されている
- Detail: packages/cloudflare-techknight-poc/src/slack.ts が origin/main と比べて変更されている。Spec の見直しが必要かもしれない
- Suggested action: Spec を再生成 (vibepro spec fingerprint → write) し、clause の有効性を確認する

### DRIFT-BMLWF8 [medium] (spec_pr)
- Clause: INV-001
- Title: INV-001 が参照するコードが PR で変更されている
- Detail: packages/cloudflare-techknight-poc/src/slack.ts, packages/cloudflare-techknight-poc/src/runtime-config.ts が origin/main と比べて変更されている。Spec の見直しが必要かもしれない
- Suggested action: Spec を再生成 (vibepro spec fingerprint → write) し、clause の有効性を確認する

### DRIFT-PAYP9Y [medium] (spec_pr)
- Clause: INV-002
- Title: INV-002 が参照するコードが PR で変更されている
- Detail: packages/cloudflare-techknight-poc/src/brainbase-mcp-proxy.ts が origin/main と比べて変更されている。Spec の見直しが必要かもしれない
- Suggested action: Spec を再生成 (vibepro spec fingerprint → write) し、clause の有効性を確認する

### DRIFT-LT9ENS [medium] (spec_pr)
- Clause: INV-003
- Title: INV-003 が参照するコードが PR で変更されている
- Detail: packages/cloudflare-techknight-poc/src/reply-pipeline.ts, packages/cloudflare-techknight-poc/src/brainbase-mcp-proxy.ts が origin/main と比べて変更されている。Spec の見直しが必要かもしれない
- Suggested action: Spec を再生成 (vibepro spec fingerprint → write) し、clause の有効性を確認する

### DRIFT-TX82NR [medium] (spec_pr)
- Clause: C-013
- Title: C-013 が参照するコードが PR で変更されている
- Detail: packages/cloudflare-techknight-poc/src/runtime-event-claim.ts, packages/cloudflare-techknight-poc/src/workspace-store.ts が origin/main と比べて変更されている。Spec の見直しが必要かもしれない
- Suggested action: Spec を再生成 (vibepro spec fingerprint → write) し、clause の有効性を確認する

### DRIFT-N34HKN [medium] (spec_pr)
- Clause: INV-005
- Title: INV-005 が参照するコードが PR で変更されている
- Detail: packages/cloudflare-techknight-poc/src/reply-pipeline.ts が origin/main と比べて変更されている。Spec の見直しが必要かもしれない
- Suggested action: Spec を再生成 (vibepro spec fingerprint → write) し、clause の有効性を確認する

### DRIFT-6B3UZQ [medium] (spec_pr)
- Clause: C-004
- Title: C-004 が参照するコードが PR で変更されている
- Detail: packages/cloudflare-techknight-poc/src/runtime-config.ts が origin/main と比べて変更されている。Spec の見直しが必要かもしれない
- Suggested action: Spec を再生成 (vibepro spec fingerprint → write) し、clause の有効性を確認する

### DRIFT-SZVXKV [medium] (spec_pr)
- Clause: INV-006
- Title: INV-006 が参照するコードが PR で変更されている
- Detail: packages/cloudflare-techknight-poc/src/reply-pipeline.ts が origin/main と比べて変更されている。Spec の見直しが必要かもしれない
- Suggested action: Spec を再生成 (vibepro spec fingerprint → write) し、clause の有効性を確認する

### DRIFT-XPSSD4 [medium] (spec_pr)
- Clause: C-005
- Title: C-005 が参照するコードが PR で変更されている
- Detail: packages/cloudflare-techknight-poc/src/slack-attachments.ts が origin/main と比べて変更されている。Spec の見直しが必要かもしれない
- Suggested action: Spec を再生成 (vibepro spec fingerprint → write) し、clause の有効性を確認する

### DRIFT-VV9B2W [medium] (spec_pr)
- Clause: C-006
- Title: C-006 が参照するコードが PR で変更されている
- Detail: packages/cloudflare-techknight-poc/src/reply-pipeline.ts が origin/main と比べて変更されている。Spec の見直しが必要かもしれない
- Suggested action: Spec を再生成 (vibepro spec fingerprint → write) し、clause の有効性を確認する

### DRIFT-EXGX8P [medium] (spec_pr)
- Clause: C-007
- Title: C-007 が参照するコードが PR で変更されている
- Detail: packages/cloudflare-techknight-poc/src/runtime-event-claim.ts が origin/main と比べて変更されている。Spec の見直しが必要かもしれない
- Suggested action: Spec を再生成 (vibepro spec fingerprint → write) し、clause の有効性を確認する

### DRIFT-KUTKE9 [medium] (spec_pr)
- Clause: INV-007
- Title: INV-007 が参照するコードが PR で変更されている
- Detail: packages/cloudflare-techknight-poc/src/reply-pipeline.ts が origin/main と比べて変更されている。Spec の見直しが必要かもしれない
- Suggested action: Spec を再生成 (vibepro spec fingerprint → write) し、clause の有効性を確認する

### DRIFT-DLPKNN [medium] (spec_pr)
- Clause: C-015
- Title: C-015 が参照するコードが PR で変更されている
- Detail: packages/cloudflare-techknight-poc/src/reply-pipeline.ts が origin/main と比べて変更されている。Spec の見直しが必要かもしれない
- Suggested action: Spec を再生成 (vibepro spec fingerprint → write) し、clause の有効性を確認する

### DRIFT-C5GAAN [medium] (spec_pr)
- Clause: C-016
- Title: C-016 が参照するコードが PR で変更されている
- Detail: packages/cloudflare-techknight-poc/src/reply-pipeline.ts が origin/main と比べて変更されている。Spec の見直しが必要かもしれない
- Suggested action: Spec を再生成 (vibepro spec fingerprint → write) し、clause の有効性を確認する

### DRIFT-U9WBLE [medium] (spec_pr)
- Clause: C-010
- Title: C-010 が参照するコードが PR で変更されている
- Detail: packages/cloudflare-techknight-poc/src/reply-pipeline.ts が origin/main と比べて変更されている。Spec の見直しが必要かもしれない
- Suggested action: Spec を再生成 (vibepro spec fingerprint → write) し、clause の有効性を確認する

### DRIFT-YWGUD9 [medium] (spec_pr)
- Clause: C-008
- Title: C-008 が参照するコードが PR で変更されている
- Detail: packages/cloudflare-techknight-poc/src/index.ts が origin/main と比べて変更されている。Spec の見直しが必要かもしれない
- Suggested action: Spec を再生成 (vibepro spec fingerprint → write) し、clause の有効性を確認する

### DRIFT-GC5SMU [medium] (spec_pr)
- Clause: C-002
- Title: C-002 が参照するコードが PR で変更されている
- Detail: packages/cloudflare-techknight-poc/src/index.ts, packages/cloudflare-techknight-poc/src/index.ts が origin/main と比べて変更されている。Spec の見直しが必要かもしれない
- Suggested action: Spec を再生成 (vibepro spec fingerprint → write) し、clause の有効性を確認する

### DRIFT-GR2HSL [medium] (spec_pr)
- Clause: C-009
- Title: C-009 が参照するコードが PR で変更されている
- Detail: packages/cloudflare-techknight-poc/src/multitenancy/runtime-boundaries.ts が origin/main と比べて変更されている。Spec の見直しが必要かもしれない
- Suggested action: Spec を再生成 (vibepro spec fingerprint → write) し、clause の有効性を確認する

### DRIFT-6CCUMG [medium] (spec_pr)
- Clause: INV-008
- Title: INV-008 が参照するコードが PR で変更されている
- Detail: packages/cloudflare-techknight-poc/src/multitenancy/idempotency.ts, packages/cloudflare-techknight-poc/src/multitenancy/accounting.ts が origin/main と比べて変更されている。Spec の見直しが必要かもしれない
- Suggested action: Spec を再生成 (vibepro spec fingerprint → write) し、clause の有効性を確認する
