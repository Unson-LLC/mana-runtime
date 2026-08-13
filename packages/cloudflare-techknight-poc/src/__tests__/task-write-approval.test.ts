import { TaskWriteApproval } from "../task-write-approval.js";

function harness() {
  const values = new Map<string, unknown>();
  const storage: any = {
    get: vi.fn(async (key: string) => values.get(key)),
    put: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
    setAlarm: vi.fn(async () => undefined),
    deleteAll: vi.fn(async () => { values.clear(); }),
    transaction: vi.fn(async (closure: (storage: any) => Promise<unknown>) => closure(storage)),
  };
  return { object: new TaskWriteApproval({ storage }), values };
}

const pending = () => ({ approvalId: crypto.randomUUID(), payloadHash: "a".repeat(64), body: { operation: "create" },
  capability: "signed.token", requesterId: "U_REQUESTER", approvers: ["U_APPROVER"], policyVersion: "v1", expiresAt: Date.now() + 60_000 });

describe("TaskWriteApproval", () => {
  it("persists pending state and consumes it exactly once by an allowed approver", async () => {
    const { object } = harness(); const item = pending();
    expect((await object.fetch(new Request("https://task-write-approval.internal/pending", { method: "POST", body: JSON.stringify(item) }))).status).toBe(204);
    const consume = () => object.fetch(new Request("https://task-write-approval.internal/consume", { method: "POST",
      body: JSON.stringify({ approvalId: item.approvalId, payloadHash: item.payloadHash, approverId: "U_APPROVER" }) }));
    expect((await consume()).status).toBe(200);
    expect((await consume()).status).toBe(409);
  });

  it("rejects an unauthorized approver and payload replacement", async () => {
    const { object } = harness(); const item = pending();
    await object.fetch(new Request("https://task-write-approval.internal/pending", { method: "POST", body: JSON.stringify(item) }));
    const call = (approverId: string, payloadHash = item.payloadHash) => object.fetch(new Request("https://task-write-approval.internal/consume", { method: "POST",
      body: JSON.stringify({ approvalId: item.approvalId, payloadHash, approverId }) }));
    expect((await call("U_OUTSIDER")).status).toBe(403);
    expect((await call("U_APPROVER", "b".repeat(64))).status).toBe(403);
  });
});
