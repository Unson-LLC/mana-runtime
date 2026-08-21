import { describe, expect, it, vi } from "vitest";
import {
  buildContractLedgerPlan,
  ContractLedgerStateStore,
  contractLedgerConfig,
  contractStatusLabel,
  enqueueScheduledContractLedgerSync,
  fetchAllContractEnvelopes,
  parseContractLedgerSlackAction,
  type ContractEnvelope,
  type ContractLedgerEnvironment,
} from "../contract-ledger.js";

function envelope(overrides: Partial<ContractEnvelope> = {}): ContractEnvelope {
  return { envelopeId: "env-1", status: "completed", subject: "業務委託契約書", senderEmail: "info@unson.jp",
    counterparty: "取引先", sentAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-02T00:00:00Z", ...overrides };
}

describe("contract ledger rules", () => {
  it("updates existing voided rows and does not add unknown voided envelopes", () => {
    const ledger = [["管理番号", "Envelope ID", "取引先", "件名", "種別", "状態", "最終更新"],
      ["DS-2026-001", "known", "A", "契約", "業務委託", "署名が必要", "old"]];
    const plan = buildContractLedgerPlan(ledger, [envelope({ envelopeId: "known", status: "voided" }),
      envelope({ envelopeId: "unknown", status: "voided" })], 2026);
    expect(plan.updates).toEqual([expect.objectContaining({ envelopeId: "known", status: "取消", rowNumber: 2 })]);
    expect(plan.candidates).toHaveLength(0);
    expect(plan.excluded).toContain("unknown");
  });

  it("keeps a valid new envelope as approval candidate instead of appending", () => {
    const ledger = [["管理番号", "Envelope ID"]];
    const plan = buildContractLedgerPlan(ledger, [envelope()], 2026);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]?.proposedRow[1]).toBe("env-1");
    expect(plan.updates).toHaveLength(0);
  });

  it("excludes explicit test envelopes", () => {
    const plan = buildContractLedgerPlan([["管理番号", "Envelope ID"]], [envelope({ subject: "テスト契約" })], 2026);
    expect(plan.candidates).toHaveLength(0);
    expect(plan.excluded).toEqual(["env-1"]);
  });

  it("maps unknown statuses without claiming success", () => {
    expect(contractStatusLabel("processing_error")).toBe("processing_error");
    expect(contractStatusLabel("")).toBe("未確認");
  });
});

describe("schedule and approval boundaries", () => {
  it("only enqueues the dedicated weekday cron when enabled", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = { CONTRACT_LEDGER_ENABLED: "true", CONTRACT_LEDGER_FROM_DATE: "2026-01-01",
      CONTRACT_LEDGER_SYNCS: { send } } as unknown as ContractLedgerEnvironment;
    expect(await enqueueScheduledContractLedgerSync({ cron: "*/15 * * * *", scheduledTime: Date.UTC(2026, 7, 18) }, env)).toBe(false);
    expect(await enqueueScheduledContractLedgerSync({ cron: "0 0 * * 1-5", scheduledTime: Date.UTC(2026, 7, 18) }, env)).toBe(true);
    expect(send).toHaveBeenCalledOnce();
  });

  it("requires an allowlisted approver in the legal channel", () => {
    const config = { ...contractLedgerConfig({} as ContractLedgerEnvironment), legalChannelId: "legal",
      approverUserIds: new Set(["approver"]) };
    const payload = { user: { id: "approver" }, channel: { id: "legal" }, actions: [{ action_id: "mana_contract_ledger_approve",
      value: JSON.stringify({ envelopeId: "env-1", runId: "run-1" }) }] };
    expect(parseContractLedgerSlackAction(payload, config)).toEqual(expect.objectContaining({ decision: "approved", envelopeId: "env-1" }));
    expect(() => parseContractLedgerSlackAction({ ...payload, user: { id: "other" } }, config)).toThrow("contract_ledger_approver_forbidden");
  });
});

describe("DocuSign pagination", () => {
  it("reads every page and validates the info@unson.jp account", async () => {
    const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const derBase64 = Buffer.from(pkcs8).toString("base64");
    const pem = `-----BEGIN PRIVATE KEY-----\n${derBase64.match(/.{1,64}/g)?.join("\n")}\n-----END PRIVATE KEY-----\n`;
    const key = Buffer.from(pem).toString("base64");
    let envelopePage = 0;
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/oauth/token")) return Response.json({ access_token: "token" });
      if (url.endsWith("/oauth/userinfo")) return Response.json({ email: "info@unson.jp",
        accounts: [{ account_id: "account", base_uri: "https://jp1.docusign.net", is_default: true }] });
      envelopePage += 1;
      return Response.json(envelopePage === 1 ? { envelopes: [{ envelopeId: "one", status: "sent" }], nextUri: "/next" }
        : { envelopes: [{ envelopeId: "two", status: "completed" }] });
    });
    const fetchMock = fetchSpy as unknown as typeof fetch;
    const result = await fetchAllContractEnvelopes({ DOCUSIGN_INTEGRATION_KEY: "key", DOCUSIGN_USER_ID: "user",
      DOCUSIGN_RSA_PRIVATE_KEY_BASE64: key } as ContractLedgerEnvironment, "2026-01-01", fetchMock);
    expect(result.map((item) => item.envelopeId)).toEqual(["one", "two"]);
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes("/envelopes?")).length).toBe(2);
  });
});

describe("Durable Object idempotency", () => {
  it("claims each run and candidate decision once", async () => {
    const values = new Map<string, unknown>();
    const storage = {
      get: async (key: string) => values.get(key),
      put: async (keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
        if (typeof keyOrEntries === "string") values.set(keyOrEntries, value);
        else Object.entries(keyOrEntries).forEach(([key, entry]) => values.set(key, entry));
      },
      delete: async (key: string) => values.delete(key),
      transaction: async <T>(operation: (tx: unknown) => Promise<T>) => operation(storage),
    };
    const state = new ContractLedgerStateStore({ storage: storage as unknown as DurableObjectStorage });
    expect(await state.claimRun("day")).toBe("claimed");
    expect(await state.claimRun("day")).toBe("in_progress");
    values.set("run:stale", { status: "running", claimedAt: "2026-01-01T00:00:00.000Z" });
    expect(await state.claimRun("stale")).toBe("claimed");
    const candidate = { kind: "contract_ledger_candidate" as const, runId: "run", envelope: envelope(),
      proposedRow: ["DS-2026-001", "env-1"] };
    expect((await state.saveCandidate(candidate)).created).toBe(true);
    expect((await state.saveCandidate(candidate)).created).toBe(false);
    const decision = { kind: "contract_ledger_approval" as const, runId: "run", envelopeId: "env-1",
      decision: "approved" as const, decidedBy: "approver", decidedAt: new Date().toISOString() };
    expect((await state.claimDecision(decision)).apply).toBe(true);
    await state.completeApproval("env-1");
    expect((await state.claimDecision(decision)).apply).toBe(false);
  });
});

