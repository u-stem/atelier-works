import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkDocTreeHash,
  type DirectoryEntryIo,
  hashDirectoryTree,
  REQUIREMENTS_DIR_MISSING_REASON,
  REQUIREMENTS_MODIFIED_BEFORE_DESIGN_REASON,
  REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON,
  REQUIREMENTS_MODIFIED_REASON,
  realDirectoryIo,
} from "../../f/factory/lib/doc_tree_hash.ts";

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "doc-tree-hash-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("hashDirectoryTree", () => {
  function io(files: Record<string, string>): DirectoryEntryIo {
    return {
      readDir: async (dir) => {
        const prefix = `${dir}/`;
        const names = new Map<string, boolean>();
        for (const path of Object.keys(files)) {
          if (!path.startsWith(prefix)) continue;
          const rest = path.slice(prefix.length);
          const [first] = rest.split("/");
          if (first === undefined) continue;
          names.set(first, rest.includes("/"));
        }
        if (names.size === 0) throw new Error("ENOENT");
        return [...names].map(([name, isDirectory]) => ({ name, isDirectory }));
      },
      readFile: async (path) => {
        const content = files[path];
        if (content === undefined) throw new Error("ENOENT");
        return new TextEncoder().encode(content);
      },
    };
  }

  const BASE = { "/d/a.md": "A", "/d/b.drawio": "B", "/d/sub/c.txt": "C" };

  test("returns the same hash for the same tree", async () => {
    expect(await hashDirectoryTree("/d", io(BASE))).toBe(
      await hashDirectoryTree("/d", io({ ...BASE })),
    );
  });

  test("does not depend on the order of the files", async () => {
    const reversed = {
      "/d/sub/c.txt": "C",
      "/d/b.drawio": "B",
      "/d/a.md": "A",
    };
    expect(await hashDirectoryTree("/d", io(reversed))).toBe(
      await hashDirectoryTree("/d", io(BASE)),
    );
  });

  test("changes when a file changes", async () => {
    expect(
      await hashDirectoryTree("/d", io({ ...BASE, "/d/a.md": "A2" })),
    ).not.toBe(await hashDirectoryTree("/d", io(BASE)));
  });

  test("changes when a file is added", async () => {
    expect(
      await hashDirectoryTree("/d", io({ ...BASE, "/d/new": "N" })),
    ).not.toBe(await hashDirectoryTree("/d", io(BASE)));
  });

  test("changes when a file is removed", async () => {
    const { "/d/b.drawio": _removed, ...rest } = BASE;
    expect(await hashDirectoryTree("/d", io(rest))).not.toBe(
      await hashDirectoryTree("/d", io(BASE)),
    );
  });

  test("changes when a file is renamed", async () => {
    const { "/d/a.md": content, ...rest } = BASE;
    expect(
      await hashDirectoryTree("/d", io({ ...rest, "/d/z.md": content })),
    ).not.toBe(await hashDirectoryTree("/d", io(BASE)));
  });

  test("changes when a file in a subdirectory changes", async () => {
    expect(
      await hashDirectoryTree("/d", io({ ...BASE, "/d/sub/c.txt": "C2" })),
    ).not.toBe(await hashDirectoryTree("/d", io(BASE)));
  });

  test("does not confuse the end of a name with the start of the content", async () => {
    expect(await hashDirectoryTree("/d", io({ "/d/ab": "c" }))).not.toBe(
      await hashDirectoryTree("/d", io({ "/d/a": "bc" })),
    );
  });

  test("returns null for a directory that does not exist", async () => {
    expect(await hashDirectoryTree("/missing", io(BASE))).toBeNull();
  });

  test("returns a hex digest", async () => {
    expect(await hashDirectoryTree("/d", io(BASE))).toMatch(/^[0-9a-f]{64}$/);
  });

  /** ルートを読む呼び出しが投げる例外を差し込んだ読み取り。 */
  function rootFails(err: Error): DirectoryEntryIo {
    return {
      readDir: async () => {
        throw err;
      },
      readFile: async () => new Uint8Array(),
    };
  }

  test("returns null when the root is missing (code ENOENT only)", async () => {
    const err = new Error("operation failed");
    Reflect.set(err, "code", "ENOENT");
    expect(await hashDirectoryTree("/d", rootFails(err))).toBeNull();
  });

  test("returns null when the root is missing (message only, no code)", async () => {
    expect(
      await hashDirectoryTree(
        "/d",
        rootFails(new Error("ENOENT: no such file or directory, scandir")),
      ),
    ).toBeNull();
  });

  test("rethrows an error with another code even when the root's name spells ENOENT", async () => {
    const err = new Error("EACCES: permission denied, scandir '/d/ENOENT.md'");
    Reflect.set(err, "code", "EACCES");
    await expect(hashDirectoryTree("/d", rootFails(err))).rejects.toThrow(
      "EACCES",
    );
  });
});

