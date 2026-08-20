import { describe, expect, it, vi } from "vitest";

import {
  consumeMeetingMinutesIntakePause,
  gateMeetingMinutesCommandQueueMessage,
  gateMeetingMinutesRouterQueueMessage,
  handleMeetingMinutesIntakeAdminRequest,
  interceptMeetingMinutesIntakePause,
} from "../meeting-minutes-intake-entrypoints.js";
import type { MeetingMinutesRedo, MeetingMinutesSelection } from "../meeting-minutes-contracts.js";
import type { SlackQueueEvent } from "../types.js";

const fileEvent: SlackQueueEvent = {
  tenantId: "unson-business",
  eventId: "Ev-file-1",
  workspaceId: "T1",
  channelId: "C0BKTFQ9V38",
  threadTs: "1786000000.000001",
  messageTs: "1786000000.000001",
  eventType: "message",
  subtype: "file_share",
  text: "",
  receivedAt: "2026-08-16T00:00:00.000Z",
  files: [{ id: "F1", name: "meeting.txt" }],
};

const selection: MeetingMinutesSelection = {
  kind: "meeting_minutes_selection", runId: "Ev-file-1_F1", destinationId: "senpainurse",
  workspaceId: "T1", appId: "A1", channelId: "C0BKTFQ9V38", threadTs: "1786000000.000001",
  userId: "U1", actionTs: "1786000010.000001",
};

const redo: MeetingMinutesRedo = {
  kind: "meeting_minutes_redo", runId: "Ev-file-1_F1", workspaceId: "T1", appId: "A1",
  channelId: "C0BKTFQ9V38", threadTs: "1786000000.000001", userId: "U1", actionTs: "1786000020.000001",
};

