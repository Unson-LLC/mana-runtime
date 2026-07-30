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

The gateway also keeps an in-process busy flag, but the development user's
lock directory is the authoritative cross-restart guard. The runner removes it
only after its VibePro child has closed. If the host or runner is killed
uncleanly, the lock intentionally fails closed. An operator must first verify
that no runner or VibePro process remains, then remove only the exact lock path
before retrying.

## Release and rollback

### Release note

The runner version advances to `2026-07-31.1`. It adds the Human-in-the-Loop
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
version. Restart `openryoko`, then verify all of the following before sending a
Slack development request:

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
