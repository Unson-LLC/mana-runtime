import { runtimeWorkspaceName } from "../runtime-workspace-key.js";

describe("runtime workspace session key", () => {
  it("routes a control command and a normal reply for the same thread to the same workspace", () => {
    const replyKey = runtimeWorkspaceName({
      tenantId: "unson-business",
      workspaceId: "T0882T8N9UH",
      channelId: "C0BMNSP6C80",
      threadTs: "1786677816.307859",
    });
    const commandKey = runtimeWorkspaceName({
      tenantId: "unson-business",
      workspaceId: "T0882T8N9UH",
      channelId: "C0BMNSP6C80",
      threadTs: "1786677816.307859",
      command: "/status",
      userId: "U_UMEDA",
    });

    expect(commandKey).toBe(replyKey);
    expect(replyKey).toBe(
      "unson-business:T0882T8N9UH:C0BMNSP6C80:1786677816.307859",
    );
  });

  it("keeps different threads isolated", () => {
    const base = {
      tenantId: "unson-business",
      workspaceId: "T0882T8N9UH",
      channelId: "C0BMNSP6C80",
    };
    expect(runtimeWorkspaceName({ ...base, threadTs: "100.1" }))
      .not.toBe(runtimeWorkspaceName({ ...base, threadTs: "100.2" }));
  });
});
