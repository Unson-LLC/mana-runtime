#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const write = (relative, content) => fs.writeFileSync(path.join(root, relative), content);

function replaceOnce(content, search, replacement, label) {
  const first = content.indexOf(search);
  if (first === -1) throw new Error(`${label}: search text not found`);
  if (content.indexOf(search, first + search.length) !== -1) throw new Error(`${label}: search text is not unique`);
  return content.slice(0, first) + replacement + content.slice(first + search.length);
}

function findMatching(text, openIndex, openChar, closeChar) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
    if (char === openChar) depth += 1;
    else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`matching ${closeChar} not found`);
}

function replaceFunction(content, name, replacement) {
  const marker = `export async function ${name}(`;
  const start = content.indexOf(marker);
  if (start === -1) throw new Error(`${name}: function not found`);
  const openBrace = content.indexOf("{", start + marker.length);
  const closeBrace = findMatching(content, openBrace, "{", "}");
  return content.slice(0, start) + replacement + content.slice(closeBrace + 1);
}

// Send a continuation envelope to the existing isolated development runner.
{
  const file = "packages/cloud-runtime/src/development-runner-client.ts";
  let content = read(file);
  if (!content.includes('from "./mana-development-control.js"')) {
    content = replaceOnce(
      content,
      'import type { DevelopmentTerminalAccountingPlan } from "./multitenancy/development-terminal-outbox.js";',
      'import type { DevelopmentTerminalAccountingPlan } from "./multitenancy/development-terminal-outbox.js";\nimport { parseManaDevelopmentControlRequest } from "./mana-development-control.js";',
      "development control import",
    );
  }
  if (!content.includes("const developmentControl = parseManaDevelopmentControlRequest(input.request);")) {
    content = replaceOnce(
      content,
      "  const payload = {\n    job_id: jobId,\n    request: input.request,",
      [
        "  const developmentControl = parseManaDevelopmentControlRequest(input.request);",
        "  const payload = {",
        "    job_id: jobId,",
        "    ...(developmentControl.mode === \"new\"",
        "      ? { request: developmentControl.request }",
        "      : developmentControl.mode === \"resume\"",
        "        ? { mode: \"resume\", story_id: developmentControl.storyId, answers: developmentControl.answers }",
        "        : { mode: \"continueGates\", story_id: developmentControl.storyId }),",
      ].join("\n"),
      "development runner payload",
    );
  }
  write(file, content);
}

