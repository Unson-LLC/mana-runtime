type QueueMessageLike = {
  body: unknown;
  ack(): void;
};

type QueueAuditEntry = {
  event: "tenant_queue_failed";
  code: "MALFORMED_TENANT_CONTEXT";
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasQueueRoutingContext(value: unknown): boolean {
  const context = record(value);
  const tenant = record(context?.tenant);
  const connection = record(context?.workspace_connection);
  const actor = record(context?.actor);
  const placement = record(context?.placement);
  const slack = record(context?.slack);
  return nonEmptyString(tenant?.tenant_id)
    && nonEmptyString(connection?.connection_id)
    && nonEmptyString(connection?.connection_revision)
    && nonEmptyString(connection?.workspace_id)
    && nonEmptyString(connection?.app_id)
    && nonEmptyString(actor?.principal_id)
    && nonEmptyString(actor?.authenticated_subject_id)
    && nonEmptyString(placement?.deployment_id)
    && nonEmptyString(placement?.profile)
    && nonEmptyString(slack?.event_id)
    && nonEmptyString(slack?.channel_id);
}

/** ACKs canonical Queue envelopes that cannot safely reach typed tenant dispatch. */
export function ackMalformedTenantQueueMessage(
  message: QueueMessageLike,
  logError: (entry: QueueAuditEntry) => void,
): boolean {
  const body = record(message.body);
  if (body?.schema_version !== "1.0" || !("tenant_context" in body)
    || hasQueueRoutingContext(body.tenant_context)) {
    return false;
  }
  logError({ event: "tenant_queue_failed", code: "MALFORMED_TENANT_CONTEXT" });
  message.ack();
  return true;
}
