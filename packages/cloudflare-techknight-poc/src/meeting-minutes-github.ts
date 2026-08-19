import type { GeneratedMeetingMinutes, MeetingMinutesDestination } from "./meeting-minutes-contracts.js";
import { stripMeetingMinutesActionItems } from "./meeting-minutes-generator.js";

export interface SavedMeetingMinutesRecords {
  transcriptPath: string; minutesPath: string; transcriptUrl: string; minutesUrl: string;
}
export interface SaveMeetingMinutesRecordsRequest {
  destination: MeetingMinutesDestination; transcript: string; minutes: GeneratedMeetingMinutes;
  sourceFileName: string; sourceTs: string;
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value); let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
function prefix(value?: string): string {
  const parts = (value ?? "").split("/").map((part) => part.trim()).filter((part) => part && part !== "." && part !== "..");
  return parts.length ? `${parts.join("/")}/` : "";
}
function name(value: string): string {
  return value.normalize("NFKC").replace(/\.txt$/i, "").replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, "-")
    .replace(/\s+/g, "-").replace(/\.{2,}/g, ".").replace(/^-+|-+$/g, "").slice(0, 120) || "meeting";
}
function jstDate(sourceTs: string): string {
  const seconds = Number.parseFloat(sourceTs); const date = Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date(0);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
export function formatCloudflareMeetingMinutesMarkdown(request: SaveMeetingMinutesRecordsRequest, transcriptPath: string, date: string): string {
  const tasks = request.minutes.tasks ?? [];
  const contextWarnings = request.minutes.brainbase_context_warnings ?? [];
  const contextWarningNote = contextWarnings.includes("unknown_source_ref_removed")
    ? ["> ⚠️ Brainbaseの正本にない参照候補を除外し、正本の参照だけで作成しました。", ""]
    : [];
  const actionItems = tasks.length ? tasks.flatMap((task) => {
    const details = [task.assignee_name ? `担当: ${task.assignee_name}` : undefined,
      task.due_at ? `期限: ${task.due_at.slice(0, 10)}` : undefined,
      task.priority ? `優先度: ${task.priority}` : undefined].filter(Boolean);
    return [`- [ ] ${task.title}${details.length ? `（${details.join(" / ")}）` : ""}`,
      ...(task.description ? [`  - 背景: ${task.description}`] : [])];
  }) : ["- なし"];
  return ["---", `title: ${JSON.stringify(request.minutes.title)}`, `date: ${date}`,
    `project_id: ${JSON.stringify(request.destination.projectId)}`, `transcript_ref: ${JSON.stringify(transcriptPath)}`,
    `brainbase_context_receipt: ${JSON.stringify(request.minutes.brainbase_context_receipt_id ?? null)}`,
    `brainbase_context_checksum: ${JSON.stringify(request.minutes.brainbase_context_checksum ?? null)}`,
    `brainbase_source_refs: ${JSON.stringify(request.minutes.used_source_refs ?? [])}`,
    `brainbase_context_warnings: ${JSON.stringify(contextWarnings)}`,
    "---", "", `# ${request.minutes.title}`, "", request.minutes.overview, "",
    ...contextWarningNote, stripMeetingMinutesActionItems(request.minutes.body), "",
    "## アクションアイテム", "", ...actionItems, ""].join("\n");
}

export class CloudflareMeetingMinutesGitHubClient {
  private readonly fetchImpl: typeof fetch;
  private readonly brokered: boolean;

  constructor(private readonly token?: string, fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? fetch;
    this.brokered = fetchImpl !== undefined;
  }

  private headers(): Record<string, string> {
    return { Accept: "application/vnd.github+json",
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      "User-Agent": "mana-runtime-meeting-minutes", "X-GitHub-Api-Version": "2022-11-28" };
  }
  async save(request: SaveMeetingMinutesRecordsRequest): Promise<SavedMeetingMinutesRecords> {
    if (!this.token?.trim() && !this.brokered) throw new Error("github_token_not_configured");
    const target = request.destination.github;
    if (!target.owner.trim() || !target.repo.trim()) throw new Error("github_destination_invalid");
    const date = jstDate(request.sourceTs); const base = name(request.sourceFileName); const root = prefix(target.pathPrefix);
    const transcriptPath = `${root}transcripts/${date}_${base}.txt`; const minutesPath = `${root}minutes/${date}_${base}.md`;
    const transcriptUrl = await this.put(target, transcriptPath, request.transcript, `Save meeting transcript: ${date} ${base}`);
    const minutesUrl = await this.put(target, minutesPath, formatCloudflareMeetingMinutesMarkdown(request, transcriptPath, date),
      `Save meeting minutes: ${date} ${base}`);
    return { transcriptPath, minutesPath, transcriptUrl, minutesUrl };
  }
  async delete(target: MeetingMinutesDestination["github"], paths: readonly string[]): Promise<void> {
    if (!this.token?.trim() && !this.brokered) throw new Error("github_token_not_configured");
    const branch = target.branch?.trim() || "main";
    const headers = this.headers();
    for (const path of paths) {
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const api = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/contents/${encodedPath}`;
      const current = await this.fetchImpl.call(globalThis, `${api}?ref=${encodeURIComponent(branch)}`, { headers });
      if (current.status === 404) continue;
      if (!current.ok) throw new Error(`github_read_failed:${current.status}`);
      const sha = ((await current.json()) as { sha?: string }).sha;
      if (!sha) throw new Error("github_existing_content_invalid");
      const deleted = await this.fetchImpl.call(globalThis, api, { method: "DELETE",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ message: `Remove misplaced meeting record: ${path}`, sha, branch }) });
      if (!deleted.ok && deleted.status !== 404) throw new Error(`github_delete_failed:${deleted.status}`);
    }
  }
  private async put(target: MeetingMinutesDestination["github"], path: string, content: string, message: string): Promise<string> {
    const branch = target.branch?.trim() || "main"; const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const api = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/contents/${encodedPath}`;
    const headers = this.headers();
    const current = await this.fetchImpl.call(globalThis, `${api}?ref=${encodeURIComponent(branch)}`, { headers }); let sha: string | undefined;
    if (current.ok) { sha = ((await current.json()) as { sha?: string }).sha; if (!sha) throw new Error("github_existing_content_invalid"); }
    else if (current.status !== 404) throw new Error(`github_read_failed:${current.status}`);
    const saved = await this.fetchImpl.call(globalThis, api, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ message, content: base64Utf8(content), branch, ...(sha ? { sha } : {}) }) });
    if (!saved.ok) throw new Error(`github_write_failed:${saved.status}`);
    const result = (await saved.json()) as { content?: { html_url?: string }; html_url?: string };
    return result.content?.html_url ?? result.html_url ?? `https://github.com/${target.owner}/${target.repo}/blob/${encodeURIComponent(branch)}/${encodedPath}`;
  }
}
