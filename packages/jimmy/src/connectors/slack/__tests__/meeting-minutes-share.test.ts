import { beforeEach, describe, expect, it, vi } from "vitest";

const bolt = vi.hoisted(() => {
  const apiCall = vi.fn();
  return {
    apiCall,
    client: {
      auth: { test: vi.fn(async () => ({ user_id: "U_BOT" })) },
      apiCall,
    },
  };
});

vi.mock("@slack/bolt", () => ({
  App: class MockSlackApp {
    client = bolt.client;
    message() {}
    command() {}
    event() {}
    action() {}
    view() {}
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
  },
}));

import { SlackConnector } from "../index.js";
import type { MeetingMinutesShareRequest } from "../meeting-minutes-pipeline.js";

const REQUEST: MeetingMinutesShareRequest = {
  sourceConnectorInstanceId: "slack",
  destination: {
    shareId: "baao-business",
    projectId: "proj_baao",
    name: "事業運営 / BAAO",
    connectorInstanceId: "slack-biz",
    workspaceId: "T_BIZ",
    channelId: "C_BIZ_BAAO",
  },
  minutes: {
    title: "定例会議",
    overview: "定例会議の概要",
    body: "生成済み議事録本文",
  },
  onProgress: vi.fn(),
};

async function connector(): Promise<SlackConnector> {
  const result = new SlackConnector({
    id: "slack-biz",
    botToken: "xoxb-test",
    appToken: "xapp-test",
  });
  await result.start();
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  bolt.apiCall.mockImplementation(async (method: string) => {
    if (method === "auth.test") return { ok: true, team_id: "T_BIZ" };
    if (method === "conversations.info") {
      return { channel: { id: "C_BIZ_BAAO", is_member: true, is_archived: false } };
    }
    if (method === "chat.postMessage") return { ok: true, ts: "9000.1" };
    return { ok: true };
  });
});

describe("SlackConnector.postSharedMeetingMinutes", () => {
  it("posts overview and generated body only after identity and membership checks", async () => {
    const target = await connector();
    await expect(target.postSharedMeetingMinutes(REQUEST)).resolves.toEqual({ parentTs: "9000.1" });

    expect(bolt.apiCall.mock.calls.map(([method]) => method)).toEqual([
      "auth.test",
      "conversations.info",
      "chat.postMessage",
      "chat.postMessage",
    ]);
    expect(JSON.stringify(bolt.apiCall.mock.calls)).not.toContain("RAW_TRANSCRIPT_SENTINEL");
  });

  it.each([
    ["workspace mismatch", "auth.test", { ok: true, team_id: "T_OTHER" }],
    ["auth rejected", "auth.test", { ok: false, team_id: "T_BIZ" }],
    [
      "not a member",
      "conversations.info",
      { channel: { id: "C_BIZ_BAAO", is_member: false, is_archived: false } },
    ],
    [
      "archived",
      "conversations.info",
      { channel: { id: "C_BIZ_BAAO", is_member: true, is_archived: true } },
    ],
  ])("fails closed for %s", async (_label, failingMethod, response) => {
    const target = await connector();
    bolt.apiCall.mockImplementation(async (method: string) => {
      if (method === failingMethod) return response;
      if (method === "auth.test") return { ok: true, team_id: "T_BIZ" };
      if (method === "conversations.info") {
        return { channel: { id: "C_BIZ_BAAO", is_member: true, is_archived: false } };
      }
      return { ok: true, ts: "unexpected" };
    });

    await expect(target.postSharedMeetingMinutes(REQUEST)).rejects.toThrow();
    expect(bolt.apiCall.mock.calls.some(([method]) => method === "chat.postMessage")).toBe(false);
  });

  it("reports an untracked target thread post as a partial failure", async () => {
    const target = await connector();
    let posts = 0;
    bolt.apiCall.mockImplementation(async (method: string) => {
      if (method === "auth.test") return { ok: true, team_id: "T_BIZ" };
      if (method === "conversations.info") {
        return { channel: { id: "C_BIZ_BAAO", is_member: true, is_archived: false } };
      }
      if (method === "chat.postMessage") {
        posts += 1;
        return posts === 1 ? { ok: true, ts: "9000.1" } : { ok: true };
      }
      return { ok: true };
    });

    await expect(target.postSharedMeetingMinutes(REQUEST)).rejects.toThrow(
      "thread post returned no timestamp",
    );
    expect(posts).toBe(2);
  });
});
