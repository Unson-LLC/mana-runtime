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
      'ac:1': 'matches an exact workspace, channel, and user',
      'ac:2': 'denies ambiguous matching profiles',
      'ac:3': 'atomically rebinds an existing Slack session to the resolved placement authority',
      'ac:4': 'allows only the primary and escalation employees',
      'ac:5': 'applies placement MCP selection and gateway policy environment',
      'ac:6': 'allows only an authenticated placement delivery target on the direct connector route',
      'ac:7': 'denies localhost operator mutations without the out-of-process operator token',
      'ac:8': 'never renders secret-like placement data in the system context',
      'ac:9': 'preserves legacy routing when no placements are configured',
      'ac:10': 'uses Bolt context.teamId as the reaction workspace boundary',
      'ac:11': 'uses the allowed employee definition and rejects execution overrides',
      'S-001': 'filters and rejects tools not explicitly allowed',
      'S-002': 'fails closed when the parent placement is no longer configured',
      'S-003': 'allows employee omission so the server can inherit the parent employee',
    } as const

    for (const [clause, testName] of Object.entries(clauseEvidence)) {
      expect(output, `vibepro: ${clause} -> ${testName}`).toContain(testName)
    }
  })
})
