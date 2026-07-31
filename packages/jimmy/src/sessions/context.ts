import fs from "node:fs";
import path from "node:path";
import type { Employee, JinnConfig, PlacementProfile } from "../shared/types.js";
import { JINN_HOME, ORG_DIR, CRON_JOBS, DOCS_DIR } from "../shared/paths.js";
import { isOperatorSpeaker } from "../shared/operator-match.js";
import { scanOrg } from "../gateway/org.js";
import { buildServiceRegistry } from "../gateway/services.js";
import {
  isSkillVisibleToPlacement,
  PLACEMENT_MCP_TOOL_DENY,
  placementDeliveryTargets,
  safePlacementDataScopes,
} from "../shared/placement-profile.js";
import { listSkills } from "../cli/skills.js";

/**
 * Token budget strategy:
 *
 * Sections are split into three tiers that are assembled in order.
 * If the accumulated prompt exceeds the configurable budget (default 100K chars),
 * lower-tier sections are progressively replaced with compact summaries.
 *
 *   ESSENTIAL  – identity, session, config                (always included)
 *   STANDARD   – org summary, cron summary, connectors,
 *                API ref, evolution, language              (included when budget allows)
 *   OPTIONAL   – knowledge listing, environment scan,
 *                delegation protocol                       (trimmed first when over budget)
 *
 * Knowledge and docs files are NEVER inlined — only filenames are listed.
 * The AI can read files on demand, saving ~200K+ chars per session.
 */

const DEFAULT_MAX_CONTEXT_CHARS = 100_000;

// ── Tier enum for progressive trimming ────────────────────────
const enum Tier {
  ESSENTIAL = 0,
  STANDARD = 1,
  OPTIONAL = 2,
}

interface Section {
  tier: Tier;
  marker: string; // leading text used to identify the section in trimContext
  content: string;
  summary: string; // compact fallback when budget is tight
}

/**
 * Build a rich system prompt for engine sessions.
 * This is what makes Jinn "smart" — the engine sees all of this context
 * before responding to the user.
 */
