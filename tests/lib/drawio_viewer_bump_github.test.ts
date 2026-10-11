import { describe, expect, test } from "bun:test";
import {
  compareChangedFiles,
  createBranchWithFiles,
  getBranchHeadSha,
  getRepoFileMeta,
  getRepoFileText,
  listOpenPullRequestHeads,
  listReleases,
  resolveTagCommit,
} from "../../f/factory/lib/drawio_viewer_bump_github.ts";
import { GitHubPaginationLimitError } from "../../f/factory/lib/github.ts";
import {
  createFakeCommandRunner,
  ghApiOk,
  ghApiStdout,
  ok,
} from "./testSupport.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const SHA_D = "d".repeat(40);

function clientFor(responses: Parameters<typeof createFakeCommandRunner>[0]) {
  const fake = createFakeCommandRunner(responses);
  return { fake, client: { run: fake.run, ghToken: "tok" } };
}

describe("listReleases", () => {
  test("maps the fields used to pick a release", async () => {
    const { client } = clientFor([
      ghApiOk([
        {
          tag_name: "v32.4.1",
          published_at: "2026-10-08T21:49:28Z",
          draft: false,
          prerelease: false,
          body: "ignored",
        },
      ]),
    ]);
    expect(await listReleases(client, "jgraph", "drawio")).toEqual([
      {
        tagName: "v32.4.1",
        publishedAt: "2026-10-08T21:49:28Z",
        draft: false,
        prerelease: false,
      },
    ]);
  });

  test("requests the first 100 releases", async () => {
    const { client, fake } = clientFor([ghApiOk([])]);
    await listReleases(client, "jgraph", "drawio");
    expect(fake.calls[0]?.argv).toContain(
      "repos/jgraph/drawio/releases?per_page=100",
    );
  });

  test("throws for an unexpected shape", async () => {
    const { client } = clientFor([ghApiOk([{ tag_name: 1 }])]);
    await expect(listReleases(client, "jgraph", "drawio")).rejects.toThrow(
      "unexpected response shape",
    );
  });
});

describe("resolveTagCommit", () => {
  test("returns the commit of a lightweight tag", async () => {
    const { client } = clientFor([
      ghApiOk({ object: { sha: SHA_A, type: "commit" } }),
    ]);
    expect(await resolveTagCommit(client, "jgraph", "drawio", "v1.0.0")).toBe(
      SHA_A,
    );
  });

  test("follows an annotated tag to its commit", async () => {
    const { client } = clientFor([
      ghApiOk({ object: { sha: SHA_A, type: "tag" } }),
      ghApiOk({ object: { sha: SHA_B, type: "commit" } }),
    ]);
    expect(await resolveTagCommit(client, "jgraph", "drawio", "v1.0.0")).toBe(
      SHA_B,
    );
  });

  test("rejects a tag that points at a tree", async () => {
    const { client } = clientFor([
      ghApiOk({ object: { sha: SHA_A, type: "tree" } }),
    ]);
    await expect(
      resolveTagCommit(client, "jgraph", "drawio", "v1.0.0"),
    ).rejects.toThrow("points at a tree");
  });

  test("rejects a tag name that could leave the refs path", async () => {
    const { client } = clientFor([]);
    await expect(
      resolveTagCommit(client, "jgraph", "drawio", "../heads/main"),
    ).rejects.toThrow("invalid tag name");
  });
});

