import type { ConfigHistoryEntry } from "../shared/config-history.js";
import { safeSettingsBaseUrl } from "../shared/settings-url.js";
import type { JinnConfig, SlackConnectorConfig, SlackRespondMode } from "../shared/types.js";

export type TopologyVerificationStatus = "verified" | "error" | "unconfirmed";
export type TopologyVerificationCode =
  | "channel_ready_by_static_checks"
  | "bot_not_member"
  | "channel_archived"
  | "permission_denied"
  | "channel_not_found"
  | "workspace_identity_unavailable"
  | "workspace_mismatch"
  | "slack_probe_failed"
  | "runtime_snapshot_unavailable"
  | "target_connector_missing";

export interface SlackChannelProbeSnapshot {
  channelId: string;
  name?: string;
  checkedAt: string;
  status: TopologyVerificationStatus;
  code: TopologyVerificationCode;
}

export interface SlackRuntimeSnapshot {
  instanceId: string;
  health: "healthy" | "degraded" | "stopped" | "unknown";
  healthCode?: "slack_runtime_unavailable";
  healthObservedAt?: string;
  workspaceId?: string;
  workspaceName?: string;
  checkedAt?: string;
  channels: Record<string, SlackChannelProbeSnapshot>;
}

export interface SettingsTopologyConnector {
  instanceId: string;
  employee: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  health: SlackRuntimeSnapshot["health"];
  healthCode: SlackRuntimeSnapshot["healthCode"] | null;
  healthObservedAt: string | null;
  checkedAt: string | null;
  allowlistedOperatorCount: number;
  settingsEntryEnabled: boolean;
  respondTo: { im: SlackRespondMode; mpim: SlackRespondMode; channel: SlackRespondMode };
  routerChannels: string[];
  routerChannelDetails: SettingsTopologyChannel[];
}

export interface SettingsTopologyChannel {
  channelId: string;
  channelName: string | null;
  verification: SettingsTopologyVerification;
}

export interface SettingsTopologyVerification {
  status: TopologyVerificationStatus;
  code: TopologyVerificationCode;
  checkedAt: string | null;
}

export interface SettingsTopologyRoute {
  id: string;
  kind: "primary" | "share";
  sourceConnectorInstanceId: string;
  sourceWorkspaceId: string | null;
  sourceWorkspaceName: string | null;
  routerChannels: string[];
  routerChannelDetails: SettingsTopologyChannel[];
  destinationConnectorInstanceId: string;
  workspaceId: string | null;
  workspaceName: string | null;
  projectId: string;
  projectName: string;
  channelId: string;
  channelName: string | null;
  verification: SettingsTopologyVerification;
}

export interface SettingsTopologyWarning {
  code: TopologyVerificationCode | "settings_url_unconfigured";
  severity: "warning" | "error";
  targetId: string;
  message: string;
}

export interface SettingsTopology {
  schemaVersion: 1;
  observedAt: string;
  connectors: SettingsTopologyConnector[];
  routes: SettingsTopologyRoute[];
  warnings: SettingsTopologyWarning[];
  history: Array<Pick<ConfigHistoryEntry, "ts" | "source" | "file" | "operatorAuthenticated">>;
  summary: { connectorCount: number; routeCount: number; warningCount: number };
}

interface SlackDeclaration {
  instanceId: string;
  employee: string | null;
  config: SlackConnectorConfig;
}

function allowlistCount(value: SlackConnectorConfig["allowFrom"]): number {
  if (Array.isArray(value)) return value.filter(Boolean).length;
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean).length;
  return 0;
}

function slackDeclarations(config: JinnConfig): SlackDeclaration[] {
  const declarations: SlackDeclaration[] = [];
  if (config.connectors?.slack) {
    declarations.push({ instanceId: "slack", employee: config.connectors.slack.employee ?? null, config: config.connectors.slack });
  }
  for (const instance of config.connectors?.instances ?? []) {
    if (instance.type !== "slack" || !instance.id) continue;
    declarations.push({
      instanceId: instance.id,
      employee: typeof instance.employee === "string" ? instance.employee : null,
      config: instance as unknown as SlackConnectorConfig,
    });
  }
  return declarations;
}

export interface SlackTopologyProbePlanEntry {
  instanceId: string;
  targets: Array<{ channelId: string; workspaceId?: string }>;
}

export function buildSlackTopologyProbePlan(config: JinnConfig): SlackTopologyProbePlanEntry[] {
  const plans = new Map<string, Map<string, { channelId: string; workspaceId?: string }>>();
  const add = (instanceId: string, channelId: string | undefined, workspaceId?: string) => {
    if (!channelId) return;
    let targets = plans.get(instanceId);
    if (!targets) {
      targets = new Map();
      plans.set(instanceId, targets);
    }
    const key = `${channelId}\u0000${workspaceId ?? ""}`;
    if (!targets.has(key)) targets.set(key, { channelId, ...(workspaceId ? { workspaceId } : {}) });
  };

  for (const source of slackDeclarations(config)) {
    const pipeline = source.config.meetingMinutesPipeline;
    if (!pipeline?.enabled) continue;
    for (const channelId of pipeline.routerChannels ?? []) add(source.instanceId, channelId);
    for (const destination of pipeline.destinations ?? []) add(source.instanceId, destination.channelId);
    for (const destination of pipeline.shareDestinations ?? []) {
      add(destination.connectorInstanceId, destination.channelId, destination.workspaceId);
    }
  }

  return Array.from(plans, ([instanceId, targets]) => ({ instanceId, targets: Array.from(targets.values()) }));
}

