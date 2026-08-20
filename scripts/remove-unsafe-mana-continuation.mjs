#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const write = (relative, content) => fs.writeFileSync(path.join(root, relative), content);

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

// Fresh Containers do not preserve the old worktree, so a control envelope
// claiming same-Story resume is unsafe until a durable artifact boundary exists.
{
  const file = "packages/cloud-runtime/src/development-runner-client.ts";
  let content = read(file);
  content = content.replace('import { parseManaDevelopmentControlRequest } from "./mana-development-control.js";\n', "");
  content = content.replace(
    /  const developmentControl = parseManaDevelopmentControlRequest\(input\.request\);\n  const payload = \{\n    job_id: jobId,\n    \.\.\.\(developmentControl\.mode === "new"[\s\S]*?: \{ mode: "continueGates", story_id: developmentControl\.storyId \}\),/,
    "  const payload = {\n    job_id: jobId,\n    request: input.request,",
  );
  write(file, content);
}

// Remove action buttons that would imply a continuation contract the Cloud
// runtime cannot currently satisfy.
{
  const file = "packages/cloud-runtime/src/development-callback.ts";
  let content = read(file);
  content = content.replace(
    /import \{\n  MANA_IMPROVEMENT_CONTINUE_GATES_ACTION_ID,[\s\S]*?\} from "\.\/mana-improvement-actions\.js";\n/,
    "",
  );
  content = content.replace(
    /    const recommended = payload\.story_id \? recommendedDevelopmentAnswers\(questions\) : undefined;[\s\S]*?    \}\n    if \(technical\)/,
    [
      "    blocks.push({",
      "      type: \"context\",",
      "      elements: [{ type: \"mrkdwn\", text: \"現時点では安全のため停止しています。Cloud版で同じStoryを再開するにはdurable worktree artifactが必要です。\" }],",
      "    });",
      "    if (technical)",
    ].join("\n"),
  );
  content = content.replace(
    /    if \(payload\.story_id\) \{\n      blocks\.push\(\{\n        type: "actions",[\s\S]*?      \}\);\n    \}\n    if \(technical\)/,
    "    if (technical)",
  );
  write(file, content);
}

