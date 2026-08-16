import type { BoundaryName } from "./contracts.js";

export class TenantBoundaryError extends Error {
  readonly boundary: BoundaryName | string;
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    boundary: BoundaryName | string,
    code: string,
    message = code,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "TenantBoundaryError";
    this.boundary = boundary;
    this.code = code;
    this.details = details;
  }
}

export function deny(
  boundary: BoundaryName | string,
  code: string,
  details?: Readonly<Record<string, unknown>>,
): never {
  throw new TenantBoundaryError(boundary, code, code, details);
}
