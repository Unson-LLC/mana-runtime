#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function write(relative, content) {
  fs.writeFileSync(path.join(root, relative), content);
}

function fail(message) {
  throw new Error(`[mana-improvement-ux] ${message}`);
}

function replaceOnce(content, search, replacement, label) {
  const first = content.indexOf(search);
  if (first === -1) fail(`${label}: search text not found`);
  if (content.indexOf(search, first + search.length) !== -1) fail(`${label}: search text is not unique`);
  return content.slice(0, first) + replacement + content.slice(first + search.length);
}

function replaceRegexOnce(content, regex, replacement, label) {
  const matches = [...content.matchAll(new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`))];
  if (matches.length !== 1) fail(`${label}: expected one match, found ${matches.length}`);
  return content.replace(regex, replacement);
}

function findMatching(text, openIndex, openChar, closeChar) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === openChar) depth += 1;
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  fail(`matching ${closeChar} not found`);
}

function transformFunction(content, name, transform) {
  const marker = `export async function ${name}(`;
  const start = content.indexOf(marker);
  if (start === -1) fail(`${name}: function not found`);
  const openBrace = content.indexOf("{", start + marker.length);
  if (openBrace === -1) fail(`${name}: opening brace not found`);
  const closeBrace = findMatching(content, openBrace, "{", "}");
  const segment = content.slice(start, closeBrace + 1);
  const next = transform(segment);
  if (next === segment) fail(`${name}: transform made no change`);
  return content.slice(0, start) + next + content.slice(closeBrace + 1);
}

function splitTopLevelArguments(value) {
  const result = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
    if (char === "(") round += 1;
    else if (char === ")") round -= 1;
    else if (char === "[") square += 1;
    else if (char === "]") square -= 1;
    else if (char === "{") curly += 1;
    else if (char === "}") curly -= 1;
    else if (char === "," && round === 0 && square === 0 && curly === 0) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(value.slice(start).trim());
  return result;
}

// 1. Make Slack interaction effects return the guarded provider result. This
// lets the guided flow obtain the real root message ts without weakening the
// tenant boundary or posting outside the canonical credential broker.
{
  const file = "packages/cloud-runtime/src/slack-interactions.ts";
  let content = read(file);
  content = replaceOnce(
    content,
    "  slackDelivery(effectId: string, target: TenantInteractionTarget, event: unknown,\n    execute: (credentialFetch: typeof fetch) => Promise<void>): Promise<void>;",
    "  slackDelivery<T>(effectId: string, target: TenantInteractionTarget, event: unknown,\n    execute: (credentialFetch: typeof fetch) => Promise<T>): Promise<T>;",
    "generic Slack interaction effect",
  );
  write(file, content);
}

// 2. Allow tenant-scoped Slack delivery helpers to carry Block Kit alongside
// their safe fallback text. Existing callers keep their current signatures.
{
  const file = "packages/cloud-runtime/src/reply-pipeline.ts";
  let content = read(file);
  for (const name of ["postSlackReply", "updateSlackReply"]) {
    content = transformFunction(content, name, (segment) => {
      let next = segment.replace(
        /fetchImpl:\s*typeof fetch\s*=\s*fetch,?\s*\)/,
        "fetchImpl: typeof fetch = fetch,\n  blocks?: unknown[],\n)",
      );
      if (next === segment) fail(`${name}: fetch parameter signature not found`);
      next = next.replace(
        "text: escapeUntrustedSlackMrkdwn(text),",
        "text: escapeUntrustedSlackMrkdwn(text),\n        ...(blocks ? { blocks } : {}),",
      );
      if (!next.includes("...(blocks ? { blocks } : {})")) fail(`${name}: Slack body text field not found`);
      return next;
    });
  }
  write(file, content);
}

// 3. Progress callbacks are non-terminal. They are forwarded only while the
// exact development owner is still in progress and never arm the terminal
// outbox, complete accounting, or destroy the sandbox.
{
  const file = "packages/cloud-runtime/src/multitenancy/development-callback-proxy.ts";
  let content = read(file);
  const marker = "  if (claimed.disposition === \"succeeded\") {";
  const insertion = [
    "  if (payload.status === \"progress\") {",
    "    if (claimed.disposition !== \"in_progress\") {",
    "      return Response.json({ error: \"development_callback_in_progress\" }, {",
    "        status: 409,",
    "        headers: { \"retry-after\": \"2\" },",
    "      });",
    "    }",
    "    return forwardDevelopmentCallback(raw, boundaryHandle, input.fetchImpl, input.callbackBaseUrl);",
    "  }",
    "",
  ].join("\n");
  content = replaceOnce(content, marker, `${insertion}${marker}`, "progress proxy path");
  write(file, content);
}

// 4. Preserve old two-argument callback test doubles while production's
// three-argument function receives Block Kit. This is also useful for
// customer-managed adapters that have not added Block Kit yet.
{
  const file = "packages/cloud-runtime/src/development-callback.ts";
  let content = read(file);
  content = replaceOnce(
    content,
    "    if (options.update) await options.update(event, message.text, message.blocks);",
    [
      "    if (options.update) {",
      "      if (options.update.length >= 3) await options.update(event, message.text, message.blocks);",
      "      else await options.update(event, message.text);",
      "    }",
    ].join("\n"),
    "backward-compatible progress update",
  );
  content = replaceOnce(
    content,
    "      delivery = { state: \"delivered\", responseTs: await options.post(event, message.text, message.blocks) };",
    [
      "      const responseTs = options.post.length >= 3",
      "        ? await options.post(event, message.text, message.blocks)",
      "        : await options.post(event, message.text);",
      "      delivery = { state: \"delivered\", responseTs };",
    ].join("\n"),
    "backward-compatible result post",
  );
  write(file, content);
}

// 5. Wire the modal, real root message, canonical Queue event, progress card,
// and structured Block Kit results into the Cloud runtime composition root.
{
  const file = "packages/cloud-runtime/src/index.ts";
  let content = read(file);
  content = replaceOnce(
    content,
    'import { handleSlackCommandRequest } from "./slack-command.js";',
    [
      'import { handleSlackCommandRequest } from "./slack-command.js";',
      'import {',
      '  handleManaImprovementInteraction,',
      '  openManaImprovementModal,',
      '  postManaImprovementAcceptance,',
      '} from "./mana-improvement-slack.js";',
      'import { serializeManaImprovementRequest } from "./mana-improvement-request.js";',
    ].join("\n"),
    "Mana improvement imports",
  );

  if (!content.includes("updateSlackReply")) {
    content = content.replace(
      /import \{([^}]*\bpostSlackReply\b[^}]*)\} from "\.\/reply-pipeline\.js";/s,
      (match, names) => `import {${names}, updateSlackReply } from "./reply-pipeline.js";`,
    );
    if (!content.includes("updateSlackReply")) {
      content = `import { updateSlackReply } from "./reply-pipeline.js";\n${content}`;
    }
  }

  const genericStart = content.indexOf("      slackDelivery: async (effectId, target, event, execute) => {");
  if (genericStart === -1) fail("index Slack delivery implementation not found");
  const genericEndMarker = "\n      },\n    };";
  const genericEnd = content.indexOf(genericEndMarker, genericStart);
  if (genericEnd === -1) fail("index Slack delivery implementation end not found");
  const genericReplacement = [
    "      async slackDelivery<T>(effectId, target, event, execute) {",
    "        const resolvedTarget = interactionTarget(source, target);",
    "        let executed = false;",
    "        let output: T | undefined;",
    "        const responseTs = await executeTenantBoundary(\"slack_delivery\", effectId, resolvedTarget, async (credentialFetch) => {",
    "          return postTenantSlackReply({",
    "            tenant_context: context.tenant_context,",
    "            expected_scope: resolvedTarget,",
    "            ownership: createDurableTenantStateClient(",
    "              env.TENANT_RUNTIME_STATE,",
    "              context.tenant_context.tenant.tenant_id,",
    "            ),",
    "            read_authoritative_snapshot: () => clients.authority.read_workspace_connection(",
    "              context.tenant_context.workspace_connection.connection_id,",
    "            ),",
    "            resolve_verification_key: (keyId) => resolveTenantProviderVerificationKey(env, keyId),",
    "            now: new Date().toISOString(),",
    "            retention_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString(),",
    "            event,",
    "            text: \"\",",
    "            effect_id: effectId,",
    "            post: async () => {",
    "              output = await execute(credentialFetch);",
    "              executed = true;",
    "              return typeof output === \"string\"",
    "                ? output",
    "                : `interaction_effect:${context.tenant_context.operation.operation_id}`;",
    "            },",
    "          });",
    "        });",
    "        return (executed ? output : responseTs) as T;",
    "      },",
  ].join("\n");
  content = content.slice(0, genericStart) + genericReplacement + content.slice(genericEnd + "\n      },".length);

  const commandMarker = '    if (request.method === "POST" && url.pathname === "/slack/commands") {';
  const commandIndex = content.indexOf(commandMarker);
  if (commandIndex === -1) fail("Slack command route not found");
  const sendMarker = "        send: async (event) => {";
  const sendStart = content.indexOf(sendMarker, commandIndex);
  if (sendStart === -1) fail("Slack command send callback not found");
  const arrowStart = sendStart + "        send: ".length;
  const openBrace = content.indexOf("{", arrowStart);
  const closeBrace = findMatching(content, openBrace, "{", "}");
  let arrow = content.slice(arrowStart, closeBrace + 1);
  arrow = arrow.replace("async (event) =>", 'async (event: Omit<SlackQueueEvent, "tenantId">) =>');
  if (/\bruntime\b/.test(arrow) && !/const runtime\s*=/.test(arrow)) {
    arrow = arrow.replace("=> {", "=> {\n      const runtime = runtimeConfig(env);");
  }
  content = content.slice(0, sendStart)
    + "        send: enqueueManaDevelopmentEvent"
    + content.slice(closeBrace + 1);
  content = content.slice(0, commandIndex)
    + `    const enqueueManaDevelopmentEvent = ${arrow};\n\n`
    + content.slice(commandIndex);

  const sendProperty = "        send: enqueueManaDevelopmentEvent,";
  const openModalBlock = [
    "        openModal: async (input) => {",
    "          const interactionTs = String(Date.now() / 1_000);",
    "          const safeTrigger = input.triggerId.replace(/[^A-Za-z0-9_-]/g, \"_\").slice(0, 64);",
    "          const resolveEffects = createTenantInteractionEffectResolver(env);",
    "          const effects = await resolveEffects({",
    "            app_id: requiredRuntimeBinding(env.SLACK_EXPECTED_APP_ID, \"SLACK_EXPECTED_APP_ID\"),",
    "            workspace_id: input.workspaceId,",
    "            event_id: `mana_improvement_modal_${safeTrigger}`,",
    "            channel_id: input.channelId,",
    "            thread_ts: interactionTs,",
    "            requester_id: input.requesterId,",
    "          });",
    "          await effects.slackDelivery<string>(",
    "            `mana_improvement_modal_${safeTrigger}`,",
    "            { channel_id: input.channelId, thread_ts: interactionTs },",
    "            { type: \"mana_improvement_modal\", trigger_id: safeTrigger },",
    "            (credentialFetch) => openManaImprovementModal({",
    "              fetchImpl: credentialFetch,",
    "              triggerId: input.triggerId,",
    "              metadata: {",
    "                workspaceId: input.workspaceId,",
    "                channelId: input.channelId,",
    "                requesterId: input.requesterId,",
    "                command: input.command,",
    "              },",
    "              initialProblem: input.initialProblem,",
    "            }),",
    "          );",
    "        },",
    sendProperty,
  ].join("\n");
  content = replaceOnce(content, sendProperty, openModalBlock, "command modal wiring");

  const interactionMarker = [
    "      const resolveInteractionEffects = createTenantInteractionEffectResolver(env);",
    "      return handleMeetingMinutesInteractionEntrypoint(",
  ].join("\n");
  const interactionReplacement = [
    "      const resolveInteractionEffects = createTenantInteractionEffectResolver(env);",
    "      const improvementResponse = await handleManaImprovementInteraction(request.clone(), {",
    "        signingSecret: requiredRuntimeBinding(env.SLACK_SIGNING_SECRET, \"SLACK_SIGNING_SECRET\"),",
    "        expectedAppId: env.SLACK_EXPECTED_APP_ID,",
    "        placements: runtime.placements.map((placement) => ({",
    "          channelId: placement.channelId,",
    "          allowedUserIds: placement.audience?.allowedUserIds ?? [],",
    "        })),",
    "        defer: (work) => ctx.waitUntil(work),",
    "        onDeferredError: (error, submission) => console.error(JSON.stringify({",
    "          event: \"mana_improvement_submission_failed\",",
    "          eventId: submission.eventId,",
    "          code: error instanceof Error ? error.message : \"unexpected_error\",",
    "        })),",
    "        accept: async (submission) => {",
    "          const sourceEffects = await resolveInteractionEffects({",
    "            app_id: submission.appId,",
    "            workspace_id: submission.workspaceId,",
    "            event_id: `${submission.eventId}_acceptance`,",
    "            channel_id: submission.channelId,",
    "            thread_ts: submission.interactionThreadTs,",
    "            requester_id: submission.requesterId,",
    "          });",
    "          const rootTs = await sourceEffects.slackDelivery<string>(",
    "            `mana_improvement_acceptance_${submission.eventId}`,",
    "            { channel_id: submission.channelId, thread_ts: submission.interactionThreadTs },",
    "            { type: \"mana_improvement_acceptance\", event_id: submission.eventId },",
    "            (credentialFetch) => postManaImprovementAcceptance({",
    "              fetchImpl: credentialFetch,",
    "              channelId: submission.channelId,",
    "              requesterId: submission.requesterId,",
    "              request: submission.request,",
    "            }),",
    "          );",
    "          await enqueueManaDevelopmentEvent({",
    "            eventId: submission.eventId,",
    "            workspaceId: submission.workspaceId,",
    "            channelId: submission.channelId,",
    "            threadTs: rootTs,",
    "            messageTs: rootTs,",
    "            userId: submission.requesterId,",
    "            eventType: \"app_mention\",",
    "            text: `/develop ${serializeManaImprovementRequest(submission.request)}`,",
    "            receivedAt: submission.receivedAt,",
    "          });",
    "        },",
    "      });",
    "      if (improvementResponse) return improvementResponse;",
    "      return handleMeetingMinutesInteractionEntrypoint(",
  ].join("\n");
  content = replaceOnce(content, interactionMarker, interactionReplacement, "interaction submission wiring");

  const callbackRoute = content.indexOf('url.pathname === "/development/callback"');
  if (callbackRoute === -1) fail("development callback route not found");
  const callbackPostMarker = "post: (event, text) => postSlackReply(";
  const callbackPostStart = content.indexOf(callbackPostMarker, callbackRoute);
  if (callbackPostStart === -1) fail("development callback post adapter not found");
  const callOpen = content.indexOf("(", callbackPostStart + callbackPostMarker.length - 1);
  const callClose = findMatching(content, callOpen, "(", ")");
  const args = splitTopLevelArguments(content.slice(callOpen + 1, callClose));
  if (args.length !== 3) fail(`development callback post expected 3 args, found ${args.length}`);
  let callbackPropertyEnd = callClose + 1;
  while (/\s/.test(content[callbackPropertyEnd] ?? "")) callbackPropertyEnd += 1;
  if (content[callbackPropertyEnd] === ",") callbackPropertyEnd += 1;
  const callbackAdapters = [
    `post: (event, text, blocks) => postSlackReply(${args[0]}, ${args[1]}, ${args[2]}, blocks),`,
    `        update: (event, text, blocks) => updateSlackReply(event, event.threadTs, text, ${args[2]}, blocks),`,
  ].join("\n");
  content = content.slice(0, callbackPostStart) + callbackAdapters + content.slice(callbackPropertyEnd);

  write(file, content);
}

// 6. Update legacy callback expectations to the new fallback text while the
// rest of the existing idempotency/security suite remains unchanged.
{
  const file = "packages/cloud-runtime/src/__tests__/development-callback.test.ts";
  let content = read(file);
  content = replaceRegexOnce(
    content,
    /expect\(post\)\.toHaveBeenCalledWith\(expect\.anything\(\), \[\s*"Development: completed",[\s\S]*?\]\.join\("\\n"\)\);/,
    [
      'expect(post).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("Manaの改善案ができました"));',
      '    expect(post.mock.calls[0][1]).toContain("Story: STR-1 &lt;@U_ATTACK&gt;");',
      '    expect(post.mock.calls[0][1]).toContain("PR: https://github.com/x/y/pull/1");',
      '    expect(post.mock.calls[0][1]).toContain("*完了* &lt;!channel&gt; &lt;https://evil.test|確認&gt;");',
    ].join("\n    "),
    "completed callback expectation",
  );
  content = content.replace(
    'expect.stringContaining("Development: timed_out")',
    'expect.stringContaining("時間内に完了しませんでした")',
  );
  write(file, content);
}

console.log("Mana improvement UX patches applied successfully.");