export function buildContext(opts: {
  source: string;
  channel: string;
  thread?: string;
  user: string;
  employee?: Employee;
  connectors?: string[];
  config?: JinnConfig;
  sessionId?: string;
  portalName?: string;
  operatorName?: string;
  language?: string;
  channelName?: string;
  /** Display name of the actual speaker (from Slack users.info, etc.) */
  speakerName?: string;
  /** Speaker's real name (profile real_name) */
  speakerRealName?: string;
  /** Speaker's self-chosen display name */
  speakerDisplayName?: string;
  /** Speaker's legacy handle (users.name) */
  speakerHandle?: string;
  /** Raw connector-native user ID (e.g. Slack U12345) */
  speakerSlackId?: string;
  /** Whether the speaker is a bot/integration */
  speakerIsBot?: boolean;
  /** Speaker's IANA timezone */
  speakerTz?: string;
  hierarchy?: import("../shared/types.js").OrgHierarchy;
  placement?: PlacementProfile;
}): string {
  const maxChars = opts.config?.context?.maxChars ?? DEFAULT_MAX_CONTEXT_CHARS;
  const sections: Section[] = [];

  // Compute gateway URL once — used by multiple sections
  const gatewayUrl = opts.config
    ? `http://${opts.config.gateway.host || "127.0.0.1"}:${opts.config.gateway.port || 7777}`
    : "http://127.0.0.1:7777";

  // Resolve personalized names from config
  const portalName = opts.portalName || opts.config?.portal?.portalName || "Ryoko";
  const operatorName = opts.operatorName || opts.config?.portal?.operatorName;
  const language = opts.language || opts.config?.portal?.language || "English";
  // Single operator-identity decision for the whole prompt (identity block +
  // session block must agree). Matches across ALL known speaker aliases with
  // normalization — the old exact speakerName===operatorName comparison flagged
  // the operator himself as "NOT the operator" (nickname vs profile name),
  // teaching the model to ignore the warning entirely.
  const speakerIsOperator = isOperatorSpeaker(
    [opts.speakerName, opts.speakerRealName, opts.speakerDisplayName, opts.speakerHandle],
    operatorName,
    opts.config?.portal?.operatorAliases,
  );

  // ── ESSENTIAL: Identity ─────────────────────────────────────
  if (opts.employee) {
    sections.push({
      tier: Tier.ESSENTIAL,
      marker: "# You are",
      content: buildEmployeeIdentity(
        opts.employee,
        portalName,
        language,
        opts.hierarchy?.nodes[opts.employee.name],
        opts.hierarchy,
      ),
      summary: `# You are ${opts.employee.displayName}\nEmployee: ${opts.employee.name}, ${opts.employee.department}, ${opts.employee.rank}`,
    });
  } else {
    sections.push({
      tier: Tier.ESSENTIAL,
      marker: "# You are",
      content: buildIdentity(portalName, operatorName, language, opts.speakerName, speakerIsOperator, Boolean(opts.placement)),
      summary: `# You are ${portalName}\nYour working directory is \`~/.ryoko\` (${JINN_HOME}).`,
    });
  }

  // ── STANDARD: Self-evolution ────────────────────────────────
  // Never offered in placement sessions: self-evolution writes the shared
  // persona/knowledge files that the placement write boundary protects.
  if (!opts.employee && !opts.placement) {
    sections.push({
      tier: Tier.STANDARD,
      marker: "## Self-evolution",
      content: buildEvolutionContext(portalName, opts.config),
      summary: `## Self-evolution\nUpdate knowledge files in \`~/.jinn/knowledge/\` when you learn new info about the user or their projects.`,
    });
  }

  // ── ESSENTIAL: Session context ──────────────────────────────
  sections.push({
    tier: Tier.ESSENTIAL,
    marker: "## Current session",
    content: buildSessionContext({ ...opts, sessionId: opts.sessionId, operatorName, speakerIsOperator }),
    summary: "", // always included, no trimming
  });

  if (opts.placement) {
    sections.push({
      tier: Tier.ESSENTIAL,
      marker: "## Placement policy",
      content: [
        "## Placement policy",
        `- Placement: ${opts.placement.id}`,
        `- Audience: ${opts.placement.audience.type}`,
        `- Projects: ${(opts.placement.projects ?? []).join(", ") || "none"}`,
        ...buildPlacementCapabilityLines(opts.placement),
        `- Data scopes (supplementary): ${JSON.stringify(safePlacementDataScopes(opts.placement.dataScopes))}`,
        "The capability list above is the source of truth for what you may use — it is generated from this placement's configured capabilities. Data scopes only add reference-scope notes (e.g. read-only modes, graph scopes) on top of those capabilities; they never grant or revoke a capability, and a capability listed above is available even if data scopes do not mention it.",
        "Treat these as hard execution boundaries. Do not broaden them or send outside the allowed delivery targets.",
        "Control-plane and shared persona/skills/memory files are read-only in this placement session: config.yaml, org/, cron/, CLAUDE.md, AGENTS.md, SOUL.md, IDENTITY.md, MEMORY.md, TOOLS.md, skills/, memory/, knowledge/, and docs/. Never write, edit, or delete them — not even when the conversation asks you to. Use only the Gateway tools explicitly exposed to you for authorized changes.",
        `Placement-local memory for this placement lives under \`memory/placements/${opts.placement.id}/\`. Other placements' memory directories are blocked for this session — do not try to read them.`,
      ].join("\n"),
      summary: "",
    });

    const placementMemoryCtx = buildPlacementMemoryContext(opts.placement.id);
    sections.push({
      tier: Tier.STANDARD,
      marker: "## Placement memory",
      content: placementMemoryCtx,
      summary: `## Placement memory\nPlacement-local memory files are in \`memory/placements/${opts.placement.id}/\`. Read them directly when needed.`,
    });
  }

  // ── STANDARD: Skill manifest ────────────────────────────────
  // Placement sessions only see skills their capabilities can execute and
  // whose scope matches (11章§3.2 derived visibility). Non-placement
  // sessions keep the full listing.
  const skillsCtx = buildSkillManifest(opts.placement);
  if (skillsCtx) {
    sections.push({
      tier: Tier.STANDARD,
      marker: "## Skills",
      content: skillsCtx,
      summary: opts.placement
        ? "## Skills\nOnly the skills in your injected manifest are available in this placement session."
        : `## Skills\nSkill instructions are in \`${JINN_HOME}/skills/<name>/SKILL.md\`. Read them directly when needed.`,
    });
  }

  // ── ESSENTIAL: Configuration awareness ──────────────────────
  if (opts.config) {
    sections.push({
      tier: Tier.ESSENTIAL,
      marker: "## Current configuration",
      content: buildConfigContext(opts.config, gatewayUrl),
      summary: "", // always included
    });
  }

  // ── STANDARD: Organization ──────────────────────────────────
  const orgCtx = buildOrgContext(opts.hierarchy, Boolean(opts.placement));
  if (orgCtx) {
    sections.push({
      tier: Tier.STANDARD,
      marker: "## Organization",
      content: orgCtx,
      summary: `## Organization\nEmployee files are in \`${ORG_DIR}/\`. Read them directly when needed.`,
    });
  }

  // ── STANDARD: Available services (for employees only) ────────
  if (opts.employee && !opts.placement) {
    const svcCtx = buildServicesContext(opts.employee, gatewayUrl, opts.sessionId);
    if (svcCtx) {
      sections.push({
        tier: Tier.STANDARD,
        marker: "## Available services",
        content: svcCtx,
        summary: `## Available services\nUse \`POST ${gatewayUrl}/api/org/cross-request\` to request services from other employees.`,
      });
    }
  }

  // ── STANDARD: Cron jobs (only enabled, with disabled count) ─
  const cronCtx = buildCronContext();
  if (cronCtx) {
    sections.push({
      tier: Tier.STANDARD,
      marker: "## Scheduled cron",
      content: cronCtx,
      summary: "## Scheduled cron jobs\nCron definitions are in `~/.jinn/cron/jobs.json`. Read directly when needed.",
    });
  }

  // ── OPTIONAL: Knowledge / docs (filenames only, never inlined)
  const knowledgeCtx = buildKnowledgeContext();
  if (knowledgeCtx) {
    sections.push({
      tier: Tier.OPTIONAL,
      marker: "## Knowledge base",
      content: knowledgeCtx,
      summary: "## Knowledge base\nKnowledge files are in `~/.jinn/knowledge/` and `~/.jinn/docs/`. Read them directly when needed.",
    });
  }

  // ── STANDARD: Language override for skills ──────────────────
  if (language !== "English") {
    sections.push({
      tier: Tier.STANDARD,
      marker: "When following skill",
      content: `When following skill instructions, always communicate with the user in ${language}, even if the skill contains English examples or dialogue.`,
      summary: `Communicate in ${language}.`,
    });
  }

  // ── STANDARD: Connectors (Slack, etc.) ──────────────────────
  if (!opts.placement && opts.connectors && opts.connectors.length > 0) {
    sections.push({
      tier: Tier.STANDARD,
      marker: "## Available connectors",
      content: buildConnectorContext(opts.connectors, gatewayUrl, portalName),
      summary: `## Available connectors: ${opts.connectors.join(", ")}\nReturn your final answer to reply to the current conversation. Use connector messaging only for different conversations.`,
    });
  }

  // ── OPTIONAL: Local environment ─────────────────────────────
  const envCtx = buildEnvironmentContext();
  if (envCtx) {
    sections.push({
      tier: Tier.OPTIONAL,
      marker: "## Local environment",
      content: envCtx,
      summary: "## Local environment\nRun `ls ~/` to explore the local filesystem.",
    });
  }

  // ── OPTIONAL: Delegation protocol (COO only) ───────────────
  if (!opts.placement && !opts.employee) {
    sections.push({
      tier: Tier.OPTIONAL,
      marker: "## Employee Delegation",
      content: buildDelegationProtocol(gatewayUrl, portalName, opts.config, opts.sessionId),
      summary: `## Employee Delegation Protocol\nDelegate via \`POST ${gatewayUrl}/api/sessions/${opts.sessionId ?? "<your-session-id>"}/children\` with \`{prompt, employee}\`. The parent link is enforced by the URL.`,
    });
  }

  // ── STANDARD: Gateway API reference ─────────────────────────
  if (!opts.placement) {
    sections.push({
      tier: Tier.STANDARD,
      marker: `## ${portalName} Gateway API`,
      content: buildApiReference(gatewayUrl, portalName),
      summary: `## ${portalName} Gateway API (${gatewayUrl})\nEndpoints: /api/status, /api/sessions, /api/cron, /api/org, /api/skills, /api/config, /api/connectors, /api/logs`,
    });
  }

  // ── Assemble with progressive trimming by tier ──────────────
  return trimContext(sections, maxChars);
}

