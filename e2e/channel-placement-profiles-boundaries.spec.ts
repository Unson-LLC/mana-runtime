import { execFileSync } from 'node:child_process'
import { test, expect } from '@playwright/test'

test.describe('Channel Placement Profile execution boundaries', () => {
  test('focused integration journey satisfies placement acceptance contract', () => {
    const output = execFileSync(
      'pnpm',
      ['--filter', 'openryoko', 'test:integration'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, CI: '1' },
      },
    )

    expect(output, 'vibepro: AC-1 legacy compatibility').toContain(
      'preserves legacy routing when no placements are configured',
    )
    expect(output, 'vibepro: AC-2 unique placement routing').toContain(
      'matches an exact workspace, channel, and user',
    )
    expect(output, 'vibepro: AC-3 employee and model selection').toContain(
      'allows only the primary and escalation employees',
    )
    expect(output, 'vibepro: AC-4 MCP server deny-by-default').toContain(
      'applies placement MCP selection and gateway policy environment',
    )
    expect(output, 'vibepro: AC-5 MCP tool allowlist').toContain(
      'filters and rejects tools not explicitly allowed',
    )
    expect(output, 'vibepro: AC-6 connector and channel boundary').toContain(
      'allows only an authenticated placement delivery target on the direct connector route',
    )
    expect(output, 'vibepro: AC-7 placement audit context').toContain(
      'renders placement identity, audience, projects, and data scope in the system context',
    )
    expect(output, 'vibepro: AC-8 secret redaction').toContain(
      'never renders secret-like placement data in the system context',
    )
    expect(output, 'vibepro: AC-9 positive and denial regression paths').toContain(
      'fails closed for unauthorized user',
    )
    expect(output, 'vibepro: AC-10 child and cross-request parent inheritance').toContain(
      'inherits placement employee and execution settings on a valid nested child',
    )
    expect(output, 'vibepro: AC-11 delegation override rejection').toContain(
      'uses the allowed employee definition and rejects execution overrides',
    )
    expect(output, 'vibepro: S-001 exact Slack placement match').toContain(
      'matches an exact workspace, channel, and user',
    )
    expect(output, 'vibepro: S-002 unauthorized Slack event rejection').toContain(
      'fails closed for unauthorized user',
    )
    expect(output, 'vibepro: S-003 outbound target rejection before delivery').toContain(
      'allows only an authenticated placement delivery target on the direct connector route',
    )
  })
})
