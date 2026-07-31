import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { App } from "@slack/bolt";

vi.mock("../../../shared/paths.js", () => ({
  JINN_HOME: "/tmp/openryoko-vibepro-decision-test",
}));
vi.mock("../../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  VibeproDecisionNotifier,
  buildQuestionCardBlocks,
  buildAnswerModalView,
  extractAnswersFromViewState,
  ACTION_OPEN_FORM,
  VIEW_ANSWER_SUBMIT,
} from "../vibepro-decision.js";
import type { DevelopmentQuestion } from "../../../shared/types.js";

const STATE_DIR = "/tmp/openryoko-vibepro-decision-test";
const STATE_FILE = path.join(STATE_DIR, ".vibepro-decisions.json");
const ALLOWED_USER = "U_ALLOWED";

const QUESTIONS: DevelopmentQuestion[] = [
  {
    id: "auth_strategy",
    question: "認証方式はどちらにしますか？",
    options: [
      { label: "OAuth", description: "既存IdPを使う", recommended: true },
      { label: "独自実装" },
    ],
    allow_free_text: true,
  },
  {
    id: "notes",
    question: "他に制約はありますか？",
    options: [],
    allow_free_text: false,
  },
];

function makeApp() {
  const apiCall = vi.fn().mockResolvedValue({ ok: true, ts: "1234.000001" });
  const app = {
    client: { apiCall },
    action: vi.fn(),
    view: vi.fn(),
  } as unknown as App & { action: ReturnType<typeof vi.fn>; view: ReturnType<typeof vi.fn> };
  return { app, apiCall };
}

function makeNotifier(overrides: { allowFrom?: string[]; resumeDecision?: ReturnType<typeof vi.fn> } = {}) {
  const { app, apiCall } = makeApp();
  const resumeDecision = overrides.resumeDecision ?? vi.fn().mockReturnValue(true);
  const notifier = new VibeproDecisionNotifier(app, overrides.allowFrom ?? [ALLOWED_USER], {
    resumeDecision: resumeDecision as unknown as (storyId: string, answers: any, target: any) => boolean,
  });
  notifier.register();
  return { notifier, app, apiCall, resumeDecision };
}

describe("vibepro-decision blocks and modal builders", () => {
  it("renders a question card with numbered questions, options, and a recommended marker", () => {
    const blocks = buildQuestionCardBlocks("story-x", QUESTIONS, "曖昧さがあります");
    const text = JSON.stringify(blocks);
    expect(text).toContain("story-x");
    expect(text).toContain("認証方式はどちらにしますか");
    expect(text).toContain("OAuth");
    expect(text).toContain("（推奨）");
    expect(text).toContain(ACTION_OPEN_FORM);
  });

  it("builds a modal with a radio input + optional free text for an options question, and a plain text input otherwise", () => {
    const view = buildAnswerModalView({
      storyId: "story-x",
      channel: "C1",
      thread: "T1",
      questions: QUESTIONS,
      summary: "x",
      createdAt: 0,
      expiresAt: 0,
    });
    expect(view.callback_id).toBe(VIEW_ANSWER_SUBMIT);
    const blocks = JSON.stringify(view.blocks);
    expect(blocks).toContain("question:auth_strategy");
    expect(blocks).toContain("radio_buttons");
    expect(blocks).toContain("freetext:auth_strategy");
    expect(blocks).toContain("question:notes");
    expect(blocks).toContain("plain_text_input");
    expect(JSON.parse(view.private_metadata as string)).toEqual({ storyId: "story-x", channel: "C1", thread: "T1" });
  });

  it("extracts answers from submitted view state, combining a selected option with free text", () => {
    const answers = extractAnswersFromViewState({
      "question:auth_strategy": { value: { selected_option: { value: "OAuth" } } },
      "freetext:auth_strategy": { value: { value: "社内標準に合わせて" } },
      "question:notes": { value: { value: "特になし" } },
    });
    expect(answers).toEqual([
      { id: "auth_strategy", answer: "OAuth / 社内標準に合わせて" },
      { id: "notes", answer: "特になし" },
    ]);
  });

  it("omits an answer when neither a selection nor typed text is present", () => {
    const answers = extractAnswersFromViewState({
      "question:auth_strategy": { value: {} },
    });
    expect(answers).toEqual([]);
  });
});

