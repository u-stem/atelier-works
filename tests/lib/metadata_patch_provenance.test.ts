import { describe, expect, test } from "bun:test";
import { checkProvenance } from "../../f/factory/lib/metadata_patch_verify.ts";
import { world } from "./metadata_patch_verify_world.ts";

// 出どころの検査は、実行の事実とPRの差分だけを見る。
// artifactとポートは渡さないので、ダウンロードと展開の前に呼べる。
function check(change: (w: ReturnType<typeof world>) => void) {
  const w = world();
  change(w);
  const result = checkProvenance({ config: w.config, run: w.run, pr: w.pr });
  return result === null ? "ok" : result.code;
}

describe("checkProvenance", () => {
  test("passes a run of the same repository for the same head", () => {
    expect(check(() => {})).toBe("ok");
  });

  test("rejects a run of another workflow", () => {
    expect(
      check((w) => {
        w.run = { ...w.run, workflowPath: ".github/workflows/evil.yml" };
      }),
    ).toBe("workflow_path_mismatch");
  });

  test("rejects an event other than pull_request", () => {
    expect(
      check((w) => {
        w.run = { ...w.run, event: "push" };
      }),
    ).toBe("event_mismatch");
  });

  test("rejects a run of a fork", () => {
    expect(
      check((w) => {
        w.run = { ...w.run, headRepositoryFullName: "mallory/widgets" };
      }),
    ).toBe("head_repository_mismatch");
  });

  test("rejects a run without a head repository", () => {
    expect(
      check((w) => {
        w.run = { ...w.run, headRepositoryFullName: null };
      }),
    ).toBe("head_repository_mismatch");
  });

  test("rejects a run of another pull request", () => {
    expect(
      check((w) => {
        w.run = { ...w.run, pullRequestNumbers: [7] };
      }),
    ).toBe("pull_request_mismatch");
  });

  test("rejects a run of an older head", () => {
    expect(
      check((w) => {
        w.run = { ...w.run, headSha: "e".repeat(40) };
      }),
    ).toBe("run_head_sha_mismatch");
  });

  test("rejects a run that did not fail", () => {
    expect(
      check((w) => {
        w.run = { ...w.run, conclusion: "success" };
      }),
    ).toBe("run_not_failed");
  });

  test("rejects a run whose metadata job did not fail", () => {
    expect(
      check((w) => {
        w.run = { ...w.run, metadataJobConclusion: "success" };
      }),
    ).toBe("metadata_job_not_failed");
  });

  test("rejects a diff that is cut short", () => {
    expect(
      check((w) => {
        w.pr = { ...w.pr, diffTruncated: true };
      }),
    ).toBe("pr_diff_incomplete");
  });

  test("rejects a diff outside the allow list", () => {
    expect(
      check((w) => {
        w.pr = {
          ...w.pr,
          diff: [...w.pr.diff, { path: "scripts/a.ts", status: "modified" }],
        };
      }),
    ).toBe("pr_diff_not_allowed");
  });

  test("rejects a rename from outside the allow list", () => {
    expect(
      check((w) => {
        w.pr = {
          ...w.pr,
          diff: [
            {
              path: "f/factory/a.ts",
              previousPath: "scripts/a.ts",
              status: "renamed",
            },
          ],
        };
      }),
    ).toBe("pr_diff_not_allowed");
  });
});
