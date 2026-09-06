import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertBrainbaseMeetingMinutesProjects, assertBrainbaseMeetingMinutesRuntimeProjects, collectMeetingMinutesProjectBindings, projectCodesFromGraphResponse } from "../../scripts/brainbase-project-binding-check.mjs";

function config(overrides: Record<string, unknown> = {}) {
  return { vars: {
    BRAINBASE_GRAPH_API_BASE_URL: "https://brainbase.example",
    MEETING_MINUTES_DESTINATIONS_JSON: JSON.stringify([{ id: "kartz", contextProjectCode: "kartz", taskProjectCodes: ["kartz"], taskBoardTargetId: "minutes-kartz" }]),
    MEETING_MINUTES_ADDITIONAL_DESTINATIONS_JSON: "[]",
    TASK_BOARD_TARGETS_JSON: JSON.stringify([{ targetId: "minutes-kartz", projectCodes: ["kartz"] }]),
    ...overrides,
  } };
}

async function configFile(value: unknown) {
  const path = join(tmpdir(), `mana-brainbase-bindings-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(value), "utf8");
  return path;
}

describe("Brainbase meeting-minutes project deployment check", () => {
  it("collects explicit context, task and board mappings", () => {
    expect(collectMeetingMinutesProjectBindings(config()).requiredCodes).toEqual(["kartz"]);
    expect(projectCodesFromGraphResponse({ records: [{ id: "project:kartz", payload: { project_code: "kartz" } }] })).toEqual(["kartz", "project:kartz"]);
  });

  it("collects mappings from compact task-board configuration", () => {
    const bindings = collectMeetingMinutesProjectBindings(config({
      TASK_BOARD_TARGETS_JSON: JSON.stringify({
        defaults: { enabled: true, autoProvision: true, bindingRevision: 1 },
        targets: [{ targetId: "minutes-kartz", projectCodes: ["kartz"] }],
      }),
    }));
    expect(bindings.requiredCodes).toEqual(["kartz"]);
  });

  it("rejects missing mappings and mismatched board targets", () => {
    expect(() => collectMeetingMinutesProjectBindings(config({ MEETING_MINUTES_DESTINATIONS_JSON: JSON.stringify([{ id: "kartz", taskProjectCodes: ["kartz"], taskBoardTargetId: "minutes-kartz" }]) })))
      .toThrow("meeting_minutes_brainbase_project_check_binding_missing:kartz");
    expect(() => collectMeetingMinutesProjectBindings(config({ TASK_BOARD_TARGETS_JSON: JSON.stringify([{ targetId: "minutes-kartz", projectCodes: ["unson"] }]) })))
      .toThrow("meeting_minutes_brainbase_project_check_target_mismatch:kartz:minutes-kartz");
  });

  it("allows a board to read an explicit legacy scope while new tasks use only the canonical scope", () => {
    const bindings = collectMeetingMinutesProjectBindings(config({
      TASK_BOARD_TARGETS_JSON: JSON.stringify([{
        targetId: "minutes-kartz", projectCodes: ["kartz", "proj_kartz"],
      }]),
    }));
    expect(bindings.requiredCodes).toEqual(["kartz", "proj_kartz"]);
  });

  it("allows deployment only when every configured code is authorized", async () => {
    const path = await configFile(config());
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ records: [{ id: "project:kartz", payload: { project_code: "kartz" } }] }));
    await expect(assertBrainbaseMeetingMinutesProjects({ configPath: path, baseUrl: "https://brainbase.example", token: "token", fetchImpl }))
      .resolves.toEqual(expect.objectContaining({ requiredCodes: ["kartz"] }));
    expect(fetchImpl).toHaveBeenCalledWith(expect.objectContaining({ pathname: "/api/info/graph/entities" }),
      expect.objectContaining({ redirect: "error", headers: { authorization: "Bearer token" } }));
  });

  it("validates both runtime Task and Graph credentials before deployment", async () => {
    const path = await configFile(config());
    const fetchImpl = vi.fn().mockImplementation(async (input: URL) => input.pathname === "/api/companion/tasks"
      ? Response.json({ items: [], next_cursor: null })
      : Response.json({ records: [{ payload: { project_code: "kartz" } }] }));
    await expect(assertBrainbaseMeetingMinutesRuntimeProjects({ configPath: path,
      taskBaseUrl: "https://task.brainbase.example", graphBaseUrl: "https://graph.brainbase.example",
      taskToken: "task-token", graphToken: "graph-token", fetchImpl })).resolves.toEqual(expect.objectContaining({
      task: expect.objectContaining({ requiredCodes: ["kartz"], apiReachable: true }),
      graph: expect.objectContaining({ requiredCodes: ["kartz"] }),
    }));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.map((call) => (call[0] as URL).pathname)).toEqual([
      "/api/info/graph/entities", "/api/companion/tasks", "/api/info/graph/entities",
    ]);
    expect(fetchImpl.mock.calls.map((call) => (call[1] as RequestInit).headers)).toEqual([
      { authorization: "Bearer graph-token" }, { authorization: "Bearer task-token" }, { authorization: "Bearer task-token" },
    ]);
    await expect(assertBrainbaseMeetingMinutesRuntimeProjects({ configPath: path,
      taskBaseUrl: "https://task.brainbase.example", graphBaseUrl: "https://graph.brainbase.example",
      taskToken: "task-token", graphToken: "" })).rejects.toThrow("meeting_minutes_brainbase_project_check_auth_missing:graph");
  });

  it("fails closed when either runtime API omits a configured project", async () => {
    const path = await configFile(config());
    await expect(assertBrainbaseMeetingMinutesRuntimeProjects({ configPath: path,
      taskBaseUrl: "https://task.brainbase.example", graphBaseUrl: "https://graph.brainbase.example",
      taskToken: "task-token", graphToken: "graph-token",
      fetchImpl: vi.fn().mockImplementation(async (input: URL, init: RequestInit) => input.pathname === "/api/companion/tasks"
        ? Response.json({ items: [], next_cursor: null })
        : (init.headers as Record<string, string>).authorization === "Bearer task-token"
          ? Response.json({ records: [] })
          : Response.json({ records: [{ payload: { project_code: "kartz" } }] })) }))
      .rejects.toThrow("meeting_minutes_brainbase_project_check_task_scope:kartz_missing");
  });

  it("accepts a Task-only scope only after filtered Task API readback", async () => {
    const path = await configFile(config({
      MEETING_MINUTES_DESTINATIONS_JSON: JSON.stringify([{
        id: "board", contextProjectCode: "techknight", taskProjectCodes: ["proj_techknight_board"],
        taskBoardTargetId: "minutes-board",
      }]),
      TASK_BOARD_TARGETS_JSON: JSON.stringify([{
        targetId: "minutes-board", projectCodes: ["proj_techknight_board"],
      }]),
    }));
    const fetchImpl = vi.fn().mockImplementation(async (input: URL) => {
      if (input.pathname === "/api/info/graph/entities") {
        return Response.json({ records: [{ payload: { project_code: "techknight" } }] });
      }
      const code = input.searchParams.get("project_code");
      return Response.json({ items: code === "proj_techknight_board"
        ? [{ project_codes: ["proj_techknight_board"] }]
        : [], next_cursor: null });
    });
    await expect(assertBrainbaseMeetingMinutesRuntimeProjects({ configPath: path,
      taskBaseUrl: "https://task.brainbase.example", graphBaseUrl: "https://graph.brainbase.example",
      taskToken: "task-token", graphToken: "graph-token", fetchImpl })).resolves.toEqual(expect.objectContaining({
      graph: expect.objectContaining({ requiredCodes: ["techknight"] }),
      task: expect.objectContaining({ requiredCodes: ["proj_techknight_board"],
        authorizedCodes: expect.arrayContaining(["proj_techknight_board"]) }),
    }));
  });

  it("fails closed when the Canonical Task API rejects the runtime credential", async () => {
    const path = await configFile(config());
    await expect(assertBrainbaseMeetingMinutesRuntimeProjects({ configPath: path,
      taskBaseUrl: "https://task.brainbase.example", graphBaseUrl: "https://graph.brainbase.example",
      taskToken: "task-token", graphToken: "graph-token",
      fetchImpl: vi.fn().mockImplementation(async (input: URL) => input.pathname === "/api/companion/tasks"
        ? new Response(null, { status: 401 })
        : Response.json({ records: [{ payload: { project_code: "kartz" } }] })) }))
      .rejects.toThrow("meeting_minutes_brainbase_project_check_task_api_http_401");
  });

  it("uses the production Brainbase URL declared by the Worker config", async () => {
    const path = await configFile(config());
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ records: [{ id: "project:kartz", payload: { project_code: "kartz" } }] }));
    await expect(assertBrainbaseMeetingMinutesProjects({ configPath: path, token: "token", fetchImpl })).resolves.toBeDefined();
    expect(fetchImpl.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ origin: "https://brainbase.example" }));
  });

  it("fails closed for an unauthorized or unreachable Brainbase", async () => {
    const path = await configFile(config());
    await expect(assertBrainbaseMeetingMinutesProjects({ configPath: path, baseUrl: "https://brainbase.example", token: "token",
      fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 403 })) })).rejects.toThrow("meeting_minutes_brainbase_project_check_http_403");
    await expect(assertBrainbaseMeetingMinutesProjects({ configPath: path, baseUrl: "https://brainbase.example", token: "token",
      fetchImpl: vi.fn().mockRejectedValue(new Error("offline")) })).rejects.toThrow("meeting_minutes_brainbase_project_check_unreachable");
  });

  it("reports every missing canonical project code together", async () => {
    const path = await configFile(config({
      MEETING_MINUTES_ADDITIONAL_DESTINATIONS_JSON: JSON.stringify([{ id: "back-office", contextProjectCode: "back-office", taskProjectCodes: ["back-office"], taskBoardTargetId: "minutes-back-office" }]),
      TASK_BOARD_TARGETS_JSON: JSON.stringify([{ targetId: "minutes-kartz", projectCodes: ["kartz"] }, { targetId: "minutes-back-office", projectCodes: ["back-office"] }]),
    }));
    await expect(assertBrainbaseMeetingMinutesProjects({ configPath: path, baseUrl: "https://brainbase.example", token: "token",
      fetchImpl: vi.fn().mockResolvedValue(Response.json({ records: [] })) })).rejects.toThrow("meeting_minutes_brainbase_project_check_missing:back-office,kartz");
  });
});