// Render one-click continuation controls only when the callback contains a
// valid Story and a deterministic answer for every question.
{
  const file = "packages/cloud-runtime/src/development-callback.ts";
  let content = read(file);
  if (!content.includes('from "./mana-improvement-actions.js"')) {
    content = replaceOnce(
      content,
      'import { escapeUntrustedSlackMrkdwn } from "./slack-mrkdwn.js";',
      [
        'import { escapeUntrustedSlackMrkdwn } from "./slack-mrkdwn.js";',
        'import {',
        '  MANA_IMPROVEMENT_CONTINUE_GATES_ACTION_ID,',
        '  MANA_IMPROVEMENT_RESUME_RECOMMENDED_ACTION_ID,',
        '  buildContinueGatesActionValue,',
        '  buildResumeRecommendedActionValue,',
        '  recommendedDevelopmentAnswers,',
        '} from "./mana-improvement-actions.js";',
      ].join("\n"),
      "continuation action imports",
    );
  }

  const oldDecisionContext = [
    "    blocks.push({",
    "      type: \"context\",",
    "      elements: [{ type: \"mrkdwn\", text: \"現時点では安全のため停止しています。回答内容を添えてManaへ再依頼してください。\" }],",
    "    });",
  ].join("\n");
  if (content.includes(oldDecisionContext)) {
    const replacement = [
      "    const recommended = payload.story_id ? recommendedDevelopmentAnswers(questions) : undefined;",
      "    if (payload.story_id && recommended) {",
      "      blocks.push({",
      "        type: \"actions\",",
      "        elements: [{",
      "          type: \"button\",",
      "          style: \"primary\",",
      "          text: { type: \"plain_text\", text: \"Manaの推奨で続ける\" },",
      "          action_id: MANA_IMPROVEMENT_RESUME_RECOMMENDED_ACTION_ID,",
      "          value: buildResumeRecommendedActionValue({ storyId: payload.story_id, answers: recommended }),",
      "        }],",
      "      });",
      "      blocks.push({ type: \"context\", elements: [{ type: \"mrkdwn\", text: \"クリックすると同じStoryを回答付きで再開します。merge・deployは行いません。\" }] });",
      "    } else {",
      "      blocks.push({",
      "        type: \"context\",",
      "        elements: [{ type: \"mrkdwn\", text: \"Manaが安全に選べる推奨案がないため停止しています。内容を補足して新しい改善依頼を出してください。\" }],",
      "      });",
      "    }",
    ].join("\n");
    content = replaceOnce(content, oldDecisionContext, replacement, "recommended decision action");
  }

  const needsInputTechnical = "    if (technical) blocks.push({ type: \"context\", elements: [{ type: \"mrkdwn\", text: technical }] });\n    return { text, blocks };\n  }\n\n  const timedOut";
  if (content.includes(needsInputTechnical) && !content.includes("buildContinueGatesActionValue(payload.story_id)")) {
    const replacement = [
      "    if (payload.story_id) {",
      "      blocks.push({",
      "        type: \"actions\",",
      "        elements: [{",
      "          type: \"button\",",
      "          style: \"primary\",",
      "          text: { type: \"plain_text\", text: \"続行して確認を解消させる\" },",
      "          action_id: MANA_IMPROVEMENT_CONTINUE_GATES_ACTION_ID,",
      "          value: buildContinueGatesActionValue(payload.story_id),",
      "        }],",
      "      });",
      "    }",
      "    if (technical) blocks.push({ type: \"context\", elements: [{ type: \"mrkdwn\", text: technical }] });",
      "    return { text, blocks };",
      "  }",
      "",
      "  const timedOut",
    ].join("\n");
    content = replaceOnce(content, needsInputTechnical, replacement, "Gate continuation action");
  }
  write(file, content);
}

