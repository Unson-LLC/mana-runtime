# Jinn Design Document

**Date:** 2026-03-06
**Status:** Superseded（歴史資料 — placement・Canonical Task・議事録パイプライン導入以前の初期設計。現在地は [docs/architecture/01_system_overview.md](../architecture/01_system_overview.md) を正とする）
**Package:** `jinn-cli`

---

## 1. Overview

Jinn is a lightweight, open-source AI gateway daemon that orchestrates Claude Code CLI and Codex SDK to create an autonomous, self-organizing AI workforce.

### Core Principles

1. **Zero opinions on AI** — Jinn never touches the agentic loop. No ReAct implementation, no tool execution, no context management, no memory system. Claude Code and Codex handle all intelligence. Jinn is a bus, not a brain.

2. **Files are the interface** — Everything is files on disk. Employees are persona YAML files. Boards are JSON files. Skills are directories with SKILL.md. Config is YAML. The engines read and write these files natively. The gateway watches for changes and reacts.

3. **Organic growth** — No predefined structure. Jinn bootstraps an organization based on the user's actual needs. Departments, employees, ranks, boards — all created on demand by Jinn's management skill, not hardcoded.

### Mental Model

You are the CEO. Jinn is your COO. He hires, manages, and orchestrates a team of AI employees — each backed by Claude Code or Codex — to handle your work across projects, platforms, and domains.

### Tech Stack

- **Runtime:** Node.js + TypeScript
- **Monorepo:** pnpm + Turborepo
- **Web UI:** Next.js 15 + Tailwind CSS (static export)
- **Database:** SQLite (better-sqlite3) for session registry
- **Slack:** Bolt SDK (socket mode)
- **Cron:** node-cron
- **Package:** `jinn-cli` on npm

---

## 2. Architecture

### Three Components

| Component | Package | Purpose |
|-----------|---------|---------|
| Core | `jinn-cli` | CLI + gateway daemon + engines + connectors + cron |
| Web UI | `@jinn/web` | Next.js + Tailwind dashboard, statically exported |
| Template | `template/` | Init files copied to `~/.jinn/` on setup |

### Single Process Runtime

`jinn start` boots one Node.js process that runs:
- HTTP server (REST API + static web UI files)
- WebSocket server (live events to web UI)
- Connector system (Slack etc. via socket mode)
- Cron scheduler (node-cron)
- File watcher (hot-reload config, cron jobs, org structure)

Engine sessions are child processes (`claude -p` or Codex SDK calls) that run, return results, and exit. The gateway manages their lifecycle.

### Data Flow

```
Incoming message (Slack / Web UI / Cron tick)
    |
    v
Connector normalizes -> { source, channel, thread, user, text, attachments }
    |
    v
Gateway checks: is this a Jinn command (/new, /status)?
    | YES -> handle internally, respond
    | NO  v
    |
Router: who is this for?
    | @employee-name mentioned? -> look up employee persona
    | No mention? -> use channel/DM session (Jinn or last active persona)
    |
    v
Session Manager
    | 1. Look up session in registry (SQLite)
    | 2. Determine engine + model (employee persona -> channel override -> global default)
    | 3. Download attachments to temp dir (if any)
    | 4. Build --append-system-prompt (session origin context)
    | 5. Add eyes reaction via connector
    | 6. Spawn engine process (one-shot, cwd: ~/.jinn/)
    |
    v
Engine runs (Claude Code / Codex does everything)
    | Reads CLAUDE.md / AGENTS.md, uses skills, edits files, runs commands...
    |
    v
Session Manager receives result
    | 1. Update registry (session_id, status, last_activity)
    | 2. Remove eyes, add checkmark reaction
    | 3. Send result text to connector (Slack thread / web UI)
    | 4. Emit event to WebSocket (web UI live update)
    | 5. If error: add X reaction, send error message, log to file
    |
    v
File watcher detects changes (if engine modified cron/config/org)
    | Reload affected subsystem
```

### Port

Default: `7777`. Configurable in `config.yaml`.

---

## 3. Session Model

### Four Session Types