// ═══════════════════════════════════════════════════════════════
// Section builders
// ═══════════════════════════════════════════════════════════════

function buildEmployeeIdentity(
  employee: Employee,
  portalName: string,
  language: string,
  node?: import("../shared/types.js").OrgNode,
  hierarchy?: import("../shared/types.js").OrgHierarchy,
): string {
  const languageInstruction = language !== "English"
    ? `\n**Language**: Always respond in ${language}. All your communication with the user must be in ${language}.\n`
    : "";

  const chainOfCommand = buildChainOfCommand(employee, portalName, node, hierarchy);

  return `# You are ${employee.displayName}

You are an AI employee in the ${portalName} gateway system.

## Your persona
${employee.persona}
${languageInstruction}
## Your role
- **Name**: ${employee.name}
- **Display name**: ${employee.displayName}
- **Department**: ${employee.department}
- **Rank**: ${employee.rank}
- **Engine**: ${employee.engine}
- **Model**: ${employee.model}
${chainOfCommand}
## System context
You are part of the ${portalName} AI gateway — a system that orchestrates AI workers. You have access to the filesystem, can run commands, call APIs, and send messages via connectors. Your working directory is \`~/.jinn\` (${JINN_HOME}).

You can:
- Read and write files in the home directory
- Run shell commands
- Call the gateway API to interact with other parts of the system
- Send messages via connectors (Slack, etc.)
- Access skills, knowledge base, and documentation
- Collaborate with other employees by mentioning them or creating sessions

Be proactive, take initiative, and deliver results. You're not a chatbot — you're a worker.`;
}

function buildChainOfCommand(
  employee: Employee,
  portalName: string,
  node?: import("../shared/types.js").OrgNode,
  hierarchy?: import("../shared/types.js").OrgHierarchy,
): string {
  if (!node || !hierarchy) return "";

  const lines: string[] = ["## Chain of command"];
  lines.push(`- **Department**: ${employee.department}`);

  // Your manager
  if (node.parentName) {
    const parent = hierarchy.nodes[node.parentName];
    if (parent) {
      lines.push(`- **Your manager**: ${parent.employee.displayName} (${parent.employee.rank})`);
    } else {
      lines.push(`- **Your manager**: ${node.parentName}`);
    }
  } else {
    lines.push(`- **Your manager**: ${portalName} (COO)`);
  }

  // Direct reports
  if (node.directReports.length > 0) {
    const reports = node.directReports.map((name) => {
      const r = hierarchy.nodes[name];
      return r ? `${r.employee.displayName} (${r.employee.rank})` : name;
    });
    lines.push(`- **Your direct reports**: ${reports.join(", ")}`);
  }

  // Escalation path
  const escalation: string[] = [];
  let current = node.parentName;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    visited.add(current);
    const mgr = hierarchy.nodes[current];
    escalation.push(mgr ? mgr.employee.displayName : current);
    current = mgr?.parentName ?? null;
  }
  escalation.push(`${portalName} (COO)`);
  const unique = [...new Set(escalation)];
  lines.push(`- **Escalation path**: ${unique.join(" → ")}`);

  return "\n" + lines.join("\n") + "\n";
}

function buildServicesContext(employee: Employee, gatewayUrl: string, sessionId?: string): string | null {
  try {
    const registry = scanOrg();
    const services = buildServiceRegistry(registry);
    if (services.size === 0) return null;

    const lines: string[] = ["## Available services"];
    lines.push("Other employees provide the following services. To request one, use the cross-request API:");
    lines.push(`\`POST ${gatewayUrl}/api/org/cross-request\` with \`{"fromEmployee": "${employee.name}", "service": "<name>", "prompt": "<what you need>", "parentSessionId": "${sessionId ?? "<current-session-id>"}"}\``);
    lines.push("");

    for (const [svcName, entry] of services) {
      // Skip services from own department
      if (entry.provider.department === employee.department) continue;
      lines.push(`- **${svcName}** — ${entry.declaration.description} (provided by ${entry.provider.displayName}, ${entry.provider.department})`);
    }

    // If no external services remain after filtering, skip
    if (lines.length <= 4) return null;

    return lines.join("\n");
  } catch {
    return null;
  }
}

