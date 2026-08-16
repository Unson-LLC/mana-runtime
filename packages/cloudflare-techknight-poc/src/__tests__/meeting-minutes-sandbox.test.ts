import { classifyMeetingMinutesDestinationInSandbox, generateMeetingMinutesInSandbox,
  parseAuditedGeneratedMeetingMinutesOutput, parseGeneratedMeetingMinutesOutput,
  parseMeetingMinutesRoutingOutput } from "../meeting-minutes-generator.js";

const destinations = [
  { id: "sales-tailor", projectId: "proj_salestailor", contextProjectCode: "salestailor",
    taskProjectCodes: ["salestailor"], taskBoardTargetId: "minutes-salestailor", name: "SalesTailor",
    organization: { id: "unson", name: "雲孫" }, slackChannelId: "C1", github: { owner: "o", repo: "r" } },
  { id: "united", projectId: "proj_united", contextProjectCode: "techknight",
    taskProjectCodes: ["techknight"], taskBoardTargetId: "minutes-united", name: "United",
    organization: { id: "tech-knight", name: "Tech Knight" }, slackChannelId: "C2", github: { owner: "o", repo: "r2" } },
];
const context = { schema_version: "meeting_minutes_context_receipt.v1" as const, receipt_id: "mmctx_1",
  identity: { run_id: "Ev1_F1", project_code: "unson", transcript_sha256: "a".repeat(64) },
  status: "resolved" as const, checksum: "b".repeat(64), resolved_at: "2026-08-15T00:00:00.000Z",
  context: { source_refs: [{ type: "graph_entity", id: "project-1" }],
    open_tasks: [{ id: "task-1", title: "未完了の正本タスク" }] } };
const auditOutput = { used_source_refs: [{ type: "graph_entity", id: "project-1" }],
  decision_candidates: [] };
function auditedStream(minutes: Record<string, unknown>, options: { receipt?: unknown; hook?: boolean;
  input?: Record<string, unknown>; resultSession?: string; toolResultSession?: string;
  hookBeforeResult?: boolean; hookSession?: string } = {}): string {
  const input = options.input ?? { receipt_id: context.receipt_id, ...context.identity };
  const hook = { type: "system", subtype: "hook_response", hook_event: "PostToolUse",
    exit_code: 0, outcome: "success", stdout: "Brainbase tool use recorded",
    ...(options.hookSession ? { session_id: options.hookSession } : {}) };
  const toolResult = { type: "user", session_id: options.toolResultSession ?? "session-1",
    message: { content: [{ type: "tool_result", tool_use_id: "tool-1",
      content: JSON.stringify(options.receipt ?? { status: "ok", receipt: context }) }] } };
  const auditedEvents = options.hook === false ? [toolResult]
    : options.hookBeforeResult === false ? [toolResult, hook] : [hook, toolResult];
  return [
    { type: "system", subtype: "init", session_id: "session-1" },
    { type: "assistant", session_id: "session-1", message: { content: [{ type: "tool_use", id: "tool-1",
      name: "mcp__brainbase__brainbase_get_meeting_minutes_context", input }] } },
    ...auditedEvents,
    { type: "result", structured_output: minutes, session_id: options.resultSession ?? "session-1" },
  ].map((event) => JSON.stringify(event)).join("\n");
}

function receiptBoundStream(minutes: Record<string, unknown>): string {
  return [
    { type: "system", subtype: "init", session_id: "session-1" },
    { type: "result", structured_output: minutes, session_id: "session-1" },
  ].map((event) => JSON.stringify(event)).join("\n");
}

