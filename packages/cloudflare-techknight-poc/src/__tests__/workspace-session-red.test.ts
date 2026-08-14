import {
  applyNewSessionCommand,
  markClaudeSessionStarted,
  markWorkspaceEngaged,
  reconcilePermissionRevision,
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
  it("reads persisted session state when the workspace returns a stream", async () => {
    const fs = new MemoryFs();
    await markWorkspaceEngaged(fs, "2026-08-14T09:00:00Z");
    const streamFs: WorkspaceSessionFs = {
      mkdir: async () => undefined,
      writeFile: (...args) => fs.writeFile(...args),
      readFile: async (path) => new Response(await fs.readFile(path)).body!,
    };

    await expect(readWorkspaceSession(streamFs)).resolves.toMatchObject({
      generation: 1,
      engaged: true,
      updatedAt: "2026-08-14T09:00:00Z",
    });
  });

  it("increments /new generation exactly once for the same command id", async () => {
    const fs = new MemoryFs();

    await expect(applyNewSessionCommand(fs, {
      commandId: "cmd-1786677816.307859-U_UMEDA",
      requestedAt: "2026-08-14T09:00:00.000Z",
      messageTs: "1786677816.307859",
    })).resolves.toMatchObject({ generation: 2, applied: true });

    await expect(applyNewSessionCommand(fs, {
      commandId: "cmd-1786677816.307859-U_UMEDA",
      requestedAt: "2026-08-14T09:00:01.000Z",
      messageTs: "1786677816.307859",
    })).resolves.toMatchObject({ generation: 2, applied: false });

    await expect(readWorkspaceSession(fs)).resolves.toMatchObject({
      generation: 2,
      lastNewCommandId: "cmd-1786677816.307859-U_UMEDA",
      contextAfterTs: "1786677816.307859",
    });
  });

  it("regenerates the session only when the placement permission revision changes", async () => {
    const fs = new MemoryFs();
    await expect(reconcilePermissionRevision(fs, "permissions-v1", "2026-08-14T09:00:00Z"))
      .resolves.toMatchObject({ generation: 1, changed: false });
    await expect(reconcilePermissionRevision(fs, "permissions-v1", "2026-08-14T09:01:00Z"))
      .resolves.toMatchObject({ generation: 1, changed: false });
    await expect(reconcilePermissionRevision(fs, "permissions-v2", "2026-08-14T09:02:00Z"))
      .resolves.toMatchObject({ generation: 2, changed: true });
  });

  it("records Claude startup only for the active generation and /new clears it", async () => {
    const fs = new MemoryFs();
    await markClaudeSessionStarted(fs, 1, "2026-08-14T09:00:00Z");
    await expect(readWorkspaceSession(fs)).resolves.toMatchObject({ claudeSessionStartedGeneration: 1 });
    await applyNewSessionCommand(fs, { commandId: "new-1", requestedAt: "2026-08-14T09:01:00Z" });
    await expect(readWorkspaceSession(fs)).resolves.not.toHaveProperty("claudeSessionStartedGeneration");
    await markClaudeSessionStarted(fs, 1, "2026-08-14T09:02:00Z");
    await expect(readWorkspaceSession(fs)).resolves.not.toHaveProperty("claudeSessionStartedGeneration");
  });
});
