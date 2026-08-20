import { DurableObject } from "cloudflare:workers";

interface ActiveRun { runId: string; deadlineAt: string; startedAt: string }
const ACTIVE_KEY = "active-runs";
const INTAKE_PAUSED_KEY = "intake-paused";

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

  async setIntakePaused(paused: boolean): Promise<void> {
    await this.ctx.storage.put(INTAKE_PAUSED_KEY, paused);
  }

  async isIntakePaused(): Promise<boolean> {
    return await this.ctx.storage.get<boolean>(INTAKE_PAUSED_KEY) ?? false;
  }

  async status(): Promise<{ allowed: boolean; intakePaused: boolean; activeRuns: ActiveRun[] }> {
    const current = await this.ctx.storage.get<Record<string, ActiveRun>>(ACTIVE_KEY) ?? {};
    const activeRuns = Object.values(current).sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    return { allowed: activeRuns.length === 0, intakePaused: await this.isIntakePaused(), activeRuns };
  }
}
