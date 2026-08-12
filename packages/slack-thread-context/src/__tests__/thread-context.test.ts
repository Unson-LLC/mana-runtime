import { describe, expect, it, vi } from "vitest";
import { formatSlackThreadContext, hydrateSlackThreadContext } from "../index.js";

describe("Slack thread context core", () => {
  it("follows cursors, deduplicates overlaps, and excludes the triggering message", async () => {
    const replies = vi.fn()
      .mockResolvedValueOnce({
        messages: [
          { ts: "1", user: "U1", text: "root" },
          { ts: "2", user: "U2", text: "middle" },
        ],
        response_metadata: { next_cursor: "next" },
      })
      .mockResolvedValueOnce({
        messages: [
          { ts: "2", user: "U2", text: "middle" },
          { ts: "3", user: "U3", text: "current" },
        ],
      });

    const context = await hydrateSlackThreadContext(replies, "C1", "1", "3");

    expect(replies).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: "next", limit: 98 }));
    expect(context).toContain("<@U1>: root");
    expect(context).toContain("<@U2>: middle");
    expect(context).not.toContain("current");
    expect(context.match(/middle/g)).toHaveLength(1);
  });

  it("terminates repeated cursors and marks the snapshot incomplete", async () => {
    const replies = vi.fn().mockResolvedValue({
      messages: [{ ts: "1", text: "root" }],
      response_metadata: { next_cursor: "same" },
    });
    const context = await hydrateSlackThreadContext(replies, "C1", "1", "9");
    expect(replies).toHaveBeenCalledTimes(2);
    expect(context).toContain("replies omitted");
  });

  it("never exceeds the exact character budget while preserving the newest reply", () => {
    const context = formatSlackThreadContext([
      { ts: "1", text: "r".repeat(25_000) },
      { ts: "2", text: "newest actionable detail" },
    ], "9");
    expect(context.length).toBeLessThanOrEqual(20_000);
    expect(context).toContain("newest actionable detail");
  });
});
