export interface DevelopmentSandbox {
  writeFile(path: string, content: string): Promise<unknown>;
  startProcess(command: string, options: {
    processId: string;
    autoCleanup: boolean;
    timeout: number;
  }): Promise<{ id: string }>;
}

function authenticatedHttpsBase(value: string | undefined): URL {
  if (!value) throw new Error("development_runner_not_configured");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("development_runner_not_configured");
  }
  return url;
}

function jobIdForEvent(eventId: string): string {
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(eventId)) {
    throw new Error("development_runner_invalid_event_id");
  }
  return `development-${eventId}`;
}

export async function runCloudflareDevelopmentRequest(input: {
  request: string;
  placementId: string;
  requesterId: string;
  eventId: string;
  workspaceId: string;
  channelId: string;
  threadTs: string;
  callbackBaseUrl?: string;
  createSandbox: (id: string) => DevelopmentSandbox;
}): Promise<string> {
  const callback = authenticatedHttpsBase(input.callbackBaseUrl);
  const jobId = jobIdForEvent(input.eventId);
  const jobPath = `/tmp/${jobId}.json`;
  const callbackPath = callback.pathname.replace(/\/$/, "");
  const payload = {
    request: input.request,
    placement_id: input.placementId,
    requester_id: input.requesterId,
    event_id: input.eventId,
    workspace_id: input.workspaceId,
    channel_id: input.channelId,
    thread_ts: input.threadTs,
    callback_url: `${callback.origin}${callbackPath}/development/callback`,
  };

  try {
    const sandbox = input.createSandbox(jobId);
    await sandbox.writeFile(jobPath, JSON.stringify(payload));
    await sandbox.startProcess(
      `node /opt/mana/cloudflare-development-runner.mjs ${jobPath}`,
      { processId: jobId, autoCleanup: false, timeout: 4_800_000 },
    );
  } catch {
    throw new Error("development_runner_failed");
  }

  return `開発依頼を受け付けました。job: ${jobId}\n完了または判断が必要になった時点で、このスレッドへ通知します。`;
}
