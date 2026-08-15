import { parseTaskBoardTargets, taskBoardSlackToken, taskBoardTargetsForProjects } from "../task-board-targets.js";

const targets = [
  { targetId: "unson-board", organizationId: "unson", workspaceId: "T0882T8N9UH",
    channelId: "C0BKXCVSDCH", projectCodes: ["proj_unson_board"] },
  { targetId: "tech-pms", organizationId: "tech-knight", workspaceId: "T07A9J3PEMB",
    channelId: "C0BKX9Y169F", projectCodes: ["proj_pms"] },
] as const;

describe("task-board targets", () => {
  it("parses trusted multi-workspace targets and resolves affected projects", () => {
    const parsed = parseTaskBoardTargets(JSON.stringify(targets));
    expect(taskBoardTargetsForProjects(parsed, ["proj_pms"])).toEqual([parsed[1]]);
  });

  it("rejects duplicate canvas coordinates", () => {
    expect(() => parseTaskBoardTargets(JSON.stringify([...targets, { ...targets[1], targetId: "duplicate" }])))
      .toThrow("duplicate_task_board_canvas");
  });

  it("keeps Tech Knight token isolated without fallback", () => {
    const parsed = parseTaskBoardTargets(JSON.stringify(targets));
    expect(taskBoardSlackToken(parsed[0]!, { SLACK_BOT_TOKEN: "unson", SLACK_BOT_TOKEN_TECHKNIGHT: "tech" })).toBe("unson");
    expect(taskBoardSlackToken(parsed[1]!, { SLACK_BOT_TOKEN: "unson", SLACK_BOT_TOKEN_TECHKNIGHT: "tech" })).toBe("tech");
    expect(() => taskBoardSlackToken(parsed[1]!, { SLACK_BOT_TOKEN: "unson" })).toThrow("task_board_slack_token_not_configured");
  });
});
