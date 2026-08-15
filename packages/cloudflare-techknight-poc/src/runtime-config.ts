import type { SlackQueueEvent } from "./types.js";
import type { RuntimeRespondPolicy } from "./runtime-respond-policy.js";

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
  developmentEnabled?: boolean;
  taskBoardEnabled?: boolean;
  permissionRevision?: string;
  audience?: { type: "operator"; allowedUserIds: string[] };
  agent?: { model: "opus" | "sonnet"; escalationEmployee?: string };
  capabilities?: { mcp: string[]; gatewayTools: string[] };
  taskInventoryChannelIds?: string[];
  taskInventoryAllowedUserIds?: string[];
  dataScopes?: { graph: { mode: "read-only"; scopes: string[] } };
  deliveryScopes?: Array<{ connector: "slack"; channelId: string }>;
  respondTo?: RuntimeRespondPolicy;
  runtimeContext?: { persona: string; instructions: string[]; skills: string[] };
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
        (candidate.taskWriteEnabled !== undefined && typeof candidate.taskWriteEnabled !== "boolean") ||
        (candidate.developmentEnabled !== undefined && typeof candidate.developmentEnabled !== "boolean") ||
        (candidate.taskBoardEnabled !== undefined && typeof candidate.taskBoardEnabled !== "boolean") ||
        (candidate.permissionRevision !== undefined &&
          (typeof candidate.permissionRevision !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(candidate.permissionRevision)))
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
      const taskInventoryChannelIds = candidate.taskInventoryChannelIds;
      if (taskInventoryChannelIds !== undefined && (
        !Array.isArray(taskInventoryChannelIds) || taskInventoryChannelIds.length === 0 || taskInventoryChannelIds.length > 10 ||
        taskInventoryChannelIds.some((id) => typeof id !== "string" || !/^[A-Z0-9_]{2,32}$/.test(id)) ||
        new Set(taskInventoryChannelIds).size !== taskInventoryChannelIds.length
      )) throw new Error("invalid");
      const taskInventoryAllowedUserIds = candidate.taskInventoryAllowedUserIds;
      if (taskInventoryAllowedUserIds !== undefined && (
        !Array.isArray(taskInventoryAllowedUserIds) || taskInventoryAllowedUserIds.length === 0 || taskInventoryAllowedUserIds.length > 50 ||
        taskInventoryAllowedUserIds.some((id) => typeof id !== "string" || !/^U[A-Z0-9]{2,31}$/.test(id)) ||
        new Set(taskInventoryAllowedUserIds).size !== taskInventoryAllowedUserIds.length
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
      const respondTo = candidate.respondTo as Record<string, unknown> | undefined;
      const respondModes = new Set<unknown>(["always", "mention", "never"]);
      if (respondTo !== undefined && (
        typeof respondTo !== "object" || respondTo === null ||
        !respondModes.has(respondTo.im) || !respondModes.has(respondTo.mpim) ||
        !respondModes.has(respondTo.channel) || typeof respondTo.engagedThreads !== "boolean"
      )) throw new Error("invalid");
      const runtimeContext = candidate.runtimeContext as Record<string, unknown> | undefined;
      if (runtimeContext !== undefined && (
        typeof runtimeContext !== "object" || runtimeContext === null ||
        typeof runtimeContext.persona !== "string" || runtimeContext.persona.trim().length === 0 || runtimeContext.persona.length > 500 ||
        !Array.isArray(runtimeContext.instructions) || runtimeContext.instructions.length === 0 ||
        runtimeContext.instructions.some((value) => typeof value !== "string" || value.trim().length === 0 || value.length > 500) ||
        !Array.isArray(runtimeContext.skills) || runtimeContext.skills.length === 0 ||
        runtimeContext.skills.some((value) => typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value))
      )) throw new Error("invalid");
      return {
        placementId: candidate.placementId,
        channelId: candidate.channelId,
        projectCodes,
        taskWriteEnabled: candidate.taskWriteEnabled === true,
        ...(candidate.developmentEnabled === true ? { developmentEnabled: true } : {}),
        ...(candidate.taskBoardEnabled === true ? { taskBoardEnabled: true } : {}),
        ...(candidate.permissionRevision ? { permissionRevision: candidate.permissionRevision as string } : {}),
        ...(audience ? { audience: { type: "operator", allowedUserIds: [...audience.allowedUserIds as string[]] } } : {}),
        ...(agent ? { agent: { model: agent.model as "opus" | "sonnet", ...(agent.escalationEmployee ? { escalationEmployee: agent.escalationEmployee as string } : {}) } } : {}),
        ...(capabilities ? { capabilities: { mcp: [...capabilities.mcp as string[]], gatewayTools: [...capabilities.gatewayTools as string[]] } } : {}),
        ...(taskInventoryChannelIds ? { taskInventoryChannelIds: [...taskInventoryChannelIds as string[]] } : {}),
        ...(taskInventoryAllowedUserIds ? { taskInventoryAllowedUserIds: [...taskInventoryAllowedUserIds as string[]] } : {}),
        ...(dataScopes ? { dataScopes } : {}),
        ...(deliveryScopes ? { deliveryScopes } : {}),
        ...(respondTo ? { respondTo: respondTo as unknown as RuntimeRespondPolicy } : {}),
        ...(runtimeContext ? { runtimeContext: { persona: runtimeContext.persona as string,
          instructions: [...runtimeContext.instructions as string[]], skills: [...runtimeContext.skills as string[]] } } : {}),
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
  const channelPlacement = config.placements.find((candidate) => candidate.channelId === event.channelId);
  if (channelPlacement) return { tenantId: config.tenantId, workspaceId: config.workspaceId, ...channelPlacement };

  // Slack DM channel IDs are created per conversation and cannot be listed as a
  // static placement channel. Bind only an explicitly enabled, unique placement
  // whose audience contains the actor.
  const dmScope = event.channelType === "im" ? "im" : event.channelType === "mpim" ? "mpim" : undefined;
  const dmPlacements = dmScope ? config.placements.filter((candidate) =>
    candidate.respondTo?.[dmScope] !== undefined && candidate.respondTo[dmScope] !== "never" &&
    candidate.audience?.allowedUserIds.includes(event.userId ?? "") === true) : [];
  if (dmPlacements.length !== 1) throw new RuntimeBindingError("channel_not_allowed");
  return { tenantId: config.tenantId, workspaceId: config.workspaceId, ...dmPlacements[0], channelId: event.channelId };
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
