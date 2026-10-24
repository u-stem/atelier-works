import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// 実際のプロセスで、フックの入口から読みの子プロセスまでを通して確かめる。
// `mise`は、PATHの先頭に置いた偽の実行ファイルに差し替える。
const ROOT = join(import.meta.dir, "../../..");
const HOOKS = join(ROOT, "scripts/claude-hooks");
const RUN = join(HOOKS, "run.sh");
const BUN_DIR = dirname(process.execPath);
const NODE_ON_PATH = Bun.which("node");

/** miseのshimではなく、実際のnodeの実行ファイル。環境変数の無い子から呼んでも動く。 */
const NODE =
  NODE_ON_PATH === null
    ? null
    : Bun.spawnSync([NODE_ON_PATH, "-p", "process.execPath"])
        .stdout.toString()
        .trim();

function nodeRunsTypeScript(): boolean {
  if (NODE === null) return false;
  const version = Bun.spawnSync([NODE, "--version"]).stdout.toString();
  return Number(/^v(\d+)/.exec(version)?.[1] ?? 0) >= 24;
}

function hookInput(command: string): string {
  return JSON.stringify({
    session_id: "session",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    cwd: ROOT,
  });
}

const HOLD_ROWS = JSON.stringify([
  {
    id: 7,
    scope: "merge",
    target: "example/test-hold",
    reason: "verify stage 5",
    holder_kind: "human",
    holder: "human",
    created_at: new Date(Date.now() - 3_600_000).toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    released_at: null,
    released_by: null,
  },
]);

function deployFreezeVariable(): string {
  const now = Date.now();
  return JSON.stringify({
    version: 1,
    freezes: [],
    deploy_freezes: [
      {
        id: "0123abcd",
        reason: "verify stage 5",
        holder_kind: "human",
        holder: "human",
        created_at: new Date(now - 60_000).toISOString(),
        expires_at: new Date(now + 3_600_000).toISOString(),
        released_at: null,
      },
    ],
  });
}

