#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const file = path.join(process.cwd(), "packages/cloud-runtime/src/mana-improvement-slack.ts");
let content = fs.readFileSync(file, "utf8");

content = content.replace(
  "    const work = options.accept(submission).catch((error) => options.onDeferredError?.(error, submission));",
  "    const work: Promise<void> = options.accept(submission).catch((error) => {\n      options.onDeferredError?.(error, submission);\n    });",
);
content = content.replace(
  "  let continuation;\n  try { continuation = parseManaImprovementContinuationAction(action.value); }",
  "  let continuation: ReturnType<typeof parseManaImprovementContinuationAction>;\n  try { continuation = parseManaImprovementContinuationAction(action.value); }",
);
content = content.replace(
  "  const work = options.continueDevelopment(submission).catch((error) => options.onDeferredError?.(error, submission));",
  "  const work: Promise<void> = options.continueDevelopment(submission).catch((error) => {\n    options.onDeferredError?.(error, submission);\n  });",
);

if (!content.includes("const work: Promise<void> = options.accept")
  || !content.includes("ReturnType<typeof parseManaImprovementContinuationAction>")) {
  throw new Error("continuation Promise typing patch did not apply");
}

fs.writeFileSync(file, content);
console.log("Mana improvement continuation typing finalized successfully.");
