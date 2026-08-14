import {
  applyNewSessionCommand,
  readWorkspaceSession,
  type WorkspaceSessionFs,
} from "../workspace-session.js";

class MemoryFs implements WorkspaceSessionFs {
  readonly files = new Map<string, string>();

  async mkdir(): Promise<void> {}

  async readFile(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) {
      const error = new Error("not found") as Error & { code: string };
      error.code = "ENOENT";
      throw error;
    }
    return value;
  }

  async writeFile(path: string, value: string): Promise<void> {
    this.files.set(path, value);
  }
}

describe("workspace session control commands", () => {
  it("increments /new generation exactly once for the same command id", async () => {
    const fs = new MemoryFs();

    await expect(applyNewSessionCommand(fs, {
      commandId: "cmd-1786677816.307859-U_UMEDA",
      requestedAt: "2026-08-14T09:00:00.000Z",
    })).resolves.toMatchObject({ generation: 2, applied: true });

    await expect(applyNewSessionCommand(fs, {
      commandId: "cmd-1786677816.307859-U_UMEDA",
      requestedAt: "2026-08-14T09:00:01.000Z",
    })).resolves.toMatchObject({ generation: 2, applied: false });

    await expect(readWorkspaceSession(fs)).resolves.toMatchObject({
      generation: 2,
      lastNewCommandId: "cmd-1786677816.307859-U_UMEDA",
    });
  });
});
