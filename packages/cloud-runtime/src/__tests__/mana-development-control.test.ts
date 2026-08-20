import { describe, expect, it } from "vitest";
import {
  parseManaDevelopmentControlRequest,
  serializeManaDevelopmentContinueGates,
  serializeManaDevelopmentResume,
} from "../mana-development-control.js";

const storyId = "story-slack-20260821010101-abcd1234";

describe("Mana development continuation control", () => {
  it("keeps ordinary requests on the new Story path", () => {
    expect(parseManaDevelopmentControlRequest(" 一覧を改善する ")).toEqual({
      mode: "new",
      request: "一覧を改善する",
    });
  });

  it("round-trips recommended human answers without exposing an internal slash command", () => {
    const encoded = serializeManaDevelopmentResume({
      storyId,
      answers: [
        { id: "display", answer: "全員を表示" },
        { id: "order", answer: "期限順" },
      ],
    });
    expect(encoded).toMatch(/^\[mana_development_control_v1\][A-Za-z0-9_-]+$/);
    expect(parseManaDevelopmentControlRequest(encoded)).toEqual({
      mode: "resume",
      storyId,
      answers: [
        { id: "display", answer: "全員を表示" },
        { id: "order", answer: "期限順" },
      ],
    });
  });

  it("round-trips a same-Story Gate continuation", () => {
    const encoded = serializeManaDevelopmentContinueGates(storyId);
    expect(parseManaDevelopmentControlRequest(encoded)).toEqual({
      mode: "continueGates",
      storyId,
    });
  });

  it("fails closed for malformed or unsupported continuation payloads", () => {
    expect(() => parseManaDevelopmentControlRequest("[mana_development_control_v1]not-base64!"))
      .toThrow("mana_development_control_invalid");
    expect(() => serializeManaDevelopmentContinueGates("other-story"))
      .toThrow("mana_development_story_invalid");
    expect(() => serializeManaDevelopmentResume({
      storyId,
      answers: [{ id: "bad id", answer: "x" }],
    })).toThrow("mana_development_answers_invalid");
  });
});
