import { resolveClaudeRuntimeConfig } from "../claude-runtime-config.js";
import {
  executeReplyRuntime,
  type PreparedReplyRequester,
  type ReplyRuntimeBaseOptions,
} from "../reply-runtime-execution.js";
import type { WorkspaceFs } from "../workspace-store.js";
import type { SlackQueueEvent } from "../types.js";

class MemoryFs implements WorkspaceFs {
  readonly files = new Map<string, string>();

  async mkdir(): Promise<void> {}

  async ls(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((path) => path.startsWith(prefix));
  }

  async readFile(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error("ENOENT");
    return value;
  }

  async writeFile(path: string, value: string): Promise<void> {
    this.files.set(path, value);
  }
}

function event(overrides: Partial<SlackQueueEvent> = {}): SlackQueueEvent {
  return {
    tenantId: "techknight",
    eventId: "EvRuntimeExecution",
    workspaceId: "T_TECHKNIGHT",
    channelId: "C_MANA_TEST",
    threadTs: "1786454600.000001",
    messageTs: "1786454653.386769",
    userId: "U_USER",
    eventType: "app_mention",
    text: "<@U_BOT> 私のタスクを教えて",
    receivedAt: "2026-08-11T13:24:13.000Z",
    ...overrides,
  };
}

const judgmentLine = "🧠 判断参照: 「質問」を参照 → 質問として回答 ✓";
const brainbaseLine = "📚 Brainbase未参照: 必須参照なし・実呼び出し0回 ✓";
const receiptPrefix = "__MANA_JUDGMENT_RECEIPT_V1__:";

function auditedReplyStream(): string {
  const receipt = (hookEventName: "UserPromptSubmit" | "Stop") => ({
    type: "system",
    subtype: "hook_response",
    hook_event: hookEventName,
    exit_code: 0,
    outcome: "success",
    session_id: "session-1",
    stdout: JSON.stringify({
      systemMessage: [
        ...(hookEventName === "Stop" ? [judgmentLine, brainbaseLine] : []),
        `${receiptPrefix}${JSON.stringify({
          schema_version: "mana_judgment_hook_receipt.v1",
          hook_event_name: hookEventName,
          session_id: "session-1",
          turn_id: "turn-1",
          ...(hookEventName === "UserPromptSubmit" ? {
            host_receipt_id: "receipt-route-1",
            route_resolution_sha256: "a".repeat(64),
          } : {}),
        })}`,
      ].join("\n"),
    }),
  });
  return [
    { type: "system", subtype: "init", session_id: "session-1" },
    receipt("UserPromptSubmit"),
    receipt("Stop"),
    { type: "result", session_id: "session-1", result: [judgmentLine, brainbaseLine, "回答本文"].join("\n") },
  ].map((entry) => JSON.stringify(entry)).join("\n");
}

const boundaryHandle = `tb_${"A".repeat(32)}`;

