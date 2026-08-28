export class AutonomyWorkerConfigError extends Error {
  readonly code: string;
  constructor(code: string);
}

export function renderAutonomyWorkerConfig(source: string): string;
export function assertAutonomyDeploymentDisabled(source: string): void;
