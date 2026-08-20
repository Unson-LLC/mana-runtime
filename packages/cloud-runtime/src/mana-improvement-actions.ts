import type { DevelopmentQuestion } from "./development-callback.js";
import type { ManaDevelopmentAnswer } from "./mana-development-control.js";

export const MANA_IMPROVEMENT_RESUME_RECOMMENDED_ACTION_ID = "mana_improvement_resume_recommended";
export const MANA_IMPROVEMENT_CONTINUE_GATES_ACTION_ID = "mana_improvement_continue_gates";

const STORY_ID_RE = /^story-[a-z0-9-]+$/;
const MAX_ACTION_VALUE_LENGTH = 1_900;

export type ManaImprovementContinuationAction =
  | { version: 1; kind: "resume_recommended"; storyId: string; answers: ManaDevelopmentAnswer[] }
  | { version: 1; kind: "continue_gates"; storyId: string };

function storyId(value: unknown): string {
  if (typeof value !== "string" || !STORY_ID_RE.test(value)) {
    throw new Error("mana_improvement_action_invalid");
  }
  return value;
}

function answers(value: unknown): ManaDevelopmentAnswer[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) {
    throw new Error("mana_improvement_action_invalid");
  }
  const ids = new Set<string>();
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("mana_improvement_action_invalid");
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.id !== "string" || !/^[a-z0-9_-]{1,64}$/i.test(candidate.id)
      || ids.has(candidate.id) || typeof candidate.answer !== "string"
      || candidate.answer.length < 1 || candidate.answer.length > 160) {
      throw new Error("mana_improvement_action_invalid");
    }
    ids.add(candidate.id);
    return { id: candidate.id, answer: candidate.answer };
  });
}

function encode(action: ManaImprovementContinuationAction): string {
  const value = JSON.stringify(action);
  if (value.length > MAX_ACTION_VALUE_LENGTH) throw new Error("mana_improvement_action_too_large");
  return value;
}

export function recommendedDevelopmentAnswers(
  questions: DevelopmentQuestion[],
): ManaDevelopmentAnswer[] | undefined {
  const result: ManaDevelopmentAnswer[] = [];
  for (const question of questions) {
    const recommended = question.options.find((option) => option.recommended)
      ?? (question.options.length === 1 ? question.options[0] : undefined);
    if (!recommended) return undefined;
    result.push({ id: question.id, answer: recommended.label });
  }
  return result.length > 0 ? result : undefined;
}

export function buildResumeRecommendedActionValue(input: {
  storyId: string;
  answers: ManaDevelopmentAnswer[];
}): string {
  return encode({ version: 1, kind: "resume_recommended", storyId: storyId(input.storyId), answers: answers(input.answers) });
}

export function buildContinueGatesActionValue(value: string): string {
  return encode({ version: 1, kind: "continue_gates", storyId: storyId(value) });
}

export function parseManaImprovementContinuationAction(value: unknown): ManaImprovementContinuationAction {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_ACTION_VALUE_LENGTH) {
    throw new Error("mana_improvement_action_invalid");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("mana_improvement_action_invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("mana_improvement_action_invalid");
  const action = parsed as Record<string, unknown>;
  if (action.version !== 1) throw new Error("mana_improvement_action_invalid");
  if (action.kind === "resume_recommended") {
    return { version: 1, kind: "resume_recommended", storyId: storyId(action.storyId), answers: answers(action.answers) };
  }
  if (action.kind === "continue_gates") {
    return { version: 1, kind: "continue_gates", storyId: storyId(action.storyId) };
  }
  throw new Error("mana_improvement_action_invalid");
}
