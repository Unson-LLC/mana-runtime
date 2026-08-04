import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { test, expect } from '@playwright/test'

const repoRoot = path.resolve(__dirname, '..')

test('S-001 S-002 S-003 S-004: headless deployment contract boundary', () => {
  const output = execFileSync(
    path.join(repoRoot, 'scripts/deploy/test-deploy-scripts.sh'),
    { cwd: repoRoot, encoding: 'utf8' },
  )

  expect(output, 'vibepro: ac:1 manual workflow contract').toContain('deploy workflow semantic contract passed')
  expect(output, 'vibepro: ac:2 main commit resolution').toContain('commit resolution fixtures passed')
  expect(output, 'vibepro: ac:3 restricted installer artifacts').toContain('installer artifact fixtures passed')
  expect(output, 'vibepro: ac:4 forced SSH command validation').toContain('deploy script, workflow contract, and rollback validation passed')
  expect(output, 'vibepro: ac:5 build failure safety').toContain('rollback validation passed')
  expect(output, 'vibepro: ac:6 guarded restart safety').toContain('rollback validation passed')
  expect(output, 'vibepro: ac:7 systemd activation safety').toContain('rollback validation passed')
  expect(output, 'vibepro: ac:8 entrypoint identity safety').toContain('rollback validation passed')
  expect(output, 'vibepro: ac:9 process identity safety').toContain('rollback validation passed')
  expect(output, 'vibepro: ac:10 post-activation cleanup semantics').toContain('rollback validation passed')
})
