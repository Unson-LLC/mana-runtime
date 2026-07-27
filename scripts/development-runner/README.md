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
