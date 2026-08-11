import { describe, expect, it, vi } from "vitest";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  BrainbaseContextClient,
  GraphPeopleClient,
  resolvePersonByName,
  resolvePersonByNameStrict,
  type GraphPerson,
} from "../brainbase-graph.js";

const PEOPLE: GraphPerson[] = [
  { id: "per_sato_keigo", name: "佐藤 圭吾", aliases: ["佐藤圭吾", "sato", "K.Sato"] },
  { id: "per_sato_noriyuki", name: "佐藤 紀征", aliases: [] },
  { id: "per_tanaka", name: "田中 太郎", aliases: ["田中"] },
];

describe("resolvePersonByName", () => {
  it("matches full names ignoring whitespace and case", () => {
    expect(resolvePersonByName(PEOPLE, "佐藤圭吾")?.id).toBe("per_sato_keigo");
    expect(resolvePersonByName(PEOPLE, "佐藤 圭吾")?.id).toBe("per_sato_keigo");
    expect(resolvePersonByName(PEOPLE, "k.sato")?.id).toBe("per_sato_keigo");
    expect(resolvePersonByName(PEOPLE, "田中")?.id).toBe("per_tanaka");
  });

  it("returns null for ambiguous or unknown names", () => {
    // 「佐藤」だけでは2人にマッチしうる… aliasesで佐藤圭吾のみが「佐藤」を
    // 持たないこのfixtureでは一意だが、実データの曖昧照合を模して部分一致は
    // しないことを確認する
    expect(resolvePersonByName(PEOPLE, "佐藤")).toBeNull(); // 部分一致はしない
    expect(resolvePersonByName(PEOPLE, "存在しない人")).toBeNull();
    expect(resolvePersonByName(PEOPLE, "")).toBeNull();
  });

  it("returns null when two people share an alias", () => {
    const dup = [
      { id: "a", name: "山田", aliases: [] },
      { id: "b", name: "山田 別人", aliases: ["山田"] },
    ];
    expect(resolvePersonByName(dup, "山田")).toBeNull();
    expect(resolvePersonByNameStrict(dup, "山田")).toEqual({ status: "ambiguous" });
  });

  it("distinguishes resolved, unknown, and ambiguous names", () => {
    expect(resolvePersonByNameStrict(PEOPLE, "K.Sato")).toMatchObject({
      status: "resolved",
      person: { id: "per_sato_keigo" },
    });
    expect(resolvePersonByNameStrict(PEOPLE, "存在しない人")).toEqual({ status: "unknown" });
  });
});

