# Spec Drift

- Status: drift_detected
- Story: story-mana-multitenant-runtime
- Evaluated at: 2026-08-16T13:34:40.802Z

| Axis | Count |
|------|-------|
| spec_code_drift | 0 |
| spec_test_drift | 19 |
| code_test_drift | 0 |
| spec_pr_drift | 0 |

## Items

### DRIFT-6QMYS4 [high] (spec_test)
- Clause: C-001
- Title: C-001.test_pattern[0].must_cover が満たされていない
- Detail: must_cover "WorkspaceConnectionSnapshotV1 lifecycle planned Red" が packages/cloudflare-techknight-poc/src/__tests__/slack.test.ts のテストで参照されていない
- Suggested action: テストを追加するか、clause の verifiable_by.test_pattern を見直す

### DRIFT-GBBC6G [high] (spec_test)
- Clause: INV-001
- Title: INV-001.test_pattern[0].must_cover が満たされていない
- Detail: must_cover "fail closed before enqueue and LLM planned Red" が packages/cloudflare-techknight-poc/src/__tests__/queue-consumer.test.ts のテストで参照されていない
- Suggested action: テストを追加するか、clause の verifiable_by.test_pattern を見直す

### DRIFT-MPRTDF [high] (spec_test)
- Clause: INV-002
- Title: INV-002.test_pattern[0].must_cover が満たされていない
- Detail: must_cover "no credential body crosses a persisted or observable boundary planned Red" が packages/cloudflare-techknight-poc/src/__tests__/anthropic-auth.test.ts のテストで参照されていない
- Suggested action: テストを追加するか、clause の verifiable_by.test_pattern を見直す

### DRIFT-XELMB8 [high] (spec_test)
- Clause: C-002
- Title: C-002.test_pattern[0].must_cover が満たされていない
- Detail: must_cover "TenantContextEnvelopeV1 schema and integrity planned Red" が packages/cloudflare-techknight-poc/src/__tests__/runtime-config.test.ts のテストで参照されていない
- Suggested action: テストを追加するか、clause の verifiable_by.test_pattern を見直す

### DRIFT-HWW3XE [high] (spec_test)
- Clause: INV-003
- Title: INV-003.test_pattern[0].must_cover が満たされていない
- Detail: must_cover "Worker Queue DO Container MCP Brainbase proxy delivery validators planned Red" が packages/cloudflare-techknight-poc/src/__tests__/queue-consumer.test.ts のテストで参照されていない
- Suggested action: テストを追加するか、clause の verifiable_by.test_pattern を見直す

### DRIFT-3N493Y [high] (spec_test)
- Clause: C-003
- Title: C-003.test_pattern[0].must_cover が満たされていない
- Detail: must_cover "tenant event operation atomic idempotency planned Red" が packages/cloudflare-techknight-poc/src/__tests__/runtime-event-claim.test.ts のテストで参照されていない
- Suggested action: テストを追加するか、clause の verifiable_by.test_pattern を見直す

### DRIFT-A6P48N [high] (spec_test)
- Clause: INV-004
- Title: INV-004.test_pattern[0].must_cover が満たされていない
- Detail: must_cover "TenantPartitionKeyV1 matrix planned Red" が packages/cloudflare-techknight-poc/src/__tests__/runtime-workspace-key-red.test.ts のテストで参照されていない
- Suggested action: テストを追加するか、clause の verifiable_by.test_pattern を見直す

### DRIFT-VZ65Q4 [high] (spec_test)
- Clause: INV-005
- Title: INV-005.test_pattern[0].must_cover が満たされていない
- Detail: must_cover "ContainerSanitizationReceiptV1 planned Red" が packages/cloudflare-techknight-poc/src/__tests__/disposable-resource.test.ts のテストで参照されていない
- Suggested action: テストを追加するか、clause の verifiable_by.test_pattern を見直す

### DRIFT-UFYU4F [high] (spec_test)
- Clause: C-004
- Title: C-004.test_pattern[0].must_cover が満たされていない
- Detail: must_cover "common external contract across deployment profiles planned Red" が packages/cloudflare-techknight-poc/src/__tests__/deployment-config.test.ts のテストで参照されていない
- Suggested action: テストを追加するか、clause の verifiable_by.test_pattern を見直す