describe("realDirectoryIo with hashDirectoryTree", () => {
  const hashOf = (dir: string) => hashDirectoryTree(dir, realDirectoryIo);

  async function tree(): Promise<string> {
    const dir = join(base, "tree");
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "a.md"), "A");
    await writeFile(join(dir, "sub", "c.txt"), "C");
    return dir;
  }

  test("returns a hex digest for an existing directory", async () => {
    expect(await hashOf(await tree())).toMatch(/^[0-9a-f]{64}$/);
  });

  test("returns null when the root does not exist", async () => {
    expect(await hashOf(join(base, "missing"))).toBeNull();
  });

  test("returns the same hash when nothing changed", async () => {
    const dir = await tree();
    const first = await hashOf(dir);
    expect(await hashOf(dir)).toBe(first);
  });

  test("changes the hash when a regular file is added", async () => {
    const dir = await tree();
    const before = await hashOf(dir);
    await writeFile(join(dir, "new.md"), "N");
    expect(await hashOf(dir)).not.toBe(before);
  });

  test("changes the hash when the content of a file changes", async () => {
    const dir = await tree();
    const before = await hashOf(dir);
    await writeFile(join(dir, "a.md"), "A2");
    expect(await hashOf(dir)).not.toBe(before);
  });

  test("changes the hash when a symbolic link is added", async () => {
    const dir = await tree();
    const before = await hashOf(dir);
    await symlink("a.md", join(dir, "link"));
    expect(await hashOf(dir)).not.toBe(before);
  });

  test("changes the hash when a symbolic link is pointed at another target", async () => {
    const dir = await tree();
    await symlink("a.md", join(dir, "link"));
    const before = await hashOf(dir);
    await unlink(join(dir, "link"));
    await symlink("sub/c.txt", join(dir, "link"));
    expect(await hashOf(dir)).not.toBe(before);
  });

  test("changes the hash when a symbolic link to a directory is pointed at another directory", async () => {
    const dir = await tree();
    const outside = join(base, "outside");
    const other = join(base, "other");
    await mkdir(outside);
    await mkdir(other);
    await symlink(outside, join(dir, "dirlink"));
    const before = await hashOf(dir);
    await unlink(join(dir, "dirlink"));
    await symlink(other, join(dir, "dirlink"));
    expect(await hashOf(dir)).not.toBe(before);
  });

  test("does not follow a symbolic link to a directory", async () => {
    const dir = await tree();
    const outside = join(base, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "x.txt"), "X");
    await symlink(outside, join(dir, "dirlink"));
    const before = await hashOf(dir);
    await writeFile(join(outside, "x.txt"), "changed");
    expect(await hashOf(dir)).toBe(before);
  });

  test("changes the hash when a special file is added", async () => {
    const dir = await tree();
    const before = await hashOf(dir);
    Bun.spawnSync(["mkfifo", join(dir, "pipe")]);
    expect(await hashOf(dir)).not.toBe(before);
  });
});

