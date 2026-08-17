import { describe, expect, it, vi } from "vitest";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { BrainbaseEntityResolverClient } from "../brainbase-entity-resolution.js";

function response(records: unknown[], revision = "rev-1") {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ etag: revision }),
    json: async () => ({ records }),
  };
}

describe("BrainbaseEntityResolverClient", () => {
  it("uses the common Brainbase resolver and returns a portable receipt", async () => {
    const recordsByType: Record<string, unknown[]> = {
      project: [
        {
          id: "proj_salestailor",
          entity_type: "project",
          project_code: "salestailor",
          payload: { name: "SalesTailor", aliases: ["セールステイラー"] },
        },
      ],
      person: [
        {
          id: "per_takashow",
          entity_type: "person",
          member_of_project_ids: ["proj_salestailor"],
          payload: { name: "タカショー", aliases: ["Takashow"] },
        },
      ],
      org: [],
      decision: [
        {
          id: "dec_price",
          entity_type: "decision",
          project_id: "proj_salestailor",
          payload: { name: "価格改定を8月に実施する", aliases: [] },
        },
      ],
    };
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = new URL(String(input));
      return response(recordsByType[url.searchParams.get("type") ?? ""] ?? []);
    }) as unknown as typeof fetch;
    const client = new BrainbaseEntityResolverClient({
      baseUrl: "https://bb.example",
      token: "token",
      fetchImpl,
    });

    const result = await client.resolve("Takashowさんが価格改定を説明した", {
      projectId: "proj_salestailor",
      asOf: "2026-08-17T00:00:00.000Z",
    });

    expect(result.receipt).toMatchObject({
      schemaVersion: 1,
      resolverVersion: "1.0.0",
      source: { authority: "local_graph", status: "complete" },
      resolutionStatus: "complete",
      summary: { resolved: 1, ambiguous: 0, unresolved: 0 },
    });
    expect(result.receipt.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result.receipt)).not.toContain("Takashow");
    expect(result.properNouns).toEqual([
      { id: "per_takashow", name: "タカショー", aliases: ["Takashowさん"] },
    ]);
    expect(result.decisions).toEqual(["価格改定を8月に実施する"]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    for (const [url] of vi.mocked(fetchImpl).mock.calls) {
      expect(new URL(String(url)).searchParams.get("project")).toBe("proj_salestailor");
    }
  });

  it("does not collapse an unavailable Brainbase source into an empty result", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;
    const client = new BrainbaseEntityResolverClient({
      baseUrl: "https://bb.example",
      token: "token",
      fetchImpl,
    });

    const result = await client.resolve("Takashowさん", {
      projectId: "proj_salestailor",
      asOf: "2026-08-17T00:00:00.000Z",
    });

    expect(result.receipt).toMatchObject({
      source: { status: "unavailable", issueCodes: ["http_503"] },
      resolutionStatus: "blocked",
      summary: null,
    });
    expect(result.properNouns).toEqual([]);
    expect(result.decisions).toEqual([]);
  });

  it("marks a partially fetched Graph explicitly", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (input: string | URL) => {
      const type = new URL(String(input)).searchParams.get("type");
      if (type === "org") return { ok: false, status: 502 };
      if (type === "project") {
        return response([{ id: "proj_salestailor", payload: { name: "SalesTailor" } }]);
      }
      return response([]);
    }) as unknown as typeof fetch;
    const client = new BrainbaseEntityResolverClient({
      baseUrl: "https://bb.example",
      token: "token",
      fetchImpl,
    });

    const result = await client.resolve("定例会議", {
      projectId: "proj_salestailor",
      asOf: "2026-08-17T00:00:00.000Z",
    });

    expect(result.receipt.source.status).toBe("partial");
    expect(result.receipt.source.issueCodes).toEqual(["org_http_502"]);
    expect(result.receipt.resolutionStatus).toBe("none");
  });
});
