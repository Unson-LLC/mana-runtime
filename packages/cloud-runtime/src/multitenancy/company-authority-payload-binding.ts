import type { SlackQueueEvent } from "../types.js";
import { jcsCanonicalize } from "./jcs.js";

const PAYLOAD_BINDING_SEPARATOR = "#payload_sha256=";

async function payloadDigest(payload: SlackQueueEvent): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(jcsCanonicalize(payload)),
  ));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Binds every execution-relevant Slack Queue field to the signed request. */
export async function companyAuthoritySlackResourceRef(
  projectId: string,
  payload: SlackQueueEvent,
): Promise<string> {
  return `project:${projectId}${PAYLOAD_BINDING_SEPARATOR}${await payloadDigest(payload)}`;
}

export async function matchesCompanyAuthoritySlackPayload(
  resourceRef: string,
  projectId: string,
  payload: SlackQueueEvent,
): Promise<boolean> {
  return resourceRef === await companyAuthoritySlackResourceRef(projectId, payload);
}
