import { describe, expect, it, vi } from "vitest";
import { createAnthropicServiceFetch, createBrainbaseServiceFetch } from "../multitenancy/tenant-service-fetch.js";

describe("tenant service credential fetches", () => {
  it("uses the Brainbase service token only for the configured task origin", async () => {
    const upstream = vi.fn(async (request: Request) => Response.json({ authorization: request.headers.get("authorization") }));
    const serviceFetch = createBrainbaseServiceFetch({
      BRAINBASE_TASK_API_BASE_URL: "https://bb.example/api",
      BRAINBASE_TASK_API_TOKEN: "brainbase-service-secret",
    }, upstream as typeof fetch);
    const response = await serviceFetch("https://bb.example/api/meeting-minutes/context-receipts", {
      method: "POST", headers: { authorization: "Bearer caller-value" }, body: "{}",
    });
    await expect(response.json()).resolves.toEqual({ authorization: "Bearer brainbase-service-secret" });
    await expect(serviceFetch("https://evil.example/api/meeting-minutes/context-receipts"))
      .rejects.toMatchObject({ code: "CONFIGURATION_INVALID" });
  });

  it("uses the Anthropic service credential only for the messages endpoint", async () => {
    const upstream = vi.fn(async (request: Request) => Response.json({ key: request.headers.get("x-api-key") }));
    const serviceFetch = createAnthropicServiceFetch({ ANTHROPIC_API_KEY: "anthropic-service-secret" }, upstream as typeof fetch);
    const response = await serviceFetch("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" });
    await expect(response.json()).resolves.toEqual({ key: "anthropic-service-secret" });
    await expect(serviceFetch("https://api.anthropic.com/v1/complete"))
      .rejects.toMatchObject({ code: "PROVIDER_OPERATION_UNSUPPORTED" });
  });
});
