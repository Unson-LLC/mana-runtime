import type { GeneratedMeetingMinutes } from "./meeting-minutes-contracts.js";

function nonEmpty(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

export function parseGeneratedMeetingMinutes(value: unknown): GeneratedMeetingMinutes {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const title = nonEmpty(record.title, 200); const overview = nonEmpty(record.overview, 3000);
  const body = nonEmpty(record.body, 100_000);
  if (!title || !overview || !body) throw new Error("meeting_minutes_generation_invalid");
  return { title, overview, body };
}

export function splitMeetingMinutesForSlack(body: string, maxChars = 2_900): string[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 100) throw new Error("slack_chunk_size_invalid");
  const chunks: string[] = [];
  let remaining = body.trim();
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars + 1);
    const boundary = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const cut = boundary >= Math.floor(maxChars * 0.5) ? boundary : maxChars;
    chunks.push(remaining.slice(0, cut).trim()); remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
