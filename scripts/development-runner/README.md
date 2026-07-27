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
the gateway, submit one `/ryoko-develop` request from an allowlisted Slack user in
an allowed channel, and
confirm that the runtime checkout remains clean and unchanged. VibePro stops at
`pr_ready`; PR creation, merge, and deployment remain human actions.

When VibePro stops with the exact `blocked/no_progress` recovery shape, the
runner validates that the referenced Story, run ID, and real managed-worktree
path belong to the current isolated Story. It then reconstructs a fixed argv
and resumes at most once within the original wall-clock budget. The recovery
string is never executed through a shell. Any mismatch, second `no_progress`,
timeout, or other stop reason fails closed as `needs_input` or `failed`.

The gateway also keeps an in-process busy flag, but the development user's
lock directory is the authoritative cross-restart guard. The runner removes it
only after its VibePro child has closed. If the host or runner is killed
uncleanly, the lock intentionally fails closed. An operator must first verify
that no runner or VibePro process remains, then remove only the exact lock path
before retrying.

## Release and rollback

### Release note

The runner version advances to `2026-07-27.1`. It adds one bounded automatic
resume for the exact `blocked/no_progress` recovery result and otherwise keeps
the existing fail-closed Slack result contract.

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

For the pilot smoke test, submit one bounded `/ryoko-develop` request in the
allowlisted channel and follow the session until `pr_ready` or a fail-closed
terminal result. Capture the VibePro run state and systemd journal alongside
the final runner result; do not infer success only from an acknowledged Slack
message. For the exact first `blocked/no_progress` recovery path, verify one
subsequent `vibepro execute resume` invocation in that evidence and no more than
one. A second `no_progress`, invalid recovery metadata, or exhausted budget
must end as `needs_input` without another resume invocation.

### Rollback instruction

To roll back, restore the previously installed root-owned runner and its
matching `runnerVersion` config as one unit, restart `openryoko`, and repeat the
service/version/digest/commit checks above. If a development run is active,
stop accepting new requests and let it reach a terminal state before replacing
the runner. Never remove the durable lock merely to force a rollout; first
confirm that no runner or VibePro process remains.