// Restore the modal-only interaction handler. Other Block Kit interactions
// continue to fall through to the existing meeting/task handler.
{
  const file = "packages/cloud-runtime/src/mana-improvement-slack.ts";
  let content = read(file);
  content = content.replace(
    /import \{\n  MANA_IMPROVEMENT_CONTINUE_GATES_ACTION_ID,[\s\S]*?\} from "\.\/mana-improvement-actions\.js";\n/,
    "",
  );
  content = content.replace(
    /import \{\n  serializeManaDevelopmentContinueGates,[\s\S]*?\} from "\.\/mana-development-control\.js";\n/,
    "",
  );
  content = content.replace(
    /export interface ManaImprovementContinuationSubmission \{[\s\S]*?\}\n\n/,
    "",
  );
  content = content.replace(
    "  continueDevelopment?(submission: ManaImprovementContinuationSubmission): Promise<void>;\n",
    "",
  );
  content = content.replace(
    "  onDeferredError?(error: unknown, submission: ManaImprovementSubmission | ManaImprovementContinuationSubmission): void;",
    "  onDeferredError?(error: unknown, submission: ManaImprovementSubmission): void;",
  );

  const functionReplacement = `export async function handleManaImprovementInteraction(\n  request: Request,\n  options: ManaImprovementInteractionOptions,\n): Promise<Response | null> {\n  let body: string;\n  try {\n    body = await readSlackRequestBody(request);\n  } catch (error) {\n    const rejected = slackRequestBodyErrorResponse(error);\n    if (rejected) return rejected;\n    throw error;\n  }\n  const timestamp = request.headers.get(\"x-slack-request-timestamp\") ?? \"\";\n  const signature = request.headers.get(\"x-slack-signature\") ?? \"\";\n  const verified = await verifySlackRequest({\n    body, timestamp, signature, signingSecret: options.signingSecret, nowMs: options.nowMs,\n  });\n  if (!verified) return response(\"slack_signature_invalid\", 401);\n\n  const encoded = new URLSearchParams(body).get(\"payload\");\n  if (!encoded) return response(\"slack_interaction_invalid\", 400);\n  let payload: Record<string, unknown>;\n  try {\n    const parsed = JSON.parse(encoded) as unknown;\n    if (!parsed || typeof parsed !== \"object\" || Array.isArray(parsed)) return response(\"slack_interaction_invalid\", 400);\n    payload = parsed as Record<string, unknown>;\n  } catch {\n    return response(\"slack_interaction_invalid\", 400);\n  }\n  const view = payload.view && typeof payload.view === \"object\" && !Array.isArray(payload.view)\n    ? payload.view as Record<string, unknown> : undefined;\n  if (view?.callback_id !== MANA_IMPROVEMENT_VIEW_CALLBACK_ID) return null;\n\n  const team = payload.team && typeof payload.team === \"object\" && !Array.isArray(payload.team)\n    ? payload.team as Record<string, unknown> : {};\n  const user = payload.user && typeof payload.user === \"object\" && !Array.isArray(payload.user)\n    ? payload.user as Record<string, unknown> : {};\n  const workspaceId = typeof team.id === \"string\" ? team.id : \"\";\n  const requesterId = typeof user.id === \"string\" ? user.id : \"\";\n  const appId = typeof payload.api_app_id === \"string\" ? payload.api_app_id : \"\";\n  const viewId = typeof view.id === \"string\" ? view.id : \"\";\n  const metadata = parseMetadata(view.private_metadata);\n  if (!metadata || metadata.workspaceId !== workspaceId || metadata.requesterId !== requesterId\n    || !viewId || !SLACK_ID_RE.test(workspaceId) || !SLACK_ID_RE.test(requesterId)\n    || (options.expectedAppId && appId !== options.expectedAppId)) {\n    return response(\"mana_improvement_scope_invalid\", 403);\n  }\n  const placement = options.placements.find((candidate) => candidate.channelId === metadata.channelId);\n  if (!placement?.allowedUserIds.includes(requesterId)) return response(\"mana_improvement_forbidden\", 403);\n\n  const state = view.state && typeof view.state === \"object\" && !Array.isArray(view.state)\n    ? view.state as { values?: unknown } : {};\n  const values = state.values && typeof state.values === \"object\" && !Array.isArray(state.values)\n    ? state.values as Record<string, Record<string, unknown>> : {};\n  let improvement: ManaImprovementRequest;\n  try {\n    improvement = extractManaImprovementRequestFromView(values);\n  } catch (error) {\n    const code = error instanceof Error ? error.message : \"mana_improvement_invalid\";\n    const blockId = code === \"mana_improvement_outcome_required\"\n      ? \"mana_improvement_outcome\" : \"mana_improvement_problem\";\n    return Response.json({ response_action: \"errors\", errors: { [blockId]: \"必須項目を入力してください。\" } });\n  }\n\n  const receivedAt = new Date(options.nowMs ?? Date.now()).toISOString();\n  const submission: ManaImprovementSubmission = {\n    eventId: await interactionEventId(body), appId, workspaceId, channelId: metadata.channelId, requesterId,\n    interactionThreadTs: metadata.interactionTs, request: improvement, receivedAt,\n  };\n  const work: Promise<void> = options.accept(submission).catch((error) => {\n    options.onDeferredError?.(error, submission);\n  });\n  if (options.defer) options.defer(work); else await work;\n  return new Response(\"\", { status: 200 });\n}\n`;
  content = replaceFunction(content, "handleManaImprovementInteraction", functionReplacement);
  write(file, content);
}

// Remove continuation Queue wiring if a prior temporary workflow applied it.
{
  const file = "packages/cloud-runtime/src/index.ts";
  let content = read(file);
  content = content.replace(
    /        continueDevelopment: async \(submission\) => \{[\s\S]*?        \},\n(?=      \}\);\n      if \(improvementResponse\))/,
    "",
  );
  write(file, content);
}

// Remove focused expectations and tests for the unsafe button path.
{
  const file = "packages/cloud-runtime/src/__tests__/development-callback-ux.test.ts";
  let content = read(file);
  content = content.replace('    expect(JSON.stringify(message.blocks)).toContain("mana_improvement_resume_recommended");\n', "");
  content = content.replace('    expect(JSON.stringify(message.blocks)).toContain("mana_improvement_continue_gates");\n', "");
  write(file, content);
}

{
  const file = "packages/cloud-runtime/src/__tests__/mana-improvement-slack.test.ts";
  let content = read(file);
  content = content.replace(
    /\n  it\("queues a recommended same-Story continuation[\s\S]*?\n  it\("rejects a continuation click outside the authorized channel[\s\S]*?\n  \}\);\n/,
    "\n",
  );
  write(file, content);
}

console.log("Unsafe same-Story continuation controls removed successfully.");
