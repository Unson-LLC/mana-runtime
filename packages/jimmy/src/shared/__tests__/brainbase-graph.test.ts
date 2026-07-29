import { describe, expect, it, vi } from "vitest";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { GraphPeopleClient, resolvePersonByName, type GraphPerson } from "../brainbase-graph.js";

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
});
