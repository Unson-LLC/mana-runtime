import { describe, expect, it } from "vitest";
import {
  resolveSlackInstanceRuntimeConfig,
  resolveSlackRuntimeConfig,
  SLACK_APP_TOKEN_ENV,
  SLACK_BOT_TOKEN_ENV,
} from "../slack-runtime-config.js";

describe("resolveSlackRuntimeConfig", () => {
  it("resolves credentials from the environment without mutating persisted config", () => {
    const config = { allowFrom: ["U_ALLOWED"] };
    const result = resolveSlackRuntimeConfig(config, {
      [SLACK_APP_TOKEN_ENV]: "xapp-runtime",
      [SLACK_BOT_TOKEN_ENV]: "xoxb-runtime",
    });

    expect(result).toMatchObject({
      appToken: "xapp-runtime",
      botToken: "xoxb-runtime",
      allowFrom: ["U_ALLOWED"],
    });
    expect(config).toEqual({ allowFrom: ["U_ALLOWED"] });
  });

  it("uses environment credentials instead of legacy YAML values", () => {
    const result = resolveSlackRuntimeConfig(
      { appToken: "xapp-yaml", botToken: "xoxb-yaml", allowFrom: ["U_ALLOWED"] },
      {
        [SLACK_APP_TOKEN_ENV]: "xapp-runtime",
        [SLACK_BOT_TOKEN_ENV]: "xoxb-runtime",
      },
    );

    expect(result?.appToken).toBe("xapp-runtime");
    expect(result?.botToken).toBe("xoxb-runtime");
  });

  it("rejects legacy YAML-only credentials", () => {
    expect(() =>
      resolveSlackRuntimeConfig(
        { appToken: "xapp-yaml", botToken: "xoxb-yaml", allowFrom: ["U_ALLOWED"] },
        {},
      ),
    ).toThrow("config.yaml are not supported");
  });

  it("fails closed when only one runtime credential exists", () => {
    expect(() =>
      resolveSlackRuntimeConfig(undefined, {
        [SLACK_APP_TOKEN_ENV]: "xapp-runtime",
      }),
    ).toThrow(`both ${SLACK_APP_TOKEN_ENV} and ${SLACK_BOT_TOKEN_ENV}`);
  });

  it("returns null when Slack is not configured", () => {
    expect(resolveSlackRuntimeConfig(undefined, {})).toBeNull();
  });

  it("fails closed when Slack credentials exist without an allowFrom whitelist", () => {
    expect(() =>
      resolveSlackRuntimeConfig(
        {},
        {
          [SLACK_APP_TOKEN_ENV]: "xapp-runtime",
          [SLACK_BOT_TOKEN_ENV]: "xoxb-runtime",
        },
      ),
    ).toThrow("non-empty allowFrom");
  });
});

describe("resolveSlackInstanceRuntimeConfig", () => {
  it("resolves per-instance tokens from the named env vars", () => {
    const config = { id: "slack-biz", appTokenEnv: "BIZ_APP", botTokenEnv: "BIZ_BOT" };
    const result = resolveSlackInstanceRuntimeConfig(config, {
      BIZ_APP: "xapp-biz",
      BIZ_BOT: "xoxb-biz",
    });

    expect(result).toMatchObject({ id: "slack-biz", appToken: "xapp-biz", botToken: "xoxb-biz" });
    expect(config).toEqual({ id: "slack-biz", appTokenEnv: "BIZ_APP", botTokenEnv: "BIZ_BOT" });
  });

  it("passes inline credentials through when no *TokenEnv is set", () => {
    const config = { appToken: "xapp-inline", botToken: "xoxb-inline" };
    expect(resolveSlackInstanceRuntimeConfig(config, {})).toBe(config);
  });

  it("fails closed when only one *TokenEnv field is set", () => {
    expect(() =>
      resolveSlackInstanceRuntimeConfig({ appTokenEnv: "BIZ_APP" }, { BIZ_APP: "xapp-biz" }),
    ).toThrow("both appTokenEnv and botTokenEnv");
  });

  it("fails closed when a named env var is missing or empty", () => {
    expect(() =>
      resolveSlackInstanceRuntimeConfig(
        { appTokenEnv: "BIZ_APP", botTokenEnv: "BIZ_BOT" },
        { BIZ_APP: "xapp-biz", BIZ_BOT: "  " },
      ),
    ).toThrow("set BIZ_APP and BIZ_BOT");
  });
});
