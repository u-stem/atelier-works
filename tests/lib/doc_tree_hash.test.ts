import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
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
  copyDirectoryTreeWithHash,
  copyFilesWithHash,
  type DirectoryEntryIo,
  hashDirectoryTree,
  isRequirementsUntrustedReason,
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
        return { kind: "file", content: new TextEncoder().encode(content) };
      },
      isSymbolicLink: async () => false,
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
      readFile: async () => ({ kind: "file", content: new Uint8Array() }),
      isSymbolicLink: async () => false,
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

  test("tells a regular file whose content spells a link apart from the link itself", async () => {
    const asFile = join(base, "as-file");
    const asLink = join(base, "as-link");
    await mkdir(asFile);
    await mkdir(asLink);
    await writeFile(join(asFile, "x"), "symlink:/x");
    await symlink("/x", join(asLink, "x"));
    expect(await hashOf(asFile)).not.toBe(await hashOf(asLink));
  });

  test("tells a special file apart from a regular file whose content is the word special", async () => {
    const asFile = join(base, "as-file");
    const asSpecial = join(base, "as-special");
    await mkdir(asFile);
    await mkdir(asSpecial);
    await writeFile(join(asFile, "x"), "special");
    Bun.spawnSync(["mkfifo", join(asSpecial, "x")]);
    expect(await hashOf(asFile)).not.toBe(await hashOf(asSpecial));
  });

  test("tells a link apart from a special file", async () => {
    const asLink = join(base, "as-link");
    const asSpecial = join(base, "as-special");
    await mkdir(asLink);
    await mkdir(asSpecial);
    await symlink("special", join(asLink, "x"));
    Bun.spawnSync(["mkfifo", join(asSpecial, "x")]);
    expect(await hashOf(asLink)).not.toBe(await hashOf(asSpecial));
  });

  /** `real`と同じ内容の本物のディレクトリを`replica`に作り、`real`を`replica`へのシンボリックリンクに置き換える。 */
  async function replaceRootWithLink(real: string): Promise<void> {
    const replica = join(base, "replica");
    await mkdir(join(replica, "sub"), { recursive: true });
    await writeFile(join(replica, "a.md"), "A");
    await writeFile(join(replica, "sub", "c.txt"), "C");
    await rm(real, { recursive: true, force: true });
    await symlink(replica, real);
  }

  test("refuses a root that was replaced with a link to a directory of the same content", async () => {
    const dir = await tree();
    await replaceRootWithLink(dir);
    await expect(hashOf(dir)).rejects.toThrow("symbolic link");
  });

  test("treats a root replaced with a link as modified, not as a match", async () => {
    const dir = await tree();
    const baseline = await hashOf(dir);
    await replaceRootWithLink(dir);
    expect(await checkDocTreeHash(dir, baseline, hashOf)).toBe("modified");
  });

  test("treats a root replaced with a dangling link as modified, not as missing", async () => {
    const dir = await tree();
    const baseline = await hashOf(dir);
    await rm(dir, { recursive: true, force: true });
    await symlink(join(base, "nowhere"), dir);
    expect(await checkDocTreeHash(dir, baseline, hashOf)).toBe("modified");
  });
});

describe("copyDirectoryTreeWithHash", () => {
  const hashOf = (dir: string) => hashDirectoryTree(dir, realDirectoryIo);

  async function tree(): Promise<string> {
    const dir = join(base, "tree");
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "a.md"), "A");
    await writeFile(join(dir, "sub", "c.txt"), "C");
    return dir;
  }

  /** 1回読んだ直後に、元のファイルを別の内容に書き換える読み取り。複製の最中だけ書き換える攻撃に似せる。 */
  function swapAfterRead(path: string, replacement: string): DirectoryEntryIo {
    return {
      ...realDirectoryIo,
      readFile: async (target) => {
        const read = await realDirectoryIo.readFile(target);
        if (target === path) await writeFile(path, replacement);
        return read;
      },
    };
  }

  test("returns the same hash as hashing the source", async () => {
    const dir = await tree();
    const copy = join(base, "copy");
    expect(await copyDirectoryTreeWithHash(dir, copy)).toBe(await hashOf(dir));
  });

  test("writes the files of the source into the destination", async () => {
    const dir = await tree();
    const copy = join(base, "copy");
    await copyDirectoryTreeWithHash(dir, copy);
    expect(await Bun.file(join(copy, "sub", "c.txt")).text()).toBe("C");
  });

  test("returns a hash that the copy itself reproduces", async () => {
    const dir = await tree();
    const copy = join(base, "copy");
    const hash = await copyDirectoryTreeWithHash(dir, copy);
    expect(await hashOf(copy)).toBe(hash);
  });

  test("writes the bytes that it hashed even when the source is swapped right after the read", async () => {
    const dir = await tree();
    const copy = join(base, "copy");
    await copyDirectoryTreeWithHash(
      dir,
      copy,
      swapAfterRead(join(dir, "a.md"), "SWAPPED"),
    );
    expect(await Bun.file(join(copy, "a.md")).text()).toBe("A");
  });

  test("returns the hash of the bytes that it wrote, which the swapped source no longer has", async () => {
    const dir = await tree();
    const before = await hashOf(dir);
    const copy = join(base, "copy");
    const hash = await copyDirectoryTreeWithHash(
      dir,
      copy,
      swapAfterRead(join(dir, "a.md"), "SWAPPED"),
    );
    expect([hash === before, (await hashOf(dir)) === before]).toEqual([
      true,
      false,
    ]);
  });

  test("does not copy a symbolic link but still hashes it", async () => {
    const dir = await tree();
    await symlink("a.md", join(dir, "link"));
    const copy = join(base, "copy");
    const hash = await copyDirectoryTreeWithHash(dir, copy);
    expect([
      hash === (await hashOf(dir)),
      existsSync(join(copy, "link")),
    ]).toEqual([true, false]);
  });

  test("does not copy a special file", async () => {
    const dir = await tree();
    Bun.spawnSync(["mkfifo", join(dir, "pipe")]);
    const copy = join(base, "copy");
    await copyDirectoryTreeWithHash(dir, copy);
    expect(existsSync(join(copy, "pipe"))).toBe(false);
  });

  test("returns null when the source does not exist", async () => {
    expect(
      await copyDirectoryTreeWithHash(
        join(base, "missing"),
        join(base, "copy"),
      ),
    ).toBeNull();
  });

  test("refuses a source that is a symbolic link", async () => {
    const dir = await tree();
    const link = join(base, "link-root");
    await symlink(dir, link);
    await expect(
      copyDirectoryTreeWithHash(link, join(base, "copy")),
    ).rejects.toThrow("symbolic link");
  });
});

