export interface DevelopmentResult { status: string; summary: string; storyId?: string; prUrl?: string }
export async function runRemoteDevelopmentRequest(input: { request: string; placementId: string; requesterId: string;
  baseUrl?: string; token?: string; fetchImpl?: typeof fetch }): Promise<string> {
  if (!input.baseUrl || !input.token) throw new Error("development_runner_not_configured");
  const origin = new URL(input.baseUrl);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash) throw new Error("development_runner_not_configured");
  const response = await (input.fetchImpl ?? fetch)(`${origin.origin}${origin.pathname.replace(/\/$/, "")}/run`, { method: "POST",
    headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
    body: JSON.stringify({ request: input.request, placement_id: input.placementId, requester_id: input.requesterId }),
    signal: AbortSignal.timeout(5_400_000) });
  const payload = await response.json().catch(() => null) as DevelopmentResult | null;
  if (!response.ok || !payload || typeof payload.status !== "string" || typeof payload.summary !== "string") throw new Error("development_runner_failed");
  return [`Development: ${payload.status}`, payload.storyId ? `Story: ${payload.storyId}` : undefined,
    payload.prUrl ? `PR: ${payload.prUrl}` : undefined, payload.summary].filter(Boolean).join("\n");
}
