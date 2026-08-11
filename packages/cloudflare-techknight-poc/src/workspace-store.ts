import type { SlackQueueEvent } from "./types.js";

interface WorkspaceFs {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  ls(prefix: string): Promise<string[]>;
  writeFile(path: string, value: string): Promise<unknown>;
}

export async function persistEventOnce(
  fs: WorkspaceFs,
  event: SlackQueueEvent,
): Promise<{ created: boolean; path: string }> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(event.eventId)) {
    throw new Error("event_id_invalid");
  }

  const path = `/events/${event.eventId}.json`;
  await fs.mkdir("/events", { recursive: true });
  if ((await fs.ls("/events")).includes(path)) {
    return { created: false, path };
  }

  await fs.writeFile(path, JSON.stringify(event));
  return { created: true, path };
}
