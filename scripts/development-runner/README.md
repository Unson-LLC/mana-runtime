# Isolated Slack development runner

`/develop` does not run Claude inside the gateway process. The gateway invokes
this runner as a separate Unix user through a fixed `sudoers` command. Requests
arrive as one JSON object on stdin; stdout is one bounded result object. Command
logs stay on stderr and are never relayed to Slack.

## Server layout

- Runtime user/check-out: `ryoko` / `/home/ryoko/src/OpenRyoko` (read-only pilot runtime)
- Development user: `ryoko-dev`
- Canonical development clone: `/srv/openryoko-development/repository`
- Per-Story worktrees: `/srv/openryoko-development/worktrees/`
- Root-owned config: `/etc/openryoko-development-runner.json` (`0644`)
- Installed runner: `/usr/local/libexec/openryoko-development-runner` (`0755`, root-owned)
- Durable single-flight lock: `/home/ryoko-dev/.openryoko-development-runner.lock`

The root-owned config pins `runnerVersion`. The installed script fails closed
before creating a worktree when its embedded version differs, so rollout must
update the script and config together and verify the expected version.

The development user's GitHub credential must be scoped to
`Unson-LLC/brainbase-mana`. Its Claude Code login is the Max account used by the
pilot. Do not copy Slack tokens or gateway config into this account.

## Gateway config (disabled by default)

```yaml
developmentRunner:
  enabled: false
  bin: /usr/bin/sudo
  args:
    - -n
    - -H
    - -u
    - ryoko-dev
    - /usr/local/libexec/openryoko-development-runner
  timeoutMs: 5400000
  allowedSlackChannels:
    - C0A2L9FEKEJ # mana テスト
```

The only required sudoers rule is:

```text
ryoko ALL=(ryoko-dev) NOPASSWD: /usr/local/libexec/openryoko-development-runner
```

Use `origin/main` as `baseRef` after the current pilot branch has merged. Until
then, set the explicit reviewed pilot branch in the root-owned config so the
development worktree contains the code that is actually running.

`allowedSlackChannels` is a required fail-closed boundary for both the native
command and the internal compatibility route. An absent or empty list permits
no development command.

Validate with a docs-only request while `enabled: false`, then enable, restart
the gateway, submit one `/vibepro` request from an allowlisted Slack user in
an allowed channel, and
confirm that the runtime checkout remains clean and unchanged. VibePro stops at
`pr_ready`; PR creation, merge, and deployment remain human actions.

The development engine is a Claude Code session spawned in the isolated
worktree. The agent follows the VibePro workflow itself (Story -> Spec ->
implementation -> verification evidence -> `vibepro pr prepare`), while the
runner keeps the safety boundary: after the agent exits, readiness is
re-derived deterministically from `vibepro pr ship --dry-run` output, and only
a `vibepro pr create` next command maps to `pr_ready`. The agent's own claims
are never trusted for the Slack result. Agent credentials (for example
`ANTHROPIC_API_KEY`) load from the optional root-configured `agentEnvFile`
(recommended: `/home/ryoko-dev/.config/openryoko/agent-environment`, `0600`,
owned by `ryoko-dev`). An agent error or timeout fails closed as
`needs_input`; the partially completed worktree stays available for review.

## Human-in-the-Loop question/answer round-trip

When a `/vibepro` request has ambiguity that is expensive to guess, the agent
may stop without implementing anything and instead run
`vibepro story diagnose . --id <storyId> --phase design-input`, then write up
to 5 questions to `.openryoko/questions.json` in the worktree:

```json
{
  "questions": [
    {
      "id": "auth_strategy",
      "question": "認証方式はどちらにしますか？",
      "options": [
        { "label": "OAuth", "description": "既存IdPを使う", "recommended": true },
        { "label": "独自実装" }
      ],
      "allow_free_text": true
    }
  ]
}
```

The runner validates this document itself (fail-closed on any shape mismatch —
a malformed file becomes `needs_input`, never a silently-ignored guess) and,
when it validates, emits `{status: "needs_decision", storyId, questions,
summary}` instead of running `vibepro pr ship --dry-run`. `.openryoko/` is
gitignored in the worktree so this scratch file never becomes part of the
Story's commits.

