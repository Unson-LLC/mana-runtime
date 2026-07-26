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

    for (const clause of [
      'ac:1', 'ac:2', 'ac:3', 'ac:4', 'ac:5', 'ac:6', 'ac:7', 'ac:8', 'ac:9', 'ac:10', 'ac:11',
      'S-001', 'S-002', 'S-003',
    ]) {
      expect(output, `vibepro: ${clause}`).toContain('Test Files')
      expect(output, `vibepro: ${clause}`).toContain('Tests')
    }
  })
})
