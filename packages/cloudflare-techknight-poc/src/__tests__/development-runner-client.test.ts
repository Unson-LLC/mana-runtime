import { describe, expect, it, vi } from "vitest";
import { runCloudflareDevelopmentRequest } from "../development-runner-client.js";

function input(overrides: Record<string, unknown> = {}) {
  const armTerminalWatchdog = vi.fn(async () => undefined);
  const cancelTerminalWatchdog = vi.fn(async () => undefined);
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
    githubCredentialLeaseHandle: "github_lease_handle_abcdefghijklmnopqrs",
    tenantBoundaryHandle: "tb_opaque_operation_handle_1234567890",
    contextExpiresAt: "2026-08-17T10:04:05.000Z",
    now: () => "2026-08-17T10:00:00.000Z",
    callbackBaseUrl: "https://worker.example.com",
    quotaDecision: "allowed" as const,
    registerJobOwner: vi.fn(async () => ({
      created: true,
      release: vi.fn(async () => undefined),
      armTerminalWatchdog,
      cancelTerminalWatchdog,
    })),
    createSandbox: vi.fn(),
    ...overrides,
  };
}

describe("runCloudflareDevelopmentRequest", () => {
  it("bounds the asynchronous process lifetime below the signed tenant context expiry", async () => {
    const startProcess = vi.fn(async (_command: string, _options: Record<string, unknown>) => (
      { id: "development-Ev1" }
    ));
    const createSandbox = vi.fn((_id: string) => ({
      writeFile: vi.fn(async () => undefined),
      startProcess,
    }));

    await runCloudflareDevelopmentRequest(input({ createSandbox }));

    expect(startProcess.mock.calls[0]![1]).toEqual(expect.objectContaining({ timeout: 240_000 }));
  });

  it("fails closed before launch when the signed tenant context cannot cover process startup", async () => {
    const startProcess = vi.fn(async () => ({ id: "development-Ev1" }));
    const createSandbox = vi.fn(() => ({
      writeFile: vi.fn(async () => undefined),
      startProcess,
    }));

    await expect(runCloudflareDevelopmentRequest(input({
      contextExpiresAt: "2026-08-17T10:00:04.999Z",
      createSandbox,
    }))).rejects.toThrow("development_tenant_context_expiring");
    expect(createSandbox).not.toHaveBeenCalled();
    expect(startProcess).not.toHaveBeenCalled();
  });

  it("stores a bounded job and starts the bundled runner asynchronously", async () => {
    const writeFile = vi.fn(async (_path: string, _content: string) => undefined);
    const startProcess = vi.fn(async (_command: string, _options: Record<string, unknown>) => ({ id: "development-Ev1" }));
    const createSandbox = vi.fn((_id: string) => ({ writeFile, startProcess }));

    await expect(runCloudflareDevelopmentRequest(input({ createSandbox }))).resolves.toContain("development-");

    const sandboxId = createSandbox.mock.calls[0]![0];
    const jobId = JSON.parse(writeFile.mock.calls[0]![1]).job_id as string;
    expect(jobId).toMatch(/^development-[A-Za-z0-9_-]{43}$/);
    expect(sandboxId).toMatch(/^development-sandbox-[0-9a-f-]{36}$/);
    expect(createSandbox).toHaveBeenCalledWith(sandboxId);
    expect(writeFile).toHaveBeenCalledOnce();
    expect(JSON.parse(writeFile.mock.calls[0]![1])).toEqual(expect.objectContaining({
      request: "修正して",
      job_id: jobId,
      placement_id: "mana-dev-biz",
      callback_url: "https://worker.example.com/development/callback",
      runner_timeout_ms: 230_000,
    }));
    expect(startProcess).toHaveBeenCalledWith(
      `node /opt/mana/cloudflare-development-runner.mjs /tmp/${jobId}.json`,
      expect.objectContaining({
        processId: jobId,
        autoCleanup: true,
        env: {
          IS_SANDBOX: "1",
          CLAUDE_CODE_OAUTH_TOKEN: "mana-tenant-boundary-v1:tb_opaque_operation_handle_1234567890",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: "Authorization: Bearer mana-tenant-boundary-v1:tb_opaque_operation_handle_1234567890",
          MANA_TENANT_BOUNDARY_HANDLE: "tb_opaque_operation_handle_1234567890",
        },
      }),
    );
    expect(JSON.stringify(startProcess.mock.calls[0]![1])).not.toContain("mana-credential-lease-v1:");
  });

  it("arms an exact durable timeout callback before the Container can start", async () => {
    const armTerminalWatchdog = vi.fn(async (_watchdog: {
      callback_body: string;
      activate_at: string;
      terminal_deadline_at: string;
    }) => undefined);
    const cancelTerminalWatchdog = vi.fn(async () => undefined);
    const registerJobOwner = vi.fn(async () => ({
      created: true,
      release: vi.fn(async () => undefined),
      armTerminalWatchdog,
      cancelTerminalWatchdog,
    }));
    const createSandbox = vi.fn((_id: string) => ({
      writeFile: vi.fn(async () => undefined),
      startProcess: vi.fn(async () => ({ id: "development-Ev1" })),
    }));

    await runCloudflareDevelopmentRequest(input({ registerJobOwner, createSandbox }));

    expect(armTerminalWatchdog).toHaveBeenCalledOnce();
    const armed = armTerminalWatchdog.mock.calls[0]![0];
    expect((armed as typeof armed & { container_id?: string }).container_id)
      .toBe(createSandbox.mock.calls[0]![0]);
    expect(JSON.parse(armed.callback_body)).toEqual(expect.objectContaining({
      status: "timed_out",
      quota_decision: "allowed",
    }));
    expect(Date.parse(armed.activate_at)).toBeLessThan(Date.parse(armed.terminal_deadline_at));
    expect(armTerminalWatchdog.mock.invocationCallOrder[0])
      .toBeLessThan(createSandbox.mock.invocationCallOrder[0]!);
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
    const firstStart = vi.fn(async (_command: string, _options: Record<string, unknown>) => ({ id: "first" }));
    const secondStart = vi.fn(async (_command: string, _options: Record<string, unknown>) => ({ id: "second" }));
    const firstCreate = vi.fn((_id: string) => ({ writeFile: vi.fn(async () => undefined), startProcess: firstStart }));
    const secondCreate = vi.fn((_id: string) => ({ writeFile: vi.fn(async () => undefined), startProcess: secondStart }));

    await runCloudflareDevelopmentRequest(input({ createSandbox: firstCreate }));
    await runCloudflareDevelopmentRequest(input({
      tenantId: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAY",
      connectionId: "wsc_01ARZ3NDEKTSV4RRFFQ69G5FAX",
      operationId: "op_01ARZ3NDEKTSV4RRFFQ69G5FB1",
      createSandbox: secondCreate,
    }));

    const firstSandboxId = firstCreate.mock.calls[0]![0];
    const secondSandboxId = secondCreate.mock.calls[0]![0];
    expect(firstSandboxId).toMatch(/^development-sandbox-[0-9a-f-]{36}$/);
    expect(secondSandboxId).toMatch(/^development-sandbox-[0-9a-f-]{36}$/);
    expect(firstSandboxId).not.toBe(secondSandboxId);
    expect(firstStart.mock.calls[0]![1]).toEqual(expect.objectContaining({ autoCleanup: true }));
  });

  it("never reuses a Container even for the same tenant operation", async () => {
    const firstCreate = vi.fn((_id: string) => ({ writeFile: vi.fn(async () => undefined),
      startProcess: vi.fn(async () => ({ id: "first" })) }));
    const secondCreate = vi.fn((_id: string) => ({ writeFile: vi.fn(async () => undefined),
      startProcess: vi.fn(async () => ({ id: "second" })) }));

    const firstJobId = await runCloudflareDevelopmentRequest(input({ createSandbox: firstCreate }));
    const secondJobId = await runCloudflareDevelopmentRequest(input({ createSandbox: secondCreate }));

    expect(firstJobId).toBe(secondJobId);
    expect(firstCreate.mock.calls[0]![0]).not.toBe(secondCreate.mock.calls[0]![0]);
  });

  it("does not launch a second Container when the durable job owner already exists", async () => {
    const createSandbox = vi.fn();
    const registerJobOwner = vi.fn(async () => ({
      created: false,
      release: vi.fn(async () => undefined),
      armTerminalWatchdog: vi.fn(async () => undefined),
      cancelTerminalWatchdog: vi.fn(async () => undefined),
    }));

    await expect(runCloudflareDevelopmentRequest(input({ createSandbox, registerJobOwner })))
      .resolves.toContain("development-");

    expect(registerJobOwner).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      connectionId: "wsc_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      operationId: "op_01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      eventId: "Ev1",
      workspaceId: "T1",
      channelId: "C1",
      threadTs: "1.0",
      requesterId: "U1",
      placementId: "mana-dev-biz",
      quotaDecision: "allowed",
    }));
    expect(createSandbox).not.toHaveBeenCalled();
  });

  it("releases the durable job owner when Container startup fails", async () => {
    const release = vi.fn(async () => undefined);
    const armTerminalWatchdog = vi.fn(async () => undefined);
    const cancelTerminalWatchdog = vi.fn(async () => undefined);
    const destroy = vi.fn(async () => undefined);
    const registerJobOwner = vi.fn(async () => ({
      created: true,
      release,
      armTerminalWatchdog,
      cancelTerminalWatchdog,
    }));
    const createSandbox = vi.fn(() => ({
      writeFile: vi.fn(async () => undefined),
      startProcess: vi.fn(async () => { throw new Error("secret internal failure"); }),
      destroy,
    }));

    await expect(runCloudflareDevelopmentRequest(input({ createSandbox, registerJobOwner })))
      .rejects.toThrow("development_runner_failed");

    expect(release).toHaveBeenCalledOnce();
    expect(cancelTerminalWatchdog).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("fails closed when a partially started Container cannot be sanitized", async () => {
    const release = vi.fn(async () => undefined);
    const cancelTerminalWatchdog = vi.fn(async () => undefined);
    const registerJobOwner = vi.fn(async () => ({
      created: true,
      release,
      armTerminalWatchdog: vi.fn(async () => undefined),
      cancelTerminalWatchdog,
    }));
    const createSandbox = vi.fn(() => ({
      writeFile: vi.fn(async () => undefined),
      startProcess: vi.fn(async () => { throw new Error("secret startup failure"); }),
      destroy: vi.fn(async () => { throw new Error("secret destroy failure"); }),
    }));

    await expect(runCloudflareDevelopmentRequest(input({ createSandbox, registerJobOwner })))
      .rejects.toThrow(/^development_container_sanitization_unproven$/);

    expect(release).not.toHaveBeenCalled();
    expect(cancelTerminalWatchdog).not.toHaveBeenCalled();
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
      destroy: vi.fn(async () => undefined),
    }));
    await expect(runCloudflareDevelopmentRequest(input({ createSandbox })))
      .rejects.toThrow(/^development_runner_failed$/);
  });
});