| Type | Trigger | Lifecycle | Resume behavior |
|------|---------|-----------|-----------------|
| Main | DM to Jinn on Slack | Persistent forever | Same session_id resumed on every DM |
| Channel | Message in Slack channel root | Persistent per channel | Same session_id resumed for all root messages |
| Thread | Reply creating a Slack thread | Isolated per thread | Same session_id for all messages within thread |
| Cron | Cron job fires | Isolated per run | Fresh session every time, never resumed |

### Session Registry (SQLite)

```sql
CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,
  engine            TEXT NOT NULL,
  engine_session_id TEXT,
  source            TEXT NOT NULL,
  source_ref        TEXT NOT NULL,
  employee          TEXT,
  model             TEXT,
  status            TEXT DEFAULT 'idle',
  created_at        TEXT NOT NULL,
  last_activity     TEXT NOT NULL,
  last_error        TEXT
);
```

### Rules

- **One engine per session, fixed at creation.** No mid-conversation engine switching.
- **One-shot resume model.** Every interaction spawns `claude -p --resume <id> --output-format json "message"`. Process runs, returns JSON, exits.
- **Lane queue.** One engine process per session at a time. New messages queue until the current process finishes.
- **`/new` command.** User types `/new` in any context -> Jinn creates a new session ID, stops resuming the old one. Old session remains in engine's native storage but Jinn no longer references it.
- **`/status` command.** Returns active sessions, cron jobs, gateway health.

---

## 4. Engine Abstraction

### Interface

```typescript
interface Engine {
  name: string;

  run(opts: {
    prompt: string;
    resumeSessionId?: string;
    systemPrompt?: string;
    cwd: string;
    model?: string;
    attachments?: string[];
  }): Promise<EngineResult>;
}

interface EngineResult {
  sessionId: string;
  result: string;
  cost?: number;
  durationMs?: number;
  numTurns?: number;
  error?: string;
}
```

### Claude Engine

Spawns `claude` CLI as a child process:

```
claude -p \
  --resume <sessionId> \
  --output-format json \
  --permission-mode bypassPermissions \
  --append-system-prompt "<context>" \
  --model <model> \
  --verbose \
  "<prompt>"
```

- `cwd: ~/.jinn/`
- Parses JSON stdout: `{ session_id, result, total_cost_usd, duration_ms, num_turns }`
- Attachments included in prompt as file paths (Claude Code reads files/images natively)
- **Must unset `CLAUDECODE` env var** to prevent false "nested session" detection:
  ```typescript
  env: { ...process.env, CLAUDECODE: undefined }
  ```

### Codex Engine

Uses `@openai/codex-sdk` programmatically:

```typescript
import { Codex } from "@openai/codex-sdk";

const codex = new Codex();
const thread = resumeId
  ? codex.resumeThread(resumeId)
  : codex.startThread({ workingDirectory: "~/.jinn/" });
const result = await thread.run(prompt);
```

### Adding New Engines

One new file implementing the `Engine` interface. The gateway is engine-agnostic. Any engine can be Jinn's default brain — configurable in `config.yaml`.

### Available Models

**Claude Code (March 2026):**

| Alias | Model | Use case |
|-------|-------|----------|
| `opus` | Claude Opus 4.6 | Complex reasoning (default for Max) |
| `sonnet` | Claude Sonnet 4.6 | Daily coding, execution |
| `haiku` | Claude Haiku 4.5 | Quick tasks |
| `opusplan` | Opus plan + Sonnet execute | Hybrid mode |
| `sonnet[1m]` | Sonnet with 1M context | Long sessions |

**Codex (March 2026):**

| Model | Use case |
|-------|----------|
| `gpt-5.4` | Flagship: coding + reasoning + agentic |
| `gpt-5.3-codex` | Complex software engineering |
| `gpt-5.3-codex-spark` | Real-time coding (Pro only) |
| `gpt-5.1-codex-max` | Long-horizon agentic |
| `codex-mini-latest` | Fast, low-latency |

---

## 5. Connector System

### Interface

