import { applyNewSessionCommand, readWorkspaceSession, writeWorkspaceSession, type WorkspaceSessionFs, type WorkspaceSessionState } from "./workspace-session.js";

export class RuntimeControlCommandError extends Error {
  constructor(readonly code: string) { super(code); this.name = "RuntimeControlCommandError"; }
}

export function renderRuntimeStatus(input: {
  placementId: string; projectCodes: string[]; generation: number; model: string;
  taskSearchEnabled: boolean; taskWriteEnabled: boolean; [key: string]: unknown;
}): string {
  return [
    `placement: ${input.placementId}`,
    `project: ${input.projectCodes.join(", ")}`,
    `session generation: ${input.generation}`,
    `model: ${input.model}`,
    `task search: ${input.taskSearchEnabled ? "enabled" : "disabled"}`,
    `task write: ${input.taskWriteEnabled ? "enabled" : "disabled"}`,
  ].join("\n");
}

export function applyModelCommand(
  state: WorkspaceSessionState,
  requestedModel: string,
  placement: { placementId: string; allowedModels: readonly string[] },
): WorkspaceSessionState {
  if (!placement.allowedModels.includes(requestedModel)) throw new RuntimeControlCommandError("model_not_allowed");
  return { ...state, modelOverride: requestedModel };
}

export type RuntimeControlCommand =
  | { name: "new" }
  | { name: "status" }
  | { name: "model"; model: string };

export function parseRuntimeControlCommand(text: string): RuntimeControlCommand | undefined {
  const normalized = text.replace(/<@[^>]{1,128}>/g, " ").trim();
  if (normalized === "/new") return { name: "new" };
  if (normalized === "/status") return { name: "status" };
  const model = normalized.match(/^\/model(?:\s+([^\s]+))?$/);
  if (model) {
    if (!model[1]) throw new RuntimeControlCommandError("model_required");
    return { name: "model", model: model[1] };
  }
  return undefined;
}

export async function executeRuntimeControlCommand(input: {
  fs: WorkspaceSessionFs;
  command: RuntimeControlCommand;
  commandId: string;
  requestedAt: string;
  placementId: string;
  projectCodes: string[];
  currentModel: string;
  allowedModels: readonly string[];
  taskSearchEnabled: boolean;
  taskWriteEnabled: boolean;
}): Promise<string> {
  if (input.command.name === "new") {
    const state = await applyNewSessionCommand(input.fs, { commandId: input.commandId, requestedAt: input.requestedAt });
    return state.applied ? `新しい会話を開始しました。session generation: ${state.generation}`
      : `この会話はすでに初期化済みです。session generation: ${state.generation}`;
  }
  const state = await readWorkspaceSession(input.fs);
  if (input.command.name === "status") return renderRuntimeStatus({
    placementId: input.placementId,
    projectCodes: input.projectCodes,
    generation: state.generation,
    model: state.modelOverride ?? input.currentModel,
    taskSearchEnabled: input.taskSearchEnabled,
    taskWriteEnabled: input.taskWriteEnabled,
  });
  const next = applyModelCommand(state, input.command.model, {
    placementId: input.placementId,
    allowedModels: input.allowedModels,
  });
  await writeWorkspaceSession(input.fs, { ...next, updatedAt: input.requestedAt });
  return `model: ${next.modelOverride}`;
}
