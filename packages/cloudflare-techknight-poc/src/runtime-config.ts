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

export class RuntimeBindingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RuntimeBindingError";
  }
}

function projectCodes(value: string | undefined): string[] {
  return [...new Set((value ?? "")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean))];
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
  const resolvedProjects = projectCodes(config.projectCodes);
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