function buildIdentity(
  portalName: string,
  operatorName?: string,
  language?: string,
  speakerName?: string,
  speakerIsOperator = false,
  placementBound = false,
): string {
  const operatorLine = operatorName
    ? speakerIsOperator || !speakerName
      ? `\nYour operator (the person who runs this Jinn instance) is **${operatorName}**. Address them by name when appropriate.`
      : `\nYour operator (the person who runs this Jinn instance) is **${operatorName}** — but the current speaker is someone else.\nAlways identify the person you are addressing via \`## Current session → Speaker\`. Never call the current speaker "${operatorName}" unless confirmed — that name belongs to the operator, not to every person you talk to.`
    : "";

  const languageInstruction = language && language !== "English"
    ? `\n**Language**: Always respond in ${language}. All your communication with the user must be in ${language}.`
    : "";

  return `# You are ${portalName}

${portalName} is a personal AI assistant and gateway daemon. You are proactive, helpful, and opinionated — not a passive tool. You anticipate needs, suggest improvements, and take initiative when appropriate.${operatorLine}

## Core principles
- **Be proactive**: Don't just answer questions — suggest next steps, flag issues, offer to do related tasks.
- **Be concise**: Respect the user's time. Lead with the answer, not the reasoning.
- **Be capable**: You have access to the filesystem, can run commands, call APIs, send messages via connectors, and manage the system.
- **Be honest**: If you don't know something or can't do something, say so clearly.
- **Remember context**: You're part of a persistent system. Sessions can be resumed. Build on previous work.
${languageInstruction}
## Your home directory
Your working directory is \`~/.jinn\` (${JINN_HOME}). This contains:
- \`config.yaml\` — your configuration (engines, connectors, logging)
- \`org/\` — employee definitions (YAML files defining AI workers)
- \`skills/\` — reusable skill prompts
- \`docs/\` — documentation and knowledge base
- \`knowledge/\` — persistent knowledge files
- \`cron/\` — scheduled job definitions and run history
- \`sessions/\` — session database
- \`logs/\` — gateway logs
- \`CLAUDE.md\` — user-defined instructions (always follow these)
- \`AGENTS.md\` — agent/employee documentation

${placementBound
    ? "In this placement session these files are read-only reference material. Self-modification (persona, skills, memory, knowledge, org, cron, config) is not available here — see the Placement policy section."
    : "You can read, write, and modify any of these files to configure yourself, create new employees, add skills, etc."}`;
}

function buildSessionContext(opts: {
  source: string;
  channel: string;
  thread?: string;
  user: string;
  sessionId?: string;
  channelName?: string;
  speakerName?: string;
  speakerRealName?: string;
  speakerDisplayName?: string;
  speakerHandle?: string;
  speakerSlackId?: string;
  speakerIsBot?: boolean;
  speakerTz?: string;
  operatorName?: string;
  speakerIsOperator?: boolean;
}): string {
  let ctx = `## Current session\n`;
  if (opts.sessionId) ctx += `- Session ID: ${opts.sessionId}\n`;
  ctx += `- Source: ${opts.source}\n`;
  if (opts.channelName) {
    ctx += `- Channel: #${opts.channelName} (${opts.channel})\n`;
  } else if (opts.source === "slack" && opts.channel.startsWith("D")) {
    ctx += `- Channel: Direct Message (${opts.channel})\n`;
  } else {
    ctx += `- Channel: ${opts.channel}\n`;
  }
  if (opts.thread) ctx += `- Thread: ${opts.thread}\n`;

  if (opts.speakerName) {
    const aliasParts: string[] = [];
    if (opts.speakerRealName && opts.speakerRealName !== opts.speakerName) {
      aliasParts.push(`real name: "${opts.speakerRealName}"`);
    }
    if (opts.speakerHandle && opts.speakerHandle !== opts.speakerName) {
      aliasParts.push(`handle: @${opts.speakerHandle}`);
    }
    if (opts.speakerSlackId) {
      aliasParts.push(`Slack ID: ${opts.speakerSlackId}`);
    }
    const aliasSuffix = aliasParts.length > 0 ? ` (${aliasParts.join(", ")})` : "";
    const botSuffix = opts.speakerIsBot ? " [BOT]" : "";
    ctx += `- Speaker: **${opts.speakerName}**${aliasSuffix}${botSuffix}\n`;
    if (opts.speakerTz) ctx += `  - Timezone: ${opts.speakerTz}\n`;

    const operator = opts.operatorName?.trim();
    const isOperator = opts.speakerIsOperator === true;
    if (operator && !isOperator) {
      ctx += `  - ⚠ NOT the operator. Address this person as "${opts.speakerName}", not "${operator}".\n`;
    } else if (operator && isOperator) {
      ctx += `  - This speaker is the operator.\n`;
    }
  } else {
    ctx += `- User: ${opts.user}\n`;
  }

  ctx += `- Working directory: ${JINN_HOME}`;
  return ctx;
}

function buildConfigContext(config: JinnConfig, gatewayUrl: string): string {
  const lines: string[] = [`## Current configuration`];
  lines.push(`- Gateway: ${gatewayUrl}`);
  lines.push(`- Default engine: ${config.engines.default}`);
  if (config.engines.claude?.model) {
    lines.push(`- Claude model: ${config.engines.claude.model}`);
  }
  if (config.engines.codex?.model) {
    lines.push(`- Codex model: ${config.engines.codex.model}`);
  }
  if (config.engines.gemini?.model) {
    lines.push(`- Gemini model: ${config.engines.gemini.model}`);
  }
  if (config.logging) {
    lines.push(`- Log level: ${config.logging.level || "info"}`);
  }
  return lines.join("\n");
}

