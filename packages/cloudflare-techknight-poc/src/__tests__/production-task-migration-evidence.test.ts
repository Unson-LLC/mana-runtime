import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface ProductionTaskMigrationEvidence {
  schema_version: string;
  evidence_type: string;
  collected_at: string;
  channel: {
    channel_id: string;
    thread_ts: string;
    placement_id: string;
    project_codes: string[];
  };
  cloudflare: {
    current: {
      worker_version: string;
      traffic_percent: number;
      release_tag: string | null;
      git_sha: string;
      git_sha_provenance: string;
      script_etag: string;
      task_search_enabled: boolean;
      task_write_enabled: boolean;
      task_board_enabled: boolean;
      handlers: string[];
    };
    mutation_e2e_deployment: {
      worker_version: string;
      release_tag: string;
      git_sha: string;
    };
    container: {
      state: string;
      healthy_instances: number;
      failed_instances: number;
      image_digest: string;
    };
  };
  slack_e2e: {
    mutation: {
      request_url: string;
      response_url: string;
      title: string;
      original_task_id: string;
      create: { version: number; status: string };
      update: { version: number; description: string };
      transition: { version: number; status: string };
      failed_operations: number;
    };
    post_cutover_readback: {
      request_url: string;
      response_url: string;
      response_count: number;
      read_status: string;
      has_more: boolean;
      next_cursor: string | null;
      tasks: Array<{ title: string; matches: number; status: string; version: number }>;
    };
  };
  brainbase: {
    read_status: string;
    secret_values_read: boolean;
    tasks: Array<{
      title: string;
      status: string;
      description: string | null;
      project_codes: string[];
      version: number;
    }>;
  };
  canvas: {
    title: string;
    subtitle: string;
    counts: { pending: number; in_progress: number; waiting: number; completed: number };
    visible_titles: string[];
    screenshot: { sha256: string; width: number; height: number };
  };
  lightsail: {
    config_git_sha: string;
    service: { active_state: string; sub_state: string; restart_count: number };
    task_ownership: { placement_enabled: boolean; task_canvas_enabled: boolean };
  };
  ownership_assertion: {
    task_search_owner: string;
    task_write_owner: string;
    task_board_owner: string;
    lightsail_task_owner_enabled: boolean;
    duplicate_slack_response_observed: boolean;
  };
  scope_boundary: { meeting_minutes: string; lightsail_service_shutdown: string };
}

const evidencePath = fileURLToPath(
  new URL(
    "../../../../docs/operations/cloudflare-task-migration-evidence-2026-08-13.json",
    import.meta.url,
  ),
);
const evidence = JSON.parse(
  readFileSync(evidencePath, "utf8"),
) as ProductionTaskMigrationEvidence;

function taskByTitle(title: string) {
  return evidence.brainbase.tasks.find((task) => task.title === title);
}