The gateway renders `needs_decision` as a Slack Block Kit question card with a
button that opens an answer modal (see `packages/jimmy/src/connectors/slack/vibepro-decision.ts`).
Submitting the modal resumes the same Story exactly once: the gateway sends
`{"storyId": "...", "answers": [{"id": "...", "answer": "..."}]}` over stdin
instead of `{"request": "..."}`. The runner appends a `## Human answers`
section to the Story doc, commits it, deletes `.openryoko/questions.json`, and
re-runs the agent with a resume prompt that explicitly forbids asking again
(the 1-round-trip rule) before falling through to the same `pr ship --dry-run`
readiness check. A Story resume requires its worktree to still exist under
`worktreesRoot`; a missing worktree fails closed as `failed`, not as a fresh
Story.

## needs_input gate results and the Gate-resolution continue round

When `vibepro pr ship --dry-run` finds unresolved gates (no `pr create` next
command), the runner no longer returns a single truncated English sentence.
It parses the `pr ship` report into a structured `gates` array —
`[{severity: "critical" | "evidence", text}, ...]`, bounded to 30 entries of
at most 500 characters each (`critical_gate` lines map to `"critical"`,
`waiver_or_evidence` lines to `"evidence"`) — and attaches it to the
`needs_input` result alongside `commits: {count, subjects}`: commits made in
the Story worktree since the run's baseline HEAD, with `subjects` holding up
to 5 newest-first commit messages (the runner's own `chore: record ...`
bookkeeping commits are counted but excluded from `subjects`). `commits` is
also attached to `pr_ready` results for the same "what actually happened"
visibility. Both fields are validated fail-closed by the gateway
(`packages/jimmy/src/sessions/development-runner.ts`) with the same bounds.

The gateway renders this as a "成果報告＋次の一手" Block Kit card (see
`packages/jimmy/src/connectors/slack/vibepro-gate-result.ts`) instead of the
old plain-text dump: what was accomplished (commit count + subjects, when
non-zero), the remaining gates grouped by severity with a bounded preview and
a "📄 全Gate詳細" button for the full list, and a "🔁 続行してGateを解消させる"
button. A `needs_input` result with no `gates` (for example an agent crash
before `pr ship` ever ran) falls back to a short plain-text notice —
needs_input is a dead end in that case, same as before this change.

Pressing "続行してGateを解消させる" sends a third stdin shape,
`{"storyId": "...", "continueGates": true}`, mutually exclusive with both
`{"request": "..."}` and the `answers` resume shape. The runner reuses the
existing worktree (same existence/containment check as the answers resume
path) and re-runs the agent with a prompt that tells it to run
`vibepro pr ship --dry-run` itself, read the remaining gates, and resolve them
through evidence recording, review dispatch, or scope trims — gates that
genuinely need a human waiver decision may be left unresolved. No Story-doc
change is made before this run (unlike the answers resume path, there is no
human answer to record), and the run then falls through to the same
`pr ship --dry-run` readiness check as every other path — it may again land
on `needs_input` with a shorter gate list, or reach `pr_ready`.

The gateway also keeps an in-process busy flag, but the development user's
lock directory is the authoritative cross-restart guard. The runner removes it
only after its VibePro child has closed. If the host or runner is killed
uncleanly, the lock fails closed, and the next runner start reclaims it
automatically only when staleness is provable. All of the following must hold:

- the lock's `owner` file exists and parses to a positive pid;
- that pid is definitively dead (`ESRCH`; `EPERM` counts as alive);
- no other live process runs as the development user (a `/proc` scan), so a
  dead runner whose detached agent/VibePro children survived is never
  reclaimed over.

Any uncertainty — unreadable owner file, live or permission-denied pid,
surviving development-user process, `/proc` unavailable — keeps the lock and
the request fails closed with the reason on stderr. Removal itself is raced
safely: the directory is claimed with an atomic rename and re-assessed in
quarantine, so a fresh lock created concurrently is renamed back untouched
instead of being deleted. Pid reuse degrades in the safe direction: a recycled
owner pid looks alive, the lock stays, and the operator falls back to the
manual procedure — verify that no runner or VibePro process remains, then
remove only the exact lock path before retrying.

## Surviving gateway restarts

`systemctl restart openryoko` kills the whole service cgroup. Because the
gateway starts the runner through sudo inside its own cgroup, a restart
mid-run kills the runner and strands the fail-closed lock (observed
2026-07-31). Three defenses, layered:

1. **Deploy-time guard (required).** Before any gateway restart, run the
   preflight on the pilot host:

   ```bash
   sudo ./guard-restart.sh --wait 5400
   ```

   It exits 0 only when no development run is active (no lock, or a provably
   stale lock that the runner will reclaim). While a run is active it waits up
   to `--wait` seconds, then exits 1 — do not restart in that case.

