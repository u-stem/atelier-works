import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureJobTmpDir,
  JOB_TMP_MAX_AGE_SEC,
  JOB_TMP_PREFIX,
  JOB_TMP_ROOT,
  JobTmpError,
  type JobTmpFs,
  type JobTmpStat,
  jobTmpDirPath,
  jobTmpEnv,
  realJobTmpFs,
  sweepStaleJobTmpDirs,
} from "../../f/factory/lib/job_tmp.ts";

const JOB_A = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const JOB_B = "0198a1b2-0000-7000-8000-000000000001";
const OWN_UID = 0;

// ---------------------------------------------------------------------------
// 偽のファイルシステム: 所有者の違いなど、実ファイルでは作れない状況を確かめる。
// ---------------------------------------------------------------------------

type FakeOptions = { uidOnCreate?: number };

function fakeFs(initial: Record<string, JobTmpStat> = {}, o: FakeOptions = {}) {
  const entries = new Map<string, JobTmpStat>(Object.entries(initial));
  const removeOnExit: string[] = [];
  const removed: string[] = [];
  const modes: Array<[string, number]> = [];
  const fs: JobTmpFs = {
    uid: () => OWN_UID,
    lstat: (path) => entries.get(path) ?? null,
    mkdir: (path, mode) => {
      if (entries.has(path)) {
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      }
      entries.set(path, {
        isDirectory: true,
        isSymbolicLink: false,
        uid: o.uidOnCreate ?? OWN_UID,
        mode,
        mtimeMs: 0,
      });
    },
    chmod: (path, mode) => {
      modes.push([path, mode]);
      const entry = entries.get(path);
      if (entry !== undefined) entries.set(path, { ...entry, mode });
    },
    readdir: (path) =>
      [...entries.keys()]
        .filter((key) => key.startsWith(`${path}/`))
        .map((key) => key.slice(path.length + 1))
        .filter((name) => !name.includes("/")),
    rm: (path) => {
      removed.push(path);
      entries.delete(path);
    },
    removeOnExit: (path) => {
      removeOnExit.push(path);
    },
  };
  return { fs, entries, removeOnExit, removed, modes };
}

const dir = (overrides: Partial<JobTmpStat> = {}): JobTmpStat => ({
  isDirectory: true,
  isSymbolicLink: false,
  uid: OWN_UID,
  mode: 0o700,
  mtimeMs: 0,
  ...overrides,
});

const JOB_DIR_A = `${JOB_TMP_ROOT}/${JOB_TMP_PREFIX}${JOB_A}`;

describe("jobTmpDirPath", () => {
  test("puts the directory under the Windmill temp root", () => {
    expect(jobTmpDirPath({ WM_JOB_ID: JOB_A })).toBe(JOB_DIR_A);
  });

  test("keeps the name short enough for a UNIX domain socket inside it", () => {
    const path = jobTmpDirPath({ WM_JOB_ID: JOB_A }) ?? "";
    expect(Buffer.byteLength(`${path}/claude-socket-0000.sock`)).toBeLessThan(
      108,
    );
  });

  test("returns null outside a job", () => {
    expect(jobTmpDirPath({})).toBeNull();
  });

  test("returns null for a job id that is not a UUID", () => {
    expect(jobTmpDirPath({ WM_JOB_ID: "../../etc" })).toBeNull();
  });
});

