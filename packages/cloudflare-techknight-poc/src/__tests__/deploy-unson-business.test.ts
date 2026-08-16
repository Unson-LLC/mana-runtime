import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("unson business deploy wrapper", () => {
  it("stops before deployment when Brainbase project preflight fails", () => {
    const script = fileURLToPath(new URL("../../scripts/deploy-unson-business.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: {
        PATH: "/path-that-does-not-contain-pnpm",
        BRAINBASE_GRAPH_API_BASE_URL: "https://brainbase.invalid",
        BRAINBASE_TASK_API_TOKEN: "",
        BRAINBASE_GRAPH_API_TOKEN: "",
      },
    });

    expect(result.status).toBe(6);
    expect(result.stderr).toContain("meeting_minutes_brainbase_project_check_auth_missing");
    expect(result.stderr).not.toContain("ENOENT");
  });
});
