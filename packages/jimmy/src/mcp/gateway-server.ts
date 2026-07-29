#!/usr/bin/env node
/**
 * Jinn Gateway MCP Server
 *
 * A Model Context Protocol (MCP) server that gives AI employees
 * first-class access to the Jinn gateway API. Instead of crafting
 * curl commands, employees get typed tools for messaging, org queries,
 * session management, and cron control.
 *
 * Started as a stdio subprocess by Claude Code via --mcp-config.
 */

import { createInterface } from "node:readline";
import { currentConversationFromEnv, isSendToCurrentConversation } from "./current-conversation.js";

const GATEWAY_URL = process.env.JINN_GATEWAY_URL || "http://127.0.0.1:7777";

// ─── MCP Protocol Types ───

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── Tool Definitions ───

const TOOLS = [
  {
    name: "send_message",
    description: "Send a proactive message to a Slack channel or other connector. Do not use this to reply to the current conversation; return your final answer instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        connector: { type: "string", description: "Connector name (e.g. 'slack')", default: "slack" },
        channel: { type: "string", description: "Channel ID or name (e.g. '#general', 'C0ACR0ZVD7H')" },
        text: { type: "string", description: "Message text to send" },
        thread: { type: "string", description: "Thread timestamp to reply in (optional)" },
      },
      required: ["channel", "text"],
    },
  },
  {
    name: "list_sessions",
    description: "List all active sessions in the Jinn gateway. Returns session IDs, employees, status, and timestamps.",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: { type: "string", enum: ["idle", "running", "error", "interrupted"], description: "Filter by status" },
      },
    },
  },
  {
    name: "get_session",
    description: "Get details and message history for a specific session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID to look up" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "create_child_session",
    description: "Create a child session to delegate work to another employee. The child session runs asynchronously.",
    inputSchema: {
      type: "object" as const,
      properties: {
        employee: { type: "string", description: "Employee name to delegate to (e.g. 'homy-writer')" },
        prompt: { type: "string", description: "Task/instruction for the employee" },
        parentSessionId: { type: "string", description: "Your current session ID (for tracking)" },
        engine: { type: "string", description: "Engine override (claude or codex)" },
        model: { type: "string", description: "Model override" },
      },
      required: ["employee", "prompt"],
    },
  },
  {
    name: "send_to_session",
    description: "Send a follow-up message to an existing session (e.g. to give feedback to a child session).",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID to send to" },
        message: { type: "string", description: "Follow-up message" },
      },
      required: ["sessionId", "message"],
    },
  },
  {
    name: "list_employees",
    description: "List all employees in the organization with their departments and roles.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_employee",
    description: "Get detailed information about a specific employee.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Employee name (kebab-case)" },
      },
      required: ["name"],
    },
  },
  {
    name: "create_task",
    description:
      "Create a task in the canonical Brainbase task store (the single source of truth for tasks). ALWAYS use this — never a department board — when asked to create, register, or record a task. Returns the created task with its canonical ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Task title" },
        description: { type: "string", description: "Task description (optional)" },
        priority: { type: "string", enum: ["low", "medium", "high", "urgent"], description: "Priority (default medium)" },
        due_at: { type: "string", description: "Due date-time in ISO 8601 (optional)" },
      },
      required: ["title"],
    },
  },
  {
    name: "list_tasks",
    description:
      "List tasks from the canonical Brainbase task store. Filter by status or priority.",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: { type: "string", enum: ["pending", "in_progress", "waiting", "completed"], description: "Filter by status" },
        priority: { type: "string", enum: ["low", "medium", "high", "urgent"], description: "Filter by priority" },
        limit: { type: "number", description: "Max items to return (default 20)" },
      },
    },
  },
  {
    name: "update_task",
    description:
      "Update a canonical task's title, description, priority, or due date. Requires the task's current version (expected_version) from create_task/list_tasks.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string", description: "Canonical task ID" },
        expected_version: { type: "number", description: "Current task version (optimistic lock)" },
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
        due_at: { type: "string", description: "ISO 8601 due date-time" },
      },
      required: ["task_id", "expected_version"],
    },
  },
  {
    name: "transition_task",
    description:
      "Move a canonical task to another status (pending, in_progress, waiting, completed). Use this to start, block, or complete tasks. waiting requires waiting_on.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string", description: "Canonical task ID" },
        expected_version: { type: "number", description: "Current task version (optimistic lock)" },
        to_status: { type: "string", enum: ["pending", "in_progress", "waiting", "completed"], description: "Target status" },
        waiting_on: { type: "string", description: "What the task is waiting on (required for waiting)" },
      },
      required: ["task_id", "expected_version", "to_status"],
    },
  },
  {
    name: "update_board",
    description:
      "Update a department's board view. Boards are a local workflow visualization only — they are NOT the task store. To create or complete actual tasks, use create_task / transition_task (canonical Brainbase store) instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        department: { type: "string", description: "Department name" },
        board: {
          type: "array",
          description: "Full board array (replace entire board)",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              status: { type: "string", enum: ["todo", "in_progress", "done"] },
              assignee: { type: "string" },
              priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
              notes: { type: "string" },
            },
          },
        },
      },
      required: ["department", "board"],
    },
  },
  {
    name: "get_board",
    description: "Get the task board for a department.",
    inputSchema: {
      type: "object" as const,
      properties: {
        department: { type: "string", description: "Department name" },
      },
      required: ["department"],
    },
  },
  {
    name: "list_cron_jobs",
    description: "List all configured cron jobs with their schedules and status.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "trigger_cron_job",
    description: "Manually trigger a cron job to run immediately.",
    inputSchema: {
      type: "object" as const,
      properties: {
        jobId: { type: "string", description: "Cron job ID or name" },
      },
      required: ["jobId"],
    },
  },
  {
    name: "update_cron_job",
    description: "Enable, disable, or update a cron job.",
    inputSchema: {
      type: "object" as const,
      properties: {
        jobId: { type: "string", description: "Cron job ID" },
        enabled: { type: "boolean", description: "Enable or disable the job" },
        schedule: { type: "string", description: "New cron schedule expression" },
        prompt: { type: "string", description: "New prompt for the job" },
      },
      required: ["jobId"],
    },
  },
];

