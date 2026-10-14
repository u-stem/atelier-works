import { describe, expect, test } from "bun:test";
import {
  GitHubResponseError,
  listWorkflowRunArtifacts,
} from "../../f/factory/lib/github.ts";
import { createFakeCommandRunner, ghApiOk } from "./testSupport.ts";

const SHA = "a".repeat(40);

const rawArtifact = (overrides: Record<string, unknown> = {}) => ({
  id: 9001,
  name: "metadata-patch",
  size_in_bytes: 1234,
  expired: false,
  digest: `sha256:${"b".repeat(64)}`,
  workflow_run: {
    id: 555,
    head_sha: SHA,
    head_branch: "factory/x",
    head_repository_id: 77,
  },
  ...overrides,
});

const client = (fake: ReturnType<typeof createFakeCommandRunner>) => ({
  run: fake.run,
  ghToken: "tok",
  sleep: async () => {},
});

describe("listWorkflowRunArtifacts", () => {
  const list = (
    fake: ReturnType<typeof createFakeCommandRunner>,
    name?: string,
  ) => listWorkflowRunArtifacts(client(fake), "acme", "widgets", 555, name);

  test("asks for the artifacts of that run", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ artifacts: [] })]);
    await list(fake);
    expect(fake.calls[0]?.argv).toContain(
      "repos/acme/widgets/actions/runs/555/artifacts?per_page=100",
    );
  });

  test("filters by name when given", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ artifacts: [] })]);
    await list(fake, "metadata-patch");
    expect(fake.calls[0]?.argv).toContain(
      "repos/acme/widgets/actions/runs/555/artifacts?per_page=100&name=metadata-patch",
    );
  });

  test("returns the artifacts with the fields to check", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({ artifacts: [rawArtifact()] }),
    ]);
    expect(await list(fake)).toEqual([
      {
        id: 9001,
        name: "metadata-patch",
        sizeInBytes: 1234,
        expired: false,
        digest: `sha256:${"b".repeat(64)}`,
        runId: 555,
        headSha: SHA,
        headBranch: "factory/x",
      },
    ]);
  });

  test("returns null for fields that GitHub leaves out", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({
        artifacts: [
          rawArtifact({ digest: undefined, workflow_run: undefined }),
        ],
      }),
    ]);
    const [artifact] = await list(fake);
    expect([artifact?.digest, artifact?.runId, artifact?.headSha]).toEqual([
      null,
      null,
      null,
    ]);
  });

  test("rejects an artifact of another run", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({
        artifacts: [rawArtifact({ workflow_run: { id: 1, head_sha: SHA } })],
      }),
    ]);
    await expect(list(fake)).rejects.toBeInstanceOf(GitHubResponseError);
  });

  test("rejects a response of an unexpected shape", async () => {
    const fake = createFakeCommandRunner([ghApiOk({ artifacts: "no" })]);
    await expect(list(fake)).rejects.toThrow("unexpected response shape");
  });

  test("rejects an artifact with a negative size", async () => {
    const fake = createFakeCommandRunner([
      ghApiOk({ artifacts: [rawArtifact({ size_in_bytes: -1 })] }),
    ]);
    await expect(list(fake)).rejects.toThrow("unexpected response shape");
  });

  test("rejects a run id that is not a positive integer", async () => {
    const fake = createFakeCommandRunner([]);
    await expect(
      listWorkflowRunArtifacts(client(fake), "acme", "widgets", 0),
    ).rejects.toThrow("invalid run id");
  });
});
