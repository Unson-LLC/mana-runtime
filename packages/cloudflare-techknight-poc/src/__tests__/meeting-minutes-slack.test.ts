import { MeetingMinutesSlackClient } from "../meeting-minutes-slack.js";

describe("MeetingMinutesSlackClient", () => {
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

  it("does not stop minutes processing when the optional assistant status is unavailable", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).includes("assistant.threads.setStatus")
      ? Response.json({ ok: false, error: "not_allowed" })
      : Response.json({ ok: true, ts: "3.1" })) as typeof fetch;
    await expect(new MeetingMinutesSlackClient("token", fetchImpl).postProcessingStatus(routedRun()))
      .resolves.toBe("3.1");
  });

  it("explains a canonical task project scope mismatch to the operator", async () => {
    let call: { url: string; body: Record<string, unknown> } | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      call = { url: String(input), body: JSON.parse(String(init?.body)) };
      return Response.json({ ok: true });
    }) as typeof fetch;
    const run = { ...routedRun(), slack: { ...routedRun().slack, parentTs: "4.1" } };
    await new MeetingMinutesSlackClient("token", fetchImpl).postTaskScopeMismatch(run, "U1");
    expect(call?.url).toBe("https://slack.com/api/chat.postEphemeral");
    expect(call?.body).toMatchObject({ channel: "C2", thread_ts: "4.1", user: "U1" });
    expect(String(call?.body.text)).toContain("現在のBrainbaseプロジェクトに紐付いていない");
    expect(String(call?.body.text)).toContain("編集・取消できません");
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

  it("replaces a failed result with a retry button for the selected destination", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)); return Response.json({ ok: true });
    }) as typeof fetch;
    await new MeetingMinutesSlackClient("token", fetchImpl).updateRunStatus(routedRun(), "failed");
    expect(JSON.stringify(body)).toContain("議事録の作成に失敗しました");
    expect(JSON.stringify(body)).toContain("mana_meeting_minutes_choose_destination:mana");
    expect(JSON.stringify(body)).toContain("再実行");
    expect(JSON.stringify(body)).toContain('\\"sourceThreadTs\\":\\"1.0\\"');
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
    expect(serialized).toContain("保存先をやり直す");
    expect(serialized).not.toContain("タスク処理を再実行");
    expect(serialized).not.toContain("meeting_minutes_persisted_placeholder_output");
  });

  it("keeps a failed redo visible with a durable retry action", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)); return Response.json({ ok: true });
    }) as typeof fetch;
    await new MeetingMinutesSlackClient("token", fetchImpl).showRedoFailure(routedRun());
    expect(body).toMatchObject({ channel: "C1", ts: "3.1" });
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("保存先のやり直しを完了できませんでした");
    expect(serialized).toContain("取り消しを再実行");
    expect(serialized).toContain("mana_meeting_minutes_confirm_redo");
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
});
