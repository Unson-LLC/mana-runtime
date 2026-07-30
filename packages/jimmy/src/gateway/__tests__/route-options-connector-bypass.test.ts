import { describe, expect, it } from "vitest";
import { resolveRouteOptions } from "../server.js";
import type { Employee, IncomingMessage, JinnConfig } from "../../shared/types.js";

const BASE_CONFIG = {
  gateway: { port: 7777, host: "127.0.0.1" },
  engines: { default: "claude", claude: { bin: "claude", model: "sonnet" } },
  connectors: {},
  logging: { level: "info", stdout: false, file: "" },
} as unknown as JinnConfig;

const PLACEMENTS = [
  {
    id: "mana-test",
    connector: "slack",
    workspaceId: "T1",
    channelId: "C1",
    audience: { type: "operator" as const, allowedUsers: ["U1"] },
  },
];

function msg(connector: string, channel = "D1", user = "U1"): IncomingMessage {
  return {
    source: connector,
    connector,
    sessionKey: `${connector}:${channel}`,
    channel,
    user,
    userId: user,
    text: "hello",
    attachments: [],
    raw: {},
  } as unknown as IncomingMessage;
}

const EMPLOYEES = new Map<string, Employee>([
  ["ryoko", { name: "ryoko", engine: "claude" } as unknown as Employee],
]);

describe("resolveRouteOptions connector bypass (gap A-1)", () => {
  it.each(["discord", "telegram", "whatsapp"])(
    "denies a %s message when placements are configured and none matches",
    (connector) => {
      const cfg = { ...BASE_CONFIG, placements: PLACEMENTS } as JinnConfig;
      expect(resolveRouteOptions(cfg, msg(connector), EMPLOYEES)).toBeUndefined();
    },
  );

  it("denies a Slack message outside every configured placement", () => {
    const cfg = { ...BASE_CONFIG, placements: PLACEMENTS } as JinnConfig;
    expect(resolveRouteOptions(cfg, msg("slack", "C-unknown"), EMPLOYEES)).toBeUndefined();
  });

  it("keeps legacy routing (with employee fallback) when no placements are configured", () => {
    const opts = resolveRouteOptions(BASE_CONFIG, msg("discord"), EMPLOYEES, "ryoko");
    expect(opts).toBeDefined();
    expect(opts?.placement).toBeUndefined();
    expect(opts?.employee?.name).toBe("ryoko");
  });
});
