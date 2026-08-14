export interface DevelopmentSubmission { status: "accepted"; job_id: string }

function authenticatedHttpsBase(value: string | undefined): URL {
  if (!value) throw new Error("development_runner_not_configured");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("development_runner_not_configured");
  }
  return url;
}

export async function runRemoteDevelopmentRequest(input: {
  request: string; placementId: string; requesterId: string; eventId: string; workspaceId: string;
  channelId: string; threadTs: string; callbackBaseUrl?: string; baseUrl?: string; token?: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const origin = authenticatedHttpsBase(input.baseUrl);
  const callback = authenticatedHttpsBase(input.callbackBaseUrl);
  if (!input.token) throw new Error("development_runner_not_configured");
  const response = await (input.fetchImpl ?? fetch)(`${origin.origin}${origin.pathname.replace(/\/$/, "")}/run`, {
    method: "POST",
    headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
    body: JSON.stringify({ request: input.request, placement_id: input.placementId, requester_id: input.requesterId,
      event_id: input.eventId, workspace_id: input.workspaceId, channel_id: input.channelId, thread_ts: input.threadTs,
      callback_url: `${callback.origin}${callback.pathname.replace(/\/$/, "")}/development/callback` }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null) as DevelopmentSubmission | null;
  if (response.status !== 202 || !payload || payload.status !== "accepted" ||
    typeof payload.job_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.job_id)) {
    throw new Error("development_runner_failed");
  }
  return `開発依頼を受け付けました。job: ${payload.job_id}\n完了または判断が必要になった時点で、このスレッドへ通知します。`;
}
