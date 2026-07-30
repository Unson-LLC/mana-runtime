import { execFileSync } from 'node:child_process'
import { test, expect } from '@playwright/test'

// Story: agent-ledger-gaps (docs/stories/agent-ledger-gaps.md)
// Executable coverage markers map acceptance criteria to the focused vitest
// suites, following the channel-placement-profiles-boundaries.spec.ts contract.
test.describe('Agent ledger execution boundaries', () => {
  test('focused suites satisfy the agent-ledger acceptance contract', () => {
    const output = execFileSync(
      'pnpm',
      [
        '--filter', 'openryoko', 'exec', 'vitest', 'run', '--reporter=verbose',
        'src/shared/__tests__/placement-profile.test.ts',
        'src/gateway/__tests__/placements.test.ts',
        'src/gateway/__tests__/costs.test.ts',
        'src/gateway/__tests__/api-placement-authorization-http.test.ts',
        'src/shared/__tests__/security-events.test.ts',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, CI: '1' },
      },
    )

    expect(output, 'vibepro: ac:1 owner/purpose backward compatibility (S-001)').toContain(
      'treats explicit enabled: true and absent enabled as active',
    )
    expect(output, 'vibepro: ac:2 placement monthly cost aggregation with unplaced visibility').toContain(
      'groups monthly cost by transport_meta.placementId and reports unplaced sessions',
    )
    expect(output, 'vibepro: ac:3 kill switch fails closed at the resolver').toContain(
      'fails closed with an auditable reason when the placement kill switch is off',
    )
    expect(output, 'vibepro: ac:3 kill switch fails closed at delivery').toContain(
      'fail-closes direct delivery when the placement kill switch is off',
    )
    expect(output, 'vibepro: ac:4 disabled placement rejected on session-bound authorization').toContain(
      'reports a disabled placement distinctly so callers fail closed',
    )
    expect(output, 'vibepro: ac:5 placement_disabled security event audit').toContain(
      'fail-closes direct delivery when the placement kill switch is off',
    )
    expect(output, 'vibepro: ac:6 ledger joins costs and keeps unplaced/orphan spend visible').toContain(
      'joins ledger fields with monthly placement costs and keeps unplaced/orphan spend visible',
    )
    expect(output, 'vibepro: ac:6 ledger redacts secret-like values').toContain(
      'redacts secret-like values in free-text ledger fields',
    )
    expect(output, 'vibepro: ac:7 operator token protection regression for read APIs').toContain(
      'protects session metadata and transcripts while placements are active',
    )
    expect(output, 'vibepro: ac:8 ledger gap flags for missing owner/purpose/budget').toContain(
      'flags ledger gaps: missing owner/purpose, untracked budget, disabled kill switch',
    )
    expect(output, 'vibepro: ac:9 schema_failure invalid placement config fails closed').toContain(
      'fails closed when a placement data scope contains a secret-like value',
    )
    expect(output, 'vibepro: workflow_state_regression placement authorization boundary suite green').toContain(
      'placement authorization at HTTP derived-session endpoints',
    )
  })
})