describe("generateMeetingMinutesInSandbox", () => {
  it("injects the validated Brainbase Receipt context without requiring a model-initiated MCP call", async () => {
    const sandbox = { writeFile: vi.fn(), exec: vi.fn().mockResolvedValue({ success: true,
      stdout: receiptBoundStream({ title: "定例", overview: "概要", body: "本文", tasks: [
        { title: "請求書を送る", description: "会議で合意", priority: "high", due_at: "2026-08-20" },
      ], ...auditOutput }), stderr: "" }), destroy: vi.fn().mockResolvedValue(undefined) };
    await expect(generateMeetingMinutesInSandbox("transcript", destinations[0]!, context, "required",
      { model: "opus", effort: "xhigh" }, sandbox))
      .resolves.toEqual({ title: "定例", overview: "概要", body: "本文", tasks: [
        { title: "請求書を送る", description: "会議で合意", priority: "high", due_at: "2026-08-20T00:00:00+09:00" },
      ], used_source_refs: [{ type: "graph_entity", id: "project-1" }],
      brainbase_context_attestation: expect.objectContaining({
        schema_version: "meeting_minutes_context_attestation.v2",
        source: "worker_context_receipt", receipt_id: "mmctx_1", session_id: "session-1",
      }) });
    expect(sandbox.writeFile).toHaveBeenCalledWith("/tmp/meeting-minutes-prompt.txt", expect.stringContaining("transcript"));
    expect(sandbox.writeFile).toHaveBeenCalledWith(
      "/tmp/meeting-minutes-prompt.txt",
      expect.stringContaining("narrative_minutes.v1"),
    );
    expect(sandbox.writeFile).toHaveBeenCalledWith(
      "/tmp/meeting-minutes-prompt.txt",
      expect.stringContaining("アクションアイテムの唯一の正本はtasks"),
    );
    const prompt = String(sandbox.writeFile.mock.calls.find((call) => call[0] === "/tmp/meeting-minutes-prompt.txt")?.[1]);
    expect(prompt).toContain("1段落・3〜5文・200〜400字");
    expect(prompt).not.toContain('"title":"YYYY-MM-DD 会議トピック-要約"');
    expect(prompt).not.toContain('"overview":"1段落・3〜5文の短い概要"');
    expect(prompt).toContain("見本・説明文・型の選択肢を値として出力してはいけません");
    expect(prompt).not.toContain("bodyの最後には必ず「*アクションアイテム*」");
    expect(prompt).not.toContain("brainbase_get_meeting_minutes_contextを必ず1回呼び");
    expect(prompt).toContain(`receipt_id=${context.receipt_id}`);
    expect(prompt).toContain('"id":"project-1"');
    expect(prompt).toContain('"title":"未完了の正本タスク"');
    expect(prompt).toContain("Receipt IDとchecksumはWorkerが正規Receiptから付与します");
    expect(prompt).not.toContain('"brainbase_context_receipt_id"');
    expect(prompt).toContain("project_code=unson");
    expect(prompt).not.toContain("project_code=proj_salestailor");
    expect(sandbox.writeFile).toHaveBeenCalledWith(
      "/tmp/meeting-minutes-prompt.txt",
      expect.stringContaining("必須キーはtitle、overview、body、tasks"),
    );
    expect(sandbox.writeFile).toHaveBeenCalledWith(
      "/tmp/mana-meeting-minutes-mcp.json",
      expect.stringContaining('"brainbase"'),
    );
    expect(sandbox.exec).toHaveBeenCalledWith(expect.stringContaining("< /tmp/meeting-minutes-prompt.txt"),
      expect.objectContaining({
        timeout: 600_000,
        env: { IS_SANDBOX: "1", CLAUDE_CODE_OAUTH_TOKEN: "proxy-injected" },
      }));
    expect(sandbox.exec).toHaveBeenCalledWith(expect.stringContaining("--output-format stream-json --verbose --include-hook-events --json-schema"),
      expect.any(Object));
    expect(sandbox.destroy).toHaveBeenCalled();
  });

  it("fails closed before Claude when the canonical Receipt context exceeds the prompt boundary", async () => {
    const oversizedContext = {
      ...context,
      context: { ...context.context, source_refs: [
        { type: "graph_entity", id: "x".repeat(100_001) },
      ] },
    };
    const sandbox = { writeFile: vi.fn(), exec: vi.fn(), destroy: vi.fn().mockResolvedValue(undefined) };

    await expect(generateMeetingMinutesInSandbox("transcript", destinations[0]!, oversizedContext, "required",
      { model: "opus", effort: "xhigh" }, sandbox))
      .rejects.toThrow("meeting_minutes_brainbase_context_prompt_too_large");
    expect(sandbox.exec).not.toHaveBeenCalled();
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });
  it("destroys the Sandbox and rejects invalid model output", async () => {
    const sandbox = { writeFile: vi.fn(), exec: vi.fn().mockResolvedValue({ success: true,
      stdout: auditedStream({ title: "", overview: "", body: "", tasks: [] }), stderr: "" }),
    destroy: vi.fn().mockResolvedValue(undefined) };
    await expect(generateMeetingMinutesInSandbox("transcript", destinations[0]!, context, "required",
      { model: "opus", effort: "xhigh" }, sandbox))
      .rejects.toThrow("meeting_minutes_generation_invalid");
    expect(sandbox.destroy).toHaveBeenCalled();
  });

  it("fails closed unless the exact Brainbase call, Receipt, and PostToolUse audit are all present", () => {
    const minutes = { title: "定例", overview: "概要", body: "本文", tasks: [], ...auditOutput };
    expect(() => parseAuditedGeneratedMeetingMinutesOutput(
      JSON.stringify({ type: "result", structured_output: minutes, session_id: "session-1" }), context,
    )).toThrow("meeting_minutes_brainbase_tool_not_called");
    expect(() => parseAuditedGeneratedMeetingMinutesOutput(auditedStream(minutes, {
      input: { receipt_id: "wrong", ...context.identity },
    }), context)).toThrow("meeting_minutes_brainbase_tool_input_mismatch");
    expect(() => parseAuditedGeneratedMeetingMinutesOutput(auditedStream(minutes, {
      receipt: { ...context, checksum: "wrong" },
    }), context)).toThrow("meeting_minutes_brainbase_tool_result_mismatch");
    expect(() => parseAuditedGeneratedMeetingMinutesOutput(auditedStream(minutes, { hook: false }), context))
      .toThrow("meeting_minutes_brainbase_post_tool_use_not_audited");
  });

  it("rejects unrelated Brainbase calls, failed results, empty audits, and mixed sessions", () => {
    const minutes = { title: "定例", overview: "概要", body: "本文", tasks: [], ...auditOutput };
    const unrelated = auditedStream(minutes).replace(
      "mcp__brainbase__brainbase_get_meeting_minutes_context", "mcp__brainbase__search",
    );
    expect(() => parseAuditedGeneratedMeetingMinutesOutput(unrelated, context))
      .toThrow("meeting_minutes_brainbase_tool_input_mismatch");
    const failedResult = auditedStream(minutes).replace('"type":"tool_result"', '"type":"tool_result","is_error":true');
    expect(() => parseAuditedGeneratedMeetingMinutesOutput(failedResult, context))
      .toThrow("meeting_minutes_brainbase_tool_result_mismatch");
    const emptyAudit = auditedStream(minutes).replace('"stdout":"Brainbase tool use recorded"', '"stdout":""');
    expect(() => parseAuditedGeneratedMeetingMinutesOutput(emptyAudit, context))
      .toThrow("meeting_minutes_brainbase_post_tool_use_not_audited");
    const mixedSession = auditedStream(minutes, { hookSession: "session-2" });
    expect(() => parseAuditedGeneratedMeetingMinutesOutput(mixedSession, context))
      .toThrow("meeting_minutes_brainbase_session_mismatch");
    const mixedResultSession = auditedStream(minutes, { resultSession: "session-2" });
    expect(() => parseAuditedGeneratedMeetingMinutesOutput(mixedResultSession, context))
      .toThrow("meeting_minutes_brainbase_session_mismatch");
    const mixedToolResultSession = auditedStream(minutes, { toolResultSession: "session-2" });
    expect(() => parseAuditedGeneratedMeetingMinutesOutput(mixedToolResultSession, context))
      .toThrow("meeting_minutes_brainbase_session_mismatch");
  });

  it("accepts PostToolUse immediately before or after the matching tool result", () => {
    const minutes = { title: "定例", overview: "概要", body: "本文", tasks: [], ...auditOutput };
    expect(parseAuditedGeneratedMeetingMinutesOutput(auditedStream(minutes), context))
      .toEqual(expect.objectContaining({ title: "定例" }));
    expect(parseAuditedGeneratedMeetingMinutesOutput(auditedStream(minutes, { hookBeforeResult: false }), context))
      .toEqual(expect.objectContaining({ title: "定例" }));
  });

  it("recovers JSON from Claude prose and a markdown fence", () => {
    expect(parseGeneratedMeetingMinutesOutput([
      "議事録を作成しました。", "```json",
      JSON.stringify({ title: "定例", overview: "概要", body: "本文", tasks: [] }),
      "```",
    ].join("\n"))).toEqual({ title: "定例", overview: "概要", body: "本文", tasks: [] });
  });

  it("accepts Claude JSON envelopes and omitted empty tasks", () => {
    expect(parseGeneratedMeetingMinutesOutput(JSON.stringify({
      type: "result", result: JSON.stringify({ title: "定例", overview: "概要", body: "本文" }),
    }))).toEqual({ title: "定例", overview: "概要", body: "本文", tasks: [] });
    expect(parseGeneratedMeetingMinutesOutput(JSON.stringify({
      structured_output: { title: "定例", overview: "概要", body: "本文", tasks: [] },
    }))).toEqual({ title: "定例", overview: "概要", body: "本文", tasks: [] });
  });

  it("rejects the production prompt example when it is copied as meeting minutes", () => {
    expect(() => parseGeneratedMeetingMinutesOutput(JSON.stringify({
      title: "YYYY-MM-DD 会議トピック-要約",
      overview: "1段落・3〜5文の短い概要",
      body: "区切り線とトピック別の物語的本文。アクションアイテム一覧は含めない",
      tasks: [{
        title: "実行内容",
        description: "会議で確認できた背景",
        assignee_name: "文字起こしで明示された担当者名。未確認なら省略",
        priority: "low|medium|high|urgent",
        due_at: "YYYY-MM-DD",
      }],
      used_source_refs: [],
      decision_candidates: [],
    }))).toThrow("meeting_minutes_generation_placeholder_output");
  });

  it("enforces the overview hard limit and strips a legacy action-item tail", () => {
    const minutes = parseGeneratedMeetingMinutesOutput(JSON.stringify({
      title: "定例", overview: "あ".repeat(601),
      body: "------------\n議論本文\n\n*アクションアイテム*\n- 重複タスク", tasks: [{ title: "正本タスク" }],
    }));
    expect(minutes.overview).toHaveLength(600);
    expect(minutes.body).toBe("------------\n議論本文");
    expect(minutes.tasks).toEqual([{ title: "正本タスク" }]);
  });
});

