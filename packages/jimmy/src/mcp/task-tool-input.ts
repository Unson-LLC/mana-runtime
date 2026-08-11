export const TASK_ASSIGNEE_NAME_SCHEMA = {
  type: "string" as const,
  description: "Assignee name or alias to resolve to a canonical person ID through Brainbase Graph (placement requests only)",
};

export function withTaskAssigneeNameSchema<T extends Record<string, unknown>>(
  properties: T,
): T & { assignee_name: typeof TASK_ASSIGNEE_NAME_SCHEMA } {
  return { ...properties, assignee_name: TASK_ASSIGNEE_NAME_SCHEMA };
}

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

export function buildCreateTaskRequestBody(args: Record<string, unknown>): Record<string, unknown> {
  return {
    title: args.title,
    ...(args.description ? { description: args.description } : {}),
    ...(args.priority ? { priority: args.priority } : {}),
    ...(args.due_at ? { due_at: args.due_at } : {}),
    ...(hasOwn(args, "assignee_name") ? { assignee_name: args.assignee_name } : {}),
  };
}

export function buildUpdateTaskRequestBody(args: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of ["expected_version", "title", "description", "priority", "due_at", "assignee_name"] as const) {
    if (hasOwn(args, key)) body[key] = args[key];
  }
  return body;
}
