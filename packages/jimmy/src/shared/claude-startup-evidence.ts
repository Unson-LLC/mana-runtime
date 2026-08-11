import fs from "node:fs";
import path from "node:path";

const MAX_EVIDENCE_CHARS = 16_384;

/** Strip terminal control sequences and redact common credential shapes before
 *  persisting a failed startup screen. This is diagnostic evidence, not a raw
 *  terminal transcript. */
export function sanitizeClaudeStartupEvidence(raw: string): string {
  let text = raw
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "[REDACTED_SLACK_TOKEN]")
    .replace(/xox[e]-[A-Za-z0-9-]+/g, "[REDACTED_SLACK_TOKEN]")
    .replace(/\bxapp-[A-Za-z0-9-]+/g, "[REDACTED_SLACK_TOKEN]")
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]+/g, "[REDACTED_API_TOKEN]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]")
    .replace(/\bhttps?:\/\/[^/\s:@]+:[^@\s/]+@/gi, "https://[REDACTED_BASIC_AUTH]@")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
    .replace(/(^|\n)([^\n]*(?:token|secret|password|authorization|api[_ -]?key)[^:=\n]*[:=]\s*)[^\n]+/gi, "$1$2[REDACTED]")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  if (text.length > MAX_EVIDENCE_CHARS) text = text.slice(-MAX_EVIDENCE_CHARS);
  return text.trim();
}

export function writeClaudeStartupEvidence(dir: string, sessionId: string, raw: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const safeId = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  const filePath = path.join(dir, `${safeId}-${Date.now()}.log`);
  const body = [
    `recorded_at=${new Date().toISOString()}`,
    `session_id=${safeId}`,
    "reason=session_start_timeout",
    "",
    sanitizeClaudeStartupEvidence(raw) || "(no PTY output captured)",
    "",
  ].join("\n");
  fs.writeFileSync(filePath, body, { mode: 0o600, flag: "wx" });
  fs.chmodSync(filePath, 0o600);
  return filePath;
}
