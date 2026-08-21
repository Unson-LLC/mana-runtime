import { assertMeetingMinutesDeployAllowed, setMeetingMinutesIntakePaused } from "../../scripts/deploy-gate-check.mjs";

describe("meeting minutes deployment gate", () => {
  it("fails closed when configuration or the current Worker is unavailable", async () => {
    await expect(assertMeetingMinutesDeployAllowed({ baseUrl: "", token: "" }))
      .rejects.toThrow("meeting_minutes_deploy_gate_config_missing");
    await expect(assertMeetingMinutesDeployAllowed({ baseUrl: "https://worker.example", token: "token",
      fetchImpl: vi.fn().mockRejectedValue(new Error("timeout")) }))
      .rejects.toThrow("meeting_minutes_deploy_gate_unreachable");
  });

  it("aborts a gate request that exceeds the deployment timeout", async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })) as typeof fetch;
    await expect(assertMeetingMinutesDeployAllowed({
      baseUrl: "https://worker.example",
      token: "token",
      timeoutMs: 1,
      fetchImpl,
    })).rejects.toThrow("meeting_minutes_deploy_gate_unreachable");
  });

  it("blocks active runs and allows only an explicit drained response", async () => {
    await expect(assertMeetingMinutesDeployAllowed({ baseUrl: "https://worker.example", token: "token",
      fetchImpl: vi.fn().mockResolvedValue(Response.json({ allowed: false, activeRuns: [{ runId: "run-1" }] })) }))
      .rejects.toThrow("meeting_minutes_deploy_blocked_active_runs:1");
    await expect(assertMeetingMinutesDeployAllowed({ baseUrl: "https://worker.example", token: "token",
      fetchImpl: vi.fn().mockResolvedValue(Response.json({ allowed: true, activeRuns: [] })) })).resolves.toBeUndefined();
  });

  it("permits a missing endpoint only for an explicit one-time bootstrap", async () => {
    const missing = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    await expect(assertMeetingMinutesDeployAllowed({ baseUrl: "https://worker.example", token: "token",
      fetchImpl: missing })).rejects.toThrow("meeting_minutes_deploy_gate_http_404");
    await expect(assertMeetingMinutesDeployAllowed({ baseUrl: "https://worker.example", token: "token",
      fetchImpl: missing, allowMissingGate: true })).resolves.toBeUndefined();
  });

  it("permits only known runtime bootstrap responses during an explicit bootstrap", async () => {
    const legacy = vi.fn().mockResolvedValue(Response.json({
      boundary: "brainbase_proxy", error: "TENANT_CONTEXT_MISSING",
    }, { status: 503 }));
    await expect(assertMeetingMinutesDeployAllowed({ baseUrl: "https://worker.example", token: "token",
      fetchImpl: legacy })).rejects.toThrow("meeting_minutes_deploy_gate_http_503");
    await expect(assertMeetingMinutesDeployAllowed({ baseUrl: "https://worker.example", token: "token",
      fetchImpl: legacy, allowMissingGate: true })).resolves.toBeUndefined();
    await expect(assertMeetingMinutesDeployAllowed({ baseUrl: "https://worker.example", token: "token",
      fetchImpl: vi.fn().mockResolvedValue(Response.json({ error: "runtime_bootstrap_mode_active" }, { status: 503 })),
      allowMissingGate: true })).resolves.toBeUndefined();
    await expect(assertMeetingMinutesDeployAllowed({ baseUrl: "https://worker.example", token: "token",
      fetchImpl: vi.fn().mockResolvedValue(Response.json({ error: "upstream_unavailable" }, { status: 503 })),
      allowMissingGate: true })).rejects.toThrow("meeting_minutes_deploy_gate_http_503");
  });

  it("pauses new intake even while active runs are still draining", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({
      allowed: false, intakePaused: true, activeRuns: [{ runId: "run-1" }],
    }));
    await expect(setMeetingMinutesIntakePaused({
      baseUrl: "https://worker.example", token: "token", paused: true, fetchImpl,
    })).resolves.toEqual(expect.objectContaining({ intakePaused: true }));
    expect(fetchImpl).toHaveBeenCalledWith(new URL("/admin/meeting-minutes/intake", "https://worker.example"),
      expect.objectContaining({ method: "POST", body: JSON.stringify({ paused: true }) }));
  });
});
