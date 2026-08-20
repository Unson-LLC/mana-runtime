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

// Bind the modal submission to a timestamp-shaped authority scope created at
// command ingress. A Slack view id is not a thread timestamp and must never be
// sent to the canonical tenant resolver as one.
{
  const file = "packages/cloud-runtime/src/mana-improvement-slack.ts";
  let content = read(file);
  if (!content.includes("  interactionTs: string;\n  command:")) {
    content = replaceOnce(
      content,
      "  requesterId: string;\n  command: string;",
      "  requesterId: string;\n  interactionTs: string;\n  command: string;",
      "metadata interaction timestamp field",
    );
  }
  if (!content.includes("TIMESTAMP_RE")) {
    content = replaceOnce(
      content,
      "const SLACK_ID_RE = /^[A-Z0-9_-]{2,64}$/;",
      "const SLACK_ID_RE = /^[A-Z0-9_-]{2,64}$/;\nconst TIMESTAMP_RE = /^\\d{1,20}(?:\\.\\d{1,12})?$/;",
      "timestamp validator",
    );
  }
  content = content.replace(
    "    || !SLACK_ID_RE.test(candidate.requesterId ?? \"\")\n    || typeof candidate.command !== \"string\"",
    "    || !SLACK_ID_RE.test(candidate.requesterId ?? \"\")\n    || !TIMESTAMP_RE.test(candidate.interactionTs ?? \"\")\n    || typeof candidate.command !== \"string\"",
  );
  content = content.replace(
    "    interactionThreadTs: viewId,",
    "    interactionThreadTs: metadata.interactionTs,",
  );
  write(file, content);
}

// Carry the timestamp-shaped authority scope into the signed Slack modal
// metadata. The actual development thread is still the real acceptance post ts.
{
  const file = "packages/cloud-runtime/src/index.ts";
  let content = read(file);
  const marker = "                requesterId: input.requesterId,\n                command: input.command,";
  if (content.includes(marker)) {
    content = replaceOnce(
      content,
      marker,
      "                requesterId: input.requesterId,\n                interactionTs,\n                command: input.command,",
      "modal authority timestamp wiring",
    );
  }
  write(file, content);
}

// SlackQueueEvent uses the existing development_result transport category;
// progress remains non-terminal through the event id and callback status.
{
  const file = "packages/cloud-runtime/src/development-callback.ts";
  let content = read(file);
  content = content.replace(
    '    eventType: payload.status === "progress" ? "development_progress" : "development_result",',
    '    eventType: "development_result",',
  );

  const start = content.indexOf("function parseQuestions(");
  const end = content.indexOf("function parseGates(", start);
  if (start !== -1 && end !== -1) {
    const safeParser = `function parseQuestions(value: unknown): DevelopmentQuestion[] | undefined {\n  if (value === undefined) return undefined;\n  if (!Array.isArray(value) || value.length < 1 || value.length > 5) return undefined;\n  const ids = new Set<string>();\n  const questions: DevelopmentQuestion[] = [];\n  for (const raw of value) {\n    const question = record(raw);\n    if (!question) return undefined;\n    const id = boundedString(question.id, 64);\n    const text = boundedString(question.question, 300);\n    const rawOptions = question.options;\n    const allowFreeText = question.allow_free_text;\n    if (!id || !/^[a-z0-9_-]+$/i.test(id) || ids.has(id) || !text\n      || !Array.isArray(rawOptions) || rawOptions.length > 5 || typeof allowFreeText !== \"boolean\") return undefined;\n    ids.add(id);\n    const options: DevelopmentQuestionOption[] = [];\n    for (const rawOption of rawOptions) {\n      const option = record(rawOption);\n      if (!option) return undefined;\n      const label = boundedString(option.label, 80);\n      const description = option.description === undefined ? undefined : boundedString(option.description, 200);\n      if (!label || (option.description !== undefined && !description)\n        || (option.recommended !== undefined && typeof option.recommended !== \"boolean\")) return undefined;\n      options.push({\n        label,\n        ...(description ? { description } : {}),\n        ...(typeof option.recommended === \"boolean\" ? { recommended: option.recommended } : {}),\n      });\n    }\n    questions.push({ id, question: text, options, allow_free_text: allowFreeText });\n  }\n  return questions;\n}\n\n`;
    content = content.slice(0, start) + safeParser + content.slice(end);
  }
  write(file, content);
}

// Update modal tests to use the canonical timestamp-shaped scope.
{
  const file = "packages/cloud-runtime/src/__tests__/mana-improvement-slack.test.ts";
  let content = read(file);
  content = content.replace(
    "        requesterId: \"U1\",\n        command: \"/vibepro\",",
    "        requesterId: \"U1\",\n        interactionTs: \"1.234\",\n        command: \"/vibepro\",",
  );
  content = content.replace(
    '      interactionThreadTs: "V1",',
    '      interactionThreadTs: "1.234",',
  );
  write(file, content);
}

// Keep the callback UX test exactly typed against the production handler.
{
  const file = "packages/cloud-runtime/src/__tests__/development-callback-ux.test.ts";
  let content = read(file);
  content = content.replace(
    "function options(overrides: Record<string, unknown> = {}) {",
    "function options(\n  overrides: Partial<Parameters<typeof handleDevelopmentCallback>[1]> = {},\n): Parameters<typeof handleDevelopmentCallback>[1] {",
  );
  content = content.replace(
    "    resolve: async (event: Record<string, unknown>) => ({ ...event, tenantId:",
    "    resolve: async (event) => ({ ...event, tenantId:",
  );
  write(file, content);
}

console.log("Mana improvement UX hardening patches applied successfully.");
