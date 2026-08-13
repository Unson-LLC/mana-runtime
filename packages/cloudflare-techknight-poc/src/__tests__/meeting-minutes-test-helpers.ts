import type { WorkspaceFs } from "../workspace-store.js";

export class MemoryFs implements WorkspaceFs {
  readonly files = new Map<string, string>();
  async mkdir(): Promise<void> {}
  async ls(prefix: string): Promise<string[]> { return [...this.files.keys()].filter((key) => key.startsWith(`${prefix}/`)); }
  async readFile(path: string): Promise<string> { const value = this.files.get(path); if (value === undefined) throw new Error("ENOENT"); return value; }
  async writeFile(path: string, value: string): Promise<void> { this.files.set(path, value); }
}
