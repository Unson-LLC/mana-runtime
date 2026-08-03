import { mkdirSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import {
  buildMeetingMinutesFailureControl,
  buildSettingsAppHomeBlocks,
  buildSettingsDmBlocks,
} from '../packages/jimmy/src/connectors/slack/settings-deep-link'

const topology = {
  schemaVersion: 1,
  observedAt: '2026-08-02T00:00:00.000Z',
  connectors: [
    {
      instanceId: 'slack-source', employee: 'mana', workspaceId: 'T-SOURCE',
      workspaceName: 'Brainbase',
      health: 'healthy', checkedAt: '2026-08-02T00:00:00.000Z',
      allowlistedOperatorCount: 2, settingsEntryEnabled: true,
      respondTo: { im: 'never', mpim: 'never', channel: 'mention' },
      routerChannels: ['C-ROUTER'],
      routerChannelDetails: [{ channelId: 'C-ROUTER', channelName: 'minutes-router', verification: { status: 'verified', code: 'channel_ready_by_static_checks', checkedAt: '2026-08-02T00:00:00.000Z' } }],
    },
    {
      instanceId: 'slack-client', employee: 'mana-client', workspaceId: 'T-CLIENT',
      workspaceName: 'Client Workspace',
      health: 'degraded', checkedAt: '2026-08-02T00:00:00.000Z',
      allowlistedOperatorCount: 1, settingsEntryEnabled: true,
      respondTo: { im: 'never', mpim: 'never', channel: 'mention' },
      routerChannels: [],
      routerChannelDetails: [],
    },
  ],
  routes: [
    {
      id: 'primary:slack-source:brainbase', kind: 'primary',
      sourceConnectorInstanceId: 'slack-source', routerChannels: ['C-ROUTER'],
      sourceWorkspaceId: 'T-SOURCE', sourceWorkspaceName: 'Brainbase',
      routerChannelDetails: [{ channelId: 'C-ROUTER', channelName: 'minutes-router', verification: { status: 'verified', code: 'channel_ready_by_static_checks', checkedAt: '2026-08-02T00:00:00.000Z' } }],
      destinationConnectorInstanceId: 'slack-source', workspaceId: 'T-SOURCE',
      workspaceName: 'Brainbase',
      projectId: 'brainbase', projectName: 'Brainbase', channelId: 'C-BRAINBASE',
      channelName: 'meeting-minutes',
      verification: { status: 'verified', code: 'channel_ready_by_static_checks', checkedAt: '2026-08-02T00:00:00.000Z' },
    },
    {
      id: 'share:slack-source:client-a', kind: 'share',
      sourceConnectorInstanceId: 'slack-source', routerChannels: ['C-ROUTER'],
      sourceWorkspaceId: 'T-SOURCE', sourceWorkspaceName: 'Brainbase',
      routerChannelDetails: [{ channelId: 'C-ROUTER', channelName: 'minutes-router', verification: { status: 'verified', code: 'channel_ready_by_static_checks', checkedAt: '2026-08-02T00:00:00.000Z' } }],
      destinationConnectorInstanceId: 'slack-client', workspaceId: 'T-CLIENT',
      workspaceName: 'Client Workspace',
      projectId: 'client-a', projectName: 'Client A', channelId: 'C-CLIENT',
      channelName: 'shared-minutes',
      verification: { status: 'error', code: 'bot_not_member', checkedAt: '2026-08-02T00:00:00.000Z' },
    },
  ],
  warnings: [{ code: 'bot_not_member', severity: 'warning', targetId: 'C-CLIENT', message: 'Botが共有先channelに参加していません' }],
  history: [],
  summary: { connectorCount: 2, routeCount: 2, warningCount: 1 },
}

const evidenceDir = '.vibepro/visual/story-mana-configuration-visibility'

test.beforeEach(async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  const requiresOperatorAuth = testInfo.title.includes('through operator auth')
  await page.addInitScript(({ requiresOperatorAuth }) => {
    localStorage.setItem('openryoko-theme', 'dark')
    if (!requiresOperatorAuth) {
      localStorage.setItem('openryoko.operatorToken', 'visual-test-token')
    }
    localStorage.setItem('jinn-onboarded', 'true')
  }, { requiresOperatorAuth })
  await page.route('**/api/settings/topology', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(topology) }))
})

