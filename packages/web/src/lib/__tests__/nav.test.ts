import { describe, expect, it } from "vitest"
import { NAV_ITEMS, isNavItemActive } from "../nav"

describe("settings navigation", () => {
  it("keeps edit settings and read-only topology reachable with one active item", () => {
    expect(NAV_ITEMS.map((item) => item.href)).toEqual(expect.arrayContaining(["/settings", "/settings/topology"]))
    for (const pathname of ["/settings", "/settings/topology", "/settings/meeting-minutes"]) {
      expect(NAV_ITEMS.filter((item) => isNavItemActive(pathname, item.href, NAV_ITEMS))).toHaveLength(1)
    }
    expect(isNavItemActive("/settings/topology", "/settings/topology", NAV_ITEMS)).toBe(true)
    expect(isNavItemActive("/settings/topology", "/settings", NAV_ITEMS)).toBe(false)
  })
})
