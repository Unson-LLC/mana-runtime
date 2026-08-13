/**
 * Lightsail/Node adapter for the shared Canonical Task runtime core.
 *
 * The HTTP contract lives in @openryoko/task-runtime-core. This adapter keeps
 * the legacy Jimmy API while injecting process.env and Node UUID defaults.
 */

import { randomUUID } from "node:crypto";

import {
  TaskApiClient,
  TaskApiError,
  type CanonicalTask,
  type CreateTaskInput,
  type ListTasksQuery,
  type SearchTasksQuery,
  type TaskApiClientOptions,
  type TaskSearchPage,
  type TransitionTaskInput,
  type UpdateTaskInput,
} from "@openryoko/task-runtime-core";

export type BrainbaseTask = CanonicalTask;
export type {
  CreateTaskInput,
  ListTasksQuery,
  SearchTasksQuery,
  TaskSearchPage,
  TransitionTaskInput,
  UpdateTaskInput,
};
export { TaskApiError as BrainbaseTaskError };

export interface BrainbaseTaskClientOptions extends Partial<Omit<TaskApiClientOptions, "baseUrl" | "token">> {
  baseUrl?: string;
  token?: string;
}

export function isBrainbaseTaskStoreConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.BRAINBASE_TASK_API_BASE_URL && env.BRAINBASE_TASK_API_TOKEN);
}

export class BrainbaseTaskClient extends TaskApiClient {
  constructor(options: BrainbaseTaskClientOptions = {}) {
    super({
      baseUrl: options.baseUrl ?? process.env.BRAINBASE_TASK_API_BASE_URL ?? "",
      token: options.token ?? process.env.BRAINBASE_TASK_API_TOKEN ?? "",
      fetchImpl: options.fetchImpl,
    });
  }

  override createTask(input: CreateTaskInput, idempotencyKey?: string): Promise<BrainbaseTask> {
    return super.createTask(input, idempotencyKey ?? `openryoko:${randomUUID()}`);
  }

  override updateTask(
    taskId: string,
    input: UpdateTaskInput,
    idempotencyKey?: string,
  ): Promise<BrainbaseTask> {
    return super.updateTask(taskId, input, idempotencyKey ?? `openryoko:${randomUUID()}`);
  }

  override transitionTask(
    taskId: string,
    input: TransitionTaskInput,
    idempotencyKey?: string,
  ): Promise<BrainbaseTask> {
    return super.transitionTask(taskId, input, idempotencyKey ?? `openryoko:${randomUUID()}`);
  }

  override deleteTask(
    taskId: string,
    expectedVersion: number,
    idempotencyKey?: string,
  ): Promise<{ task_id: string }> {
    return super.deleteTask(taskId, expectedVersion, idempotencyKey ?? `openryoko:${randomUUID()}`);
  }
}
