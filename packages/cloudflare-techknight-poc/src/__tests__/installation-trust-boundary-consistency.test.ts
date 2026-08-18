import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const storyPath = "docs/management/stories/active/story-mana-multitenant-runtime.md";
const architecturePath = "docs/architecture/story-mana-multitenant-runtime.md";
const acceptedSpecPath = ".vibepro/spec/story-mana-multitenant-runtime/spec.json";
const publicSpecPath = "docs/specs/story-mana-multitenant-runtime.vibepro.json";
const canonicalContractPath = "contracts/mana-brainbase-tenant-context/v1/schema.json";
const repoRoot = new URL("../../../../", import.meta.url);

const readText = (path: string) => readFile(new URL(path, repoRoot), "utf8");

type Clause = {
  id: string;
  statement: string;
  [key: string]: unknown;
};

type VibeProSpec = {
  clauses: Clause[];
};

const readSpec = (path: string) =>
  readText(path).then((value) => JSON.parse(value) as VibeProSpec);

const clause = (spec: VibeProSpec, id: string) => {
  const value = spec.clauses.find((candidate) => candidate.id === id);
  expect(value, `Spec must contain ${id}`).toBeDefined();
  return value!;
};

describe("initial Slack installation trust boundary", () => {
  it("keeps Story and Architecture explicit and fail closed", async () => {
    const [story, architecture] = await Promise.all([
      readText(storyPath),
      readText(architecturePath),
    ]);

    for (const expected of [
      "認証済みtenant admin",
      "事前登録されたworkspace connection",
      "stateとnonce",
      "原子的に1回だけ消費",
      "workspace／enterprise／app衝突",
    ]) {
      expect(story).toContain(expected);
    }

    for (const expected of [
      "認証済みtenant admin",
      "事前登録connection",
      "state／nonce不一致",
      "replay",
      "CSRF",
      "cross-tenant衝突",
      "token保存とconnection登録の前",
    ]) {
      expect(architecture).toContain(expected);
    }
  });

  it("keeps accepted and public Specs on the same installation contract", async () => {
    const [accepted, published] = await Promise.all([
      readSpec(acceptedSpecPath),
      readSpec(publicSpecPath),
    ]);

    for (const spec of [accepted, published]) {
      expect(clause(spec, "C-001").statement).toMatch(/InstallationIntent/);
      expect(clause(spec, "C-001").statement).toMatch(/認証済みtenant admin/);
      expect(clause(spec, "C-001").statement).toMatch(/事前登録されたWorkspaceConnectionSnapshot/);
      expect(clause(spec, "C-001").statement).toMatch(/原子的に1回だけconsume/);
      expect(clause(spec, "INV-001").statement).toMatch(/INSTALLATION_STATE_REPLAYED/);
      expect(clause(spec, "INV-001").statement).toMatch(/INSTALLATION_BINDING_MISMATCH/);
      expect(clause(spec, "INV-001").statement).toMatch(/WORKSPACE_CONNECTION_CONFLICT/);
      expect(clause(spec, "INV-001").statement).toMatch(/token保存とconnection登録の前/);
    }

    expect(clause(published, "C-001")).toEqual(clause(accepted, "C-001"));
    expect(clause(published, "INV-001")).toEqual(clause(accepted, "INV-001"));
  });

  it("pins C-012 and C-015 to the canonical local PR #292 contract", async () => {
    const [accepted, published] = await Promise.all([
      readSpec(acceptedSpecPath),
      readSpec(publicSpecPath),
    ]);

    for (const spec of [accepted, published]) {
      for (const clauseId of ["C-012", "C-015"]) {
        const statement = clause(spec, clauseId).statement;
        expect(statement).toMatch(/PR #292/);
        expect(statement).toContain(canonicalContractPath);
        expect(statement).not.toMatch(/PR #237/);
      }
    }
  });
});
