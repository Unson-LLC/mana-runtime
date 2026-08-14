import { describe, expect, it, vi } from "vitest";
import { runRuntimeDoctor } from "../runtime-doctor.js";

describe("runtime doctor", () => {
  it("checks each placement MCP without exposing credentials", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toMatch(/^Bearer /);
      expect(headers.get("accept")).toBe("application/json, text/event-stream");
      return Response.json({ jsonrpc: "2.0", result: { tools: [] } });
    }) as unknown as typeof fetch;
    const text = await runRuntimeDoctor({
      SLACK_BOT_TOKEN: "slack-secret", BRAINBASE_TASK_API_BASE_URL: "https://bb.unson.jp", BRAINBASE_TASK_API_TOKEN: "task-secret",
      BRAINBASE_GRAPH_API_TOKEN: "graph-secret", BRAINBASE_MCP_BASE_URL: "https://bb.unson.jp/runtime-mcp", BRAINBASE_MCP_TOKEN: "mcp-secret",
      GOOGLE_DRIVE_MCP_BASE_URL: "https://bb.unson.jp/runtime-google-drive", GOOGLE_DRIVE_MCP_TOKEN: "drive-secret",
      NOCODB_URL: "https://nocodb.example", NOCODB_TOKEN: "nocodb-secret",
    }, ["brainbase", "google-drive", "nocodb"], fetchImpl);
    expect(text).toContain("診断: 正常");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(text).not.toMatch(/secret/);
  });

  it("reports missing bindings as failure", async () => {
    const text = await runRuntimeDoctor({}, ["google-drive"]);
    expect(text).toContain("診断: 異常あり");
    expect(text).toContain("Google Drive MCP: 異常（未設定）");
  });
});