// Handle signed Block Kit continuation clicks in the same endpoint as the
// improvement modal. The action token is validated and converted to the
// internal control envelope; Slack cannot inject arbitrary slash commands.
{
  const file = "packages/cloud-runtime/src/mana-improvement-slack.ts";
  let content = read(file);
  if (!content.includes('from "./mana-improvement-actions.js"')) {
    content = replaceOnce(
      content,
      '} from "./mana-improvement-request.js";',
      [
        '} from "./mana-improvement-request.js";',
        'import {',
        '  MANA_IMPROVEMENT_CONTINUE_GATES_ACTION_ID,',
        '  MANA_IMPROVEMENT_RESUME_RECOMMENDED_ACTION_ID,',
        '  parseManaImprovementContinuationAction,',
        '} from "./mana-improvement-actions.js";',
        'import {',
        '  serializeManaDevelopmentContinueGates,',
        '  serializeManaDevelopmentResume,',
        '} from "./mana-development-control.js";',
      ].join("\n"),
      "interaction continuation imports",
    );
  }

  if (!content.includes("export interface ManaImprovementContinuationSubmission")) {
    content = replaceOnce(
      content,
      "export interface ManaImprovementSubmission {",
      [
        "export interface ManaImprovementContinuationSubmission {",
        "  eventId: string;",
        "  appId: string;",
        "  workspaceId: string;",
        "  channelId: string;",
        "  requesterId: string;",
        "  threadTs: string;",
        "  controlRequest: string;",
        "  receivedAt: string;",
        "}",
        "",
        "export interface ManaImprovementSubmission {",
      ].join("\n"),
      "continuation submission interface",
    );
  }

  content = content.replace(
    "  accept(submission: ManaImprovementSubmission): Promise<void>;\n  defer?",
    "  accept(submission: ManaImprovementSubmission): Promise<void>;\n  continueDevelopment?(submission: ManaImprovementContinuationSubmission): Promise<void>;\n  defer?",
  );
  content = content.replace(
    "  onDeferredError?(error: unknown, submission: ManaImprovementSubmission): void;",
    "  onDeferredError?(error: unknown, submission: ManaImprovementSubmission | ManaImprovementContinuationSubmission): void;",
  );

  const functionReplacement = `export async function handleManaImprovementInteraction(\n  request: Request,\n  options: ManaImprovementInteractionOptions,\n): Promise<Response | null> {\n  let body: string;\n  try {\n    body = await readSlackRequestBody(request);\n  } catch (error) {\n    const rejected = slackRequestBodyErrorResponse(error);\n    if (rejected) return rejected;\n    throw error;\n  }\n  const timestamp = request.headers.get(\"x-slack-request-timestamp\") ?? \"\";\n  const signature = request.headers.get(\"x-slack-signature\") ?? \"\";\n  const verified = await verifySlackRequest({\n    body, timestamp, signature, signingSecret: options.signingSecret, nowMs: options.nowMs,\n  });\n  if (!verified) return response(\"slack_signature_invalid\", 401);\n\n  const encoded = new URLSearchParams(body).get(\"payload\");\n  if (!encoded) return response(\"slack_interaction_invalid\", 400);\n  let payload: Record<string, unknown>;\n  try {\n    const parsed = JSON.parse(encoded) as unknown;\n    if (!parsed || typeof parsed !== \"object\" || Array.isArray(parsed)) return response(\"slack_interaction_invalid\", 400);\n    payload = parsed as Record<string, unknown>;\n  } catch {\n    return response(\"slack_interaction_invalid\", 400);\n  }\n\n  const object = (value: unknown): Record<string, unknown> =>\n    value && typeof value === \"object\" && !Array.isArray(value) ? value as Record<string, unknown> : {};\n  const team = object(payload.team);\n  const user = object(payload.user);\n  const workspaceId = typeof team.id === \"string\" ? team.id : \"\";\n  const requesterId = typeof user.id === \"string\" ? user.id : \"\";\n  const appId = typeof payload.api_app_id === \"string\" ? payload.api_app_id : \"\";\n  if (!SLACK_ID_RE.test(workspaceId) || !SLACK_ID_RE.test(requesterId)\n    || (options.expectedAppId && appId !== options.expectedAppId)) {\n    return response(\"mana_improvement_scope_invalid\", 403);\n  }\n\n  const view = object(payload.view);\n  if (view.callback_id === MANA_IMPROVEMENT_VIEW_CALLBACK_ID) {\n    const viewId = typeof view.id === \"string\" ? view.id : \"\";\n    const metadata = parseMetadata(view.private_metadata);\n    if (!metadata || metadata.workspaceId !== workspaceId || metadata.requesterId !== requesterId || !viewId) {\n      return response(\"mana_improvement_scope_invalid\", 403);\n    }\n    const placement = options.placements.find((candidate) => candidate.channelId === metadata.channelId);\n    if (!placement?.allowedUserIds.includes(requesterId)) return response(\"mana_improvement_forbidden\", 403);\n\n    const state = object(view.state);\n    const values = object(state.values) as Record<string, Record<string, unknown>>;\n    let improvement: ManaImprovementRequest;\n    try {\n      improvement = extractManaImprovementRequestFromView(values);\n    } catch (error) {\n      const code = error instanceof Error ? error.message : \"mana_improvement_invalid\";\n      const blockId = code === \"mana_improvement_outcome_required\"\n        ? \"mana_improvement_outcome\" : \"mana_improvement_problem\";\n      return Response.json({ response_action: \"errors\", errors: { [blockId]: \"必須項目を入力してください。\" } });\n    }\n\n    const receivedAt = new Date(options.nowMs ?? Date.now()).toISOString();\n    const submission: ManaImprovementSubmission = {\n      eventId: await interactionEventId(body), appId, workspaceId, channelId: metadata.channelId,\n      requesterId, interactionThreadTs: metadata.interactionTs, request: improvement, receivedAt,\n    };\n    const work = options.accept(submission).catch((error) => options.onDeferredError?.(error, submission));\n    if (options.defer) options.defer(work); else await work;\n    return new Response(\"\", { status: 200 });\n  }\n\n  const actions = Array.isArray(payload.actions) ? payload.actions : [];\n  const action = actions.length === 1 ? object(actions[0]) : {};\n  const actionId = typeof action.action_id === \"string\" ? action.action_id : \"\";\n  if (actionId !== MANA_IMPROVEMENT_RESUME_RECOMMENDED_ACTION_ID\n    && actionId !== MANA_IMPROVEMENT_CONTINUE_GATES_ACTION_ID) return null;\n  if (!options.continueDevelopment) return response(\"mana_improvement_continuation_unavailable\", 503);\n\n  const channel = object(payload.channel);\n  const container = object(payload.container);\n  const message = object(payload.message);\n  const channelId = typeof channel.id === \"string\" ? channel.id\n    : typeof container.channel_id === \"string\" ? container.channel_id : \"\";\n  const threadTs = typeof message.thread_ts === \"string\" ? message.thread_ts\n    : typeof container.thread_ts === \"string\" ? container.thread_ts\n      : typeof message.ts === \"string\" ? message.ts : \"\";\n  if (!SLACK_ID_RE.test(channelId) || !TIMESTAMP_RE.test(threadTs)) {\n    return response(\"mana_improvement_scope_invalid\", 403);\n  }\n  const placement = options.placements.find((candidate) => candidate.channelId === channelId);\n  if (!placement?.allowedUserIds.includes(requesterId)) return response(\"mana_improvement_forbidden\", 403);\n\n  let continuation;\n  try { continuation = parseManaImprovementContinuationAction(action.value); }\n  catch { return response(\"mana_improvement_action_invalid\", 400); }\n  if ((actionId === MANA_IMPROVEMENT_RESUME_RECOMMENDED_ACTION_ID && continuation.kind !== \"resume_recommended\")\n    || (actionId === MANA_IMPROVEMENT_CONTINUE_GATES_ACTION_ID && continuation.kind !== \"continue_gates\")) {\n    return response(\"mana_improvement_action_invalid\", 400);\n  }\n  const controlRequest = continuation.kind === \"resume_recommended\"\n    ? serializeManaDevelopmentResume({ storyId: continuation.storyId, answers: continuation.answers })\n    : serializeManaDevelopmentContinueGates(continuation.storyId);\n  const eventDigest = createHash(\"sha256\").update([\n    workspaceId, channelId, threadTs, requesterId, continuation.kind, continuation.storyId,\n  ].join(\":\")).digest(\"hex\").slice(0, 32);\n  const submission: ManaImprovementContinuationSubmission = {\n    eventId: \`mana_improvement_continue_\${eventDigest}\`, appId, workspaceId, channelId, requesterId,\n    threadTs, controlRequest, receivedAt: new Date(options.nowMs ?? Date.now()).toISOString(),\n  };\n  const work = options.continueDevelopment(submission).catch((error) => options.onDeferredError?.(error, submission));\n  if (options.defer) options.defer(work); else await work;\n  return new Response(\"\", { status: 200 });\n}\n`;
  content = replaceFunction(content, "handleManaImprovementInteraction", functionReplacement);
  write(file, content);
}

