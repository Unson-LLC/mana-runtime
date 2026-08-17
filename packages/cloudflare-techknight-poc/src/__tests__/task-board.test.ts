import { createManagedTaskBoardCanvas, refreshTaskBoard, renderBoundedTaskBoard } from "../task-board.js";

const canonical = (id: string, status: string) => ({
  id, version: 1, title: `タスク${id}`, description: null, status, priority: "low",
  project_codes: ["back-office"], assignee_person_id: null, assignee_display_name: null,
  due_at: null, waiting_on: null, completed_at: null,
});

describe("Cloudflare bounded task Canvas", () => {
  it("story-task-canvas-ownership:ac:1 creates a Mana-owned Canvas in the trusted channel", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, canvas_id: "FMANABOARD" }));

    const canvasId = await createManagedTaskBoardCanvas(
      "C_TRUSTED",
      "tech-token",
      { fetch: fetchMock },
    );

    expect(canvasId).toBe("FMANABOARD");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://slack.com/api/canvases.create");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      channel_id: "C_TRUSTED",
      title: "Mana タスクボード",
      document_content: {
        type: "markdown",
        markdown: "# タスクボード\n\nManaがBrainbaseの正本タスクを同期します。",
      },
    });
  });

  it("renders truncation as a lower bound rather than an exact total", () => {
    const markdown = renderBoundedTaskBoard({
      items: [canonical("1", "pending")], hasMore: true, observedLowerBound: 2, requestCount: 4,
    }, ["back-office"], "2026-08-13T00:00:00.000Z");
    expect(markdown).toContain("表示 2件以上（続きあり");
    expect(markdown).not.toContain("全 2件");
    expect(markdown).toContain("全件走査はしていません");
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
