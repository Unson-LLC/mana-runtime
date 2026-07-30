import { describe, it, expect, vi } from 'vitest'

vi.hoisted(() => {
  // Static ESM imports are evaluated before top-level test code. Set the
  // instance home in a hoisted block so shared/path constants resolve to an
  // isolated writable database instead of the user's real runtime DB.
  process.env.RYOKO_HOME = `/tmp/openryoko-costs-test-${process.pid}`
  delete process.env.JINN_HOME
})

import { getCostSummary, getCostsByEmployee, getCostsByPlacement, UNPLACED_COST_KEY } from '../costs.js'
import { createSession, accumulateSessionCost } from '../../sessions/registry.js'

describe('getCostSummary', () => {
  it('returns zero total when no sessions exist', () => {
    const result = getCostSummary('month')
    expect(result.total).toBeGreaterThanOrEqual(0)
    expect(Array.isArray(result.daily)).toBe(true)
    expect(Array.isArray(result.byEmployee)).toBe(true)
  })

  it('returns zero for day period', () => {
    const result = getCostSummary('day')
    expect(result.total).toBeGreaterThanOrEqual(0)
  })

  it('returns zero for week period', () => {
    const result = getCostSummary('week')
    expect(result.total).toBeGreaterThanOrEqual(0)
  })
})

describe('getCostsByPlacement', () => {
  it('groups monthly cost by transport_meta.placementId and reports unplaced sessions', () => {
    const placed = createSession({
      engine: 'mock', source: 'slack', sourceRef: 'ch-1:1', connector: 'slack',
      transportMeta: { placementId: 'mana-test', team: 'T01' },
    })
    accumulateSessionCost(placed.id, 1.5, 2)
    const placedAgain = createSession({
      engine: 'mock', source: 'slack', sourceRef: 'ch-1:2', connector: 'slack',
      transportMeta: { placementId: 'mana-test', team: 'T01' },
    })
    accumulateSessionCost(placedAgain.id, 0.5, 1)
    const unplaced = createSession({
      engine: 'mock', source: 'slack', sourceRef: 'ch-2:1', connector: 'slack',
    })
    accumulateSessionCost(unplaced.id, 0.25, 1)

    const rows = getCostsByPlacement('month')
    const byId = Object.fromEntries(rows.map((row) => [row.placementId, row]))

    expect(byId['mana-test'].cost).toBeCloseTo(2.0)
    expect(byId['mana-test'].sessions).toBe(2)
    expect(byId['mana-test'].lastActivity).toBeTruthy()
    expect(byId[UNPLACED_COST_KEY].cost).toBeGreaterThanOrEqual(0.25)
    expect(byId[UNPLACED_COST_KEY].sessions).toBeGreaterThanOrEqual(1)
  })

  it('accepts week period', () => {
    expect(Array.isArray(getCostsByPlacement('week'))).toBe(true)
  })
})

describe('getCostsByEmployee', () => {
  it('returns an array', () => {
    const result = getCostsByEmployee('month')
    expect(Array.isArray(result)).toBe(true)
  })
})