/** 偽の`mise`を置いた使い捨てのディレクトリで`run`を実行し、終わったら消す。 */
async function withFakeMise<T>(
  body: string,
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "merge-guard-"));
  try {
    writeFileSync(join(directory, "mise"), `#!/bin/sh\n${body}\n`);
    chmodSync(join(directory, "mise"), 0o755);
    return await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

type Finished = {
  readonly stdout: string;
  readonly exitCode: number;
  readonly elapsedMs: number;
};

async function launch(
  directory: string,
  command: string,
  program: readonly string[],
): Promise<Finished> {
  const started = Date.now();
  const child = Bun.spawn([...program], {
    stdin: new TextEncoder().encode(hookInput(command)),
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: `${directory}:${BUN_DIR}:/usr/bin:/bin` },
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return { stdout, exitCode, elapsedMs: Date.now() - started };
}

function viaLauncher(directory: string, command: string): Promise<Finished> {
  return launch(directory, command, ["/bin/sh", RUN, "merge-guard"]);
}

describe("the merge guard as a process", () => {
  test("allows a merge when the holds are empty", async () => {
    const finished = await withFakeMise('echo "[]"', (directory) =>
      viaLauncher(directory, "gh pr merge 1 --repo example/test-hold"),
    );
    expect(finished.stdout).toBe("");
  });

  test("denies a merge of the held repository", async () => {
    const finished = await withFakeMise(`echo '${HOLD_ROWS}'`, (directory) =>
      viaLauncher(directory, "gh pr merge 1 --repo example/test-hold"),
    );
    expect(finished.stdout).toContain('"permissionDecision":"deny"');
  });

  test("names the hold in the denial", async () => {
    const finished = await withFakeMise(`echo '${HOLD_ROWS}'`, (directory) =>
      viaLauncher(directory, "gh pr merge 1 --repo example/test-hold"),
    );
    expect(finished.stdout).toContain("merge hold 7");
  });

  test("allows a merge of another repository", async () => {
    const finished = await withFakeMise(`echo '${HOLD_ROWS}'`, (directory) =>
      viaLauncher(directory, "gh pr merge 1 --repo example/other"),
    );
    expect(finished.stdout).toBe("");
  });

  test("denies a merge when mise fails", async () => {
    const finished = await withFakeMise("exit 1", (directory) =>
      viaLauncher(directory, "gh pr merge 1"),
    );
    expect(finished.stdout).toContain('"permissionDecision":"deny"');
  });

  test("exits with 0 when it denies", async () => {
    const finished = await withFakeMise("exit 1", (directory) =>
      viaLauncher(directory, "gh pr merge 1"),
    );
    expect(finished.exitCode).toBe(0);
  });

  test("denies a deployment while a deploy freeze is active", async () => {
    const variable = JSON.stringify({ value: deployFreezeVariable() });
    const finished = await withFakeMise(
      `case "$*" in *wmill*) echo '${variable}' ;; *) echo '[]' ;; esac`,
      (directory) => viaLauncher(directory, "wmill sync push"),
    );
    expect(finished.stdout).toContain("0123abcd");
  });

  test("does not start mise for a command that is not guarded", async () => {
    const started = await withFakeMise(
      'touch "$0.ran"; echo "[]"',
      async (directory) => {
        await viaLauncher(directory, "git status");
        return existsSync(join(directory, "mise.ran"));
      },
    );
    expect(started).toBe(false);
  });

  test("runs mise exec in the repository root with docker compose", async () => {
    const args = await withFakeMise(
      'echo "$@" > "$0.args"; echo "[]"',
      async (directory) => {
        await viaLauncher(directory, "gh pr merge 1");
        return readFileSync(join(directory, "mise.args"), "utf8");
      },
    );
    expect(args).toContain(`exec -C ${ROOT} -- docker compose -f`);
  });

  test.each(["MISE_AUTO_INSTALL", "MISE_EXEC_AUTO_INSTALL"])(
    "turns off %s for the child",
    async (name) => {
      const value = await withFakeMise(
        `echo "$${name}" > "$0.env"; echo "[]"`,
        async (directory) => {
          await viaLauncher(directory, "gh pr merge 1");
          return readFileSync(join(directory, "mise.env"), "utf8").trim();
        },
      );
      expect(value).toBe("0");
    },
  );

  test("denies within the time limit when a grandchild keeps the output open", async () => {
    const finished = await withFakeMise("sleep 30 &\nwait", (directory) =>
      viaLauncher(directory, "gh pr merge 1"),
    );
    expect({
      denied: finished.stdout.includes('"permissionDecision":"deny"'),
      quick: finished.elapsedMs < 7500,
    }).toEqual({ denied: true, quick: true });
  }, 15_000);
});

describe("the merge guard under node", () => {
  test.skipIf(!nodeRunsTypeScript())(
    "allows a merge when the holds are empty",
    async () => {
      const finished = await withFakeMise('echo "[]"', (directory) =>
        launch(directory, "gh pr merge 1 --repo example/test-hold", [
          NODE ?? "node",
          join(HOOKS, "merge-guard.ts"),
        ]),
      );
      expect(finished.stdout).toBe("");
    },
  );

  test.skipIf(!nodeRunsTypeScript())(
    "denies a merge of the held repository",
    async () => {
      const finished = await withFakeMise(`echo '${HOLD_ROWS}'`, (directory) =>
        launch(directory, "gh pr merge 1 --repo example/test-hold", [
          NODE ?? "node",
          join(HOOKS, "merge-guard.ts"),
        ]),
      );
      expect(finished.stdout).toContain('"permissionDecision":"deny"');
    },
  );

  test.skipIf(!nodeRunsTypeScript())(
    "allows a command that is not guarded",
    async () => {
      const finished = await withFakeMise('echo "[]"', (directory) =>
        launch(directory, "git status", [
          NODE ?? "node",
          join(HOOKS, "merge-guard.ts"),
        ]),
      );
      expect(finished.stdout).toBe("");
    },
  );
});
