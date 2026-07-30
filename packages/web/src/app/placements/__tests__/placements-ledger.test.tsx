import { describe, expect, it, vi } from "vitest"
import { render, waitFor } from "@testing-library/react"
import type { PlacementLedger } from "@/lib/api"

const ledger: PlacementLedger = {
  placements: [
    {
      id: "mana-ops", connector: "slack", workspaceId: "T1", channelId: "C1",
      owner: "U0KSATO", purpose: "brainbase運用のoperator対話", enabled: true,
      audienceType: "operator", allowedUserCount: 1, employee: "ryoko",
      defaultModel: "sonnet", budgetTracked: true, mcp: ["brainbase"],
      gatewayTools: ["send_message"], deliveryTargets: ["slack:C1"],
      monthlyCost: 2.5, monthlySessions: 3, lastActivity: "2026-07-30T00:00:00.000Z",
    },
    {
      id: "legacy-experiment", connector: "slack", workspaceId: "T1", channelId: "C9",
      owner: null, purpose: null, enabled: false,
      audienceType: "project-team", allowedUserCount: 0, employee: null,
      defaultModel: null, budgetTracked: false, mcp: false,
      gatewayTools: [], deliveryTargets: ["slack:C9"],
      monthlyCost: 0, monthlySessions: 0, lastActivity: null,
    },
  ],
  unplaced: { monthlyCost: 0.5, monthlySessions: 1, lastActivity: null },
  orphanCosts: [{ placementId: "removed", cost: 1.0, sessions: 1, lastActivity: null }],
}

const { getPlacements } = vi.hoisted(() => ({
  getPlacements: vi.fn(),
}))

vi.mock("@/lib/api", () => ({ api: { getPlacements } }))
vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock("@/context/breadcrumb-context", () => ({ useBreadcrumbs: () => {} }))

import PlacementsPage from "../page"

describe("Placements ledger view", () => {
  it("renders gap badges for missing owner/purpose, untracked budget, and disabled kill switch", async () => {
    getPlacements.mockResolvedValue(ledger)
    const { getByText, queryByText } = render(<PlacementsPage />)

    await waitFor(() => expect(getByText("mana-ops")).toBeTruthy())
    expect(getByText("legacy-experiment")).toBeTruthy()
    expect(getByText("disabled")).toBeTruthy()
    expect(getByText("owner未設定")).toBeTruthy()
    expect(getByText("purpose未設定")).toBeTruthy()
    expect(getByText("budget対象外")).toBeTruthy()
    expect(getByText("U0KSATO")).toBeTruthy()
    expect(getByText("brainbase運用のoperator対話")).toBeTruthy()
    expect(getByText("$2.50")).toBeTruthy()
    expect(queryByText("placementsが未設定です（legacy単一配置モード）。")).toBeNull()
    expect(getByText(/placement未紐付けコスト（当月）: \$0\.50 \/ 1 sessions/)).toBeTruthy()
    expect(getByText(/removed \(\$1\.00\)/)).toBeTruthy()
  })

  it("shows the operator authorization error state instead of ledger data on denial", async () => {
    getPlacements.mockRejectedValue(new Error("operator authorization required"))
    const { getByText, queryByText } = render(<PlacementsPage />)

    await waitFor(() => expect(getByText("operator authorization required")).toBeTruthy())
    expect(queryByText("mana-ops")).toBeNull()
  })

  it("shows the legacy empty state when no placements are configured", async () => {
    getPlacements.mockResolvedValue({ placements: [], unplaced: { monthlyCost: 0, monthlySessions: 0, lastActivity: null }, orphanCosts: [] })
    const { getByText } = render(<PlacementsPage />)

    await waitFor(() => expect(getByText("placementsが未設定です（legacy単一配置モード）。")).toBeTruthy())
  })
})
