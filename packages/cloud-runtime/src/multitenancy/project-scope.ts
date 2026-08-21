import type { BoundaryName } from "./contracts.js";
import { deny } from "./errors.js";

type SignedProjectAuthorization = {
  readonly project_ids: readonly string[];
  readonly data_scopes: readonly string[];
};

export function resolveCanonicalProjectScope(
  authorization: SignedProjectAuthorization,
  trustedProjectCodes: readonly string[],
  boundary: BoundaryName,
): { project_id: string; project_ids: readonly string[] } {
  const signedProjectIds = [...authorization.project_ids].sort();
  const expectedProjectCodes = [...trustedProjectCodes].sort();
  const legacyExactMatch = signedProjectIds.length === expectedProjectCodes.length
    && signedProjectIds.every((projectId, index) => projectId === expectedProjectCodes[index]);
  if (legacyExactMatch) return { project_id: signedProjectIds[0]!, project_ids: signedProjectIds };

  if (expectedProjectCodes.length === 1 && signedProjectIds.length === 1) {
    const resourcePrefix = "company_authority:resource:project:";
    const resourceScopes = authorization.data_scopes.filter((scope) => scope.startsWith(resourcePrefix));
    const resourceScope = resourceScopes[0];
    const separatorIndex = resourceScope?.lastIndexOf("@") ?? -1;
    const resourceCode = separatorIndex > resourcePrefix.length
      ? resourceScope!.slice(resourcePrefix.length, separatorIndex)
      : "";
    const resourceRevision = separatorIndex > 0 ? resourceScope!.slice(separatorIndex + 1) : "";
    if (resourceScopes.length === 1
      && resourceCode === expectedProjectCodes[0]
      && /^[1-9]\d*$/.test(resourceRevision)) {
      return { project_id: signedProjectIds[0]!, project_ids: signedProjectIds };
    }
  }
  deny(boundary, "PROJECT_SCOPE_MISMATCH");
}
