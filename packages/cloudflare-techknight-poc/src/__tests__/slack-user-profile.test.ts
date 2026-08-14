import { resolveSlackUserProfile } from "../slack-user-profile.js";

const botToken = "xoxb-super-secret-test-token";

describe("resolveSlackUserProfile", () => {
  it("normalizes display_name, real_name, name, and timezone from users.info", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({
      ok: true,
      user: {
        id: "U123",
        name: "keigo.sato",
        real_name: "佐藤 圭吾",
        tz: "Asia/Tokyo",
        deleted: false,
        is_bot: false,
        profile: {
          display_name: "佐藤",
          real_name: "佐藤圭吾",
        },
      },
    }));

    await expect(resolveSlackUserProfile({
      userId: "U123",
      botToken,
      fetchImpl,
    })).resolves.toEqual({
      status: "resolved",
      profile: {
        userId: "U123",
        name: "佐藤",
        displayName: "佐藤",
        realName: "佐藤 圭吾",
        handle: "keigo.sato",
        timezone: "Asia/Tokyo",
      },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://slack.com/api/users.info?user=U123",
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: `Bearer ${botToken}` },
      }),
    );
  });

  it("fails closed with a stable reason when the Slack API fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(
      { ok: false, error: "users_not_found" },
      { status: 200 },
    ));

    await expect(resolveSlackUserProfile({
      userId: "U404",
      botToken,
      fetchImpl,
    })).resolves.toEqual({
      status: "unavailable",
      reason: "slack_api_error",
    });
  });

  it.each([
    { field: "deleted", user: { deleted: true, is_bot: false }, reason: "deleted_user" },
    { field: "bot", user: { deleted: false, is_bot: true }, reason: "bot_user" },
  ])("fails closed for a $field Slack identity", async ({ user, reason }) => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({
      ok: true,
      user: {
        id: "U_BLOCKED",
        name: "blocked.identity",
        profile: { display_name: "Blocked" },
        ...user,
      },
    }));

    await expect(resolveSlackUserProfile({
      userId: "U_BLOCKED",
      botToken,
      fetchImpl,
    })).resolves.toEqual({ status: "rejected", reason });
  });

  it("never exposes the Bearer token or Slack response body on failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: false, error: `internal_error ${botToken}` }),
      { status: 503, statusText: `upstream included ${botToken}` },
    ));

    const result = await resolveSlackUserProfile({
      userId: "U123",
      botToken,
      fetchImpl,
    });

    expect(result).toEqual({ status: "unavailable", reason: "slack_api_error" });
    expect(JSON.stringify(result)).not.toContain(botToken);
    expect(JSON.stringify(result)).not.toContain("internal_error");

    const [requestUrl, requestInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(requestUrl).not.toContain(botToken);
    expect(requestInit.body).toBeUndefined();
  });
});
