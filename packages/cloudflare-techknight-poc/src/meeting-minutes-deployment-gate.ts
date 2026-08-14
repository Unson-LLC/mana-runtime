import { DurableObject } from "cloudflare:workers";

interface ActiveRun { runId: string; deadlineAt: string; startedAt: string }
const ACTIVE_KEY = "active-runs";

export class MeetingMinutesDeploymentGate extends DurableObject {
  async markActive(run: ActiveRun): Promise<void> {
    const current = await this.ctx.storage.get<Record<string, ActiveRun>>(ACTIVE_KEY) ?? {};
    current[run.runId] = run;
    await this.ctx.storage.put(ACTIVE_KEY, current);
  }

  async markTerminal(runId: string): Promise<void> {
    const current = await this.ctx.storage.get<Record<string, ActiveRun>>(ACTIVE_KEY) ?? {};
    if (!(runId in current)) return;
    delete current[runId];
    await this.ctx.storage.put(ACTIVE_KEY, current);
  }

  async status(): Promise<{ allowed: boolean; activeRuns: ActiveRun[] }> {
    const current = await this.ctx.storage.get<Record<string, ActiveRun>>(ACTIVE_KEY) ?? {};
    const activeRuns = Object.values(current).sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    return { allowed: activeRuns.length === 0, activeRuns };
  }
}
