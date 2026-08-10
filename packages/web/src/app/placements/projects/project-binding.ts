export interface PlacementProjectBinding {
  id: string
  connector: string
  workspaceId?: string
  channelId: string
  projects?: string[]
  [key: string]: unknown
}

export function normalizeProjectCodes(projectCodes: string[]): string[] {
  return [...new Set(projectCodes.map((code) => code.trim()).filter(Boolean))]
}

export function resolveChannelPlacementUpdate<T extends PlacementProjectBinding>(
  placements: T[],
  input: {
    connectorId: string
    workspaceId?: string
    channelId: string
    projectCodes: string[]
  },
): T[] {
  const matches = placements.filter((placement) =>
    placement.connector === input.connectorId
    && placement.channelId === input.channelId
    && (!input.workspaceId || placement.workspaceId === input.workspaceId),
  )
  if (matches.length === 0) throw new Error("対象チャンネルのplacementが見つかりません")
  if (matches.length > 1) throw new Error("対象チャンネルに複数のplacementがあります。管理者が設定を整理してください")
  const targetId = matches[0].id
  const projects = normalizeProjectCodes(input.projectCodes)
  return placements.map((placement) =>
    placement.id === targetId ? { ...placement, projects } : placement,
  )
}
