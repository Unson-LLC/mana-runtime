# Mana autonomy 24h service entry

## Status

This runbook prepares the bounded `mana-autonomy-24h-v0` experiment. It does not authorize production activation by itself.

The experiment remains inactive unless all of the following are present and valid:

- `MANA_AUTONOMY_EXPERIMENT_JSON`
- `MANA_AUTONOMY_KILL_SWITCH=inactive`
- canonical Brainbase `provider=service` identity for `mana_autonomy_v0`
- canonical Company Authority for one project and one capability
- a matching runtime placement and Task Write policy
- authoritative Workspace Connection and Tenant Context signature readback

## Required canonical scope

Do not copy identifiers from this document into production. Read them back from the current Brainbase tenant and the deployed Unson Business profile first.

The reviewed scope must bind exactly:

- one tenant
- one organization
- one canonical project ID and project code
- actor `mana_autonomy_v0`
- placement `mana-autonomy`
- Company Authority capability `task.create`
- service registry capability `create_task`
- one Unson Business workspace/app pair
- one synthetic delivery channel used only as an operation scope

`brainbase-deployment` and `brainbase` are not interchangeable. A project code found in a design document is not production authority.

## Release order

1. Read back tenant, organization, project, workspace connection, service actor and capability registry.
2. Generate a `service-company-authority.v1` manifest from those readbacks.
3. Run Brainbase service-authority `--check`.
4. Run Brainbase service-authority `--dry-run`; retain snapshot-before, mutation plan and snapshot-after.
5. Apply only the reviewed manifest, then repeat readback.
6. Deploy the Worker code with the experiment JSON absent and the kill switch active.
7. Verify that the existing scheduled handler still runs and the autonomy outcome is `inactive`.
8. Add the reviewed placement and Task Write policy while keeping the kill switch active.
9. Add an experiment contract whose `enabled` value remains false; verify `disabled` and zero task writes.
10. Set `enabled=true` while keeping the kill switch active; verify `disabled` and zero task writes.
11. Inject failures for Brainbase unavailable, stale connection revision, invalid signature, missing Company Authority, expired capability, concurrent Run and task-write denial.
12. Only after all readbacks pass, set the external kill switch to `inactive` for the approved experiment window.

## Zero-write rehearsal acceptance

A rehearsal is successful only when all conditions hold:

- the existing scheduled work completes normally
- autonomy emits `inactive` or `disabled`, never `ran`
- Run history contains no successful task evidence
- Task Write Budget has zero completed writes for the experiment
- no provider request or Slack delivery is observed
- no raw secret, exception message, prompt or model output is persisted
- replaying the same scheduled wake creates no additional effect

HTTP success or a successful Worker deployment is not sufficient evidence.

## Rollback

Rollback is ordered from authority to code:

1. Set the external kill switch active.
2. Remove `MANA_AUTONOMY_EXPERIMENT_JSON` or set `enabled=false`.
3. Confirm subsequent scheduled wakes return `inactive` or `disabled` with zero new writes.
4. Revoke or supersede the Company Authority binding.
5. Suspend the service external identity or service actor if the experiment is abandoned.
6. Roll back the Worker version only after the authority path is closed.

Never recover by impersonating a Slack user, bypassing Brainbase Tenant Context verification, broadening the project set, or disabling the Task Write budget.
