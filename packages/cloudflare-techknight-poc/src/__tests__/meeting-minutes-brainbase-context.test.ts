import {
  MeetingMinutesBrainbaseContextClient,
  assertMeetingMinutesContextUsable,
  reconcileMeetingMinutesTask,
  validateGeneratedMeetingMinutesContext,
} from "../meeting-minutes-brainbase-context.js";
import type { MeetingMinutesContextReceipt } from "../meeting-minutes-contracts.js";

const receipt: MeetingMinutesContextReceipt = {
  schema_version: "meeting_minutes_context_receipt.v1",
  receipt_id: "mmctx_123",
  identity: { run_id: "Ev1_F1", project_code: "mana", transcript_sha256: "a".repeat(64) },
  status: "resolved",
  checksum: "b".repeat(64),
  resolved_at: "2026-08-15T00:00:00.000Z",
  context: {
    source_refs: [{ type: "graph_entity", id: "project-mana" }],
    open_tasks: [{ id: "task-1", title: "請求書を送る", assignee_person_id: "person-1" }],
  },
};

describe("meeting minutes Brainbase context", () => {
  it("invokes the runtime fetch with the global receiver required by Cloudflare Workers", async () => {
    const runtimeFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(new Response(JSON.stringify(receipt), { status: 201 }));
    });
    const client = new MeetingMinutesBrainbaseContextClient("https://bb.example", "secret", runtimeFetch);

    await expect(client.resolve(receipt.identity)).resolves.toEqual(receipt);
    expect(runtimeFetch).toHaveBeenCalledOnce();
  });

  it("uses the redirect mode supported by Cloudflare Workers", async () => {
    const runtimeFetch = vi.fn(function (this: unknown, _input: string | URL | Request, init?: RequestInit) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      if (init?.redirect === "error") {
        throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
      }
      return Promise.resolve(new Response(JSON.stringify(receipt), { status: 201 }));
    });
    const client = new MeetingMinutesBrainbaseContextClient("https://bb.example", "secret", runtimeFetch);

    await expect(client.resolve(receipt.identity)).resolves.toEqual(receipt);
    expect(runtimeFetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: "manual" }));
  });

  it("rejects redirects without following them", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: "https://unexpected.example/receipt" },
    }));
    const client = new MeetingMinutesBrainbaseContextClient("https://bb.example", "secret", fetch);

    await expect(client.resolve(receipt.identity)).rejects.toThrow("meeting_minutes_context_redirect_rejected");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("creates and retrieves an identity-bound Receipt through the server API", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt), { status: 200 }));
    const client = new MeetingMinutesBrainbaseContextClient("https://bb.example", "secret", fetch);
    await expect(client.resolve(receipt.identity)).resolves.toEqual(receipt);
    await expect(client.resolve(receipt.identity, receipt.receipt_id)).resolves.toEqual(receipt);
    expect(fetch.mock.calls[0]?.[0].toString()).toBe("https://bb.example/api/meeting-minutes/context-receipts");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST", redirect: "manual",
      headers: expect.objectContaining({ authorization: "Bearer secret" }) });
    expect(fetch.mock.calls[1]?.[0].toString()).toContain(`/api/meeting-minutes/context-receipts/${receipt.receipt_id}`);
  });

  it("rejects a Receipt whose identity does not match the run", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...receipt,
      identity: { ...receipt.identity, project_code: "other" } }), { status: 201 }));
    const client = new MeetingMinutesBrainbaseContextClient("https://bb.example", "secret", fetch);
    await expect(client.resolve(receipt.identity)).rejects.toThrow("meeting_minutes_context_identity_mismatch");
  });

  it("fails closed for partial context only in required mode", () => {
    expect(() => assertMeetingMinutesContextUsable({ ...receipt, status: "partial" }, "required"))
      .toThrow("meeting_minutes_context_partial");
    expect(() => assertMeetingMinutesContextUsable({ ...receipt, status: "partial" }, "observe"))
      .not.toThrow();
    expect(() => assertMeetingMinutesContextUsable({ ...receipt, status: "confirmed_empty" }, "required"))
      .not.toThrow();
  });

  it("binds generated minutes to the exact Receipt and known source references", () => {
    expect(() => validateGeneratedMeetingMinutesContext({
      title: "定例", overview: "概要", body: "本文", tasks: [],
      brainbase_context_receipt_id: receipt.receipt_id,
      brainbase_context_checksum: receipt.checksum,
      used_source_refs: [{ type: "graph_entity", id: "project-mana" }],
    }, receipt)).not.toThrow();
    expect(() => validateGeneratedMeetingMinutesContext({
      title: "定例", overview: "概要", body: "本文", tasks: [],
      brainbase_context_receipt_id: receipt.receipt_id,
      brainbase_context_checksum: receipt.checksum,
      used_source_refs: [{ type: "graph_entity", id: "invented" }],
    }, receipt)).toThrow("meeting_minutes_context_source_ref_unknown");
  });

  it("reuses exact tasks, flags similar tasks, and creates only genuinely new tasks", () => {
    expect(reconcileMeetingMinutesTask({ title: "請求書を送る", assignee_name: "佐藤" }, receipt))
      .toEqual({ outcome: "reused", taskId: "task-1" });
    const similar = reconcileMeetingMinutesTask({ title: "請求書を今日中に送る" }, receipt);
    expect(similar.outcome).toBe("needs_review");
    expect(reconcileMeetingMinutesTask({ title: "議事録を共有する" }, receipt)).toEqual({ outcome: "new" });
  });
});
