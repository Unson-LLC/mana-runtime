import { createManagedTaskBoardCanvas, refreshTaskBoard, renderBoundedTaskBoard } from "../task-board.js";

const canonical = (id: string, status: string) => ({
  id, version: 1, title: `タスク${id}`, description: null, status, priority: "low",
  project_codes: ["back-office"], assignee_person_id: null, assignee_display_name: null,
  due_at: null, waiting_on: null, completed_at: null,
});

describe("Cloudflare bounded task Canvas", () => {
  it("story-task-canvas-ownership:ac:1 creates the trusted channel Canvas", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, canvas_id: "FMANABOARD" }));

    const canvasId = await createManagedTaskBoardCanvas(
      "C_TRUSTED",
      "tech-token",
      { fetch: fetchMock },
    );

    expect(canvasId).toBe("FMANABOARD");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://slack.com/api/conversations.canvases.create");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      channel_id: "C_TRUSTED",
      document_content: {
        type: "markdown",
        markdown: "# タスクボード\n\nManaがBrainbaseの正本タスクを同期します。",
      },
    });
  });

  it("joins a public task channel and retries Canvas creation when Mana is not yet a member", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: false, error: "channel_not_found" }))
      .mockResolvedValueOnce(Response.json({ ok: true, channel: { id: "C_TRUSTED" } }))
      .mockResolvedValueOnce(Response.json({ ok: true, canvas_id: "FMANABOARD" }));

    await expect(createManagedTaskBoardCanvas("C_TRUSTED", "tech-token", { fetch: fetchMock }))
      .resolves.toBe("FMANABOARD");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1]![0])).toBe("https://slack.com/api/conversations.join");
    expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body)))
      .toEqual({ channel: "C_TRUSTED" });
    expect(String(fetchMock.mock.calls[2]![0])).toBe("https://slack.com/api/conversations.canvases.create");
  });

  it("reports the actual channel join failure without retrying indefinitely", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: false, error: "not_in_channel" }))
      .mockResolvedValueOnce(Response.json({ ok: false, error: "missing_scope" }));

    await expect(createManagedTaskBoardCanvas("C_TRUSTED", "tech-token", { fetch: fetchMock }))
      .rejects.toMatchObject({ message: "task_board_missing_scope", definitive: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("story-task-canvas-ownership:ac:2 reuses the authoritative channel Canvas", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("conversations.canvases.create")) {
        return Response.json({ ok: false, error: "channel_canvas_already_exists" });
      }
      if (parsed.pathname.endsWith("conversations.info")) {
        return Response.json({
          ok: true,
          channel: { properties: { tabs: [
            { id: "Ct_LEGACY", type: "canvas", data: { file_id: "FLEGACY" } },
          ] } },
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    await expect(createManagedTaskBoardCanvas("C_TRUSTED", "tech-token", { fetch: fetchMock }))
      .resolves.toBe("FLEGACY");
  });

  it.each([
    { canvas: "FSTRING" },
    { canvas: { canvas_id: "FCANVASID" } },
  ])("reuses the channel Canvas from supported conversations.info canvas shapes", async (properties) => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("conversations.canvases.create")) {
        return Response.json({ ok: false, error: "channel_canvas_already_exists" });
      }
      if (parsed.pathname.endsWith("conversations.info")) {
        return Response.json({ ok: true, channel: { properties } });
      }
      throw new Error(`unexpected ${url}`);
    });

    await expect(createManagedTaskBoardCanvas("C_TRUSTED", "tech-token", { fetch: fetchMock }))
      .resolves.toMatch(/^F(?:STRING|CANVASID)$/u);
  });

  it("does not guess a Canvas when Slack reports an existing channel Canvas but none is readable", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("conversations.canvases.create")) {
        return Response.json({ ok: false, error: "channel_canvas_already_exists" });
      }
      if (parsed.pathname.endsWith("conversations.info")) {
        return Response.json({ ok: true, channel: { properties: {} } });
      }
      throw new Error(`unexpected ${url}`);
    });

    await expect(createManagedTaskBoardCanvas("C_TRUSTED", "tech-token", { fetch: fetchMock }))
      .rejects.toThrow("task_board_channel_canvas_already_exists");
  });

  it("does not choose between multiple Canvas identifiers", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("conversations.canvases.create")) {
        return Response.json({ ok: false, error: "channel_canvas_already_exists" });
      }
      if (parsed.pathname.endsWith("conversations.info")) {
        return Response.json({
          ok: true,
          channel: { properties: { tabs: [
            { id: "Ct_ONE", type: "canvas", data: { file_id: "FONE" } },
            { id: "Ct_TWO", type: "canvas", data: { file_id: "FTWO" } },
          ] } },
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    await expect(createManagedTaskBoardCanvas("C_TRUSTED", "tech-token", { fetch: fetchMock }))
      .rejects.toThrow("task_board_channel_canvas_already_exists");
  });

  it("renders truncation as a lower bound rather than an exact total", () => {
    const markdown = renderBoundedTaskBoard({
      items: [canonical("1", "pending")], hasMore: true, observedLowerBound: 2, requestCount: 4,
    }, ["back-office"], "2026-08-13T00:00:00.000Z");
    expect(markdown).toContain("表示 2件以上（続きあり");
    expect(markdown).not.toContain("全 2件");
    expect(markdown).toContain("全件走査はしていません");
  });

  it("renders status and priority with distinct icons and readable task metadata", () => {
    const markdown = renderBoundedTaskBoard({
      items: [
        { ...canonical("urgent", "in_progress"), title: "緊急対応", priority: "urgent", assignee_display_name: "佐藤", due_at: "2026-08-12T00:00:00.000Z" },
        { ...canonical("high", "waiting"), title: "確認待ち", priority: "high" },
        { ...canonical("medium", "pending"), title: "通常対応", priority: "medium" },
        { ...canonical("low", "completed"), title: "軽微な対応", priority: "low" },
      ],
      hasMore: false,
      observedLowerBound: 4,
      requestCount: 4,
    }, ["back-office"], "2026-08-13T00:00:00.000Z");

    expect(markdown).toContain("🚧 進行中 1件｜⏸️ 保留 1件｜📥 未着手 1件｜✅ 完了 1件");
    expect(markdown).toContain("## 🚧 進行中（表示1件）");
    expect(markdown).toContain("## ⏸️ 保留（表示1件）");
    expect(markdown).toContain("## 📥 未着手（表示1件）");
    expect(markdown).toContain("## ✅ 完了（表示1件）");
    expect(markdown).toContain("- 🛑 緊急　緊急対応");
    expect(markdown).toContain("  - 👤 佐藤　📅 2026-08-12　⚠️ 期限超過");
    expect(markdown).toContain("- 🔴 高　確認待ち");
    expect(markdown).toContain("- 🟡 中　通常対応");
    expect(markdown).toContain("- 🟢 低　軽微な対応");
    expect(markdown).toContain("  - 👤 未割当　📅 期限なし");
  });

  it("updates only the explicitly bound Mana Canvas", async () => {
    const fetchMock = vi.fn().mockImplementation(async function (this: unknown, url: string, init?: RequestInit) {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      const parsed = new URL(url);
      if (parsed.hostname === "bb.example.test") {
        expect(parsed.searchParams.get("limit")).toBe("21");
        expect(parsed.searchParams.getAll("project_code")).toEqual(["back-office"]);
        return Response.json({ items: [canonical(parsed.searchParams.get("status")!, parsed.searchParams.get("status")!)], next_cursor: null });
      }
      if (parsed.pathname.endsWith("conversations.info")) {
        expect(init?.method).toBe("GET");
        expect(parsed.searchParams.get("channel")).toBe("C_BACK_OFFICE");
        expect(init?.body).toBeUndefined();
        return Response.json({
          ok: true,
          channel: { properties: { tabs: [
            { id: "Ct_OTHER", type: "canvas", data: { file_id: "F_OTHER" } },
            { id: "Ct_TAB", type: "canvas", data: { file_id: "F_CANVAS" } },
          ] } },
        });
      }
      if (parsed.pathname.endsWith("canvases.edit")) return Response.json({ ok: true });
      throw new Error(`unexpected ${url} ${String(init?.body)}`);
    });
    const result = await refreshTaskBoard({
      RUNTIME_TASK_BOARD_ENABLED: "true",
      RUNTIME_PROJECT_CODES: "back-office",
      BRAINBASE_TASK_API_BASE_URL: "https://bb.example.test",
      BRAINBASE_TASK_API_TOKEN: "task-secret",
      SLACK_BOT_TOKEN: "slack-secret",
      SLACK_ALLOWED_CHANNEL_ID: "C_BACK_OFFICE",
      TASK_BOARD_CANVAS_ID: "F_CANVAS",
    }, { fetch: fetchMock, now: () => "2026-08-13T00:00:00.000Z" });

    expect(result).toEqual({ outcome: "updated", displayed: 4, hasMore: false });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("bb.example.test"))).toHaveLength(4);
    const edit = fetchMock.mock.calls.find(([url]) => String(url).includes("canvases.edit"));
    expect(edit).toBeTruthy();
    expect(JSON.parse(String((edit?.[1] as RequestInit).body))).toMatchObject({ canvas_id: "F_CANVAS" });
    expect(String((edit?.[1] as RequestInit).body)).not.toContain("task-secret");
  });

  it("uses separate authority fetches for canonical tasks and destination Slack", async () => {
    const taskFetch = vi.fn().mockImplementation(async (url: string) => {
      expect(new URL(url).hostname).toBe("bb.example.test");
      return Response.json({ items: [], next_cursor: null });
    });
    const slackFetch = vi.fn().mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      expect(parsed.hostname).toBe("slack.com");
      if (parsed.pathname.endsWith("conversations.info")) {
        return Response.json({
          ok: true,
          channel: { properties: { tabs: [
            { id: "Ct_TAB", type: "canvas", data: { file_id: "F_CANVAS" } },
          ] } },
        });
      }
      if (parsed.pathname.endsWith("canvases.edit")) return Response.json({ ok: true });
      throw new Error(`unexpected ${url}`);
    });

    await expect(refreshTaskBoard({
      RUNTIME_TASK_BOARD_ENABLED: "true",
      RUNTIME_PROJECT_CODES: "back-office",
      BRAINBASE_TASK_API_BASE_URL: "https://bb.example.test",
      BRAINBASE_TASK_API_TOKEN: "task-secret",
      SLACK_BOT_TOKEN: "slack-secret",
      SLACK_ALLOWED_CHANNEL_ID: "C_BACK_OFFICE",
      TASK_BOARD_CANVAS_ID: "F_CANVAS",
    }, { fetch: slackFetch, taskFetch })).resolves.toEqual({
      outcome: "updated", displayed: 0, hasMore: false,
    });

    expect(taskFetch).toHaveBeenCalledTimes(4);
    expect(slackFetch).toHaveBeenCalledTimes(2);
  });

  it("does not adopt or create an unbound channel Canvas", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.hostname === "bb.example.test") return Response.json({ items: [], next_cursor: null });
      if (parsed.pathname.endsWith("conversations.info")) return Response.json({ ok: true, channel: { properties: {} } });
      throw new Error(`unexpected ${url}`);
    });
    await expect(refreshTaskBoard({
      RUNTIME_TASK_BOARD_ENABLED: "true",
      RUNTIME_PROJECT_CODES: "back-office",
      BRAINBASE_TASK_API_BASE_URL: "https://bb.example.test",
      BRAINBASE_TASK_API_TOKEN: "task-secret",
      SLACK_BOT_TOKEN: "slack-secret",
      SLACK_ALLOWED_CHANNEL_ID: "C_BACK_OFFICE",
      TASK_BOARD_CANVAS_ID: "F_OWNED",
    }, { fetch: fetchMock })).rejects.toThrow("task_board_canvas_binding_mismatch");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("canvases.edit"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("canvases.create"))).toBe(false);
  });

  it("does not adopt a different Canvas found in the bound channel", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.hostname === "bb.example.test") return Response.json({ items: [], next_cursor: null });
      if (parsed.pathname.endsWith("conversations.info")) {
        return Response.json({ ok: true, channel: { properties: { tabz: [{ id: "Ct_OTHER", type: "canvas", data: { file_id: "F_OTHER" } }] } } });
      }
      throw new Error(`unexpected ${url}`);
    });
    await expect(refreshTaskBoard({
      RUNTIME_TASK_BOARD_ENABLED: "true",
      RUNTIME_PROJECT_CODES: "back-office",
      BRAINBASE_TASK_API_BASE_URL: "https://bb.example.test",
      BRAINBASE_TASK_API_TOKEN: "task-secret",
      SLACK_BOT_TOKEN: "slack-secret",
      SLACK_ALLOWED_CHANNEL_ID: "C_BACK_OFFICE",
      TASK_BOARD_CANVAS_ID: "F_OWNED",
    }, { fetch: fetchMock })).rejects.toThrow("task_board_canvas_binding_mismatch");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("canvases.edit"))).toBe(false);
  });

  it("never recreates an explicitly bound Canvas after Slack reports it missing", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.hostname === "bb.example.test") return Response.json({ items: [], next_cursor: null });
      if (parsed.pathname.endsWith("conversations.info")) {
        return Response.json({ ok: true, channel: { properties: { canvas: { file_id: "F_STALE" } } } });
      }
      if (parsed.pathname.endsWith("canvases.edit")) return Response.json({ ok: false, error: "canvas_not_found" });
      if (parsed.pathname.endsWith("conversations.canvases.create")) return Response.json({ ok: true, canvas_id: "F_NEW" });
      throw new Error(`unexpected ${url}`);
    });
    await expect(refreshTaskBoard({
      RUNTIME_TASK_BOARD_ENABLED: "true",
      RUNTIME_PROJECT_CODES: "back-office",
      BRAINBASE_TASK_API_BASE_URL: "https://bb.example.test",
      BRAINBASE_TASK_API_TOKEN: "task-secret",
      SLACK_BOT_TOKEN: "slack-secret",
      SLACK_ALLOWED_CHANNEL_ID: "C_BACK_OFFICE",
      TASK_BOARD_CANVAS_ID: "F_STALE",
    }, { fetch: fetchMock })).rejects.toThrow("task_board_canvas_not_found");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("canvases.create"))).toBe(false);
  });

  it("does nothing while the board feature is disabled", async () => {
    await expect(refreshTaskBoard({ RUNTIME_TASK_BOARD_ENABLED: "false" })).resolves.toEqual({ outcome: "disabled" });
  });
});
