export interface SandboxAdminEnv {
  SANDBOX_PROBE_TOKEN?: string;
}

interface ExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number;
}

interface ProbeSandbox {
  exec(
    command: string,
    options?: { env?: Record<string, string | undefined>; timeout?: number },
  ): Promise<ExecResult>;
  destroy(): Promise<void>;
}

interface ProbeDependencies {
  createSandbox: (id: string) => ProbeSandbox;
  randomId?: () => string;
}

async function secureEqual(actual: string | null, expected: string): Promise<boolean> {
  if (!actual || actual.length !== expected.length) return false;
  const encoder = new TextEncoder();
  const [actualDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(actualDigest);
  const right = new Uint8Array(expectedDigest);
  return left.every((value, index) => value === right[index]);
}

export async function isSandboxAdminAuthorized(request: Request, token?: string): Promise<boolean> {
  if (!token) return false;
  return secureEqual(request.headers.get("authorization"), `Bearer ${token}`);
}

function boundedVersion(output: string): string {
  return output.trim().replace(/[\r\n]+/g, " ").slice(0, 120);
}

export async function handleSandboxAdminRequest(
  request: Request,
  env: SandboxAdminEnv,
  dependencies: ProbeDependencies,
): Promise<Response> {
  if (!(await isSandboxAdminAuthorized(request, env.SANDBOX_PROBE_TOKEN))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const pathname = new URL(request.url).pathname;
  const sandbox = dependencies.createSandbox(
    `techknight-probe-${dependencies.randomId?.() ?? crypto.randomUUID()}`,
  );

  try {
    if (pathname === "/admin/sandbox/runtime-probe") {
      const result = await sandbox.exec("claude --version", { timeout: 60_000 });
      return Response.json({
        ok: result.success,
        tenant: "techknight",
        runtime: "claude-code",
        version: result.success ? boundedVersion(result.stdout) : undefined,
        providerForwarding: "trusted_forwarder_required",
      });
    }

    if (pathname === "/admin/sandbox/oauth-probe") {
      return Response.json({ error: "credential_forwarding_unavailable" }, { status: 503 });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  } catch {
    return Response.json({ error: "sandbox_probe_failed" }, { status: 502 });
  } finally {
    await sandbox.destroy().catch(() => undefined);
  }
}
