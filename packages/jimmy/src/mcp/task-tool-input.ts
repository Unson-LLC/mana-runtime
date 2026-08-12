export const TASK_ASSIGNEE_NAME_SCHEMA = {
  type: "string" as const,
  description: "Assignee name or alias to resolve to a canonical person ID through Brainbase Graph (placement requests only)",
};

export const TASK_LIST_DESCRIPTION =
  "List one page from the canonical Brainbase task store. A non-null next_cursor means the result is partial; pass it to continue and never infer absence from a partial page.";

export const TASK_SEARCH_DESCRIPTION =
  "Search canonical task titles on the server with bounded results. Use this to find a named task instead of scanning list_tasks pages. A non-null next_cursor or true has_more means the search is partial; continue with the cursor and never infer absence from a partial search.";

export const TASK_LIST_QUERY_SCHEMA = {
  status: { type: "string" as const, enum: ["pending", "in_progress", "waiting", "completed"], description: "Filter by status" },
  priority: { type: "string" as const, enum: ["low", "medium", "high", "urgent"], description: "Filter by priority" },
  assignee_person_id: { type: "string" as const, description: "Filter by canonical Graph person ID" },
  cursor: { type: "string" as const, description: "Opaque cursor returned by the previous page" },
  project_code: {
    type: "array" as const,
    items: { type: "string" as const },
    description: "Filter by project code. Placement calls are forcibly scoped by the gateway.",
  },
  limit: { type: "number" as const, minimum: 1, maximum: 50, description: "Items in this page (default 50, max 50)" },
};

export const TASK_SEARCH_QUERY_SCHEMA = {
  query: { type: "string" as const, minLength: 1, maxLength: 200, description: "Words to find in the task title" },
  status: TASK_LIST_QUERY_SCHEMA.status,
  priority: TASK_LIST_QUERY_SCHEMA.priority,
  assignee_person_id: TASK_LIST_QUERY_SCHEMA.assignee_person_id,
  cursor: TASK_LIST_QUERY_SCHEMA.cursor,
  project_code: TASK_LIST_QUERY_SCHEMA.project_code,
  limit: { type: "number" as const, minimum: 1, maximum: 20, description: "Items in this search page (default 20, max 20)" },
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

function buildTaskReadPath(pathname: string, args: Record<string, unknown>, includeQuery: boolean): string {
  const params = new URLSearchParams();
  const scalarKeys = includeQuery
    ? ["query", "status", "priority", "assignee_person_id", "cursor"]
    : ["status", "priority", "assignee_person_id", "cursor"];
  for (const key of scalarKeys) {
    const value = args[key];
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  const projectCodes = Array.isArray(args.project_code) ? args.project_code : [];
  for (const projectCode of projectCodes) params.append("project_code", String(projectCode));
  if (args.limit !== undefined && args.limit !== null && args.limit !== "") {
    params.set("limit", String(args.limit));
  }
  return params.size ? `${pathname}?${params.toString()}` : pathname;
}

export function buildTaskListPath(args: Record<string, unknown>): string {
  return buildTaskReadPath("/api/tasks", args, false);
}

export function buildTaskSearchPath(args: Record<string, unknown>): string {
  return buildTaskReadPath("/api/tasks/search", args, true);
}