function baseOptions(overrides: Partial<ReplyRuntimeBaseOptions> = {}): ReplyRuntimeBaseOptions {
  const sandbox = {
    writeFile: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockResolvedValue({ success: true, stdout: auditedReplyStream(), stderr: "" }),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
  return {
    expectedTenantId: "techknight",
    expectedWorkspaceId: "T_TECHKNIGHT",
    allowedChannelId: "C_MANA_TEST",
    oauthConfigured: true,
    tenantBoundaryHandle: boundaryHandle,
    claudeRuntime: resolveClaudeRuntimeConfig({ RUNTIME_CLAUDE_MODEL: "opus", RUNTIME_CLAUDE_EFFORT: "xhigh" }),
    createSandbox: vi.fn(() => sandbox),
    now: () => "2026-08-11T13:30:00.000Z",
    postReply: vi.fn().mockResolvedValue("1786455000.000001"),
    ...overrides,
  };
}

function requester(overrides: Partial<PreparedReplyRequester> = {}): PreparedReplyRequester {
  return {
    requesterIdentity: { slackUserId: "U_USER", personId: "person_canonical" },
    requesterProfile: { userId: "U_USER", name: "Canonical User" },
    graphContext: "Graph context",
    taskWriteEnabled: false,
    ...overrides,
  };
}

describe("shared reply runtime execution", () => {
  it("executes the real reply pipeline with the prepared canonical requester", async () => {
    const fs = new MemoryFs();
    const inputEvent = event();
    const prepareRequester = vi.fn(async () => requester());
    const options = baseOptions();

    await expect(executeReplyRuntime({
      fs,
      event: inputEvent,
      taskSearch: {
        tenantId: "techknight",
        workspaceId: "T_TECHKNIGHT",
        channelId: "C_MANA_TEST",
        projectCodes: "brainbase",
        taskSearchEnabled: "true",
        brainbaseApiBaseUrl: "https://bb.example.test",
        tenantCredentialFetchConfigured: true,
      },
      prepareRequester,
      options,
    })).resolves.toEqual({
      outcome: "replied",
      responseTs: "1786455000.000001",
    });

    expect(prepareRequester).toHaveBeenCalledWith(expect.objectContaining({
      taskSearch: {
        taskSearchEnabled: true,
        binding: {
          tenantId: "techknight",
          workspaceId: "T_TECHKNIGHT",
          channelId: "C_MANA_TEST",
          projectCodes: ["brainbase"],
        },
      },
    }));
    const sandbox = vi.mocked(options.createSandbox).mock.results[0]?.value;
    const writeCalls = (sandbox?.writeFile as unknown as {
      mock?: { calls: Array<[string, string]> };
    }).mock?.calls ?? [];
    const prompt = String(writeCalls.find(([path]) => path === "/tmp/mana-slack-prompt.txt")?.[1]);
    expect(prompt).toContain("requester_person_id: person_canonical");
    expect(prompt).not.toContain("<@U_BOT>");
    expect(options.postReply).toHaveBeenCalledWith(
      inputEvent,
      [judgmentLine, brainbaseLine, "回答本文"].join("\n"),
    );
  });

  it("fails closed before Claude when the prepared identity is not the Slack actor", async () => {
    const fs = new MemoryFs();
    const options = baseOptions();
    const createSandbox = vi.mocked(options.createSandbox);

    await expect(executeReplyRuntime({
      fs,
      event: event(),
      taskSearch: {
        tenantId: "techknight",
        workspaceId: "T_TECHKNIGHT",
        channelId: "C_MANA_TEST",
        projectCodes: "brainbase",
        taskSearchEnabled: "true",
        brainbaseApiBaseUrl: "https://bb.example.test",
        tenantCredentialFetchConfigured: true,
      },
      prepareRequester: async () => requester({
        requesterIdentity: { slackUserId: "U_OTHER", personId: "person_canonical" },
      }),
      options,
    })).rejects.toMatchObject({ code: "requester_identity_not_found" });
    expect(createSandbox).not.toHaveBeenCalled();
  });

  it("fails closed before Claude when the canonical person id is missing", async () => {
    const fs = new MemoryFs();
    const options = baseOptions();
    const createSandbox = vi.mocked(options.createSandbox);

    await expect(executeReplyRuntime({
      fs,
      event: event(),
      taskSearch: {
        tenantId: "techknight",
        workspaceId: "T_TECHKNIGHT",
        channelId: "C_MANA_TEST",
        projectCodes: "brainbase",
        taskSearchEnabled: "true",
        brainbaseApiBaseUrl: "https://bb.example.test",
        tenantCredentialFetchConfigured: true,
      },
      prepareRequester: async () => requester({
        requesterIdentity: { slackUserId: "U_USER", personId: "" },
      }),
      options,
    })).rejects.toMatchObject({ code: "requester_identity_not_found" });
    expect(createSandbox).not.toHaveBeenCalled();
  });
});
