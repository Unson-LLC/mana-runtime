import type { SlackQueueEvent } from "./types.js";

export interface RuntimeBinding {
  tenantId: string;
  workspaceId: string;
  channelId: string;
  projectCodes: string[];
}

export interface RuntimePlacement {
  placementId: string;
  channelId: string;
  projectCodes: string[];
  taskWriteEnabled: boolean;
}

export interface ResolvedRuntimePlacement extends RuntimeBinding, RuntimePlacement {}

export interface RuntimePlacementConfig {
  tenantId: string;
  workspaceId: string;
  placements: RuntimePlacement[];
}

export interface RuntimeBindingConfig {
  tenantId: string;
  workspaceId: string;
  channelId: string;
  projectCodes?: string;
}

export interface ReplyTaskSearchBindingConfig extends RuntimeBindingConfig {
  taskSearchEnabled?: string;
  brainbaseApiBaseUrl?: string;
  brainbaseTaskToken?: string;
}

export type ReplyTaskSearchOptions =
  | { taskSearchEnabled: false }
  | { taskSearchEnabled: true; binding: RuntimeBinding };

export class RuntimeBindingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RuntimeBindingError";
  }
}

export function parseRuntimeProjectCodes(value: string | undefined): string[] {
  const codes = [...new Set((value ?? "")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean))];
  if (codes.some((code) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(code))) {
    throw new RuntimeBindingError("project_binding_invalid");
  }
  return codes;
}

export function parseRuntimePlacements(value: string | undefined): RuntimePlacement[] {
  if (!value) throw new RuntimeBindingError("runtime_placements_missing");
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("invalid");
    const placements = parsed.map((item): RuntimePlacement => {
      if (typeof item !== "object" || item === null) throw new Error("invalid");
      const candidate = item as Record<string, unknown>;
      if (
        typeof candidate.placementId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(candidate.placementId) ||
        typeof candidate.channelId !== "string" ||
        !/^[A-Z0-9_]{2,32}$/.test(candidate.channelId) ||
        !Array.isArray(candidate.projectCodes) ||
        candidate.projectCodes.length === 0 ||
        candidate.projectCodes.some((code) => typeof code !== "string") ||
        (candidate.taskWriteEnabled !== undefined && typeof candidate.taskWriteEnabled !== "boolean")
      ) throw new Error("invalid");
      const projectCodes = parseRuntimeProjectCodes(candidate.projectCodes.join(","));
      if (projectCodes.length !== candidate.projectCodes.length) throw new Error("invalid");
      return {
        placementId: candidate.placementId,
        channelId: candidate.channelId,
        projectCodes,
        taskWriteEnabled: candidate.taskWriteEnabled === true,
      };
    });
    if (
      new Set(placements.map((placement) => placement.placementId)).size !== placements.length ||
      new Set(placements.map((placement) => placement.channelId)).size !== placements.length
    ) throw new Error("invalid");
    return placements;
  } catch (error) {
    if (error instanceof RuntimeBindingError) throw error;
    throw new RuntimeBindingError("runtime_placements_invalid");
  }
}

export function resolveRuntimePlacement(
  event: SlackQueueEvent,
  config: RuntimePlacementConfig,
): ResolvedRuntimePlacement {
  if (event.tenantId !== config.tenantId) throw new RuntimeBindingError("tenant_not_allowed");
  if (event.workspaceId !== config.workspaceId) throw new RuntimeBindingError("workspace_not_allowed");
  const placement = config.placements.find((candidate) => candidate.channelId === event.channelId);
  if (!placement) throw new RuntimeBindingError("channel_not_allowed");
  return { tenantId: config.tenantId, workspaceId: config.workspaceId, ...placement };
}

export function resolveRuntimeBinding(
  event: SlackQueueEvent,
  config: RuntimeBindingConfig,
): RuntimeBinding {
  if (event.tenantId !== config.tenantId) {
    throw new RuntimeBindingError("tenant_not_allowed");
  }
  if (event.workspaceId !== config.workspaceId) {
    throw new RuntimeBindingError("workspace_not_allowed");
  }
  if (event.channelId !== config.channelId) {
    throw new RuntimeBindingError("channel_not_allowed");
  }
  const resolvedProjects = parseRuntimeProjectCodes(config.projectCodes);
  if (resolvedProjects.length === 0) {
    throw new RuntimeBindingError("project_binding_missing");
  }
  return {
    tenantId: config.tenantId,
    workspaceId: config.workspaceId,
    channelId: config.channelId,
    projectCodes: resolvedProjects,
  };
}

export function resolveReplyTaskSearchOptions(
  event: SlackQueueEvent,
  config: ReplyTaskSearchBindingConfig,
): ReplyTaskSearchOptions {
  if (config.taskSearchEnabled !== "true") return { taskSearchEnabled: false };
  const binding = resolveRuntimeBinding(event, config);
  if (!config.brainbaseApiBaseUrl || !config.brainbaseTaskToken) {
    throw new RuntimeBindingError("task_search_config_missing");
  }
  try {
    const baseUrl = new URL(config.brainbaseApiBaseUrl);
    if (
      baseUrl.protocol !== "https:" ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.port ||
      (baseUrl.pathname !== "/" && baseUrl.pathname !== "") ||
      baseUrl.search ||
      baseUrl.hash
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw new RuntimeBindingError("task_search_config_invalid");
  }
  return { taskSearchEnabled: true, binding };
}

export function runWithReplyTaskSearchBinding<T>(
  event: SlackQueueEvent,
  config: ReplyTaskSearchBindingConfig,
  run: (options: ReplyTaskSearchOptions) => T,
): T {
  const options = resolveReplyTaskSearchOptions(event, config);
  return run(options);
}
