import { handleNocodbProxyRequest } from "../nocodb-proxy.js";

const env = {
  NOCODB_URL: "https://nocodb.example.com",
  NOCODB_TOKEN: "secret-token",
  NOCODB_PROJECT_MAPPING_JSON: JSON.stringify({ app_mana: "project_mana" }),
};

describe("NocoDB sandbox proxy", () => {
  it("maps an allowed legacy base and injects the token only upstream", async () => {
    const upstream = vi.fn().mockResolvedValue(Response.json({ list: [{ ID: 1 }] }));
    const response = await handleNocodbProxyRequest(new Request("https://nocodb.internal/api/runtime/nocodb", {
      method: "POST", body: JSON.stringify({ tool: "nocodb_list_records", arguments: { baseId: "app_mana", tableName: "Tasks", limit: 20 } }),
    }), env, upstream);
    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledWith(
      "https://nocodb.example.com/api/v1/db/data/noco/project_mana/Tasks?limit=20&offset=0",
      expect.objectContaining({ headers: expect.objectContaining({ "xc-token": "secret-token" }) }),
    );
  });

  it("rejects an unknown base before contacting NocoDB", async () => {
    const upstream = vi.fn();
    const response = await handleNocodbProxyRequest(new Request("https://nocodb.internal/api/runtime/nocodb", {
      method: "POST", body: JSON.stringify({ tool: "nocodb_list_records", arguments: { baseId: "other", tableName: "Tasks" } }),
    }), env, upstream);
    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
});
