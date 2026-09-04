import { TaskApiClient, TaskApiError } from "@openryoko/task-runtime-core";

/** Keep redo on the same tenant-owned credential path as ordinary task writes. */
export function createMeetingMinutesTaskDeleter(options: {
  baseUrl: string;
  boundary(name: "brainbase_proxy", execute: (credentialFetch: typeof fetch) => Promise<void>): Promise<void>;
}): (taskId: string, idempotencyKey: string) => Promise<void> {
  return async (taskId, idempotencyKey) => {
    await options.boundary("brainbase_proxy", async (credentialFetch) => {
      const client = new TaskApiClient({ baseUrl: options.baseUrl, fetchImpl: credentialFetch });
      try {
        const task = await client.getTask(taskId);
        await client.deleteTask(taskId, task.version, idempotencyKey);
      } catch (error) {
        if (error instanceof TaskApiError && error.status === 404) return;
        throw error;
      }
    });
  };
}
