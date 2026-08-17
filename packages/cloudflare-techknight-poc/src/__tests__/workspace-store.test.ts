import {
  isReplyCompleted,
  persistEventOnce,
  persistReplyCompletion,
} from "../workspace-store.js";

class MemoryFs {
  readonly files = new Map<string, string>();

  async mkdir(): Promise<void> {}

  async ls(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((path) => path.startsWith(prefix));
  }

  async readFile(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) {
      const error = new Error("not found") as Error & { code: string };
      error.code = "ENOENT";
      throw error;
    }
    return value;
  }

  async writeFile(path: string, value: string): Promise<void> {
    this.files.set(path, value);
  }
}

describe("persistEventOnce", () => {
  it("stores a duplicate event only once", async () => {
    const fs = new MemoryFs();
    const event = {
      tenantId: "techknight" as const,
      eventId: "Ev123",
      workspaceId: "T_TECHKNIGHT",
      channelId: "C123",
      threadTs: "1.0",
      messageTs: "2.0",
      eventType: "app_mention",
      text: "task",
      receivedAt: "2026-08-11T04:00:00.000Z",
    };

    await expect(persistEventOnce(fs, event)).resolves.toEqual({
      created: true,
      path: "/events/Ev123.json",
    });
    await expect(persistEventOnce(fs, event)).resolves.toEqual({
      created: false,
      path: "/events/Ev123.json",
    });
    expect(fs.files.size).toBe(1);
  });

  it("bounds and sanitizes persisted Slack text without mutating the input", async () => {
    const fs = new MemoryFs();
    const originalText = `prefix\u0000${"a".repeat(20_500)}`;
    const event = {
      tenantId: "techknight" as const,
      eventId: "EvBounded",
      workspaceId: "T_TECHKNIGHT",
      channelId: "C123",
      threadTs: "1.0",
      messageTs: "2.0",
      eventType: "app_mention" as const,
      text: originalText,
      receivedAt: "2026-08-12T04:00:00.000Z",
    };

    await persistEventOnce(fs, event);

    const persisted = JSON.parse(fs.files.get("/events/EvBounded.json") ?? "{}");
    expect(persisted.text).toHaveLength(20_000);
    expect(persisted.text).not.toContain("\u0000");
    expect(event.text).toBe(originalText);
  });
});

describe("reply completion", () => {
  it("records only non-sensitive completion metadata", async () => {
    const fs = new MemoryFs();
    await expect(isReplyCompleted(fs, "Ev123")).resolves.toBe(false);
    await expect(persistReplyCompletion(fs, {
      eventId: "Ev123",
      responseTs: "3.0",
      completedAt: "2026-08-11T13:30:00.000Z",
    })).resolves.toBe("/replies/Ev123.json");
    await expect(isReplyCompleted(fs, "Ev123")).resolves.toBe(true);
    expect(JSON.parse(fs.files.get("/replies/Ev123.json") ?? "{}")).toEqual({
      eventId: "Ev123",
      responseTs: "3.0",
      completedAt: "2026-08-11T13:30:00.000Z",
    });
  });

  it("reads the persisted response timestamp so accounting retry does not repost Slack", async () => {
    const fs = new MemoryFs();
    await persistReplyCompletion(fs, {
      eventId: "EvAccountingRetry",
      responseTs: "4.0",
      completedAt: "2026-08-11T13:31:00.000Z",
    });
    const workspaceStore = await import("../workspace-store.js") as typeof import("../workspace-store.js") & {
      readReplyCompletion?: (inputFs: MemoryFs, eventId: string) => Promise<{
        eventId: string;
        responseTs: string;
        completedAt: string;
      } | undefined>;
    };
    expect(workspaceStore.readReplyCompletion).toBeTypeOf("function");
    await expect(workspaceStore.readReplyCompletion?.(fs, "EvAccountingRetry")).resolves.toEqual({
      eventId: "EvAccountingRetry",
      responseTs: "4.0",
      completedAt: "2026-08-11T13:31:00.000Z",
    });
  });
});
