import { parseTaskBoardTargets, taskBoardSlackToken, taskBoardTargetsForProjects } from "../task-board-targets.js";

const targets = [
  { targetId: "unson-board", organizationId: "unson", workspaceId: "T07LL5WV7N1",
    channelId: "C0A9ESC81UZ", projectCodes: ["proj_salestailor"], enabled: true, manaCanvasId: "FUNSON", bindingRevision: 1 },
  { targetId: "business-board", organizationId: "unson-business", workspaceId: "T0882T8N9UH",
    channelId: "C0BKXCVSDCH", projectCodes: ["proj_unson_board"], enabled: false, manaCanvasId: null, bindingRevision: null },
  { targetId: "tech-pms", organizationId: "tech-knight", workspaceId: "T07A9J3PEMB",
    channelId: "C0BKX9Y169F", projectCodes: ["proj_pms"], enabled: true, manaCanvasId: "FTECH", bindingRevision: 3 },
] as const;

describe("task-board targets", () => {
  it("parses trusted multi-workspace targets and resolves affected projects", () => {
    const parsed = parseTaskBoardTargets(JSON.stringify(targets));
    expect(taskBoardTargetsForProjects(parsed, ["proj_pms"])).toEqual([parsed[2]]);
  });

  it("rejects duplicate canvas coordinates", () => {
    expect(() => parseTaskBoardTargets(JSON.stringify([...targets, { ...targets[2], targetId: "duplicate" }])))
      .toThrow("duplicate_task_board_canvas");
  });

  it("requires an explicit Canvas binding before a target can be enabled", () => {
    expect(() => parseTaskBoardTargets(JSON.stringify([{ ...targets[0], manaCanvasId: null, bindingRevision: null }])))
      .toThrow("invalid_task_board_canvas_binding");
    expect(() => parseTaskBoardTargets(JSON.stringify([{ ...targets[0], enabled: false, bindingRevision: null }])))
      .toThrow("invalid_task_board_canvas_binding");
  });

  it("allows an enabled target to provision a new Mana-owned Canvas", () => {
    const parsed = parseTaskBoardTargets(JSON.stringify([{
      ...targets[2],
      autoProvision: true,
      manaCanvasId: null,
      bindingRevision: 1,
    }]));
    expect(parsed[0]).toMatchObject({
      enabled: true,
      autoProvision: true,
      manaCanvasId: null,
      bindingRevision: 1,
    });
    expect(taskBoardTargetsForProjects(parsed, ["proj_pms"])).toEqual(parsed);
  });


  it("rejects one owned Canvas being bound to two target channels", () => {
    expect(() => parseTaskBoardTargets(JSON.stringify([targets[0], {
      ...targets[0], targetId: "duplicate-owner", channelId: "C0A9ESC81UX",
    }]))).toThrow("duplicate_task_board_canvas_binding");
  });

  it("isolates Slack tokens by the trusted organization without fallback", () => {
    const parsed = parseTaskBoardTargets(JSON.stringify(targets));
    const env = { SLACK_BOT_TOKEN: "business", SLACK_BOT_TOKEN_UNSON: "unson", SLACK_BOT_TOKEN_TECHKNIGHT: "tech" };
    expect(taskBoardSlackToken(parsed[0]!, env)).toBe("unson");
    expect(taskBoardSlackToken(parsed[1]!, env)).toBe("business");
    expect(taskBoardSlackToken(parsed[2]!, env)).toBe("tech");
    expect(taskBoardSlackToken({ ...parsed[0]!, workspaceId: "T0882T8N9UH" }, env)).toBe("business");
    expect(() => taskBoardSlackToken(parsed[0]!, { SLACK_BOT_TOKEN: "business" }))
      .toThrow("task_board_slack_token_not_configured");
  });
});

describe("split task-board bindings", () => {
  it("preserves target order and contents across bindings", () => {
    expect(parseTaskBoardTargets(JSON.stringify(targets.slice(0, 1)), JSON.stringify(targets.slice(1))))
      .toEqual(parseTaskBoardTargets(JSON.stringify(targets)));
  });
  it("rejects duplicate targets across bindings", () => {
    expect(() => parseTaskBoardTargets(JSON.stringify(targets), JSON.stringify([targets[0]])))
      .toThrow("duplicate_task_board_target_id");
  });
  it("rejects malformed additional settings and combined capacity overflow", () => {
    expect(() => parseTaskBoardTargets(JSON.stringify(targets), "{}" )).toThrow("invalid_task_board_targets");
    expect(() => parseTaskBoardTargets(JSON.stringify(Array(30).fill(targets[0])), JSON.stringify(Array(21).fill(targets[1]))))
      .toThrow("invalid_task_board_targets");
  });
});