### DRIFT-2U4859 [high] (spec_test)
- Clause: INV-006
- Title: INV-006.test_pattern[0].must_cover が満たされていない
- Detail: must_cover "concurrent A B negative matrix planned Red" が packages/cloudflare-techknight-poc/src/__tests__/queue-consumer.test.ts のテストで参照されていない
- Suggested action: テストを追加するか、clause の verifiable_by.test_pattern を見直す

### DRIFT-25A6N9 [high] (spec_test)
- Clause: C-005
- Title: C-005.test_pattern[0].must_cover が満たされていない
- Detail: must_cover "temporary object lifecycle and deletion receipt planned Red" が packages/cloudflare-techknight-poc/src/__tests__/slack-attachments.test.ts のテストで参照されていない
- Suggested action: テストを追加するか、clause の verifiable_by.test_pattern を見直す

### DRIFT-HT456R [high] (spec_test)
- Clause: C-006
- Title: C-006.test_pattern[0].must_cover が満たされていない
- Detail: must_cover "CredentialDecisionV1 selection and injection planned Red" が packages/cloudflare-techknight-poc/src/__tests__/anthropic-auth.test.ts のテストで参照されていない
- Suggested action: テストを追加するか、clause の verifiable_by.test_pattern を見直す

### DRIFT-V2JB4E [high] (spec_test)
- Clause: C-007
- Title: C-007.test_pattern[0].must_cover が満たされていない
- Detail: must_cover "tenant OAuth lifecycle and concurrent refresh planned Red" が packages/cloudflare-techknight-poc/src/__tests__/anthropic-auth.test.ts のテストで参照されていない
- Suggested action: テストを追加するか、clause の verifiable_by.test_pattern を見直す

### DRIFT-9AVB3N [high] (spec_test)
- Clause: INV-007
- Title: INV-007.test_pattern[0].must_cover が満たされていない
- Detail: must_cover "no credential fallback planned Red" が packages/cloudflare-techknight-poc/src/__tests__/anthropic-auth.test.ts のテストで参照されていない
- Suggested action: テストを追加するか、clause の verifiable_by.test_pattern を見直す

### DRIFT-PCW4SC [high] (spec_test)
- Clause: INV-007
- Title: INV-007.test_pattern[1].must_cover が満たされていない
- Detail: must_cover "no singleton credential source on shared path planned Red" が packages/cloudflare-techknight-poc/src/__tests__/anthropic-auth.test.ts のテストで参照されていない
- Suggested action: テストを追加するか、clause の verifiable_by.test_pattern を見直す

### DRIFT-XVLHNX [high] (spec_test)
- Clause: C-008
- Title: C-008.test_pattern[0].must_cover が満たされていない
- Detail: must_cover "UsageEventV1 success failure and not measured planned Red" が packages/cloudflare-techknight-poc/src/__tests__/reply-pipeline.test.ts のテストで参照されていない
- Suggested action: テストを追加するか、clause の verifiable_by.test_pattern を見直す

### DRIFT-3T3SPU [high] (spec_test)
- Clause: C-009
- Title: C-009.test_pattern[0].must_cover が満たされていない
- Detail: must_cover "per tenant quota decisions and isolation planned Red" が packages/cloudflare-techknight-poc/src/__tests__/runtime-config.test.ts のテストで参照されていない
- Suggested action: テストを追加するか、clause の verifiable_by.test_pattern を見直す

### DRIFT-ZSQ77H [high] (spec_test)
- Clause: C-010
- Title: C-010.test_pattern[0].must_cover が満たされていない
- Detail: must_cover "safe actionable failure and scoped delivery planned Red" が packages/cloudflare-techknight-poc/src/__tests__/reply-pipeline.test.ts のテストで参照されていない
- Suggested action: テストを追加するか、clause の verifiable_by.test_pattern を見直す

### DRIFT-SGJ8UY [high] (spec_test)
- Clause: C-011
- Title: C-011.test_pattern[0].must_cover が満たされていない
- Detail: must_cover "positive negative and non applicable fixture suites planned Red" が packages/cloudflare-techknight-poc/src/__tests__/reply-runtime-wiring.test.ts のテストで参照されていない
- Suggested action: テストを追加するか、clause の verifiable_by.test_pattern を見直す
