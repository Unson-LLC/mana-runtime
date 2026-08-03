import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ usePathname: () => "/settings/topology" }))
vi.mock("@/app/settings-provider", () => ({
  useSettings: () => ({ settings: { portalEmoji: "🧞", portalName: "Ryoko" } }),
}))
vi.mock("@/context/breadcrumb-context", () => ({ useBreadcrumbs: () => ({ items: [] }) }))
vi.mock("@/lib/nav", () => ({ NAV_ITEMS: [], isNavItemActive: () => false }))
vi.mock("@/components/sidebar", () => ({ Sidebar: () => null }))
vi.mock("@/components/global-search", () => ({ GlobalSearch: () => null }))
vi.mock("@/components/live-stream-widget", () => ({ LiveStreamWidget: () => null }))
vi.mock("@/components/onboarding-wizard", () => ({
  OnboardingWizard: () => <div data-testid="onboarding-wizard" />,
}))
vi.mock("@/components/notifications/notification-bell", () => ({ NotificationBell: () => null }))
vi.mock("@/components/notifications/toast-container", () => ({ ToastContainer: () => null }))
vi.mock("@/components/breadcrumb-bar", () => ({ BreadcrumbBar: () => null }))

import { PageLayout } from "../page-layout"

describe("PageLayout", () => {
  afterEach(cleanup)

  it("shows onboarding by default", () => {
    render(<PageLayout><div>content</div></PageLayout>)

    expect(screen.getByTestId("onboarding-wizard")).toBeTruthy()
  })

  it("can suppress onboarding for operator-only views", () => {
    render(<PageLayout suppressOnboarding><div>content</div></PageLayout>)

    expect(screen.queryByTestId("onboarding-wizard")).toBeNull()
  })
})
