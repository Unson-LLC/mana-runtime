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
    exec: vi.fn().mockResolvedValue(result),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
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
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("oauth-secret-must-not-leak");
    expect(client.destroy).toHaveBeenCalledOnce();
  });
});
