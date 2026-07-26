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
    expect(output, 'vibepro: AC-2 rejects an unregistered channel').toContain(
      'fails closed for unmatched channel',
    )
    expect(output, 'vibepro: AC-2 rejects the wrong workspace').toContain(
      'fails closed for wrong workspace',
    )
    expect(output, 'vibepro: AC-2 rejects an unauthorized user').toContain(
      'fails closed for unauthorized user',
    )
    expect(output, 'vibepro: AC-2 rejects ambiguous placement matches').toContain(
      'denies ambiguous matching profiles',
    )
    expect(output, 'vibepro: AC-3 employee and model selection').toContain(
      'allows only the primary and escalation employees',
    )
    expect(output, 'vibepro: AC-4 MCP server deny-by-default').toContain(
      'applies placement MCP selection and gateway policy environment',
    )
    expect(output, 'vibepro: AC-4 denies MCP when capability is omitted').toContain(
      'denies all MCP servers when a placement omits MCP capability',
    )
    expect(output, 'vibepro: AC-4 excludes globally available unlisted MCP servers').toContain(
      'records globally available MCP servers excluded by a placement allowlist',
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
    expect(output, 'vibepro: AC-9 MCP resolver allow and deny paths').toContain(
      'denies all MCP servers when a placement omits MCP capability',
    )
    expect(output, 'vibepro: AC-9 delivery allow and deny paths').toContain(
      'allows only an authenticated placement delivery target on the direct connector route',
    )
    expect(output, 'vibepro: AC-9 Slack reaction workspace boundary').toContain(
      'uses Bolt context.teamId as the reaction workspace boundary',
    )
    expect(output, 'vibepro: AC-9 child denial path').toContain(
      'rejects a token bound to another parent on nested child',
    )
    expect(output, 'vibepro: AC-9 cross-request denial path').toContain(
      'rejects a token bound to another parent on cross request',
    )
    expect(output, 'vibepro: AC-9 cross-request success path').toContain(
      'inherits placement and provider execution settings on a valid cross-request',
    )
    expect(output, 'vibepro: AC-10 child and cross-request parent inheritance').toContain(
      'inherits placement employee and execution settings on a valid nested child',
    )
    expect(output, 'vibepro: AC-10 cross-request parent inheritance').toContain(
      'inherits placement and provider execution settings on a valid cross-request',
    )
    expect(output, 'vibepro: AC-10 rejects mismatched child parent authorization').toContain(
      'rejects a token bound to another parent on nested child',
    )
    expect(output, 'vibepro: AC-10 rejects mismatched cross-request parent authorization').toContain(
      'rejects a token bound to another parent on cross request',
    )
    expect(output, 'vibepro: AC-10 rejects missing parents for both derived APIs').toContain(
      'records missing parent rejection on child and cross-request APIs',
    )
    expect(output, 'vibepro: AC-11 delegation override rejection').toContain(
      'uses the allowed employee definition and rejects execution overrides',
    )
    expect(output, 'vibepro: AC-12 operator token protects localhost control plane').toContain(
      'denies localhost operator mutations without the out-of-process operator token',
    )
    expect(output, 'vibepro: AC-12 operator token authorizes protected requests').toContain(
      'requires operator authorization for legacy parent creation while placements are active',
    )
    expect(output, 'vibepro: AC-13 Discord proxy requires a dedicated service principal').toContain(
      'keeps remote Discord proxying on a separate service principal',
    )
    expect(output, 'vibepro: AC-13 Discord input rejects missing and wrong credentials').toContain(
      'authenticates proxied Discord input with the same service principal',
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
