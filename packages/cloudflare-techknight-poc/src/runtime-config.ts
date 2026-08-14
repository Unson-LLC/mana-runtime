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
  audience?: { type: "operator"; allowedUserIds: string[] };
  agent?: { model: "opus" | "sonnet"; escalationEmployee?: string };
  capabilities?: { mcp: string[]; gatewayTools: string[] };
  dataScopes?: { graph: { mode: "read-only"; scopes: string[] } };
  deliveryScopes?: Array<{ connector: "slack"; channelId: string }>;
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
      const audience = candidate.audience as Record<string, unknown> | undefined;
      if (audience !== undefined && (
        typeof audience !== "object" || audience === null || audience.type !== "operator" ||
        !Array.isArray(audience.allowedUserIds) || audience.allowedUserIds.length === 0 ||
        audience.allowedUserIds.some((id) => typeof id !== "string" || !/^U[A-Z0-9]{2,31}$/.test(id))
      )) throw new Error("invalid");
      const agent = candidate.agent as Record<string, unknown> | undefined;
      if (agent !== undefined && (
        typeof agent !== "object" || agent === null ||
        (agent.model !== "opus" && agent.model !== "sonnet") ||
        (agent.escalationEmployee !== undefined && typeof agent.escalationEmployee !== "string")
      )) throw new Error("invalid");
      const capabilities = candidate.capabilities as Record<string, unknown> | undefined;
      if (capabilities !== undefined && (
        typeof capabilities !== "object" || capabilities === null ||
        !Array.isArray(capabilities.mcp) || capabilities.mcp.some((v) => typeof v !== "string") ||
        !Array.isArray(capabilities.gatewayTools) || capabilities.gatewayTools.some((v) => typeof v !== "string")
      )) throw new Error("invalid");
      const dataScopes = candidate.dataScopes as RuntimePlacement["dataScopes"] | undefined;
      if (dataScopes !== undefined && (
        dataScopes?.graph?.mode !== "read-only" || !Array.isArray(dataScopes.graph.scopes) ||
        dataScopes.graph.scopes.some((v) => typeof v !== "string")
      )) throw new Error("invalid");
      const deliveryScopes = candidate.deliveryScopes as RuntimePlacement["deliveryScopes"] | undefined;
      if (deliveryScopes !== undefined && (
        !Array.isArray(deliveryScopes) || deliveryScopes.length === 0 ||
        deliveryScopes.some((scope) => scope?.connector !== "slack" || typeof scope.channelId !== "string")
      )) throw new Error("invalid");
      return {
        placementId: candidate.placementId,
        channelId: candidate.channelId,
        projectCodes,
        taskWriteEnabled: candidate.taskWriteEnabled === true,
        ...(audience ? { audience: { type: "operator", allowedUserIds: [...audience.allowedUserIds as string[]] } } : {}),
        ...(agent ? { agent: { model: agent.model as "opus" | "sonnet", ...(agent.escalationEmployee ? { escalationEmployee: agent.escalationEmployee as string } : {}) } } : {}),
        ...(capabilities ? { capabilities: { mcp: [...capabilities.mcp as string[]], gatewayTools: [...capabilities.gatewayTools as string[]] } } : {}),
        ...(dataScopes ? { dataScopes } : {}),
        ...(deliveryScopes ? { deliveryScopes } : {}),
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