describe("VibeproDecisionNotifier", () => {
  beforeEach(() => {
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
    fs.mkdirSync(STATE_DIR, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
  });

  it("does not register Bolt listeners when allowFrom is empty (fail-closed)", () => {
    const { app } = makeNotifier({ allowFrom: [] });
    expect(app.action).not.toHaveBeenCalled();
    expect(app.view).not.toHaveBeenCalled();
  });

  it("posts a Block Kit question card and persists the pending decision", async () => {
    const { notifier, apiCall } = makeNotifier();
    await notifier.postQuestions({ channel: "C1", thread: "T1" }, "story-x", QUESTIONS, "曖昧さがあります");

    expect(apiCall).toHaveBeenCalledWith("chat.postMessage", expect.objectContaining({
      channel: "C1",
      thread_ts: "T1",
      blocks: expect.any(Array),
    }));
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    expect(state["story-x"].questions).toEqual(QUESTIONS);
  });

  it("opens the answer modal for an authorized user when the pending decision exists", async () => {
    const { notifier, apiCall } = makeNotifier();
    await notifier.postQuestions({ channel: "C1", thread: "T1" }, "story-x", QUESTIONS, "x");

    await notifier.handleOpenForm(
      { user: { id: ALLOWED_USER }, channel: { id: "C1" }, trigger_id: "TRIGGER" },
      { value: "story-x" },
    );

    expect(apiCall).toHaveBeenCalledWith("views.open", expect.objectContaining({ trigger_id: "TRIGGER" }));
  });

  it("rejects an open-form request from a user outside allowFrom", async () => {
    const { notifier, apiCall } = makeNotifier();
    await notifier.postQuestions({ channel: "C1", thread: "T1" }, "story-x", QUESTIONS, "x");

    await notifier.handleOpenForm(
      { user: { id: "U_STRANGER" }, channel: { id: "C1" }, trigger_id: "TRIGGER" },
      { value: "story-x" },
    );

    expect(apiCall).not.toHaveBeenCalledWith("views.open", expect.anything());
    expect(apiCall).toHaveBeenCalledWith("chat.postEphemeral", expect.objectContaining({ user: "U_STRANGER" }));
  });

  it("tells the user the question session expired when no pending decision matches the storyId", async () => {
    const { notifier, apiCall } = makeNotifier();
    await notifier.handleOpenForm(
      { user: { id: ALLOWED_USER }, channel: { id: "C1" }, trigger_id: "TRIGGER" },
      { value: "story-unknown" },
    );

    expect(apiCall).not.toHaveBeenCalledWith("views.open", expect.anything());
    expect(apiCall).toHaveBeenCalledWith("chat.postEphemeral", expect.objectContaining({
      text: expect.stringContaining("期限切れ"),
    }));
  });

  it("resumes the Story on a valid, authorized submission and marks the pending decision answered", async () => {
    const resumeDecision = vi.fn().mockReturnValue(true);
    const { notifier, apiCall } = makeNotifier({ resumeDecision });
    await notifier.postQuestions({ channel: "C1", thread: "T1" }, "story-x", QUESTIONS, "x");

    await notifier.handleSubmit(
      { user: { id: ALLOWED_USER } },
      {
        private_metadata: JSON.stringify({ storyId: "story-x", channel: "C1", thread: "T1" }),
        state: {
          values: {
            "question:auth_strategy": { value: { selected_option: { value: "OAuth" } } },
            "question:notes": { value: { value: "特になし" } },
          },
        },
      },
    );

    expect(resumeDecision).toHaveBeenCalledWith(
      "story-x",
      [
        { id: "auth_strategy", answer: "OAuth" },
        { id: "notes", answer: "特になし" },
      ],
      { channel: "C1", thread: "T1" },
    );
    expect(apiCall).toHaveBeenCalledWith("chat.postMessage", expect.objectContaining({
      text: expect.stringContaining("受け付けました"),
    }));
    const stored = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"))["story-x"];
    expect(stored.answeredAt).toEqual(expect.any(Number));
  });

  it("reports answered (not expired) when the card button is pressed after submit", async () => {
    const { notifier, apiCall } = makeNotifier();
    await notifier.postQuestions({ channel: "C1", thread: "T1" }, "story-x", QUESTIONS, "x");
    await notifier.handleSubmit(
      { user: { id: ALLOWED_USER } },
      {
        private_metadata: JSON.stringify({ storyId: "story-x", channel: "C1", thread: "T1" }),
        state: {
          values: {
            "question:auth_strategy": { value: { selected_option: { value: "OAuth" } } },
          },
        },
      },
    );
    apiCall.mockClear();

    await notifier.handleOpenForm(
      { user: { id: ALLOWED_USER }, channel: { id: "C1" }, trigger_id: "TRIGGER" },
      { value: "story-x" },
    );

    expect(apiCall).not.toHaveBeenCalledWith("views.open", expect.anything());
    expect(apiCall).toHaveBeenCalledWith("chat.postEphemeral", expect.objectContaining({
      text: expect.stringContaining("回答済み"),
    }));
  });

  it("ignores a duplicate submit from a stale modal after the Story already resumed", async () => {
    const resumeDecision = vi.fn().mockReturnValue(true);
    const { notifier } = makeNotifier({ resumeDecision });
    await notifier.postQuestions({ channel: "C1", thread: "T1" }, "story-x", QUESTIONS, "x");
    const submitBody = { user: { id: ALLOWED_USER } };
    const submitView = {
      private_metadata: JSON.stringify({ storyId: "story-x", channel: "C1", thread: "T1" }),
      state: {
        values: {
          "question:auth_strategy": { value: { selected_option: { value: "OAuth" } } },
        },
      },
    };
    await notifier.handleSubmit(submitBody, submitView);
    resumeDecision.mockClear();

    await notifier.handleSubmit(submitBody, submitView);

    expect(resumeDecision).not.toHaveBeenCalled();
  });

  it("tells the user development is busy when resumeDecision reports it could not start", async () => {
    const resumeDecision = vi.fn().mockReturnValue(false);
    const { notifier, apiCall } = makeNotifier({ resumeDecision });

    await notifier.handleSubmit(
      { user: { id: ALLOWED_USER } },
      {
        private_metadata: JSON.stringify({ storyId: "story-x", channel: "C1", thread: "T1" }),
        state: { values: { "question:notes": { value: { value: "x" } } } },
      },
    );

    expect(apiCall).toHaveBeenCalledWith("chat.postMessage", expect.objectContaining({
      text: expect.stringContaining("再開できません"),
    }));
  });

  it("ignores a submission from a user outside allowFrom", async () => {
    const resumeDecision = vi.fn();
    const { notifier } = makeNotifier({ resumeDecision });

    await notifier.handleSubmit(
      { user: { id: "U_STRANGER" } },
      {
        private_metadata: JSON.stringify({ storyId: "story-x", channel: "C1", thread: "T1" }),
        state: { values: { "question:notes": { value: { value: "x" } } } },
      },
    );

    expect(resumeDecision).not.toHaveBeenCalled();
  });
});
