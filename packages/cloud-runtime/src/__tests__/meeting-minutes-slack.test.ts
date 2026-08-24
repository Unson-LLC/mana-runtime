import { immediateStatusFailedMessage, interactionActionFailedMessage, interactionEnqueueFailedMessage,
  selectionConfirmationFailedMessage, statusProjectionFailedMessage, tenantInteractionFailedMessage,
  threadCoordinateMissingMessage, MeetingMinutesSlackClient, redoFailedMessage } from "../meeting-minutes-slack.js";
import { meetingMinutesTaskActionFailure } from "../meeting-minutes-contracts.js";
import { deriveCorrelationId } from "../multitenancy/ids.js";

describe("MeetingMinutesSlackClient", () => {
  it("derives a stable inquiry id from the same run, stage, and code", () => {
    const first = deriveCorrelationId("run-42", "status_projection", "STATUS_PROJECTION_FAILED");
    expect(first).toBe(deriveCorrelationId("run-42", "status_projection", "STATUS_PROJECTION_FAILED"));
    expect(first).not.toBe(deriveCorrelationId("run-42", "task_action", "STATUS_PROJECTION_FAILED"));
    expect(first).toMatch(/^cor_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it.each([
    ["thread", () => threadCoordinateMissingMessage("run-42", "meeting.txt")],
    ["immediate", () => immediateStatusFailedMessage("run-42", "meeting.txt")],
    ["selection", () => selectionConfirmationFailedMessage("run-42", "meeting.txt")],
    ["status", () => statusProjectionFailedMessage("run-42", "meeting.txt")],
    ["redo", () => redoFailedMessage("run-42", "meeting.txt")],
    ["enqueue", () => interactionEnqueueFailedMessage("run-42", "meeting.txt")],
    ["tenant", () => tenantInteractionFailedMessage("run-42", "meeting.txt", {
      code: "temporary_failure", message_key: "tenant.temporary_failure", next_actions: ["retry_later"],
      correlation_id: "cor_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    })],
    ["action", () => interactionActionFailedMessage("run-42", "meeting.txt", {
      code: "temporary_failure", message_key: "tenant.temporary_failure", next_actions: ["retry_later"],
      correlation_id: "cor_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    })],
  ])("includes a deterministic inquiry id on the %s failure path", (_name, makeMessage) => {
    const serialized = JSON.stringify(makeMessage());
    expect(serialized).toMatch(/問い合わせID: cor_[0-9A-HJKMNP-TV-Z]{26}/);
  });

  it("shows a stable error code and run id when a button request cannot be queued", () => {
    const message = interactionEnqueueFailedMessage("run-42", "meeting.txt");
    const serialized = JSON.stringify(message);
    expect(serialized).toContain("処理ID: run-42");
    expect(serialized).toContain("失敗段階: 処理受付");
    expect(serialized).toContain("エラーコード: INTERACTION_ENQUEUE_FAILED");
  });

  it("prefers projection failure diagnostics when Slack status projection fails", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)); return Response.json({ ok: true });
    }) as typeof fetch;
    const run = { ...routedRun(), status: "failed" as const,
      diagnostics: { schemaVersion: "meeting_minutes_diagnostics.v1" as const, stage: "github_save" as const,
        code: "GITHUB_SAVE_FAILED", retryable: false, failedAt: "2026-08-18T00:00:00.000Z" },
      projectionFailure: { stage: "status_projection" as const, code: "STATUS_PROJECTION_FAILED",
        retryable: true, failedAt: "2026-08-18T00:01:00.000Z" } };
    await new MeetingMinutesSlackClient("token", fetchImpl).updateRunStatus(run, "failed");
    expect(JSON.stringify(body)).toContain("エラーコード: STATUS_PROJECTION_FAILED");
    expect(JSON.stringify(body)).toMatch(/問い合わせID: cor_[0-9A-HJKMNP-TV-Z]{26}/);
    expect(JSON.stringify(body)).toContain("mana_meeting_minutes_choose_destination:mana");
  });
  const routedRun = () => ({ version: 1 as const, runId: "run-1", eventId: "Ev1", workspaceId: "T1", sourceChannelId: "C1",
    sourceThreadTs: "1.0", sourceMessageTs: "1.0", file: { id: "F1", name: "meeting.txt", mimetype: "text/plain", size: 10 },
    status: "completed" as const, destination: { id: "mana", projectId: "mana", contextProjectCode: "mana",
      taskProjectCodes: ["mana"], taskBoardTargetId: "minutes-mana", name: "mana",
      organization: { id: "unson", name: "雲孫" }, slackChannelId: "C2",
      github: { owner: "o", repo: "r" } }, github: { transcriptPath: "t", minutesPath: "m", transcriptUrl: "tu",
      minutesUrl: "https://github.test/minutes" }, context: { receiptId: "receipt-1", checksum: "checksum-1",
      status: "resolved" as const, mode: "required" as const, sourceRefs: [], resolvedAt: "2026-08-15T00:00:00.000Z" },
    slack: { selectionTs: "2.1", processingTs: "3.1", postedChunkIndexes: [] },
    createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z" });

  it("clears the assistant status and updates the selector with a durable completed result", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) }); return Response.json({ ok: true });
    }) as typeof fetch;
    await new MeetingMinutesSlackClient("token", fetchImpl).updateRunStatus(routedRun(), "completed");
    expect(calls[0]).toEqual({ url: "https://slack.com/api/assistant.threads.setStatus",
      body: { channel_id: "C1", thread_ts: "1.0", status: "" } });
    expect(calls[1]?.url).toBe("https://slack.com/api/chat.update");
    expect(calls[1]?.body).toMatchObject({ channel: "C1", ts: "3.1" });
    expect(JSON.stringify(calls[1]?.body)).toContain("議事録を作成しました");
    expect(JSON.stringify(calls[1]?.body)).toContain("https://github.test/minutes");
    expect(JSON.stringify(calls[1]?.body)).toContain("Brainbase正本文脈: 参照済み");
    expect(JSON.stringify(calls[1]?.body)).toContain("receipt-1");
    expect(JSON.stringify(calls[1]?.body)).not.toContain("再実行");
    expect(JSON.stringify(calls[1]?.body)).toContain("保存先をやり直す");
  });

  it("shows when unknown Brainbase references were removed in observe mode", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)); return Response.json({ ok: true });
    }) as typeof fetch;
    const run = { ...routedRun(), generated: { title: "定例", overview: "概要", body: "本文",
      brainbase_context_warnings: ["unknown_source_ref_removed" as const] } };
    await new MeetingMinutesSlackClient("token", fetchImpl).updateRunStatus(run, "completed");
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("Brainbaseの正本にない参照候補を除外し、正本の参照だけで作成しました");
    expect(serialized).not.toContain("unknown_source_ref_removed");
  });

  it("shows processing feedback with the Slack assistant thread status", async () => {
    let call: { url: string; body: Record<string, unknown>; signal?: AbortSignal | null } | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      call = { url: String(input), body: JSON.parse(String(init?.body)), signal: init?.signal };
      return Response.json({ ok: true });
    }) as typeof fetch;
    await new MeetingMinutesSlackClient("token", fetchImpl).showProcessingStatus("C1", "1.0", "PMS");
    expect(call?.url).toBe("https://slack.com/api/assistant.threads.setStatus");
    expect(call?.body).toMatchObject({ channel_id: "C1", thread_ts: "1.0" });
    expect(JSON.stringify(call?.body)).toContain("議事録を作成しています");
    expect(JSON.stringify(call?.body)).toContain("PMS");
    expect(call?.signal).toBeInstanceOf(AbortSignal);
  });

  it("explains an intake pause in the source thread", async () => {
    let call: { url: string; body: Record<string, unknown> } | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      call = { url: String(input), body: JSON.parse(String(init?.body)) };
      return Response.json({ ok: true });
    }) as typeof fetch;
    await new MeetingMinutesSlackClient("token", fetchImpl).postIntakePaused("C1", "1.0");
    expect(call?.url).toBe("https://slack.com/api/chat.postMessage");
    expect(call?.body).toMatchObject({ channel: "C1", thread_ts: "1.0" });
    expect(JSON.stringify(call?.body)).toContain("議事録の新規受付は一時停止中です");
    expect(JSON.stringify(call?.body)).toContain("復旧後にファイルを投稿し直してください");
  });

  it("derives the router intake inquiry id from the event id and uses a deterministic fallback", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    }) as typeof fetch;
    const client = new MeetingMinutesSlackClient("token", fetchImpl);
    await client.postIntakePaused("C1", "1.0", "event-1");
    await client.postIntakePaused("C1", "1.0");
    const eventText = String(bodies[0]?.text);
    const fallbackText = String(bodies[1]?.text);
    expect(eventText).toContain(`問い合わせID: ${deriveCorrelationId("event-1", "intake", "INTAKE_PAUSED")}`);
    expect(eventText).not.toContain(deriveCorrelationId("C1:1.0", "intake", "INTAKE_PAUSED"));
    expect(fallbackText).toContain(`問い合わせID: ${deriveCorrelationId("legacy-intake:C1:1.0", "intake", "INTAKE_PAUSED")}`);
    expect(fallbackText).toMatch(/問い合わせID: cor_[0-9A-HJKMNP-TV-Z]{26}/);
  });

  it("explains a blocked queued command privately to the operator", async () => {
    let call: { url: string; body: Record<string, unknown> } | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      call = { url: String(input), body: JSON.parse(String(init?.body)) };
      return Response.json({ ok: true });
    }) as typeof fetch;
    await new MeetingMinutesSlackClient("token", fetchImpl).postIntakePausedToUser("C1", "U1");
    expect(call?.url).toBe("https://slack.com/api/chat.postEphemeral");
    expect(call?.body).toMatchObject({ channel: "C1", user: "U1" });
    expect(JSON.stringify(call?.body)).toContain("議事録の受付は一時停止中です");
    expect(JSON.stringify(call?.body)).toContain("保存先の選択またはやり直しをもう一度実行してください");
  });

  it("derives a queued command inquiry id from runId", async () => {
    let call: { url: string; body: Record<string, unknown> } | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      call = { url: String(input), body: JSON.parse(String(init?.body)) };
      return Response.json({ ok: true });
    }) as typeof fetch;
    await new MeetingMinutesSlackClient("token", fetchImpl)
      .postIntakePausedToUser("C1", "U1", "run-1");
    expect(String(call?.body.text)).toContain(`問い合わせID: ${deriveCorrelationId("run-1", "intake", "INTAKE_PAUSED")}`);
    expect(String(call?.body.text)).not.toContain(
      deriveCorrelationId("C1:U1", "intake", "INTAKE_PAUSED"),
    );
  });

  it("does not stop minutes processing when the optional assistant status is unavailable", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).includes("assistant.threads.setStatus")
      ? Response.json({ ok: false, error: "not_allowed" })
      : Response.json({ ok: true, ts: "3.1" })) as typeof fetch;
    await expect(new MeetingMinutesSlackClient("token", fetchImpl).postProcessingStatus(routedRun()))
      .resolves.toBe("3.1");
  });

  it("propagates a completion assistant status failure for durable lifecycle diagnostics", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).includes("assistant.threads.setStatus")
      ? Response.json({ ok: false, error: "not_allowed" })
      : Response.json({ ok: true })) as typeof fetch;
    await expect(new MeetingMinutesSlackClient("token", fetchImpl).updateRunStatus(routedRun(), "completed"))
      .rejects.toThrow("slack_api_failed:assistant.threads.setStatus:not_allowed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("explains a canonical task project scope mismatch to the operator", async () => {
    let call: { url: string; body: Record<string, unknown> } | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      call = { url: String(input), body: JSON.parse(String(init?.body)) };
      return Response.json({ ok: true });
    }) as typeof fetch;
    const run = { ...routedRun(), slack: { ...routedRun().slack, parentTs: "4.1" } };
    const failure = meetingMinutesTaskActionFailure(run.runId, "TASK_SCOPE_MISMATCH", false);
    await new MeetingMinutesSlackClient("token", fetchImpl).postTaskScopeMismatch(run, "U1", failure);
    expect(call?.url).toBe("https://slack.com/api/chat.postEphemeral");
    expect(call?.body).toMatchObject({ channel: "C2", thread_ts: "4.1", user: "U1" });
    expect(String(call?.body.text)).toContain("現在のBrainbaseプロジェクトに紐付いていない");
    expect(String(call?.body.text)).toContain("編集・取消できません");
    expect(String(call?.body.text)).toContain("処理ID: run-1");
    expect(String(call?.body.text)).toContain("失敗段階: タスク操作（task_action）");
    expect(String(call?.body.text)).toContain("エラーコード: TASK_SCOPE_MISMATCH");
    expect(String(call?.body.text)).toContain(`問い合わせID: ${failure.correlationId}`);
    expect(String(call?.body.text)).toContain("再試行可否: 不可");
    expect(String(call?.body.text)).toContain("再試行せず");
  });

  it.each([["edit", "編集"], ["cancel", "取消"]] as const)(
    "projects the typed retryable %s task action failure with its reporter correlation id",
    async (action, actionLabel) => {
      let call: { url: string; body: Record<string, unknown> } | undefined;
      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        call = { url: String(input), body: JSON.parse(String(init?.body)) };
        return Response.json({ ok: true });
      }) as typeof fetch;
      const run = { ...routedRun(), slack: { ...routedRun().slack, parentTs: "4.1" } };
      const failure = meetingMinutesTaskActionFailure(run.runId, "TASK_ACTION_FAILED", true);
      await new MeetingMinutesSlackClient("token", fetchImpl).postTaskActionFailure(run, "U1", action, failure);
      const text = String(call?.body.text);
      expect(text).toContain(`議事録タスクの${actionLabel}に失敗しました`);
      expect(text).toContain("処理ID: run-1");
      expect(text).toContain("失敗段階: タスク操作（task_action）");
      expect(text).toContain("エラーコード: TASK_ACTION_FAILED");
      expect(text).toContain(`問い合わせID: ${failure.correlationId}`);
      expect(text).toContain("再試行可否: 可能");
      expect(text).toContain("もう一度操作してください");
    },
  );

  it("does not expose a legacy raw failure string as a public inquiry id", async () => {
    let call: { url: string; body: Record<string, unknown> } | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      call = { url: String(input), body: JSON.parse(String(init?.body)) };
      return Response.json({ ok: true });
    }) as typeof fetch;
    const run = { ...routedRun(), slack: { ...routedRun().slack, parentTs: "4.1" } };
    const rawFailure = "Bearer super-secret-token";
    await new MeetingMinutesSlackClient("token", fetchImpl)
      .postTaskActionFailure(run, "U1", "edit", rawFailure);
    const text = String(call?.body.text);
    expect(text).not.toContain(rawFailure);
    expect(text).toContain(`問い合わせID: ${deriveCorrelationId(run.runId, "task_action", "TASK_ACTION_FAILED")}`);
    expect(text).toMatch(/問い合わせID: cor_[0-9A-HJKMNP-TV-Z]{26}/);
  });

  it("does not accept a well-formed but unrelated legacy inquiry id", async () => {
    let call: { url: string; body: Record<string, unknown> } | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      call = { url: String(input), body: JSON.parse(String(init?.body)) };
      return Response.json({ ok: true });
    }) as typeof fetch;
    const run = { ...routedRun(), slack: { ...routedRun().slack, parentTs: "4.1" } };
    const unrelatedCorrelationId = "cor_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    await new MeetingMinutesSlackClient("token", fetchImpl)
      .postTaskActionFailure(run, "U1", "edit", unrelatedCorrelationId);
    const text = String(call?.body.text);
    const expectedCorrelationId = deriveCorrelationId(run.runId, "task_action", "TASK_ACTION_FAILED");
    expect(text).toContain(`問い合わせID: ${expectedCorrelationId}`);
    expect(text).not.toContain(`問い合わせID: ${unrelatedCorrelationId}`);
  });

  it("posts processing as a second reply after the selector reply", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body))); return Response.json({ ok: true, ts: "3.1" });
    }) as typeof fetch;
    await expect(new MeetingMinutesSlackClient("token", fetchImpl).postProcessingStatus(routedRun()))
      .resolves.toBe("3.1");
    expect(bodies[1]).toMatchObject({ channel: "C1", thread_ts: "1.0" });
    expect(JSON.stringify(bodies[1])).toContain("議事録を作成中");
  });

  it("marks the old destination post as withdrawn and reopens the selector in the status reply", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body))); return Response.json({ ok: true });
    }) as typeof fetch;
    const client = new MeetingMinutesSlackClient("token", fetchImpl);
    await client.retractSharedMinutes("C2", "10.1", "meeting.txt");
    await expect(client.showDestinationSelection(routedRun(), [routedRun().destination])).resolves.toBe("3.1");
    expect(calls[0]).toMatchObject({ channel: "C2", ts: "10.1" });
    expect(JSON.stringify(calls[0])).toContain("取り消されました");
    expect(calls[1]).toMatchObject({ channel: "C1", ts: "3.1" });
    expect(JSON.stringify(calls[1])).toContain("組織を選択");
  });

  it("treats an already missing shared post as idempotently withdrawn", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: false, error: "message_not_found" })) as typeof fetch;
    const client = new MeetingMinutesSlackClient("token", fetchImpl);

    await expect(client.retractSharedMinutes("C2", "10.1", "meeting.txt")).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not hide other shared post retraction failures", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: false, error: "not_in_channel" })) as typeof fetch;
    const client = new MeetingMinutesSlackClient("token", fetchImpl);

    await expect(client.retractSharedMinutes("C2", "10.1", "meeting.txt"))
      .rejects.toThrow("slack_api_failed:chat.update:not_in_channel");
  });

  it("replaces a failed result with a retry button for the selected destination", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)); return Response.json({ ok: true });
    }) as typeof fetch;
    await new MeetingMinutesSlackClient("token", fetchImpl).updateRunStatus(routedRun(), "failed");
    expect(JSON.stringify(body)).toContain("議事録の作成に失敗しました");
    expect(JSON.stringify(body)).toContain("mana_meeting_minutes_choose_destination:mana");
    expect(JSON.stringify(body)).toContain("再実行");
    expect(JSON.stringify(body)).toContain("失敗段階: 不明（旧形式）");
    expect(JSON.stringify(body)).not.toContain("失敗段階: 状態表示");
    expect(JSON.stringify(body)).toContain('\\"sourceThreadTs\\":\\"1.0\\"');
  });

  it("shows safe same-run diagnostics for an unclassified failure without exposing the raw error", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)); return Response.json({ ok: true });
    }) as typeof fetch;
    const run = { ...routedRun(), status: "failed" as const,
      failure: { stage: "routed", message: "Authorization: Bearer secret-value raw upstream response" },
      diagnostics: { schemaVersion: "meeting_minutes_diagnostics.v1" as const, stage: "generation" as const,
        code: "UNCLASSIFIED_FAILURE", retryable: true, failedAt: "2026-08-18T00:00:00.000Z" } };
    await new MeetingMinutesSlackClient("token", fetchImpl).updateRunStatus(run, "failed");
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("処理ID: run-1");
    expect(serialized).toContain("失敗段階: 議事録生成");
    expect(serialized).toContain("エラーコード: UNCLASSIFIED_FAILURE");
    expect(serialized).toMatch(/問い合わせID: cor_[0-9A-HJKMNP-TV-Z]{26}/);
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("raw upstream response");
  });

  it("does not recommend or offer retry when diagnostics say operator action is required", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)); return Response.json({ ok: true });
    }) as typeof fetch;
    const run = { ...routedRun(), status: "failed" as const,
      failure: { stage: "routed", message: "meeting_minutes_transcript_changed" },
      diagnostics: { schemaVersion: "meeting_minutes_diagnostics.v1" as const, stage: "transcript_download" as const,
        code: "TRANSCRIPT_CHANGED", retryable: false, failedAt: "2026-08-18T00:00:00.000Z" } };
    await new MeetingMinutesSlackClient("token", fetchImpl).updateRunStatus(run, "failed");
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("運用担当者へ確認してください");
    expect(serialized).not.toContain("下のボタンから再実行できます");
    expect(serialized).not.toContain('"type":"actions"');
  });

  it("explains that placeholder output was rejected before it was shared", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)); return Response.json({ ok: true });
    }) as typeof fetch;
    const run = { ...routedRun(), failure: {
      stage: "routed", message: "meeting_minutes_generation_placeholder_output",
    } };
    await new MeetingMinutesSlackClient("token", fetchImpl).updateRunStatus(run, "failed");
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("生成結果が議事録になっていませんでした");
    expect(serialized).toContain("見本やプレースホルダーのままの出力を検出");
    expect(serialized).toContain("GitHub・Slack・タスクには保存していません");
    expect(serialized).toContain("再実行");
    expect(serialized).not.toContain("meeting_minutes_generation_placeholder_output");
  });

  it("requires an explicit redo when a saved meeting minutes file contains placeholders", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)); return Response.json({ ok: true });
    }) as typeof fetch;
    const run = { ...routedRun(), failure: {
      stage: "generated", message: "meeting_minutes_persisted_placeholder_output",
    } };
    await new MeetingMinutesSlackClient("token", fetchImpl).updateRunStatus(run, "completed");
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("保存済みの議事録に見本文が含まれています");
    expect(serialized).toContain("以前の生成結果を自動では上書きしません");
    expect(serialized).toMatch(/問い合わせID: cor_[0-9A-HJKMNP-TV-Z]{26}/);
    expect(serialized).toContain("保存先をやり直す");
    expect(serialized).not.toContain("タスク処理を再実行");
    expect(serialized).not.toContain("meeting_minutes_persisted_placeholder_output");
  });

  it("keeps a failed redo visible with a durable retry action", async () => {
    const directMessage = JSON.stringify(redoFailedMessage("run-1", "meeting.txt"));
    expect(directMessage).toContain("処理ID: run-1");
    expect(directMessage).toContain("失敗段階: 処理受付");
    expect(directMessage).toContain("エラーコード: REDO_ENQUEUE_FAILED");
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)); return Response.json({ ok: true });
    }) as typeof fetch;
    await new MeetingMinutesSlackClient("token", fetchImpl).showRedoFailure(routedRun());
    expect(body).toMatchObject({ channel: "C1", ts: "3.1" });
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("保存先のやり直しを完了できませんでした");
    expect(serialized).toContain("処理ID: run-1");
    expect(serialized).toContain("失敗段階: 処理受付");
    expect(serialized).toContain("エラーコード: REDO_ENQUEUE_FAILED");
    expect(serialized).toContain("取り消しを再実行");
    expect(serialized).toContain("mana_meeting_minutes_confirm_redo");
  });

  it("uses one bounded safe projection when the redo failure notice cannot be posted", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return bodies.length === 1 ? Response.json({ ok: false, error: "message_not_found" }) : Response.json({ ok: true });
    }) as typeof fetch;
    await new MeetingMinutesSlackClient("token", fetchImpl).showRedoFailure(routedRun());
    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(bodies[1])).toContain("STATUS_PROJECTION_FAILED");
    expect(JSON.stringify(bodies[1])).toContain("処理ID: run-1");
    expect(JSON.stringify(bodies[1])).toContain("失敗段階: 状態表示");
  });

  it("explains how to recover when the destination Slack channel is unavailable", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)); return Response.json({ ok: true });
    }) as typeof fetch;
    const run = { ...routedRun(), status: "posting" as const,
      failure: { stage: "slack_parent", message: "slack_api_failed:chat.postMessage:channel_not_found" } };
    await new MeetingMinutesSlackClient("token", fetchImpl).updateRunStatus(run, "failed");
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("保存先チャンネルへ投稿できませんでした");
    expect(serialized).toContain("Manaアプリが「mana」のチャンネルに参加しているか確認してください");
    expect(serialized).toContain("参加させた後、下のボタンから再実行できます");
    expect(serialized).toContain("再実行");
    expect(serialized).not.toContain("channel_not_found");
  });

  it("explains a permanent Brainbase project binding failure without offering retry", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)); return Response.json({ ok: true });
    }) as typeof fetch;
    const run = { ...routedRun(), status: "routed" as const,
      failure: { stage: "routed", message: "meeting_minutes_context_request_failed:403" } };
    await new MeetingMinutesSlackClient("token", fetchImpl).updateRunStatus(run, "failed");
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("Brainbaseのプロジェクト紐付けを確認できませんでした");
    expect(serialized).toContain("未設定、または利用権限がありません");
    expect(serialized).toContain("設定を修正するまで再実行しても成功しません");
    expect(serialized).not.toContain("meeting_minutes_context_request_failed");
    expect(serialized).not.toContain('"type":"actions"');
  });

  it("explains a Brainbase authentication failure without mislabeling it as a project binding", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)); return Response.json({ ok: true });
    }) as typeof fetch;
    const run = { ...routedRun(), status: "routed" as const,
      failure: { stage: "routed", message: "meeting_minutes_context_request_failed:401" } };
    await new MeetingMinutesSlackClient("token", fetchImpl).updateRunStatus(run, "failed");
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("Brainbaseの認証設定を確認できませんでした");
    expect(serialized).toContain("認証情報が未設定、無効、または期限切れです");
    expect(serialized).not.toContain("プロジェクト紐付け");
    expect(serialized).not.toContain('"type":"actions"');
  });

  it("explains a permanent task project binding failure without offering task retry", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)); return Response.json({ ok: true });
    }) as typeof fetch;
    const run = { ...routedRun(), status: "completed" as const,
      slack: { processingTs: "2.1", parentTs: "10.1", postedChunkIndexes: [0] },
      taskRegistration: { registered: [], failure: {
        index: 0, stage: "task_registration" as const, code: "project_code_not_allowed", status: 403,
        message: "project code is not allowed", failedAt: "2026-08-15T00:00:00.000Z",
      } },
      github: { transcriptPath: "t", minutesPath: "m", transcriptUrl: "tu", minutesUrl: "https://github/minutes" } };
    await new MeetingMinutesSlackClient("token", fetchImpl).updateRunStatus(run, "completed");
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("議事録は作成・共有済みです");
    expect(serialized).toContain("Brainbaseのプロジェクト紐付けを確認できませんでした");
    expect(serialized).toContain("未登録、またはタスク登録権限がありません");
    expect(serialized).toContain("設定を修正するまで再実行しても成功しません");
    expect(serialized).not.toContain("タスク処理を再実行");
    expect(serialized).toContain("GitHubで議事録を開く");
    expect(serialized).not.toContain("project_code_not_allowed");
    expect(serialized).not.toContain("project code is not allowed");
  });

  it("explains a task API authentication failure after sharing minutes without offering task retry", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)); return Response.json({ ok: true });
    }) as typeof fetch;
    const run = { ...routedRun(), status: "completed" as const,
      slack: { processingTs: "2.1", parentTs: "10.1", postedChunkIndexes: [0] },
      taskRegistration: { registered: [], failure: {
        index: 0, stage: "task_registration" as const, code: "unauthorized", status: 401,
        message: "invalid token", failedAt: "2026-08-15T00:00:00.000Z",
      } },
      github: { transcriptPath: "t", minutesPath: "m", transcriptUrl: "tu", minutesUrl: "https://github/minutes" } };
    await new MeetingMinutesSlackClient("token", fetchImpl).updateRunStatus(run, "completed");
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("議事録は作成・共有済みです");
    expect(serialized).toContain("Brainbaseの認証設定を確認できませんでした");
    expect(serialized).toContain("認証情報が未設定、無効、または期限切れです");
    expect(serialized).not.toContain("プロジェクト紐付け");
    expect(serialized).not.toContain("タスク処理を再実行");
    expect(serialized).not.toContain("invalid token");
    expect(serialized).toContain("保存先をやり直す");
  });

  it("keeps task retry for a transient task integration failure", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)); return Response.json({ ok: true });
    }) as typeof fetch;
    const run = { ...routedRun(), status: "completed" as const,
      slack: { processingTs: "2.1", parentTs: "10.1", postedChunkIndexes: [0] },
      taskRegistration: { registered: [], failure: {
        index: 0, stage: "task_registration" as const, message: "task api down",
        failedAt: "2026-08-15T00:00:00.000Z",
      } } };
    await new MeetingMinutesSlackClient("token", fetchImpl).updateRunStatus(run, "completed");
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("タスク自動登録だけ完了していません");
    expect(serialized).toContain("タスク処理を再実行");
  });

  it("explains when only task board reflection remains", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)); return Response.json({ ok: true });
    }) as typeof fetch;
    const run = { ...routedRun(), status: "completed" as const,
      slack: { processingTs: "2.1", parentTs: "10.1", postedChunkIndexes: [0] },
      taskRegistration: { registered: [{ index: 0, title: "確認する", taskId: "task-1" }], failure: {
        index: 0, stage: "task_board" as const, message: "board down", failedAt: "2026-08-15T00:00:00.000Z",
      } },
      github: { transcriptPath: "t", minutesPath: "m", transcriptUrl: "tu", minutesUrl: "https://github/minutes" } };
    await new MeetingMinutesSlackClient("token", fetchImpl).updateRunStatus(run, "completed");
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("タスク登録は完了しましたが、タスクボードへの反映が完了していません");
    expect(serialized).not.toContain("board down");
  });

  it("shows only unique organizations in the initial selector", async () => {
    let body: { blocks?: Array<{ elements?: Array<{ action_id?: string }> }> } = {};
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ ok: true, ts: "1.2" });
    }) as typeof fetch;
    const run = { version: 1 as const, runId: "run-1", eventId: "Ev1", workspaceId: "T1", sourceChannelId: "C1",
      sourceThreadTs: "1.0", sourceMessageTs: "1.0", file: { id: "F1", name: "meeting.txt", mimetype: "text/plain", size: 10 },
      status: "awaiting_destination" as const, createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z" };
    const destinations = [
      { id: "one", projectId: "p1", contextProjectCode: "unson", taskProjectCodes: ["unson"],
        taskBoardTargetId: "minutes-one", name: "One", organization: { id: "unson", name: "雲孫" },
        slackChannelId: "C2", github: { owner: "o", repo: "r", pathPrefix: "meetings" } },
      { id: "two", projectId: "p2", contextProjectCode: "techknight", taskProjectCodes: ["techknight"],
        taskBoardTargetId: "minutes-two", name: "Two", organization: { id: "tech-knight", name: "Tech Knight" },
        slackChannelId: "C3", github: { owner: "o", repo: "r", pathPrefix: "meetings" } },
    ];
    await new MeetingMinutesSlackClient("token", fetchImpl).requestDestination(run, destinations);
    const ids = body.blocks?.flatMap((block) => block.elements ?? []).map((element) => element.action_id);
    expect(ids).toEqual(["mana_meeting_minutes_choose_organization:unson",
      "mana_meeting_minutes_choose_organization:tech-knight"]);
  });

  it("shows the automatically suggested project with confirmation and a manual-change path", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)); return Response.json({ ok: true, ts: "1.2" });
    }) as typeof fetch;
    const run = { version: 1 as const, runId: "run-1", eventId: "Ev1", workspaceId: "T1", sourceChannelId: "C1",
      sourceThreadTs: "1.0", sourceMessageTs: "1.0", file: { id: "F1", name: "meeting.txt", mimetype: "text/plain", size: 10 },
      status: "awaiting_destination" as const,
      routing: { evaluated: true as const, suggestedDestinationId: "one", reason: "案件名が一致" },
      createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z" };
    const destinations = [{ id: "one", projectId: "p1", contextProjectCode: "salestailor",
      taskProjectCodes: ["salestailor"], taskBoardTargetId: "minutes-one", name: "SalesTailor",
      organization: { id: "unson", name: "雲孫" }, slackChannelId: "C2", github: { owner: "o", repo: "r" } }];
    await new MeetingMinutesSlackClient("token", fetchImpl).requestDestination(run, destinations);
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("候補は *SalesTailor*");
    expect(serialized).toContain("案件名が一致");
    expect(serialized).toContain("mana_meeting_minutes_choose_destination:one");
    expect(serialized).toContain("この候補で進める");
    expect(serialized).toContain("別の保存先を選ぶ");
  });

  it("invokes fetch with the Workers global receiver", async () => {
    const fetchImpl = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new Error("illegal receiver");
      return Promise.resolve(new Response(JSON.stringify({ ok: true, ts: "1.2" }), { status: 200 }));
    });
    await expect(new MeetingMinutesSlackClient("token", fetchImpl).postParent("C1", "meeting.txt", "test", "receiver-test"))
      .resolves.toBe("1.2");
  });

  it("refetches the private URL and downloads a bounded text file", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).includes("files.info")
      ? Response.json({ ok: true, file: { name: "meeting.txt", mimetype: "text/plain", size: 5,
        url_private_download: "https://files.slack.test/private" } })
      : new Response("hello")) as typeof fetch;
    await expect(new MeetingMinutesSlackClient("xoxb-token", fetchImpl).downloadTextFile("F1")).resolves.toBe("hello");
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://files.slack.test/private",
      expect.objectContaining({ headers: { Authorization: "Bearer xoxb-token" } }));
  });

  it("uses a deterministic UUID client_msg_id for retry-safe posts", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body))); return Response.json({ ok: true, ts: "1.2" });
    }) as typeof fetch;
    const client = new MeetingMinutesSlackClient("token", fetchImpl);
    await client.postParent("C1", "meeting.txt", "text", "run-parent");
    await client.postParent("C1", "meeting.txt", "text", "run-parent");
    const ids = bodies.map((body) => (body as { client_msg_id: string }).client_msg_id);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ids[0]).toBe(ids[1]);
  });

  it("story-meeting-minutes-task-card-runtime:ac:1 story-meeting-minutes-task-card-runtime:ac:2 story-meeting-minutes-task-card-runtime:ac:3 scopes task card idempotency to the run revision", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body))); return Response.json({ ok: true, ts: `${bodies.length}.2` });
    }) as typeof fetch;
    const client = new MeetingMinutesSlackClient("token", fetchImpl);
    const run = { ...routedRun(), revision: 0,
      taskRegistration: { registered: [{ index: 0, title: "確認する", taskId: "task-1", status: "registered" as const }] },
      slack: { ...routedRun().slack, parentTs: "4.1" } };

    await client.postTaskCard(run);
    await client.postTaskCard(run);
    await client.postTaskCard({ ...run, revision: 1 });
    await client.postTaskCard({ ...run, revision: undefined });

    expect(bodies).toHaveLength(4);
    expect(bodies[0]).toMatchObject({
      channel: "C2",
      thread_ts: "4.1",
      text: "議事録のタスク確認: 新規1件・既存0件",
    });
    expect(bodies[2]?.blocks).toEqual(bodies[0]?.blocks);
    const ids = bodies.map((body) => body.client_msg_id);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ids[0]).toBe("1224a6fc-a576-4e61-b8fa-f3302ef61619");
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).toBe("8dc542bb-b7dd-4397-abee-c94297f18d03");
    expect(ids[3]).toBe(ids[0]);
  });

  it("explains that only the task card remains when task registration already completed", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)); return Response.json({ ok: true });
    }) as typeof fetch;
    const run = { ...routedRun(), taskRegistration: {
      registered: [{ index: 0, title: "確認する", taskId: "task-1", status: "registered" as const }],
      failure: { index: 0, stage: "task_card" as const, message: "internal-slack-error",
        failedAt: "2026-08-17T00:00:00.000Z" },
    } };

    await new MeetingMinutesSlackClient("token", fetchImpl).updateRunStatus(run, "completed");

    const serialized = JSON.stringify(body);
    expect(serialized).toContain("タスク登録は完了しましたが、タスクカードの投稿が完了していません");
    expect(serialized).toContain("未完了の処理だけ再実行できます");
    expect(serialized).not.toContain("internal-slack-error");
    expect(serialized).not.toContain("タスク自動登録だけ未完了");
  });

  it("propagates the exact Slack task card API error", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: false, error: "invalid_blocks" })) as typeof fetch;
    const run = { ...routedRun(), revision: 1,
      taskRegistration: { registered: [{ index: 0, title: "確認する", taskId: "task-1", status: "registered" as const }] },
      slack: { ...routedRun().slack, parentTs: "4.1" } };

    await expect(new MeetingMinutesSlackClient("token", fetchImpl).postTaskCard(run))
      .rejects.toThrow("slack_api_failed:chat.postMessage:invalid_blocks");
  });

  it("posts the legacy summary card and detailed thread contract", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body))); return Response.json({ ok: true, ts: `${bodies.length}.1` });
    }) as typeof fetch;
    const client = new MeetingMinutesSlackClient("token", fetchImpl);
    const parentTs = await client.postParent("C1", "定例.txt", "*定例*\n概要", "run-parent");
    await client.postThreadChunk("C1", parentTs, "定例.txt", "議題1", 0, 2, "run-chunk-0");
    await client.postThreadChunk("C1", parentTs, "定例.txt", "議題2", 1, 2, "run-chunk-1");
    expect(bodies[0]).toMatchObject({ channel: "C1", text: "📝 会議要約: 定例.txt" });
    expect(JSON.stringify(bodies[0]?.blocks)).toContain("詳細な議事録はこの投稿のスレッド");
    expect(JSON.stringify(bodies[1]?.blocks)).toContain("詳細議事録: 定例.txt");
    expect(JSON.stringify(bodies[1]?.blocks)).toContain("続きがあります（2件中 1件目）");
    expect(JSON.stringify(bodies[2]?.blocks)).toContain("この議事録はAIにより自動生成されました");
  });

  it("renders untrusted meeting text literally while preserving the card's trusted mrkdwn", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body))); return Response.json({ ok: true, ts: `${bodies.length}.1` });
    }) as typeof fetch;
    const client = new MeetingMinutesSlackClient("token", fetchImpl);

    const parentTs = await client.postParent(
      "C1",
      "定例 <@U_ATTACK>.txt",
      "*要約* <!channel> <https://evil.test|確認> &lt;@U_SAFE&gt; https://safe.test",
      "safe-parent",
    );
    await client.postThreadChunk(
      "C1", parentTs, "定例 <@U_ATTACK>.txt",
      "*本文* <!here> <https://evil.test> &lt;!channel&gt;", 0, 1, "safe-chunk",
    );

    const parent = JSON.stringify(bodies[0]);
    const chunk = JSON.stringify(bodies[1]);
    expect(parent).toContain("📝 *会議要約: 定例 &lt;@U_ATTACK&gt;.txt*");
    expect(parent).toContain("*要約* &lt;!channel&gt; &lt;https://evil.test|確認&gt; &lt;@U_SAFE&gt; https://safe.test");
    expect(chunk).toContain("📄 *詳細議事録: 定例 &lt;@U_ATTACK&gt;.txt*");
    expect(chunk).toContain("*本文* &lt;!here&gt; &lt;https://evil.test&gt; &lt;!channel&gt;");
  });
});
