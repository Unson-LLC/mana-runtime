import { describe, it, expect, vi } from 'vitest'

vi.hoisted(() => {
  process.env.RYOKO_HOME = `/tmp/openryoko-placements-test-${process.pid}`
  delete process.env.JINN_HOME
})

import { buildPlacementLedger } from '../placements.js'
import { createSession, accumulateSessionCost } from '../../sessions/registry.js'
import type { PlacementProfile } from '../../shared/types.js'

const basePlacement: PlacementProfile = {
  id: 'mana-test',
  connector: 'slack',
  workspaceId: 'T1',
  channelId: 'C1',
  owner: 'U1',
  purpose: 'operator dialogue',
  audience: { type: 'operator', allowedUsers: ['U1', 'U2'] },
  agent: { employee: 'ryoko', defaultModel: 'sonnet' },
  capabilities: { mcp: ['brainbase'], gatewayTools: ['send_message'] },
}

describe('buildPlacementLedger', () => {
  it('joins ledger fields with monthly placement costs and keeps unplaced/orphan spend visible', () => {
    const placed = createSession({
      engine: 'mock', source: 'slack', sourceRef: 'l-1:1', connector: 'slack',
      transportMeta: { placementId: 'mana-test' },
    })
    accumulateSessionCost(placed.id, 2.5, 3)
    const orphan = createSession({
      engine: 'mock', source: 'slack', sourceRef: 'l-2:1', connector: 'slack',
      transportMeta: { placementId: 'removed-placement' },
    })
    accumulateSessionCost(orphan.id, 1.0, 1)
    const unplaced = createSession({
      engine: 'mock', source: 'slack', sourceRef: 'l-3:1', connector: 'slack',
    })
    accumulateSessionCost(unplaced.id, 0.5, 1)

    const ledger = buildPlacementLedger([basePlacement])
    expect(ledger.placements).toHaveLength(1)
    const entry = ledger.placements[0]
    expect(entry).toMatchObject({
      id: 'mana-test', owner: 'U1', purpose: 'operator dialogue', enabled: true,
      audienceType: 'operator', allowedUserCount: 2, employee: 'ryoko',
      defaultModel: 'sonnet', budgetTracked: true, mcp: [{ name: 'brainbase', mode: 'full' }],
      gatewayTools: ['send_message'], deliveryTargets: ['slack:C1'],
      monthlySessions: 1,
    })
    expect(entry.monthlyCost).toBeCloseTo(2.5)
    expect(entry.lastActivity).toBeTruthy()
    expect(ledger.unplaced.monthlyCost).toBeCloseTo(0.5)
    expect(ledger.orphanCosts).toContainEqual(expect.objectContaining({ placementId: 'removed-placement', sessions: 1 }))
  })

  it('flags ledger gaps: missing owner/purpose, untracked budget, disabled kill switch', () => {
    const bare: PlacementProfile = {
      id: 'bare', connector: 'slack', workspaceId: 'T1', channelId: 'C9',
      enabled: false,
      audience: { type: 'client', allowedUsers: [] },
    }
    const [entry] = buildPlacementLedger([bare]).placements
    expect(entry).toMatchObject({
      id: 'bare', owner: null, purpose: null, enabled: false,
      budgetTracked: false, employee: null, mcp: false, gatewayTools: [],
      monthlyCost: 0, monthlySessions: 0, lastActivity: null,
    })
  })

  it('projects read-only and fail-closed rejected MCP grants with their modes (G2 ledger visibility)', () => {
    const readOnly: PlacementProfile = {
      ...basePlacement,
      id: 'mana-accounting',
      capabilities: { mcp: [{ name: 'freee', mode: 'read-only' }, { name: 'nocodb', mode: 'read-only' }, 'brainbase'] },
    }
    const catalog = {
      custom: { freee: { command: 'npx', tools: { writeTools: ['freee_api_post'] } } },
    }
    const [entry] = buildPlacementLedger([readOnly], catalog).placements
    expect(entry.mcp).toEqual([
      { name: 'freee', mode: 'read-only' },
      { name: 'brainbase', mode: 'full' },
      // nocodb declared no tool classification → the ledger shows the rejection.
      { name: 'nocodb', mode: 'read-only', rejected: true },
    ])
  })

  it('redacts secret-like values in free-text ledger fields', () => {
    const leaky: PlacementProfile = {
      ...basePlacement, id: 'leaky',
      owner: 'xoxb-1234567890-secret',
      purpose: 'legit purpose',
    }
    const [entry] = buildPlacementLedger([leaky]).placements
    expect(entry.owner).toBe('[REDACTED]')
    expect(entry.purpose).toBe('legit purpose')
  })

  it('returns an empty ledger when no placements are configured', () => {
    const ledger = buildPlacementLedger(undefined)
    expect(ledger.placements).toEqual([])
  })
})
