import { describe, expect, it, vi } from "vitest";
import { runCloudflareDevelopmentRequest } from "../development-runner-client.js";

function input(overrides: Record<string, unknown> = {}) {
  return {
    request: "修正して",
    placementId: "mana-dev-biz",
    requesterId: "U1",
    eventId: "Ev1",
    workspaceId: "T1",
    channelId: "C1",
    threadTs: "1.0",
    credentialLeaseHandle: "lease_handle_abcdefghijklmnopqrstuvwxyz12",
    tenantBoundaryHandle: "tb_opaque_operation_handle_1234567890",
    callbackBaseUrl: "https://worker.example.com",
    createSandbox: vi.fn(),
    ...overrides,
  };
}

describe("runCloudflareDevelopmentRequest", () => {
  it("stores a bounded job and starts the bundled runner asynchronously", async () => {
    const writeFile = vi.fn(async (_path: string, _content: string) => undefined);
    const startProcess = vi.fn(async (_command: string, _options: Record<string, unknown>) => ({ id: "development-Ev1" }));
    const createSandbox = vi.fn(() => ({ writeFile, startProcess }));

    await expect(runCloudflareDevelopmentRequest(input({ createSandbox }))).resolves.toContain("development-Ev1");

    expect(createSandbox).toHaveBeenCalledWith("development-Ev1");
    expect(writeFile).toHaveBeenCalledOnce();
    expect(JSON.parse(writeFile.mock.calls[0]![1])).toEqual(expect.objectContaining({
      request: "修正して",
      placement_id: "mana-dev-biz",
      callback_url: "https://worker.example.com/development/callback",
    }));
    expect(startProcess).toHaveBeenCalledWith(
      "node /opt/mana/cloudflare-development-runner.mjs /tmp/development-Ev1.json",
      expect.objectContaining({
        processId: "development-Ev1",
        autoCleanup: false,
        env: {
          IS_SANDBOX: "1",
          CLAUDE_CODE_OAUTH_TOKEN: "mana-credential-lease-v1:lease_handle_abcdefghijklmnopqrstuvwxyz12",
          MANA_TENANT_BOUNDARY_HANDLE: "tb_opaque_operation_handle_1234567890",
        },
      }),
    );
  });

  it("never interpolates request text into the shell command", async () => {
    const dangerous = "fix '$(touch /tmp/pwned)'\nthen";
    const startProcess = vi.fn(async (_command: string, _options: Record<string, unknown>) => ({ id: "development-Ev1" }));
    const writeFile = vi.fn(async (_path: string, _content: string) => undefined);
    const createSandbox = vi.fn(() => ({ writeFile, startProcess }));

    await runCloudflareDevelopmentRequest(input({ request: dangerous, createSandbox }));

    expect(startProcess.mock.calls[0]![0]).not.toContain(dangerous);
    expect(JSON.parse(writeFile.mock.calls[0]![1]).request).toBe(dangerous);
  });

  it("fails closed before starting when callback configuration is missing", async () => {
    const createSandbox = vi.fn();
    await expect(runCloudflareDevelopmentRequest(input({ callbackBaseUrl: undefined, createSandbox })))
      .rejects.toThrow("development_runner_not_configured");
    expect(createSandbox).not.toHaveBeenCalled();
  });

  it("rejects unsafe event identifiers instead of building a command", async () => {
    const createSandbox = vi.fn();
    await expect(runCloudflareDevelopmentRequest(input({ eventId: "Ev1; rm -rf x", createSandbox })))
      .rejects.toThrow("development_runner_invalid_event_id");
    expect(createSandbox).not.toHaveBeenCalled();
  });

  it("maps sandbox startup failures without leaking their message", async () => {
    const createSandbox = vi.fn(() => ({
      writeFile: vi.fn(async () => undefined),
      startProcess: vi.fn(async () => { throw new Error("secret internal failure"); }),
    }));
    await expect(runCloudflareDevelopmentRequest(input({ createSandbox })))
      .rejects.toThrow(/^development_runner_failed$/);
  });
});
