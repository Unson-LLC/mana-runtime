import type { MeetingMinutesRun } from "./meeting-minutes-contracts.js";
import type { WorkspaceFs } from "./workspace-store.js";

function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9_-]{3,260}$/.test(runId)) throw new Error("meeting_minutes_run_id_invalid");
}

async function readText(value: string | ReadableStream<Uint8Array>): Promise<string> {
  return typeof value === "string" ? value : await new Response(value).text();
}

export async function loadMeetingMinutesRun(fs: WorkspaceFs, runId: string): Promise<MeetingMinutesRun | undefined> {
  validateRunId(runId);
  const directory = "/meeting-minutes";
  const path = `${directory}/${runId}.json`;
  await fs.mkdir(directory, { recursive: true });
  if (!(await fs.ls(directory)).includes(path)) return undefined;
  const parsed = JSON.parse(await readText(await fs.readFile(path))) as MeetingMinutesRun;
  if (parsed.version !== 1 || parsed.runId !== runId) throw new Error("meeting_minutes_run_corrupt");
  return parsed;
}

export async function saveMeetingMinutesRun(fs: WorkspaceFs, run: MeetingMinutesRun): Promise<string> {
  validateRunId(run.runId);
  const directory = "/meeting-minutes";
  const path = `${directory}/${run.runId}.json`;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path, JSON.stringify(run));
  return path;
}
