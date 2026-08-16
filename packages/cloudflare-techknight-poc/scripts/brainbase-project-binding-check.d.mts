export type MeetingMinutesProjectBindingConfig = {
  vars?: Record<string, unknown>;
};

export type BrainbaseProjectBindingCheckOptions = {
  configPath?: string | URL;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export function collectMeetingMinutesProjectBindings(config: MeetingMinutesProjectBindingConfig): {
  destinations: unknown[];
  requiredCodes: string[];
};

export function projectCodesFromGraphResponse(body: unknown): string[];

export function assertBrainbaseMeetingMinutesProjects(options?: BrainbaseProjectBindingCheckOptions): Promise<{
  requiredCodes: string[];
  authorizedCodes: string[];
}>;

export function assertBrainbaseMeetingMinutesRuntimeProjects(options?: Omit<BrainbaseProjectBindingCheckOptions, "token"> & {
  taskToken?: string;
  graphToken?: string;
}): Promise<{
  graph: { requiredCodes: string[]; authorizedCodes: string[] };
  task: { requiredCodes: string[]; authorizedCodes: string[] };
}>;
