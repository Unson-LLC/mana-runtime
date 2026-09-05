import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

describe("tenant Slack runtime wiring", () => {
  it("fails closed on a missing destination authority before all three selection effects", () => {
    const resolverStart = source.indexOf("function createTenantInteractionEffectResolver(");
    const resolver = source.slice(resolverStart, source.indexOf("function tenantInteractionEvent(", resolverStart));
    const queueStart = source.indexOf("const destinationAuthorization = command.kind === \"meeting_minutes_selection\"");
    const queueIngress = source.slice(queueStart, source.indexOf("}, async (identity, destination)", queueStart));
    const consumerStart = source.indexOf("function expectedTenantMeetingMinutesSelectionScope(");
    const consumer = source.slice(consumerStart, source.indexOf("function expectedTenantMeetingMinutesRedoScope(", consumerStart));

    expect(resolverStart).toBeGreaterThan(-1);
    expect(resolver).toContain("destinationAuthorizationForSelection(env, destination)");
    expect(resolver.indexOf("destinationAuthorizationForSelection(env, destination)"))
      .toBeLessThan(resolver.indexOf("const sourceResolved = await resolve("));
    expect(queueStart).toBeGreaterThan(-1);
    expect(queueIngress).toContain("destinationAuthorizationForSelection(env, destination)");
    expect(queueIngress.indexOf("destinationAuthorizationForSelection(env, destination)"))
      .toBeLessThan(queueIngress.indexOf("env.TECHKNIGHT_EVENTS.send("));
    expect(consumerStart).toBeGreaterThan(-1);
    expect(consumer).toContain('destinationAuthorizationForSelection(env, destination, "queue_consumer")');
    expect(consumer.indexOf('destinationAuthorizationForSelection(env, destination, "queue_consumer")'))
      .toBeLessThan(consumer.indexOf("resolveMeetingMinutesDestinationProjectScope("));
    expect(source).not.toContain("if (projectId === undefined) return undefined");
  });

  it("re-authorizes redo task deletion for the persisted configured destination", () => {
    const start = source.indexOf("async function processTenantMeetingMinutesRedo(");
    expect(start).toBeGreaterThan(-1);
    const redo = source.slice(start, source.indexOf("\nexport default", start + 1));
    expect(redo).toContain("loadMeetingMinutesRun(workspace.fs, command.runId)");
    expect(redo).toContain("candidate.id === run?.destination?.id");
    expect(redo).toContain("destination.contextProjectCode !== run?.destination?.contextProjectCode");
    expect(redo).toContain("resolveDerivedSlackTenantContext(env, tenantContext");
    expect(redo).toContain("}, { destination }, () => tenantConfiguredDesiredEffectByCapability(env))");
    expect(redo).toContain("resolveMeetingMinutesDestinationProjectScope(");
    expect(redo).toContain("tenant_context: taskContext");
    expect(redo).toContain("expected_scope: taskScope");
    expect(redo).toContain("boundary: taskEffects.boundary");
    expect(redo).not.toContain("BRAINBASE_TASK_API_TOKEN");
    const derivedStart = source.indexOf("async function resolveDerivedSlackTenantContext(");
    const derived = source.slice(derivedStart, source.indexOf("async function ", derivedStart + 1));
    expect(derived).toContain("destinationAuthorizationForSelection(env, options.destination)");
    expect(derived).toContain("destinationAuthorization?.trusted_project_ids");
    expect(derived).toContain('if (options.destination && !destinationAuthorization) deny("worker_ingress", "PROJECT_SCOPE_MISMATCH")');
    expect(derived).toContain("typeof desiredEffectByCapability === \"function\"");
    expect(derived.indexOf("destinationAuthorizationForSelection(env, options.destination)"))
      .toBeLessThan(derived.indexOf("const resolvedDesiredEffectByCapability"));
    expect(derived.indexOf("const resolvedDesiredEffectByCapability"))
      .toBeLessThan(derived.indexOf("tenantRuntimeClients(env, undefined, resolvedDesiredEffectByCapability)"));
  });

  it("resolves signed events and commands through the canonical tenant authority", () => {
    const commandStart = source.indexOf('url.pathname === "/slack/commands"');
    const eventStart = source.indexOf('url.pathname !== "/slack/events"', commandStart);
    const queueStart = source.indexOf("async queue(", eventStart);
    const ingress = source.slice(commandStart, queueStart);
    const parseAt = ingress.indexOf("parseCompanyAuthorityRuntimeConfiguration(env)");
    const configureAt = ingress.indexOf("companyAuthorityIngressConfiguration(");
    const handlerAt = ingress.indexOf("handleTenantSlackRequest(request");
    const envStart = source.indexOf("interface Env");
    const eventQueueStart = source.indexOf("TECHKNIGHT_EVENTS:", envStart);
    const nextBindingStart = source.indexOf("TASK_BOARD_REPAIRS:", eventQueueStart);
    const eventQueueBinding = source.slice(eventQueueStart, nextBindingStart);

    expect(commandStart).toBeGreaterThan(-1);
    expect(ingress).toContain("resolveSlackWorkerIngress({");
    expect(ingress).toContain("handleTenantSlackRequest(request");
    expect(parseAt).toBeGreaterThan(-1);
    expect(configureAt).toBeGreaterThan(-1);
    expect(parseAt).toBeLessThan(configureAt);
    expect(handlerAt).toBeGreaterThan(configureAt);
    expect(ingress).toContain("company_authority:");
    expect(ingress).toContain("const desiredEffectByCapability = runtimeConfiguration.state === \"enabled\"");
    expect(ingress).toContain("tenantRuntimeClients(env, undefined, desiredEffectByCapability)");
    expect(ingress).toContain("tenantConfiguredDesiredEffectByCapability(env)");
    expect(ingress).toContain("env.TECHKNIGHT_EVENTS.send(event)");
    expect(eventQueueBinding).toContain("| CompanyAuthorityRuntimeEnvelope<SlackQueueEvent>");
    expect(ingress).toContain('schema_version: "1.0"');
    expect(ingress).not.toContain("tenantId: env.TENANT_ID");
    expect(ingress).not.toContain("handleSlackRequest(request");
  });

  it("keeps pre-handler Slack ingress failures diagnosable without exposing raw errors", () => {
    const eventStart = source.indexOf('url.pathname !== "/slack/events"');
    const queueStart = source.indexOf("async queue(", eventStart);
    const ingress = source.slice(eventStart, queueStart);

    expect(ingress).toContain('event: "slack_tenant_ingress_failed"');
    expect(ingress).toContain('const stage = "runtime_configuration"');
    expect(ingress).toContain('"x-mana-error-code": code');
    expect(ingress).toContain('"x-mana-failure-stage": stage');
    expect(ingress).toContain('"x-mana-correlation-id": correlationId');
    expect(ingress).not.toContain("error.message");
    expect(ingress).not.toContain("error.stack");
  });

  it("validates canonical Queue envelopes before dispatching the legacy Slack payload", () => {
    const queueStart = source.indexOf("async queue(");
    const queue = source.slice(queueStart);

    expect(queue).toContain("ackMalformedTenantQueueMessage");
    expect(queue).toContain("consumeTenantQueueMessage");
    expect(queue).toContain("TenantRuntimeBoundaryVerifier");
    expect(queue).toContain("createDurableTenantStateClient");
    expect(queue).toContain("expectedTenantQueueScope(env, body)");
    expect(queue).toContain('code: "FALLBACK_FORBIDDEN"');
  });

  it("connects company-authority envelopes to the verified Queue consumer without legacy fallback", () => {
    const queueStart = source.indexOf("async queue(");
    const queue = source.slice(queueStart);
    const candidateAt = queue.indexOf("isCompanyAuthorityRuntimeEnvelopeCandidate(message.body)");
    const strictAt = queue.indexOf("isCompanyAuthorityRuntimeEnvelope<SlackQueueEvent>(message.body)");
    const legacyAt = queue.indexOf("if (ackMalformedTenantQueueMessage", candidateAt);

    expect(candidateAt).toBeGreaterThan(-1);
    expect(strictAt).toBeGreaterThan(candidateAt);
    expect(legacyAt).toBeGreaterThan(strictAt);
    expect(queue.slice(candidateAt, legacyAt)).toContain("diagnoseCompanyAuthorityRuntimeEnvelope(message.body)");
    expect(queue.slice(candidateAt, legacyAt)).toContain('code: diagnostic.code');
    expect(queue.slice(candidateAt, legacyAt)).toContain("message.retry();");
    expect(queue).toContain("isCompanyAuthorityRuntimeEnvelope<SlackQueueEvent>(message.body)");
    expect(queue).toContain("parseCompanyAuthorityRuntimeConfiguration(env)");
    expect(queue).toContain("consumeCompanyAuthorityQueueMessage({");
    expect(queue).toContain("resolveCompanyAuthoritySlackQueueScope({");
    expect(queue).toContain("createDurableTenantStateClient(env.TENANT_RUNTIME_STATE");
    expect(queue).toContain("companyAuthorityProviderRoutes");
    expect(queue).toContain("processCompanyAuthorityAutoQueueRoute({");
    expect(queue).toContain("request: snapshot.request");
    expect(queue).toContain("envelope: snapshot.envelope");
    expect(queue).toContain("registry: companyAuthorityProviderRoutes");
    expect(queue).toContain("executeTenantContainerOperationWithRegistry({");
    expect(queue).toContain("processCompanyAuthorityHumanHandoff({");
    expect(queue).toContain("createDurableCompanyAuthorityHumanHandoffClient(");
    expect(queue).toContain("execution_hash: snapshot.execution_hash");
    expect(queue).not.toContain('unavailableCompanyAuthorityQueueRoute("approval")');
    expect(queue).not.toContain('unavailableCompanyAuthorityQueueRoute("human_action")');
    expect(queue).toContain('stage: "company_authority_runtime_configuration"');
    expect(queue).toContain('stage: "company_authority_runtime_disabled"');
  });

  it("routes ambiguous external effects through readback reconciliation before malformed ACK", () => {
    const queueStart = source.indexOf("async queue(");
    const queue = source.slice(queueStart);
    const reconciliationAt = queue.indexOf("isExternalEffectReconciliationQueueCandidate(message.body)");
    const malformedAckAt = queue.indexOf("if (ackMalformedTenantQueueMessage", reconciliationAt);

    expect(reconciliationAt).toBeGreaterThan(-1);
    expect(malformedAckAt).toBeGreaterThan(reconciliationAt);
    expect(queue.slice(reconciliationAt, malformedAckAt)).toContain(
      "handleExternalEffectReconciliationQueueMessage({",
    );
    expect(queue.slice(reconciliationAt, malformedAckAt)).toContain("ack: () => message.ack()");
    expect(queue.slice(reconciliationAt, malformedAckAt)).toContain("retry: () => message.retry()");
    expect(source).toContain('outcome === "succeeded"');
    expect(queue.slice(reconciliationAt, malformedAckAt)).not.toContain("postSlackReply(");
  });

  it("exposes installation lifecycle and single-use OAuth intent routes", () => {
    expect(source).toContain('url.pathname === "/internal/slack/installations/lifecycle"');
    expect(source).toContain('url.pathname === "/slack/installations/oauth/start"');
    expect(source).toContain('url.pathname === "/slack/installations/oauth/callback"');
    expect(source).toContain("createDurableSlackInstallationIntentClient(env.TENANT_RUNTIME_STATE)");
    expect(source).toContain("isSlackInstallationIntentRequest(request)");
  });

  it("fails closed when the native control-plane Service Binding is unset", () => {
    const oauthStart = source.indexOf('url.pathname === "/slack/installations/oauth/start"');
    const oauthCallback = source.indexOf('url.pathname === "/slack/installations/oauth/callback"');
    const commandStart = source.indexOf('url.pathname === "/slack/commands"', oauthCallback);
    const oauthRoutes = source.slice(oauthStart, commandStart);

    expect(oauthStart).toBeGreaterThan(-1);
    expect(oauthRoutes.match(/!env\.SLACK_INSTALLATION_CONTROL_PLANE/g)).toHaveLength(2);
    expect(oauthRoutes.match(/oauth_configuration_invalid/g)).toHaveLength(2);
    expect(oauthRoutes.match(/status: 503/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(oauthRoutes).toContain(
      "createSlackInstallationControlPlaneClient(\n        env.SLACK_INSTALLATION_CONTROL_PLANE",
    );
  });

  it("routes meeting-minutes context reads through the private Brainbase Service Binding", () => {
    const clientsStart = source.indexOf("function meetingMinutesClients(");
    const clientsEnd = source.indexOf("function ", clientsStart + 1);
    const clients = source.slice(clientsStart, clientsEnd);

    expect(clientsStart).toBeGreaterThan(-1);
    expect(clients).toContain("env.BRAINBASE_TENANT_RUNTIME_SERVICE?.fetch.bind");
    expect(clients).toContain('"https://tenant-runtime.internal"');
    expect(clients).toContain("tenantContext");
    expect(clients).toContain('effects.boundary("brainbase_proxy", () => new MeetingMinutesBrainbaseContextClient(');
    const redoStart = clients.indexOf("redo: {");
    expect(redoStart).toBeGreaterThan(-1);
    expect(clients.slice(0, redoStart)).not.toContain("BRAINBASE_TASK_API_TOKEN");
    expect(clients.slice(redoStart)).not.toContain("BRAINBASE_TASK_API_TOKEN");
    expect(clients.slice(redoStart)).toContain("deleteTask: createMeetingMinutesTaskDeleter({");
    expect(clients.slice(redoStart)).toContain("boundary: effects.boundary");
  });

  it("scopes redo Slack effect keys to the redo revision", () => {
    const clientsStart = source.indexOf("function meetingMinutesClients(");
    const clientsEnd = source.indexOf("function ", clientsStart + 1);
    const clients = source.slice(clientsStart, clientsEnd);
    const redoStart = clients.indexOf("redo: {");
    const redo = clients.slice(redoStart);
    const revision = "run.redo?.revision ?? run.revision ?? 0";

    expect(redo).toContain(`destination-selection:\${run.runId}:revision-\${${revision}}`);
    expect(redo).toContain(`redo-failure:\${run.runId}:revision-\${${revision}}`);
    expect(redo).toContain(`kind: "destination_selection", runId: run.runId, revision: ${revision}`);
    expect(redo).toContain(`kind: "redo_failure", runId: run.runId, revision: ${revision}`);
  });
});
