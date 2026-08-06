import { describe, expect, it } from "vitest";
import type { JinnConfig } from "../../shared/types.js";
import { buildSettingsTopology, buildSlackTopologyProbePlan, type SlackRuntimeSnapshot } from "../settings-topology.js";

const config = {
  gateway: { host: "127.0.0.1", port: 7777 },
  engines: { default: "claude" },
  logging: { file: false, stdout: true, level: "info" },
  connectors: {
    slack: {
      appToken: "xapp-secret",
      botToken: "xoxb-secret",
      appTokenEnv: "SLACK_APP_TOKEN",
      allowFrom: ["U1", "U2"],
      respondTo: { im: "never", channel: "mention" },
      settingsHome: { enabled: true, webBaseUrl: "https://mana.example.com" },
      meetingMinutesPipeline: {
        enabled: true,
        routerChannels: ["C_ROUTER"],
        destinations: [{ projectId: "p1", name: "Project One", channelId: "C_PRIMARY" }],
        shareDestinations: [{
          shareId: "share-1",
          projectId: "p1",
          name: "Project One Archive",
          connectorInstanceId: "slack-archive",
          workspaceId: "T_ARCHIVE",
          channelId: "C_SHARE",
        }],
      },
    },
    instances: [{
      id: "slack-archive",
      type: "slack",
      employee: "archivist",
      appTokenEnv: "ARCHIVE_APP_TOKEN",
      botTokenEnv: "ARCHIVE_BOT_TOKEN",
      allowFrom: "U1",
      settingsHome: { enabled: true, webBaseUrl: "https://mana.example.com" },
    }],
  },
} as unknown as JinnConfig;

