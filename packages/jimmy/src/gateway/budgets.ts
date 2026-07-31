import { v4 as uuid } from 'uuid';
import { initDb } from '../sessions/registry.js';

export type BudgetStatus = 'ok' | 'warning' | 'exceeded' | 'paused';

export interface BudgetStatusResult {
  status: BudgetStatus;
  spend: number;
  limit: number;
  percent: number;
}

export function getBudgetStatus(employee: string, budgetConfig: Record<string, number>): BudgetStatusResult {
  const db = initDb();
  const limit = budgetConfig[employee];
  if (!limit) return { status: 'ok', spend: 0, limit: 0, percent: 0 };

  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  const row = db.prepare(
    `SELECT COALESCE(SUM(total_cost), 0) as spend FROM sessions WHERE employee = ? AND created_at >= ?`
  ).get(employee, monthStart) as { spend: number };

  const spend = row.spend;
  const percent = limit > 0 ? Math.round((spend / limit) * 100) : 0;

  let status: BudgetStatus;
  if (percent >= 100) status = 'paused';
  else if (percent >= 80) status = 'warning';
  else status = 'ok';

  return { status, spend, limit, percent };
}

function currentMonthStart(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

// Placement spend is read on every routed message, so month-to-date sums are
// cached briefly instead of hitting SQLite per message. TTL is short enough
// that an over-limit placement is caught within seconds of crossing the cap.
const PLACEMENT_SPEND_TTL_MS = 30_000;
const placementSpendCache = new Map<string, { spend: number; expiresAt: number }>();

export function clearPlacementBudgetCache(): void {
  placementSpendCache.clear();
}

function getPlacementMonthlySpend(placementId: string): number {
  const cached = placementSpendCache.get(placementId);
  if (cached && cached.expiresAt > Date.now()) return cached.spend;

  const db = initDb();
  const row = db.prepare(
    `SELECT COALESCE(SUM(total_cost), 0) as spend FROM sessions
     WHERE json_extract(transport_meta, '$.placementId') = ? AND created_at >= ?`
  ).get(placementId, currentMonthStart()) as { spend: number };

  placementSpendCache.set(placementId, { spend: row.spend, expiresAt: Date.now() + PLACEMENT_SPEND_TTL_MS });
  return row.spend;
}

export function getPlacementBudgetStatus(placementId: string, monthlyBudgetUsd: number | undefined): BudgetStatusResult {
  if (!monthlyBudgetUsd || monthlyBudgetUsd <= 0) return { status: 'ok', spend: 0, limit: 0, percent: 0 };

  const spend = getPlacementMonthlySpend(placementId);
  const percent = Math.round((spend / monthlyBudgetUsd) * 100);

  let status: BudgetStatus;
  if (percent >= 100) status = 'paused';
  else if (percent >= 80) status = 'warning';
  else status = 'ok';

  return { status, spend, limit: monthlyBudgetUsd, percent };
}

/**
 * One warning per placement per calendar month: records a budget_events row
 * (keyed as `placement:<id>` in the employee column) and returns true only for
 * the first call in the month, so callers can notify exactly once.
 */
export function shouldNotifyPlacementBudgetWarning(placementId: string, spend: number, limitUsd: number): boolean {
  const db = initDb();
  const key = `placement:${placementId}`;
  const existing = db.prepare(
    `SELECT id FROM budget_events WHERE employee = ? AND event_type = 'placement_warning' AND created_at >= ? LIMIT 1`
  ).get(key, currentMonthStart());
  if (existing) return false;
  recordBudgetEvent(key, 'placement_warning', spend, limitUsd);
  return true;
}

export function checkBudget(employee: string, budgetConfig: Record<string, number>): BudgetStatus {
  const result = getBudgetStatus(employee, budgetConfig);
  return result.status;
}

export function recordBudgetEvent(employee: string, eventType: string, amount: number, limitAmount: number) {
  const db = initDb();
  db.prepare(
    `INSERT INTO budget_events (id, employee, event_type, amount, limit_amount) VALUES (?, ?, ?, ?, ?)`
  ).run(uuid(), employee, eventType, amount, limitAmount);
}

export function getBudgetEvents(limit = 50) {
  const db = initDb();
  return db.prepare(
    `SELECT * FROM budget_events ORDER BY created_at DESC LIMIT ?`
  ).all(limit);
}

export function overrideBudget(employee: string, budgetConfig: Record<string, number>) {
  const limit = budgetConfig[employee] || 0;
  recordBudgetEvent(employee, 'override', 0, limit);
  return { status: 'ok', message: `Budget override recorded for ${employee}` };
}
