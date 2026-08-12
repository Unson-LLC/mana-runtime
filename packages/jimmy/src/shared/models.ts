import type {
  JinnConfig,
  ModelInfo,
  ModelRegistry,
  EngineRegistryEntry,
  EffortMechanism,
  EngineModelsConfig,
} from "./types.js";

/**
 * Model + capability registry — the single source of truth for which engines and
 * models exist and what they support (effort levels). Built from the
 * optional `models:` block in config.yaml; when that block is absent (or an engine
 * is missing from it) the entry is synthesized from `engines.<name>.model` so
 * existing configs keep working. Adding a NEW model is a config edit, no code change.
 */

/** Engines registered in this build (mirrors server.ts engine map). */
const ENGINE_NAMES = ["claude", "codex", "gemini"] as const;
type EngineName = (typeof ENGINE_NAMES)[number];

const EFFORT_MECHANISM: Record<EngineName, EffortMechanism> = {
  claude: "claude-flag",
  codex: "codex-config",
  gemini: "none",
};

/** Per-engine defaults used when synthesizing (no `models:` block). */
const SYNTH_DEFAULTS: Record<EngineName, { supportsEffort: boolean; effortLevels: string[]; fallbackModel: string }> = {
  claude: { supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh", "max"], fallbackModel: "opus" },
  codex: { supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh"], fallbackModel: "gpt-5.6-sol" },
  gemini: { supportsEffort: false, effortLevels: [], fallbackModel: "gemini-2.5-pro" },
};

/**
 * Claude CLI declares one flat effort list without model-specific gates.
 * Claude Code determines model support at runtime; when effort is rejected, it
 * follows the `latching unsupported and retrying without it` path and silently
 * retries without effort instead of surfacing an error.
 *
 * Do not duplicate a model-capability table here. Such a table can go stale,
 * causing `resolveEffort` to reject a newly supported level and silently fall
 * back to medium. Both failure modes are silent; letting Claude Code probe at
 * runtime is less harmful than preemptively blocking levels with stale data.
 */
function synthEffortLevels(engine: EngineName): string[] {
  const d = SYNTH_DEFAULTS[engine];
  // `supportsEffort` is the authority: an engine that declares no effort support
  // yields no levels even if `effortLevels` is non-empty, so the two fields
  // cannot drift into offering levels for an engine that rejects them.
  if (!d.supportsEffort) return [];
  return [...d.effortLevels];
}

function isEngineName(engine: string): engine is EngineName {
  return (ENGINE_NAMES as readonly string[]).includes(engine);
}

let cached: ModelRegistry | null = null;

/** Clear the cached registry. Call on config reload / PUT /api/config. */
export function invalidateModelRegistry(): void {
  cached = null;
}

/** Resolve the registry (cached). Pass the current config; cache is keyed by
 *  invalidation, not by config identity — call invalidateModelRegistry() to refresh. */
export function getModelRegistry(config: JinnConfig): ModelRegistry {
  if (!cached) cached = buildRegistry(config);
  return cached;
}

/**
 * Valid effort levels for a session's engine+model, from the registry.
 * Returns [] when the engine/model doesn't support effort (e.g. gemini) or
 * the engine is unknown. `modelId` defaults to the engine's default model.
 */
export function effortLevelsForModel(config: JinnConfig, engine: string, modelId?: string): string[] {
  const entry = getModelRegistry(config)[engine];
  if (!entry) return [];

  const exact = modelId ? entry.models.find((m) => m.id === modelId) : undefined;
  if (exact) return exact.supportsEffort ? [...exact.effortLevels] : [];

  // A session may override a synthesized engine's configured model. Synthesized
  // effort levels are engine-wide; an explicit `models:` block still owns its
  // declared per-model levels and uses the default-model fallback below.
  if (modelId && isEngineName(engine) && !config.models?.[engine]) {
    return synthEffortLevels(engine);
  }

  const fallback = entry.models.find((m) => m.id === entry.defaultModel) ?? entry.models[0];
  return fallback?.supportsEffort ? [...fallback.effortLevels] : [];
}

/** Context window (tokens) for a session's engine+model, or undefined if unknown. */
export function contextWindowForModel(config: JinnConfig, engine: string, modelId?: string): number | undefined {
  const entry = getModelRegistry(config)[engine];
  if (!entry) return undefined;
  const model =
    (modelId ? entry.models.find((m) => m.id === modelId) : undefined) ??
    entry.models.find((m) => m.id === entry.defaultModel) ??
    entry.models[0];
  return model?.contextWindow;
}

/** Build the registry without touching the cache (used by getModelRegistry + tests). */
export function buildRegistry(config: JinnConfig): ModelRegistry {
  const synthesized = synthesizeFromEngineConfig(config);
  const block = config.models;
  if (!block) return synthesized;

  const registry: ModelRegistry = {};
  for (const name of ENGINE_NAMES) {
    const engineBlock = block[name];
    registry[name] = engineBlock
      ? fromEngineModelsConfig(name, engineBlock)
      : synthesized[name]; // engine omitted from the block → keep the synthesized entry
  }
  return registry;
}

/** Backward-compat: synthesize a minimal registry from engines.<name>.model. */
export function synthesizeFromEngineConfig(config: JinnConfig): ModelRegistry {
  const registry: ModelRegistry = {};
  for (const name of ENGINE_NAMES) {
    const defaults = SYNTH_DEFAULTS[name];
    const engineCfg = (config.engines as unknown as Record<string, { model?: string } | undefined>)[name];
    const modelId = engineCfg?.model || defaults.fallbackModel;
    const model: ModelInfo = {
      id: modelId,
      label: modelId,
      supportsEffort: defaults.supportsEffort,
      effortLevels: synthEffortLevels(name),
    };
    registry[name] = {
      name,
      available: true,
      defaultModel: modelId,
      effortMechanism: EFFORT_MECHANISM[name],
      models: [model],
    };
  }
  return registry;
}

function fromEngineModelsConfig(name: EngineName, block: EngineModelsConfig): EngineRegistryEntry {
  const models: ModelInfo[] = (block.models ?? []).map((m) => {
    const supportsEffort = m.supportsEffort ?? false;
    return {
      id: m.id,
      label: m.label || m.id,
      supportsEffort,
      effortLevels: supportsEffort ? (m.effortLevels ?? []) : [],
      ...(typeof m.contextWindow === "number" ? { contextWindow: m.contextWindow } : {}),
    };
  });
  const defaultModel = block.default || models[0]?.id || SYNTH_DEFAULTS[name].fallbackModel;
  return {
    name,
    available: true,
    defaultModel,
    effortMechanism: block.effortMechanism ?? EFFORT_MECHANISM[name],
    models,
  };
}
