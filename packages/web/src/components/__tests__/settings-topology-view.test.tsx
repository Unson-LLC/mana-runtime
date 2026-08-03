import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getSettingsTopology: vi.fn(),
  operatorToken: vi.fn<() => string | undefined>(),
  storeOperatorToken: vi.fn(),
  token: undefined as string | undefined,
}))

vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("@/lib/operator-auth", () => ({ operatorToken: () => mocks.token, storeOperatorToken: mocks.storeOperatorToken }))
vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error { constructor(message: string, public status: number) { super(message) } },
  api: { getSettingsTopology: mocks.getSettingsTopology },
}))

import { SettingsTopologyViewPage } from "../settings-topology-view"
import { ApiError } from "@/lib/api"

const topology = {
  schemaVersion: 1 as const,
  observedAt: "2026-08-02T00:00:00.000Z",
  connectors: [],
  routes: [{
    id: "primary:slack-a:project-a",
    kind: "primary" as const,
    sourceConnectorInstanceId: "slack-a",
    sourceWorkspaceId: "T-A",
    sourceWorkspaceName: "Workspace A",
    routerChannels: ["C-ROUTER"],
    routerChannelDetails: [{
      channelId: "C-ROUTER",
      channelName: "minutes-router",
      verification: { status: "verified" as const, code: "channel_ready_by_static_checks", checkedAt: "2026-08-02T00:00:00.000Z" },
    }],
    destinationConnectorInstanceId: "slack-a",
    workspaceId: "T-A",
    workspaceName: "Workspace A",
    projectId: "project-a",
    projectName: "Project A",
    channelId: "C-A",
    channelName: "project-a",
    verification: { status: "verified" as const, code: "channel_ready_by_static_checks", checkedAt: "2026-08-02T00:00:00.000Z" },
  }],
  warnings: [],
  history: [],
  summary: { connectorCount: 1, routeCount: 1, warningCount: 0 },
}