describe("getRepoFileMeta", () => {
  test("returns the blob id and the size", async () => {
    const { client } = clientFor([
      ghApiOk({ type: "file", sha: SHA_A, size: 4360162, content: "" }),
    ]);
    expect(
      await getRepoFileMeta(client, "jgraph", "drawio", "src/a.js", SHA_B),
    ).toEqual({ sha: SHA_A, size: 4360162 });
  });

  test("passes the ref as a query parameter", async () => {
    const { client, fake } = clientFor([
      ghApiOk({ type: "file", sha: SHA_A, size: 1 }),
    ]);
    await getRepoFileMeta(client, "jgraph", "drawio", "src/a.js", SHA_B);
    expect(fake.calls[0]?.argv).toContain(
      `repos/jgraph/drawio/contents/src/a.js?ref=${SHA_B}`,
    );
  });

  test("rejects a directory", async () => {
    const { client } = clientFor([
      ghApiOk({ type: "dir", sha: SHA_A, size: 0 }),
    ]);
    await expect(
      getRepoFileMeta(client, "jgraph", "drawio", "src", SHA_B),
    ).rejects.toThrow("unexpected response shape");
  });
});

describe("getRepoFileText", () => {
  test("returns the raw body", async () => {
    const { client } = clientFor([
      ok(ghApiStdout(200, "line one\nline two\n")),
    ]);
    expect(
      await getRepoFileText(client, "acme", "widgets", "a.txt", "main"),
    ).toBe("line one\nline two\n");
  });

  test("asks for the raw media type", async () => {
    const { client, fake } = clientFor([ok(ghApiStdout(200, "x"))]);
    await getRepoFileText(client, "acme", "widgets", "a.txt", "main");
    expect(fake.calls[0]?.argv).toContain(
      "Accept: application/vnd.github.raw+json",
    );
  });
});

describe("getBranchHeadSha", () => {
  test("returns the commit id", async () => {
    const { client } = clientFor([ghApiOk({ object: { sha: SHA_A } })]);
    expect(await getBranchHeadSha(client, "acme", "widgets", "main")).toBe(
      SHA_A,
    );
  });

  test("returns null for a missing branch", async () => {
    const { client } = clientFor([
      ok(ghApiStdout(404, { message: "Not Found" })),
    ]);
    expect(
      await getBranchHeadSha(client, "acme", "widgets", "gone"),
    ).toBeNull();
  });
});

describe("listOpenPullRequestHeads", () => {
  const pr = (ref: string, fullName: string | null) => ({
    head: { ref, repo: fullName === null ? null : { full_name: fullName } },
  });

  test("returns the head branch names of this repository", async () => {
    const { client } = clientFor([
      ghApiOk([pr("feat/a", "acme/widgets"), pr("feat/b", "acme/widgets")]),
    ]);
    expect(await listOpenPullRequestHeads(client, "acme", "widgets")).toEqual([
      "feat/a",
      "feat/b",
    ]);
  });

  test("ignores a branch of another repository with the same name", async () => {
    const { client } = clientFor([
      ghApiOk([
        pr("factory/drawio-viewer-9.9.9", "attacker/widgets"),
        pr("feat/a", "acme/widgets"),
      ]),
    ]);
    expect(await listOpenPullRequestHeads(client, "acme", "widgets")).toEqual([
      "feat/a",
    ]);
  });

  test("ignores a pull request whose head repository was deleted", async () => {
    const { client } = clientFor([ghApiOk([pr("feat/a", null)])]);
    expect(await listOpenPullRequestHeads(client, "acme", "widgets")).toEqual(
      [],
    );
  });

  test("compares the repository name without regard to case", async () => {
    const { client } = clientFor([ghApiOk([pr("feat/a", "ACME/Widgets")])]);
    expect(await listOpenPullRequestHeads(client, "acme", "widgets")).toEqual([
      "feat/a",
    ]);
  });

  test("follows the next page after a full page of 100", async () => {
    const full = Array.from({ length: 100 }, (_, i) =>
      pr(`feat/${String(i)}`, "acme/widgets"),
    );
    const { client } = clientFor([
      ok(
        ghApiStdout(200, full, {
          link: '<https://api.github.com/repos/acme/widgets/pulls?page=2>; rel="next"',
        }),
      ),
      ghApiOk([pr("factory/drawio-viewer-32.5.0", "acme/widgets")]),
    ]);
    const heads = await listOpenPullRequestHeads(client, "acme", "widgets");
    expect(heads).toContain("factory/drawio-viewer-32.5.0");
  });

  test("fails when the pages never end", async () => {
    const link =
      '<https://api.github.com/repos/acme/widgets/pulls?page=2>; rel="next"';
    const { client } = clientFor(
      Array.from({ length: 11 }, () => ok(ghApiStdout(200, [], { link }))),
    );
    await expect(
      listOpenPullRequestHeads(client, "acme", "widgets"),
    ).rejects.toBeInstanceOf(GitHubPaginationLimitError);
  });
});