```typescript
interface Connector {
  name: string;

  start(): Promise<void>;
  stop(): Promise<void>;

  sendMessage(target: Target, text: string): Promise<void>;
  addReaction(target: Target, emoji: string): Promise<void>;
  removeReaction(target: Target, emoji: string): Promise<void>;
  editMessage(target: Target, text: string): Promise<void>;

  onMessage(handler: (msg: IncomingMessage) => void): void;
}

interface IncomingMessage {
  source: string;
  channel: string;
  thread?: string;
  user: string;
  userId: string;
  text: string;
  attachments: Attachment[];
  raw: any;
}

interface Attachment {
  type: string;
  url: string;
  name: string;
}

interface Target {
  channel: string;
  thread?: string;
  messageId?: string;
}
```

### Slack Connector

Built on Bolt SDK in socket mode:
- Thread detection: `event.thread_ts` exists -> thread session, else -> channel/DM session
- Reactions: eyes on processing, checkmark on success, X on error
- Attachments: downloaded from Slack URL to `~/.jinn/tmp/`
- Message editing supported (for streaming or corrections)

### Thread Mapping

```
DM to bot             -> source_ref = "slack:dm:<userId>"              -> Main session
Channel root message  -> source_ref = "slack:<channelId>"              -> Channel session
Thread reply          -> source_ref = "slack:<channelId>:<threadTs>"    -> Thread session
```

### Employee Mention Detection

Before routing, scan message text for `@employee-name` patterns. Match against `~/.jinn/org/` employee registry (loaded by gateway, refreshed by file watcher). If matched, spawn session with that employee's persona. If not matched, use default (Jinn).

### Jinn Commands

Connector intercepts `/new` and `/status` before routing to session manager. Handled internally, no engine session needed.

### Future Connectors

Discord, iMessage, etc. implement the same `Connector` interface. The gateway works with `IncomingMessage` everywhere — platform-agnostic.

---

## 6. Cron System

### Job Definition (`~/.jinn/cron/jobs.json`)

```json
[
  {
    "id": "daily-engagement",
    "name": "Daily Engagement Scout",
    "enabled": true,
    "schedule": "0 12 * * *",
    "timezone": "Europe/Sofia",
    "engine": "claude",
    "model": "opus",
    "employee": "engagement-scout",
    "prompt": "Run your daily engagement scan.",
    "delivery": {
      "connector": "slack",
      "channel": "#engagement"
    }
  }
]
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique identifier |
| `name` | yes | Human-readable name |
| `enabled` | yes | Active or paused |
| `schedule` | yes | Cron expression (5-field) |
| `timezone` | no | IANA timezone (default: system) |
| `engine` | no | Override engine (default: global) |
| `model` | no | Override model |
| `employee` | no | Employee persona (null = Jinn) |
| `prompt` | yes | Message sent to engine |
| `delivery` | no | Where to post results |

### Execution

1. node-cron fires at scheduled time
2. Creates a fresh session (never resumed — isolated per run)
3. Spawns engine with employee persona (if set)
4. Engine runs, returns result
5. If delivery configured, posts result to connector channel
6. Logs run to `~/.jinn/cron/runs/<jobId>.jsonl`
7. If error: logs error, posts error with X reaction to delivery channel

### No retry. Hot-reload via file watcher.

The `cron-manager` skill instructs the engine to ask the user about delivery channel if not specified, then write the job to `jobs.json`. The gateway picks it up automatically.

---

## 7. Organization System

### Directory Structure (Created by Jinn on Demand)

```
~/.jinn/org/
  jinn.yaml
  departments/
    marketing/
      department.yaml
      board.json
      employees/
        seo-specialist.yaml
        content-writer.yaml
    development/
      department.yaml
      board.json
      employees/
        ios-dev.yaml
        web-dev.yaml
  comms/
    inbox.json
```

### Employee Persona (`seo-specialist.yaml`)

```yaml
name: seo-specialist
displayName: "Sarah - SEO Specialist"
department: marketing
rank: senior
engine: claude
model: opus
hired: "2026-03-06"
hiredBy: jinn

