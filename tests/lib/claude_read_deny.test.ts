// 調査のClaudeの読み出しを塞ぐ固定の一覧と、設定の書き出しを固定する。
// 保護パスに置く。一覧や書き出しの条件を緩める変更が、このテストを書き換えて通らないようにするため。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCwdOutsideDeny,
  assertJobConfigDir,
  buildReadDenyPaths,
  buildReadDenySettings,
  prepareReadDenySettings,
  READ_DENY_BASE_PATHS,
  ReadDenyError,
  readDenyRules,
} from "../../f/factory/lib/claude_read_deny.ts";

const JOB_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_JOB_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("READ_DENY_BASE_PATHS", () => {
  test("is the fixed list of the places the worker keeps secrets in", () => {
    expect(READ_DENY_BASE_PATHS).toEqual([
      "/proc",
      "/dev/fd",
      "/dev/stdin",
      "/run",
      "/var/lib/factory",
      "/root",
      "/tmp",
      "/var/tmp",
      "/etc",
      "/workspaces",
      "/tmp/windmill",
    ]);
  });
});

describe("buildReadDenyPaths", () => {
  test("adds the resolved home to the fixed list", () => {
    expect(buildReadDenyPaths("/home/worker")).toEqual([
      ...READ_DENY_BASE_PATHS,
      "/home/worker",
    ]);
  });

  test("does not repeat a home that the fixed list already has", () => {
    expect(buildReadDenyPaths("/root")).toEqual([...READ_DENY_BASE_PATHS]);
  });

  test("drops a trailing slash of the home", () => {
    expect(buildReadDenyPaths("/home/worker/")).toContain("/home/worker");
  });

  test.each([
    ["a relative path", "home/worker"],
    ["the filesystem root", "/"],
    ["an empty string", ""],
    ["a path with a parent segment", "/home/../etc"],
    ["a path with a glob character", "/home/*"],
    ["a path with a parenthesis", "/home/a)b"],
  ])("throws for a home that is %s", (_name, home) => {
    expect(() => buildReadDenyPaths(home)).toThrow(ReadDenyError);
  });
});

describe("readDenyRules", () => {
  test("writes both the path itself and everything below it for each path", () => {
    expect(readDenyRules(["/proc", "/var/lib/factory"])).toEqual([
      "Read(//proc)",
      "Read(//proc/**)",
      "Read(//var/lib/factory)",
      "Read(//var/lib/factory/**)",
    ]);
  });

  test("gives two rules for every path of the full list", () => {
    expect(readDenyRules(buildReadDenyPaths("/home/worker"))).toHaveLength(24);
  });

  test.each([
    ["a relative path", "proc"],
    ["a path with a parent segment", "/proc/../etc"],
    ["a path with a doubled slash", "/proc//self"],
    ["a path with a glob character", "/pro?"],
    ["the filesystem root", "/"],
  ])("throws for %s", (_name, path) => {
    expect(() => readDenyRules([path])).toThrow(ReadDenyError);
  });
});

describe("buildReadDenySettings", () => {
  test("holds the rules under permissions.deny", () => {
    const parsed: unknown = JSON.parse(buildReadDenySettings(["/proc"]));
    expect(parsed).toEqual({
      permissions: { deny: ["Read(//proc)", "Read(//proc/**)"] },
    });
  });
});

describe("assertCwdOutsideDeny", () => {
  const paths = buildReadDenyPaths("/home/worker");

  test("accepts a directory outside every denied path", () => {
    expect(() =>
      assertCwdOutsideDeny("/srv/investigate/12", paths, () => null),
    ).not.toThrow();
  });

  test("accepts a sibling whose name only starts like a denied path", () => {
    expect(() =>
      assertCwdOutsideDeny(
        "/var/lib/factory-investigate/12",
        paths,
        () => null,
      ),
    ).not.toThrow();
  });

  test("throws for a denied path itself", () => {
    expect(() =>
      assertCwdOutsideDeny("/workspaces", paths, () => null),
    ).toThrow(ReadDenyError);
  });

  test("throws for a directory below a denied path", () => {
    expect(() =>
      assertCwdOutsideDeny("/workspaces/repo/investigate-1", paths, () => null),
    ).toThrow(ReadDenyError);
  });

  test("throws for a directory below the home", () => {
    expect(() =>
      assertCwdOutsideDeny("/home/worker/work", paths, () => null),
    ).toThrow(ReadDenyError);
  });

  test("throws for a path that reaches a denied path through a parent segment", () => {
    expect(() =>
      assertCwdOutsideDeny("/srv/../workspaces/x", paths, () => null),
    ).toThrow(ReadDenyError);
  });

  test("throws when the real path of the directory is below a denied path", () => {
    expect(() =>
      assertCwdOutsideDeny("/srv/link", paths, () => "/run/factory-tmp/x"),
    ).toThrow(ReadDenyError);
  });

  test("throws for a relative directory", () => {
    expect(() => assertCwdOutsideDeny("work", paths, () => null)).toThrow(
      ReadDenyError,
    );
  });
});

