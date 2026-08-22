import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const storyId = "story-brainbase-owned-company-authority-consumer";
const expectedReasonCodes = [
  "multi_tenant_failure_semantics_no_data",
  "multi_tenant_tenant_graph_edges",
  "multi_tenant_tenant_graph_entities",
  "multi_tenant_tenant_propagation_unverified",
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const run = (command, args, cwd, env = process.env) =>
  spawnSync(command, args, { cwd, env, encoding: null, maxBuffer: 16 * 1024 * 1024 });

const checked = (command, args, cwd) => {
  const result = run(command, args, cwd);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr?.toString("utf8") ?? ""}`);
  }
  return result.stdout;
};

const gitSnapshot = (repoRoot) => {
  const head = checked("git", ["rev-parse", "HEAD"], repoRoot).toString("utf8").trim();
  const porcelain = checked("git", ["status", "--porcelain=v2", "--untracked-files=all"], repoRoot);
  const unstaged = checked("git", ["diff", "--binary", "HEAD"], repoRoot);
  const staged = checked("git", ["diff", "--cached", "--binary", "HEAD"], repoRoot);
  const worktreeBytes = Buffer.concat([
    Buffer.from(head), Buffer.from([0]), porcelain, Buffer.from([0]), unstaged, Buffer.from([0]), staged,
  ]);
  return {
    head,
    porcelain_base64: porcelain.toString("base64"),
    porcelain_bytes: porcelain.length,
    porcelain_sha256: sha256(porcelain),
    worktree_fingerprint_sha256: sha256(worktreeBytes),
  };
};

const atomicWrite = async (path, bytes) => {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
};

const contentBinding = async (repoRoot) => {
  const paths = [
    ".vibepro/spec/story-brainbase-owned-company-authority-consumer/a0-evidence-conformance.test.mjs",
    ".vibepro/spec/story-brainbase-owned-company-authority-consumer/generate-spec-final-negative-evidence.mjs",
    ".vibepro/spec/story-brainbase-owned-company-authority-consumer/draft.json",
    ".vibepro/spec/story-brainbase-owned-company-authority-consumer/spec.json",
    ".vibepro/spec/story-brainbase-owned-company-authority-consumer/production-e2e-plan.json",
    ".vibepro/spec/story-brainbase-owned-company-authority-consumer/production-e2e-not-collected.test.mjs",
    "contracts/mana-brainbase-company-authority/v1/consumer-source-lock.json",
    "contracts/mana-brainbase-company-authority/v1/producer.contract.json",
    "contracts/mana-brainbase-company-authority/v1/fixtures/cases.json",
  ].sort();
  const files = [];
  const parts = [];
  for (const path of paths) {
    const bytes = await readFile(join(repoRoot, path));
    files.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
    parts.push(Buffer.from(path), Buffer.from([0]), bytes, Buffer.from([0]));
  }
  return { algorithm: "sha256(path\\0bytes\\0, sorted by path)", files, sha256: sha256(Buffer.concat(parts)) };
};

export async function generateSpecFinalNegativeEvidence({ repoRoot, artifactDir: artifactDirOverride }) {
  const root = resolve(fileURLToPath(repoRoot));
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const vibeproLookup = checked("which", ["vibepro"], root).toString("utf8").trim();
  const vibeproPath = await realpath(vibeproLookup);
  const versionBytes = checked(vibeproPath, ["--version"], root);
  const identityResult = run(vibeproPath, ["runtime", "identity", "--json"], root, childEnv);
  if (identityResult.status !== 0) throw new Error("vibepro runtime identity failed");
  const identityBytes = identityResult.stdout;
  const identity = JSON.parse(identityBytes.toString("utf8"));
  const argv = [
    "spec", "write", ".", "--id", storyId,
    "--input", `.vibepro/spec/${storyId}/draft.json`, "--final", "--caller", "codex", "--json",
  ];
  const before = gitSnapshot(root);
  const startedAt = new Date().toISOString();
  const result = run(vibeproPath, argv, root, childEnv);
  const finishedAt = new Date().toISOString();
  const after = gitSnapshot(root);
  const stdout = result.stdout ?? Buffer.alloc(0);
  const stderr = result.stderr ?? Buffer.alloc(0);
  let parsed = null;
  try { parsed = JSON.parse(stdout.toString("utf8")); } catch {}
  const reasonCodes = [...new Set((parsed?.errors ?? []).map(({ code }) => code).filter(Boolean))].sort();
  const rawLog = Buffer.concat([
    Buffer.from(`STDOUT_BYTES=${stdout.length}\n`), stdout,
    Buffer.from(`\nSTDERR_BYTES=${stderr.length}\n`), stderr,
  ]);
  const binding = await contentBinding(root);
  const artifactDir = artifactDirOverride
    ? resolve(artifactDirOverride)
    : join(root, ".vibepro", "pr", storyId, "spec-final-negative-evidence");
  await mkdir(artifactDir, { recursive: true });
  const manifestPath = join(artifactDir, "manifest.json");
  const logPath = join(artifactDir, "raw.log");
  const sidecarPath = join(artifactDir, "manifest.sha256");
  const manifestRelative = artifactDirOverride ? manifestPath : relative(root, manifestPath);
  const logRelative = artifactDirOverride ? logPath : relative(root, logPath);
  const manifest = {
    schema_version: "0.1.0",
    evidence_type: "vibepro_spec_final_rejection",
    story_id: storyId,
    manifest_path: manifestRelative,
    command: { executable: vibeproPath, argv, display: [vibeproPath, ...argv].join(" ") },
    exit_code: result.status,
    signal: result.signal,
    started_at: startedAt,
    finished_at: finishedAt,
    reason_codes: reasonCodes,
    expected_reason_codes: expectedReasonCodes,
    success_claim: false,
    production_proof: false,
    generator: {
      path: relative(root, fileURLToPath(import.meta.url)),
      runtime: process.execPath,
      node_version: process.version,
    },
    vibepro: {
      cli_path: vibeproPath,
      version: versionBytes.toString("utf8").trim(),
      version_sha256: sha256(versionBytes),
      runtime_identity: identity,
      runtime_identity_sha256: sha256(identityBytes),
    },
    git: {
      head_before: before.head,
      head_after: after.head,
      porcelain_bytes_before: before.porcelain_bytes,
      porcelain_bytes_after: after.porcelain_bytes,
      porcelain_base64_before: before.porcelain_base64,
      porcelain_base64_after: after.porcelain_base64,
      porcelain_sha256_before: before.porcelain_sha256,
      porcelain_sha256_after: after.porcelain_sha256,
      worktree_fingerprint_sha256_before: before.worktree_fingerprint_sha256,
      worktree_fingerprint_sha256_after: after.worktree_fingerprint_sha256,
      fingerprint_formula: "sha256(HEAD\\0porcelain-v2\\0git-diff-binary-HEAD\\0git-diff-cached-binary-HEAD)",
    },
    stdout: { bytes: stdout.length, sha256: sha256(stdout) },
    stderr: { bytes: stderr.length, sha256: sha256(stderr) },
    raw_log: { path: logRelative, bytes: rawLog.length, sha256: sha256(rawLog) },
    content_binding: binding,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestSha256 = sha256(manifestBytes);
  await atomicWrite(logPath, rawLog);
  await atomicWrite(manifestPath, manifestBytes);
  await atomicWrite(sidecarPath, Buffer.from(`${manifestSha256}\n`));

  if (result.status !== 2 || JSON.stringify(reasonCodes) !== JSON.stringify([...expectedReasonCodes].sort())) {
    throw new Error(`unexpected spec final result: exit=${result.status} reasons=${reasonCodes.join(",")}`);
  }
  if (before.head !== after.head || before.worktree_fingerprint_sha256 !== after.worktree_fingerprint_sha256) {
    throw new Error("spec final command mutated HEAD or worktree");
  }
  return { manifest, manifestPath, logPath, sidecarPath, manifestSha256 };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await generateSpecFinalNegativeEvidence({ repoRoot: new URL("../../../", import.meta.url) });
  process.stdout.write(`${JSON.stringify({
    manifest_path: result.manifest.manifest_path,
    manifest_sha256: result.manifestSha256,
    raw_log_path: result.manifest.raw_log.path,
    raw_log_sha256: result.manifest.raw_log.sha256,
    exit_code: result.manifest.exit_code,
    success_claim: result.manifest.success_claim,
  })}\n`);
}
