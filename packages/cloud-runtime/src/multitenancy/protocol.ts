import {
  REQUIRED_TENANT_CAPABILITIES,
  TENANT_PROTOCOL_ID,
  TENANT_PROTOCOL_MAJOR,
  type DeploymentProfile,
} from "./contracts.js";
import { deny } from "./errors.js";

function versionParts(version: string): [number, number] | undefined {
  const match = /^(\d+)\.(\d+)$/.exec(version);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2])];
}

export function negotiateTenantProtocol(
  profile: DeploymentProfile,
  peer: { protocol_id: string; supported_versions: string[]; capabilities: string[] },
): { protocol_id: typeof TENANT_PROTOCOL_ID; protocol_version: string; capabilities: string[] } {
  if (peer.protocol_id !== TENANT_PROTOCOL_ID) deny("protocol", "PROTOCOL_VERSION_UNSUPPORTED");
  const supported = peer.supported_versions
    .map((version) => ({ version, parts: versionParts(version) }))
    .filter((entry): entry is { version: string; parts: [number, number] } => entry.parts !== undefined)
    .filter((entry) => entry.parts[0] === TENANT_PROTOCOL_MAJOR)
    .sort((left, right) => right.parts[1] - left.parts[1]);
  if (supported.length === 0) deny("protocol", "PROTOCOL_VERSION_UNSUPPORTED");
  const missing = REQUIRED_TENANT_CAPABILITIES.filter((capability) =>
    !profile.capabilities.includes(capability) || !peer.capabilities.includes(capability));
  if (missing.length > 0) deny("protocol", "PROTOCOL_CAPABILITY_UNSUPPORTED", { missing });
  return {
    protocol_id: TENANT_PROTOCOL_ID,
    protocol_version: supported[0].version,
    capabilities: [...REQUIRED_TENANT_CAPABILITIES],
  };
}

export function validateNonApplicableCapabilities(
  advertised: Record<string, { status: string; reason?: string }>,
  stillRequired: string[],
): string[] {
  const missingRequired = REQUIRED_TENANT_CAPABILITIES.filter((capability) => !stillRequired.includes(capability));
  if (missingRequired.length > 0) deny("protocol", "PROTOCOL_CAPABILITY_UNSUPPORTED", { missing: missingRequired });
  const nonApplicable: string[] = [];
  for (const [capability, declaration] of Object.entries(advertised)) {
    if (REQUIRED_TENANT_CAPABILITIES.includes(capability as typeof REQUIRED_TENANT_CAPABILITIES[number])) {
      deny("protocol", "PROTOCOL_CAPABILITY_UNSUPPORTED", { capability });
    }
    if (declaration.status !== "non_applicable" || !declaration.reason) deny("protocol", "PROTOCOL_CAPABILITY_UNSUPPORTED");
    nonApplicable.push(capability);
  }
  return nonApplicable;
}
