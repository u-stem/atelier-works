import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSecureFile,
  writeSecureFile,
} from "../../scripts/host_apply/secure_file.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "host-apply-sf-"));
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
const NAME = "state.json";
const LABEL = "state file";
const MAX = 1024;

function put(dir: string, body = "hello\n", createDir = false): void {
  writeSecureFile({
    dir,
    name: NAME,
    label: LABEL,
    body,
    maxBytes: MAX,
    uid,
    createDir,
  });
}

function get(dir: string, readUid = uid, label = LABEL, maxBytes = MAX) {
  return readSecureFile({ dir, name: NAME, label, maxBytes, uid: readUid });
}

function filePath(dir: string): string {
  return join(dir, NAME);
}

describe("writeSecureFile", () => {
  test("creates a missing directory with mode 0700", () => {
    const dir = join(tempRoot(), "fresh");
    put(dir, "hello\n", true);
    expect(mode(dir)).toBe(0o700);
  });

  test("writes the file with mode 0600", () => {
    const dir = privateDir();
    put(dir);
    expect(mode(filePath(dir))).toBe(0o600);
  });

  test("leaves no temporary file behind", () => {
    const dir = privateDir();
    put(dir);
    expect(readdirSync(dir)).toEqual([NAME]);
  });

  test("can be read back as written", () => {
    const dir = privateDir();
    put(dir, "hello\n");
    expect(get(dir)).toMatchObject({ kind: "found", text: "hello\n" });
  });

  test("refuses a directory that others can read", () => {
    const dir = privateDir();
    chmodSync(dir, 0o755);
    expect(() => put(dir)).toThrow();
  });

  test("leaves a loose directory without a file", () => {
    const dir = privateDir();
    chmodSync(dir, 0o755);
    try {
      put(dir);
    } catch {
      // 拒否されることだけを確かめる
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  test("refuses a directory that is a symlink", () => {
    const real = privateDir();
    const link = join(tempRoot(), "link");
    symlinkSync(real, link);
    expect(() => put(link)).toThrow();
  });

  test("refuses a directory owned by someone else", () => {
    const dir = privateDir();
    expect(() =>
      writeSecureFile({
        dir,
        name: NAME,
        label: LABEL,
        body: "x",
        maxBytes: MAX,
        uid: uid + 1,
      }),
    ).toThrow();
  });

  test("refuses a name outside the closed list", () => {
    const dir = privateDir();
    expect(() =>
      writeSecureFile({
        dir,
        name: "prod",
        label: LABEL,
        body: "x",
        maxBytes: MAX,
        uid,
      }),
    ).toThrow();
  });

  test("refuses a body over the limit", () => {
    const dir = privateDir();
    expect(() => put(dir, "x".repeat(MAX + 1))).toThrow();
  });

  test("writes nothing for a body over the limit", () => {
    const dir = privateDir();
    try {
      put(dir, "x".repeat(MAX + 1));
    } catch {
      // 書かれないことだけを確かめる
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  test("removes its temporary file when the rename fails", () => {
    const dir = privateDir();
    // 行き先が中身のあるディレクトリだと、renameが失敗する。
    mkdirSync(filePath(dir));
    writeFileSync(join(filePath(dir), "keep"), "");
    try {
      put(dir);
    } catch {
      // 失敗の後の後始末だけを確かめる
    }
    expect(readdirSync(dir)).toEqual([NAME]);
  });

  test("keeps a temporary file that another writer made", () => {
    const dir = privateDir();
    const other = `.${NAME}.00000000-0000-4000-8000-000000000000.tmp`;
    writeFileSync(join(dir, other), "", { mode: 0o600 });
    mkdirSync(filePath(dir));
    writeFileSync(join(filePath(dir), "keep"), "");
    try {
      put(dir);
    } catch {
      // 失敗の後の後始末だけを確かめる
    }
    expect(readdirSync(dir).sort()).toEqual([other, NAME].sort());
  });

  test("throws when the directory is missing and createDir is off", () => {
    const dir = join(tempRoot(), "missing");
    expect(() => put(dir)).toThrow();
  });

  test("does not create the directory when createDir is off", () => {
    const dir = join(tempRoot(), "missing");
    try {
      put(dir);
    } catch {
      // 置き場が作られないことだけを確かめる
    }
    expect(existsSync(dir)).toBe(false);
  });

  test("creates the missing parents of the directory when createDir is on", () => {
    const dir = join(tempRoot(), "parent", "state");
    put(dir, "hello\n", true);
    expect(existsSync(filePath(dir))).toBe(true);
  });
});

describe("readSecureFile", () => {
  test("returns absent when there is no directory", () => {
    expect(get(join(tempRoot(), "none"))).toEqual({ kind: "absent" });
  });

  test("returns absent when there is no file", () => {
    expect(get(privateDir())).toEqual({ kind: "absent" });
  });

  test("is unsafe for a directory that is a symlink", () => {
    const real = privateDir();
    put(real);
    const link = join(tempRoot(), "link");
    symlinkSync(real, link);
    expect(get(link)).toMatchObject({ kind: "invalid", cause: "unsafe" });
  });

  test("is unsafe for a directory that others can read", () => {
    const dir = privateDir();
    put(dir);
    chmodSync(dir, 0o755);
    expect(get(dir)).toMatchObject({ kind: "invalid", cause: "unsafe" });
  });

  test("is unsafe for a directory owned by someone else", () => {
    const dir = privateDir();
    put(dir);
    expect(get(dir, uid + 1)).toMatchObject({
      kind: "invalid",
      cause: "unsafe",
    });
  });

  test("is unsafe for a file owned by someone else", () => {
    // 別のuidで読むと置き場の所有者も違うので、置き場の拒否と区別はつかない。
    const dir = privateDir();
    put(dir);
    expect(get(dir, uid + 1).kind).toBe("invalid");
  });

  test("is unsafe for a file that is a symlink", () => {
    const dir = privateDir();
    const target = join(tempRoot(), "real.json");
    writeFileSync(target, "hello\n", { mode: 0o600 });
    symlinkSync(target, filePath(dir));
    expect(get(dir)).toMatchObject({ kind: "invalid", cause: "unsafe" });
  });

  test("is unsafe for a file that others can read", () => {
    const dir = privateDir();
    writeFileSync(filePath(dir), "hello\n");
    chmodSync(filePath(dir), 0o644);
    expect(get(dir)).toMatchObject({ kind: "invalid", cause: "unsafe" });
  });

  test("is unsafe for a file with another hard link", () => {
    const dir = privateDir();
    put(dir);
    linkSync(filePath(dir), join(tempRoot(), "alias.json"));
    expect(get(dir)).toMatchObject({ kind: "invalid", cause: "unsafe" });
  });

  test("is unsafe for a file over the limit", () => {
    const dir = privateDir();
    writeFileSync(filePath(dir), "x".repeat(MAX + 1), { mode: 0o600 });
    expect(get(dir)).toMatchObject({ kind: "invalid", cause: "unsafe" });
  });

  test("reads a file of exactly the limit", () => {
    const dir = privateDir();
    writeFileSync(filePath(dir), "x".repeat(MAX), { mode: 0o600 });
    expect(get(dir)).toMatchObject({ kind: "found" });
  });

  test("is unsafe for a FIFO, without blocking", () => {
    const dir = privateDir();
    Bun.spawnSync(["mkfifo", filePath(dir)]);
    // 開くのが止まる実装でもテスト全体が止まらないよう、別のプロセスで時間を切って読む。
    const script = `import { readSecureFile } from ${JSON.stringify(
      join(import.meta.dir, "../../scripts/host_apply/secure_file.ts"),
    )}; const r = readSecureFile({ dir: ${JSON.stringify(dir)}, name: ${JSON.stringify(
      NAME,
    )}, label: "state file", maxBytes: 1024, uid: ${uid} }); console.log(r.kind === "invalid" ? "invalid:" + r.cause : r.kind);`;
    const result = Bun.spawnSync(
      [process.execPath, "--no-env-file", "-e", script],
      { timeout: 3000, killSignal: "SIGKILL" },
    );
    expect(result.stdout.toString().trim()).toBe("invalid:unsafe");
  });

  test("is io for a file that cannot be opened", async () => {
    const dir = privateDir();
    // ソケットのファイルは、rootでも開けない。パスの長さの上限を避けるため、短い場所で作って移す。
    const short = mkdtempSync(join(tmpdir(), "s-"));
    roots.push(short);
    const socketPath = join(short, "k");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    renameSync(socketPath, filePath(dir));
    const result = get(dir);
    server.close();
    expect(result).toMatchObject({ kind: "invalid", cause: "io" });
  });

  test("refuses a name outside the closed list", () => {
    const dir = privateDir();
    expect(() =>
      readSecureFile({
        dir,
        name: "lock",
        label: LABEL,
        maxBytes: MAX,
        uid,
      }),
    ).toThrow();
  });

  test("puts the label into the reason of a file", () => {
    const dir = privateDir();
    writeFileSync(filePath(dir), "hello\n");
    chmodSync(filePath(dir), 0o644);
    expect(get(dir, uid, "custom label")).toMatchObject({
      reason: "custom label is open to others",
    });
  });

  test("keeps the label out of the reason of a directory", () => {
    const dir = privateDir();
    chmodSync(dir, 0o755);
    expect(get(dir, uid, "custom label")).toMatchObject({
      reason: "state directory is open to others",
    });
  });

  test("returns the dev and ino of the file that it read", () => {
    const dir = privateDir();
    put(dir);
    const stat = statSync(filePath(dir));
    expect(get(dir)).toMatchObject({ dev: stat.dev, ino: stat.ino });
  });
});
