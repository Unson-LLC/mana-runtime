import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { McpGlobalConfig, McpServerConfig, McpServerUrlConfig, Employee } from "../shared/types.js";
import { JINN_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { getSessionDelegationToken } from "../sessions/delegation-auth.js";
import { emitSecurityEvent } from "../shared/security-events.js";

export interface ResolvedMcpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export interface McpSessionContext {
  sessionId?: string;
  connector?: string;
  channel?: string;
  thread?: string;
  placementId?: string;
  configRevision?: string;
  allowedGatewayTools?: string[];
  allowedDeliveryTargets?: Array<{ connector: string; channel: string }>;
}

/**
 * Resolve the MCP servers that should be available for a given employee
 * based on global config and employee-level overrides.
 */
export function resolveMcpServers(
  globalMcp: McpGlobalConfig | undefined,
  employee?: Employee,
  sessionContext?: McpSessionContext,
  placementMcp?: false | string[],
): ResolvedMcpConfig {
  const servers: Record<string, McpServerConfig> = {};

  if (!globalMcp) return { mcpServers: servers };

  // Build the full set of available MCP servers from global config
  const available = buildAvailableServers(globalMcp, sessionContext);

  // Determine which servers this employee gets
  const employeeMcp = placementMcp === undefined ? employee?.mcp : placementMcp;

  if (employeeMcp === false) {
    // Employee explicitly opted out of all MCP servers
    for (const name of Object.keys(available)) {
      emitSecurityEvent({ event: "capability", reason: "mcp_denied", sessionId: sessionContext?.sessionId,
        connector: sessionContext?.connector, channelId: sessionContext?.channel, placementId: sessionContext?.placementId,
        configRevision: sessionContext?.configRevision, capability: "mcp", target: name });
    }
    return { mcpServers: {} };
  }

  if (Array.isArray(employeeMcp)) {
    // Employee wants only specific servers
    for (const name of employeeMcp) {
      if (available[name]) {
        servers[name] = available[name];
      } else {
        emitSecurityEvent({ event: "capability", reason: "mcp_denied", sessionId: sessionContext?.sessionId,
          connector: sessionContext?.connector, channelId: sessionContext?.channel, placementId: sessionContext?.placementId,
          configRevision: sessionContext?.configRevision, capability: "mcp", target: name });
        logger.warn(`Employee ${employee?.name} requests MCP server "${name}" but it's not configured`);
      }
    }
    for (const name of Object.keys(available)) {
      if (!employeeMcp.includes(name)) {
        emitSecurityEvent({ event: "capability", reason: "mcp_denied", sessionId: sessionContext?.sessionId,
          connector: sessionContext?.connector, channelId: sessionContext?.channel, placementId: sessionContext?.placementId,
          configRevision: sessionContext?.configRevision, capability: "mcp", target: name });
      }
    }
  } else {
    // Employee gets all enabled servers (default behavior, or mcp: true)
    Object.assign(servers, available);
  }

  return { mcpServers: servers };
}

/**
 * Build the map of all available (enabled) MCP servers from global config.
 */
function buildAvailableServers(config: McpGlobalConfig, sessionContext?: McpSessionContext): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};

  // Browser automation via Playwright
  if (config.browser?.enabled !== false) {
    const provider = config.browser?.provider || "playwright";
    if (provider === "playwright") {
      servers.browser = {
        command: "npx",
        args: ["-y", "@anthropic-ai/mcp-server-playwright"],
      };
    } else if (provider === "puppeteer") {
      servers.browser = {
        command: "npx",
        args: ["-y", "@anthropic-ai/mcp-server-puppeteer"],
      };
    }
  }

  // Web search via Brave
  if (config.search?.enabled) {
    const apiKey = resolveEnvVar(config.search.apiKey);
    if (apiKey) {
      servers.search = {
        command: "npx",
        args: ["-y", "brave-search-mcp"],
        env: { BRAVE_API_KEY: apiKey },
      };
    } else {
      logger.warn("MCP search enabled but no API key configured (set mcp.search.apiKey or BRAVE_API_KEY env var)");
    }
  }

  // Web fetch (content extraction)
  if (config.fetch?.enabled) {
    servers.fetch = {
      command: "npx",
      args: ["-y", "@anthropic-ai/mcp-server-fetch"],
    };
  }

  // Gateway MCP server (built-in, always uses the local gateway)
  if (config.gateway?.enabled !== false) {
    const gatewayMcpPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "..",
      "dist",
      "src",
      "mcp",
      "gateway-server.js",
    );
    // Only add if the built file exists; otherwise fall back to ts-node path
    const scriptPath = fs.existsSync(gatewayMcpPath)
      ? gatewayMcpPath
      : path.resolve(path.dirname(new URL(import.meta.url).pathname), "gateway-server.js");

    servers.gateway = {
      command: "node",
      args: [scriptPath],
      env: {
        JINN_GATEWAY_URL: `http://127.0.0.1:${process.env.JINN_PORT || "7777"}`,
        ...(sessionContext?.sessionId ? { JINN_CURRENT_SESSION_ID: sessionContext.sessionId } : {}),
        ...(sessionContext?.sessionId
          ? { JINN_SESSION_DELEGATION_TOKEN: getSessionDelegationToken(sessionContext.sessionId) }
          : {}),
        ...(sessionContext?.connector ? { JINN_CURRENT_CONNECTOR: sessionContext.connector } : {}),
        ...(sessionContext?.channel ? { JINN_CURRENT_CHANNEL: sessionContext.channel } : {}),
        ...(sessionContext?.thread ? { JINN_CURRENT_THREAD: sessionContext.thread } : {}),
        ...(sessionContext?.allowedGatewayTools
          ? { JINN_ALLOWED_GATEWAY_TOOLS: JSON.stringify(sessionContext.allowedGatewayTools) }
          : {}),
        ...(sessionContext?.allowedDeliveryTargets
          ? { JINN_ALLOWED_DELIVERY_TARGETS: JSON.stringify(sessionContext.allowedDeliveryTargets) }
          : {}),
      },
    };
  }

  // Custom user-defined MCP servers
  if (config.custom) {
    for (const [name, serverConfig] of Object.entries(config.custom)) {
      if (serverConfig.enabled === false) continue;
      const { enabled, ...rest } = serverConfig;

      // URL-based MCP server (HTTP/SSE transport)
      // Claude Code requires "type": "sse" for URL-based servers
      if ("url" in rest && (rest as McpServerUrlConfig).url) {
        servers[name] = { type: "sse", ...rest } as McpServerConfig;
        continue;
      }

      // Stdio-based MCP server — resolve env vars
      if ("env" in rest && rest.env) {
        for (const [key, value] of Object.entries(rest.env)) {
          rest.env[key] = resolveEnvVar(value) || value;
        }
      }
      servers[name] = rest as McpServerConfig;
    }
  }

  return servers;
}

/**
 * Write a resolved MCP config to a temp file and return the path.
 * Claude Code reads this via --mcp-config <path>.
 */
export function writeMcpConfigFile(config: ResolvedMcpConfig, sessionId: string): string {
  const tmpDir = path.join(JINN_HOME, "tmp", "mcp");
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.chmodSync(tmpDir, 0o700);
  const filePath = path.join(tmpDir, `${sessionId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

/**
 * Clean up a temp MCP config file.
 */
export function cleanupMcpConfigFile(sessionId: string): void {
  const filePath = path.join(JINN_HOME, "tmp", "mcp", `${sessionId}.json`);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Resolve a value that may reference an environment variable.
 * Supports ${VAR_NAME} syntax.
 */
function resolveEnvVar(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^\$\{(.+)\}$/);
  if (match) {
    return process.env[match[1]] || undefined;
  }
  // Also check if the raw value is a plain env var name
  if (value.startsWith("$")) {
    return process.env[value.slice(1)] || undefined;
  }
  return value;
}