describe("meeting minutes intake entrypoints", () => {
  it("persists an authenticated intake pause and returns the durable status", async () => {
    const setPaused = vi.fn().mockResolvedValue(undefined);
    const status = vi.fn().mockResolvedValue({ allowed: false, intakePaused: true, activeRuns: [{ runId: "run-1" }] });
    const response = await handleMeetingMinutesIntakeAdminRequest(new Request("https://worker.example/admin/meeting-minutes/intake", {
      method: "POST",
      body: JSON.stringify({ paused: true }),
    }), {
      authorize: vi.fn().mockResolvedValue(true),
      setPaused,
      status,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      allowed: false,
      intakePaused: true,
      activeRuns: [{ runId: "run-1" }],
    });
    expect(setPaused).toHaveBeenCalledWith(true);
    expect(status).toHaveBeenCalledOnce();
  });

  it("rejects unauthenticated or invalid intake updates without changing durable state", async () => {
    const setPaused = vi.fn();
    const unauthorized = await handleMeetingMinutesIntakeAdminRequest(new Request("https://worker.example/admin/meeting-minutes/intake", {
      method: "POST",
      body: JSON.stringify({ paused: true }),
    }), {
      authorize: vi.fn().mockResolvedValue(false), setPaused, status: vi.fn(),
    });
    const invalid = await handleMeetingMinutesIntakeAdminRequest(new Request("https://worker.example/admin/meeting-minutes/intake", {
      method: "POST",
      body: JSON.stringify({ paused: "yes" }),
    }), {
      authorize: vi.fn().mockResolvedValue(true), setPaused, status: vi.fn(),
    });

    expect(unauthorized.status).toBe(401);
    expect(invalid.status).toBe(400);
    expect(setPaused).not.toHaveBeenCalled();
  });

  it("acks a paused file event without running downstream work or requesting a retry", async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const notify = vi.fn().mockResolvedValue(undefined);
    await expect(consumeMeetingMinutesIntakePause({ body: fileEvent, ack, retry }, {
      isPaused: vi.fn().mockResolvedValue(true),
      notify,
    })).resolves.toBe(true);

    expect(notify).toHaveBeenCalledWith(fileEvent.channelId, fileEvent.threadTs);
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it("still acks a paused file event when the Slack notice fails", async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const logNotificationFailure = vi.fn();
    await expect(consumeMeetingMinutesIntakePause({ body: fileEvent, ack, retry }, {
      isPaused: vi.fn().mockResolvedValue(true),
      notify: vi.fn().mockRejectedValue(new Error("slack unavailable")),
      logNotificationFailure,
    })).resolves.toBe(true);

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(logNotificationFailure).toHaveBeenCalledWith(fileEvent.eventId, expect.any(Error));
  });

  it("leaves an unpaused file event for the normal queue consumer", async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const notify = vi.fn();
    await expect(consumeMeetingMinutesIntakePause({ body: fileEvent, ack, retry }, {
      isPaused: vi.fn().mockResolvedValue(false),
      notify,
    })).resolves.toBe(false);

    expect(notify).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it("accepts a paused ingress event without enqueueing it, even if intake resumes afterward", async () => {
    let paused = true;
    const deferred: Promise<void>[] = [];
    const notify = vi.fn().mockResolvedValue(undefined);

    await expect(interceptMeetingMinutesIntakePause(fileEvent, {
      isPaused: vi.fn(async () => paused),
      notify,
      defer: (work) => deferred.push(work),
    })).resolves.toBe(true);

    paused = false;
    await Promise.all(deferred);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("does not intercept an unpaused ingress event", async () => {
    const notify = vi.fn();
    const defer = vi.fn();

    await expect(interceptMeetingMinutesIntakePause(fileEvent, {
      isPaused: vi.fn().mockResolvedValue(false),
      notify,
      defer,
    })).resolves.toBe(false);

    expect(notify).not.toHaveBeenCalled();
    expect(defer).not.toHaveBeenCalled();
  });

  it("keeps a queued router file out of ordinary handling in a disabled Worker", async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const notify = vi.fn().mockResolvedValue(undefined);

    await expect(gateMeetingMinutesRouterQueueMessage({ body: fileEvent, ack, retry }, {
      enabled: false,
      routerChannelId: fileEvent.channelId,
      isPaused: vi.fn().mockResolvedValue(false),
      notify,
    })).resolves.toBe("blocked");

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(fileEvent.channelId, fileEvent.threadTs);
  });

  it("allows only an enabled and unpaused router file into minutes processing", async () => {
    const ack = vi.fn();
    const retry = vi.fn();

    await expect(gateMeetingMinutesRouterQueueMessage({ body: fileEvent, ack, retry }, {
      enabled: true,
      routerChannelId: fileEvent.channelId,
      isPaused: vi.fn().mockResolvedValue(false),
      notify: vi.fn(),
    })).resolves.toBe("ready");

    expect(ack).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it("does not intercept an ordinary queued event", async () => {
    const ordinary = { ...fileEvent, channelId: "COTHER" };

    await expect(gateMeetingMinutesRouterQueueMessage({ body: ordinary, ack: vi.fn(), retry: vi.fn() }, {
      enabled: false,
      routerChannelId: fileEvent.channelId,
      isPaused: vi.fn(),
      notify: vi.fn(),
    })).resolves.toBe("not_router_file");
  });

  it("acks a queued destination selection instead of retrying it in a disabled Worker", async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const notify = vi.fn().mockResolvedValue(undefined);

    await expect(gateMeetingMinutesCommandQueueMessage({ body: selection, ack, retry }, {
      enabled: false,
      isPaused: vi.fn().mockResolvedValue(false),
      notify,
    })).resolves.toBe("blocked");

    expect(notify).toHaveBeenCalledWith(selection);
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it("acks a queued redo instead of retrying it while intake is paused", async () => {
    const ack = vi.fn();
    const retry = vi.fn();

    await expect(gateMeetingMinutesCommandQueueMessage({ body: redo, ack, retry }, {
      enabled: true,
      isPaused: vi.fn().mockResolvedValue(true),
      notify: vi.fn().mockResolvedValue(undefined),
    })).resolves.toBe("blocked");

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it("still acks a blocked command when the private Slack notice fails", async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const logNotificationFailure = vi.fn();

    await expect(gateMeetingMinutesCommandQueueMessage({ body: selection, ack, retry }, {
      enabled: false,
      isPaused: vi.fn().mockResolvedValue(false),
      notify: vi.fn().mockRejectedValue(new Error("slack unavailable")),
      logNotificationFailure,
    })).resolves.toBe("blocked");

    expect(logNotificationFailure).toHaveBeenCalledWith(selection, expect.any(Error));
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it("leaves a queued command for normal handling only when intake is enabled and unpaused", async () => {
    const ack = vi.fn();
    const retry = vi.fn();

    await expect(gateMeetingMinutesCommandQueueMessage({ body: selection, ack, retry }, {
      enabled: true,
      isPaused: vi.fn().mockResolvedValue(false),
      notify: vi.fn(),
    })).resolves.toBe("ready");

    expect(ack).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });
});