// Queue the validated continuation envelope through the same canonical tenant
// resolution and idempotency path as a new improvement request.
{
  const file = "packages/cloud-runtime/src/index.ts";
  let content = read(file);
  const marker = "        accept: async (submission) => {";
  const start = content.indexOf(marker);
  if (start === -1) throw new Error("improvement accept wiring not found");
  const interactionEnd = content.indexOf("      });\n      if (improvementResponse)", start);
  if (interactionEnd === -1) throw new Error("improvement interaction options end not found");
  const optionsSegment = content.slice(start, interactionEnd);
  if (!optionsSegment.includes("continueDevelopment:")) {
    const continuation = [
      "        continueDevelopment: async (submission) => {",
      "          await enqueueManaDevelopmentEvent({",
      "            eventId: submission.eventId,",
      "            workspaceId: submission.workspaceId,",
      "            channelId: submission.channelId,",
      "            threadTs: submission.threadTs,",
      "            messageTs: submission.threadTs,",
      "            userId: submission.requesterId,",
      "            eventType: \"app_mention\",",
      "            text: `/develop ${submission.controlRequest}`,",
      "            receivedAt: submission.receivedAt,",
      "          });",
      "        },",
    ].join("\n");
    content = content.slice(0, interactionEnd) + continuation + "\n" + content.slice(interactionEnd);
  }
  write(file, content);
}

