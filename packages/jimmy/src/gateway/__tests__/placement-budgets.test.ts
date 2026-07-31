import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.hoisted(() => {
  process.env.RYOKO_HOME = `/tmp/openryoko-placement-budgets-test-${process.pid}`
  delete process.env.JINN_HOME
})

import {
  getPlacementBudgetStatus,
  clearPlacementBudgetCache,
  shouldNotifyPlacementBudgetWarning,
} from '../budgets.js'
import { buildPlacementLedger } from '../placements.js'
import { resolveRouteOptions } from '../server.js'
import { createSession, accumulateSessionCost } from '../../sessions/registry.js'
import type { Employee, IncomingMessage, JinnConfig, PlacementProfile } from '../../shared/types.js'

let seq = 0
function spend(placementId: string, cost: number): void {
  seq += 1
  const session = createSession({
    engine: 'mock', source: 'slack', sourceRef: `pb-${seq}:1`, connector: 'slack',
    transportMeta: { placementId },
  })
  accumulateSessionCost(session.id, cost, 1)
}

function placement(id: string, monthlyBudgetUsd?: number): PlacementProfile {
  return {
    id,
    connector: 'slack',
    workspaceId: 'T1',
    channelId: `C-${id}`,
    audience: { type: 'operator', allowedUsers: ['U1'] },
    ...(monthlyBudgetUsd !== undefined ? { monthlyBudgetUsd } : {}),
  }
}

function msg(channel: string): IncomingMessage {
  return {
    source: 'slack',
    connector: 'slack',
    sessionKey: `slack:${channel}`,
    channel,
    user: 'U1',
    userId: 'U1',
    text: 'hello',
    attachments: [],
    raw: {},
    transportMeta: { team: 'T1' },
  } as unknown as IncomingMessage
}

const BASE_CONFIG = {
  gateway: { port: 7777, host: '127.0.0.1' },
  engines: { default: 'claude', claude: { bin: 'claude', model: 'sonnet' } },
  connectors: {},
  logging: { level: 'info', stdout: false, file: '' },
} as unknown as JinnConfig

const EMPLOYEES = new Map<string, Employee>()

beforeEach(() => {
  clearPlacementBudgetCache()
})

describe('getPlacementBudgetStatus', () => {
  it('reports ok below 80%, warning at 80%, paused at 100%', () => {
    spend('pb-ok', 5)
    expect(getPlacementBudgetStatus('pb-ok', 100)).toMatchObject({ status: 'ok', spend: 5, limit: 100, percent: 5 })

    spend('pb-warn', 8)
    expect(getPlacementBudgetStatus('pb-warn', 10)).toMatchObject({ status: 'warning', percent: 80 })

    spend('pb-over', 12)
    expect(getPlacementBudgetStatus('pb-over', 10)).toMatchObject({ status: 'paused', percent: 120 })
  })

  it('treats absent or non-positive limits as no cap', () => {
    spend('pb-nolimit', 999)
    expect(getPlacementBudgetStatus('pb-nolimit', undefined).status).toBe('ok')
    expect(getPlacementBudgetStatus('pb-nolimit', 0).status).toBe('ok')
  })

  it('serves spend from cache until cleared, so the hot path skips the DB', () => {
    spend('pb-cache', 1)
    expect(getPlacementBudgetStatus('pb-cache', 10).percent).toBe(10)
    spend('pb-cache', 9)
    // Still the cached value inside the TTL window.
    expect(getPlacementBudgetStatus('pb-cache', 10).percent).toBe(10)
    clearPlacementBudgetCache()
    expect(getPlacementBudgetStatus('pb-cache', 10).status).toBe('paused')
  })
})

describe('shouldNotifyPlacementBudgetWarning', () => {
  it('returns true exactly once per placement per month', () => {
    expect(shouldNotifyPlacementBudgetWarning('pb-notify', 8, 10)).toBe(true)
    expect(shouldNotifyPlacementBudgetWarning('pb-notify', 9, 10)).toBe(false)
    expect(shouldNotifyPlacementBudgetWarning('pb-notify-other', 8, 10)).toBe(true)
  })
})

describe('resolveRouteOptions placement budget enforcement', () => {
  it('fails closed when the placement monthly budget is exceeded', () => {
    spend('pb-route-over', 20)
    const cfg = { ...BASE_CONFIG, placements: [placement('pb-route-over', 10)] } as JinnConfig
    expect(resolveRouteOptions(cfg, msg('C-pb-route-over'), EMPLOYEES)).toBeUndefined()
  })

  it('keeps routing a placement under its budget (warning is not a block)', () => {
    spend('pb-route-warn', 8)
    const cfg = { ...BASE_CONFIG, placements: [placement('pb-route-warn', 10)] } as JinnConfig
    const opts = resolveRouteOptions(cfg, msg('C-pb-route-warn'), EMPLOYEES)
    expect(opts?.placement?.id).toBe('pb-route-warn')
  })

  it('keeps routing a placement without a budget (backward compatible)', () => {
    spend('pb-route-nolimit', 9999)
    const cfg = { ...BASE_CONFIG, placements: [placement('pb-route-nolimit')] } as JinnConfig
    const opts = resolveRouteOptions(cfg, msg('C-pb-route-nolimit'), EMPLOYEES)
    expect(opts?.placement?.id).toBe('pb-route-nolimit')
  })
})

describe('buildPlacementLedger budget fields', () => {
  it('projects the cap and utilization; null when no cap is set', () => {
    spend('pb-ledger', 5)
    const [capped, uncapped] = buildPlacementLedger([
      placement('pb-ledger', 20),
      placement('pb-ledger-nolimit'),
    ]).placements
    expect(capped).toMatchObject({ monthlyBudgetUsd: 20, budgetPercent: 25 })
    expect(uncapped).toMatchObject({ monthlyBudgetUsd: null, budgetPercent: null })
  })
})
