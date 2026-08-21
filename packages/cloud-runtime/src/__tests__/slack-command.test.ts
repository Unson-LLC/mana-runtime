import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleSlackCommandRequest } from "../slack-command.js";
import { MAX_SLACK_REQUEST_BODY_BYTES } from "../slack-request-body.js";
import type { SlackQueueEvent } from "../types.js";

const secret = "secret";
const nowMs = 1_786_680_000_000;
const timestamp = String(nowMs / 1000);
function make(body: string) {
  return new Request("https://runtime.test/slack/commands", {
    method: "POST",
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`,
    },
    body,
  });
}

describe("Slack native development command", () => {
  it("rejects an oversized body without Content-Length before signature verification or queueing", async () => {
    const send = vi.fn();
    const request = new Request("https://runtime.test/slack/commands", {
      method: "POST",
      headers: {
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": "v0=not-a-valid-signature",
      },
      body: "x".repeat(MAX_SLACK_REQUEST_BODY_BYTES + 1),
    });

    const response = await handleSlackCommandRequest(request, {
      signingSecret: secret,
      placements: [{ channelId: "C1", allowedUserIds: ["U1"] }],
      nowMs,
      send,
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "slack_request_body_too_large" });
    expect(send).not.toHaveBeenCalled();
  });

  it("opens the non-engineer improvement form and does not queue a synthetic thread", async () => {
    const send = vi.fn();
    const openModal = vi.fn(async () => undefined);
    const body = new URLSearchParams({
      team_id: "T1",
      channel_id: "C1",
      user_id: "U1",
      command: "/vibepro",
      trigger_id: "tr-modal",
      text: "承認待ちが分かりにくい",
    }).toString();

    const response = await handleSlackCommandRequest(make(body), {
      signingSecret: secret,
      placements: [{ channelId: "C1", allowedUserIds: ["U1"] }],
      nowMs,
      openModal,
      send,
    });

    expect(response.status).toBe(200);
    expect(openModal).toHaveBeenCalledWith({
      workspaceId: "T1",
      channelId: "C1",
      requesterId: "U1",
      triggerId: "tr-modal",
      command: "/vibepro",
      initialProblem: "承認待ちが分かりにくい",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("acknowledges Slack before the modal's external authorization work completes", async () => {
    let completeModal!: () => void;
    const modalWork = new Promise<void>((resolve) => { completeModal = resolve; });
    const defer = vi.fn<(work: Promise<void>) => void>();
    const body = new URLSearchParams({
      team_id: "T1",
      channel_id: "C1",
      user_id: "U1",
      command: "/vibepro",
      trigger_id: "tr-slow-authority",
      text: "本番でフォームを開きたい",
    }).toString();

    const response = await Promise.race([
      handleSlackCommandRequest(make(body), {
        signingSecret: secret,
        placements: [{ channelId: "C1", allowedUserIds: ["U1"] }],
        nowMs,
        openModal: () => modalWork,
        defer,
        send: vi.fn(),
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("slack_ack_waited_for_modal")), 50)),
    ]);

    expect(response.status).toBe(200);
    expect(defer).toHaveBeenCalledWith(modalWork);
    completeModal();
    await modalWork;
  });

  it("allows an empty command to open the guided form", async () => {
    const openModal = vi.fn(async () => undefined);
    const body = new URLSearchParams({
      team_id: "T1",
      channel_id: "C1",
      user_id: "U1",
      command: "/vibepro",
      trigger_id: "tr-empty",
      text: "",
    }).toString();
    const response = await handleSlackCommandRequest(make(body), {
      signingSecret: secret,
      placements: [{ channelId: "C1", allowedUserIds: ["U1"] }],
      nowMs,
      openModal,
      send: vi.fn(),
    });
    expect(response.status).toBe(200);
    expect(openModal).toHaveBeenCalledWith(expect.objectContaining({ initialProblem: "" }));
  });

  it("keeps the deterministic direct queue path as an operator fallback", async () => {
    const send = vi.fn(async (_event: Omit<SlackQueueEvent, "tenantId">) => undefined);
    const body = new URLSearchParams({
      team_id: "T1",
      channel_id: "C1",
      user_id: "U1",
      command: "/vibepro",
      trigger_id: "tr1",
      text: "認証を直して",
    }).toString();
    const response = await handleSlackCommandRequest(make(body), {
      signingSecret: secret,
      placements: [{ channelId: "C1", allowedUserIds: ["U1"] }],
      nowMs,
      send,
    });
    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "app_mention",
      text: "/develop 認証を直して",
      channelId: "C1",
      userId: "U1",
    }));
    expect(send.mock.calls[0][0]).not.toHaveProperty("tenantId");
  });

  it("does not queue or open an unauthorized command", async () => {
    const send = vi.fn();
    const openModal = vi.fn();
    const body = new URLSearchParams({
      team_id: "T1",
      channel_id: "C1",
      user_id: "U2",
      command: "/ryoko-develop",
      trigger_id: "tr2",
      text: "x",
    }).toString();
    const response = await handleSlackCommandRequest(make(body), {
      signingSecret: secret,
      placements: [{ channelId: "C1", allowedUserIds: ["U1"] }],
      nowMs,
      openModal,
      send,
    });
    expect(response.status).toBe(200);
    expect(send).not.toHaveBeenCalled();
    expect(openModal).not.toHaveBeenCalled();
  });

  it("does not combine a user from one placement with another placement channel", async () => {
    const send = vi.fn();
    const body = new URLSearchParams({
      team_id: "T1",
      channel_id: "C2",
      user_id: "U1",
      command: "/vibepro",
      trigger_id: "tr3",
      text: "x",
    }).toString();
    const response = await handleSlackCommandRequest(make(body), {
      signingSecret: secret,
      placements: [
        { channelId: "C1", allowedUserIds: ["U1"] },
        { channelId: "C2", allowedUserIds: ["U2"] },
      ],
      nowMs,
      send,
    });
    expect(response.status).toBe(200);
    expect(send).not.toHaveBeenCalled();
  });

  it("lets the canonical resolver authorize an installed workspace instead of a static team binding", async () => {
    const send = vi.fn(async (_event: Omit<SlackQueueEvent, "tenantId">) => undefined);
    const body = new URLSearchParams({
      team_id: "T_INSTALLED",
      channel_id: "C1",
      user_id: "U1",
      command: "/vibepro",
      trigger_id: "tr-installed",
      text: "tenant boundaryを直して",
    }).toString();

    const response = await handleSlackCommandRequest(make(body), {
      signingSecret: secret,
      placements: [{ channelId: "C1", allowedUserIds: ["U1"] }],
      nowMs,
      send,
    });

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "T_INSTALLED" }));
  });
});
