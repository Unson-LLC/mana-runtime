export interface WorkspaceSessionFs {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  readFile(path: string): Promise<string | ReadableStream<Uint8Array>>;
  writeFile(path: string, value: string): Promise<unknown>;
}

export interface WorkspaceSessionState {
  generation: number;
  lastNewCommandId?: string;
  modelOverride?: string;
  engaged?: boolean;
  permissionRevision?: string;
  claudeSessionStartedGeneration?: number;
  updatedAt?: string;
}

const SESSION_PATH = "/session/state.json";

async function readText(value: string | ReadableStream<Uint8Array>): Promise<string> {
  return typeof value === "string" ? value : await new Response(value).text();
}

export async function readWorkspaceSession(fs: WorkspaceSessionFs): Promise<WorkspaceSessionState> {
  try {
    const raw = await readText(await fs.readFile(SESSION_PATH));
    const value = JSON.parse(raw) as Partial<WorkspaceSessionState>;
    return Number.isSafeInteger(value.generation) && (value.generation ?? 0) >= 1
      ? { generation: value.generation!, ...(value.lastNewCommandId ? { lastNewCommandId: value.lastNewCommandId } : {}),
          ...(value.modelOverride ? { modelOverride: value.modelOverride } : {}),
          ...(value.engaged === true ? { engaged: true } : {}),
          ...(value.permissionRevision ? { permissionRevision: value.permissionRevision } : {}),
          ...(Number.isSafeInteger(value.claudeSessionStartedGeneration) ? { claudeSessionStartedGeneration: value.claudeSessionStartedGeneration } : {}),
          ...(value.updatedAt ? { updatedAt: value.updatedAt } : {}) }
      : { generation: 1 };
  } catch {
    return { generation: 1 };
  }
}

export async function reconcilePermissionRevision(fs: WorkspaceSessionFs, revision: string, updatedAt: string) {
  const current = await readWorkspaceSession(fs);
  if (current.permissionRevision === revision) return { ...current, changed: false };
  const next = { ...current, generation: current.permissionRevision ? current.generation + 1 : current.generation,
    permissionRevision: revision, updatedAt };
  delete next.modelOverride;
  await writeWorkspaceSession(fs, next);
  return { ...next, changed: Boolean(current.permissionRevision) };
}

export async function writeWorkspaceSession(fs: WorkspaceSessionFs, state: WorkspaceSessionState): Promise<void> {
  await fs.mkdir("/session", { recursive: true });
  await fs.writeFile(SESSION_PATH, JSON.stringify(state));
}

export async function markWorkspaceEngaged(fs: WorkspaceSessionFs, updatedAt: string): Promise<void> {
  const current = await readWorkspaceSession(fs);
  await writeWorkspaceSession(fs, { ...current, engaged: true, updatedAt });
}

export async function markClaudeSessionStarted(fs: WorkspaceSessionFs, generation: number, updatedAt: string): Promise<void> {
  const current = await readWorkspaceSession(fs);
  if (current.generation !== generation) return;
  await writeWorkspaceSession(fs, { ...current, claudeSessionStartedGeneration: generation, updatedAt });
}

export async function applyNewSessionCommand(fs: WorkspaceSessionFs, input: { commandId: string; requestedAt: string }) {
  const current = await readWorkspaceSession(fs);
  if (current.lastNewCommandId === input.commandId) return { ...current, applied: false };
  const next = { generation: current.generation + 1, lastNewCommandId: input.commandId, updatedAt: input.requestedAt };
  await writeWorkspaceSession(fs, next);
  return { ...next, applied: true };
}
