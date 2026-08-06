import { describe, expect, it, vi } from "vitest";

vi.mock("../../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  MIN_MINUTES_CHARS,
  buildMinutesPrompt,
  buildRoutingPrompt,
  parseMinutesResult,
  parseRoutingResult,
  sanitizeMinutesMrkdwn,
  fitSlackOverview,
  splitForSlack,
  type MinutesContext,
  type MinutesDestination,
} from "../meeting-minutes-generator.js";

const DESTINATIONS: MinutesDestination[] = [
  { projectId: "proj_salestailor", name: "SalesTailor", channelId: "C_ST" },
  { projectId: "proj_baao", name: "BAAO", channelId: "C_BAAO" },
];

describe("sanitizeMinutesMrkdwn", () => {
  it("keeps mrkdwn formatting and newlines", () => {
    const text = "*見出し*\n_補足_ と `code`\n次の行";
    expect(sanitizeMinutesMrkdwn(text)).toBe(text);
  });

  it("neutralizes mention/link constructs and control chars", () => {
    const out = sanitizeMinutesMrkdwn("<@U123> <!channel> <#C1> <https://x.example|x>");
    expect(out).not.toContain("<@");
    expect(out).not.toContain("<!");
    expect(out).not.toContain("<#");
    expect(out).not.toContain("<http");
    expect(sanitizeMinutesMrkdwn("a\u0007b")).toBe("a b");
  });

  it("leaves prose comparisons alone", () => {
    expect(sanitizeMinutesMrkdwn("A < B かつ B > C")).toBe("A < B かつ B > C");
  });
});

describe("routing", () => {
  it("prompt lists only configured destinations", () => {
    const prompt = buildRoutingPrompt("会議の冒頭テキスト", DESTINATIONS);
    expect(prompt).toContain("proj_salestailor: SalesTailor");
    expect(prompt).toContain("proj_baao: BAAO");
    expect(prompt).toContain("不明");
  });

  it("parses a valid destination", () => {
    const result = parseRoutingResult(
      '{"projectId": "proj_baao", "reason": "BAAO稽古の話題"}',
      DESTINATIONS,
    );
    expect(result?.destination.channelId).toBe("C_BAAO");
    expect(result?.reason).toBe("BAAO稽古の話題");
  });

  it("rejects projectIds outside the enum (LLM hallucination)", () => {
    expect(parseRoutingResult('{"projectId": "proj_mana"}', DESTINATIONS)).toBeNull();
    expect(parseRoutingResult('{"projectId": "不明"}', DESTINATIONS)).toBeNull();
  });

  it("rejects garbage output", () => {
    expect(parseRoutingResult("わかりません", DESTINATIONS)).toBeNull();
    expect(parseRoutingResult("", DESTINATIONS)).toBeNull();
  });

  it("accepts fenced JSON", () => {
    const result = parseRoutingResult(
      '```json\n{"projectId": "proj_salestailor", "reason": "x"}\n```',
      DESTINATIONS,
    );
    expect(result?.destination.projectId).toBe("proj_salestailor");
  });
});

function makeContext(overrides: Partial<MinutesContext> = {}): MinutesContext {
  return {
    properNouns: [
      { id: "e1", name: "UNSON", aliases: ["運送", "運尊"] },
      { id: "e2", name: "佐藤 圭吾", aliases: ["佐藤"] },
      { id: "e3", name: "エイリアスなし", aliases: [] },
    ],
    openTasks: ["見積書を送付する"],
    decisions: ["SalesTailor 価格改定 2026-07"],
    previousMinutes: { title: "2026-07-23 定例-要約", overview: "前回の概要" },
    projectName: "SalesTailor",
    dateStr: "2026-07-30",
    ...overrides,
  };
}

describe("buildMinutesPrompt", () => {
  it("injects the Graph-derived dictionary, tasks, decisions, previous minutes", () => {
    const prompt = buildMinutesPrompt("文字起こし本文", makeContext());
    expect(prompt).toContain("「運送」「運尊」→「UNSON」");
    expect(prompt).not.toContain("エイリアスなし"); // alias-less entities add noise only
    expect(prompt).toContain("見積書を送付する");
    expect(prompt).toContain("SalesTailor 価格改定 2026-07");
    expect(prompt).toContain("前回の概要");
    expect(prompt).toContain("narrative_minutes.v1");
    expect(prompt).toContain("@未確認");
    expect(prompt).toContain("[TBD]");
  });

  it("omits empty context sections", () => {
    const prompt = buildMinutesPrompt(
      "本文",
      makeContext({ properNouns: [], openTasks: [], decisions: [], previousMinutes: undefined }),
    );
    expect(prompt).not.toContain("固有名詞の表記ゆれ修正");
    expect(prompt).not.toContain("進行中のタスク");
    expect(prompt).not.toContain("関連する既存の意思決定");
    expect(prompt).not.toContain("前回の議事録");
  });

  it("truncates over-long transcripts", () => {
    const prompt = buildMinutesPrompt("あ".repeat(200_000), makeContext());
    expect(prompt).toContain("文字数上限により以降を省略");
    expect(prompt.length).toBeLessThan(160_000);
  });
});

