export interface CanonicalTask {
  id: string;
  version: number;
  title: string;
  description: string | null;
  status: "pending" | "in_progress" | "waiting" | "completed" | string;
  priority: "low" | "medium" | "high" | "urgent" | string;
  project_codes?: string[];
  assignee_person_id: string | null;
  assignee_display_name: string | null;
  due_at: string | null;
  waiting_on: string | null;
  completed_at: string | null;
  web_url?: string;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: "low" | "medium" | "high" | "urgent";
  assignee_person_id?: string;
  due_at?: string;
  project_codes?: string[];
}

export interface UpdateTaskInput {
  expected_version: number;
  title?: string;
  description?: string;
  priority?: "low" | "medium" | "high" | "urgent";
  due_at?: string;
  assignee_person_id?: string | null;
  project_codes?: string[];
}

export interface TransitionTaskInput {
  expected_version: number;
  to_status: "pending" | "in_progress" | "waiting" | "completed";
  waiting_on?: string;
  review_at?: string;
}

export interface ListTasksQuery {
  status?: string;
  priority?: string;
  assignee_person_id?: string;
  limit?: number;
  cursor?: string;
  project_code?: string[];
}

export interface SearchTasksQuery extends ListTasksQuery {
  query: string;
}

export interface TaskListPage {
  items: CanonicalTask[];
  next_cursor?: string | null;
}

export interface TaskSearchPage extends TaskListPage {
  total_count: null;
  count_status: "not_requested";
  has_more: boolean;
  read_status?: string;
}

export class TaskApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "BrainbaseTaskError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface TaskApiClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export function normalizeProjectCodes(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function applyTrustedProjectScope<T extends object>(
  input: T,
  trustedProjectCodes: readonly string[],
): Omit<T, "project_codes"> & { project_codes: string[] } {
  const projectCodes = normalizeProjectCodes(trustedProjectCodes);
  if (projectCodes.length === 0) {
    throw new TaskApiError(503, "task_scope_not_configured", "Trusted task project scope is empty");
  }
  return { ...input, project_codes: projectCodes };
}

export function applyTrustedProjectFilter<T extends object>(
  query: T,
  trustedProjectCodes: readonly string[],
): Omit<T, "project_code"> & { project_code: string[] } {
  const projectCodes = normalizeProjectCodes(trustedProjectCodes);
  if (projectCodes.length === 0) {
    throw new TaskApiError(503, "task_scope_not_configured", "Trusted task project scope is empty");
  }
  return { ...query, project_code: projectCodes };
}

function encodeQuery(query: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }
  return params.toString();
}

export class TaskApiClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TaskApiClientOptions) {
    if (!options.baseUrl || !options.token) {
      throw new TaskApiError(503, "task_store_not_configured", "Canonical task API is not configured");
    }
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(
    path: string,
    options: { method?: string; body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey !== undefined) headers["Idempotency-Key"] = options.idempotencyKey;

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      if (!response.ok) {
        throw new TaskApiError(
          response.status,
          "task_store_error",
          `Canonical task API failed: ${response.status}`,
        );
      }
      throw new TaskApiError(502, "task_store_invalid_response", "Canonical task API returned invalid JSON");
    }
    if (!response.ok) {
      const errorBody = payload && typeof payload === "object"
        ? payload as { code?: unknown; message?: unknown }
        : undefined;
      throw new TaskApiError(
        response.status,
        typeof errorBody?.code === "string" ? errorBody.code : "task_store_error",
        typeof errorBody?.message === "string"
          ? errorBody.message
          : `Canonical task API failed: ${response.status}`,
        payload,
      );
    }
    if (payload === null) {
      throw new TaskApiError(502, "task_store_invalid_response", "Canonical task API returned an empty response");
    }
    return payload as T;
  }

  private requireIdempotencyKey(value: string): string {
    if (!value.trim()) {
      throw new TaskApiError(400, "idempotency_key_required", "Task mutation requires an idempotency key");
    }
    return value;
  }

  async createTask(input: CreateTaskInput, idempotencyKey: string): Promise<CanonicalTask> {
    return await this.request<CanonicalTask>("/api/companion/tasks", {
      method: "POST",
      body: input,
      idempotencyKey: this.requireIdempotencyKey(idempotencyKey),
    });
  }

  listTasks(query: ListTasksQuery = {}): Promise<TaskListPage> {
    const encoded = encodeQuery(query);
    return this.request<TaskListPage>(`/api/companion/tasks${encoded ? `?${encoded}` : ""}`);
  }

  searchTasks(query: SearchTasksQuery): Promise<TaskSearchPage> {
    return this.request<TaskSearchPage>(`/api/companion/tasks/search?${encodeQuery(query)}`);
  }

  getTask(taskId: string): Promise<CanonicalTask> {
    return this.request<CanonicalTask>(`/api/companion/tasks/${encodeURIComponent(taskId)}`);
  }

  async updateTask(taskId: string, input: UpdateTaskInput, idempotencyKey: string): Promise<CanonicalTask> {
    return await this.request<CanonicalTask>(`/api/companion/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      body: input,
      idempotencyKey: this.requireIdempotencyKey(idempotencyKey),
    });
  }

  async transitionTask(taskId: string, input: TransitionTaskInput, idempotencyKey: string): Promise<CanonicalTask> {
    return await this.request<CanonicalTask>(`/api/companion/tasks/${encodeURIComponent(taskId)}/transitions`, {
      method: "POST",
      body: input,
      idempotencyKey: this.requireIdempotencyKey(idempotencyKey),
    });
  }

  async deleteTask(taskId: string, expectedVersion: number, idempotencyKey: string): Promise<{ task_id: string }> {
    return await this.request<{ task_id: string }>(`/api/companion/tasks/${encodeURIComponent(taskId)}`, {
      method: "DELETE",
      body: { expected_version: expectedVersion },
      idempotencyKey: this.requireIdempotencyKey(idempotencyKey),
    });
  }
}