2. **Cgroup escape (recommended, config-only).** Start the runner in its own
   transient scope so gateway restarts cannot touch it. No gateway code
   change; swap the gateway config invocation:

   ```yaml
   developmentRunner:
     bin: /usr/bin/sudo
     args:
       - -n
       - /usr/bin/systemd-run
       - --quiet
       - --collect
       - --scope
       - --uid=ryoko-dev
       - --gid=ryoko-dev
       - --setenv=HOME=/home/ryoko-dev
       - /usr/local/libexec/openryoko-development-runner
     resultsSpoolDir: /srv/openryoko-development/results
   ```

   with the matching exact sudoers rule (replacing the old `(ryoko-dev)`
   rule) shipped as `scripts/systemd/openryoko-development-scope.sudoers` —
   deploy it to `/etc/sudoers.d/openryoko-development-scope` (`0440`,
   `root:root`) and validate with `visudo -cf`:

   ```text
   ryoko ALL=(root) NOPASSWD: /usr/bin/systemd-run --quiet --collect --scope --uid=ryoko-dev --gid=ryoko-dev --setenv=HOME=/home/ryoko-dev /usr/local/libexec/openryoko-development-runner
   ```

   This command line is intentionally 100% static — it does not pass
   `--unit=...`. `systemd-run` auto-generates a unique transient unit name
   when `--unit` is omitted, so there is no per-invocation variable that
   would force either a wildcard sudoers rule (letting the gateway's `ryoko`
   user run `systemd-run` with attacker-influenced arguments) or a
   root-owned wrapper binary — sudo's exact-string match on the full argv is
   safe as-is. Only introduce a wrapper script if the invocation ever needs
   a genuinely per-run argument (e.g. embedding the Story id into `--unit=`
   for operator observability); do not silently switch to a `*` wildcard to
   work around that need. See the comment header in the `.sudoers` file for
   the full rationale.

   `--scope` keeps stdin/stdout attached (the JSON contract is unchanged) and
   keeps the runner in the gateway child's process group, so the gateway's own
   timeout kill (`process.kill(-pid)`) still works; only the systemd cgroup
   membership changes. `--setenv=HOME=` is required because systemd-run does
   not switch HOME with `--uid`. Validate on the host with a docs-only request
   while `enabled: false` first — `--uid` with `--scope` needs a reasonably
   recent systemd.

   With this escape, a gateway restart no longer aborts an in-flight run —
   but until `resultsSpoolDir` is configured (see below), the gateway that
   spawned it is gone when it finishes, so the Slack result would still be
   lost. Configure the result spool together with the cgroup escape, not
   instead of it.