describe("buildSettingsTopology", () => {
  it("assigns router/primary probes to the source and share probes to the named target", () => {
    expect(buildSlackTopologyProbePlan(config)).toEqual([
      {
        instanceId: "slack",
        targets: [
          { channelId: "C_ROUTER" },
          { channelId: "C_PRIMARY" },
        ],
      },
      {
        instanceId: "slack-archive",
        targets: [{ channelId: "C_SHARE", workspaceId: "T_ARCHIVE" }],
      },
    ]);
  });

  it("projects source-local and cross-workspace direct routes onto their exact connectors", () => {
    const result = buildSettingsTopology({
      config,
      observedAt: "2026-08-02T00:00:00.000Z",
      runtimeSnapshots: new Map<string, SlackRuntimeSnapshot>([
        ["slack", { instanceId: "slack", health: "healthy", workspaceId: "T_PRIMARY", checkedAt: "2026-08-01T23:59:00.000Z", channels: {} }],
        ["slack-archive", { instanceId: "slack-archive", health: "healthy", workspaceId: "T_ARCHIVE", checkedAt: "2026-08-01T23:59:00.000Z", channels: {} }],
      ]),
      history: [],
    });

    expect(result.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "primary", sourceConnectorInstanceId: "slack", destinationConnectorInstanceId: "slack", projectId: "p1", channelId: "C_PRIMARY" }),
      expect.objectContaining({ kind: "primary", sourceConnectorInstanceId: "slack", destinationConnectorInstanceId: "slack-archive", projectId: "p1", workspaceId: "T_ARCHIVE", channelId: "C_SHARE" }),
    ]));
    expect(result.connectors).toEqual(expect.arrayContaining([
      expect.objectContaining({ instanceId: "slack", allowlistedOperatorCount: 2 }),
      expect.objectContaining({ instanceId: "slack-archive", allowlistedOperatorCount: 1 }),
    ]));
  });

  it("retains routes and reports stable unconfirmed/error reasons when runtime evidence is absent", () => {
    const missingTarget = structuredClone(config) as JinnConfig;
    (missingTarget.connectors.instances as unknown[]) = [];
    const result = buildSettingsTopology({ config: missingTarget, observedAt: "2026-08-02T00:00:00.000Z", runtimeSnapshots: new Map(), history: [] });

    expect(result.routes).toHaveLength(2);
    expect(result.routes.find((route) => route.destinationConnectorInstanceId === "slack")?.verification).toMatchObject({ status: "unconfirmed", code: "runtime_snapshot_unavailable" });
    expect(result.routes.find((route) => route.destinationConnectorInstanceId === "slack-archive")?.verification).toMatchObject({ status: "error", code: "target_connector_missing" });
    expect(result.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(["runtime_snapshot_unavailable", "target_connector_missing"]));
  });

  it("reports a declared share target as missing when no live connector resolved", () => {
    const result = buildSettingsTopology({
      config,
      observedAt: "2026-08-02T00:00:00.000Z",
      runtimeSnapshots: new Map(),
      liveConnectorInstanceIds: new Set(["slack"]),
      history: [],
    });

    expect(result.routes.find((route) => route.destinationConnectorInstanceId === "slack-archive")?.verification).toMatchObject({
      status: "error",
      code: "target_connector_missing",
    });
  });

  it("never reuses verified channel evidence while the connector is unhealthy", () => {
    const result = buildSettingsTopology({
      config,
      observedAt: "2026-08-02T00:00:00.000Z",
      runtimeSnapshots: new Map<string, SlackRuntimeSnapshot>([
        ["slack", {
          instanceId: "slack",
          health: "degraded",
          workspaceId: "T_PRIMARY",
          checkedAt: "2026-08-01T23:59:00.000Z",
          channels: {
            C_PRIMARY: {
              channelId: "C_PRIMARY",
              status: "verified",
              code: "channel_ready_by_static_checks",
              checkedAt: "2026-08-01T23:58:00.000Z",
            },
          },
        }],
      ]),
      liveConnectorInstanceIds: new Set(["slack", "slack-archive"]),
      history: [],
    });

    expect(result.routes.find((route) => route.kind === "primary")?.verification).toMatchObject({
      status: "unconfirmed",
      code: "runtime_snapshot_unavailable",
    });
    expect(result.connectors.find((connector) => connector.instanceId === "slack")).toMatchObject({
      health: "degraded",
      healthCode: null,
      healthObservedAt: null,
    });
  });

  it("projects only stable runtime health detail and its observation time", () => {
    const result = buildSettingsTopology({
      config,
      runtimeSnapshots: new Map<string, SlackRuntimeSnapshot>([["slack", {
        instanceId: "slack",
        health: "degraded",
        healthCode: "slack_runtime_unavailable",
        healthObservedAt: "2026-08-02T00:01:00.000Z",
        channels: {},
      }]]),
      history: [],
    });

    expect(result.connectors.find((connector) => connector.instanceId === "slack")).toMatchObject({
      health: "degraded",
      healthCode: "slack_runtime_unavailable",
      healthObservedAt: "2026-08-02T00:01:00.000Z",
    });
  });

  it("fails closed when a declared cross-workspace target has channel evidence but no authenticated workspace identity", () => {
    const result = buildSettingsTopology({
      config,
      observedAt: "2026-08-02T00:00:00.000Z",
      runtimeSnapshots: new Map<string, SlackRuntimeSnapshot>([
        ["slack", { instanceId: "slack", health: "healthy", workspaceId: "T_PRIMARY", workspaceName: "Primary", checkedAt: "2026-08-01T23:59:00.000Z", channels: { C_ROUTER: { channelId: "C_ROUTER", name: "router", status: "verified", code: "channel_ready_by_static_checks", checkedAt: "2026-08-01T23:59:00.000Z" } } }],
        ["slack-archive", { instanceId: "slack-archive", health: "healthy", checkedAt: "2026-08-01T23:59:00.000Z", channels: { C_SHARE: { channelId: "C_SHARE", name: "archive", status: "verified", code: "channel_ready_by_static_checks", checkedAt: "2026-08-01T23:59:00.000Z" } } }],
      ]),
      history: [],
    });

    const share = result.routes.find((route) => route.destinationConnectorInstanceId === "slack-archive");
    expect(share).toMatchObject({
      sourceWorkspaceId: "T_PRIMARY",
      sourceWorkspaceName: "Primary",
      workspaceId: "T_ARCHIVE",
      verification: { status: "unconfirmed", code: "workspace_identity_unavailable" },
      routerChannelDetails: [expect.objectContaining({ channelId: "C_ROUTER", channelName: "router", verification: expect.objectContaining({ status: "verified" }) })],
    });
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "workspace_identity_unavailable", targetId: "C_SHARE" }));
  });

  it("serializes only allowlisted history metadata and never config credentials or env names", () => {
    const result = buildSettingsTopology({
      config,
      observedAt: "2026-08-02T00:00:00.000Z",
      runtimeSnapshots: new Map(),
      history: [{
        ts: "2026-08-01T12:00:00.000Z",
        source: "api/config",
        file: "config.yaml",
        snapshot: "secret-snapshot.yaml",
        operatorAuthenticated: true,
      }],
    });
    const serialized = JSON.stringify(result);

    expect(result.history).toEqual([{ ts: "2026-08-01T12:00:00.000Z", source: "api/config", file: "config.yaml", operatorAuthenticated: true }]);
    expect(serialized).not.toMatch(/xapp-secret|xoxb-secret|SLACK_APP_TOKEN|ARCHIVE_BOT_TOKEN|secret-snapshot/);
    expect(serialized).not.toMatch(/botToken|appToken|password|credential|Env/);
  });

  it.each([
    "https://user:pass@mana.example.com",
    "http://mana.example.com",
    "javascript:alert(1)",
    "not a url",
  ])("treats an unsafe settings URL as unconfigured: %s", (webBaseUrl) => {
    const unsafe = structuredClone(config) as JinnConfig;
    unsafe.connectors!.slack!.settingsHome = { enabled: true, webBaseUrl };

    const result = buildSettingsTopology({ config: unsafe, history: [] });
    const connector = result.connectors.find((item) => item.instanceId === "slack");

    expect(connector?.settingsEntryEnabled).toBe(false);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "settings_url_unconfigured",
      targetId: "slack",
    }));
    expect(JSON.stringify(result)).not.toContain(webBaseUrl);
  });
});
