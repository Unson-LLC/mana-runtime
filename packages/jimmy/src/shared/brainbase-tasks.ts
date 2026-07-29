/**
 * Brainbase Canonical Task API client.
 *
 * The canonical source of truth for tasks is Brainbase PostgreSQL, reached
 * through the companion task API (/api/companion/tasks). This client is the
 * single integration point: task mutations from OpenRyoko must go through
 * here, never through local board files.
 *
 * Configuration (environment):
 *   BRAINBASE_TASK_API_BASE_URL  e.g. https://bb.unson.jp
 *   BRAINBASE_TASK_API_TOKEN     bearer token (bbsvc_ service token)
 */

import { randomUUID } from "node:crypto";

export interface BrainbaseTask {
  id: string;
  version: number;
  title: string;
  description: string | null;
  status: "pending" | "in_progress" | "waiting" | "completed" | string;
  priority: "low" | "medium" | "high" | "urgent" | string;
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
}

export interface UpdateTaskInput {
  expected_version: number;
  title?: string;
  description?: string;
  priority?: "low" | "medium" | "high" | "urgent";
  due_at?: string;
  assignee_person_id?: string | null;
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
}

export class BrainbaseTaskError extends Error {
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

export interface BrainbaseTaskClientOptions {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export function isBrainbaseTaskStoreConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.BRAINBASE_TASK_API_BASE_URL && env.BRAINBASE_TASK_API_TOKEN);
}

export class BrainbaseTaskClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BrainbaseTaskClientOptions = {}) {
    const baseUrl = options.baseUrl ?? process.env.BRAINBASE_TASK_API_BASE_URL;
    const token = options.token ?? process.env.BRAINBASE_TASK_API_TOKEN;
    if (!baseUrl || !token) {
      throw new BrainbaseTaskError(
        503,
        "task_store_not_configured",
        "Brainbase task store is not configured (BRAINBASE_TASK_API_BASE_URL / BRAINBASE_TASK_API_TOKEN)",
      );
    }
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(
    path: string,
    options: { method?: string; body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const body = parsed as { code?: string; message?: string } | null;
      throw new BrainbaseTaskError(
        res.status,
        body?.code ?? "task_store_error",
        body?.message ?? `Brainbase task API failed: ${res.status}`,
        parsed,
      );
    }
    return parsed as T;
  }

  async createTask(input: CreateTaskInput, idempotencyKey?: string): Promise<BrainbaseTask> {
    return this.request<BrainbaseTask>("/api/companion/tasks", {
      method: "POST",
      body: input,
      idempotencyKey: idempotencyKey ?? `openryoko:${randomUUID()}`,
    });
  }

  async listTasks(query: ListTasksQuery = {}): Promise<{ items: BrainbaseTask[]; next_cursor?: string | null }> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.request<{ items: BrainbaseTask[]; next_cursor?: string | null }>(
      `/api/companion/tasks${suffix}`,
    );
  }

  async getTask(taskId: string): Promise<BrainbaseTask> {
    return this.request<BrainbaseTask>(`/api/companion/tasks/${encodeURIComponent(taskId)}`);
  }

  async updateTask(taskId: string, input: UpdateTaskInput, idempotencyKey?: string): Promise<BrainbaseTask> {
    return this.request<BrainbaseTask>(`/api/companion/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      body: input,
      idempotencyKey: idempotencyKey ?? `openryoko:${randomUUID()}`,
    });
  }

  async transitionTask(taskId: string, input: TransitionTaskInput, idempotencyKey?: string): Promise<BrainbaseTask> {
    return this.request<BrainbaseTask>(
      `/api/companion/tasks/${encodeURIComponent(taskId)}/transitions`,
      {
        method: "POST",
        body: input,
        idempotencyKey: idempotencyKey ?? `openryoko:${randomUUID()}`,
      },
    );
  }

  async deleteTask(
    taskId: string,
    expectedVersion: number,
    idempotencyKey?: string,
  ): Promise<{ task_id: string }> {
    return this.request<{ task_id: string }>(`/api/companion/tasks/${encodeURIComponent(taskId)}`, {
      method: "DELETE",
      body: { expected_version: expectedVersion },
      idempotencyKey: idempotencyKey ?? `openryoko:${randomUUID()}`,
    });
  }
}
