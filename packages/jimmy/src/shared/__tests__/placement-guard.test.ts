import { describe, it, expect } from "vitest";
// The guard is a standalone asset (runs inside Claude's hook process), imported
// here directly so its pure evaluation logic and protected-path lists are unit
// tested against the gateway-side source of truth.
// @ts-expect-error — plain .mjs asset without type declarations
import { evaluateBashCommand, GUARD_PROTECTED_FILES, GUARD_PROTECTED_DIRS } from "../../../assets/placement-guard.mjs";
import { PLACEMENT_PROTECTED_FILES, PLACEMENT_PROTECTED_DIRS } from "../placement-profile.js";

const HOME = "/home/mana/.ryoko";
const OS_HOME = "/home/mana";
const ctx = { home: HOME, cwd: HOME, homedir: OS_HOME };

const deny = (cmd: string, c = ctx) => expect(evaluateBashCommand(cmd, c), cmd).toBeTruthy();
const allow = (cmd: string, c = ctx) => expect(evaluateBashCommand(cmd, c), cmd).toBeUndefined();

describe("placement-guard list sync", () => {
  it("embeds the same protected files/dirs as placement-profile.ts", () => {
    expect(GUARD_PROTECTED_FILES).toEqual(PLACEMENT_PROTECTED_FILES);
    expect(GUARD_PROTECTED_DIRS).toEqual(PLACEMENT_PROTECTED_DIRS);
  });
});

describe("evaluateBashCommand — denied writes", () => {
  it("blocks redirection into protected files (absolute, ~, $HOME, relative)", () => {
    deny(`echo x >> ${HOME}/CLAUDE.md`);
    deny("echo x > ~/.ryoko/CLAUDE.md");
    deny("echo x >> $HOME/.ryoko/SOUL.md");
    deny('echo x >> "${HOME}/.ryoko/MEMORY.md"');
    deny("echo x >> CLAUDE.md"); // cwd is JINN_HOME
    deny("echo x 2> ~/.ryoko/config.yaml");
    deny("echo x &> ~/.ryoko/skills/foo.md");
    deny("cat /tmp/a >| ~/.ryoko/IDENTITY.md");
  });

  it("blocks redirection hidden inside a nested shell string", () => {
    deny(`bash -c 'echo pwned >> ${HOME}/CLAUDE.md'`);
    deny(`sh -c "echo pwned > ~/.ryoko/memory/notes.md"`);
  });

  it("blocks write commands targeting protected paths", () => {
    deny("tee ~/.ryoko/CLAUDE.md < /tmp/x");
    deny("tee -a ~/.ryoko/skills/evil/SKILL.md");
    deny("mv /tmp/payload.md ~/.ryoko/CLAUDE.md");
    deny("cp /tmp/payload.md ~/.ryoko/CLAUDE.md");
    deny("sed -i 's/a/b/' ~/.ryoko/AGENTS.md");
    deny("sed -i.bak 's/a/b/' ~/.ryoko/AGENTS.md");
    deny("perl -i -pe 's/a/b/' ~/.ryoko/TOOLS.md");
    deny("rm -rf ~/.ryoko/memory");
    deny("rm ~/.ryoko/org/raci.yaml");
    deny("touch ~/.ryoko/skills/new.md");
    deny("mkdir -p ~/.ryoko/skills/backdoor");
    deny("ln -sf /tmp/evil.md ~/.ryoko/CLAUDE.md");
    deny("chmod 777 ~/.ryoko/config.yaml");
    deny("truncate -s 0 ~/.ryoko/MEMORY.md");
    deny("dd if=/tmp/x of=~/.ryoko/CLAUDE.md");
    deny("rsync /tmp/dir/ ~/.ryoko/knowledge");
    deny("install -m 644 /tmp/x ~/.ryoko/docs/x.md");
  });

  it("blocks writes to the enforcement machinery itself", () => {
    deny("echo x > ~/.ryoko/placement-guard.mjs");
    deny("cp /tmp/noop.mjs ~/.ryoko/hook-relay.mjs");
    deny("rm ~/.ryoko/gateway.json");
    deny(`echo '{}' > ${HOME}/tmp/settings/sess-1.json`);
  });

  it("blocks destructive ops on JINN_HOME itself", () => {
    deny("rm -rf ~/.ryoko");
    deny(`rm -rf ${HOME}/`);
  });

  it("blocks writes behind wrappers and compound commands", () => {
    deny("cd /tmp && echo x >> ~/.ryoko/CLAUDE.md");
    deny("true; sudo tee ~/.ryoko/CLAUDE.md");
    deny("cat /tmp/x | tee ~/.ryoko/CLAUDE.md");
    deny("env FOO=1 cp /tmp/x ~/.ryoko/SOUL.md");
    deny("timeout 5 rm -rf ~/.ryoko/skills");
  });

  it("blocks relative-path writes resolved against a protected cwd", () => {
    deny("echo x >> skills/evil.md");
    deny("rm -rf memory", ctx);
    deny("echo x >> ../CLAUDE.md", { ...ctx, cwd: `${HOME}/tmp` });
    deny("cd ~/.ryoko && echo x >> CLAUDE.md", { ...ctx, cwd: "/tmp/work" });
    deny("cd skills && rm SKILL.md"); // cd relative to protected cwd
  });
});

describe("evaluateBashCommand — allowed commands", () => {
  it("allows reads of protected paths", () => {
    allow("cat ~/.ryoko/CLAUDE.md");
    allow("grep -r pattern ~/.ryoko/skills");
    allow("ls -la ~/.ryoko/memory");
    allow("head CLAUDE.md");
    allow("sed 's/a/b/' ~/.ryoko/CLAUDE.md"); // no -i: read-only
    allow("cp ~/.ryoko/CLAUDE.md /tmp/copy.md"); // protected path is the SOURCE
    allow("diff ~/.ryoko/CLAUDE.md /tmp/other.md");
  });

  it("allows writes outside protected paths", () => {
    allow("echo x >> /tmp/scratch.txt");
    allow("echo x > ~/notes.txt"); // OS home, outside JINN_HOME
    allow(`echo x >> ${HOME}/tmp/work.txt`); // tmp/ itself is a working dir
    allow(`echo x >> ${HOME}/files/upload.bin`);
    allow("rm -rf /tmp/build");
    allow("mkdir -p /tmp/x && cp /tmp/a /tmp/x/");
    allow("sed -i 's/a/b/' /tmp/file.txt");
    allow("tee /tmp/out.log");
  });

  it("allows ordinary gateway API / dev commands", () => {
    allow("curl -s -X POST http://127.0.0.1:31013/api/tasks -d '{}'");
    allow("git -C /tmp/repo status");
    allow("npx vitest run");
    allow("node -e 'console.log(1)'");
    allow("echo 'docs: mention ~/.ryoko/CLAUDE.md in the README'"); // mention without redirection
  });

  it("allows everything when cwd is elsewhere and paths are relative", () => {
    allow("echo x >> CLAUDE.md", { ...ctx, cwd: "/tmp/work" });
    allow("rm -rf memory", { ...ctx, cwd: "/tmp/work" });
  });

  it("returns undefined for empty/invalid input", () => {
    allow("");
    expect(evaluateBashCommand(undefined, ctx)).toBeUndefined();
    expect(evaluateBashCommand("echo x >> ~/.ryoko/CLAUDE.md", {})).toBeUndefined(); // no home — cannot evaluate
  });
});
