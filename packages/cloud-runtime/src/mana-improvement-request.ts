import { escapeUntrustedSlackMrkdwn } from "./slack-mrkdwn.js";

export const MANA_IMPROVEMENT_VIEW_CALLBACK_ID = "mana_improvement_request_v1";
export const MANA_IMPROVEMENT_SCHEMA = "mana_improvement_request_v1";

const PROBLEM_BLOCK_ID = "mana_improvement_problem";
const OUTCOME_BLOCK_ID = "mana_improvement_outcome";
const EXAMPLES_BLOCK_ID = "mana_improvement_examples";
const REFERENCES_BLOCK_ID = "mana_improvement_references";
const EFFECT_BLOCK_ID = "mana_improvement_effect";
const VALUE_ACTION_ID = "value";

export type ManaImprovementAllowedEffect = "investigate_only" | "isolated_change" | "draft_pr";

export interface ManaImprovementRequest {
  schema: typeof MANA_IMPROVEMENT_SCHEMA;
  problem: string;
  desiredOutcome: string;
  acceptanceExamples: string[];
  references: string[];
  allowedEffect: ManaImprovementAllowedEffect;
}

export interface ManaImprovementSlackMessage {
  text: string;
  blocks: unknown[];
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, maxLength);
}

function cleanLines(value: unknown, maxItems = 10, maxItemLength = 500): string[] {
  const text = cleanText(value, maxItems * maxItemLength * 2);
  if (!text) return [];
  return text
    .split("\n")
    .map((line) => line.replace(/^[-*•\s]+/, "").trim().slice(0, maxItemLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function allowedEffect(value: unknown): ManaImprovementAllowedEffect {
  return value === "investigate_only" || value === "draft_pr" ? value : "isolated_change";
}

export function normalizeManaImprovementRequest(input: {
  problem: unknown;
  desiredOutcome: unknown;
  acceptanceExamples?: unknown;
  references?: unknown;
  allowedEffect?: unknown;
}): ManaImprovementRequest {
  const problem = cleanText(input.problem, 1_500);
  const desiredOutcome = cleanText(input.desiredOutcome, 1_500);
  if (!problem) throw new Error("mana_improvement_problem_required");
  if (!desiredOutcome) throw new Error("mana_improvement_outcome_required");
  return {
    schema: MANA_IMPROVEMENT_SCHEMA,
    problem,
    desiredOutcome,
    acceptanceExamples: cleanLines(input.acceptanceExamples, 8, 500),
    references: cleanLines(input.references, 10, 500),
    allowedEffect: allowedEffect(input.allowedEffect),
  };
}

function stateValue(values: Record<string, Record<string, unknown>>, blockId: string): Record<string, unknown> {
  const block = values[blockId];
  const value = block?.[VALUE_ACTION_ID];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function extractManaImprovementRequestFromView(
  values: Record<string, Record<string, unknown>>,
): ManaImprovementRequest {
  const problem = stateValue(values, PROBLEM_BLOCK_ID).value;
  const desiredOutcome = stateValue(values, OUTCOME_BLOCK_ID).value;
  const acceptanceExamples = stateValue(values, EXAMPLES_BLOCK_ID).value;
  const references = stateValue(values, REFERENCES_BLOCK_ID).value;
  const selected = stateValue(values, EFFECT_BLOCK_ID).selected_option;
  const selectedValue = selected && typeof selected === "object" && !Array.isArray(selected)
    ? (selected as { value?: unknown }).value
    : undefined;
  return normalizeManaImprovementRequest({
    problem,
    desiredOutcome,
    acceptanceExamples,
    references,
    allowedEffect: selectedValue,
  });
}

function plainInput(blockId: string, label: string, options: {
  initialValue?: string;
  optional?: boolean;
  hint?: string;
  maxLength: number;
}): Record<string, unknown> {
  return {
    type: "input",
    block_id: blockId,
    optional: options.optional === true,
    label: { type: "plain_text", text: label },
    ...(options.hint ? { hint: { type: "plain_text", text: options.hint } } : {}),
    element: {
      type: "plain_text_input",
      action_id: VALUE_ACTION_ID,
      multiline: true,
      max_length: options.maxLength,
      ...(options.initialValue ? { initial_value: options.initialValue.slice(0, options.maxLength) } : {}),
    },
  };
}

export function buildManaImprovementModal(input: {
  privateMetadata: string;
  initialProblem?: string;
}): Record<string, unknown> {
  const initialProblem = cleanText(input.initialProblem, 1_500);
  return {
    type: "modal",
    callback_id: MANA_IMPROVEMENT_VIEW_CALLBACK_ID,
    private_metadata: input.privateMetadata.slice(0, 2_900),
    title: { type: "plain_text", text: "Manaを改善する" },
    submit: { type: "plain_text", text: "改善を開始" },
    close: { type: "plain_text", text: "キャンセル" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "専門用語は不要です。困っていることと、どうなればよいかを入力してください。Manaが隔離環境で調査・変更・検証します。",
        },
      },
      plainInput(PROBLEM_BLOCK_ID, "困っていること", {
        initialValue: initialProblem,
        maxLength: 1_500,
        hint: "いま何が不便・不明・手作業になっているか",
      }),
      plainInput(OUTCOME_BLOCK_ID, "どうなればよいか", {
        maxLength: 1_500,
        hint: "改善後にできるようになってほしいこと",
      }),
      plainInput(EXAMPLES_BLOCK_ID, "具体例・完了条件（任意）", {
        optional: true,
        maxLength: 2_000,
        hint: "1行に1つずつ入力してください",
      }),
      plainInput(REFERENCES_BLOCK_ID, "参考情報（任意）", {
        optional: true,
        maxLength: 2_000,
        hint: "関連するSlackスレッド、画面、URLなど",
      }),
      {
        type: "input",
        block_id: EFFECT_BLOCK_ID,
        label: { type: "plain_text", text: "Manaに許可する範囲" },
        element: {
          type: "static_select",
          action_id: VALUE_ACTION_ID,
          initial_option: {
            text: { type: "plain_text", text: "隔離環境で変更案とテストまで" },
            value: "isolated_change",
          },
          options: [
            {
              text: { type: "plain_text", text: "隔離環境で変更案とテストまで" },
              value: "isolated_change",
            },
            {
              text: { type: "plain_text", text: "調査だけ（コード変更なし）" },
              value: "investigate_only",
            },
          ],
        },
      },
    ],
  };
}

function effectLabel(effect: ManaImprovementAllowedEffect): string {
  if (effect === "investigate_only") return "調査だけ（コード変更なし）";
  if (effect === "draft_pr") return "Draft PR作成まで";
  return "隔離環境で変更案とテストまで";
}

export function serializeManaImprovementRequest(request: ManaImprovementRequest): string {
  const lines = [
    `[${MANA_IMPROVEMENT_SCHEMA}]`,
    "",
    "## 困っていること",
    request.problem,
    "",
    "## どうなればよいか",
    request.desiredOutcome,
    "",
    "## Manaに許可する範囲",
    request.allowedEffect,
    "",
    "## 安全境界",
    "merge、deploy、secret変更、本番データ変更は行わない。許可範囲を超える前に停止する。",
  ];
  if (request.acceptanceExamples.length > 0) {
    lines.push("", "## 具体例・完了条件", ...request.acceptanceExamples.map((item) => `- ${item}`));
  }
  if (request.references.length > 0) {
    lines.push("", "## 参考情報", ...request.references.map((item) => `- ${item}`));
  }
  if (request.allowedEffect === "investigate_only") {
    lines.push("", "## 追加制約", "コード・設定・ドキュメントを変更せず、調査結果と改善案だけを報告する。");
  }
  return lines.join("\n");
}

export function buildManaImprovementAcceptanceMessage(
  request: ManaImprovementRequest,
  requesterId: string,
): ManaImprovementSlackMessage {
  const problem = escapeUntrustedSlackMrkdwn(request.problem);
  const outcome = escapeUntrustedSlackMrkdwn(request.desiredOutcome);
  const text = [
    "🛠 Manaの改善依頼として受け付けました",
    `困っていること: ${problem}`,
    `完了条件: ${outcome}`,
    `許可範囲: ${effectLabel(request.allowedEffect)}`,
    "状態: 依頼を整理中",
  ].join("\n");
  return {
    text,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🛠 *Manaの改善依頼として受け付けました*\n依頼者: <@${requesterId}>`,
        },
      },
      { type: "divider" },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*困っていること*\n${problem}` },
          { type: "mrkdwn", text: `*どうなればよいか*\n${outcome}` },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Manaに許可した範囲*\n${effectLabel(request.allowedEffect)}\n\n*行わないこと*\nmerge・本番反映・secret変更・権限変更`,
        },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "⏳ 状態: 依頼を整理中" }],
      },
    ],
  };
}
