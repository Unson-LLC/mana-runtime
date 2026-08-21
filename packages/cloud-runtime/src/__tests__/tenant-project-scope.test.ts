import { TenantBoundaryError } from "../multitenancy/errors.js";
import { resolveCanonicalProjectScope } from "../multitenancy/project-scope.js";

describe("tenant project scope", () => {
  it("maps one trusted placement code to Brainbase's signed canonical project id", () => {
    expect(resolveCanonicalProjectScope({
      project_ids: ["prj_01M0MANA000000000000000001"],
      data_scopes: ["company_authority:resource:project:mana@prj_01M0MANA000000000000000001"],
    }, ["mana"], "queue_consumer")).toEqual({
      project_id: "prj_01M0MANA000000000000000001",
      project_ids: ["prj_01M0MANA000000000000000001"],
    });
  });

  it("preserves an exact legacy id scope", () => {
    expect(resolveCanonicalProjectScope({ project_ids: ["mana"], data_scopes: [] },
      ["mana"], "queue_consumer")).toEqual({ project_id: "mana", project_ids: ["mana"] });
  });

  it("rejects an unbound code, multiple canonical candidates, and partial legacy scope", () => {
    for (const [authorization, codes] of [
      [{ project_ids: ["prj_other"], data_scopes: [] }, ["mana"]],
      [{ project_ids: ["prj_mana", "prj_other"],
        data_scopes: ["company_authority:resource:project:mana@prj_mana"] }, ["mana"]],
      [{ project_ids: ["mana", "other"], data_scopes: [] }, ["mana"]],
    ] as const) {
      expect(() => resolveCanonicalProjectScope(authorization, codes, "queue_consumer"))
        .toThrow(TenantBoundaryError);
    }
  });
});
