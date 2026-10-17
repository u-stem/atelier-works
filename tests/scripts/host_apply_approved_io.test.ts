import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approvedFilePath,
  readApproved,
  writeApproved,
} from "../../scripts/host_apply/approved_io.ts";
import {
  type ApprovedRecord,
  MAX_APPROVED_BYTES,
  serializeApprovedRecord,
} from "../../scripts/host_apply/approved_store.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "89abcdef0123456789abcdef0123456789abcdef";

const RECORD: ApprovedRecord = {
  schema: 1,
  sha: SHA,
  applied: OTHER,
  approved_at: "2026-10-18T01:02:03.000Z",
  files: [{ path: "scripts/doctor.sh", status: "M" }],
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "host-apply-io-"));
  roots.push(root);
  return root;
}

/** 0700の状態ディレクトリを作る。 */
function privateDir(): string {
  const dir = join(tempRoot(), "state");
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

const uid = process.getuid?.() ?? 0;

describe("writeApproved", () => {
  test("creates a missing directory with mode 0700", () => {
    const dir = join(tempRoot(), "fresh");
    writeApproved(dir, RECORD, uid);
    expect(mode(dir)).toBe(0o700);
  });

  test("writes the file with mode 0600", () => {
    const dir = privateDir();
    writeApproved(dir, RECORD, uid);
    expect(mode(approvedFilePath(dir))).toBe(0o600);
  });

  test("refuses a directory that others can read", () => {
    const dir = privateDir();
    chmodSync(dir, 0o755);
    expect(() => writeApproved(dir, RECORD, uid)).toThrow();
  });

  test("leaves a loose directory without a file", () => {
    const dir = privateDir();
    chmodSync(dir, 0o755);
    try {
      writeApproved(dir, RECORD, uid);
    } catch {
      // 拒否されることだけを確かめる
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  test("refuses a directory that is a symlink", () => {
    const real = privateDir();
    const link = join(tempRoot(), "link");
    symlinkSync(real, link);
    expect(() => writeApproved(link, RECORD, uid)).toThrow();
  });

  test("refuses a directory owned by someone else", () => {
    const dir = privateDir();
    expect(() => writeApproved(dir, RECORD, uid + 1)).toThrow();
  });

  test("leaves no temporary file behind", () => {
    const dir = privateDir();
    writeApproved(dir, RECORD, uid);
    expect(readdirSync(dir)).toEqual(["approved.json"]);
  });

  test("replaces a symlink at the file path instead of following it", () => {
    const dir = privateDir();
    const outside = join(tempRoot(), "outside.json");
    writeFileSync(outside, "keep");
    symlinkSync(outside, approvedFilePath(dir));
    writeApproved(dir, RECORD, uid);
    expect(readdirSync(dir)).toEqual(["approved.json"]);
  });

  test("does not write through a symlink at the file path", () => {
    const dir = privateDir();
    const outside = join(tempRoot(), "outside.json");
    writeFileSync(outside, "keep");
    symlinkSync(outside, approvedFilePath(dir));
    writeApproved(dir, RECORD, uid);
    expect(readFileSync(outside, "utf8")).toBe("keep");
  });

  test("refuses a record that is not valid", () => {
    const dir = privateDir();
    const broken = { ...RECORD, sha: "short" };
    expect(() => writeApproved(dir, broken, uid)).toThrow();
  });
});

describe("readApproved", () => {
  test("returns absent when there is no file", () => {
    expect(readApproved(privateDir(), uid)).toEqual({ kind: "absent" });
  });

  test("returns absent when there is no directory", () => {
    expect(readApproved(join(tempRoot(), "none"), uid)).toEqual({
      kind: "absent",
    });
  });

  test("reads back a written record", () => {
    const dir = privateDir();
    writeApproved(dir, RECORD, uid);
    expect(readApproved(dir, uid)).toEqual({ kind: "found", record: RECORD });
  });

  test("does not read a file that is a symlink", () => {
    const dir = privateDir();
    const target = join(tempRoot(), "real.json");
    writeFileSync(target, serializeApprovedRecord(RECORD), { mode: 0o600 });
    symlinkSync(target, approvedFilePath(dir));
    expect(readApproved(dir, uid).kind).toBe("invalid");
  });

  test("does not read a file that others can read", () => {
    const dir = privateDir();
    writeFileSync(approvedFilePath(dir), serializeApprovedRecord(RECORD));
    chmodSync(approvedFilePath(dir), 0o644);
    expect(readApproved(dir, uid).kind).toBe("invalid");
  });

  test("does not read a file in a directory that others can read", () => {
    const dir = privateDir();
    writeApproved(dir, RECORD, uid);
    chmodSync(dir, 0o755);
    expect(readApproved(dir, uid).kind).toBe("invalid");
  });

  test("does not read a file in a directory that is a symlink", () => {
    const real = privateDir();
    writeApproved(real, RECORD, uid);
    const link = join(tempRoot(), "link");
    symlinkSync(real, link);
    expect(readApproved(link, uid).kind).toBe("invalid");
  });

  test("does not read a file over the size limit", () => {
    const dir = privateDir();
    writeFileSync(approvedFilePath(dir), " ".repeat(MAX_APPROVED_BYTES + 1), {
      mode: 0o600,
    });
    expect(readApproved(dir, uid).kind).toBe("invalid");
  });

  test("does not read a file with another hard link", () => {
    const dir = privateDir();
    writeApproved(dir, RECORD, uid);
    linkSync(approvedFilePath(dir), join(tempRoot(), "alias.json"));
    expect(readApproved(dir, uid).kind).toBe("invalid");
  });

  test("does not read a file owned by someone else", () => {
    const dir = privateDir();
    writeApproved(dir, RECORD, uid);
    expect(readApproved(dir, uid + 1).kind).toBe("invalid");
  });

  test("does not read a file whose body is not a record", () => {
    const dir = privateDir();
    writeFileSync(approvedFilePath(dir), "{}", { mode: 0o600 });
    expect(readApproved(dir, uid).kind).toBe("invalid");
  });
});
