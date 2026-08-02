import { describe, expect, it } from "vitest";
import type { JinnConfig } from "../../shared/types.js";
import type { Connector } from "../../shared/types.js";
import { SlackConnector } from "../../connectors/slack/index.js";
import {
  buildSlackConnectorContext,
  createMeetingMinutesShareGateway,
} from "../server.js";

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

describe("createMeetingMinutesShareGateway", () => {
  const request = {
    sourceConnectorInstanceId: "slack",
    destination: {
      shareId: "baao-business",
      projectId: "proj_baao",
      name: "BAAO business",
      connectorInstanceId: "slack-biz",
      workspaceId: "T_BIZ",
      channelId: "C_BIZ",
    },
    minutes: { title: "定例", overview: "概要", body: "本文" },
    onProgress: () => {},
  };

  it("calls only the exact configured Slack connector instance", async () => {
    const exact = Object.create(SlackConnector.prototype) as SlackConnector;
    exact.postSharedMeetingMinutes = async () => ({ parentTs: "9000.1" });
    const other = Object.create(SlackConnector.prototype) as SlackConnector;
    let otherCalled = false;
    other.postSharedMeetingMinutes = async () => {
      otherCalled = true;
      return { parentTs: "wrong" };
    };
    const gateway = createMeetingMinutesShareGateway(
      new Map<string, Connector>([
        ["slack-biz", exact as unknown as Connector],
        ["slack-other", other as unknown as Connector],
      ]),
    );

    await expect(gateway(request)).resolves.toEqual({ parentTs: "9000.1" });
    expect(otherCalled).toBe(false);
  });

  it("never falls back for missing, non-Slack, or same-instance targets", async () => {
    const gateway = createMeetingMinutesShareGateway(new Map<string, Connector>());
    await expect(gateway(request)).rejects.toThrow("not found");
    await expect(
      gateway({
        ...request,
        sourceConnectorInstanceId: "slack-biz",
      }),
    ).rejects.toThrow("different target connector");
  });
});
