import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Unson Business autonomy entry configuration", () => {
  it("routes only the Unson Business deployment through the optional autonomy wrapper", async () => {
    const unson = await readFile(new URL("../../wrangler.unson-business.jsonc", import.meta.url), "utf8");
    const shared = await readFile(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
    const dedicated = await readFile(new URL("../../wrangler.dedicated-cloud.jsonc", import.meta.url), "utf8");
    const customerManaged = await readFile(new URL("../../wrangler.customer-managed-oss.jsonc", import.meta.url), "utf8");

    expect(unson).toMatch(/"main"\s*:\s*"src\/autonomy-worker\.ts"/u);
    expect(shared).not.toMatch(/"main"\s*:\s*"src\/autonomy-worker\.ts"/u);
    expect(dedicated).not.toMatch(/"main"\s*:\s*"src\/autonomy-worker\.ts"/u);
    expect(customerManaged).not.toMatch(/"main"\s*:\s*"src\/autonomy-worker\.ts"/u);
  });
});