// ─── API Helpers ───

async function apiGet(path: string): Promise<unknown> {
  const res = await fetch(`${GATEWAY_URL}${path}`);
  if (!res.ok) throw new Error(`API ${path}: ${res.status} ${res.statusText}`);
  return res.json();
}

async function apiPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

async function apiPut(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${path}: ${res.status} ${res.statusText}`);
  return res.json();
}

async function apiPatch(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`API ${path}: ${res.status} ${res.statusText}${detail ? ` ${detail.slice(0, 300)}` : ""}`);
  }
  return res.json();
}

// ─── Tool Handlers ───

async function handleTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "send_message": {
      const connector = (args.connector as string) || "slack";
      if (isSendToCurrentConversation({ ...args, connector }, currentConversationFromEnv())) {
        throw new Error(
          "send_message cannot post to the current conversation. Return the reply as your final answer instead; Jinn will deliver it to the correct thread.",
        );
      }
      const result = await apiPost(`/api/connectors/${connector}/send`, {
        channel: args.channel,
        text: args.text,
        thread: args.thread,
      });
      return JSON.stringify(result);
    }

    case "list_sessions": {
      const sessions = await apiGet("/api/sessions") as any[];
      const filtered = args.status
        ? sessions.filter((s: any) => s.status === args.status)
        : sessions;
      // Return a summary, not the full data
      const summary = filtered.map((s: any) => ({
        id: s.id,
        employee: s.employee,
        engine: s.engine,
        status: s.status,
        source: s.source,
        title: s.title,
        lastActivity: s.lastActivity,
        lastError: s.lastError,
      }));
      return JSON.stringify(summary);
    }

    case "get_session": {
      const session = await apiGet(`/api/sessions/${args.sessionId}`);
      return JSON.stringify(session);
    }

    case "create_child_session": {
      const result = await apiPost("/api/sessions", {
        prompt: args.prompt,
        employee: args.employee,
        engine: args.engine,
        parentSessionId: args.parentSessionId,
      });
      return JSON.stringify(result);
    }

    case "send_to_session": {
      const result = await apiPost(`/api/sessions/${args.sessionId}/message`, {
        message: args.message,
      });
      return JSON.stringify(result);
    }

    case "list_employees": {
      const org = await apiGet("/api/org") as any;
      return JSON.stringify(org);
    }

    case "get_employee": {
      const employee = await apiGet(`/api/org/employees/${args.name}`);
      return JSON.stringify(employee);
    }

    case "create_task": {
      const result = await apiPost("/api/tasks", {
        title: args.title,
        ...(args.description ? { description: args.description } : {}),
        ...(args.priority ? { priority: args.priority } : {}),
        ...(args.due_at ? { due_at: args.due_at } : {}),
      });
      return JSON.stringify(result);
    }

    case "list_tasks": {
      const params = new URLSearchParams();
      if (args.status) params.set("status", String(args.status));
      if (args.priority) params.set("priority", String(args.priority));
      if (args.limit) params.set("limit", String(args.limit));
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      const result = await apiGet(`/api/tasks${suffix}`);
      return JSON.stringify(result);
    }

    case "update_task": {
      const { task_id, ...rest } = args as { task_id: string } & Record<string, unknown>;
      const result = await apiPatch(`/api/tasks/${encodeURIComponent(task_id)}`, rest);
      return JSON.stringify(result);
    }

    case "transition_task": {
      const { task_id, ...rest } = args as { task_id: string } & Record<string, unknown>;
      const result = await apiPost(`/api/tasks/${encodeURIComponent(task_id)}/transitions`, rest);
      return JSON.stringify(result);
    }

    case "update_board": {
      const result = await apiPut(`/api/org/departments/${args.department}/board`, args.board);
      return JSON.stringify(result);
    }

    case "get_board": {
      const board = await apiGet(`/api/org/departments/${args.department}/board`);
      return JSON.stringify(board);
    }

    case "list_cron_jobs": {
      const jobs = await apiGet("/api/cron");
      return JSON.stringify(jobs);
    }

    case "trigger_cron_job": {
      // Resolve job ID (allow passing name or id)
      const jobs = await apiGet("/api/cron") as any[];
      const job = jobs.find((j: any) => j.id === args.jobId || j.name === args.jobId);
      if (!job) return JSON.stringify({ error: `Job "${args.jobId}" not found` });
      // Actually trigger the job via the gateway REST API (fire-and-forget)
      apiPost(`/api/cron/${job.id}/trigger`, {}).catch(() => {});
      return JSON.stringify({ triggered: true, jobId: job.id, message: `Cron job "${job.name}" triggered manually` });
    }

    case "update_cron_job": {
      const result = await apiPut(`/api/cron/${args.jobId}`, {
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
        ...(args.schedule ? { schedule: args.schedule } : {}),
        ...(args.prompt ? { prompt: args.prompt } : {}),
      });
      return JSON.stringify(result);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── MCP Protocol Handler ───

function sendResponse(response: JsonRpcResponse): void {
  const json = JSON.stringify(response);
  process.stdout.write(json + "\n");
}

async function handleRequest(request: JsonRpcRequest): Promise<void> {
  const { id, method, params } = request;

  switch (method) {
    case "initialize":
      sendResponse({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "jinn-gateway",
            version: "0.1.0",
          },
        },
      });
      break;

    case "tools/list":
      sendResponse({
        jsonrpc: "2.0",
        id,
        result: { tools: TOOLS },
      });
      break;

    case "tools/call": {
      const toolName = params?.name as string;
      const toolArgs = (params?.arguments as Record<string, unknown>) || {};
      try {
        const result = await handleTool(toolName, toolArgs);
        sendResponse({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: result }],
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendResponse({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `Error: ${msg}` }],
            isError: true,
          },
        });
      }
      break;
    }

    case "notifications/initialized":
      // Client acknowledged initialization, no response needed
      break;

    default:
      sendResponse({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
  }
}

// ─── Main ───

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  try {
    const request = JSON.parse(line) as JsonRpcRequest;
    handleRequest(request).catch((err) => {
      sendResponse({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      });
    });
  } catch {
    // Ignore unparseable lines
  }
});

rl.on("close", () => {
  process.exit(0);
});