describe("ensureJobTmpDir with a fake file system", () => {
  test("registers the removal at exit", () => {
    const { fs, removeOnExit } = fakeFs({ [JOB_TMP_ROOT]: dir() });

    const path = ensureJobTmpDir({ WM_JOB_ID: JOB_A }, { fs });

    expect(removeOnExit).toEqual([path ?? ""]);
  });

  test("creates the temp root when it is missing", () => {
    const { fs, entries } = fakeFs();

    ensureJobTmpDir({ WM_JOB_ID: JOB_A }, { fs });

    expect(entries.has(JOB_TMP_ROOT)).toBe(true);
  });

  test("returns null outside a job", () => {
    const { fs } = fakeFs();

    expect(ensureJobTmpDir({}, { fs })).toBeNull();
  });

  test("does not warn outside Windmill", () => {
    const { fs } = fakeFs();
    const warnings: string[] = [];

    ensureJobTmpDir({}, { fs, warn: (m) => warnings.push(m) });

    expect(warnings).toEqual([]);
  });

  test("warns when the workspace is set but the job id is not readable", () => {
    const { fs } = fakeFs();
    const warnings: string[] = [];

    const path = ensureJobTmpDir(
      { WM_WORKSPACE: "factory", WM_JOB_ID: "unknown" },
      { fs, warn: (m) => warnings.push(m) },
    );

    expect({ path, warnings: warnings.length }).toEqual({
      path: null,
      warnings: 1,
    });
  });

  test("refuses an existing directory owned by another user", () => {
    const { fs } = fakeFs({
      [JOB_TMP_ROOT]: dir(),
      [JOB_DIR_A]: dir({ uid: 1234 }),
    });

    expect(() => ensureJobTmpDir({ WM_JOB_ID: JOB_A }, { fs })).toThrow(
      JobTmpError,
    );
  });

  test("refuses a temp root owned by another user", () => {
    const { fs } = fakeFs({ [JOB_TMP_ROOT]: dir({ uid: 1234 }) });

    expect(() => ensureJobTmpDir({ WM_JOB_ID: JOB_A }, { fs })).toThrow(
      "chown",
    );
  });

  test("leaves a temp root owned by another user untouched", () => {
    const { fs, modes } = fakeFs({
      [JOB_TMP_ROOT]: dir({ uid: 1234, mode: 0o777 }),
    });

    try {
      ensureJobTmpDir({ WM_JOB_ID: JOB_A }, { fs });
    } catch {
      // 例外になることは、上のテストで確かめる。
    }

    expect(modes).toEqual([]);
  });

  test("repairs a temp root that others can write", () => {
    const { fs, entries } = fakeFs({ [JOB_TMP_ROOT]: dir({ mode: 0o777 }) });

    ensureJobTmpDir({ WM_JOB_ID: JOB_A }, { fs });

    expect(entries.get(JOB_TMP_ROOT)?.mode).toBe(0o700);
  });
});

