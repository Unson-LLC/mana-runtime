import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'

const repoRoot = path.resolve(__dirname, '..')

test('Lightsail通常デプロイ経路は廃止され、復旧境界だけが記録されている', () => {
  const workflow = path.join(repoRoot, '.github/workflows/deploy-lightsail.yml')
  const runbook = fs.readFileSync(
    path.join(repoRoot, 'docs/operations/lightsail-deploy-workflow.md'),
    'utf8',
  )
  const decommissionRecord = fs.readFileSync(
    path.join(repoRoot, 'docs/operations/lightsail-runtime-decommission-2026-08-18.md'),
    'utf8',
  )

  expect(fs.existsSync(workflow)).toBe(false)
  expect(runbook).toContain('Lightsailデプロイ経路（廃止済み）')
  expect(runbook).toContain('通常の配備や検証に使わない')
  expect(decommissionRecord).toContain('過去のLightsail版を直接再起動しない')
  expect(decommissionRecord).toContain('同じSlack入力に対するCloudflare/Lightsailの重複件数が0')
})
