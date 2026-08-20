export interface RuntimeWorkspaceIdentity {
  tenantId: string;
  workspaceId: string;
  channelId: string;
  threadTs: string;
  command?: string;
  userId?: string;
}

export function runtimeWorkspaceName(identity: RuntimeWorkspaceIdentity): string {
  return [identity.tenantId, identity.workspaceId, identity.channelId, identity.threadTs].join(":");
}