describe("jobTmpEnv with a fake file system", () => {
  test("sets TMPDIR to the job directory", () => {
    const { fs } = fakeFs({ [JOB_TMP_ROOT]: dir() });

    const env = jobTmpEnv({ WM_JOB_ID: JOB_A }, { fs });

    expect(env.TMPDIR).toBe(JOB_DIR_A);
  });

  test("is empty outside a job", () => {
    const { fs } = fakeFs();

    expect(jobTmpEnv({}, { fs })).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 実ファイルシステム: 権限のビットとsymlinkと掃除の挙動を、一時ディレクトリの下で確かめる。
// ---------------------------------------------------------------------------

describe("with the real file system", () => {
  let base = "";
  let root = "";
  const fs: JobTmpFs = { ...realJobTmpFs, removeOnExit: () => {} };
  const modeOf = (path: string): number => lstatSync(path).mode & 0o777;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "job-tmp-test-"));
    root = join(base, "windmill");
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const jobDir = (id: string) => join(root, `${JOB_TMP_PREFIX}${id}`);

  test("creates the job directory with mode 0700", () => {
    const path = ensureJobTmpDir({ WM_JOB_ID: JOB_A }, { fs, root });

    expect(modeOf(path ?? "")).toBe(0o700);
  });

  test("creates the temp root with mode 0700 when it is missing", () => {
    ensureJobTmpDir({ WM_JOB_ID: JOB_A }, { fs, root });

    expect(modeOf(root)).toBe(0o700);
  });

  test("ends with mode 0700 even when a narrow umask cut the creation mode", () => {
    // 0o277のumaskでは、mkdirの0700が0500に狭まる。
    mkdirSync(root, { mode: 0o700 });
    const before = process.umask(0o277);
    let path: string | null;
    try {
      path = ensureJobTmpDir({ WM_JOB_ID: JOB_A }, { fs, root });
    } finally {
      process.umask(before);
    }

    expect(modeOf(path ?? "")).toBe(0o700);
  });

  test("a narrow umask really narrows the plain mkdir", () => {
    const before = process.umask(0o277);
    try {
      mkdirSync(root, { mode: 0o700 });
    } finally {
      process.umask(before);
    }

    expect(modeOf(root)).toBe(0o500);
  });

  test("repairs a temp root of mode 0777 to 0700", () => {
    mkdirSync(root);
    chmodSync(root, 0o777);

    ensureJobTmpDir({ WM_JOB_ID: JOB_A }, { fs, root });

    expect(modeOf(root)).toBe(0o700);
  });

  test("refuses a job directory that someone else created with another mode", () => {
    mkdirSync(root, { mode: 0o700 });
    mkdirSync(jobDir(JOB_A));
    chmodSync(jobDir(JOB_A), 0o755);

    expect(() => ensureJobTmpDir({ WM_JOB_ID: JOB_A }, { fs, root })).toThrow(
      JobTmpError,
    );
  });

  test("reuses a job directory that is already private", () => {
    mkdirSync(root, { mode: 0o700 });
    mkdirSync(jobDir(JOB_A), { mode: 0o700 });

    expect(ensureJobTmpDir({ WM_JOB_ID: JOB_A }, { fs, root })).toBe(
      jobDir(JOB_A),
    );
  });

  test("refuses a symbolic link in place of the job directory", () => {
    mkdirSync(root, { mode: 0o700 });
    mkdirSync(join(base, "elsewhere"), { mode: 0o700 });
    symlinkSync(join(base, "elsewhere"), jobDir(JOB_A));

    expect(() => ensureJobTmpDir({ WM_JOB_ID: JOB_A }, { fs, root })).toThrow(
      JobTmpError,
    );
  });

  test("refuses a symbolic link in place of the temp root", () => {
    mkdirSync(join(base, "elsewhere"), { mode: 0o700 });
    symlinkSync(join(base, "elsewhere"), root);

    expect(() => ensureJobTmpDir({ WM_JOB_ID: JOB_A }, { fs, root })).toThrow(
      JobTmpError,
    );
  });

  describe("sweepStaleJobTmpDirs", () => {
    const nowMs = Date.now();
    const oldSec = (nowMs - (JOB_TMP_MAX_AGE_SEC + 3600) * 1000) / 1000;
    const makeJobDir = (id: string, ageOld: boolean): string => {
      const path = jobDir(id);
      mkdirSync(path, { mode: 0o700 });
      if (ageOld) utimesSync(path, oldSec, oldSec);
      return path;
    };

    test("removes only the job directories older than the limit", () => {
      mkdirSync(root, { mode: 0o700 });
      const stale = makeJobDir(JOB_A, true);
      makeJobDir(JOB_B, false);

      const result = sweepStaleJobTmpDirs({ nowMs, fs, root });

      expect(result.removed).toEqual([stale]);
    });

    test("keeps the job directory newer than the limit", () => {
      mkdirSync(root, { mode: 0o700 });
      const fresh = makeJobDir(JOB_B, false);

      sweepStaleJobTmpDirs({ nowMs, fs, root });

      expect(lstatSync(fresh).isDirectory()).toBe(true);
    });

    test("leaves an old entry that is not a job directory", () => {
      mkdirSync(root, { mode: 0o700 });
      const other = join(root, "wk-default-abc");
      mkdirSync(other);
      utimesSync(other, oldSec, oldSec);

      sweepStaleJobTmpDirs({ nowMs, fs, root });

      expect(lstatSync(other).isDirectory()).toBe(true);
    });

    test("does not follow a symbolic link with a job directory name", () => {
      mkdirSync(root, { mode: 0o700 });
      const target = join(base, "elsewhere");
      mkdirSync(target, { mode: 0o700 });
      symlinkSync(target, jobDir(JOB_A));

      sweepStaleJobTmpDirs({ nowMs, fs, root });

      expect(lstatSync(target).isDirectory()).toBe(true);
    });

    test("repairs a temp root of mode 0777 before it removes anything", () => {
      mkdirSync(root);
      chmodSync(root, 0o777);
      makeJobDir(JOB_A, true);

      sweepStaleJobTmpDirs({ nowMs, fs, root });

      expect(modeOf(root)).toBe(0o700);
    });

    test("does nothing when the temp root does not exist", () => {
      expect(sweepStaleJobTmpDirs({ nowMs, fs, root })).toEqual({
        removed: [],
        failed: [],
      });
    });

    test("removes nothing and reports the root when it is a symbolic link", () => {
      const target = join(base, "elsewhere");
      mkdirSync(target, { mode: 0o700 });
      symlinkSync(target, root);

      const result = sweepStaleJobTmpDirs({ nowMs, fs, root });

      expect(result.failed).toEqual([root]);
    });

    test("keeps the old directory behind a symbolic link root", () => {
      const target = join(base, "elsewhere");
      mkdirSync(target, { mode: 0o700 });
      const victim = join(target, `${JOB_TMP_PREFIX}${JOB_A}`);
      mkdirSync(victim, { mode: 0o700 });
      utimesSync(victim, oldSec, oldSec);
      symlinkSync(target, root);

      sweepStaleJobTmpDirs({ nowMs, fs, root });

      expect(lstatSync(victim).isDirectory()).toBe(true);
    });
  });
});

describe("sweepStaleJobTmpDirs with a fake file system", () => {
  const nowMs = 10 * JOB_TMP_MAX_AGE_SEC * 1000;
  const old = nowMs - (JOB_TMP_MAX_AGE_SEC + 60) * 1000;
  const stale = JOB_DIR_A;

  test("removes nothing when the temp root belongs to another user", () => {
    const { fs, removed } = fakeFs({
      [JOB_TMP_ROOT]: dir({ uid: 1234 }),
      [stale]: dir({ mtimeMs: old }),
    });

    sweepStaleJobTmpDirs({ nowMs, fs });

    expect(removed).toEqual([]);
  });

  test("returns the reason with the next step when the root is unusable", () => {
    const { fs } = fakeFs({ [JOB_TMP_ROOT]: dir({ uid: 1234 }) });

    expect(sweepStaleJobTmpDirs({ nowMs, fs }).rootError).toContain("chown");
  });

  test("does not remove an old directory owned by another user", () => {
    const { fs, removed } = fakeFs({
      [JOB_TMP_ROOT]: dir(),
      [stale]: dir({ uid: 1234, mtimeMs: old }),
    });

    sweepStaleJobTmpDirs({ nowMs, fs });

    expect(removed).toEqual([]);
  });

  test("reports an old directory owned by another user as failed", () => {
    const { fs } = fakeFs({
      [JOB_TMP_ROOT]: dir(),
      [stale]: dir({ uid: 1234, mtimeMs: old }),
    });

    expect(sweepStaleJobTmpDirs({ nowMs, fs }).failed).toEqual([stale]);
  });

  test("does not remove an old directory that others can read", () => {
    const { fs, removed } = fakeFs({
      [JOB_TMP_ROOT]: dir(),
      [stale]: dir({ mode: 0o755, mtimeMs: old }),
    });

    sweepStaleJobTmpDirs({ nowMs, fs });

    expect(removed).toEqual([]);
  });

  test("reports an old directory that others can read as failed", () => {
    const { fs } = fakeFs({
      [JOB_TMP_ROOT]: dir(),
      [stale]: dir({ mode: 0o750, mtimeMs: old }),
    });

    expect(sweepStaleJobTmpDirs({ nowMs, fs }).failed).toEqual([stale]);
  });

  test("reports the root as failed when it belongs to another user", () => {
    const { fs } = fakeFs({
      [JOB_TMP_ROOT]: dir({ uid: 1234 }),
      [stale]: dir({ mtimeMs: old }),
    });

    expect(sweepStaleJobTmpDirs({ nowMs, fs }).failed).toEqual([JOB_TMP_ROOT]);
  });

  test("reports a failed removal and carries on", () => {
    const second = `${JOB_TMP_ROOT}/${JOB_TMP_PREFIX}${JOB_B}`;
    const { fs, removed } = fakeFs({
      [JOB_TMP_ROOT]: dir(),
      [stale]: dir({ mtimeMs: old }),
      [second]: dir({ mtimeMs: old }),
    });
    const failing: JobTmpFs = {
      ...fs,
      rm: (path) => {
        if (path === stale) throw new Error("busy");
        fs.rm(path);
      },
    };

    const result = sweepStaleJobTmpDirs({ nowMs, fs: failing });

    expect({ removed, failed: result.failed }).toEqual({
      removed: [second],
      failed: [stale],
    });
  });
});
