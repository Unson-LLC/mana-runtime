export interface AutonomyExperimentConfig {
  id: string;
  actorId: string;
  project: string;
  startsAt: number;
  expiresAt: number;
  maxWrites: number;
  disabled: boolean;
}

const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

function text(value: unknown, max = 128): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function parseAutonomyExperiment(
  raw: string | undefined,
  killSwitch: string | undefined,
  now = Date.now(),
): AutonomyExperimentConfig | null {
  if (!raw?.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("autonomy_experiment_invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("autonomy_experiment_invalid");
  }
  const item = value as Record<string, unknown>;
  const startsAt = Date.parse(String(item.starts_at ?? ""));
  const expiresAt = Date.parse(String(item.expires_at ?? ""));
  if (!text(item.id)
    || !text(item.actor_id)
    || !text(item.project)
    || !Number.isFinite(startsAt)
    || !Number.isFinite(expiresAt)
    || expiresAt <= startsAt
    || expiresAt - startsAt > MAX_DURATION_MS
    || !Number.isInteger(item.max_writes)
    || Number(item.max_writes) < 1
    || Number(item.max_writes) > 100) {
    throw new Error("autonomy_experiment_invalid");
  }
  if (now < startsAt || now >= expiresAt) return null;
  return {
    id: item.id,
    actorId: item.actor_id,
    project: item.project,
    startsAt,
    expiresAt,
    maxWrites: Number(item.max_writes),
    disabled: killSwitch === "true",
  };
}
