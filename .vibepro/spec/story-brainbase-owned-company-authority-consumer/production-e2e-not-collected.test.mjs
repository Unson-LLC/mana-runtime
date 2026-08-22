import test from "node:test";

export const production_e2e_not_collected = true;

test("production 2x2 tenant/person E2E remains not_collected", {
  skip: "A0 fixture/mock conformance is not production 2x2 tenant/person E2E evidence",
}, () => {});
