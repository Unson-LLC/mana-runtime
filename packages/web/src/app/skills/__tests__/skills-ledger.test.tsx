import { describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"

const { getSkills } = vi.hoisted(() => ({
  getSkills: vi.fn().mockResolvedValue([
    {
      name: "salestailor-sync",
      description: "SalesTailor専用の同期手順",
      requiredMcp: ["nocodb", "brainbase"],
      requiredTools: [],
      scope: "salestailor",
    },
    {
      name: "legacy-skill",
      description: "旧来のスキル",
      requiredMcp: [],
      requiredTools: [],
    },
  ]),
}))

vi.mock("@/lib/api", () => ({ api: { getSkills, getSkill: vi.fn() } }))
vi.mock("@/app/settings-provider", () => ({ useSettings: () => ({ settings: {} }) }))
vi.mock("@/context/breadcrumb-context", () => ({ useBreadcrumbs: () => {} }))
vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

import SkillsPage from "../page"

// SKILLVIS-STORY-S-001: the skills ledger view shows scope and requiredMcp
// columns so a skill's visibility boundary is auditable at a glance.
describe("skills ledger view", () => {
  it("renders scope and requiredMcp as ledger columns for every skill", async () => {
    render(<SkillsPage />)
    await waitFor(() => expect(getSkills).toHaveBeenCalled())

    expect(await screen.findByRole("columnheader", { name: "scope" })).toBeTruthy()
    expect(screen.getByRole("columnheader", { name: "requiredMcp" })).toBeTruthy()

    const scopedRow = (await screen.findByText("salestailor-sync")).closest("tr")!
    expect(scopedRow.textContent).toContain("salestailor")
    expect(scopedRow.textContent).toContain("nocodb, brainbase")

    // Undeclared skills read as global with no MCP requirement.
    const legacyRow = screen.getByText("legacy-skill").closest("tr")!
    expect(legacyRow.textContent).toContain("global")
    expect(legacyRow.textContent).toContain("—")
  })
})
