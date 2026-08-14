import type { SlackFileReference, SlackQueueEvent } from "./types.js";

const MAX_FILES = 10;
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_CHARS = 20_000;
const TEXT_MIME_TYPES = new Set([
  "text/plain", "text/markdown", "text/csv", "application/json", "application/xml",
]);

export class SlackAttachmentError extends Error {
  constructor(readonly code: string) { super(code); this.name = "SlackAttachmentError"; }
}

interface SlackFileMetadata extends SlackFileReference { url: string }

function safeText(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

async function metadata(file: SlackFileReference, token: string, fetchImpl: typeof fetch): Promise<SlackFileMetadata> {
  let response: Response;
  try {
    response = await fetchImpl(`https://slack.com/api/files.info?file=${encodeURIComponent(file.id)}`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new SlackAttachmentError("slack_attachment_metadata_unavailable"); }
  if (!response.ok) throw new SlackAttachmentError("slack_attachment_metadata_unavailable");
  const payload = await response.json().catch(() => undefined) as { ok?: unknown; file?: Record<string, unknown> } | undefined;
  if (payload?.ok !== true || !payload.file) throw new SlackAttachmentError("slack_attachment_metadata_unavailable");
  const id = safeText(payload.file.id, 128);
  const name = safeText(payload.file.name, 512);
  const mimetype = safeText(payload.file.mimetype, 128);
  const url = safeText(payload.file.url_private_download, 2_048) ?? safeText(payload.file.url_private, 2_048);
  const size = typeof payload.file.size === "number" && Number.isSafeInteger(payload.file.size) ? payload.file.size : undefined;
  if (id !== file.id || !name || !url || !mimetype || size === undefined || size < 0) {
    throw new SlackAttachmentError("slack_attachment_metadata_invalid");
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
    !(parsed.hostname === "files.slack.com" || parsed.hostname.endsWith(".slack.com"))) {
    throw new SlackAttachmentError("slack_attachment_url_invalid");
  }
  return { id, name, mimetype, size, url };
}

async function downloadText(file: SlackFileMetadata, token: string, fetchImpl: typeof fetch): Promise<string> {
  if ((file.size ?? 0) > MAX_DOWNLOAD_BYTES) throw new SlackAttachmentError("slack_attachment_too_large");
  let response: Response;
  try {
    response = await fetchImpl(file.url, { headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000) });
  } catch { throw new SlackAttachmentError("slack_attachment_download_unavailable"); }
  if (!response.ok) throw new SlackAttachmentError("slack_attachment_download_unavailable");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new SlackAttachmentError("slack_attachment_too_large");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes).slice(0, MAX_TEXT_CHARS); }
  catch { throw new SlackAttachmentError("slack_attachment_text_invalid"); }
}

export async function hydrateSlackAttachments(event: SlackQueueEvent, options: {
  botToken?: string; fetchImpl?: typeof fetch;
}): Promise<SlackQueueEvent> {
  if (!event.files?.length) return event;
  if (!options.botToken) throw new SlackAttachmentError("slack_bot_token_not_configured");
  if (event.files.length > MAX_FILES) throw new SlackAttachmentError("slack_attachments_too_many");
  const fetchImpl = options.fetchImpl ?? fetch;
  const sections: string[] = [];
  for (const reference of event.files) {
    const file = await metadata(reference, options.botToken, fetchImpl);
    const header = `添付: ${file.name} (${file.mimetype}, ${file.size} bytes)`;
    if (!TEXT_MIME_TYPES.has(file.mimetype ?? "")) {
      sections.push(`${header}\n本文取得対象外`);
      continue;
    }
    sections.push(`${header}\n---\n${await downloadText(file, options.botToken, fetchImpl)}\n---`);
  }
  return { ...event, attachmentContext: sections.join("\n\n") };
}
