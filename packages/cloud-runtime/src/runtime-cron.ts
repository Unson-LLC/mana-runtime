import type { WorkspaceSessionFs } from "./workspace-session.js";

export interface RuntimeCronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: string;
  timezone: string;
  prompt: string;
  delivery: { connector: "slack"; channel: string };
}

const STATE_PATH = "/session/cron-overrides.json";

export function parsePlacementCronJobs(raw: string | undefined, allowedChannelId: string): RuntimeCronJob[] {
  if (!raw?.trim()) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((job): job is RuntimeCronJob => {
      if (!job || typeof job !== "object" || Array.isArray(job)) return false;
      const item = job as Partial<RuntimeCronJob>;
      return typeof item.id === "string" && Boolean(item.id.trim()) && typeof item.name === "string" &&
        typeof item.enabled === "boolean" && typeof item.schedule === "string" && typeof item.timezone === "string" &&
        typeof item.prompt === "string" && item.delivery?.connector === "slack" && item.delivery.channel === allowedChannelId;
    });
  } catch { return []; }
}

async function readOverrides(fs: WorkspaceSessionFs): Promise<Record<string, boolean>> {
  try {
    const raw = await fs.readFile(STATE_PATH);
    if (typeof raw !== "string") return {};
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
  } catch { return {}; }
}

export async function executeRuntimeCron(input: {
  fs: WorkspaceSessionFs;
  jobs: readonly RuntimeCronJob[];
  action: "list" | "run" | "enable" | "disable";
  target?: string;
  run: (job: RuntimeCronJob) => Promise<void>;
}): Promise<string> {
  const overrides = await readOverrides(input.fs);
  const jobs = input.jobs.map((job) => ({ ...job, enabled: overrides[job.id] ?? job.enabled }));
  if (input.action === "list") {
    return jobs.length === 0 ? "このplacementで実行可能な定期処理はありません。"
      : ["定期処理:", ...jobs.map((job) => `- ${job.name} (${job.id}) — ${job.enabled ? "有効" : "無効"} — ${job.schedule}`)].join("\n");
  }
  const job = jobs.find((candidate) => candidate.id === input.target || candidate.name === input.target);
  if (!job) return `定期処理「${input.target}」は、このplacementでは見つかりません。`;
  if (input.action === "run") {
    await input.run(job);
    return `定期処理「${job.name}」を実行しました。`;
  }
  const enabled = input.action === "enable";
  await input.fs.mkdir("/session", { recursive: true });
  await input.fs.writeFile(STATE_PATH, JSON.stringify({ ...overrides, [job.id]: enabled }));
  return `定期処理「${job.name}」を${enabled ? "有効" : "無効"}にしました。`;
}
