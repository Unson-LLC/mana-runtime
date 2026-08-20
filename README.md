# Mana Runtime

Mana Runtime is the execution layer for Mana, an operating agent that understands organizational context, makes bounded decisions, executes authorized work, and follows work through to completion.

The canonical runtime is Cloudflare-native. The retired Jimmy/OpenRyoko + Lightsail runtime is not part of the active architecture.

## Canonical architecture

```text
Slack / scheduled event / system event
                ↓
        Cloudflare Worker
                ↓
        Queue + Durable Objects
                ↓
     Cloudflare Computer / Sandbox
                ↓
            Claude Code
                ↓
   Brainbase memory + control plane
                ↓
       action / Slack response
```

The runtime is deployed per organization. Slack applications, Worker resources, Queue/DLQ, Durable Objects, sandbox/container state, and provider credential boundaries are isolated by deployment.

Brainbase and Mana have different responsibilities:

- **Brainbase** owns memory, organizational state, ontology, provenance, permissions, and the Memory Loop.
- **Mana** owns interpretation, prioritization, judgment, action, reminders, follow-through, and the Operating Loop.
- **Codex / Claude Code and other execution engines** are workers Mana can invoke; they are not the system of record.

See [`docs/architecture/mana-operating-loop-product-boundary.md`](docs/architecture/mana-operating-loop-product-boundary.md).

## Repository layout

- `packages/cloud-runtime/` — canonical Cloudflare Worker / Queue / Durable Object / Computer runtime.
- `packages/task-runtime-core/` — shared task-runtime primitives.
- `packages/slack-thread-context/` — Slack thread context utilities.
- `packages/write-broker/` — bounded write broker primitives.
- `packages/web/` — Mana web surfaces.
- `docs/` — architecture, contracts, stories, operations, and product decisions.

There is intentionally no `packages/jimmy` or OpenRyoko runtime. Historical implementation details belong in Git history, not in the active source tree.

## Development

Requires Node.js 22+ and pnpm 9.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Cloud runtime commands:

```bash
pnpm --filter @mana-runtime/cloud-runtime test
pnpm --filter @mana-runtime/cloud-runtime typecheck
pnpm --filter @mana-runtime/cloud-runtime build
pnpm --filter @mana-runtime/cloud-runtime build:unson-business
```

`build` uses Wrangler dry-run profiles; deployment is explicit and profile-specific.

## Deployment boundary

Do not share tenant credentials or runtime state across organizations. Provider credentials must not be materialized in the Worker or sandbox. Brainbase's trusted credential/forwarding boundary remains authoritative.

Current deployment and rollout details live under `packages/cloud-runtime/README.md` and `docs/operations/`.

## Historical note

Mana was initially operated using a Jimmy/OpenRyoko-derived runtime on Lightsail. That architecture has been retired after the Cloudflare Computer migration. Git history preserves the old implementation; the active repository no longer treats it as a supported runtime.
