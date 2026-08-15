const SLACK_ID = /^[A-Z0-9]{2,32}$/;
const TARGET_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface TaskBoardTarget {
  targetId: string;
  organizationId: "unson" | "unson-business" | "tech-knight";
  workspaceId: string;
  channelId: string;
  projectCodes: string[];
}

export interface TaskBoardTargetEnv {
  TASK_BOARD_TARGETS_JSON?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_BOT_TOKEN_UNSON?: string;
  SLACK_BOT_TOKEN_TECHKNIGHT?: string;
}

export function parseTaskBoardTargets(raw: string | undefined): TaskBoardTarget[] {
  if (!raw?.trim()) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("invalid_task_board_targets"); }
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) throw new Error("invalid_task_board_targets");
  const targetIds = new Set<string>();
  const canvasKeys = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("invalid_task_board_target");
    const candidate = item as Record<string, unknown>;
    const targetId = typeof candidate.targetId === "string" ? candidate.targetId.trim() : "";
    const organizationId = candidate.organizationId;
    const workspaceId = typeof candidate.workspaceId === "string" ? candidate.workspaceId.trim() : "";
    const channelId = typeof candidate.channelId === "string" ? candidate.channelId.trim() : "";
    const projectCodes = Array.isArray(candidate.projectCodes)
      ? [...new Set(candidate.projectCodes.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean))]
      : [];
    if (!TARGET_ID.test(targetId) || !["unson", "unson-business", "tech-knight"].includes(String(organizationId)) ||
      !SLACK_ID.test(workspaceId) || !SLACK_ID.test(channelId) || projectCodes.length === 0 || projectCodes.length > 20) {
      throw new Error("invalid_task_board_target");
    }
    if (targetIds.has(targetId)) throw new Error("duplicate_task_board_target_id");
    const canvasKey = `${workspaceId}:${channelId}`;
    if (canvasKeys.has(canvasKey)) throw new Error("duplicate_task_board_canvas");
    targetIds.add(targetId); canvasKeys.add(canvasKey);
    return { targetId, organizationId: organizationId as TaskBoardTarget["organizationId"], workspaceId, channelId, projectCodes };
  });
}

export function taskBoardTargetsForProjects(targets: readonly TaskBoardTarget[], projects: readonly string[]): TaskBoardTarget[] {
  const affected = new Set(projects);
  return targets.filter((target) => target.projectCodes.some((project) => affected.has(project)));
}

export function taskBoardSlackToken(target: TaskBoardTarget, env: TaskBoardTargetEnv): string {
  const token = target.workspaceId === "T07A9J3PEMB"
    ? env.SLACK_BOT_TOKEN_TECHKNIGHT
    : target.workspaceId === "T07LL5WV7N1"
      ? env.SLACK_BOT_TOKEN_UNSON
      : target.workspaceId === "T0882T8N9UH"
        ? env.SLACK_BOT_TOKEN
        : target.organizationId === "tech-knight"
          ? env.SLACK_BOT_TOKEN_TECHKNIGHT
          : target.organizationId === "unson"
            ? env.SLACK_BOT_TOKEN_UNSON
            : target.organizationId === "unson-business"
              ? env.SLACK_BOT_TOKEN
              : undefined;
  if (!token?.trim()) throw new Error("task_board_slack_token_not_configured");
  return token;
}