describe("compareChangedFiles", () => {
  test("returns the changed paths in sorted order", async () => {
    const { client } = clientFor([
      ghApiOk({ files: [{ filename: "b.json" }, { filename: "a.html" }] }),
    ]);
    expect(
      await compareChangedFiles(client, "acme", "widgets", "main", "feat/x"),
    ).toEqual(["a.html", "b.json"]);
  });

  test("compares from the base to the head with three dots", async () => {
    const { client, fake } = clientFor([ghApiOk({ files: [] })]);
    await compareChangedFiles(client, "acme", "widgets", "main", "feat/x");
    expect(fake.calls[0]?.argv).toContain(
      "repos/acme/widgets/compare/main...feat/x",
    );
  });

  test("throws for an unexpected shape", async () => {
    const { client } = clientFor([ghApiOk({ status: "ahead" })]);
    await expect(
      compareChangedFiles(client, "acme", "widgets", "main", "feat/x"),
    ).rejects.toThrow("unexpected response shape");
  });
});

describe("createBranchWithFiles", () => {
  const options = {
    baseBranch: "main",
    branch: "factory/drawio-viewer-32.5.0",
    message: "chore: update",
    files: [{ path: "console/a.json", content: "{}\n" }],
    identity: {
      name: "factory-bot",
      email: "1+factory-bot@users.noreply.github.com",
    },
  };

  function responses() {
    return [
      ghApiOk({ object: { sha: SHA_A } }),
      ghApiOk({ tree: { sha: SHA_B } }),
      ghApiOk({ sha: SHA_C }),
      ghApiOk({ sha: SHA_D }),
      ghApiOk({ ref: "refs/heads/x" }),
    ];
  }

  test("returns the new commit id", async () => {
    const { client } = clientFor(responses());
    expect(
      await createBranchWithFiles(client, "acme", "widgets", options),
    ).toBe(SHA_D);
  });

  test("builds the tree on top of the base tree", async () => {
    const { client, fake } = clientFor(responses());
    await createBranchWithFiles(client, "acme", "widgets", options);
    expect(fake.calls[2]?.options?.stdin).toBe(
      JSON.stringify({
        base_tree: SHA_B,
        tree: [
          {
            path: "console/a.json",
            mode: "100644",
            type: "blob",
            content: "{}\n",
          },
        ],
      }),
    );
  });

  test("commits with the given identity and the base as parent", async () => {
    const { client, fake } = clientFor(responses());
    await createBranchWithFiles(client, "acme", "widgets", options);
    expect(fake.calls[3]?.options?.stdin).toBe(
      JSON.stringify({
        message: "chore: update",
        tree: SHA_C,
        parents: [SHA_A],
        author: options.identity,
        committer: options.identity,
      }),
    );
  });

  test("points the new branch at the commit", async () => {
    const { client, fake } = clientFor(responses());
    await createBranchWithFiles(client, "acme", "widgets", options);
    expect(fake.calls[4]?.options?.stdin).toBe(
      JSON.stringify({ ref: `refs/heads/${options.branch}`, sha: SHA_D }),
    );
  });

  test("fails when the base branch is missing", async () => {
    const { client } = clientFor([
      ok(ghApiStdout(404, { message: "Not Found" })),
    ]);
    await expect(
      createBranchWithFiles(client, "acme", "widgets", options),
    ).rejects.toThrow("base branch not found");
  });
});
