import { safeSettingsBaseUrl } from "../../shared/settings-url.js";

export interface SettingsDeepLinkTarget {
  workspaceId?: string;
  projectId?: string;
  channelId?: string;
}

export interface SlackSettingsButton {
  type: "button";
  text: { type: "plain_text"; text: string; emoji?: boolean };
  action_id?: string;
  url: string;
}

export function buildSettingsAppHomeBlocks(input: {
  webBaseUrl: string | undefined;
  running: boolean;
  instanceId: string;
}): any[] {
  const blocks: any[] = [
    { type: "header", text: { type: "plain_text", text: "Mana 設定", emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: `*接続状態:* ${input.running ? "稼働中" : "未確認"}\n*Connector:* ${input.instanceId}` } },
  ];
  const url = buildSettingsTopologyUrl(input.webBaseUrl);
  if (url) {
    blocks.push({
      type: "actions",
      elements: [{ type: "button", text: { type: "plain_text", text: "Mana設定を開く", emoji: true }, action_id: "open_mana_settings", url }],
    });
  } else {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: ":warning: 管理者による設定画面URLの登録が必要です。" } });
  }
  return blocks;
}

export function buildSettingsDmBlocks(webBaseUrl: string | undefined): any[] {
  const blocks: any[] = [{ type: "section", text: { type: "mrkdwn", text: "Manaのルーティングと接続状態を読み取り専用画面で確認できます。" } }];
  const url = buildSettingsTopologyUrl(webBaseUrl);
  if (url) {
    blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Mana設定を開く", emoji: true }, action_id: "open_mana_settings_dm", url }] });
  } else {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: ":warning: 設定画面URLが未設定です。管理者に確認してください。" } });
  }
  return blocks;
}

export function buildSettingsTopologyUrl(webBaseUrl: string | undefined): string | null {
  const url = safeSettingsBaseUrl(webBaseUrl);
  if (!url) return null;
  url.pathname = "/settings/topology";
  return url.toString().replace(/\/$/, "");
}

/**
 * Builds an operator-facing link without carrying credentials, error text, or
 * arbitrary caller-controlled query fields into the Web UI.
 */
export function buildSettingsDeepLink(
  webBaseUrl: string | undefined,
  target: SettingsDeepLinkTarget,
): string | null {
  const url = safeSettingsBaseUrl(webBaseUrl);
  if (!url) return null;
  try {
    url.pathname = "/settings/meeting-minutes";
    if (target.workspaceId?.trim()) url.searchParams.set("workspace", target.workspaceId.trim());
    if (target.projectId?.trim()) url.searchParams.set("project", target.projectId.trim());
    if (target.channelId?.trim()) url.searchParams.set("channel", target.channelId.trim());
    return url.toString();
  } catch {
    return null;
  }
}

export function buildMeetingMinutesSettingsAction(
  webBaseUrl: string | undefined,
  target: SettingsDeepLinkTarget,
): SlackSettingsButton | null {
  const url = buildSettingsDeepLink(webBaseUrl, target);
  if (!url) return null;
  return {
    type: "button",
    text: { type: "plain_text", text: "構成を確認" },
    url,
  };
}

/** Production payload used by the meeting-minutes failure path and browser journey tests. */
export function buildMeetingMinutesFailureControl(input: {
  key: string;
  message: string;
  settingsWebBaseUrl?: string;
  target: SettingsDeepLinkTarget;
  retryActionId?: string;
}): { text: string; blocks: unknown[] } {
  const elements: unknown[] = [
    {
      type: "button",
      style: "primary",
      text: { type: "plain_text", text: "再試行" },
      action_id: input.retryActionId ?? "meeting_minutes_retry",
      value: JSON.stringify({ key: input.key }),
    },
  ];
  const settingsAction = buildMeetingMinutesSettingsAction(input.settingsWebBaseUrl, input.target);
  if (settingsAction) elements.push(settingsAction);
  return {
    text: `⚠️ ${input.message}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `⚠️ ${input.message}` } },
      { type: "actions", elements },
    ],
  };
}