describe("SettingsTopologyViewPage", () => {
  afterEach(cleanup)

  beforeEach(() => {
    mocks.getSettingsTopology.mockReset()
    mocks.operatorToken.mockReset()
    mocks.storeOperatorToken.mockReset()
    mocks.storeOperatorToken.mockImplementation((value: string) => { mocks.token = value })
    mocks.token = undefined
    window.history.replaceState({}, "", "/settings/topology")
  })

  it("does not fetch protected topology until a token is entered", async () => {
    mocks.getSettingsTopology.mockResolvedValue(topology)
    render(<SettingsTopologyViewPage view="topology" />)

    expect((screen.getByLabelText("Operator Token") as HTMLInputElement).type).toBe("password")
    expect(mocks.getSettingsTopology).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText("Operator Token"), { target: { value: "operator-token" } })
    fireEvent.click(screen.getByRole("button", { name: "Tokenを保存して再取得" }))

    expect(mocks.storeOperatorToken).toHaveBeenCalledWith("operator-token")
    await waitFor(() => expect(mocks.getSettingsTopology).toHaveBeenCalledTimes(1))
    expect(screen.getAllByRole("link")).toHaveLength(5)
  })

  it("highlights the route selected by safe deep-link query fields", async () => {
    mocks.token = "operator-token"
    mocks.getSettingsTopology.mockResolvedValue(topology)
    window.history.replaceState({}, "", "/settings/meeting-minutes?workspace=T-A&project=project-a&channel=C-A")
    render(<SettingsTopologyViewPage view="minutes" />)

    const heading = await screen.findByRole("heading", { name: /^Project A/ })
    expect(heading.closest("article")?.className).toContain("border-[var(--accent)]")
    expect(screen.queryByRole("button", { name: /編集|保存|適用/ })).toBeNull()
  })

  it("does not highlight a route when no safe deep-link selection is present", async () => {
    mocks.token = "operator-token"
    mocks.getSettingsTopology.mockResolvedValue(topology)
    render(<SettingsTopologyViewPage view="topology" />)

    const heading = await screen.findByRole("heading", { name: /^Project A/ })
    expect(heading.closest("article")?.className).not.toContain("border-[var(--accent)]")
  })

  it("shows an explicit fallback when a safe deep-link target is unknown", async () => {
    mocks.token = "operator-token"
    mocks.getSettingsTopology.mockResolvedValue(topology)
    window.history.replaceState({}, "", "/settings/meeting-minutes?workspace=T-X&project=missing&channel=C-X")
    render(<SettingsTopologyViewPage view="minutes" />)

    const fallback = await screen.findByText(/現在の構成に見つかりません/)
    expect(fallback.getAttribute("role")).toBe("status")
    expect(await screen.findByRole("heading", { name: /^Project A/ })).toBeTruthy()
  })

  it("clears protected data on 403 and preserves the safe query through re-authentication", async () => {
    mocks.token = "operator-token"
    mocks.getSettingsTopology.mockResolvedValue(topology)
    window.history.replaceState({}, "", "/settings/meeting-minutes?workspace=T-A&project=project-a&channel=C-A")
    render(<SettingsTopologyViewPage view="minutes" />)
    expect(await screen.findByRole("heading", { name: /^Project A/ })).toBeTruthy()

    mocks.getSettingsTopology.mockRejectedValueOnce(new ApiError("forbidden", 403))
    fireEvent.click(screen.getByRole("button", { name: "構成情報を再取得" }))

    expect(await screen.findByRole("heading", { name: "Operator認証が必要です" })).toBeTruthy()
    expect(screen.queryByRole("heading", { name: /^Project A/ })).toBeNull()

    mocks.getSettingsTopology.mockResolvedValueOnce(topology)
    fireEvent.change(screen.getByLabelText("Operator Token"), { target: { value: "replacement-token" } })
    fireEvent.click(screen.getByRole("button", { name: "Tokenを保存して再取得" }))

    const heading = await screen.findByRole("heading", { name: /^Project A/ })
    expect(mocks.storeOperatorToken).toHaveBeenCalledWith("replacement-token")
    expect(window.location.pathname + window.location.search).toBe("/settings/meeting-minutes?workspace=T-A&project=project-a&channel=C-A")
    expect(heading.closest("article")?.className).toContain("border-[var(--accent)]")
  })

  it("shows a retryable error and recovers without retaining stale data", async () => {
    mocks.token = "operator-token"
    mocks.getSettingsTopology.mockRejectedValueOnce(new Error("network unavailable"))
    render(<SettingsTopologyViewPage view="topology" />)

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("構成情報を取得できませんでした")
    expect(alert.textContent).not.toContain("network unavailable")
    expect(screen.queryByRole("heading", { name: /^Project A/ })).toBeNull()

    mocks.getSettingsTopology.mockResolvedValueOnce(topology)
    fireEvent.click(screen.getByRole("button", { name: "再試行" }))
    expect(await screen.findByRole("heading", { name: /^Project A/ })).toBeTruthy()
  })

  it("fails closed before a credential-shaped API value can reach the DOM", async () => {
    mocks.token = "operator-token"
    const secret = "xoxb-super-secret-token"
    mocks.getSettingsTopology.mockResolvedValue({
      ...topology,
      routes: [{ ...topology.routes[0], workspaceName: secret }],
      warnings: [{ code: "probe_failed", severity: "warning", targetId: "C-A", message: `https://bot:${secret}@slack.example.test` }],
    })
    render(<SettingsTopologyViewPage view="topology" />)

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("構成情報を取得できませんでした")
    expect(document.body.textContent).not.toContain(secret)
    expect(screen.queryByRole("heading", { name: /^Project A/ })).toBeNull()
  })

  it.each([
    ["slack", "Slack connector状態", "Slack connectorは設定されていません。"],
    ["permissions", "Slack権限設定", "Slack connectorは設定されていません。"],
    ["history", "構成履歴", "表示できる履歴metadataはありません。"],
  ] as const)("renders the %s empty state with an accessible region", async (view, regionName, emptyText) => {
    mocks.token = "operator-token"
    mocks.getSettingsTopology.mockResolvedValue(topology)
    render(<SettingsTopologyViewPage view={view} />)

    if (view === "history") expect(await screen.findByRole("heading", { name: regionName })).toBeTruthy()
    else expect(await screen.findByRole("region", { name: regionName })).toBeTruthy()
    expect(await screen.findByText(emptyText)).toBeTruthy()
    expect(screen.getByRole("link", { current: "page" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "構成情報を再取得" })).toBeTruthy()
  })

  it("distinguishes runtime health from Slack channel verification", async () => {
    mocks.token = "operator-token"
    mocks.getSettingsTopology.mockResolvedValue({
      ...topology,
      connectors: [{
        instanceId: "slack-a", employee: "mana", workspaceId: "T-A", workspaceName: "Workspace A",
        health: "healthy", healthCode: null, healthObservedAt: topology.observedAt, checkedAt: topology.observedAt, allowlistedOperatorCount: 1,
        settingsEntryEnabled: true, respondTo: { im: "never", mpim: "never", channel: "mention" },
        routerChannels: ["C-ROUTER"], routerChannelDetails: topology.routes[0].routerChannelDetails,
      }],
    })
    render(<SettingsTopologyViewPage view="slack" />)

    expect(await screen.findByText("実行中")).toBeTruthy()
    cleanup()
    window.history.replaceState({}, "", "/settings/topology")
    render(<SettingsTopologyViewPage view="topology" />)
    expect((await screen.findAllByText(/静的確認済み（実投稿未確認）/)).length).toBeGreaterThan(0)
  })

  it("explains Bot response policies in Japanese without presenting them as Slack API permissions", async () => {
    mocks.token = "operator-token"
    mocks.getSettingsTopology.mockResolvedValue({
      ...topology,
      connectors: [{
        instanceId: "slack-a", employee: "mana", workspaceId: "T-A", workspaceName: "Workspace A",
        health: "healthy", healthCode: null, healthObservedAt: topology.observedAt, checkedAt: topology.observedAt,
        allowlistedOperatorCount: 2, settingsEntryEnabled: true,
        respondTo: { im: "never", mpim: "always", channel: "mention" }, routerChannels: [], routerChannelDetails: [],
      }],
    })
    render(<SettingsTopologyViewPage view="permissions" />)

    expect(await screen.findByText(/Slack APIの権限ではなく.*Mana Bot.*応答するかの方針/)).toBeTruthy()
    expect(screen.getByText("操作許可ユーザー")).toBeTruthy()
    expect(screen.getByText("ダイレクトメッセージ")).toBeTruthy()
    expect(screen.getByText("複数人DM")).toBeTruthy()
    expect(screen.getByText("チャンネル")).toBeTruthy()
    expect(screen.getByText("応答しない")).toBeTruthy()
    expect(screen.getByText("常に応答")).toBeTruthy()
    expect(screen.getByText("メンション時のみ応答")).toBeTruthy()
  })

  it.each([
    ["bot_not_member", "Botが対象チャンネルに参加していません", "Botを対象チャンネルに招待"],
    ["channel_archived", "対象チャンネルはアーカイブされています", "有効なチャンネルへ設定を変更"],
    ["workspace_mismatch", "設定したworkspaceとBotの接続先が一致しません", "workspace IDまたはconnector設定を修正"],
    ["permission_denied", "Botにチャンネル確認の権限がありません", "Slackアプリの権限と再インストール状況を確認"],
    ["slack_probe_failed", "Slackへの確認処理が失敗しました", "Slack接続と権限を確認してから再取得"],
  ] as const)("shows cause, action, and an auxiliary diagnostic code for %s", async (code, cause, action) => {
    mocks.token = "operator-token"
    mocks.getSettingsTopology.mockResolvedValue({
      ...topology,
      routes: [{ ...topology.routes[0], verification: { status: "error" as const, code, checkedAt: topology.observedAt } }],
    })
    render(<SettingsTopologyViewPage view="topology" />)

    expect(await screen.findByText(new RegExp(cause))).toBeTruthy()
    expect(screen.getByText(new RegExp(action))).toBeTruthy()
    expect(screen.getByText(`診断コード: ${code}`)).toBeTruthy()
  })

  it("keeps stable IDs, unresolved-name reasons, and verification times visible", async () => {
    mocks.token = "operator-token"
    mocks.getSettingsTopology.mockResolvedValue({
      ...topology,
      routes: [{
        ...topology.routes[0],
        sourceWorkspaceName: null,
        workspaceName: null,
        channelName: null,
        verification: { status: "unconfirmed" as const, code: "runtime_snapshot_unavailable", checkedAt: null },
        routerChannelDetails: [{
          channelId: "C-ROUTER",
          channelName: null,
          verification: { status: "error" as const, code: "bot_not_member", checkedAt: "2026-08-02T00:02:00.000Z" },
        }],
      }],
    })
    render(<SettingsTopologyViewPage view="topology" />)

    expect((await screen.findAllByText(/workspace名称未確認.*T-A/)).length).toBe(2)
    expect(screen.getByText(/channel名称未確認.*C-A/)).toBeTruthy()
    expect(screen.getByText(/名称未確認.*C-ROUTER/)).toBeTruthy()
    expect(screen.getByText(/実行中のconnectorから最新状態を取得できません/)).toBeTruthy()
    expect(screen.getByText(/Botが対象チャンネルに参加していません/)).toBeTruthy()
    expect(screen.getByText("診断コード: runtime_snapshot_unavailable")).toBeTruthy()
    expect(screen.getByText("診断コード: bot_not_member")).toBeTruthy()
    expect(screen.getByText("経路確認: 未実施")).toBeTruthy()
    expect(screen.getByText("確認: 2026-08-02T00:02:00.000Z")).toBeTruthy()
  })

  it("shows a stable runtime failure reason and observation time", async () => {
    mocks.token = "operator-token"
    mocks.getSettingsTopology.mockResolvedValue({
      ...topology,
      connectors: [{
        instanceId: "slack-a", employee: "mana", workspaceId: "T-A", workspaceName: "Workspace A",
        health: "degraded", healthCode: "slack_runtime_unavailable", healthObservedAt: "2026-08-02T00:01:00.000Z",
        checkedAt: null, allowlistedOperatorCount: 1, settingsEntryEnabled: true,
        respondTo: { im: "never", mpim: "never", channel: "mention" }, routerChannels: [], routerChannelDetails: [],
      }],
    })
    render(<SettingsTopologyViewPage view="slack" />)

    expect(await screen.findByText(/Slack connectorが正常に稼働していません/)).toBeTruthy()
    expect(screen.getByText("診断コード: slack_runtime_unavailable")).toBeTruthy()
    expect(screen.getByText("実行状態観測: 2026-08-02T00:01:00.000Z")).toBeTruthy()
  })
})
