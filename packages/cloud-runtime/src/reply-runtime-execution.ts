import type { RuntimeTriageDecision } from "./runtime-triage.js";
import {
  processReplyEvent,
  ReplyPipelineError,
  type ReplyPipelineOptions,
  type ReplyProcessResult,
} from "./reply-pipeline.js";
import {
  runWithReplyTaskSearchBinding,
  type ReplyTaskSearchBindingConfig,
  type ReplyTaskSearchOptions,
} from "./runtime-config.js";
import type { RequesterIdentity } from "./requester-identity.js";
import type { SlackUserProfile } from "./slack-user-profile.js";
import type { SlackQueueEvent } from "./types.js";
import type { WorkspaceFs } from "./workspace-store.js";

/**
 * Identity and context prepared by the caller before the reply pipeline runs.
 *
 * The caller is deliberately required to provide the canonical person id. This
 * shared execution path never reconstructs an actor from Slack text or falls
 * back to legacy requester bindings; Company Authority callers can therefore
 * pass their accepted canonical context without crossing an older resolver.
 */
export interface PreparedReplyRequester {
  requesterIdentity: RequesterIdentity;
  requesterProfile: SlackUserProfile;
  graphContext: string;
  taskWriteEnabled: boolean;
  taskWriteCapability?: string;
}

/** Options that are common to every caller of the real reply pipeline. */
export type ReplyRuntimeBaseOptions = Omit<ReplyPipelineOptions,
  | "taskSearchEnabled"
  | "taskWriteEnabled"
  | "taskWriteCapability"
  | "requesterIdentityBindings"
  | "requesterIdentity"
  | "requesterProfile"
  | "graphContext"
  | "triage"
>;

export interface ReplyRuntimeExecutionInput {
  fs: WorkspaceFs;
  event: SlackQueueEvent;
  taskSearch: ReplyTaskSearchBindingConfig;
  prepareRequester(input: {
    event: SlackQueueEvent;
    taskSearch: ReplyTaskSearchOptions;
  }): Promise<PreparedReplyRequester>;
  options: ReplyRuntimeBaseOptions;
  triage?(event: SlackQueueEvent, requester: PreparedReplyRequester): Promise<RuntimeTriageDecision>;
}

function validatePreparedRequester(
  event: SlackQueueEvent,
  requester: PreparedReplyRequester,
): void {
  const userId = event.userId;
  const requesterIdentity = requester?.requesterIdentity;
  const requesterProfile = requester?.requesterProfile;
  if (!userId
    || !requesterIdentity
    || typeof requesterIdentity.slackUserId !== "string"
    || typeof requesterIdentity.personId !== "string"
    || requesterIdentity.slackUserId !== userId
    || !requesterIdentity.personId.trim()
    || !requesterProfile
    || typeof requesterProfile.userId !== "string"
    || requesterProfile.userId !== userId
    || typeof requester.graphContext !== "string"
    || typeof requester.taskWriteEnabled !== "boolean"
    || (requester.taskWriteEnabled
      && (typeof requester.taskWriteCapability !== "string" || !requester.taskWriteCapability.trim()))) {
    throw new ReplyPipelineError("requester_identity_not_found");
  }
}

/**
 * Runs the shared, real T0 reply path after the caller has prepared its
 * authenticated requester context. The task-search binding is resolved here,
 * then the canonical requester is projected into `processReplyEvent`, which
 * owns judgment, Claude execution, Slack delivery, and completion persistence.
 */
export function executeReplyRuntime(
  input: ReplyRuntimeExecutionInput,
): Promise<ReplyProcessResult> {
  return runWithReplyTaskSearchBinding(input.event, input.taskSearch, async (taskSearch) => {
    const requester = await input.prepareRequester({ event: input.event, taskSearch });
    validatePreparedRequester(input.event, requester);
    const options: ReplyPipelineOptions = {
      ...input.options,
      taskSearchEnabled: taskSearch.taskSearchEnabled,
      taskWriteEnabled: requester.taskWriteEnabled,
      ...(requester.taskWriteCapability
        ? { taskWriteCapability: requester.taskWriteCapability }
        : {}),
      requesterIdentity: requester.requesterIdentity,
      requesterProfile: requester.requesterProfile,
      graphContext: requester.graphContext,
      ...(input.triage
        ? { triage: (event) => input.triage!(event, requester) }
        : {}),
    };
    return processReplyEvent(input.fs, input.event, options);
  });
}
