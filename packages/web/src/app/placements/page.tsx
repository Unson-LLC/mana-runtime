"use client"

import { useCallback, useEffect, useState } from "react"
import { RefreshCw } from "lucide-react"
import { api } from "@/lib/api"
import type { PlacementLedger, PlacementLedgerEntry } from "@/lib/api"
import { PageLayout } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"

function GapBadge({ label, tone }: { label: string; tone: "red" | "orange" }) {
  const color = tone === "red" ? "var(--system-red)" : "var(--system-orange)"
  return (
    <span
      className="inline-flex items-center rounded-full px-[var(--space-2)] py-px text-[length:var(--text-caption2)] font-[var(--weight-medium)] border"
      style={{ color, borderColor: color }}
    >
      {label}
    </span>
  )
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`
}

function formatLastActivity(iso: string | null): string {
  if (!iso) return "—"
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString()
}

function PlacementRow({ entry }: { entry: PlacementLedgerEntry }) {
  return (
    <tr
      className="border-b border-[var(--separator)] last:border-b-0"
      style={{ opacity: entry.enabled ? 1 : 0.55 }}
    >
      <td className="px-[var(--space-3)] py-[var(--space-2)] align-top">
        <div className="font-[var(--weight-semibold)] text-[var(--text-primary)]">{entry.id}</div>
        <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          {entry.connector} · {entry.workspaceId} / {entry.channelId}
        </div>
        <div className="mt-[var(--space-1)] flex flex-wrap gap-[var(--space-1)]">
          {!entry.enabled && <GapBadge label="disabled" tone="red" />}
          {!entry.owner && <GapBadge label="owner未設定" tone="orange" />}
          {!entry.purpose && <GapBadge label="purpose未設定" tone="orange" />}
          {!entry.budgetTracked && <GapBadge label="budget対象外" tone="orange" />}
        </div>
      </td>
      <td className="px-[var(--space-3)] py-[var(--space-2)] align-top text-[var(--text-secondary)]">
        <div>{entry.owner ?? "—"}</div>
        <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{entry.purpose ?? "—"}</div>
      </td>
      <td className="px-[var(--space-3)] py-[var(--space-2)] align-top text-[var(--text-secondary)]">
        <div>{entry.employee ?? "—"}</div>
        <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{entry.defaultModel ?? "既定モデル"}</div>
      </td>
      <td className="px-[var(--space-3)] py-[var(--space-2)] align-top text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
        <div>audience: {entry.audienceType} ({entry.allowedUserCount})</div>
        <div>
          mcp:{" "}
          {entry.mcp === false
            ? "deny"
            : entry.mcp
              .map((server) =>
                server.rejected
                  ? `${server.name} (read-only指定・カタログ分類なし→拒否)`
                  : server.mode === "read-only"
                    ? `${server.name} (read-only)`
                    : server.name,
              )
              .join(", ") || "deny"}
        </div>
        <div>tools: {entry.gatewayTools.join(", ") || "—"}</div>
        <div>delivery: {entry.deliveryTargets.join(", ")}</div>
      </td>
      <td className="px-[var(--space-3)] py-[var(--space-2)] align-top text-right tabular-nums">
        <div className="font-[var(--weight-semibold)] text-[var(--text-primary)]">{formatCost(entry.monthlyCost)}</div>
        <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{entry.monthlySessions} sessions</div>
        {entry.monthlyBudgetUsd !== null ? (
          <div
            className="text-[length:var(--text-caption1)]"
            style={{
              color:
                (entry.budgetPercent ?? 0) >= 100
                  ? "var(--system-red)"
                  : (entry.budgetPercent ?? 0) >= 80
                    ? "var(--system-orange)"
                    : "var(--text-tertiary)",
            }}
          >
            上限 {formatCost(entry.monthlyBudgetUsd)} ({entry.budgetPercent}%)
          </div>
        ) : (
          <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">上限なし</div>
        )}
      </td>
      <td className="px-[var(--space-3)] py-[var(--space-2)] align-top text-[length:var(--text-caption1)] text-[var(--text-tertiary)] whitespace-nowrap">
        {formatLastActivity(entry.lastActivity)}
      </td>
    </tr>
  )
}

export default function PlacementsPage() {
  useBreadcrumbs([{ label: "Placements" }])
  const [ledger, setLedger] = useState<PlacementLedger | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    setRefreshing(true)
    setError(null)
    api
      .getPlacements()
      .then(setLedger)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load placements"))
      .finally(() => {
        setLoading(false)
        setRefreshing(false)
      })
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return (
    <PageLayout>
      <div className="h-full flex flex-col overflow-hidden animate-fade-in bg-[var(--bg)]">
        <header className="flex items-center justify-between px-[var(--space-6)] py-[var(--space-4)] border-b border-[var(--separator)]">
          <div>
            <h1 className="text-[length:var(--text-title2)] font-[var(--weight-bold)] text-[var(--text-primary)]">
              Placements
            </h1>
            <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
              エージェント台帳 — 所有者・目的・権限・当月コスト・kill switch状態
            </p>
          </div>
          <button
            onClick={refresh}
            className="flex items-center gap-[var(--space-1)] rounded-[var(--radius-sm)] border border-[var(--separator)] px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--text-caption1)] text-[var(--text-secondary)] hover:bg-[var(--material-regular)]"
          >
            <RefreshCw size={12} className={refreshing ? "animate-spin" : undefined} />
            更新
          </button>
        </header>

        <div className="flex-1 overflow-auto px-[var(--space-6)] py-[var(--space-4)]">
          {loading && <div className="text-[var(--text-tertiary)]">Loading…</div>}
          {error && <div className="text-[var(--system-red)]">{error}</div>}
          {!loading && !error && ledger && (
            <>
              {ledger.placements.length === 0 ? (
                <div className="text-[var(--text-tertiary)]">
                  placementsが未設定です（legacy単一配置モード）。
                </div>
              ) : (
                <div className="rounded-[var(--radius-md)] border border-[var(--separator)] overflow-x-auto">
                  <table className="w-full text-[length:var(--text-footnote)]">
                    <thead>
                      <tr className="border-b border-[var(--separator)] text-left text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                        <th className="px-[var(--space-3)] py-[var(--space-2)] font-[var(--weight-medium)]">Placement</th>
                        <th className="px-[var(--space-3)] py-[var(--space-2)] font-[var(--weight-medium)]">Owner / Purpose</th>
                        <th className="px-[var(--space-3)] py-[var(--space-2)] font-[var(--weight-medium)]">Agent</th>
                        <th className="px-[var(--space-3)] py-[var(--space-2)] font-[var(--weight-medium)]">Capabilities</th>
                        <th className="px-[var(--space-3)] py-[var(--space-2)] font-[var(--weight-medium)] text-right">当月コスト</th>
                        <th className="px-[var(--space-3)] py-[var(--space-2)] font-[var(--weight-medium)]">最終利用</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ledger.placements.map((entry) => (
                        <PlacementRow key={entry.id} entry={entry} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="mt-[var(--space-4)] grid gap-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                <div>
                  placement未紐付けコスト（当月）: {formatCost(ledger.unplaced.monthlyCost)} / {ledger.unplaced.monthlySessions} sessions
                </div>
                {ledger.orphanCosts.length > 0 && (
                  <div>
                    設定から削除済みのplacementに紐づくコスト:{" "}
                    {ledger.orphanCosts.map((row) => `${row.placementId} (${formatCost(row.cost)})`).join(", ")}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </PageLayout>
  )
}