describe("recorded production task migration evidence contract", () => {
  it("binds the production Slack mutation to the exact Worker and Container", () => {
    expect(evidence).toMatchObject({
      schema_version: "1.0",
      evidence_type: "production_task_migration_readback",
      channel: {
        channel_id: "C0BKS6RL99T",
        thread_ts: "1786507594.889229",
        placement_id: "mana-accounting",
        project_codes: ["back-office"],
      },
      cloudflare: {
        mutation_e2e_deployment: {
          worker_version: "38c2737b-2a91-4ebe-b9bf-714327830441",
          release_tag: "git-d295c866",
          git_sha: "d295c8660b5bd842125ffe7ce9e46b2ba171b7fa",
        },
        container: {
          state: "ready",
          healthy_instances: 1,
          failed_instances: 0,
          image_digest:
            "sha256:e9c204b29e130ae387cd551260b302ad345a4598596c41dbf80f81c88ca4a985",
        },
      },
    });
    expect(evidence.slack_e2e.mutation).toMatchObject({
      title: "CF-BOARD-CUTOVER-E2E-2026-08-13-D295C86",
      original_task_id: "ecb21497-1378-4807-9ff8-387701c29040",
      create: { version: 1, status: "pending" },
      update: { version: 2, description: "cloudflare-board-confirmed" },
      transition: { version: 3, status: "completed" },
      failed_operations: 0,
    });
  });

  it("cross-checks current Slack and Canonical Task readbacks", () => {
    const mutation = evidence.slack_e2e.mutation;
    const slackReadback = evidence.slack_e2e.post_cutover_readback;
    const canonicalMutation = taskByTitle(mutation.title);
    const visibilityTitle = "CF-BOARD-VISIBILITY-2026-08-13-D295C86";
    const canonicalVisibility = taskByTitle(visibilityTitle);

    expect(mutation.request_url).toContain("1786620460252009");
    expect(mutation.response_url).toContain("1786620541481209");
    expect(slackReadback.request_url).toContain("1786621060124339");
    expect(slackReadback.response_url).toContain("1786621120419909");
    expect(slackReadback).toMatchObject({
      response_count: 1,
      read_status: "complete",
      has_more: false,
      next_cursor: null,
    });
    expect(slackReadback.tasks).toEqual(
      expect.arrayContaining([
        { title: mutation.title, matches: 1, status: "completed", version: 3 },
        { title: visibilityTitle, matches: 1, status: "pending", version: 1 },
      ]),
    );
    expect(evidence.brainbase.read_status).toBe("complete");
    expect(evidence.brainbase.secret_values_read).toBe(false);
    expect(canonicalMutation).toMatchObject({
      status: "completed",
      description: "cloudflare-board-confirmed",
      project_codes: ["back-office"],
      version: 3,
    });
    expect(canonicalVisibility).toMatchObject({
      status: "pending",
      project_codes: ["back-office"],
      version: 1,
    });
  });

  it("cross-checks the Canonical Task with the current bounded Canvas", () => {
    const visibilityTitle = "CF-BOARD-VISIBILITY-2026-08-13-D295C86";
    expect(taskByTitle(visibilityTitle)).toBeDefined();
    expect(evidence.canvas).toMatchObject({
      title: "タスクボード",
      subtitle: "Brainbase同期（読み取り専用） | 対象project: back-office",
      counts: { pending: 7, in_progress: 0, waiting: 0, completed: 6 },
    });
    expect(evidence.canvas.visible_titles).toContain(visibilityTitle);
    expect(evidence.canvas.screenshot.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.canvas.screenshot.width).toBeGreaterThan(0);
    expect(evidence.canvas.screenshot.height).toBeGreaterThan(0);
  });

  it("binds current Cloudflare ownership to disabled Lightsail task surfaces", () => {
    expect(evidence.cloudflare.current).toMatchObject({
      worker_version: "1ba0353e-223b-40df-a853-578a43d71f32",
      traffic_percent: 100,
      release_tag: null,
      git_sha: "354c29a",
      git_sha_provenance:
        "PR #132 merge commit checked out in the deployment worktree; deploy message git-354c29a PR #132; Cloudflare release tag is absent",
      script_etag: "5476268e7fc900fea625d037de8c5438a13b91b1d8ca19319092de7a8b732344",
      task_search_enabled: true,
      task_write_enabled: true,
      task_board_enabled: true,
    });
    expect(evidence.cloudflare.current.handlers).toEqual(
      expect.arrayContaining(["fetch", "queue", "scheduled"]),
    );
    expect(evidence.lightsail).toMatchObject({
      config_git_sha: "9139b37608b95df16e99cbaceb6bd880b422e12d",
      service: { active_state: "active", sub_state: "running", restart_count: 0 },
      task_ownership: { placement_enabled: false, task_canvas_enabled: false },
    });
    expect(evidence.ownership_assertion).toEqual({
      task_search_owner: "cloudflare",
      task_write_owner: "cloudflare",
      task_board_owner: "cloudflare",
      lightsail_task_owner_enabled: false,
      duplicate_slack_response_observed: false,
    });
  });

  it("keeps the later meeting-minutes migration outside task evidence", () => {
    expect(evidence.scope_boundary.meeting_minutes).toContain("Separate migration");
    expect(evidence.scope_boundary.meeting_minutes).toContain("PR #128");
    expect(evidence.scope_boundary.meeting_minutes).toContain(
      "neither state is used as evidence for this task migration",
    );
    expect(evidence.scope_boundary.lightsail_service_shutdown).toContain("Out of scope");
  });
});