3. **Result spool + reconciler (required for the escape to actually deliver
   a result).** With `resultsSpoolDir` set on both the runner's root-owned
   config (`/etc/openryoko-development-runner.json`) and the gateway's
   `developmentRunner.resultsSpoolDir` (same absolute path, e.g.
   `/srv/openryoko-development/results`, writable by `ryoko-dev`, readable
   by the gateway's `ryoko` user), every result the runner emits is also
   written to `<resultsSpoolDir>/<storyId>.json`. The gateway records a
   pending-run marker before starting the runner
   (`~/.ryoko/state/development-pending.json`) and, at startup and every 60s
   thereafter, reconciles: any pending run whose spool file has appeared
   gets its result delivered to Slack (the same `needs_decision`/
   `needs_input`/`pr_ready` cards pipe delivery uses) and its pending record
   removed; a pending run with no spool file and no live in-process owner,
   older than the configured runner timeout plus a 10-minute grace period,
   gets a plain "run was interrupted, the worktree is preserved, retry with
   `/vibepro`" notice instead of silence forever. See
   `packages/jimmy/src/sessions/development-pending.ts` and
   `development-reconciler.ts`. `resultsSpoolDir` is optional on both sides
   — omitting it disables spooling/reconciliation entirely (back-compat with
   deployments that only use defense 1).

## Release and rollback

### Release note

The runner version advances to `2026-07-31.5`. Every emitted result is now
also written to `resultsSpoolDir/<storyId>.json` (optional root-owned config
field; spooling is skipped entirely when unset), stamped with a spool-only
`finishedAt`/`runnerPid` (never part of the stdout contract). Spool writes
are atomic (`.tmp` + rename) and fail-silent — a spool write failure can
never fail or alter the development run itself. At startup the runner also
deletes spool files older than 7 days. This is the runner half of the
"Surviving gateway restarts" defense above; the gateway half
(`developmentRunner.resultsSpoolDir` + the pending-run reconciler) is
unversioned gateway code and does not require a `runnerVersion` bump on its
own, but both sides must agree on the same absolute spool directory path to
be useful together. The stdin/stdout result contract is otherwise unchanged.

The previous version `2026-07-31.4` added structured gate results.
`needs_input` results caused by unresolved VibePro gates carry a structured `gates` array
(`{severity, text}`, bounded to 30 entries of 500 chars) instead of a single
truncated sentence, and `needs_input`/`pr_ready` results carry a `commits`
object (`{count, subjects}`, up to 5 newest-first non-bookkeeping subjects) so
Slack can show what was actually accomplished. A new stdin shape
`{"storyId", "continueGates": true}` continues a Story that stopped at
`needs_input` by re-running the agent in the same worktree with an
instruction to resolve the remaining gates itself, then falling through to
the same `pr ship --dry-run` readiness check — see the "needs_input gate
results and the Gate-resolution continue round" section above. The gateway
renders the new fields as a Block Kit "成果報告＋次の一手" card with
continue/details buttons instead of the old plain-text dump. Both new fields
are optional and validated fail-closed by the gateway; the existing
`{"request"}` and `{"storyId", "answers"}` stdin shapes and result fields are
unchanged.

The previous version `2026-07-31.3` added progress reporting. While the agent
session runs, the runner writes `PROGRESS <json>` lines directly to its own
stderr every 60 seconds — `{"phase":"agent","elapsedSec":N,"commits":N,"latest":"..."}`
(the `latest` commit subject is only present once there is at least one
commit) — plus a single `{"phase":"gate","elapsedSec":N,"commits":N}` line
when `vibepro pr ship --dry-run` starts. The gateway parses these to refresh
the Slack "typing" status with real elapsed time / commit count / latest
commit subject instead of a static "開発中…" string; unparseable lines are
ignored and progress reporting never affects the run itself (git failures
fail silent). The stdin/stdout result contract is unchanged; only
`runnerVersion` must advance in lockstep.

The previous version `2026-07-31.2` added automatic stale-lock
reclamation at startup (see the lock section above): a lock whose owner pid is
provably dead and whose development user has no surviving processes is removed
and re-acquired instead of failing the request. All uncertain cases keep the
previous fail-closed behavior. The stdin/stdout contract and config shape are
unchanged; only `runnerVersion` must advance in lockstep.

The previous version `2026-07-31.1` added the Human-in-the-Loop
question/answer round-trip described above: a new `needs_decision` result
status, the `.openryoko/questions.json` contract, and a resume stdin shape
(`{"storyId", "answers"}`) alongside the existing `{"request"}` shape. The
config and Slack result contract are otherwise unchanged from `2026-07-30.1`,
which replaced the headless `vibepro execute run` engine (Codex-first provider
chain) with a Claude Code agent session that drives the VibePro CLI directly.

### Rollout plan and operator action

This change requires an operator rollout after merge; merging the PR does not
update the pilot host. Deploy the merged `run.mjs` to the root-owned installed
runner and update `runnerVersion` in the root-owned config to the same embedded
version. Run `sudo ./guard-restart.sh --wait 5400` and proceed only when it
exits 0, then restart `openryoko` and verify all of the following before
sending a Slack development request:

- `systemctl is-active openryoko` reports `active`;
- the installed runner reports the expected `RUNNER_VERSION`;
- the installed runner SHA-256 digest matches the merged source;
- the runtime checkout points at the expected merged Git commit and remains
  clean.

### Observability evidence

For the pilot smoke test, submit one bounded `/vibepro` request in the
allowlisted channel and follow the session until `pr_ready` or a fail-closed
terminal result. Capture the worktree git log, the `vibepro pr ship --dry-run`
output, and the systemd journal alongside the final runner result; do not infer
success only from an acknowledged Slack message or from the agent's own
summary.

### Rollback instruction

To roll back, restore the previously installed root-owned runner and its
matching `runnerVersion` config as one unit, restart `openryoko`, and repeat the
service/version/digest/commit checks above. If a development run is active,
stop accepting new requests and let it reach a terminal state before replacing
the runner. Never remove the durable lock merely to force a rollout; first
confirm that no runner or VibePro process remains.