persona: |
  You are Sarah, the SEO Specialist at Jinn's organization.
  You specialize in keyword research, blog content strategy,
  and App Store Optimization for iOS apps.

  Your projects:
  - Homy (security camera app) - ~/Projects/Homy-Landing/
  - SQLNoir (SQL learning game) - ~/Projects/SQLNoir/

  You report to: jinn
  You can: create tasks on other department boards (senior privilege)

knowledge:
  - org/departments/marketing/employees/seo-specialist/knowledge/
```

### Department (`department.yaml`)

```yaml
name: marketing
displayName: "Marketing Department"
lead: null
created: "2026-03-06"
purpose: "Content creation, SEO, ASO, social media, community engagement"
```

### Board (`board.json`)

```json
[
  {
    "id": "task-001",
    "title": "Write blog post: best security camera apps 2026",
    "assignee": "seo-specialist",
    "status": "in_progress",
    "priority": "high",
    "createdBy": "jinn",
    "createdAt": "2026-03-06T10:00:00Z",
    "updatedAt": "2026-03-06T14:30:00Z",
    "notes": "Focus on privacy angle."
  }
]
```

### Rank System

| Rank | Comms Privileges | Org Privileges |
|------|-----------------|----------------|
| Executive (Jinn) | Talk to anyone, anywhere | Hire/fire, create departments, promote, full org control |
| Manager | Delegate to department, spawn sessions for reports | Review output, reassign tasks within department |
| Senior | Write to other department boards, cross-team requests | Suggest hires, flag issues |
| Employee | Write to own board only, requests go up | Work on assigned tasks |

Enforcement is via persona instructions (honor system). The AI follows rank constraints defined in the persona YAML. Jinn reviews and course-corrects if needed.

### Gateway Awareness

- On startup + file watch: scans `~/.jinn/org/`, builds in-memory map of `employee name -> { persona, engine, model, department }`
- Connector uses this map for `@employee-name` mention routing
- Web UI API reads this for org chart rendering
- All creation/management is done by the management skill — the gateway only reads

---

## 8. Skills System

### Structure

Skills are directories with a SKILL.md file. No runtime, no registration, no loading system. Just files.

```
~/.jinn/skills/
  management/
    SKILL.md
  cron-manager/
    SKILL.md
  skill-creator/
    SKILL.md
  self-heal/
    SKILL.md
  onboarding/
    SKILL.md
```

### Pre-packaged Skills

| Skill | Purpose |
|-------|---------|
| `management` | Hire/fire employees, create departments, promote ranks, delegate tasks, restructure org |
| `cron-manager` | Create/edit/delete cron jobs. Always asks user about delivery if not specified |
| `skill-creator` | Thin wrapper — defers to Claude Code's native skill creation or Codex's native capabilities. Ensures output lands in `~/.jinn/skills/` and follows conventions |
| `self-heal` | Diagnose and fix Jinn issues. Read logs, check config, fix broken state |
| `onboarding` | First-run setup. Detect OpenClaw, analyze and propose migration, scaffold org |

### Discovery

CLAUDE.md and AGENTS.md reference `~/.jinn/skills/` and list available skills. The engine reads the relevant SKILL.md when it needs a capability. Creating new skills = creating a new directory with SKILL.md (via skill-creator or native engine commands).

---

## 9. Initialization Template

### What `jinn setup` Creates

```
~/.jinn/
  CLAUDE.md
  AGENTS.md
  config.yaml
  docs/
    overview.md
    architecture.md
    skills.md
    cron.md
    connectors.md
    org.md
    self-modification.md
  skills/
    management/SKILL.md
    cron-manager/SKILL.md
    skill-creator/SKILL.md
    self-heal/SKILL.md
    onboarding/SKILL.md
  org/
  cron/
    jobs.json          # []
    runs/
  sessions/
    registry.db        # Empty SQLite (schema initialized)
  connectors/
  knowledge/
  tmp/
  logs/
    gateway.log
```

### Default config.yaml

```yaml
gateway:
  port: 7777
  host: "127.0.0.1"

