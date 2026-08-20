import { describe, expect, it } from "vitest";
import {
  buildTerminalCallback,
  parseProgressLine,
  parseRunnerResult,
} from "../../container/cloudflare-development-runner.mjs";

const job = {
  job_id: "development_1",
  event_id: "event_1",
  placement_id: "mana-dev",
  workspace_id: "T1",
  channel_id: "C1",
  thread_ts: "1.0",
  requester_id: "U1",
  quota_decision: "allowed",
};

describe("Cloudflare development runner UX bridge", () => {
  it("maps internal progress into user-facing phases", () => {
    expect(parseProgressLine('PROGRESS {"phase":"agent","elapsedSec":30,"commits":0}')).toEqual({
      phase: "analyzing",
      elapsed_sec: 30,
      commits: 0,
    });
    expect(parseProgressLine('PROGRESS {"phase":"agent","elapsedSec":90,"commits":2,"latest":"feat: add status"}')).toEqual({
      phase: "implementing",
      elapsed_sec: 90,
      commits: 2,
      latest: "feat: add status",
    });
    expect(parseProgressLine('PROGRESS {"phase":"gate","elapsedSec":120,"commits":2}')).toEqual({
      phase: "verifying",
      elapsed_sec: 120,
      commits: 2,
    });
  });

  it("preserves questions, gates, commits, Story, and PR fields in the callback", () => {
    const callback = buildTerminalCallback(job, {
      status: "needs_decision",
      storyId: "story-1",
      prUrl: "https://github.com/Unson-LLC/mana-runtime/pull/1",
      summary: "判断が必要です",
      questions: [{ id: "display", question: "どう表示しますか", options: [], allow_free_text: true }],
      gates: [{ severity: "critical", text: "E2E evidence required" }],
      commits: { count: 2, subjects: ["feat: one"] },
    });
    expect(callback).toMatchObject({
      status: "needs_decision",
      story_id: "story-1",
      pr_url: "https://github.com/Unson-LLC/mana-runtime/pull/1",
      questions: [{ id: "display" }],
      gates: [{ severity: "critical" }],
      commits: { count: 2 },
    });
  });

  it("reads the last valid JSON result from noisy stdout", () => {
    expect(parseRunnerResult('noise\n{"status":"pr_ready","summary":"ready"}\n')).toEqual({
      status: "pr_ready",
      summary: "ready",
    });
  });
});