function defaultRespondMode(value: SlackRespondMode | undefined): SlackRespondMode {
  return value ?? "always";
}

function routeVerification(
  declarationExists: boolean,
  snapshot: SlackRuntimeSnapshot | undefined,
  channelId: string,
  declaredWorkspaceId?: string,
): SettingsTopologyVerification {
  if (!declarationExists) return { status: "error", code: "target_connector_missing", checkedAt: null };
  if (!snapshot) return { status: "unconfirmed", code: "runtime_snapshot_unavailable", checkedAt: null };
  if (snapshot.health !== "healthy") {
    return { status: "unconfirmed", code: "runtime_snapshot_unavailable", checkedAt: snapshot.checkedAt ?? null };
  }
  if (declaredWorkspaceId && !snapshot.workspaceId) {
    return { status: "unconfirmed", code: "workspace_identity_unavailable", checkedAt: snapshot.checkedAt ?? null };
  }
  if (declaredWorkspaceId && snapshot.workspaceId && declaredWorkspaceId !== snapshot.workspaceId) {
    return { status: "error", code: "workspace_mismatch", checkedAt: snapshot.checkedAt ?? null };
  }
  const channel = snapshot.channels[channelId];
  if (channel) return { status: channel.status, code: channel.code, checkedAt: channel.checkedAt };
  return { status: "unconfirmed", code: "runtime_snapshot_unavailable", checkedAt: snapshot.checkedAt ?? null };
}

function warningMessage(code: SettingsTopologyWarning["code"]): string {
  switch (code) {
    case "bot_not_member": return "原因: Botが対象チャンネルに参加していません。対応: SlackでBotを対象チャンネルに招待してください。";
    case "channel_archived": return "原因: 対象チャンネルはアーカイブされています。対応: 有効なチャンネルへ設定を変更してください。";
    case "permission_denied": return "原因: Botにチャンネル確認の権限がありません。対応: Slackアプリの権限と再インストール状況を確認してください。";
    case "channel_not_found": return "原因: 対象チャンネルをSlack上で確認できません。対応: チャンネルIDと接続workspaceを確認してください。";
    case "target_connector_missing": return "原因: 共有先connectorの宣言または起動を確認できません。対応: 共有先connectorの設定と起動状態を確認してください。";
    case "workspace_mismatch": return "原因: 設定したworkspaceとBotの接続先が一致しません。対応: 共有先workspace IDまたはconnector設定を修正してください。";
    case "workspace_identity_unavailable": return "原因: 接続先workspaceの認証済みIDを確認できません。対応: 共有先connectorの認証と起動状態を確認してください。";
    case "slack_probe_failed": return "原因: Slackへの確認処理が失敗しました。対応: Slack接続と権限を確認してから再取得してください。";
    case "runtime_snapshot_unavailable": return "原因: 実行中のconnectorから最新状態を取得できません。対応: connectorの起動状態を確認してから再取得してください。";
    case "settings_url_unconfigured": return "原因: 設定画面の公開HTTPS URLが未設定です。対応: credentialを含まない公開URLを設定してください。";
    case "channel_ready_by_static_checks": return "Slack上の配送先を静的確認しました。実投稿は未確認です。";
  }
}

