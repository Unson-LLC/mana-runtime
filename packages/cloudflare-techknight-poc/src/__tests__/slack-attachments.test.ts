import { describe, expect, it, vi } from "vitest";

import { hydrateSlackAttachments } from "../slack-attachments.js";
import type { SlackQueueEvent } from "../types.js";

const event: SlackQueueEvent = {
  tenantId: "unson-business", eventId: "Ev1", workspaceId: "T1", channelId: "C1",
  threadTs: "1.0", messageTs: "1.0", userId: "U1", eventType: "app_mention",
  text: "この添付を確認して", receivedAt: "2026-08-14T00:00:00.000Z",
  files: [{ id: "F1", name: "notes.txt", mimetype: "text/plain", size: 12 }],
};

describe("hydrateSlackAttachments", () => {
  it("downloads a bounded Slack text attachment with bearer authentication", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, file: {
        id: "F1", name: "notes.txt", mimetype: "text/plain", size: 12,
        url_private_download: "https://files.slack.com/files-pri/T1-F1/notes.txt",
      } }))
      .mockResolvedValueOnce(new Response("hello\nworld\n"));

    const hydrated = await hydrateSlackAttachments(event, { botToken: "xoxb-secret", fetchImpl });

    expect(hydrated.attachmentContext).toContain("添付: notes.txt (text/plain, 12 bytes)");
    expect(hydrated.attachmentContext).toContain("hello\nworld");
    expect(fetchImpl).toHaveBeenNthCalledWith(2,
      "https://files.slack.com/files-pri/T1-F1/notes.txt",
      expect.objectContaining({ headers: { authorization: "Bearer xoxb-secret" } }),
    );
  });

  it("does not download unsupported binary content and retains safe metadata", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ ok: true, file: {
      id: "F1", name: "photo.png", mimetype: "image/png", size: 1024,
      url_private_download: "https://files.slack.com/photo.png",
    } }));
    const hydrated = await hydrateSlackAttachments({ ...event,
      files: [{ id: "F1", name: "photo.png", mimetype: "image/png", size: 1024 }],
    }, { botToken: "token", fetchImpl });
    expect(hydrated.attachmentContext).toContain("本文取得対象外");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("fails closed when Slack metadata or file download is unavailable", async () => {
    const unavailable = vi.fn().mockResolvedValue(Response.json({ ok: false, error: "file_not_found" }));
    await expect(hydrateSlackAttachments(event, { botToken: "token", fetchImpl: unavailable }))
      .rejects.toThrow("slack_attachment_metadata_unavailable");

    const failedDownload = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, file: {
        id: "F1", name: "notes.txt", mimetype: "text/plain", size: 12,
        url_private_download: "https://files.slack.com/notes.txt",
      } }))
      .mockResolvedValueOnce(new Response("denied", { status: 403 }));
    await expect(hydrateSlackAttachments(event, { botToken: "token", fetchImpl: failedDownload }))
      .rejects.toThrow("slack_attachment_download_unavailable");
  });
});