// Extend focused tests for action parsing, one-click Queue continuation, and
// the visible controls in result cards.
{
  const file = "packages/cloud-runtime/src/__tests__/mana-improvement-slack.test.ts";
  let content = read(file);
  if (!content.includes("queues a recommended same-Story continuation")) {
    const insertion = `\n  it(\"queues a recommended same-Story continuation with a deterministic event id\", async () => {\n    const continueDevelopment = vi.fn(async () => undefined);\n    const actionValue = JSON.stringify({\n      version: 1, kind: \"resume_recommended\", storyId: \"story-slack-20260821010101-abcd1234\",\n      answers: [{ id: \"display\", answer: \"全員を表示\" }],\n    });\n    const response = await handleManaImprovementInteraction(signedRequest({\n      type: \"block_actions\", api_app_id: \"A1\", team: { id: \"T1\" }, user: { id: \"U1\" },\n      channel: { id: \"C1\" }, container: { channel_id: \"C1\", thread_ts: \"1.234\" },\n      message: { ts: \"2.0\", thread_ts: \"1.234\" },\n      actions: [{ action_id: \"mana_improvement_resume_recommended\", value: actionValue }],\n    }), {\n      signingSecret: secret, expectedAppId: \"A1\",\n      placements: [{ channelId: \"C1\", allowedUserIds: [\"U1\"] }], nowMs,\n      accept: vi.fn(), continueDevelopment,\n    });\n    expect(response?.status).toBe(200);\n    expect(continueDevelopment).toHaveBeenCalledWith(expect.objectContaining({\n      workspaceId: \"T1\", channelId: \"C1\", requesterId: \"U1\", threadTs: \"1.234\",\n      eventId: expect.stringMatching(/^mana_improvement_continue_[a-f0-9]{32}$/),\n      controlRequest: expect.stringMatching(/^\\[mana_development_control_v1\\]/),\n    }));\n  });\n\n  it(\"rejects a continuation click outside the authorized channel\", async () => {\n    const continueDevelopment = vi.fn();\n    const response = await handleManaImprovementInteraction(signedRequest({\n      type: \"block_actions\", api_app_id: \"A1\", team: { id: \"T1\" }, user: { id: \"U1\" },\n      channel: { id: \"C2\" }, container: { channel_id: \"C2\", thread_ts: \"1.234\" },\n      message: { ts: \"2.0\", thread_ts: \"1.234\" },\n      actions: [{ action_id: \"mana_improvement_continue_gates\", value: JSON.stringify({\n        version: 1, kind: \"continue_gates\", storyId: \"story-slack-20260821010101-abcd1234\",\n      }) }],\n    }), {\n      signingSecret: secret, expectedAppId: \"A1\",\n      placements: [{ channelId: \"C1\", allowedUserIds: [\"U1\"] }], nowMs,\n      accept: vi.fn(), continueDevelopment,\n    });\n    expect(response?.status).toBe(403);\n    expect(continueDevelopment).not.toHaveBeenCalled();\n  });\n`;
    const close = content.lastIndexOf("\n});");
    content = content.slice(0, close) + insertion + content.slice(close);
  }
  write(file, content);
}

{
  const file = "packages/cloud-runtime/src/__tests__/development-callback-ux.test.ts";
  let content = read(file);
  if (!content.includes("mana_improvement_resume_recommended")) {
    content = content.replace(
      '    expect(JSON.stringify(message.blocks)).not.toContain("Development: needs_decision");',
      '    expect(JSON.stringify(message.blocks)).not.toContain("Development: needs_decision");\n    expect(JSON.stringify(message.blocks)).toContain("mana_improvement_resume_recommended");',
    );
  }
  if (!content.includes("mana_improvement_continue_gates")) {
    content = content.replace(
      '    expect(JSON.stringify(message.blocks)).toContain("残っている確認");',
      '    expect(JSON.stringify(message.blocks)).toContain("残っている確認");\n    expect(JSON.stringify(message.blocks)).toContain("mana_improvement_continue_gates");',
    );
  }
  write(file, content);
}

console.log("Mana improvement same-Story continuation completed successfully.");
