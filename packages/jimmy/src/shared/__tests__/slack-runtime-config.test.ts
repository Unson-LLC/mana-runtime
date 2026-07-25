import { describe, expect, it } from "vitest";
import {
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
