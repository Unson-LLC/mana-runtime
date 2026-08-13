import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const evidence = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../docs/operations/cloudflare-task-migration-cutover-2026-08-13.md",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("production Cloudflare task migration evidence", () => {
  it("binds the production Slack mutation to the deployed Worker and Container", () => {
    expect(evidence).toContain("1786620460252009");
    expect(evidence).toContain("1786620541481209");
    expect(evidence).toContain("ecb21497-1378-4807-9ff8-387701c29040");
    expect(evidence).toContain("create: version 1");
    expect(evidence).toContain("update: version 2");
    expect(evidence).toContain("transition: version 3");
    expect(evidence).toContain("38c2737b-2a91-4ebe-b9bf-714327830441");
    expect(evidence).toContain("d295c8660b5bd842125ffe7ce9e46b2ba171b7fa");
    expect(evidence).toContain(
      "sha256:e9c204b29e130ae387cd551260b302ad345a4598596c41dbf80f81c88ca4a985",
    );
  });

  it("binds the Brainbase task to the updated channel Canvas", () => {
    expect(evidence).toContain("fbc06c5f-eec0-424c-9e2f-5e0689e2e337");
    expect(evidence).toContain("Canvas: pendingが6件から7件へ更新");
    expect(evidence).toContain("pending 7件、completed 6件");
    expect(evidence).toContain("4 statusの上限付き取得");
  });

  it("binds single ownership and keeps meeting minutes out of the task cutover", () => {
    expect(evidence).toContain("mana-accounting.enabled=false");
    expect(evidence).toContain("taskCanvas.enabled=false");
    expect(evidence).toContain("meetingMinutesPipeline.enabled=true");
    expect(evidence).toContain("重複応答: 観測なし");
    expect(evidence).toContain("議事録処理はこの切替の対象外");
    expect(evidence).toContain("Cloudflareを先にOFF");
  });
});
