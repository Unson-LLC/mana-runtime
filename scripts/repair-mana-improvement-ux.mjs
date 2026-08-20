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

// Preserve the existing void-returning interaction contract. Only flows that
// need a provider result opt into the optional typed request method, so older
// meeting/task effect doubles remain structurally valid.
{
  const file = "packages/cloud-runtime/src/slack-interactions.ts";
  let content = read(file);
  content = content.replace(
    "  slackDelivery<T>(effectId: string, target: TenantInteractionTarget, event: unknown,\n    execute: (credentialFetch: typeof fetch) => Promise<T>): Promise<T>;",
    "  slackDelivery(effectId: string, target: TenantInteractionTarget, event: unknown,\n    execute: (credentialFetch: typeof fetch) => Promise<void>): Promise<void>;\n  slackRequest?<T>(effectId: string, target: TenantInteractionTarget, event: unknown,\n    execute: (credentialFetch: typeof fetch) => Promise<T>): Promise<T>;",
  );
  if (!content.includes("slackRequest?<T>")) {
    throw new Error("typed Slack request interface was not installed");
  }
  write(file, content);
}

{
  const file = "packages/cloud-runtime/src/index.ts";
  let content = read(file);
  const start = content.indexOf("      async slackDelivery<T>(effectId, target, event, execute) {");
  if (start !== -1) {
    const openBrace = content.indexOf("{", start);
    const closeBrace = findMatching(content, openBrace, "{", "}");
    let end = closeBrace + 1;
    if (content[end] === ",") end += 1;
    const replacement = [
      "      slackDelivery: async (effectId, target, event, execute) => {",
      "        const resolvedTarget = interactionTarget(source, target);",
      "        await executeTenantBoundary(\"slack_delivery\", effectId, resolvedTarget, async (credentialFetch) => {",
      "          await postTenantSlackReply({",
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
      "              await execute(credentialFetch);",
      "              return `interaction_effect:${context.tenant_context.operation.operation_id}`;",
      "            },",
      "          });",
      "        });",
      "      },",
      "      async slackRequest<T>(effectId, target, event, execute) {",
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
    content = content.slice(0, start) + replacement + content.slice(end);
  }

  content = content.replace(
    "          await effects.slackDelivery<string>(",
    "          if (!effects.slackRequest) throw new Error(\"tenant_slack_request_not_configured\");\n          await effects.slackRequest<string>(",
  );
  content = content.replace(
    "          const rootTs = await sourceEffects.slackDelivery<string>(",
    "          if (!sourceEffects.slackRequest) throw new Error(\"tenant_slack_request_not_configured\");\n          const rootTs = await sourceEffects.slackRequest<string>(",
  );

  if (!content.includes("async slackRequest<T>")) {
    throw new Error("typed Slack request implementation was not installed");
  }
  write(file, content);
}

console.log("Mana improvement UX interaction contract repaired successfully.");
