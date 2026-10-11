import { describe, expect, test } from "bun:test";
import {
  ensureJobTmpDir,
  JOB_TMP_MAX_AGE_SEC,
  JOB_TMP_ROOT,
  type JobTmpFs,
  type JobTmpStat,
  jobTmpDirPath,
  jobTmpEnv,
  sweepStaleJobTmpDirs,
} from "../../f/factory/lib/job_tmp.ts";

const JOB_A = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const OWN_UID = 0;

type FakeEntry = JobTmpStat;

/** 木をメモリ上に持つ偽のファイルシステム。`uidOnCreate`は作ったディレクトリの所有者。 */
function fakeFs(
  initial: Record<string, FakeEntry> = {},
  options: { uidOnCreate?: number; modeOnCreate?: number } = {},
) {
  const entries = new Map<string, FakeEntry>(Object.entries(initial));
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
        uid: options.uidOnCreate ?? OWN_UID,
        mode: options.modeOnCreate ?? mode,
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

const dir = (overrides: Partial<FakeEntry> = {}): FakeEntry => ({
  isDirectory: true,
  isSymbolicLink: false,
  uid: OWN_UID,
  mode: 0o700,
  mtimeMs: 0,
  ...overrides,
});

describe("jobTmpDirPath", () => {
  test("puts the directory under the Windmill temp root", () => {
    expect(jobTmpDirPath({ WM_JOB_ID: JOB_A })).toBe(
      `${JOB_TMP_ROOT}/factory-job-${JOB_A}`,
    );
  });

  test("returns null outside a job", () => {
    expect(jobTmpDirPath({})).toBeNull();
  });

  test("returns null for a job id that is not a UUID", () => {
    expect(jobTmpDirPath({ WM_JOB_ID: "../../etc" })).toBeNull();
  });
});

describe("ensureJobTmpDir", () => {
  test("creates the job directory with mode 0700", () => {
    const { fs, entries } = fakeFs({ [JOB_TMP_ROOT]: dir({ mode: 0o755 }) });

    const path = ensureJobTmpDir({ WM_JOB_ID: JOB_A }, fs);

    expect(entries.get(path ?? "")?.mode).toBe(0o700);
  });

  test("forces mode 0700 even when the umask narrowed the creation mode", () => {
    const { fs, modes } = fakeFs(
      { [JOB_TMP_ROOT]: dir({ mode: 0o755 }) },
      { modeOnCreate: 0o700 },
    );

    ensureJobTmpDir({ WM_JOB_ID: JOB_A }, fs);

    expect(modes).toEqual([[`${JOB_TMP_ROOT}/factory-job-${JOB_A}`, 0o700]]);
  });

  test("creates the temp root when it is missing", () => {
    const { fs, entries } = fakeFs();

    ensureJobTmpDir({ WM_JOB_ID: JOB_A }, fs);

    expect(entries.has(JOB_TMP_ROOT)).toBe(true);
  });

  test("registers the removal at exit", () => {
    const { fs, removeOnExit } = fakeFs({ [JOB_TMP_ROOT]: dir() });

    const path = ensureJobTmpDir({ WM_JOB_ID: JOB_A }, fs);

    expect(removeOnExit).toEqual([path ?? ""]);
  });

  test("reuses a directory that is already private", () => {
    const path = `${JOB_TMP_ROOT}/factory-job-${JOB_A}`;
    const { fs } = fakeFs({ [JOB_TMP_ROOT]: dir(), [path]: dir() });

    expect(ensureJobTmpDir({ WM_JOB_ID: JOB_A }, fs)).toBe(path);
  });

  test("returns null outside a job", () => {
    const { fs } = fakeFs();

    expect(ensureJobTmpDir({}, fs)).toBeNull();
  });

  test("refuses an existing directory that others can read", () => {
    const path = `${JOB_TMP_ROOT}/factory-job-${JOB_A}`;
    const { fs } = fakeFs({
      [JOB_TMP_ROOT]: dir(),
      [path]: dir({ mode: 0o755 }),
    });

    expect(() => ensureJobTmpDir({ WM_JOB_ID: JOB_A }, fs)).toThrow(
      "not private",
    );
  });

  test("refuses an existing directory owned by another user", () => {
    const path = `${JOB_TMP_ROOT}/factory-job-${JOB_A}`;
    const { fs } = fakeFs({
      [JOB_TMP_ROOT]: dir(),
      [path]: dir({ uid: 1234 }),
    });

    expect(() => ensureJobTmpDir({ WM_JOB_ID: JOB_A }, fs)).toThrow(
      "not private",
    );
  });

  test("refuses a symbolic link in place of the directory", () => {
    const path = `${JOB_TMP_ROOT}/factory-job-${JOB_A}`;
    const { fs } = fakeFs({
      [JOB_TMP_ROOT]: dir(),
      [path]: dir({ isSymbolicLink: true, isDirectory: false }),
    });

    expect(() => ensureJobTmpDir({ WM_JOB_ID: JOB_A }, fs)).toThrow(
      "not private",
    );
  });

  test("refuses a temp root that others can write", () => {
    const { fs } = fakeFs({ [JOB_TMP_ROOT]: dir({ mode: 0o777 }) });

    expect(() => ensureJobTmpDir({ WM_JOB_ID: JOB_A }, fs)).toThrow(
      "not trusted",
    );
  });

  test("refuses a temp root owned by another user", () => {
    const { fs } = fakeFs({ [JOB_TMP_ROOT]: dir({ uid: 1234 }) });

    expect(() => ensureJobTmpDir({ WM_JOB_ID: JOB_A }, fs)).toThrow(
      "not trusted",
    );
  });
});

describe("jobTmpEnv", () => {
  test("sets TMPDIR to the job directory", () => {
    const { fs } = fakeFs({ [JOB_TMP_ROOT]: dir() });

    const env = jobTmpEnv({ WM_JOB_ID: JOB_A }, fs);

    expect(env.TMPDIR).toBe(`${JOB_TMP_ROOT}/factory-job-${JOB_A}`);
  });

  test("is empty outside a job", () => {
    const { fs } = fakeFs();

    expect(jobTmpEnv({}, fs)).toEqual({});
  });
});

describe("sweepStaleJobTmpDirs", () => {
  const nowMs = 10 * JOB_TMP_MAX_AGE_SEC * 1000;
  const old = nowMs - (JOB_TMP_MAX_AGE_SEC + 60) * 1000;
  const fresh = nowMs - 60 * 1000;
  const stale = `${JOB_TMP_ROOT}/factory-job-${JOB_A}`;

  test("removes a job directory older than the limit", () => {
    const { fs, removed } = fakeFs({
      [JOB_TMP_ROOT]: dir(),
      [stale]: dir({ mtimeMs: old }),
    });

    sweepStaleJobTmpDirs({ nowMs, fs });

    expect(removed).toEqual([stale]);
  });

  test("keeps a job directory newer than the limit", () => {
    const { fs, removed } = fakeFs({
      [JOB_TMP_ROOT]: dir(),
      [stale]: dir({ mtimeMs: fresh }),
    });

    sweepStaleJobTmpDirs({ nowMs, fs });

    expect(removed).toEqual([]);
  });

  test("leaves entries that Windmill owns", () => {
    const other = `${JOB_TMP_ROOT}/wk-default-abc`;
    const { fs, removed } = fakeFs({
      [JOB_TMP_ROOT]: dir(),
      [other]: dir({ mtimeMs: old }),
    });

    sweepStaleJobTmpDirs({ nowMs, fs });

    expect(removed).toEqual([]);
  });

  test("does not follow a symbolic link", () => {
    const { fs, removed } = fakeFs({
      [JOB_TMP_ROOT]: dir(),
      [stale]: dir({ isSymbolicLink: true, isDirectory: false, mtimeMs: old }),
    });

    sweepStaleJobTmpDirs({ nowMs, fs });

    expect(removed).toEqual([]);
  });

  test("reports the removed paths", () => {
    const { fs } = fakeFs({
      [JOB_TMP_ROOT]: dir(),
      [stale]: dir({ mtimeMs: old }),
    });

    expect(sweepStaleJobTmpDirs({ nowMs, fs }).removed).toEqual([stale]);
  });

  test("reports a failed removal and carries on", () => {
    const second = `${JOB_TMP_ROOT}/factory-job-0198a1b2-0000-7000-8000-000000000001`;
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

  test("does nothing when the temp root does not exist", () => {
    const { fs } = fakeFs();

    expect(sweepStaleJobTmpDirs({ nowMs, fs })).toEqual({
      removed: [],
      failed: [],
    });
  });
});
