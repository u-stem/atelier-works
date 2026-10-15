import { describe, expect, test } from "bun:test";
import { rehashRoundProbe } from "../../f/factory/lib/ci_metadata_rehash.ts";
import type { CommandRunner } from "../../f/factory/lib/workspace.ts";
import { ghApiOk, ok } from "./testSupport.ts";

const SHA = "a".repeat(40);
const REF = "factory/issue-3-wi-7";

type World = {
  prState: string;
  prHeadSha: string;
  jobs: readonly Record<string, unknown>[];
};

function rawPr(world: World) {
  return {
    number: 12,
    title: "t",
    body: "b",
    draft: false,
    state: world.prState,
    merged: false,
    head: {
      sha: world.prHeadSha,
      ref: REF,
      repo: { full_name: "acme/widgets" },
    },
    base: { ref: "main", repo: { full_name: "acme/widgets", id: 55 } },
    mergeable: true,
    mergeable_state: "clean",
    user: { login: "factory-bot", type: "User" },
    auto_merge: null,
  };
}

const RUN = {
  id: 101,
  workflow_id: 7,
  name: "CI",
  head_sha: SHA,
  head_branch: REF,
  event: "pull_request",
  status: "completed",
  conclusion: "failure",
  created_at: "2026-10-13T03:00:00Z",
  html_url: "https://github.com/acme/widgets/actions/runs/101",
  run_attempt: 1,
  head_repository: { id: 55, full_name: "acme/widgets" },
  pull_requests: [{ number: 12 }],
};

function job(name: string, conclusion: string, id: number) {
  return {
    id,
    run_id: 101,
    run_attempt: 1,
    head_sha: SHA,
    name,
    status: "completed",
    conclusion,
    steps: [],
  };
}

/** エンドポイントで答えを選ぶ、GitHubの偽物。`gh api`の引数にエンドポイントが入る。 */
function githubOf(world: World): CommandRunner {
  return async (argv) => {
    const text = argv.join(" ");
    if (text.includes("/jobs")) return ghApiOk({ jobs: world.jobs });
    if (text.includes("actions/runs?")) {
      return ghApiOk({ workflow_runs: [RUN] });
    }
    if (text.includes("pulls/12")) return ghApiOk(rawPr(world));
    return ok();
  };
}

async function probe(world: World): Promise<boolean> {
  const run = githubOf(world);
  return rehashRoundProbe({
    client: { run, ghToken: "tok", sleep: async () => {} },
    owner: "acme",
    repo: "widgets",
    prNumber: 12,
    headSha: SHA,
    run,
  })();
}

function world(over: Partial<World> = {}): World {
  return {
    prState: "open",
    prHeadSha: SHA,
    jobs: [job("metadata", "failure", 1)],
    ...over,
  };
}

describe("rehashRoundProbe", () => {
  test("is true when only the metadata job failed", async () => {
    expect(await probe(world())).toBe(true);
  });

  test("is false when the check job failed too", async () => {
    expect(
      await probe(
        world({
          jobs: [job("metadata", "failure", 1), job("check", "failure", 2)],
        }),
      ),
    ).toBe(false);
  });

  test("is false when only the check job failed", async () => {
    expect(await probe(world({ jobs: [job("check", "failure", 2)] }))).toBe(
      false,
    );
  });

  test("is false when the head of the pull request moved", async () => {
    expect(await probe(world({ prHeadSha: "b".repeat(40) }))).toBe(false);
  });

  test("is false when the pull request is closed", async () => {
    expect(await probe(world({ prState: "closed" }))).toBe(false);
  });

  test("is false when the metadata job succeeded", async () => {
    expect(await probe(world({ jobs: [job("metadata", "success", 1)] }))).toBe(
      false,
    );
  });

  test("reads the CI again for every call", async () => {
    let reads = 0;
    const base = githubOf(world());
    const run: CommandRunner = async (argv, options) => {
      if (argv.join(" ").includes("pulls/12")) reads += 1;
      return base(argv, options);
    };
    const subject = rehashRoundProbe({
      client: { run, ghToken: "tok", sleep: async () => {} },
      owner: "acme",
      repo: "widgets",
      prNumber: 12,
      headSha: SHA,
      run,
    });
    await subject();
    await subject();
    expect(reads).toBe(2);
  });
});