engines:
  default: claude
  claude:
    bin: claude
    model: opus
    effortLevel: medium
  codex:
    bin: codex
    model: gpt-5.4

connectors: {}

logging:
  file: true
  stdout: true
  level: info
```

### Setup Flow

```
$ jinn setup

Jinn Setup

Checking dependencies...
  [check] Node.js v24.13.0
  [check] Claude Code CLI not found
  [check] Codex CLI v1.2.3

Would you like to install Claude Code CLI? (npm install -g @anthropic-ai/claude-code) [Y/n]
> Y
  [check] Claude Code CLI installed

Checking auth...
  [x] Claude Code: not logged in -> Run "claude login"
  [check] Codex: authenticated

Creating ~/.jinn/...
  [check] config.yaml
  [check] CLAUDE.md + AGENTS.md
  [check] skills/ (5 pre-packaged)
  [check] docs/
  [check] SQLite registry initialized

Installing LaunchAgent...
  [check] com.jinn.gateway.plist -> ~/Library/LaunchAgents/

Setup complete! Run "jinn start" to boot the gateway.
Open http://localhost:7777 to get started.
```

---

## 10. Web UI

### Tech

Next.js 15 + Tailwind CSS. Static export bundled with npm package. Served by gateway on same port. Apple-inspired design: clean, minimal, whitespace, system fonts.

### Communication

- REST API (`/api/*`) for reads, writes, mutations
- WebSocket (`/ws`) for live events

### Pages

**Dashboard (`/`)** — At-a-glance overview: gateway status, active sessions, next cron fire, recent activity feed, quick "New Session" button.

**Chat (`/chat`)** — Primary interaction surface. Sidebar with conversation list (Jinn + employees). Full chat interface. Supports `@employee` mentions, `/new`, `/status`. Input box with engine/model indicator. Onboarding flow lives here on first run.

**Sessions (`/sessions`)** — List all sessions with status. Click for detail view with chat history, metadata, follow-up input.

**Organization (`/org`)** — Interactive tree: Jinn -> departments -> employees with rank badges. Click employee for detail panel (persona, tasks, sessions, engine config). Click department for board view (kanban/list of tasks).

**Cron (`/cron`)** — Job list with enable/disable toggle, schedule, status, history. Click for run history and config editing.

**Skills (`/skills`)** — Grid of skill cards. Click for SKILL.md content. "Create Skill" button triggers chat with Jinn.

**Logs (`/logs`)** — Live tail of gateway.log. Filter by level and subsystem.

**Settings (`/settings`)** — Visual config.yaml editor. Save writes to file, gateway hot-reloads.

### API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/status` | Gateway health + stats |
| GET | `/api/sessions` | List sessions |
| GET | `/api/sessions/:id` | Session detail |
| POST | `/api/sessions` | Create new session |
| POST | `/api/sessions/:id/message` | Send follow-up |
| GET | `/api/cron` | List cron jobs |
| GET | `/api/cron/:id/runs` | Run history |
| PUT | `/api/cron/:id` | Update cron job |
| GET | `/api/org` | Full org tree |
| GET | `/api/org/employees/:name` | Employee detail |
| GET | `/api/org/departments/:name/board` | Department board |
| GET | `/api/skills` | List skills |
| GET | `/api/skills/:name` | Skill content |
| GET | `/api/config` | Current config |
| PUT | `/api/config` | Update config |
| GET | `/api/logs` | Recent log entries |

### WebSocket Events

| Event | Payload |
|-------|---------|
| `session:started` | session ID, engine, source |
| `session:completed` | session ID, result preview, duration |
| `session:error` | session ID, error message |
| `cron:fired` | job ID, name |
| `cron:completed` | job ID, status, duration |
| `org:changed` | what changed |
| `config:reloaded` | which subsystem |

---

## 11. CLI Commands

| Command | Action |
|---------|--------|
| `jinn setup` | Check deps, install missing, create `~/.jinn/`, install LaunchAgent |
| `jinn start` | Start gateway in foreground (default) |
| `jinn start --daemon` | Start gateway as background daemon (PID file at `~/.jinn/gateway.pid`) |
| `jinn stop` | Stop the gateway daemon |
| `jinn status` | Show gateway status, active sessions, cron summary |

---

## 12. Error Handling

- Engine process exits non-zero: add X reaction, send error message to connector, log to `~/.jinn/logs/`
- No automatic retry for any session type (including cron)
- No automatic engine fallback
- User decides next action

---

## 13. Onboarding & OpenClaw Migration

### First-Run Flow

1. `jinn setup` installs everything, opens web UI
2. `/chat` page opens with Jinn's welcome message
3. Jinn (via engine) runs interactive onboarding:
   - What projects are you working on?
   - What do you need help with? (predefined options + free text)
   - Which engines/models to use?
4. If `~/.openclaw/` detected: "I found your OpenClaw installation. Want me to analyze it?"
5. Full analysis: skills, cron jobs, knowledge files, memory, config, session history
6. Jinn presents migration proposal with recommended org structure
7. User approves/tweaks what to migrate (skills, cron, knowledge — each opt-in)
8. Jinn scaffolds the org and migrates selected items
9. Transitions to dashboard

---

## 14. Project Structure

```
jinn/                              # Monorepo root
  README.md
  LICENSE (MIT)
  package.json
  pnpm-workspace.yaml
  turbo.json

  packages/
    jimmy/                          # jinn-cli
      package.json
      tsconfig.json
      bin/
        jimmy.ts
      src/
        cli/
          index.ts
          start.ts
          stop.ts
          status.ts
          setup.ts
        gateway/
          server.ts
          lifecycle.ts
          watcher.ts
          api.ts
        sessions/
          manager.ts
          registry.ts
          context.ts
          queue.ts
        engines/
          types.ts
          claude.ts
          codex.ts
        connectors/
          types.ts
          slack/
            index.ts
            threads.ts
            format.ts
          discord/
            index.ts          # Future
          imessage/
            index.ts          # Future
        cron/
          scheduler.ts
          jobs.ts
          runner.ts
        shared/
          config.ts
          logger.ts
          paths.ts
          types.ts
      template/
        config.default.yaml
        CLAUDE.md
        AGENTS.md
        docs/
          overview.md
          architecture.md
          skills.md
          cron.md
          connectors.md
          org.md
          self-modification.md
        skills/
          management/SKILL.md
          cron-manager/SKILL.md
          skill-creator/SKILL.md
          self-heal/SKILL.md
          onboarding/SKILL.md

    web/                            # @jinn/web
      package.json
      next.config.ts
      tailwind.config.ts
      tsconfig.json
      src/
        app/
          layout.tsx
          page.tsx                  # Dashboard
          chat/page.tsx
          sessions/page.tsx
          org/page.tsx
          cron/page.tsx
          skills/page.tsx
          logs/page.tsx
          settings/page.tsx
        components/
          ui/
          sessions/
          org/
          cron/
          chat/
        lib/
          api.ts
          ws.ts
        hooks/
          use-gateway.ts

  .github/
    workflows/
      ci.yml
      release.yml
    CONTRIBUTING.md
```

---

## 15. Key Technical Notes

### CLAUDECODE Environment Variable

When spawning Claude Code as a child process, unset the `CLAUDECODE` env var to prevent false "nested session" detection:

```typescript
const proc = spawn("claude", args, {
  cwd: jinnDir,
  env: { ...process.env, CLAUDECODE: undefined },
});
```

### Multi-User in Shared Channels

Channel sessions are shared — all users in a channel talk to the same session. The engine sees all users' messages in one conversation.

### Attachments

Slack file attachments are downloaded to `~/.jinn/tmp/` and included as file paths in the prompt. Claude Code reads files/images natively.

### Hot-Reload

The gateway watches `~/.jinn/` for changes:
- `config.yaml` -> reload config
- `cron/jobs.json` -> reload cron scheduler
- `org/` -> rebuild employee registry for mention routing

### Logging

Logs to both file (`~/.jinn/logs/gateway.log`) and stdout when running in foreground.
