import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { DevelopmentRunnerConfig } from "../shared/types.js";

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_REQUEST_CHARS = 8000;
const DEFAULT_TIMEOUT_MS = 90 * 60 * 1000;
const ALLOWED_RESULT_KEYS = new Set(["status", "storyId", "prUrl", "summary"]);
const ALLOWED_STATUSES = new Set(["queued", "pr_ready", "needs_input", "failed"]);
const PR_URL_RE = /^https:\/\/github\.com\/Unson-LLC\/brainbase-mana\/pull\/\d+$/;

export interface DevelopmentResult {
  status: "queued" | "pr_ready" | "needs_input" | "failed";
  storyId?: string;
  prUrl?: string;
  summary: string;
}

type SpawnFn = typeof spawn;

async function waitForProcessGroupExit(pid: number): Promise<void> {
  while (true) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        continue;
      }
      throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

function validateConfig(config: DevelopmentRunnerConfig): void {
  if (!config.enabled) throw new Error("development runner is disabled");
  if (!path.isAbsolute(config.bin)) throw new Error("development runner bin must be absolute");
  if ((config.args ?? []).some((arg) => arg.includes("\0") || arg.includes("\n"))) {
    throw new Error("development runner args contain forbidden characters");
  }
}

export function parseDevelopmentResult(raw: string): DevelopmentResult {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("development runner returned malformed JSON");
  }
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("development runner returned a non-object result");
  }
  if (Object.keys(value).some((key) => !ALLOWED_RESULT_KEYS.has(key))) {
    throw new Error("development runner returned an unsupported field");
  }
  if (typeof value.status !== "string" || !ALLOWED_STATUSES.has(value.status)) {
    throw new Error("development runner returned an invalid status");
  }
  if (typeof value.summary !== "string" || value.summary.length === 0 || value.summary.length > 1000) {
    throw new Error("development runner returned an invalid summary");
  }
  if (value.storyId !== undefined && (typeof value.storyId !== "string" || !/^story-[a-z0-9-]+$/.test(value.storyId))) {
    throw new Error("development runner returned an invalid story id");
  }
  if (value.prUrl !== undefined && (typeof value.prUrl !== "string" || !PR_URL_RE.test(value.prUrl))) {
    throw new Error("development runner returned an invalid PR URL");
  }
  const status = value.status as DevelopmentResult["status"];
  if (status !== "failed" && typeof value.storyId !== "string") {
    throw new Error(`development runner returned ${status} without a story id`);
  }
  if (status !== "pr_ready" && value.prUrl !== undefined) {
    throw new Error(`development runner returned a PR URL for ${status}`);
  }
  return value as unknown as DevelopmentResult;
}

export async function runDevelopmentRequest(
  config: DevelopmentRunnerConfig,
  request: string,
  spawnFn: SpawnFn = spawn,
): Promise<DevelopmentResult> {
  validateConfig(config);
  if (!request.trim()) throw new Error("development request is empty");
  if (request.length > MAX_REQUEST_CHARS) throw new Error("development request is too large");

  return new Promise((resolve, reject) => {
    const child = spawnFn(config.bin, config.args ?? [], {
      cwd: "/",
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        LANG: process.env.LANG ?? "C.UTF-8",
      },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    let stdout = "";
    let outputBytes = 0;
    let settled = false;
    let terminationError: Error | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let closedCode: number | null | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const terminate = (error: Error) => {
      if (settled || terminationError) return;
      terminationError = error;
      const pid = child.pid;
      const signal = (name: NodeJS.Signals) => {
        if (pid && process.platform !== "win32") {
          try { process.kill(-pid, name); } catch { child.kill(name); }
        } else {
          child.kill(name);
        }
      };
      signal("SIGTERM");
      killTimer = setTimeout(() => {
        killTimer = null;
        signal("SIGKILL");
        void (async () => {
          if (pid && process.platform !== "win32") {
            try {
              await waitForProcessGroupExit(pid);
            } catch (error) {
              finish(() => reject(error));
              return;
            }
          }
          if (closedCode !== undefined) finish(() => reject(terminationError!));
        })();
      }, 5000);
    };
    const timer = setTimeout(() => {
      terminate(new Error("development runner timed out"));
    }, config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        terminate(new Error("development runner output exceeded limit"));
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.resume();
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      closedCode = code;
      // A detached group leader may exit on SIGTERM while a descendant keeps
      // running. Keep the lock/state until the scheduled group SIGKILL fires.
      if (terminationError && killTimer) return;
      finish(() => {
      if (terminationError) {
        reject(terminationError);
        return;
      }
      if (code !== 0) {
        reject(new Error(`development runner exited with code ${code ?? "unknown"}`));
        return;
      }
      try {
        resolve(parseDevelopmentResult(stdout.trim()));
      } catch (error) {
        reject(error);
      }
      });
    });
    child.stdin.end(JSON.stringify({ request: request.trim() }) + "\n");
  });
}

export function formatDevelopmentResult(result: DevelopmentResult): string {
  const lines = [
    `Development: ${result.status}`,
    result.storyId ? `Story: ${result.storyId}` : null,
    result.prUrl ? `PR: ${result.prUrl}` : null,
    result.summary,
  ].filter(Boolean);
  return lines.join("\n");
}
