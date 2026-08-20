import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface StoryReference {
  kind: string;
  ac_id: string;
}

interface SpecClause {
  id: string;
  origin: {
    story_refs: StoryReference[];
  };
}

interface VibeProSpec {
  clauses: SpecClause[];
}

const repositoryRoot = new URL("../../../../", import.meta.url);

function readRepositoryFile(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, repositoryRoot)), "utf8");
}

function readRepositoryJson<T>(path: string): T {
  return JSON.parse(readRepositoryFile(path)) as T;
}

function storyAcceptanceCriteria(story: string): Set<string> {
  return new Set(
    [...story.matchAll(/^\s*-\s*\[[ xX]\]\s*(AC-[0-9]{3})\s*:/gm)].map(
      (match) => match[1],
    ),
  );
}

function assertCanonicalStoryReferences(
  spec: VibeProSpec,
  canonicalAcceptanceCriteria: Set<string>,
): void {
  const referencedAcceptanceCriteria = new Set<string>();

  for (const clause of spec.clauses) {
    for (const reference of clause.origin.story_refs) {
      expect(reference.kind).toBe("acceptance_criteria");
      expect(
        canonicalAcceptanceCriteria.has(reference.ac_id),
        `${clause.id} references unknown Story AC ${reference.ac_id}`,
      ).toBe(true);
      referencedAcceptanceCriteria.add(reference.ac_id);
    }
  }

  expect(
    [...referencedAcceptanceCriteria].sort(),
    "Spec must cover every canonical Story AC exactly by ID",
  ).toEqual([...canonicalAcceptanceCriteria].sort());
}

describe("VibePro Story acceptance-criteria traceability", () => {
  const story = readRepositoryFile(
    "docs/management/stories/active/story-mana-multitenant-runtime.md",
  );
  const acceptedSpec = readRepositoryJson<VibeProSpec>(
    ".vibepro/spec/story-mana-multitenant-runtime/spec.json",
  );
  const publishedSpec = readRepositoryJson<VibeProSpec>(
    "docs/specs/story-mana-multitenant-runtime.vibepro.json",
  );
  const canonicalAcceptanceCriteria = storyAcceptanceCriteria(story);

  it("accepted Spec and published Spec reference canonical Story AC IDs", () => {
    expect(canonicalAcceptanceCriteria.size).toBe(27);
    assertCanonicalStoryReferences(acceptedSpec, canonicalAcceptanceCriteria);
    assertCanonicalStoryReferences(publishedSpec, canonicalAcceptanceCriteria);
  });

  it("rejects an unknown sequential synthetic AC ID instead of reporting clean", () => {
    const syntheticSpec = structuredClone(acceptedSpec);
    syntheticSpec.clauses[0].origin.story_refs[0].ac_id = "AC-1";

    expect(() =>
      assertCanonicalStoryReferences(syntheticSpec, canonicalAcceptanceCriteria),
    ).toThrow(/unknown Story AC AC-1/);
  });

  it("rejects an unreferenced canonical Story AC instead of reporting clean", () => {
    const incompleteSpec = structuredClone(acceptedSpec);
    for (const clause of incompleteSpec.clauses) {
      clause.origin.story_refs = clause.origin.story_refs.filter(
        (reference) => reference.ac_id !== "AC-007",
      );
    }

    expect(() =>
      assertCanonicalStoryReferences(incompleteSpec, canonicalAcceptanceCriteria),
    ).toThrow(/Spec must cover every canonical Story AC exactly by ID/);
  });
});
