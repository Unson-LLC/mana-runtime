import type { SlackConnectorConfig } from "./types.js";

export const SLACK_APP_TOKEN_ENV = "OPENRYOKO_SLACK_APP_TOKEN";
export const SLACK_BOT_TOKEN_ENV = "OPENRYOKO_SLACK_BOT_TOKEN";

type SlackConfigSource = Omit<SlackConnectorConfig, "appToken" | "botToken"> &
  Partial<Pick<SlackConnectorConfig, "appToken" | "botToken">>;

/**
 * Resolve Slack credentials at the last possible moment so environment-backed
 * secrets never enter the persisted JinnConfig object.
 */
export function resolveSlackRuntimeConfig(
  config: SlackConfigSource | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SlackConnectorConfig | null {
  const appToken = env[SLACK_APP_TOKEN_ENV]?.trim();
  const botToken = env[SLACK_BOT_TOKEN_ENV]?.trim();

  if (!appToken && !botToken) {
    if (config?.appToken || config?.botToken) {
      throw new Error(
        `Slack credentials in config.yaml are not supported; set ${SLACK_APP_TOKEN_ENV} and ${SLACK_BOT_TOKEN_ENV}`,
      );
    }
    return null;
  }
  if (!appToken || !botToken) {
    throw new Error(
      `Slack connector requires both ${SLACK_APP_TOKEN_ENV} and ${SLACK_BOT_TOKEN_ENV}`,
    );
  }
  const allowFrom = Array.isArray(config?.allowFrom)
    ? config.allowFrom.map((value) => value.trim()).filter(Boolean)
    : config?.allowFrom?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  if (allowFrom.length === 0) {
    throw new Error("Slack connector requires a non-empty allowFrom whitelist");
  }

  return {
    ...config,
    appToken,
    botToken,
    allowFrom,
  };
}

/**
 * Resolve credentials for a named Slack connector instance
 * (connectors.instances[]). Instances can't reuse the fixed
 * OPENRYOKO_SLACK_* env vars — each Slack workspace needs its own app
 * install — so the instance names its env vars via appTokenEnv/botTokenEnv.
 * Inline appToken/botToken pass through unchanged for backwards
 * compatibility when neither *TokenEnv field is set.
 */
export function resolveSlackInstanceRuntimeConfig<
  T extends Partial<Pick<SlackConnectorConfig, "appToken" | "botToken" | "appTokenEnv" | "botTokenEnv">>,
>(config: T, env: NodeJS.ProcessEnv = process.env): T {
  const { appTokenEnv, botTokenEnv } = config;
  if (!appTokenEnv && !botTokenEnv) return config;
  if (!appTokenEnv || !botTokenEnv) {
    throw new Error("Slack instance requires both appTokenEnv and botTokenEnv when either is set");
  }
  const appToken = env[appTokenEnv]?.trim();
  const botToken = env[botTokenEnv]?.trim();
  if (!appToken || !botToken) {
    throw new Error(
      `Slack instance credentials missing: set ${appTokenEnv} and ${botTokenEnv} in the gateway environment`,
    );
  }
  return { ...config, appToken, botToken };
}
