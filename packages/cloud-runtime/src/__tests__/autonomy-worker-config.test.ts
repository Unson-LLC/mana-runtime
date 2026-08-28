import { describe, expect, it } from "vitest";

import {
  assertAutonomyDeploymentDisabled,
  renderAutonomyWorkerConfig,
} from "../../scripts/autonomy-worker-config.mjs";

describe("Unson autonomy Worker config", () => {
  it("changes only the canonical main entrypoint", () => {
    const source = `{
      "name": "mana-runtime-unson-business",
      "main": "src/index.ts",
      "vars": { "TENANT_ID": "unson-business" }
    }`;
    const rendered = renderAutonomyWorkerConfig(source);
    expect(rendered).toContain('"main": "src/autonomy-worker.ts"');
    expect(rendered).toContain('"TENANT_ID": "unson-business"');
    expect(rendered.replace("src/autonomy-worker.ts", "src/index.ts")).toBe(source);
  });

  it("fails closed when main is absent, duplicated or already drifted", () => {
    for (const source of [
      '{ "name": "missing-main" }',
      '{ "main": "src/index.ts", "nested": { "main": "src/index.ts" } }',
      '{ "main": "src/other-worker.ts" }',
    ]) {
      expect(() => renderAutonomyWorkerConfig(source)).toThrow();
    }
  });

  it("forbids experiment and rehearsal enablement in the canonical checked-in config", () => {
    expect(() => assertAutonomyDeploymentDisabled('{ "vars": { "SAFE": "1" } }')).not.toThrow();
    expect(() => assertAutonomyDeploymentDisabled(
      '{ "vars": { "MANA_AUTONOMY_EXPERIMENT_JSON": "forbidden" } }',
    )).toThrowError(expect.objectContaining({
      code: "autonomy_worker_enablement_in_config_forbidden",
    }));
    expect(() => assertAutonomyDeploymentDisabled(
      '{ "vars": { "MANA_AUTONOMY_REHEARSAL_MODE": "zero_write" } }',
    )).toThrow();
  });
});