describe("classifyMeetingMinutesDestinationInSandbox", () => {
  it("accepts only a configured project and preserves the reason", () => {
    expect(parseMeetingMinutesRoutingOutput('{"projectId":"proj_salestailor","reason":"商談内容が一致"}', destinations))
      .toEqual({ destinationId: "sales-tailor", reason: "商談内容が一致" });
    expect(parseMeetingMinutesRoutingOutput('{"projectId":"unknown","reason":"候補外"}', destinations)).toBeNull();
    expect(parseMeetingMinutesRoutingOutput('{"projectId":"不明","reason":"判断不能"}', destinations)).toBeNull();
  });

  it("neutralizes Slack mentions, active links, and control characters in the routing reason", () => {
    expect(parseMeetingMinutesRoutingOutput(
      '{"projectId":"proj_salestailor","reason":"<!channel> <@U123> <https://evil.test>\\u0007"}', destinations,
    )).toEqual({ destinationId: "sales-tailor",
      reason: "&lt;!channel> &lt;@U123> &lt;https://evil.test> " });
  });

  it("classifies a bounded transcript in an isolated Sandbox", async () => {
    const sandbox = { writeFile: vi.fn(), exec: vi.fn().mockResolvedValue({ success: true,
      stdout: '{"projectId":"proj_united","reason":"ホテルUnitedの定例"}', stderr: "" }),
    destroy: vi.fn().mockResolvedValue(undefined) };
    await expect(classifyMeetingMinutesDestinationInSandbox("transcript", destinations,
      { model: "opus", effort: "xhigh" }, sandbox))
      .resolves.toEqual({ destinationId: "united", reason: "ホテルUnitedの定例" });
    expect(sandbox.writeFile).toHaveBeenCalledWith("/tmp/meeting-minutes-prompt.txt",
      expect.stringContaining("候補のどれとも確信を持って一致しない場合"));
    expect(sandbox.exec).toHaveBeenCalledWith(expect.stringContaining("< /tmp/meeting-minutes-prompt.txt"),
      expect.objectContaining({ timeout: 60_000 }));
    expect(sandbox.exec).toHaveBeenCalledWith(expect.stringContaining('"required":["projectId","reason"]'),
      expect.any(Object));
    expect(sandbox.destroy).toHaveBeenCalled();
  });
});
