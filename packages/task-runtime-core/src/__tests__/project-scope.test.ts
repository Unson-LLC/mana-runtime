import { describe, expect, it } from "vitest";

import {
  applyTrustedProjectFilter,
  applyTrustedProjectScope,
  normalizeProjectCodes,
} from "../index.js";

describe("trusted project scope", () => {
  it("story-shared-task-runtime-core:ac:5 replaces untrusted project codes with the trusted project union", () => {
    expect(applyTrustedProjectScope(
      { title: "確認する", project_codes: ["attacker-project"] },
      [" back-office ", "accounting", "back-office", ""],
    )).toEqual({
      title: "確認する",
      project_codes: ["back-office", "accounting"],
    });
  });

  it("fails closed when the trusted scope is empty or malformed", () => {
    expect(() => applyTrustedProjectScope({ title: "確認する" }, [])).toThrowError(
      expect.objectContaining({ code: "task_scope_not_configured" }),
    );
    expect(normalizeProjectCodes(["valid", "bad code", "../escape", "valid"])).toEqual(["valid"]);
  });

  it("forces the same trusted union onto list and search filters", () => {
    expect(applyTrustedProjectFilter(
      { query: "月次", project_code: ["untrusted"] },
      ["back-office", "accounting", "back-office"],
    )).toEqual({ query: "月次", project_code: ["back-office", "accounting"] });
  });
});