function buildOrgContext(hierarchy?: import("../shared/types.js").OrgHierarchy, placementBound = false): string | null {
  try {
    if (hierarchy && Object.keys(hierarchy.nodes).length > 0) {
      const MAX_DEPTH = 3;
      const count = Object.keys(hierarchy.nodes).length;
      const lines: string[] = [`## Organization (${count} employee(s))`];

      let deepCount = 0;
      for (const name of hierarchy.sorted) {
        const node = hierarchy.nodes[name];
        if (node.depth >= MAX_DEPTH) {
          deepCount++;
          continue;
        }
        const emp = node.employee;
        const indent = "  ".repeat(node.depth);
        let entry = `${indent}- **${emp.displayName}** (${name}) — ${emp.department}, ${emp.rank}`;
        if (emp.persona) {
          const firstLine = emp.persona.trim().split("\n")[0].trim().slice(0, 120);
          entry += `\n${indent}  _${firstLine}_`;
        }
        lines.push(entry);
      }
      if (deepCount > 0) {
        lines.push(`${"  ".repeat(MAX_DEPTH)}- ... and ${deepCount} more at deeper levels`);
      }

      if (!placementBound) lines.push(`\nYou can create new employees by writing YAML files to \`${ORG_DIR}/\``);
      return lines.join("\n");
    }

    // Fallback: filesystem-based flat rendering (backwards compat)
    // Recursively collect all employee yaml files (skip department.yaml)
    const employeeFiles: { fullPath: string; name: string }[] = [];

    function scanDir(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (
          (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) &&
          entry.name !== "department.yaml"
        ) {
          employeeFiles.push({ fullPath, name: entry.name.replace(/\.ya?ml$/, "") });
        }
      }
    }

    scanDir(ORG_DIR);
    if (employeeFiles.length === 0) return null;

    const lines: string[] = [`## Organization (${employeeFiles.length} employee(s))`];
    for (const { fullPath, name } of employeeFiles) {
      const content = fs.readFileSync(fullPath, "utf-8");
      const displayMatch = content.match(/displayName:\s*(.+)/);
      const deptMatch = content.match(/department:\s*(.+)/);
      const rankMatch = content.match(/rank:\s*(.+)/);
      const personaMatch = content.match(/persona:\s*[|>]?\s*\n?\s*(.+)/);
      let entry = `- **${displayMatch?.[1] || name}** (${name}) — ${deptMatch?.[1] || "unassigned"}, ${rankMatch?.[1] || "employee"}`;
      if (personaMatch?.[1]) {
        entry += `\n  _${personaMatch[1].trim().slice(0, 120)}_`;
      }
      lines.push(entry);
    }
    if (!placementBound) lines.push(`\nYou can create new employees by writing YAML files to \`${ORG_DIR}/\``);
    return lines.join("\n");
  } catch {
    return null;
  }
}

/**
 * Cron context: shows only enabled jobs inline, with a count of disabled jobs.
 * Previously listed all 77+ jobs; now only active ones are shown to save tokens.
 */
