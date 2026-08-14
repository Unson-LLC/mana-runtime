import {
  applyModelCommand,
  renderRuntimeStatus,
} from "../runtime-control-command.js";

describe("runtime control command policy", () => {
  it("renders /status without exposing secrets or capabilities", () => {
    const status = renderRuntimeStatus({
      placementId: "mana-dev-biz",
      projectCodes: ["unson"],
      generation: 2,
      model: "claude-opus-4-1",
      taskSearchEnabled: true,
      taskWriteEnabled: false,
      brainbaseTaskToken: "brainbase-super-secret",
      slackBotToken: "xoxb-slack-super-secret",
      taskWriteCapability: "signed-write-capability",
    });

    expect(status).toContain("mana-dev-biz");
    expect(status).toContain("unson");
    expect(status).toContain("2");
    expect(status).toContain("claude-opus-4-1");
    expect(status).not.toContain("brainbase-super-secret");
    expect(status).not.toContain("xoxb-slack-super-secret");
    expect(status).not.toContain("signed-write-capability");
  });

  it("allows /model only when the requested model is permitted by the placement", () => {
    const placement = {
      placementId: "mana-dev-biz",
      allowedModels: ["claude-opus-4-1", "claude-sonnet-4-5"],
    };

    expect(applyModelCommand({ generation: 2 }, "claude-sonnet-4-5", placement)).toEqual({
      generation: 2,
      modelOverride: "claude-sonnet-4-5",
    });
    expect(() => applyModelCommand(
      { generation: 2 },
      "claude-haiku-3-5",
      placement,
    )).toThrow(expect.objectContaining({ code: "model_not_allowed" }));
  });
});