describe("checkDocTreeHash", () => {
  const HASH = "a".repeat(64);

  test("returns match when the current hash equals the baseline", async () => {
    expect(await checkDocTreeHash("/d", HASH, async () => HASH)).toBe("match");
  });

  test("returns modified when the current hash differs from the baseline", async () => {
    expect(await checkDocTreeHash("/d", HASH, async () => "b".repeat(64))).toBe(
      "modified",
    );
  });

  test("returns missing when the baseline exists but the directory does not", async () => {
    expect(await checkDocTreeHash("/d", HASH, async () => null)).toBe(
      "missing",
    );
  });

  test("does not read the directory for a null baseline", async () => {
    const calls: string[] = [];
    await checkDocTreeHash("/d", null, async (dir) => {
      calls.push(dir);
      return HASH;
    });
    expect(calls).toEqual([]);
  });

  test("returns no_baseline for a null baseline", async () => {
    expect(await checkDocTreeHash("/d", null, async () => HASH)).toBe(
      "no_baseline",
    );
  });

  test("returns no_baseline for an empty baseline", async () => {
    expect(await checkDocTreeHash("/d", "", async () => HASH)).toBe(
      "no_baseline",
    );
  });

  test("returns no_baseline for an undefined baseline (a context from before the baseline existed)", async () => {
    expect(await checkDocTreeHash("/d", undefined, async () => HASH)).toBe(
      "no_baseline",
    );
  });

  /** `code`だけを持ち、messageには種類を書かない、ファイルシステムの例外に似せた例外。 */
  function codeOnlyError(code: string): Error {
    const err = new Error("operation failed");
    Reflect.set(err, "code", code);
    return err;
  }

  /** messageだけに種類を書き、`code`を持たない例外。 */
  function messageOnlyError(message: string): Error {
    return new Error(message);
  }

  const ROOT_EXISTS = async () => true;
  const ROOT_MISSING = async () => false;

  test("returns modified when an entry vanished while hashing (code ENOENT)", async () => {
    expect(
      await checkDocTreeHash(
        "/d",
        HASH,
        async () => {
          throw codeOnlyError("ENOENT");
        },
        ROOT_EXISTS,
      ),
    ).toBe("modified");
  });

  test("returns modified when a directory was replaced by a file while hashing (code ENOTDIR)", async () => {
    expect(
      await checkDocTreeHash(
        "/d",
        HASH,
        async () => {
          throw codeOnlyError("ENOTDIR");
        },
        ROOT_EXISTS,
      ),
    ).toBe("modified");
  });

  test("returns modified for an error that only names ENOENT in its message and has no code", async () => {
    expect(
      await checkDocTreeHash(
        "/d",
        HASH,
        async () => {
          throw messageOnlyError("ENOENT: no such file or directory, open");
        },
        ROOT_EXISTS,
      ),
    ).toBe("modified");
  });

  test("returns modified for an error that only names ENOTDIR in its message and has no code", async () => {
    expect(
      await checkDocTreeHash(
        "/d",
        HASH,
        async () => {
          throw messageOnlyError("ENOTDIR: not a directory, scandir");
        },
        ROOT_EXISTS,
      ),
    ).toBe("modified");
  });

  test("rethrows an error with another code even when a file name in its message spells ENOENT", async () => {
    const err = new Error("EACCES: permission denied, open '/d/ENOENT.md'");
    Reflect.set(err, "code", "EACCES");
    await expect(
      checkDocTreeHash(
        "/d",
        HASH,
        async () => {
          throw err;
        },
        ROOT_EXISTS,
      ),
    ).rejects.toThrow("EACCES");
  });

  test("rethrows an error with another code even when a file name in its message spells ENOTDIR", async () => {
    const err = new Error("EIO: i/o error, open '/d/ENOTDIR.md'");
    Reflect.set(err, "code", "EIO");
    await expect(
      checkDocTreeHash(
        "/d",
        HASH,
        async () => {
          throw err;
        },
        ROOT_EXISTS,
      ),
    ).rejects.toThrow("EIO");
  });

  test("rethrows an error that is not about a vanished entry", async () => {
    await expect(
      checkDocTreeHash(
        "/d",
        HASH,
        async () => {
          throw codeOnlyError("EACCES");
        },
        ROOT_EXISTS,
      ),
    ).rejects.toThrow("operation failed");
  });

  test("returns missing when an entry vanished because the root is gone (ENOENT)", async () => {
    expect(
      await checkDocTreeHash(
        "/d",
        HASH,
        async () => {
          throw codeOnlyError("ENOENT");
        },
        ROOT_MISSING,
      ),
    ).toBe("missing");
  });

  test("returns missing when a directory vanished because the root is gone (ENOTDIR)", async () => {
    expect(
      await checkDocTreeHash(
        "/d",
        HASH,
        async () => {
          throw codeOnlyError("ENOTDIR");
        },
        ROOT_MISSING,
      ),
    ).toBe("missing");
  });

  test("looks for the root at the directory that it checks", async () => {
    const asked: string[] = [];
    await checkDocTreeHash(
      "/d",
      HASH,
      async () => {
        throw codeOnlyError("ENOENT");
      },
      async (dir) => {
        asked.push(dir);
        return true;
      },
    );
    expect(asked).toEqual(["/d"]);
  });

  test("does not look for the root when the hash is available", async () => {
    const asked: string[] = [];
    await checkDocTreeHash(
      "/d",
      HASH,
      async () => HASH,
      async (dir) => {
        asked.push(dir);
        return true;
      },
    );
    expect(asked).toEqual([]);
  });

  test("uses the real file system to tell a vanished root from a vanished entry", async () => {
    const root = join(base, "gone");
    expect(
      await checkDocTreeHash(root, HASH, async () => {
        throw codeOnlyError("ENOENT");
      }),
    ).toBe("missing");
  });

  test("finds an existing root on the real file system", async () => {
    expect(
      await checkDocTreeHash(base, HASH, async () => {
        throw codeOnlyError("ENOENT");
      }),
    ).toBe("modified");
  });
});

describe("the reasons for a requirements directory that cannot be trusted", () => {
  test("keeps the reason for a change during design", () => {
    expect(REQUIREMENTS_MODIFIED_REASON).toBe(
      "approved requirements were modified during design",
    );
  });

  test("names the stage before design", () => {
    expect(REQUIREMENTS_MODIFIED_BEFORE_DESIGN_REASON).toBe(
      "approved requirements were modified before design",
    );
  });

  test("names the stage before implementation", () => {
    expect(REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON).toBe(
      "approved requirements were modified before implementation",
    );
  });

  test("names a missing directory apart from a modified one", () => {
    expect(REQUIREMENTS_DIR_MISSING_REASON).toBe(
      "approved requirements directory is missing",
    );
  });
});
