import { handleSandboxAdminRequest } from "../sandbox-admin.js";

const TENANT_BOUNDARY_HANDLE = `tb_${"P".repeat(32)}`;

function env(overrides: Record<string, unknown> = {}) {
  return {
    SANDBOX_PROBE_TOKEN: "probe-secret",
    ...overrides,
  };
}

function request(path: string, token = "probe-secret") {
  return new Request(`https://example.com${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

function sandbox(result = { success: true, stdout: "2.1.0\n", stderr: "" }) {
  return {
    writeFile: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockResolvedValue(result),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

function judgmentHook(event: "UserPromptSubmit" | "Stop") {
  const receipt = {
    schema_version: "mana_judgment_hook_receipt.v1", hook_event_name: event,
    session_id: "probe-session", turn_id: "probe-turn", host_receipt_id: `host-${event}`,
    ...(event === "UserPromptSubmit" ? { route_resolution_sha256: "c".repeat(64) } : {}),
  };
  return { type: "system", subtype: "hook_response", hook_event: event, exit_code: 0, outcome: "success",
    stdout: JSON.stringify({ systemMessage: `__MANA_JUDGMENT_RECEIPT_V1__:${JSON.stringify(receipt)}` }) };
}

describe("handleSandboxAdminRequest", () => {
  it("rejects requests before starting a sandbox when the probe token is wrong", async () => {
    const createSandbox = vi.fn();
    const response = await handleSandboxAdminRequest(request("/admin/sandbox/runtime-probe", "wrong"), env(), {
      createSandbox,
    });

    expect(response.status).toBe(401);
    expect(createSandbox).not.toHaveBeenCalled();
  });

  it("reports the Claude runtime without returning credentials and destroys the sandbox", async () => {
    const client = sandbox({ success: true, stdout: "2.1.227\n", stderr: "" });
    const response = await handleSandboxAdminRequest(
      request("/admin/sandbox/runtime-probe"),
      env({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret", TENANT_ID: "must-not-be-used" }),
      { createSandbox: () => client, randomId: () => "fixed" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      runtime: "claude-code",
      version: "2.1.227",
      providerForwarding: "trusted_forwarder_required",
    });
    expect(client.destroy).toHaveBeenCalledOnce();
  });

  it("fails closed because an admin token is not a tenant provider authority", async () => {
    const client = sandbox();
    const response = await handleSandboxAdminRequest(
      request("/admin/sandbox/oauth-probe"),
      env(),
      { createSandbox: () => client },
    );

    expect(response.status).toBe(503);
    expect(client.exec).not.toHaveBeenCalled();
    expect(client.destroy).toHaveBeenCalledOnce();
  });

  it("does not fall back to a Worker secret for an OAuth probe", async () => {
    const client = sandbox({
      success: true,
      stdout: "TECHKNIGHT_OAUTH_OK oauth-secret-must-not-leak",
      stderr: "",
    });
    const response = await handleSandboxAdminRequest(
      request("/admin/sandbox/oauth-probe"),
      env({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret-must-not-leak" }),
      { createSandbox: () => client, randomId: () => "fixed" },
    );

    expect(response.status).toBe(503);
    expect(client.exec).not.toHaveBeenCalled();
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("oauth-secret-must-not-leak");
    expect(client.destroy).toHaveBeenCalledOnce();
  });

  it("runs the production meeting-minutes command and returns only a safe success result", async () => {
    const client = sandbox({
      success: true,
      stdout: [
        JSON.stringify({ type: "system", subtype: "init", session_id: "probe-session" }),
        JSON.stringify(judgmentHook("UserPromptSubmit")),
        JSON.stringify(judgmentHook("Stop")),
        JSON.stringify({ type: "result", session_id: "probe-session", structured_output: {
          title: "議事録生成プローブ", overview: "生成経路を確認した。", body: "------------\n生成経路\n本番と同じ設定を確認した。", tasks: [], used_source_refs: [], decision_candidates: [],
        } }),
      ].join("\n"),
      stderr: "secret-output-must-not-leak",
    });
    const response = await handleSandboxAdminRequest(
      request("/admin/sandbox/meeting-minutes-probe"),
      env({ RUNTIME_CLAUDE_MODEL: "opus", RUNTIME_CLAUDE_EFFORT: "xhigh",
        MEETING_MINUTES_CONTEXT_MODE: "required" }),
      { createSandbox: () => client, tenantBoundaryHandle: TENANT_BOUNDARY_HANDLE },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, probe: "meeting-minutes-generation" });
    expect(client.exec).toHaveBeenCalledWith(
      expect.stringContaining("--output-format stream-json --verbose --include-hook-events --json-schema"),
      expect.objectContaining({
        timeout: 780_000,
        env: {
          IS_SANDBOX: "1",
          MANA_DISABLE_INTERACTIVE_JUDGMENT_HOOK: "1",
          MANA_TENANT_BOUNDARY_HANDLE: TENANT_BOUNDARY_HANDLE,
        },
      }),
    );
    expect(client.writeFile).toHaveBeenCalledWith("/tmp/meeting-minutes-prompt.txt", expect.stringContaining("議事録生成プローブ"));
    expect(client.writeFile).toHaveBeenCalledWith("/tmp/meeting-minutes-prompt.txt", expect.stringContaining("文脈モードはrequiredです"));
  });

  it("does not treat raw provider secrets as tenant authority when the boundary handle is absent", async () => {
    const client = sandbox();
    const response = await handleSandboxAdminRequest(
      request("/admin/sandbox/meeting-minutes-probe"),
      env({ ANTHROPIC_API_KEY: "raw-api-key", CLAUDE_CODE_OAUTH_TOKEN: "raw-oauth-token",
        RUNTIME_CLAUDE_MODEL: "opus", RUNTIME_CLAUDE_EFFORT: "xhigh" }),
      { createSandbox: () => client },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "tenant_boundary_required" });
    expect(client.exec).not.toHaveBeenCalled();
    expect(client.destroy).toHaveBeenCalledOnce();
  });

  it("accepts a model result bound to the server-issued context Receipt without interactive hooks", async () => {
    const client = sandbox({ success: true, stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "probe-session" }),
      JSON.stringify({ type: "result", session_id: "probe-session", structured_output: {
        title: "議事録生成プローブ", overview: "生成経路を確認した。", body: "生成経路を確認した。",
        tasks: [], used_source_refs: [], decision_candidates: [],
      } }),
    ].join("\n"), stderr: "" });
    const response = await handleSandboxAdminRequest(
      request("/admin/sandbox/meeting-minutes-probe"),
      env({ RUNTIME_CLAUDE_MODEL: "opus", RUNTIME_CLAUDE_EFFORT: "xhigh" }),
      { createSandbox: () => client, tenantBoundaryHandle: TENANT_BOUNDARY_HANDLE },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ ok: true }));
  });

  it("fails closed before generation when the production context mode is invalid", async () => {
    const client = sandbox();
    const response = await handleSandboxAdminRequest(
      request("/admin/sandbox/meeting-minutes-probe"),
      env({ MEETING_MINUTES_CONTEXT_MODE: "invalid" }),
      { createSandbox: () => client, tenantBoundaryHandle: TENANT_BOUNDARY_HANDLE },
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      probe: "meeting-minutes-generation",
      code: "meeting_minutes_context_mode_invalid",
    });
    expect(client.exec).not.toHaveBeenCalled();
    expect(client.destroy).toHaveBeenCalledOnce();
  });

  it("returns a bounded diagnostic code without leaking model output", async () => {
    const client = sandbox({ success: true, stdout: "not-json", stderr: "private-stderr" });
    const response = await handleSandboxAdminRequest(
      request("/admin/sandbox/meeting-minutes-probe"),
      env({ RUNTIME_CLAUDE_MODEL: "opus", RUNTIME_CLAUDE_EFFORT: "xhigh" }),
      { createSandbox: () => client, tenantBoundaryHandle: TENANT_BOUNDARY_HANDLE },
    );

    expect(response.status).toBe(502);
    const body = JSON.stringify(await response.json());
    expect(body).toContain("meeting_minutes_generation_stream_malformed");
    expect(body).not.toContain("not-json");
    expect(body).not.toContain("private-stderr");
  });
});