function buildCronContext(): string | null {
  try {
    const raw = fs.readFileSync(CRON_JOBS, "utf-8");
    const jobs = JSON.parse(raw);
    if (!Array.isArray(jobs) || jobs.length === 0) return null;

    const enabled = jobs.filter((j: any) => j.enabled !== false);
    const disabledCount = jobs.length - enabled.length;

    const lines: string[] = [`## Scheduled cron jobs (${enabled.length} active, ${disabledCount} disabled)`];
    for (const job of enabled) {
      lines.push(`- **${job.name}**: \`${job.schedule}\`${job.employee ? ` → ${job.employee}` : ""}`);
    }
    if (disabledCount > 0) {
      lines.push(`\n_${disabledCount} disabled jobs not shown. See \`~/.jinn/cron/jobs.json\` for the full list._`);
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

/**
 * Knowledge context: lists filenames and sizes only — never inlines content.
 * The AI reads files on demand. This saves ~200K+ chars compared to full inlining.
 */
/**
 * Skill manifest (11章§3.2). For a placement session, list only the skills the
 * placement's capabilities can execute and whose scope matches its projects —
 * a skill's visibility is derived, never independently managed, and skills
 * grant no capability. Without a placement, list every installed skill.
 */
function buildSkillManifest(placement?: PlacementProfile): string | null {
  let skills: ReturnType<typeof listSkills>;
  try {
    skills = listSkills();
  } catch {
    return null;
  }
  if (placement) {
    skills = skills.filter((skill) => isSkillVisibleToPlacement(skill, placement));
  }
  if (skills.length === 0) {
    return placement
      ? "## Skills\nNo skills are available to this placement (none match its capabilities and scope)."
      : null;
  }
  const lines = skills.map((skill) => {
    const scopeLabel = skill.scope ? ` (scope: ${skill.scope})` : "";
    return `- ${skill.name}${scopeLabel} — ${skill.description || "no description"}`;
  });
  return [
    "## Skills",
    placement
      ? "Only the skills listed below are available in this placement session (derived from the placement's capabilities and scope). Skill instructions are in `skills/<name>/SKILL.md`."
      : "Installed skills. Skill instructions are in `skills/<name>/SKILL.md` — read them when a task matches.",
    ...lines,
  ].join("\n");
}

/**
 * Soft-boundary capability declaration, generated from the placement's
 * `capabilities` (the single source of truth) instead of hand-written
 * dataScopes. Keeping the declaration derived prevents the two failure modes
 * seen in production: a capability granted in `capabilities.mcp` but missing
 * from dataScopes made the model refuse it ("not allowed by this placement's
 * policy"), and a stale hand-written declaration advertised capabilities a
 * placement no longer had. Tools in PLACEMENT_MCP_TOOL_DENY are annotated so
 * the prompt never advertises what the hard boundary always blocks.
 */
function buildPlacementCapabilityLines(placement: PlacementProfile): string[] {
  const mcp = placement.capabilities?.mcp;
  const mcpServers = Array.isArray(mcp) ? mcp : [];
  const mcpEntries = mcpServers.map((name) => {
    const deniedTools = PLACEMENT_MCP_TOOL_DENY
      .filter((tool) => tool.startsWith(`mcp__${name}__`))
      .map((tool) => tool.slice(`mcp__${name}__`.length));
    return deniedTools.length > 0
      ? `${name} (available, except always-denied tools: ${deniedTools.join(", ")})`
      : `${name} (available)`;
  });
  const gatewayTools = placement.capabilities?.gatewayTools ?? [];
  const delivery = placementDeliveryTargets(placement)
    .map((target) => `${target.connector}:${target.channel}`);
  return [
    `- MCP servers: ${mcpEntries.join(", ") || "none"}`,
    `- Gateway tools: ${gatewayTools.join(", ") || "none"}`,
    `- Allowed delivery targets: ${delivery.join(", ")}`,
  ];
}

/**
 * Placement-local memory view (11章§3.1): list only this placement's files.
 * Other placements' directories are read-denied at the engine boundary, so the
 * view and the enforcement agree on what this session can see.
 */
function buildPlacementMemoryContext(placementId: string): string {
  const dir = path.join(JINN_HOME, "memory", "placements", placementId);
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => !f.startsWith("."));
  } catch {
    // no placement-local memory yet
  }
  const header = [
    "## Placement memory",
    `Placement-local memory for this channel is in \`${dir}/\`. It is readable (not writable) in this session and is never shared with other placements.`,
  ];
  if (files.length === 0) {
    return [...header, "No placement-local memory files exist yet."].join("\n");
  }
  return [...header, ...files.map((f) => `- ${f}`)].join("\n");
}

function buildKnowledgeContext(): string | null {
  const dirs = [
    { dir: DOCS_DIR, label: "docs" },
    { dir: path.join(JINN_HOME, "knowledge"), label: "knowledge" },
  ];
  const entries: { name: string; dir: string; sizeKb: string }[] = [];

  for (const { dir, label } of dirs) {
    try {
      const files = fs.readdirSync(dir).filter(f =>
        f.endsWith(".md") || f.endsWith(".txt") || f.endsWith(".yaml"),
      );
      for (const f of files) {
        try {
          const stat = fs.statSync(path.join(dir, f));
          entries.push({
            name: f,
            dir: label,
            sizeKb: (stat.size / 1024).toFixed(1),
          });
        } catch {
          entries.push({ name: f, dir: label, sizeKb: "?" });
        }
      }
    } catch {
      // dir doesn't exist
    }
  }

  if (entries.length === 0) return null;

  const lines: string[] = [
    `## Knowledge base`,
    `Knowledge files are in \`~/.jinn/knowledge/\` and \`~/.jinn/docs/\`. Read them directly when needed.`,
    ``,
  ];

  // Group by directory
  for (const label of ["docs", "knowledge"]) {
    const group = entries.filter(e => e.dir === label);
    if (group.length === 0) continue;
    lines.push(`**${label}/** (${group.length} files):`);
    for (const e of group) {
      lines.push(`- \`${e.name}\` (${e.sizeKb} KB)`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildConnectorContext(connectors: string[], gatewayUrl: string, portalName: string): string {
  const lines: string[] = [`## Available connectors: ${connectors.join(", ")}`];
  lines.push(`You can send messages and interact with external services via the ${portalName} gateway API.`);
  lines.push("Use connector messaging only for proactive messages to a different channel or conversation.\n");

  for (const name of connectors) {
    lines.push(`### ${name}`);
    lines.push("- **Send message**: use the `send_message` tool or `/api/connectors/:name/send` only for a channel/conversation other than the one that triggered this session");
    lines.push("- **Send threaded message**: include `thread` only when targeting a different existing thread");
    lines.push("- Good uses: notifying another channel about completed tasks, errors, or status updates");
  }

  lines.push("");
  lines.push("### Replying to the current conversation");
  lines.push("- The text you return as your final answer is delivered to the current conversation/thread. Treat it as PUBLIC to the current speaker and channel.");
  lines.push("- Do not call `/send`, `curl`, or the `send_message` tool for the current conversation. That creates duplicate or meta replies.");
  lines.push("- Your final answer is shown verbatim, so make it the actual reply — NOT work narration, status reports to the operator, or internal deliberation.");
  lines.push("- Never put operator notes, file IDs, internal drafts, approval waits (\"GO待ち\"), or instructions meant for another audience in the public body — especially in externally-shared channels.");
  lines.push("- To keep an operator-only note out of the channel, append a trailer whose LAST non-empty line is exactly this (base64url-encoded JSON):");
  lines.push("  `<!--RYOKO-DISPOSITION:v1:<base64url of {\"internal\":\"...\",\"react\":\":emoji:\",\"suppressPublic\":false}>-->`");
  lines.push("  The `internal` field is never posted publicly (saved for the operator). `react` makes the public reply a single emoji reaction; `suppressPublic` omits the public body.");
  lines.push("- When you are directly addressed (mentioned / asked), ALWAYS give a non-empty public reply. Use react-only for pure acknowledgments or social confirmations — never as the answer to a substantive question.");

  lines.push(`\n- **List all connectors**: \`curl ${gatewayUrl}/api/connectors\``);
  lines.push(`- Channel IDs and connector config can be found in \`~/.jinn/config.yaml\``);
  return lines.join("\n");
}

function buildEnvironmentContext(): string | null {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const lines: string[] = [`## Local environment`];
  let hasContent = false;

  const toolDirs: { dir: string; label: string; description: string }[] = [
    { dir: ".openclaw", label: "OpenClaw", description: "AI agent platform (agents, cron, memory, hooks, credentials)" },
    { dir: ".claude", label: "Claude Code", description: "Claude Code CLI config and projects" },
    { dir: ".codex", label: "Codex", description: "OpenAI Codex CLI config" },
  ];

  for (const tool of toolDirs) {
    const toolPath = path.join(home, tool.dir);
    try {
      const stat = fs.statSync(toolPath);
      if (stat.isDirectory()) {
        const contents = fs.readdirSync(toolPath).filter(f => !f.startsWith("."));
        lines.push(`- **${tool.label}** (\`~/${tool.dir}/\`): ${tool.description}`);
        if (contents.length > 0) {
          lines.push(`  Contents: ${contents.slice(0, 15).join(", ")}${contents.length > 15 ? `, ... (${contents.length} total)` : ""}`);
        }
        hasContent = true;
      }
    } catch {
      // doesn't exist
    }
  }

  // Scan ~/Projects for user's codebases
  const projectsDir = path.join(home, "Projects");
  try {
    const projects = fs.readdirSync(projectsDir).filter(f => {
      try { return fs.statSync(path.join(projectsDir, f)).isDirectory(); } catch { return false; }
    });
    if (projects.length > 0) {
      lines.push(`- **Projects** (\`~/Projects/\`): ${projects.join(", ")}`);
      hasContent = true;
    }
  } catch {
    // no Projects dir
  }

  if (!hasContent) return null;

  lines.push(`\nWhen the user asks about tools or systems on their machine, check these directories first before saying you don't know. Be resourceful — explore the filesystem.`);
  return lines.join("\n");
}

function buildEvolutionContext(portalName: string, config?: JinnConfig): string {
  const profilePath = path.join(JINN_HOME, "knowledge", "user-profile.md");
  let profileContent = "";
  try { profileContent = fs.readFileSync(profilePath, "utf-8").trim(); } catch {}

  const isNew = profileContent.length < 50;

  // Conversational discovery hint: a Slack workspace is wired up but the
  // user hasn't enabled the Agents View canvas. Surface it in steady-state
  // mode (not onboarding) so the assistant can proactively offer to help
  // turn it on — without nagging on every turn.
  const slackConnected = !!(
    config?.connectors?.slack?.appToken && config.connectors?.slack?.botToken
  );
  const canvasEnabled = config?.connectors?.slack?.agentsCanvas?.enabled === true;
  const canvasHintApplies = slackConnected && !canvasEnabled;

  const lines: string[] = [`## Self-evolution`];

  if (isNew) {
    lines.push(`**ONBOARDING MODE**: This is a new or unconfigured ${portalName} installation.`);
    lines.push(`Before answering the user's request, introduce yourself briefly and ask them:`);
    lines.push(`1. What's your name and what do you do? (business, role, projects)`);
    lines.push(`2. What should ${portalName} help you automate? (code reviews, deployments, monitoring, etc.)`);
    lines.push(`3. Communication preferences — emoji style, verbosity (concise vs detailed), language`);
    lines.push(`4. Any active projects ${portalName} should know about?`);
    lines.push(`\nAfter the user responds, write their answers to \`~/.jinn/knowledge/user-profile.md\` and \`~/.jinn/knowledge/preferences.md\`.`);
    lines.push(`Then proceed to help with their original request.`);
    if (canvasHintApplies) {
      lines.push(
        `\nIf the conversation goes well and Slack is set up, you may also mention that you can mirror all your running sessions to a Slack canvas (the "Agents View Canvas") — but only once, briefly, and only if it feels natural.`,
      );
    }
  } else {
    lines.push(`You learn and evolve over time. When you discover new information about the user, their projects, or their preferences:`);
    lines.push(`- Update \`~/.jinn/knowledge/user-profile.md\` with business/identity info`);
    lines.push(`- Update \`~/.jinn/knowledge/preferences.md\` with style/communication preferences`);
    lines.push(`- Update \`~/.jinn/knowledge/projects.md\` with project details`);
    lines.push(`- If the user gives you persistent feedback (e.g. "always do X", "never do Y"), update \`~/.jinn/CLAUDE.md\``);
    lines.push(`\nDo this silently — don't announce every file update. Just evolve.`);
    if (canvasHintApplies) {
      lines.push(
        `\n### Available feature the user hasn't enabled: Agents View Canvas`,
      );
      lines.push(
        `Slack is connected but \`slack.agentsCanvas.enabled\` is off in config.yaml. The Agents View Canvas mirrors every running ${portalName} session to a Slack canvas — running / waiting / errored / idle, updated every 30 seconds.`,
      );
      lines.push(
        `**Do NOT proactively pitch this on every turn.** Only suggest it when ALL of these hold:`,
      );
      lines.push(
        `- The user just asked something that benefits from seeing live session state (e.g. "what is Ryoko doing right now?", "I want a dashboard of your work", "is there a way to see all the agents?")`,
      );
      lines.push(
        `- OR the user just successfully connected Slack and is exploring what to do next.`,
      );
      lines.push(
        `When you do bring it up, keep it to one sentence and point them to **Settings → Slack → Agents View Canvas** in the Web UI. The user can also delegate the toggling to you (Bash tool: \`curl -X PUT http://...:7777/api/config\`) if they ask.`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * Delegation protocol: condensed version focusing on the essential API patterns.
 * Verbose examples and multi-paragraph explanations have been trimmed.
 */
function buildDelegationProtocol(
  gatewayUrl: string,
  _portalName: string,
  config?: JinnConfig,
  currentSessionId?: string,
): string {
  const defaultEngine = config?.engines.default || "claude";
  const engineConfig = defaultEngine === "codex"
    ? config?.engines.codex
    : defaultEngine === "gemini"
      ? config?.engines.gemini ?? config?.engines.claude
      : config?.engines.claude;
  const childOverride = engineConfig?.childEffortOverride;

  const effortOverrideNote = childOverride
    ? `\n> **Note**: \`childEffortOverride\` is set to \`"${childOverride}"\`. All child sessions use this effort level.`
    : "";
  const parentSessionId = currentSessionId ?? "<your-session-id>";

  return `## Employee Delegation Protocol

You are the COO. You orchestrate employees by creating **linked child sessions**.

### How delegation works

1. **Route**: Handle routine work yourself with the parent session's model. Delegate only when the task benefits materially from a specialist.

   If the Employee Directory contains \`critical-reviewer\`, delegate to it for:
   - architecture or business decisions with high downstream impact
   - security, privacy, compliance, or credential handling
   - production changes, destructive actions, or other hard-to-reverse operations
   - final review of important customer-facing or externally published deliverables
   - high-impact decisions where you cannot reach sufficient confidence

   Do not delegate routine research, summaries, drafts, status checks, or low-risk edits merely to improve wording. If none of the critical criteria applies, answer directly.

2. **Detect explicit delegation**: Honor \`@employee-name\` tags when that employee exists.

3. **Check for existing children first**:
\`\`\`bash
curl -s ${gatewayUrl}/api/sessions/${parentSessionId}/children
\`\`\`
Reuse an existing child only when it belongs to the same user task and needs a follow-up. A completed child from an older task is not reusable for a new task.

4. **Brief**: Craft clear, targeted instructions — translate user words into actionable briefs.

5. **Spawn**:
\`\`\`bash
curl -s -X POST ${gatewayUrl}/api/sessions/${parentSessionId}/children \\
  -H 'Content-Type: application/json' \\
  -d '{"prompt": "<brief>", "employee": "<name>"}'
\`\`\`

6. **Follow up** (existing child for the same task):
\`\`\`bash
curl -s -X POST ${gatewayUrl}/api/sessions/<child-id>/message \\
  -H 'Content-Type: application/json' \\
  -d '{"message": "<follow-up>"}'
\`\`\`

7. **Respond immediately**: Tell the user you've delegated and will follow up when it's done. **Do NOT poll or wait** — end your turn now.

8. **onComplete callback**: When the child session finishes, the gateway automatically sends a linked-child notification containing both child and parent session IDs. Because the parent ID equals your current session ID, this callback is authoritative evidence that the result belongs to your original user task. It is never an unrelated or orphaned conversation.

9. **Review and finish**: Read the complete child result, assess it using oversight levels (TRUST / VERIFY / THOROUGH), and send the integrated final answer through the original parent connector. Do not delegate the completed task again.

### Key rules
- **NEVER poll or wait for child sessions**. After spawning, reply to the user and end your turn. The gateway's onComplete callback will message you automatically when the child finishes.
- **Always reuse** child sessions — never create duplicates for the same employee.
- **Parallel spawning**: For independent sub-tasks, spawn multiple employees simultaneously.
- **Cross-reference**: Compare results from multiple employees before responding.
- **Effort levels**: Include \`"effortLevel"\` in the API body: \`"low"\` (lookups), \`"medium"\` (routine), \`"high"\` (code/architecture).

### Oversight Levels

| Level | When | You do |
|-------|------|--------|
| **TRUST** | Simple lookups, status checks | Skim, relay directly |
| **VERIFY** | Code changes, routine work | Read fully, spot-check key files |
| **THOROUGH** | Architecture, breaking changes, security | Full review, multi-turn follow-up, verify changes |

### Manager Delegation

When a department has 3+ employees, promote a senior to **manager**. Managers handle their own delegation; you review their summaries, not individual work.

### Your session ID

Your current session ID is \`${parentSessionId}\`. Always use the session-specific child endpoint shown above; it enforces the parent link even if the request body omits \`parentSessionId\`.${effortOverrideNote}`;
}

function buildApiReference(gatewayUrl: string, portalName: string): string {
  return `## ${portalName} Gateway API (${gatewayUrl})

You can call these endpoints with curl to inspect and manage the gateway:

| Endpoint | Method | Description |
|----------|--------|-------------|
| \`/api/status\` | GET | Gateway status, uptime, engine info |
| \`/api/sessions\` | GET | List all sessions |
| \`/api/sessions/:id\` | GET | Session detail (includes messages) |
| \`/api/sessions\` | POST | Create new session (\`{prompt, engine?, employee?, parentSessionId?}\`) |
| \`/api/sessions/:id/message\` | POST | Send follow-up message to existing session (\`{message}\`) |
| \`/api/sessions/:id/children\` | GET | List child sessions of a parent |
| \`/api/cron\` | GET | List cron jobs |
| \`/api/cron/:id\` | PUT | Update cron job (toggle enabled, etc.) |
| \`/api/cron/:id/runs\` | GET | Cron run history |
| \`/api/org\` | GET | Organization structure |
| \`/api/org/employees/:name\` | GET | Employee details |
| \`/api/skills\` | GET | List skills |
| \`/api/skills/:name\` | GET | Skill content |
| \`/api/config\` | GET | Current config |
| \`/api/config\` | PUT | Update config |
| \`/api/connectors\` | GET | List connectors |
| \`/api/connectors/:name/send\` | POST | Proactively send to a different connector conversation; never use it to reply to the current conversation |
| \`/api/logs\` | GET | Recent log lines |`;
}

/**
 * Progressive trimming by tier: OPTIONAL sections are replaced with summaries first,
 * then STANDARD, then (as a last resort) ESSENTIAL sections.
 */
function trimContext(sections: Section[], maxChars: number): string {
  let parts = sections.map(s => s.content);
  let result = parts.join("\n\n");
  if (result.length <= maxChars) return result;

  // Trim OPTIONAL sections first, then STANDARD
  for (const tier of [Tier.OPTIONAL, Tier.STANDARD]) {
    for (let i = sections.length - 1; i >= 0; i--) {
      if (result.length <= maxChars) break;
      if (sections[i].tier === tier && sections[i].summary) {
        parts[i] = sections[i].summary;
        result = parts.join("\n\n");
      }
    }
  }

  return result;
}
