import type { GeneratedMinutes } from "./meeting-minutes-generator.js";

export interface MeetingMinutesGitHubTarget {
  owner: string;
  repo: string;
  branch?: string;
  pathPrefix?: string;
}

export interface SaveMeetingRecordsRequest {
  target: MeetingMinutesGitHubTarget;
  transcript: string;
  minutes: GeneratedMinutes;
  sourceFileName: string;
  sourceTs: string;
  projectId: string;
}

export interface SavedMeetingRecords {
  transcriptPath: string;
  minutesPath: string;
  transcriptUrl: string;
  minutesUrl: string;
  savedAt: number;
}

interface GitHubContentResponse {
  sha?: string;
  html_url?: string;
  content?: { html_url?: string };
}

export interface MeetingMinutesGitHubClientOptions {
  token?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function normalizeSegment(value: string, fallback: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/\.txt$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return normalized || fallback;
}

function normalizePrefix(value: string | undefined): string {
  const parts = (value ?? "")
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part && part !== "." && part !== "..");
  return parts.length > 0 ? `${parts.join("/")}/` : "";
}

function jstDate(sourceTs: string): string {
  const seconds = Number.parseFloat(sourceTs);
  const date = Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date();
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function formatMeetingMinutesMarkdown(
  request: Pick<SaveMeetingRecordsRequest, "minutes" | "projectId">,
  transcriptPath: string,
  date: string,
): string {
  return [
    "---",
    `title: ${yamlString(request.minutes.title)}`,
    `date: ${date}`,
    `project_id: ${yamlString(request.projectId)}`,
    `transcript_ref: ${yamlString(transcriptPath)}`,
    "---",
    "",
    `# ${request.minutes.title}`,
    "",
    request.minutes.overview,
    "",
    request.minutes.body,
    "",
  ].join("\n");
}

export class MeetingMinutesGitHubClient {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: MeetingMinutesGitHubClientOptions = {}) {
    this.token = options.token?.trim() ?? "";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async save(request: SaveMeetingRecordsRequest): Promise<SavedMeetingRecords> {
    if (!this.token) throw new Error("github_token_not_configured");
    const { owner, repo } = request.target;
    if (!owner?.trim() || !repo?.trim()) throw new Error("github_destination_invalid");

    const branch = request.target.branch?.trim() || "main";
    const date = jstDate(request.sourceTs);
    const baseName = normalizeSegment(request.sourceFileName, `meeting-${request.sourceTs.replace(/\D/g, "-")}`);
    const prefix = normalizePrefix(request.target.pathPrefix);
    const transcriptPath = `${prefix}transcripts/${date}_${baseName}.txt`;
    const minutesPath = `${prefix}minutes/${date}_${baseName}.md`;

    const transcriptUrl = await this.putFile({ owner, repo, branch, path: transcriptPath }, request.transcript,
      `Save meeting transcript: ${date} ${baseName}`);
    const minutesUrl = await this.putFile(
      { owner, repo, branch, path: minutesPath },
      formatMeetingMinutesMarkdown(request, transcriptPath, date),
      `Save meeting minutes: ${date} ${baseName}`,
    );

    return { transcriptPath, minutesPath, transcriptUrl, minutesUrl, savedAt: this.now() };
  }

  private async putFile(
    target: { owner: string; repo: string; branch: string; path: string },
    content: string,
    message: string,
  ): Promise<string> {
    const encodedPath = target.path.split("/").map(encodeURIComponent).join("/");
    const apiUrl = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/contents/${encodedPath}`;
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "User-Agent": "mana-runtime-meeting-minutes",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const current = await this.fetchImpl(`${apiUrl}?ref=${encodeURIComponent(target.branch)}`, { headers });
    let sha: string | undefined;
    if (current.ok) {
      const body = await current.json() as GitHubContentResponse;
      sha = body.sha;
      if (!sha) throw new Error("github_existing_content_invalid");
    } else if (current.status !== 404) {
      throw new Error(`github_read_failed:${current.status}`);
    }

    const response = await this.fetchImpl(apiUrl, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        content: Buffer.from(content, "utf8").toString("base64"),
        branch: target.branch,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!response.ok) throw new Error(`github_write_failed:${response.status}`);
    const body = await response.json() as GitHubContentResponse;
    return body.content?.html_url ?? body.html_url ??
      `https://github.com/${target.owner}/${target.repo}/blob/${encodeURIComponent(target.branch)}/${encodedPath}`;
  }
}
