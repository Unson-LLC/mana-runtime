import {
  auditReplyJudgmentAttempt,
  completeReplyJudgmentAttempt,
  failReplyJudgmentAttempt,
  isReplyJudgmentCompleted,
  parseReplyJudgmentStream,
  readReplyJudgmentEpisode,
  startReplyJudgmentAttempt,
} from "../reply-judgment.js";
import type { SlackQueueEvent } from "../types.js";

class MemoryFs {
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

const judgmentLine = "🧠 判断参照: 「質問」を参照 → 質問として回答 ✓";
const brainbaseLine = "📚 Brainbase参照先: 「質問」→ 採用: workspace_home ✓";
const zeroCallLine = "📚 Brainbase未参照: 必須参照なし・実呼び出し0回 ✓";
const secondBrainbaseLine = "📚 Brainbase参照先: 「追加質問」→ 採用: graph ✓";
const receiptPrefix = "__MANA_JUDGMENT_RECEIPT_V1__:";
const verifiedAnswerPrefix = "__MANA_VERIFIED_ANSWER_V1__:";

function hook(event: "UserPromptSubmit" | "PostToolUse" | "Stop", systemMessage: string, turn = "turn-1") {
  return {
    type: "system",
    subtype: "hook_response",
    hook_event: event,
    exit_code: 0,
    outcome: "success",
    session_id: "session-1",
    stdout: JSON.stringify({
      systemMessage: [systemMessage, `${receiptPrefix}${JSON.stringify({
        schema_version: "mana_judgment_hook_receipt.v1",
        hook_event_name: event,
        session_id: "session-1",
        turn_id: turn,
        host_receipt_id: "receipt-1",
        route_resolution_sha256: "a".repeat(64),
      })}`].filter(Boolean).join("\n"),
    }),
  };
}

function withoutPromptReceiptField(stdout: string, field: "host_receipt_id" | "route_resolution_sha256"): string {
  return stdout.split("\n").map((line) => {
    const event = JSON.parse(line);
    if (event.hook_event !== "UserPromptSubmit") return line;
    const output = JSON.parse(event.stdout);
    output.systemMessage = output.systemMessage.split("\n").map((line: string) => {
      if (!line.startsWith(receiptPrefix)) return line;
      const receipt = JSON.parse(line.slice(receiptPrefix.length));
      delete receipt[field];
      return `${receiptPrefix}${JSON.stringify(receipt)}`;
    }).join("\n");
    event.stdout = JSON.stringify(output);
    return JSON.stringify(event);
  }).join("\n");
}

function stream(options: {
  withTool?: boolean;
  toolCount?: number;
  stop?: boolean;
  turn?: string;
  replyLines?: string[];
} = {}): string {
  const events: unknown[] = [
    { type: "system", subtype: "init", session_id: "session-1" },
    hook("UserPromptSubmit", ""),
  ];
  const toolCount = options.toolCount ?? (options.withTool ? 1 : 0);
  const toolAuditLines = [brainbaseLine, secondBrainbaseLine];
  for (let index = 0; index < toolCount; index += 1) {
    const toolNumber = index + 1;
    events.push(
      { type: "assistant", session_id: "session-1", message: { content: [
        { type: "tool_use", id: `tool-${toolNumber}`, name: "mcp__brainbase__brainbase_knowledge_resolve", input: {} },
      ] } },
      hook("PostToolUse", toolAuditLines[index]!, options.turn),
      { type: "user", session_id: "session-1", message: { content: [
        { type: "tool_result", tool_use_id: `tool-${toolNumber}`, content: "{}" },
      ] } },
    );
  }
  if (options.stop !== false) {
    events.push(hook("Stop", [
      judgmentLine,
      ...(toolCount > 0 ? toolAuditLines.slice(0, toolCount) : [zeroCallLine]),
    ].join("\n"), options.turn));
  }
  events.push({
    type: "result",
    session_id: "session-1",
    result: (options.replyLines ?? [
      judgmentLine,
      ...(toolCount > 0 ? toolAuditLines.slice(0, toolCount) : [zeroCallLine]),
      "回答本文",
    ]).join("\n"),
  });
  return events.map((event) => JSON.stringify(event)).join("\n");
}

describe("Slack reply Judgment lifecycle", () => {
  it.each([
    ["\uFEFFnot-json", "reply_judgment_stream_invalid_bom"],
    ["\u001b[31mnot-json", "reply_judgment_stream_invalid_ansi"],
    ["notice {\"type\":\"result\"}", "reply_judgment_stream_invalid_json_prefixed"],
    ["{\"type\":\"result\"} notice", "reply_judgment_stream_invalid_json_suffixed"],
    ["not-json", "reply_judgment_stream_invalid_text"],
  ])("classifies invalid stream lines without exposing their contents", (line, code) => {
    expect(() => parseReplyJudgmentStream(line)).toThrow(code);
  });

  it("story-slack-mention-brainbase-judgment:ac:1 ac:2 ac:5 requires a complete Judgment lifecycle before reply", () => {
    expect(parseReplyJudgmentStream(stream())).toMatchObject({
      reply: `${judgmentLine}\n${zeroCallLine}\n回答本文`,
      sessionId: "session-1",
      turnId: "turn-1",
      userPromptSubmit: "completed",
      stop: "completed",
    });
    expect(() => parseReplyJudgmentStream(stream({ stop: false })))
      .toThrow("reply_judgment_lifecycle_incomplete");
    expect(() => parseReplyJudgmentStream(withoutPromptReceiptField(stream(), "host_receipt_id")))
      .toThrow("reply_judgment_route_receipt_missing");
    expect(() => parseReplyJudgmentStream(withoutPromptReceiptField(stream(), "route_resolution_sha256")))
      .toThrow("reply_judgment_route_receipt_missing");
  });

  it("preserves a safe Hook failure reason for production diagnosis", () => {
    const failedHook = JSON.stringify({
      type: "system",
      subtype: "hook_response",
      hook_event: "UserPromptSubmit",
      exit_code: 2,
      outcome: "error",
      stderr: "judgment_hook_http_401\nsecret-value-must-not-be-repeated",
    });
    expect(() => parseReplyJudgmentStream(failedHook))
      .toThrow("reply_judgment_hook_failed_judgment_hook_http_401");
  });

  it("ignores a PreToolUse rejection when the model recovers into a fully audited lifecycle", () => {
    const lines = stream({ withTool: true }).split("\n");
    const promptIndex = lines.findIndex((line) => line.includes('"hook_event":"UserPromptSubmit"'));
    lines.splice(promptIndex + 1, 0,
      JSON.stringify({
        type: "assistant", session_id: "session-1", message: { content: [{
          type: "tool_use", id: "blocked-tool", name: "mcp__brainbase__brainbase_knowledge_resolve", input: {},
        }] },
      }),
      JSON.stringify({
        type: "system", subtype: "hook_response", hook_event: "PreToolUse",
        exit_code: 2, outcome: "error", stderr: "judgment_resolve_turn_required_first",
      }),
    );

    expect(parseReplyJudgmentStream(lines.join("\n"))).toMatchObject({
      stop: "completed",
      toolJournal: [{ toolUseId: "tool-1", outcome: "success" }],
    });
  });

  it("ignores PostToolUse receipts for non-Brainbase tools", () => {
    const lines = stream({ withTool: true }).split("\n");
    const stopIndex = lines.findIndex((line) => line.includes('"hook_event":"Stop"'));
    lines.splice(stopIndex, 0,
      JSON.stringify({
        type: "assistant", session_id: "session-1", message: { content: [{
          type: "tool_use", id: "google-tool", name: "mcp__google_drive__search", input: {},
        }] },
      }),
      JSON.stringify(hook("PostToolUse", "", "turn-1")),
      JSON.stringify({
        type: "user", session_id: "session-1", message: { content: [{
          type: "tool_result", tool_use_id: "google-tool", content: "{}",
        }] },
      }),
    );

    expect(parseReplyJudgmentStream(lines.join("\n"))).toMatchObject({
      stop: "completed",
      toolJournal: [{ toolUseId: "tool-1", outcome: "success" }],
    });
  });

  it("does not count Judgment control-plane calls as Brainbase source reads", () => {
    const lines = stream().split("\n");
    const stopIndex = lines.findIndex((line) => line.includes('"hook_event":"Stop"'));
    lines.splice(stopIndex, 0,
      JSON.stringify({
        type: "assistant", session_id: "session-1", message: { content: [{
          type: "tool_use", id: "resolve-turn", name: "mcp__brainbase__brainbase_resolve_turn", input: {},
        }] },
      }),
      JSON.stringify(hook("PostToolUse", zeroCallLine, "turn-1")),
      JSON.stringify({
        type: "user", session_id: "session-1", message: { content: [{
          type: "tool_result", tool_use_id: "resolve-turn", content: "{}",
        }] },
      }),
      JSON.stringify({
        type: "assistant", session_id: "session-1", message: { content: [{
          type: "tool_use", id: "state-record", name: "mcp__brainbase__brainbase_judgment_state_record", input: {},
        }] },
      }),
      JSON.stringify(hook("PostToolUse", zeroCallLine, "turn-1")),
      JSON.stringify({
        type: "user", session_id: "session-1", message: { content: [{
          type: "tool_result", tool_use_id: "state-record", content: "{}",
        }] },
      }),
    );

    expect(parseReplyJudgmentStream(lines.join("\n"))).toMatchObject({
      stop: "completed",
      toolJournal: [],
      auditLines: [judgmentLine, zeroCallLine],
    });
  });

  it("story-slack-mention-brainbase-judgment:ac:3 ac:4 ac:6 preserves Host audit order and multiplicity", () => {
    const result = parseReplyJudgmentStream(stream({ toolCount: 2 }));
    expect(result.auditLines).toEqual([judgmentLine, brainbaseLine, secondBrainbaseLine]);
    expect(result.toolJournal).toEqual([
      {
        sequence: 1,
        toolUseId: "tool-1",
        toolName: "mcp__brainbase__brainbase_knowledge_resolve",
        outcome: "success",
      },
      {
        sequence: 2,
        toolUseId: "tool-2",
        toolName: "mcp__brainbase__brainbase_knowledge_resolve",
        outcome: "success",
      },
    ]);
    expect(() => parseReplyJudgmentStream(stream({
      withTool: true,
      replyLines: [brainbaseLine, judgmentLine, "回答本文"],
    }))).toThrow("reply_judgment_audit_lines_mismatch");
    expect(() => parseReplyJudgmentStream(stream({
      withTool: true,
      replyLines: ["回答本文", judgmentLine, brainbaseLine],
    }))).toThrow("reply_judgment_audit_lines_not_leading");
    expect(() => parseReplyJudgmentStream(stream({ withTool: true, turn: "turn-2" })))
      .toThrow("reply_judgment_identity_mismatch");

    const missingAudit = stream({ toolCount: 2 }).split("\n")
      .filter((line) => !line.includes('"hook_event":"PostToolUse"') || !line.includes(secondBrainbaseLine))
      .join("\n");
    expect(() => parseReplyJudgmentStream(missingAudit)).toThrow("reply_judgment_tool_audit_mismatch");

    const stopBeforeSecondTool = stream({ toolCount: 2 }).split("\n");
    const stopIndex = stopBeforeSecondTool.findIndex((line) => line.includes('"hook_event":"Stop"'));
    const [stopEvent] = stopBeforeSecondTool.splice(stopIndex, 1);
    const secondToolIndex = stopBeforeSecondTool.findIndex((line) => line.includes('"id":"tool-2"'));
    stopBeforeSecondTool.splice(secondToolIndex, 0, stopEvent!);
    expect(() => parseReplyJudgmentStream(stopBeforeSecondTool.join("\n")))
      .toThrow("reply_judgment_event_order_invalid");
  });

  it("prepends trusted Stop audit lines when the model returns body only", () => {
    const result = parseReplyJudgmentStream(stream({ replyLines: ["受信しました"] }));
    expect(result.reply).toBe(`${judgmentLine}\n${zeroCallLine}\n受信しました`);
    expect(result.auditLines).toEqual([judgmentLine, zeroCallLine]);
  });

  it("recovers the Host-verified answer when Claude --print omits its result event", () => {
    const answer = `${judgmentLine}\n${zeroCallLine}\n回答本文`;
    const lines = stream({ replyLines: [answer] }).split("\n");
    const stopIndex = lines.findIndex((line) => line.includes('\"hook_event\":\"Stop\"'));
    const stopHook = JSON.parse(lines[stopIndex]!);
    const stopOutput = JSON.parse(stopHook.stdout);
    stopOutput.systemMessage += `\n${verifiedAnswerPrefix}${JSON.stringify({
      answer,
      answer_digest: "a".repeat(64),
    })}`;
    stopHook.stdout = JSON.stringify(stopOutput);
    lines[stopIndex] = JSON.stringify(stopHook);
    const withoutResult = lines.filter((line) => JSON.parse(line).type !== "result").join("\n");

    expect(parseReplyJudgmentStream(withoutResult)).toMatchObject({
      reply: answer,
      stop: "completed",
    });
  });

  it("uses the Host-verified Stop repair over Claude's stale result event", () => {
    const lines = stream({ replyLines: ["別の回答"] }).split("\n");
    const stopIndex = lines.findIndex((line) => line.includes('\"hook_event\":\"Stop\"'));
    const stopHook = JSON.parse(lines[stopIndex]!);
    const stopOutput = JSON.parse(stopHook.stdout);
    const hostAcceptedAnswer = `${judgmentLine}\n${zeroCallLine}\nHostが検証した回答`;
    stopOutput.systemMessage += `\n${verifiedAnswerPrefix}${JSON.stringify({
      answer: hostAcceptedAnswer,
      answer_digest: "b".repeat(64),
    })}`;
    stopHook.stdout = JSON.stringify(stopOutput);
    lines[stopIndex] = JSON.stringify(stopHook);

    expect(parseReplyJudgmentStream(lines.join("\n"))).toMatchObject({
      reply: hostAcceptedAnswer,
      stop: "completed",
    });
  });

  it("binds cumulative PostToolUse receipts without requiring Stop prose identity", () => {
    const lines = stream({ toolCount: 2, replyLines: ["回答本文"] }).split("\n");
    const firstPostToolIndex = lines.findIndex((line) => line.includes('"hook_event":"PostToolUse"'));
    const secondPostToolIndex = lines.findIndex((line, index) =>
      index > firstPostToolIndex && line.includes('"hook_event":"PostToolUse"'));
    const secondHook = JSON.parse(lines[secondPostToolIndex]!);
    const secondOutput = JSON.parse(secondHook.stdout);
    secondOutput.systemMessage = secondOutput.systemMessage.replace(
      secondBrainbaseLine,
      `${brainbaseLine}\n${secondBrainbaseLine}`,
    );
    secondHook.stdout = JSON.stringify(secondOutput);
    lines[secondPostToolIndex] = JSON.stringify(secondHook);

    const result = parseReplyJudgmentStream(lines.join("\n"));
    expect(result.auditLines).toEqual([judgmentLine, brainbaseLine, secondBrainbaseLine]);
  });

  it("accepts a completed Stop summary when every tool call has its own PostToolUse receipt", () => {
    const lines = stream({ toolCount: 2, replyLines: ["回答本文"] }).split("\n");
    const stopIndex = lines.findIndex((line) => line.includes('"hook_event":"Stop"'));
    const stopHook = JSON.parse(lines[stopIndex]!);
    const stopOutput = JSON.parse(stopHook.stdout);
    stopOutput.systemMessage = stopOutput.systemMessage.replace(`\n${secondBrainbaseLine}`, "");
    stopHook.stdout = JSON.stringify(stopOutput);
    lines[stopIndex] = JSON.stringify(stopHook);

    const result = parseReplyJudgmentStream(lines.join("\n"));
    expect(result.auditLines).toEqual([judgmentLine, brainbaseLine]);
    expect(result.toolJournal).toHaveLength(2);
  });

  it("fails closed when Stop reports an incomplete audit despite a bound PostToolUse receipt", () => {
    const lines = stream({ withTool: true, replyLines: ["回答本文"] }).split("\n");
    const stopIndex = lines.findIndex((line) => line.includes('"hook_event":"Stop"'));
    const stopHook = JSON.parse(lines[stopIndex]!);
    const stopOutput = JSON.parse(stopHook.stdout);
    stopOutput.systemMessage = stopOutput.systemMessage
      .replace(brainbaseLine, "📚 Brainbase監査未完了: 参照有無を確認できず（不在確定ではない）");
    stopHook.stdout = JSON.stringify(stopOutput);
    lines[stopIndex] = JSON.stringify(stopHook);

    expect(() => parseReplyJudgmentStream(lines.join("\n")))
      .toThrow("reply_judgment_audit_lines_missing");
  });

  it("fails closed when an empty Stop response has no bound PostToolUse receipt", () => {
    const lines = stream({ replyLines: ["回答本文"] }).split("\n");
    const stopIndex = lines.findIndex((line) => line.includes('"hook_event":"Stop"'));
    const stopHook = JSON.parse(lines[stopIndex]!);
    const stopOutput = JSON.parse(stopHook.stdout);
    stopOutput.systemMessage = stopOutput.systemMessage
      .replace(zeroCallLine, "📚 Brainbase監査未完了: 参照有無を確認できず（不在確定ではない）");
    stopHook.stdout = JSON.stringify(stopOutput);
    lines[stopIndex] = JSON.stringify(stopHook);

    expect(() => parseReplyJudgmentStream(lines.join("\n")))
      .toThrow("reply_judgment_audit_lines_missing");
  });

  it("rejects a PostToolUse event without a completed Brainbase receipt", () => {
    const lines = stream({ withTool: true }).split("\n");
    const postToolIndex = lines.findIndex((line) => line.includes('"hook_event":"PostToolUse"'));
    const postToolHook = JSON.parse(lines[postToolIndex]!);
    const postToolOutput = JSON.parse(postToolHook.stdout);
    postToolOutput.systemMessage = postToolOutput.systemMessage.replace(
      brainbaseLine,
      "📚 Brainbase監査未完了: 参照有無を確認できず（不在確定ではない）",
    );
    postToolHook.stdout = JSON.stringify(postToolOutput);
    lines[postToolIndex] = JSON.stringify(postToolHook);
    expect(() => parseReplyJudgmentStream(lines.join("\n")))
      .toThrow("reply_judgment_tool_audit_mismatch");
  });

  it("story-slack-mention-brainbase-judgment:ac:7 stores a redacted durable episode receipt through Slack completion", async () => {
    const fs = new MemoryFs();
    const event = {
      tenantId: "mana",
      eventId: "Ev1",
      workspaceId: "T1",
      channelId: "C1",
      threadTs: "1.1",
      messageTs: "1.2",
      eventType: "app_mention",
      text: "保存してはいけない本文",
      receivedAt: "2026-08-17T00:00:00.000Z",
    } satisfies SlackQueueEvent;
    const attemptId = await startReplyJudgmentAttempt(fs, event, "2026-08-17T00:00:01.000Z");
    const result = parseReplyJudgmentStream(stream({ withTool: true }));
    await auditReplyJudgmentAttempt(fs, event.eventId, attemptId, result, "2026-08-17T00:00:02.000Z");
    expect(await isReplyJudgmentCompleted(fs, event.eventId)).toBe(false);
    await completeReplyJudgmentAttempt(fs, event.eventId, attemptId, "1.3", "2026-08-17T00:00:03.000Z");
    expect(await isReplyJudgmentCompleted(fs, event.eventId)).toBe(true);
    expect(await readReplyJudgmentEpisode(fs, event.eventId)).toMatchObject({
      eventId: "Ev1",
      attempts: [{ status: "completed", responseTs: "1.3" }],
    });
    const persisted = fs.files.get("/judgment-episodes/Ev1.json")!;
    expect(JSON.parse(persisted)).toMatchObject({
      eventId: "Ev1",
      workspaceId: "T1",
      attempts: [{ status: "completed", brainbaseTurnId: "turn-1", responseTs: "1.3" }],
    });
    expect(persisted).not.toContain(event.text);
  });

  it("story-slack-mention-brainbase-judgment:ac:8 keeps retry history without duplicate completion", async () => {
    const fs = new MemoryFs();
    const event = {
      tenantId: "mana",
      eventId: "EvRetry",
      workspaceId: "T1",
      channelId: "C1",
      threadTs: "1.1",
      messageTs: "1.2",
      eventType: "app_mention",
      text: "retry",
      receivedAt: "2026-08-17T00:00:00.000Z",
    } satisfies SlackQueueEvent;
    const first = await startReplyJudgmentAttempt(fs, event, "2026-08-17T00:00:01.000Z");
    await failReplyJudgmentAttempt(fs, event.eventId, first, "reply_judgment_hook_failed",
      "2026-08-17T00:00:02.000Z");
    const second = await startReplyJudgmentAttempt(fs, event, "2026-08-17T00:00:03.000Z");
    expect(second).not.toBe(first);
    const persisted = JSON.parse(fs.files.get("/judgment-episodes/EvRetry.json")!);
    expect(persisted.attempts).toMatchObject([
      { attemptId: first, status: "failed", failureCode: "reply_judgment_hook_failed" },
      { attemptId: second, status: "started" },
    ]);
  });

  it("rejects reuse of an event id across tenant boundaries", async () => {
    const fs = new MemoryFs();
    const event = {
      tenantId: "tenant-a",
      eventId: "EvTenantBoundary",
      workspaceId: "T1",
      channelId: "C1",
      threadTs: "1.1",
      messageTs: "1.2",
      eventType: "app_mention",
      text: "tenant boundary",
      receivedAt: "2026-08-17T00:00:00.000Z",
    } satisfies SlackQueueEvent;
    await startReplyJudgmentAttempt(fs, event, "2026-08-17T00:00:01.000Z");

    await expect(startReplyJudgmentAttempt(
      fs,
      { ...event, tenantId: "tenant-b" },
      "2026-08-17T00:00:02.000Z",
    )).rejects.toThrow("reply_judgment_episode_identity_mismatch");
  });
});
