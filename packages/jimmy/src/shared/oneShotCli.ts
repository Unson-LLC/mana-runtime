import { spawn } from "node:child_process";
import { resolveBin, formatSpawnError } from "./resolveBin.js";
import { buildChildEnv } from "./childEnv.js";

export type OneShotEngine = "claude" | "codex";

export interface OneShotOptions {
  engine?: OneShotEngine;
  bin: string;
  model: string;
  timeoutMs: number;
  spawnFn?: typeof spawn;
  label: string;
  /**
   * Pass the prompt over stdin instead of argv. Required for long prompts:
   * Linux caps a single argv entry at MAX_ARG_STRLEN (128KiB), which long
   * meeting transcripts exceed. Only supported for the claude engine
   * (`claude -p` reads stdin when the prompt argument is omitted).
   */
  promptViaStdin?: boolean;
}

export function defaultBinForEngine(engine: OneShotEngine): string {
  return engine === "codex" ? "codex" : "claude";
}

export function defaultModelForEngine(engine: OneShotEngine): string {
  return engine === "codex" ? "gpt-5-nano" : "claude-haiku-4-5";
}

export async function invokeOneShot(prompt: string, opts: OneShotOptions): Promise<string> {
  const engine = opts.engine ?? "claude";
  const viaStdin = opts.promptViaStdin === true;
  if (viaStdin && engine !== "claude") {
    throw new Error(`${opts.label}: promptViaStdin is only supported for the claude engine`);
  }
  return new Promise((resolve, reject) => {
    const args = buildArgs(engine, opts.model, viaStdin ? null : prompt);
    const resolvedBin = resolveBin(opts.bin);
    const proc = (opts.spawnFn ?? spawn)(resolvedBin, args, {
      stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"],
      env: buildChildEnv(),
    });
    if (viaStdin) {
      proc.stdin?.on("error", () => { /* EPIPE when the CLI exits early — close reports it */ });
      proc.stdin?.end(prompt);
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill("SIGTERM");
      } catch { /* ignore */ }
      reject(new Error(`${opts.label} timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(formatSpawnError(`${opts.label} CLI`, opts.bin, err)));
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${engine} exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve(engine === "codex" ? extractCodexResult(stdout) : extractClaudeResult(stdout));
    });
  });
}

/** `prompt: null` omits the positional prompt (claude then reads stdin). */
function buildArgs(engine: OneShotEngine, model: string, prompt: string | null): string[] {
  if (engine === "codex") {
    return [
      "exec",
      "--json",
      "--color",
      "never",
      "--model",
      model,
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      prompt ?? "",
    ];
  }
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    model,
    "--dangerously-skip-permissions",
    ...(prompt === null ? [] : [prompt]),
  ];
}

function extractClaudeResult(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && typeof parsed.result === "string") {
      return parsed.result;
    }
  } catch { /* fall through */ }
  return trimmed;
}

function extractCodexResult(stdout: string): string {
  let text = "";
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed) as Record<string, unknown>;
      if (msg.type !== "item.completed") continue;
      const item = msg.item as Record<string, unknown> | undefined;
      if (item?.type !== "agent_message") continue;
      if (typeof item.text === "string") text += item.text;
    } catch { /* ignore non-json lines */ }
  }
  return text || stdout.trim();
}
