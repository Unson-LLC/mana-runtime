export interface MeetingMinutesDeployGateOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  allowMissingGate?: boolean;
}

export function assertMeetingMinutesDeployAllowed(
  options: MeetingMinutesDeployGateOptions,
): Promise<void>;
