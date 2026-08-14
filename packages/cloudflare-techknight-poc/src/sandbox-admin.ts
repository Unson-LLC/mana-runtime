import { hasAnthropicCredential } from "./anthropic-auth.js";

const OAUTH_OK_MARKER = "TECHKNIGHT_OAUTH_OK";

export interface SandboxAdminEnv {
  SANDBOX_PROBE_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
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
        oauthConfigured: hasAnthropicCredential(env),
        credentialLocation: "worker-secret",
      });
    }

    if (pathname === "/admin/sandbox/oauth-probe") {
      if (!hasAnthropicCredential(env)) {
        return Response.json({ error: "oauth_not_configured" }, { status: 503 });
      }
      const result = await sandbox.exec(
        `claude --print --permission-mode bypassPermissions "Reply exactly: ${OAUTH_OK_MARKER}"`,
        {
          timeout: 120_000,
          env: {
            IS_SANDBOX: "1",
            CLAUDE_CODE_OAUTH_TOKEN: "proxy-injected",
          },
        },
      );
      const ok = result.success && result.stdout.includes(OAUTH_OK_MARKER);
      return Response.json(
        {
          ok,
          tenant: "techknight",
          auth: "anthropic-oauth",
          credentialLocation: "worker-secret",
          freshContainer: true,
        },
        { status: ok ? 200 : 502 },
      );
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  } catch {
    return Response.json({ error: "sandbox_probe_failed" }, { status: 502 });
  } finally {
    await sandbox.destroy().catch(() => undefined);
  }
}
