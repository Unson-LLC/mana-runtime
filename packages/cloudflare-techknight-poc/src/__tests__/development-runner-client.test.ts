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
    tenantId: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    connectionId: "wsc_01ARZ3NDEKTSV4RRFFQ69G5FAW",
    operationId: "op_01ARZ3NDEKTSV4RRFFQ69G5FAZ",
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

  it("partitions the Container by tenant, connection, and operation and auto-cleans the process record", async () => {
    const firstStart = vi.fn(async () => ({ id: "first" }));
    const secondStart = vi.fn(async () => ({ id: "second" }));
    const firstCreate = vi.fn(() => ({ writeFile: vi.fn(async () => undefined), startProcess: firstStart }));
    const secondCreate = vi.fn(() => ({ writeFile: vi.fn(async () => undefined), startProcess: secondStart }));

    await runCloudflareDevelopmentRequest(input({ createSandbox: firstCreate }));
    await runCloudflareDevelopmentRequest(input({
      tenantId: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAY",
      connectionId: "wsc_01ARZ3NDEKTSV4RRFFQ69G5FAX",
      operationId: "op_01ARZ3NDEKTSV4RRFFQ69G5FB1",
      createSandbox: secondCreate,
    }));

    const firstSandboxId = firstCreate.mock.calls[0]![0];
    const secondSandboxId = secondCreate.mock.calls[0]![0];
    expect(firstSandboxId).toMatch(/^development-[A-Za-z0-9_-]{43}$/);
    expect(secondSandboxId).toMatch(/^development-[A-Za-z0-9_-]{43}$/);
    expect(firstSandboxId).not.toBe(secondSandboxId);
    expect(firstStart.mock.calls[0]![1]).toEqual(expect.objectContaining({ autoCleanup: true }));
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
