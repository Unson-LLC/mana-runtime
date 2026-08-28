const MAIN_FIELD = /("main"\s*:\s*")([^"\r\n]+)(")/gu;
const CANONICAL_ENTRIES = new Set(["src/index.ts", "./src/index.ts"]);
const AUTONOMY_ENTRY = "src/autonomy-worker.ts";

export class AutonomyWorkerConfigError extends Error {
  constructor(code) {
    super(code);
    this.name = "AutonomyWorkerConfigError";
    this.code = code;
  }
}

export function renderAutonomyWorkerConfig(source) {
  if (typeof source !== "string" || source.length === 0 || source.length > 1_000_000) {
    throw new AutonomyWorkerConfigError("autonomy_worker_config_invalid");
  }
  const matches = [...source.matchAll(MAIN_FIELD)];
  if (matches.length !== 1) {
    throw new AutonomyWorkerConfigError("autonomy_worker_main_ambiguous");
  }
  const current = matches[0][2];
  if (current === AUTONOMY_ENTRY || current === `./${AUTONOMY_ENTRY}`) {
    return source;
  }
  if (!CANONICAL_ENTRIES.has(current)) {
    throw new AutonomyWorkerConfigError("autonomy_worker_main_drifted");
  }
  const rendered = source.replace(MAIN_FIELD, `$1${AUTONOMY_ENTRY}$3`);
  if (rendered === source || !rendered.includes(AUTONOMY_ENTRY)) {
    throw new AutonomyWorkerConfigError("autonomy_worker_render_failed");
  }
  return rendered;
}

export function assertAutonomyDeploymentDisabled(source) {
  if (typeof source !== "string") {
    throw new AutonomyWorkerConfigError("autonomy_worker_config_invalid");
  }
  for (const forbidden of [
    "MANA_AUTONOMY_EXPERIMENT_JSON",
    "MANA_AUTONOMY_REHEARSAL_MODE",
  ]) {
    if (source.includes(`\"${forbidden}\"`)) {
      throw new AutonomyWorkerConfigError("autonomy_worker_enablement_in_config_forbidden");
    }
  }
}