describe("GraphPeopleClient", () => {
  it("parses records and caches", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        records: [
          { id: "per_a", payload: { name: "A さん", aliases: ["a"] } },
          { id: "per_b", payload: { name: "", aliases: [] } }, // dropped: no name
          { id: "per_c", payload: { name: "C さん" } },
        ],
      }),
    }) as unknown as typeof fetch;
    const client = new GraphPeopleClient({ baseUrl: "https://bb.example", token: "t", fetchImpl });
    const people = await client.listPeople(1000);
    expect(people.map((p) => p.id)).toEqual(["per_a", "per_c"]);
    await client.listPeople(2000);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // cached
  });

  it("fails open on HTTP errors and missing config", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403 }) as unknown as typeof fetch;
    const client = new GraphPeopleClient({ baseUrl: "https://bb.example", token: "t", fetchImpl });
    expect(await client.listPeople()).toEqual([]);
    const unconfigured = new GraphPeopleClient({ baseUrl: "", token: "", fetchImpl });
    expect(await unconfigured.listPeople()).toEqual([]);
  });

  it("exposes strict availability without changing listPeople fail-open behavior", async () => {
    const upstreamFetch = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;
    const upstream = new GraphPeopleClient({ baseUrl: "https://bb.example", token: "t", fetchImpl: upstreamFetch });
    await expect(upstream.listPeopleStrict()).resolves.toEqual({
      status: "unavailable",
      reason: "upstream",
      statusCode: 503,
    });
    await expect(upstream.listPeople()).resolves.toEqual([]);

    const unconfigured = new GraphPeopleClient({ baseUrl: "", token: "", fetchImpl: upstreamFetch });
    await expect(unconfigured.listPeopleStrict()).resolves.toEqual({ status: "unavailable", reason: "unconfigured" });

    const network = new GraphPeopleClient({
      baseUrl: "https://bb.example",
      token: "t",
      fetchImpl: vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch,
    });
    await expect(network.listPeopleStrict()).resolves.toEqual({ status: "unavailable", reason: "network" });

    const invalidJson = new GraphPeopleClient({
      baseUrl: "https://bb.example",
      token: "t",
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => { throw new SyntaxError("invalid JSON"); },
      }) as unknown as typeof fetch,
    });
    await expect(invalidJson.listPeopleStrict()).resolves.toEqual({ status: "unavailable", reason: "invalid_json" });
  });

  it("returns available records and bounds a hung request", async () => {
    const available = new GraphPeopleClient({
      baseUrl: "https://bb.example",
      token: "t",
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ records: [{ id: "per_a", payload: { name: "A", aliases: ["Alias A"] } }] }),
      }) as unknown as typeof fetch,
    });
    await expect(available.listPeopleStrict()).resolves.toEqual({
      status: "available",
      people: [{ id: "per_a", name: "A", aliases: ["Alias A"] }],
    });

    const hung = new GraphPeopleClient({
      baseUrl: "https://bb.example",
      token: "t",
      timeoutMs: 10,
      fetchImpl: vi.fn(() => new Promise(() => {})) as unknown as typeof fetch,
    });
    await expect(hung.listPeopleStrict()).resolves.toEqual({ status: "unavailable", reason: "timeout" });
  });

  it("uses cache only for fail-open reads and keeps strict mutation lookups fresh", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ records: [{ id: "old", payload: { name: "Old" } }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ records: [{ id: "fresh", payload: { name: "Fresh" } }] }) }) as unknown as typeof fetch;
    const client = new GraphPeopleClient({ baseUrl: "https://bb.example", token: "t", fetchImpl });
    await expect(client.listPeople(1_000)).resolves.toMatchObject([{ id: "old" }]);
    await expect(client.listPeople(2_000)).resolves.toMatchObject([{ id: "old" }]);
    await expect(client.listPeopleStrict(2_000)).resolves.toMatchObject({
      status: "available",
      people: [{ id: "fresh" }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("bounds body reads and fail-closes malformed or truncated directories", async () => {
    const hungJson = new GraphPeopleClient({
      baseUrl: "https://bb.example",
      token: "t",
      timeoutMs: 10,
      fetchImpl: vi.fn().mockResolvedValue({ ok: true, json: () => new Promise(() => {}) }) as unknown as typeof fetch,
    });
    await expect(hungJson.listPeopleStrict()).resolves.toEqual({ status: "unavailable", reason: "timeout" });

    const malformed = new GraphPeopleClient({
      baseUrl: "https://bb.example",
      token: "t",
      fetchImpl: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }) as unknown as typeof fetch,
    });
    await expect(malformed.listPeopleStrict()).resolves.toEqual({ status: "unavailable", reason: "invalid_json" });

    const truncated = new GraphPeopleClient({
      baseUrl: "https://bb.example",
      token: "t",
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ records: Array.from({ length: 500 }, (_, index) => ({ id: `p${index}`, payload: { name: `P${index}` } })) }),
      }) as unknown as typeof fetch,
    });
    await expect(truncated.listPeopleStrict()).resolves.toEqual({ status: "unavailable", reason: "truncated" });
  });
});

describe("BrainbaseContextClient", () => {
  it("hydrates on every turn and distinguishes unavailable from an empty Graph", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          report: { sections: [{ title: "Decisions", items: [{ title: "決定A" }] }] },
          meta: { timestamp: "A" },
          philosophy_context: { prompt_block: "方針A" },
          scoped_memory: { records: [{ body: "共有記憶A" }], denied: [] },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ report: "決定B", meta: { timestamp: "B" } }),
      })
      .mockResolvedValueOnce({ ok: false, status: 503 });
    const client = new BrainbaseContextClient({
      baseUrl: "https://bb.example",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const firstHydration = await client.hydrate({ project: "unson", workspace: "T1", channelId: "C1", sessionId: "S1" });
    expect(firstHydration).toMatchObject({ status: "available", revision: "A" });
    expect(firstHydration.content).toContain("決定A");
    expect(firstHydration.content).toContain("方針A");
    expect(firstHydration.content).toContain("共有記憶A");
    expect(await client.hydrate({ project: "unson", workspace: "T1", channelId: "C1", sessionId: "S1" }))
      .toMatchObject({ status: "available", revision: "B", content: "決定B" });
    expect(await client.hydrate({ project: "unson", workspace: "T1", channelId: "C1", sessionId: "S1" }))
      .toMatchObject({ status: "unavailable", reasonCode: "http_503" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const requested = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(Object.fromEntries(requested.searchParams)).toMatchObject({
      project: "unson",
      workspace: "T1",
      channelId: "C1",
      sessionId: "S1",
      humanReadable: "true",
      includeEdges: "true",
      includePhilosophy: "true",
      includeMemory: "true",
      scope: "graph",
    });
  });

  it("uses the Brainbase default project and reports a truly empty response as empty", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ entities: {}, edges: [], report: null, meta: {} }),
    }) as unknown as typeof fetch;
    const client = new BrainbaseContextClient({ baseUrl: "https://bb.example", token: "t", fetchImpl });

    await expect(client.hydrate({ workspace: "T1", channelId: "C1", sessionId: "S1" }))
      .resolves.toMatchObject({ status: "empty", content: "" });
    expect(new URL(String((fetchImpl as any).mock.calls[0][0])).searchParams.get("project"))
      .toBe("brainbase");
  });
});
