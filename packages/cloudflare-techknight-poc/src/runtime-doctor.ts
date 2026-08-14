type Check = { name: string; status: "ok" | "failed"; detail?: string };

export interface RuntimeDoctorEnv {
  SLACK_BOT_TOKEN?: string;
  BRAINBASE_TASK_API_BASE_URL?: string;
  BRAINBASE_TASK_API_TOKEN?: string;
  BRAINBASE_GRAPH_API_TOKEN?: string;
  BRAINBASE_MCP_BASE_URL?: string;
  BRAINBASE_MCP_TOKEN?: string;
  GOOGLE_DRIVE_MCP_BASE_URL?: string;
  GOOGLE_DRIVE_MCP_TOKEN?: string;
  NOCODB_URL?: string;
  NOCODB_TOKEN?: string;
}

async function checkMcp(
  name: string,
  baseUrl: string | undefined,
  token: string | undefined,
  fetchImpl: typeof fetch,
): Promise<Check> {
  if (!baseUrl || !token) return { name, status: "failed", detail: "未設定" };
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "doctor", method: "tools/list" }),
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      return { name, status: "failed", detail: "リダイレクト拒否" };
    }
    return response.ok ? { name, status: "ok" } : { name, status: "failed", detail: `HTTP ${response.status}` };
  } catch {
    return { name, status: "failed", detail: "接続失敗" };
  }
}

export async function runRuntimeDoctor(
  env: RuntimeDoctorEnv,
  enabledMcp: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const checks: Check[] = [
    { name: "Slack", status: env.SLACK_BOT_TOKEN ? "ok" : "failed", ...(!env.SLACK_BOT_TOKEN ? { detail: "未設定" } : {}) },
    { name: "Task API", status: env.BRAINBASE_TASK_API_BASE_URL && env.BRAINBASE_TASK_API_TOKEN ? "ok" : "failed",
      ...(!(env.BRAINBASE_TASK_API_BASE_URL && env.BRAINBASE_TASK_API_TOKEN) ? { detail: "未設定" } : {}) },
    { name: "Graph", status: env.BRAINBASE_GRAPH_API_TOKEN ? "ok" : "failed", ...(!env.BRAINBASE_GRAPH_API_TOKEN ? { detail: "未設定" } : {}) },
  ];
  if (enabledMcp.includes("brainbase")) checks.push(await checkMcp("Brainbase MCP", env.BRAINBASE_MCP_BASE_URL, env.BRAINBASE_MCP_TOKEN, fetchImpl));
  if (enabledMcp.includes("google-drive")) checks.push(await checkMcp("Google Drive MCP", env.GOOGLE_DRIVE_MCP_BASE_URL, env.GOOGLE_DRIVE_MCP_TOKEN, fetchImpl));
  if (enabledMcp.includes("nocodb")) checks.push({ name: "NocoDB", status: env.NOCODB_URL && env.NOCODB_TOKEN ? "ok" : "failed",
    ...(!(env.NOCODB_URL && env.NOCODB_TOKEN) ? { detail: "未設定" } : {}) });
  const ok = checks.every((check) => check.status === "ok");
  return [`診断: ${ok ? "正常" : "異常あり"}`, ...checks.map((check) => `- ${check.name}: ${check.status === "ok" ? "正常" : `異常（${check.detail}）`}`)].join("\n");
}
