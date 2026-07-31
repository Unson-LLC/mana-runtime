import { describe, expect, it } from "vitest";
import { resolveRouteOptions } from "../server.js";
import type { Employee, IncomingMessage, JinnConfig } from "../../shared/types.js";

const BASE_CONFIG = {
  gateway: { port: 7777, host: "127.0.0.1" },
  engines: { default: "claude", claude: { bin: "claude", model: "sonnet" } },
  connectors: {},
  logging: { level: "info", stdout: false, file: "" },
} as unknown as JinnConfig;

const AUTO_PLACEMENT = {
  id: "auto-C1",
  connector: "slack",
  workspaceId: "T1",
  channelId: "C1",
  owner: "U42",
  purpose: "auto-provisioned (invited by U42)",
  audience: { type: "channel-members" as const },
};

function msg(channel = "C1", user = "U_ANY"): IncomingMessage {
  return {
    source: "slack",
    connector: "slack",
    sessionKey: `slack:${channel}`,
    channel,
    user,
    userId: user,
    text: "hello",
    attachments: [],
    raw: {},
    transportMeta: { team: "T1" },
  } as unknown as IncomingMessage;
}

const EMPLOYEES = new Map<string, Employee>();

describe("resolveRouteOptions with a channel-members placement", () => {
  const cfg = { ...BASE_CONFIG, placements: [AUTO_PLACEMENT] } as JinnConfig;

  it("passes channel membership through to placement resolution", () => {
    const opts = resolveRouteOptions(cfg, msg(), EMPLOYEES, undefined, undefined, "member");
    expect(opts?.placement?.id).toBe("auto-C1");
  });

  it.each([
    ["non-member", "non-member" as const],
    ["unknown (API failure)", "unknown" as const],
    ["absent (connector without membership support)", undefined],
  ])("fails closed when membership is %s", (_label, membership) => {
    expect(resolveRouteOptions(cfg, msg(), EMPLOYEES, undefined, undefined, membership)).toBeUndefined();
  });

  it("keeps static-audience placements unaffected by the membership argument", () => {
    const staticCfg = {
      ...BASE_CONFIG,
      placements: [{ ...AUTO_PLACEMENT, audience: { type: "operator" as const, allowedUsers: ["U1"] } }],
    } as JinnConfig;
    expect(resolveRouteOptions(staticCfg, msg("C1", "U1"), EMPLOYEES)?.placement?.id).toBe("auto-C1");
    expect(resolveRouteOptions(staticCfg, msg("C1", "U9"), EMPLOYEES, undefined, undefined, "member")).toBeUndefined();
  });
});
