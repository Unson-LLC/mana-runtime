import { handleSandboxAdminRequest } from "../sandbox-admin.js";

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
      env({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret" }),
      { createSandbox: () => client, randomId: () => "fixed" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      tenant: "techknight",
      runtime: "claude-code",
      version: "2.1.227",
      oauthConfigured: true,
      credentialLocation: "worker-secret",
    });
    expect(client.destroy).toHaveBeenCalledOnce();
  });

  it("fails closed when the TechKnight OAuth secret is absent", async () => {
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

  it("passes only a placeholder into a fresh container and suppresses command output", async () => {
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

    expect(response.status).toBe(200);
    expect(client.exec).toHaveBeenCalledWith(expect.stringContaining("TECHKNIGHT_OAUTH_OK"), {
      timeout: 120_000,
      env: {
        IS_SANDBOX: "1",
        CLAUDE_CODE_OAUTH_TOKEN: "proxy-injected",
      },
    });
    const command = client.exec.mock.calls[0]?.[0] as string;
    expect(command).not.toContain("--model");
    expect(command).not.toContain("--effort");
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
      env({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret", RUNTIME_CLAUDE_MODEL: "opus", RUNTIME_CLAUDE_EFFORT: "xhigh",
        TENANT_ID: "unson-business", MEETING_MINUTES_CONTEXT_MODE: "required" }),
      { createSandbox: () => client },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true, tenant: "unson-business", probe: "meeting-minutes-generation",
    });
    expect(client.exec).toHaveBeenCalledWith(
      expect.stringContaining("--output-format stream-json --verbose --include-hook-events --json-schema"),
      expect.objectContaining({ timeout: 600_000 }),
    );
    expect(client.writeFile).toHaveBeenCalledWith("/tmp/meeting-minutes-prompt.txt", expect.stringContaining("議事録生成プローブ"));
    expect(client.writeFile).toHaveBeenCalledWith("/tmp/meeting-minutes-prompt.txt", expect.stringContaining("文脈モードはrequiredです"));
  });

  it("rejects a model result when the production Judgment hooks are absent", async () => {
    const client = sandbox({ success: true, stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "probe-session" }),
      JSON.stringify({ type: "result", session_id: "probe-session", structured_output: {
        title: "議事録生成プローブ", overview: "生成経路を確認した。", body: "生成経路を確認した。",
        tasks: [], used_source_refs: [], decision_candidates: [],
      } }),
    ].join("\n"), stderr: "" });
    const response = await handleSandboxAdminRequest(
      request("/admin/sandbox/meeting-minutes-probe"),
      env({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret", RUNTIME_CLAUDE_MODEL: "opus", RUNTIME_CLAUDE_EFFORT: "xhigh" }),
      { createSandbox: () => client },
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      ok: false, code: "meeting_minutes_judgment_lifecycle_incomplete",
    }));
  });

  it("fails closed before generation when the production context mode is invalid", async () => {
    const client = sandbox();
    const response = await handleSandboxAdminRequest(
      request("/admin/sandbox/meeting-minutes-probe"),
      env({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret", MEETING_MINUTES_CONTEXT_MODE: "invalid" }),
      { createSandbox: () => client },
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      tenant: "techknight",
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
      env({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret", RUNTIME_CLAUDE_MODEL: "opus", RUNTIME_CLAUDE_EFFORT: "xhigh" }),
      { createSandbox: () => client },
    );

    expect(response.status).toBe(502);
    const body = JSON.stringify(await response.json());
    expect(body).toContain("meeting_minutes_generation_stream_malformed");
    expect(body).not.toContain("not-json");
    expect(body).not.toContain("private-stderr");
  });
});
