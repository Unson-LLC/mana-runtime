import { describe, expect, it, vi } from "vitest";
import { executeRuntimeCron, parsePlacementCronJobs } from "../runtime-cron.js";

class Fs {
  files = new Map<string, string>();
  async mkdir() {}
  async readFile(path: string) { const value = this.files.get(path); if (!value) throw new Error("missing"); return value; }
  async writeFile(path: string, value: string) { this.files.set(path, value); }
}

const jobs = JSON.stringify([
  { id: "other", name: "Other", enabled: true, schedule: "0 8 * * *", timezone: "Asia/Tokyo", prompt: "x", delivery: { connector: "slack", channel: "C_OTHER" } },
  { id: "mine", name: "Mine", enabled: true, schedule: "0 9 * * *", timezone: "Asia/Tokyo", prompt: "y", delivery: { connector: "slack", channel: "C_MANA" } },
]);

describe("placement cron", () => {
  it("never exposes or runs a job whose delivery is outside the placement", async () => {
    const scoped = parsePlacementCronJobs(jobs, "C_MANA");
    expect(scoped.map((job) => job.id)).toEqual(["mine"]);
    const run = vi.fn();
    expect(await executeRuntimeCron({ fs: new Fs(), jobs: scoped, action: "run", target: "other", run })).toContain("見つかりません");
    expect(run).not.toHaveBeenCalled();
  });

  it("persists an enable override and runs an allowed job", async () => {
    const fs = new Fs();
    const scoped = parsePlacementCronJobs(jobs, "C_MANA");
    expect(await executeRuntimeCron({ fs, jobs: scoped, action: "disable", target: "mine", run: vi.fn() })).toContain("無効");
    expect(await executeRuntimeCron({ fs, jobs: scoped, action: "list", run: vi.fn() })).toContain("無効");
    const run = vi.fn();
    await executeRuntimeCron({ fs, jobs: scoped, action: "run", target: "mine", run });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: "mine" }));
  });
});
