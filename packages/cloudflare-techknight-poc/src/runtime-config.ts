import type { SlackQueueEvent } from "./types.js";

export interface RuntimeBinding {
  tenantId: string;
  workspaceId: string;
  channelId: string;
  projectCodes: string[];
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
