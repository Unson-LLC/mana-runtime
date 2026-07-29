import { describe, expect, it } from "vitest";
import type { JinnConfig } from "../../shared/types.js";
import { buildSlackConnectorContext } from "../server.js";

describe("buildSlackConnectorContext", () => {
  it("projects development runner policy into Slack connector context", () => {
    const config = {
      portal: { portalName: "Pilot Ryoko", operatorName: "Operator", operatorAliases: ["owner"] },
      engines: { default: "claude" },
      developmentRunner: { enabled: true, allowedSlackChannels: ["C0A2L9FEKEJ"] },
    } as JinnConfig;

    expect(buildSlackConnectorContext(config, true)).toEqual({
      portalName: "Pilot Ryoko",
      operatorName: "Operator",
      operatorAliases: ["owner"],
      goalInjectionEnabled: true,
      developmentRunnerEnabled: true,
      developmentRunnerAllowedChannels: ["C0A2L9FEKEJ"],
    });
  });

  it("fails closed when development runner policy is absent", () => {
    const config = { engines: { default: "claude" } } as JinnConfig;
    expect(buildSlackConnectorContext(config, false)).toMatchObject({
      goalInjectionEnabled: false,
      developmentRunnerEnabled: false,
      developmentRunnerAllowedChannels: undefined,
    });
  });
});