describe("copyFilesWithHash", () => {
  const hashOf = (dir: string) => hashDirectoryTree(dir, realDirectoryIo);

  async function source(): Promise<string> {
    const dir = join(base, "source");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "requirements.md"), "R");
    await writeFile(join(dir, "flow.drawio"), "FLOW");
    await writeFile(join(dir, "other.drawio"), "OTHER");
    return dir;
  }

  async function destination(): Promise<string> {
    const dir = join(base, "destination");
    await mkdir(dir, { recursive: true });
    return dir;
  }

  test("hashes the whole source, not only the files it copies", async () => {
    const dir = await source();
    const result = await copyFilesWithHash(dir, await destination(), [
      "flow.drawio",
    ]);
    expect(result.hash).toBe(await hashOf(dir));
  });

  test("copies only the named files", async () => {
    const dir = await source();
    const dest = await destination();
    await copyFilesWithHash(dir, dest, ["flow.drawio"]);
    expect([
      existsSync(join(dest, "flow.drawio")),
      existsSync(join(dest, "other.drawio")),
      existsSync(join(dest, "requirements.md")),
    ]).toEqual([true, false, false]);
  });

  test("lists the files that it copied", async () => {
    const dir = await source();
    const result = await copyFilesWithHash(dir, await destination(), [
      "flow.drawio",
      "absent.drawio",
    ]);
    expect(result.copied).toEqual(["flow.drawio"]);
  });

  test("does not copy a named file that is a symbolic link", async () => {
    const dir = await source();
    await rm(join(dir, "flow.drawio"));
    await symlink("/etc/hosts", join(dir, "flow.drawio"));
    const dest = await destination();
    const result = await copyFilesWithHash(dir, dest, ["flow.drawio"]);
    expect([result.copied, existsSync(join(dest, "flow.drawio"))]).toEqual([
      [],
      false,
    ]);
  });

  test("writes the bytes that it hashed even when the source is swapped right after the read", async () => {
    const dir = await source();
    const dest = await destination();
    const target = join(dir, "flow.drawio");
    const io: DirectoryEntryIo = {
      ...realDirectoryIo,
      readFile: async (path) => {
        const read = await realDirectoryIo.readFile(path);
        if (path === target) await writeFile(target, "SWAPPED");
        return read;
      },
    };
    await copyFilesWithHash(dir, dest, ["flow.drawio"], io);
    expect(await Bun.file(join(dest, "flow.drawio")).text()).toBe("FLOW");
  });

  test("returns null as the hash when the source does not exist", async () => {
    const result = await copyFilesWithHash(
      join(base, "missing"),
      await destination(),
      ["flow.drawio"],
    );
    expect(result.hash).toBeNull();
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

describe("isRequirementsUntrustedReason", () => {
  const REASONS = [
    ["before design", REQUIREMENTS_MODIFIED_BEFORE_DESIGN_REASON],
    ["during design", REQUIREMENTS_MODIFIED_REASON],
    ["before implementation", REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON],
    ["a missing directory", REQUIREMENTS_DIR_MISSING_REASON],
  ] as const;

  test.each(REASONS)("matches the reason alone for %s", (_name, reason) => {
    expect(isRequirementsUntrustedReason(reason)).toBe(true);
  });

  test.each(REASONS)(
    "matches the reason followed by a separator and a note for %s",
    (_name, reason) => {
      expect(
        isRequirementsUntrustedReason(`${reason}; partial work kept local`),
      ).toBe(true);
    },
  );

  test.each(REASONS)(
    "does not match the reason followed by other text for %s",
    (_name, reason) => {
      expect(isRequirementsUntrustedReason(`${reason} extra`)).toBe(false);
    },
  );

  test.each(REASONS)(
    "does not match the reason followed by a letter for %s",
    (_name, reason) => {
      expect(isRequirementsUntrustedReason(`${reason}x`)).toBe(false);
    },
  );

  test.each(REASONS)(
    "does not match a prefix of the reason for %s",
    (_name, reason) => {
      expect(isRequirementsUntrustedReason(reason.slice(0, -1))).toBe(false);
    },
  );

  test("does not match another reason", () => {
    expect(isRequirementsUntrustedReason("claude run failed")).toBe(false);
  });

  test("does not match a null note", () => {
    expect(isRequirementsUntrustedReason(null)).toBe(false);
  });
});
