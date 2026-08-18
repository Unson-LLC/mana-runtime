import type { SlackQueueEvent } from "./types.js";
import type { MeetingMinutesRedo, MeetingMinutesSelection } from "./meeting-minutes-contracts.js";
import { isMeetingMinutesRouterFileEvent } from "./meeting-minutes-entrypoints.js";

interface IntakeStatus {
  allowed: boolean;
  intakePaused: boolean;
  activeRuns: unknown[];
}

interface IntakeAdminDependencies {
  authorize(request: Request): Promise<boolean>;
  setPaused(paused: boolean): Promise<void>;
  status(): Promise<IntakeStatus>;
}

interface IntakeQueueMessage {
  body: SlackQueueEvent;
  ack(): void;
  retry(): void;
}

interface IntakeQueueDependencies {
  isPaused(): Promise<boolean>;
  notify(channelId: string, threadTs: string): Promise<void>;
  logPaused?(eventId: string): void;
  logNotificationFailure?(eventId: string, error: unknown): void;
}

interface IntakeRouterQueueDependencies extends IntakeQueueDependencies {
  enabled: boolean;
  routerChannelId: string;
  logDisabled?(eventId: string): void;
}

export type MeetingMinutesRouterQueueGate = "not_router_file" | "ready" | "blocked";
export type MeetingMinutesCommandQueueGate = "ready" | "blocked";

type MeetingMinutesQueuedCommand = MeetingMinutesSelection | MeetingMinutesRedo;

interface IntakeCommandQueueMessage {
  body: MeetingMinutesQueuedCommand;
  ack(): void;
  retry(): void;
}

interface IntakeCommandQueueDependencies {
  enabled: boolean;
  isPaused(): Promise<boolean>;
  notify(command: MeetingMinutesQueuedCommand): Promise<void>;
  logPaused?(command: MeetingMinutesQueuedCommand): void;
  logDisabled?(command: MeetingMinutesQueuedCommand): void;
  logNotificationFailure?(command: MeetingMinutesQueuedCommand, error: unknown): void;
}

interface IntakeIngressDependencies {
  isPaused(): Promise<boolean>;
  notify(channelId: string, threadTs: string): Promise<void>;
  defer(work: Promise<void>): void;
  logPaused?(eventId: string): void;
  logNotificationFailure?(eventId: string, error: unknown): void;
}

export async function handleMeetingMinutesIntakeAdminRequest(
  request: Request,
  dependencies: IntakeAdminDependencies,
): Promise<Response> {
  if (!(await dependencies.authorize(request))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!payload || typeof payload !== "object" || typeof (payload as { paused?: unknown }).paused !== "boolean") {
    return Response.json({ error: "invalid_intake_state" }, { status: 400 });
  }
  await dependencies.setPaused((payload as { paused: boolean }).paused);
  return Response.json(await dependencies.status());
}

export async function consumeMeetingMinutesIntakePause(
  message: IntakeQueueMessage,
  dependencies: IntakeQueueDependencies,
): Promise<boolean> {
  if (!(await dependencies.isPaused())) return false;

  dependencies.logPaused?.(message.body.eventId);
  try {
    await dependencies.notify(message.body.channelId, message.body.threadTs);
  } catch (error) {
    dependencies.logNotificationFailure?.(message.body.eventId, error);
  }
  message.ack();
  return true;
}

export async function gateMeetingMinutesRouterQueueMessage(
  message: IntakeQueueMessage,
  dependencies: IntakeRouterQueueDependencies,
): Promise<MeetingMinutesRouterQueueGate> {
  if (!isMeetingMinutesRouterFileEvent(message.body, dependencies.routerChannelId)) {
    return "not_router_file";
  }

  if (await dependencies.isPaused()) {
    dependencies.logPaused?.(message.body.eventId);
  } else if (!dependencies.enabled) {
    dependencies.logDisabled?.(message.body.eventId);
  } else {
    return "ready";
  }

  try {
    await dependencies.notify(message.body.channelId, message.body.threadTs);
  } catch (error) {
    dependencies.logNotificationFailure?.(message.body.eventId, error);
  }
  message.ack();
  return "blocked";
}

/**
 * Ends a destination-selection or redo command deterministically while intake is
 * paused/disabled. These commands may already be in Queue when an operator
 * pauses intake, so retrying them would survive the drain and loop after the
 * stopped Worker is deployed.
 */
export async function gateMeetingMinutesCommandQueueMessage(
  message: IntakeCommandQueueMessage,
  dependencies: IntakeCommandQueueDependencies,
): Promise<MeetingMinutesCommandQueueGate> {
  if (await dependencies.isPaused()) {
    dependencies.logPaused?.(message.body);
  } else if (!dependencies.enabled) {
    dependencies.logDisabled?.(message.body);
  } else {
    return "ready";
  }

  try {
    await dependencies.notify(message.body);
  } catch (error) {
    dependencies.logNotificationFailure?.(message.body, error);
  }
  message.ack();
  return "blocked";
}

export async function interceptMeetingMinutesIntakePause(
  event: SlackQueueEvent,
  dependencies: IntakeIngressDependencies,
): Promise<boolean> {
  if (!(await dependencies.isPaused())) return false;

  dependencies.logPaused?.(event.eventId);
  dependencies.defer(dependencies.notify(event.channelId, event.threadTs).catch((error) => {
    dependencies.logNotificationFailure?.(event.eventId, error);
  }));
  return true;
}
