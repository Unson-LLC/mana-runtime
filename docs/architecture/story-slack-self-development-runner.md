# Slack self-development runner architecture

## Boundary

```text
Slack allowlisted user
  -> Slack native /ryoko-develop command (Socket Mode)
  -> OpenRyoko internal /develop command (ryoko, read-only runtime)
  -> root-owned fixed sudo wrapper
  -> VibePro runner (ryoko-dev, one repository, one worktree per Story)
  -> machine-readable result
  -> Slack thread
```

The gateway never executes a shell assembled from Slack text. It starts one absolute executable with fixed arguments and supplies the request through stdin. The child receives a minimal environment, so connector and Claude credentials held by the gateway are not inherited.

The development runner owns GitHub and Claude credentials scoped to its Unix account. It may change only its development clone and worktrees. The runtime checkout remains detached and is updated only by the existing reviewed deployment path.

`/ryoko-develop` is registered as a Slack-native command and received through
the existing Socket Mode connection, so no public HTTP endpoint is required.
The connector acknowledges Slack immediately, checks `allowFrom` and the
fail-closed `developmentRunner.allowedSlackChannels`, and converts
the payload to the internal `/develop` command. `/develop` remains recognized
only inside the gateway for the Slack connector. The gateway's in-memory
busy flag provides immediate feedback; the runner's atomic lock directory under
`/home/ryoko-dev` is the authoritative cross-restart single-flight boundary.

## Failure behavior

- Disabled or missing configuration: fail closed before process creation.
- Concurrent request: reject instead of queueing an invisible second job; the durable runner lock also rejects after a gateway restart.
- Timeout: terminate the whole process group, wait for child close, and escalate to `SIGKILL` after the grace period before releasing the gateway flag.
- Non-zero exit, oversized output, invalid JSON, unknown field, or foreign PR URL: return a generic failure to Slack and keep stderr out of Slack.
- Unclean host/runner termination: the lock remains fail-closed. An operator verifies that no runner/VibePro process remains and removes only the documented lock path. Durable resume is a later Story using VibePro Run state.

## Deployment stages

1. Merge code with `developmentRunner.enabled=false`.
2. Provision `ryoko-dev`, the fixed wrapper, repository-scoped GitHub access, and VibePro.
3. Run a local fixture runner and confirm Slack receives only the schema-approved result.
4. Add Umeda to Slack `allowFrom` after the negative tests pass.
5. Run a docs-only Story and stop before PR creation for the first observed handoff.
