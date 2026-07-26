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

    const clauseEvidence = {
      'ac:1': 'preserves legacy routing when no placements are configured',
      'ac:2': 'matches an exact workspace, channel, and user',
      'ac:3': 'denies ambiguous matching profiles',
      'ac:4': 'allows only the primary and escalation employees',
      'ac:5': 'applies placement MCP selection and gateway policy environment',
      'ac:6': 'filters and rejects tools not explicitly allowed',
      'ac:7': 'allows only an authenticated placement delivery target on the direct connector route',
      'ac:8': 'renders placement identity, audience, projects, and data scope in the system context',
      'ac:9': 'never renders secret-like placement data in the system context',
      'ac:10': 'uses Bolt context.teamId as the reaction workspace boundary',
      'ac:11': 'uses the allowed employee definition and rejects execution overrides',
      'ac:12': 'carries the operator token in WebSocket subprotocol metadata without putting it in the URL',
      'ac:13': 'keeps remote Discord proxying on a separate service principal',
      'S-001': 'matches an exact workspace, channel, and user',
      'S-002': 'fails closed for unauthorized user',
      'S-003': 'allows only an authenticated placement delivery target on the direct connector route',
    } as const

    for (const [clause, testName] of Object.entries(clauseEvidence)) {
      expect(output, `vibepro: ${clause} -> ${testName}`).toContain(testName)
    }
  })
})
