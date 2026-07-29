import { describe, expect, it, vi } from "vitest"
import { render, waitFor } from "@testing-library/react"
import { OPERATOR_AUTH_CHANGED_EVENT } from "@/lib/operator-auth"

const { getInstances } = vi.hoisted(() => ({
  getInstances: vi.fn().mockResolvedValue([]),
}))

vi.mock("next/navigation", () => ({ usePathname: () => "/settings" }))
vi.mock("@/app/providers", () => ({ useTheme: () => ({ theme: "light", setTheme: vi.fn() }) }))
vi.mock("@/app/settings-provider", () => ({ useSettings: () => ({ settings: {} }) }))
vi.mock("@/lib/api", () => ({ api: { getInstances } }))

import { Sidebar } from "../sidebar"

describe("Sidebar operator auth refresh", () => {
  it("refetches protected instances when the operator token changes", async () => {
    render(<Sidebar />)
    await waitFor(() => expect(getInstances).toHaveBeenCalledTimes(1))

    window.dispatchEvent(new Event(OPERATOR_AUTH_CHANGED_EVENT))

    await waitFor(() => expect(getInstances).toHaveBeenCalledTimes(2))
  })
})