export function buildSettingsTopology(input: {
  config: JinnConfig;
  observedAt?: string;
  runtimeSnapshots?: ReadonlyMap<string, SlackRuntimeSnapshot>;
  liveConnectorInstanceIds?: ReadonlySet<string>;
  history?: ConfigHistoryEntry[];
}): SettingsTopology {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const snapshots = input.runtimeSnapshots ?? new Map<string, SlackRuntimeSnapshot>();
  const declarations = slackDeclarations(input.config);
  const declarationIds = new Set(declarations.map((item) => item.instanceId));
  const liveConnectorInstanceIds = input.liveConnectorInstanceIds;
  const warnings: SettingsTopologyWarning[] = [];

  const connectors = declarations.map(({ instanceId, employee, config }) => {
    const snapshot = snapshots.get(instanceId);
    const count = allowlistCount(config.allowFrom);
    const settingsUrlConfigured = safeSettingsBaseUrl(config.settingsHome?.webBaseUrl) !== null;
    const settingsEntryEnabled = config.settingsHome?.enabled === true && count > 0 && settingsUrlConfigured;
    if (config.settingsHome?.enabled === true && !settingsUrlConfigured) {
      warnings.push({ code: "settings_url_unconfigured", severity: "warning", targetId: instanceId, message: warningMessage("settings_url_unconfigured") });
    }
    const routerChannels = [...(config.meetingMinutesPipeline?.routerChannels ?? [])];
    const routerChannelDetails = routerChannels.map((channelId) => {
      const verification = routeVerification(true, snapshot, channelId);
      const channelProbe = snapshot?.channels[channelId];
      if (verification.status !== "verified") {
        warnings.push({ code: verification.code, severity: verification.status === "error" ? "error" : "warning", targetId: channelId, message: warningMessage(verification.code) });
      }
      return { channelId, channelName: channelProbe?.name ?? null, verification };
    });
    return {
      instanceId,
      employee,
      workspaceId: snapshot?.workspaceId ?? null,
      workspaceName: snapshot?.workspaceName ?? null,
      health: snapshot?.health ?? "unknown",
      healthCode: snapshot?.healthCode ?? null,
      healthObservedAt: snapshot?.healthObservedAt ?? null,
      checkedAt: snapshot?.checkedAt ?? null,
      allowlistedOperatorCount: count,
      settingsEntryEnabled,
      respondTo: {
        im: defaultRespondMode(config.respondTo?.im),
        mpim: defaultRespondMode(config.respondTo?.mpim),
        channel: defaultRespondMode(config.respondTo?.channel),
      },
      routerChannels,
      routerChannelDetails,
    } satisfies SettingsTopologyConnector;
  });

  const routes: SettingsTopologyRoute[] = [];
  for (const source of declarations) {
    const pipeline = source.config.meetingMinutesPipeline;
    if (!pipeline?.enabled) continue;
    const routerChannels = [...(pipeline.routerChannels ?? [])];
    const sourceSnapshot = snapshots.get(source.instanceId);
    const routerChannelDetails = routerChannels.map((channelId) => {
      const channelProbe = sourceSnapshot?.channels[channelId];
      return {
        channelId,
        channelName: channelProbe?.name ?? null,
        verification: routeVerification(true, sourceSnapshot, channelId),
      };
    });
    for (const destination of pipeline.destinations ?? []) {
      const snapshot = sourceSnapshot;
      const verification = routeVerification(true, snapshot, destination.channelId);
      const channelProbe = snapshot?.channels[destination.channelId];
      routes.push({
        id: `primary:${source.instanceId}:${destination.projectId}:${destination.channelId}`,
        kind: "primary",
        sourceConnectorInstanceId: source.instanceId,
        sourceWorkspaceId: sourceSnapshot?.workspaceId ?? null,
        sourceWorkspaceName: sourceSnapshot?.workspaceName ?? null,
        routerChannels,
        routerChannelDetails,
        destinationConnectorInstanceId: source.instanceId,
        workspaceId: snapshot?.workspaceId ?? null,
        workspaceName: snapshot?.workspaceName ?? null,
        projectId: destination.projectId,
        projectName: destination.name,
        channelId: destination.channelId,
        channelName: channelProbe?.name ?? null,
        verification,
      });
      if (verification.status !== "verified") warnings.push({ code: verification.code, severity: verification.status === "error" ? "error" : "warning", targetId: destination.channelId, message: warningMessage(verification.code) });
    }
    for (const destination of pipeline.shareDestinations ?? []) {
      const targetExists = declarationIds.has(destination.connectorInstanceId)
        && (liveConnectorInstanceIds?.has(destination.connectorInstanceId) ?? true);
      const snapshot = snapshots.get(destination.connectorInstanceId);
      const verification = routeVerification(targetExists, snapshot, destination.channelId, destination.workspaceId);
      const channelProbe = snapshot?.channels[destination.channelId];
      routes.push({
        id: `share:${source.instanceId}:${destination.shareId}`,
        kind: "share",
        sourceConnectorInstanceId: source.instanceId,
        sourceWorkspaceId: sourceSnapshot?.workspaceId ?? null,
        sourceWorkspaceName: sourceSnapshot?.workspaceName ?? null,
        routerChannels,
        routerChannelDetails,
        destinationConnectorInstanceId: destination.connectorInstanceId,
        workspaceId: destination.workspaceId,
        workspaceName: snapshot?.workspaceName ?? null,
        projectId: destination.projectId,
        projectName: destination.name,
        channelId: destination.channelId,
        channelName: channelProbe?.name ?? null,
        verification,
      });
      if (verification.status !== "verified") warnings.push({ code: verification.code, severity: verification.status === "error" ? "error" : "warning", targetId: destination.shareId, message: warningMessage(verification.code) });
    }
  }

  const history = (input.history ?? []).map(({ ts, source, file, operatorAuthenticated }) => ({
    ts,
    source,
    file,
    ...(operatorAuthenticated === undefined ? {} : { operatorAuthenticated }),
  }));

  return {
    schemaVersion: 1,
    observedAt,
    connectors,
    routes,
    warnings,
    history,
    summary: { connectorCount: connectors.length, routeCount: routes.length, warningCount: warnings.length },
  };
}