describe("assertJobConfigDir", () => {
  const root = "/run/factory-tmp";
  const context = { env: { WM_JOB_ID: JOB_ID }, root };
  const jobDir = `${root}/fj-${JOB_ID}`;

  test("returns a directory below the directory of this job", () => {
    expect(assertJobConfigDir(`${jobDir}/claude-config`, context)).toBe(
      `${jobDir}/claude-config`,
    );
  });

  test("throws when no directory is given", () => {
    expect(() => assertJobConfigDir(undefined, context)).toThrow(ReadDenyError);
  });

  test("throws for the directory of this job itself", () => {
    expect(() => assertJobConfigDir(jobDir, context)).toThrow(ReadDenyError);
  });

  test("throws for a directory outside the parent of the job directories", () => {
    expect(() => assertJobConfigDir("/root/.claude", context)).toThrow(
      ReadDenyError,
    );
  });

  test("throws for the directory of another job", () => {
    expect(() =>
      assertJobConfigDir(`${root}/fj-${OTHER_JOB_ID}/claude-config`, context),
    ).toThrow(ReadDenyError);
  });

  test("throws for a sibling whose name only starts like the job directory", () => {
    expect(() =>
      assertJobConfigDir(`${jobDir}-evil/claude-config`, context),
    ).toThrow(ReadDenyError);
  });

  test("throws for a path that leaves the job directory through a parent segment", () => {
    expect(() =>
      assertJobConfigDir(`${jobDir}/../fj-${OTHER_JOB_ID}/c`, context),
    ).toThrow(ReadDenyError);
  });

  test("throws for a relative path", () => {
    expect(() => assertJobConfigDir("claude-config", context)).toThrow(
      ReadDenyError,
    );
  });

  test("throws outside a job, where the job id cannot be read", () => {
    expect(() =>
      assertJobConfigDir(`${jobDir}/claude-config`, { env: {}, root }),
    ).toThrow(ReadDenyError);
  });
});

describe("prepareReadDenySettings", () => {
  let root: string;
  let jobDir: string;
  let configDir: string;
  const paths = buildReadDenyPaths("/home/worker");

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "read-deny-"));
    jobDir = join(root, `fj-${JOB_ID}`);
    configDir = join(jobDir, "claude-config");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function context() {
    return { env: { WM_JOB_ID: JOB_ID }, root };
  }

  function input(overrides: { configDir?: string; cwd?: string } = {}) {
    return {
      readDenyPaths: paths,
      configDir: overrides.configDir ?? configDir,
      cwd: overrides.cwd ?? "/srv/investigate/12",
      context: context(),
    };
  }

  test("writes the rules to settings.json in the config directory", async () => {
    await prepareReadDenySettings(input());
    expect(await readFile(join(configDir, "settings.json"), "utf8")).toBe(
      buildReadDenySettings(paths),
    );
  });

  test("keeps settings.json private to the worker user", async () => {
    await prepareReadDenySettings(input());
    const mode = (await stat(join(configDir, "settings.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("overwrites the settings.json of an earlier call in the same job", async () => {
    await prepareReadDenySettings(input());
    await writeFile(join(configDir, "settings.json"), "{}");
    await prepareReadDenySettings(input());
    expect(await readFile(join(configDir, "settings.json"), "utf8")).toBe(
      buildReadDenySettings(paths),
    );
  });

  test("throws without writing when the config directory is not of this job", async () => {
    const outside = join(root, "elsewhere");
    await expect(
      prepareReadDenySettings(input({ configDir: outside })),
    ).rejects.toThrow(ReadDenyError);
  });

  test("does not create the directory that it refuses to use", async () => {
    const outside = join(root, "elsewhere");
    await prepareReadDenySettings(input({ configDir: outside })).catch(
      () => undefined,
    );
    expect(await lstat(outside).catch(() => null)).toBeNull();
  });

  test("throws when no config directory is given", async () => {
    await expect(
      prepareReadDenySettings({ ...input(), configDir: undefined }),
    ).rejects.toThrow(ReadDenyError);
  });

  test("throws when the working directory is below a denied path", async () => {
    await expect(
      prepareReadDenySettings(input({ cwd: "/workspaces/repo" })),
    ).rejects.toThrow(ReadDenyError);
  });

  test("writes nothing when the working directory is refused", async () => {
    await prepareReadDenySettings(input({ cwd: "/workspaces/repo" })).catch(
      () => undefined,
    );
    expect(await lstat(configDir).catch(() => null)).toBeNull();
  });

  test("throws for an empty list, which would deny nothing", async () => {
    await expect(
      prepareReadDenySettings({ ...input(), readDenyPaths: [] }),
    ).rejects.toThrow(ReadDenyError);
  });

  test("throws when the config directory is a symbolic link", async () => {
    const target = join(root, "target");
    await mkdir(target);
    await mkdir(jobDir);
    await symlink(target, configDir);
    await expect(prepareReadDenySettings(input())).rejects.toThrow(
      ReadDenyError,
    );
  });

  test("writes nothing through a symbolic link at the config directory", async () => {
    const target = join(root, "target");
    await mkdir(target);
    await mkdir(jobDir);
    await symlink(target, configDir);
    await prepareReadDenySettings(input()).catch(() => undefined);
    expect(
      await lstat(join(target, "settings.json")).catch(() => null),
    ).toBeNull();
  });

  test("throws when settings.json is a symbolic link", async () => {
    const target = join(root, "target.json");
    await writeFile(target, "{}");
    await mkdir(configDir, { recursive: true });
    await symlink(target, join(configDir, "settings.json"));
    await expect(prepareReadDenySettings(input())).rejects.toThrow(
      ReadDenyError,
    );
  });

  test("leaves the target of a symbolic link settings.json untouched", async () => {
    const target = join(root, "target.json");
    await writeFile(target, "{}");
    await mkdir(configDir, { recursive: true });
    await symlink(target, join(configDir, "settings.json"));
    await prepareReadDenySettings(input()).catch(() => undefined);
    expect(await readFile(target, "utf8")).toBe("{}");
  });
});