test('desktop topology distinguishes primary and cross-workspace share routes', async ({ page }) => {
  mkdirSync(evidenceDir, { recursive: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/settings/topology')

  await expect(page.getByRole('heading', { name: 'Mana 構成' })).toBeVisible()
  await expect(page.getByText('通常配送')).toBeVisible()
  await expect(page.getByText('別workspace共有')).toBeVisible()
  await expect(page.getByText('bot_not_member', { exact: false }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: /編集|保存|適用/ })).toHaveCount(0)
  await page.screenshot({ path: `${evidenceDir}/topology-desktop.png`, fullPage: true })
})

test('mobile meeting-minutes deep link keeps the selected route and navigation readable', async ({ page }) => {
  mkdirSync(evidenceDir, { recursive: true })
  await page.setViewportSize({ width: 320, height: 844 })
  await page.goto('/settings/meeting-minutes?workspace=T-CLIENT&project=client-a&channel=C-CLIENT')

  await expect(page.getByRole('navigation', { name: 'Mana構成' })).toBeVisible()
  const selected = page.getByRole('heading', { name: /^Client A/ }).locator('xpath=ancestor::article[1]')
  await expect(selected).toHaveClass(/border-\[var\(--accent\)\]/)
  await expect(page.getByText('別workspace共有')).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(page.locator(':focus')).toBeVisible()
  await page.screenshot({ path: `${evidenceDir}/meeting-minutes-mobile.png`, fullPage: true })
})

function actionUrl(blocks: unknown[], actionId?: string): string {
  for (const block of blocks as Array<{ elements?: Array<{ action_id?: string; url?: string }> }>) {
    const action = block.elements?.find((element) => element.url && (!actionId || element.action_id === actionId))
    if (action?.url) return action.url
  }
  throw new Error(`Slack action ${actionId ?? '<any>'} was not produced`)
}

test('App Home and exact DM production entries reach the Web topology', async ({ page }) => {
  const appHomeUrl = actionUrl(buildSettingsAppHomeBlocks({
    webBaseUrl: 'http://localhost:7779', running: true, instanceId: 'slack-source',
  }), 'open_mana_settings')
  await page.goto(appHomeUrl)
  await expect(page).toHaveURL(/\/settings\/topology$/)
  await expect(page.getByRole('heading', { name: 'Mana 構成' })).toBeVisible()

  const dmUrl = actionUrl(buildSettingsDmBlocks('http://localhost:7779'), 'open_mana_settings_dm')
  await page.goto(dmUrl)
  await expect(page).toHaveURL(/\/settings\/topology$/)
  await expect(page.getByRole('heading', { name: 'Mana 構成' })).toBeVisible()
})

test('fixed production origin produces an HTTPS browser-addressable Slack entry', async ({ page }) => {
  const appHomeUrl = actionUrl(buildSettingsAppHomeBlocks({
    webBaseUrl: 'https://mana.example.com', running: true, instanceId: 'slack-source',
  }), 'open_mana_settings')
  expect(appHomeUrl).toBe('https://mana.example.com/settings/topology')

  await page.route('https://mana.example.com/**', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><title>Mana settings entry</title><main><h1>Mana 構成入口</h1></main>',
  }))
  const response = await page.goto(appHomeUrl)
  expect(response?.status()).toBe(200)
  await expect(page).toHaveURL('https://mana.example.com/settings/topology')
  await expect(page.getByRole('heading', { name: 'Mana 構成入口' })).toBeVisible()
})

test('read-only topology journey issues no settings mutation request', async ({ page }) => {
  const topologyRequests: Array<{ method: string; pathname: string }> = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/settings')) {
      topologyRequests.push({ method: request.method(), pathname: url.pathname })
    }
  })

  await page.goto('/settings/topology')
  await expect(page.getByRole('heading', { name: 'Mana 構成' })).toBeVisible()
  await page.getByRole('button', { name: '構成情報を再取得' }).click()
  await expect.poll(() => topologyRequests.length).toBeGreaterThanOrEqual(2)
  expect(topologyRequests).toEqual(topologyRequests.map(() => ({
    method: 'GET', pathname: '/api/settings/topology',
  })))
})

test('meeting-minutes error production entry reaches its target through operator auth', async ({ page }) => {
  const control = buildMeetingMinutesFailureControl({
    key: 'router:C-ROUTER:F-001:1.0',
    message: '議事録の投稿に失敗しました',
    settingsWebBaseUrl: 'http://localhost:7779',
    target: { workspaceId: 'T-CLIENT', projectId: 'client-a', channelId: 'C-CLIENT' },
  })
  const action = actionUrl(control.blocks, undefined)
  expect(action).toContain('/settings/meeting-minutes?')

  await page.goto(action)
  await expect(page.getByRole('heading', { name: 'Operator認証が必要です' })).toBeVisible()
  await page.getByLabel('Operator Token').fill('journey-test-token')
  await page.getByRole('button', { name: 'Tokenを保存して再取得' }).click()

  const selected = page.getByRole('heading', { name: /^Client A/ }).locator('xpath=ancestor::article[1]')
  await expect(selected).toHaveClass(/border-\[var\(--accent\)\]/)
})

test('sidebar entry reaches topology in one browser operation', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/settings')
  const topologyEntry = page.getByRole('link', { name: '構成', exact: true })
  await expect(topologyEntry).toBeVisible()
  await topologyEntry.click()
  await expect(page).toHaveURL(/\/settings\/topology$/)
  await expect(page.getByRole('link', { name: '構成', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('heading', { name: 'Mana 構成' })).toBeVisible()
})

test('mobile global menu entry reaches topology', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 })
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Open menu' }).click()
  const topologyEntry = page.getByRole('link', { name: '構成', exact: true })
  await expect(topologyEntry).toBeVisible()
  await topologyEntry.click()
  await expect(page).toHaveURL(/\/settings\/topology$/)
  await expect(page.getByRole('heading', { name: 'Mana 構成' })).toBeVisible()
})