function validMinutesBody(): string {
  const paragraph = "議論の背景と流れを保存するための本文。".repeat(30);
  return [
    "2026-07-30 SalesTailor定例-要約",
    "SalesTailor 週次定例",
    "",
    `概要段落1。${paragraph}`,
    "",
    "------------",
    "",
    "*価格改定について*",
    paragraph,
    "",
    "------------",
    "",
    "*アクションアイテム*",
    "佐藤 圭吾: 見積書を送付する（期限: 2026-08-05）",
    "@未確認: デモ環境を用意する（期限: [TBD]）",
  ].join("\n");
}

describe("parseMinutesResult", () => {
  it("accepts a contract-conforming body and extracts title/overview", () => {
    const result = parseMinutesResult(validMinutesBody(), "2026-07-30");
    expect("minutes" in result).toBe(true);
    if ("minutes" in result) {
      expect(result.minutes.title).toBe("2026-07-30 SalesTailor定例-要約");
      expect(result.minutes.overview).toContain("概要段落1");
      expect(result.minutes.overview).not.toContain("価格改定について");
      expect(result.minutes.body.length).toBeGreaterThanOrEqual(MIN_MINUTES_CHARS);
    }
  });

  it("strips code fences before validating", () => {
    const result = parseMinutesResult("```markdown\n" + validMinutesBody() + "\n```", "2026-07-30");
    expect("minutes" in result).toBe(true);
  });

  it("prefixes the date when the model omitted it", () => {
    const body = validMinutesBody().replace("2026-07-30 SalesTailor定例-要約", "SalesTailor定例-要約");
    const result = parseMinutesResult(body, "2026-07-30");
    if ("minutes" in result) {
      expect(result.minutes.title).toBe("2026-07-30 SalesTailor定例-要約");
    } else {
      throw new Error("expected minutes");
    }
  });

  it("rejects too-short output", () => {
    const result = parseMinutesResult("2026-07-30 定例-要約\n短い\n------------\nアクションアイテム", "2026-07-30");
    expect("error" in result && result.error.reason).toContain("too short");
  });

  it("rejects missing topic separators", () => {
    const body = validMinutesBody().replace(/^-{5,}\s*$/gm, "＝＝＝");
    const result = parseMinutesResult(body, "2026-07-30");
    expect("error" in result && result.error.reason).toContain("separators");
  });

  it("rejects missing action-item section", () => {
    const body = validMinutesBody().replace(/アクションアイテム/g, "TODO");
    const result = parseMinutesResult(body, "2026-07-30");
    expect("error" in result && result.error.reason).toContain("アクションアイテム");
  });

  it("rejects a malformed title line", () => {
    const body = validMinutesBody().replace("2026-07-30 SalesTailor定例-要約", "はじめに");
    const result = parseMinutesResult(body, "2026-07-30");
    expect("error" in result && result.error.reason).toContain("title");
  });

  it("rejects empty output", () => {
    expect("error" in parseMinutesResult("", "2026-07-30")).toBe(true);
  });
});

describe("fitSlackOverview", () => {
  it("caps an oversized overview and points readers to the thread", () => {
    const result = fitSlackOverview("概要\n" + "x".repeat(4_000));
    expect(result.length).toBeLessThanOrEqual(2_900);
    expect(result).toContain("概要");
    expect(result).toMatch(/全文はスレッド内）$/);
  });
});

describe("splitForSlack", () => {
  it("returns short text as a single chunk", () => {
    expect(splitForSlack("短いテキスト")).toEqual(["短いテキスト"]);
  });

  it("splits at newline boundaries under the limit", () => {
    const line = "あ".repeat(1000);
    const text = [line, line, line, line].join("\n");
    const chunks = splitForSlack(text, 2900);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2900);
    }
    expect(chunks.join("").replace(/\n/g, "")).toBe(text.replace(/\n/g, ""));
  });

  it("hard-splits when no boundary exists", () => {
    const chunks = splitForSlack("x".repeat(6000), 2900);
    expect(chunks.map((c) => c.length)).toEqual([2900, 2900, 200]);
  });
});
