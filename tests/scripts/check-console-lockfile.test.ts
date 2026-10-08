import { describe, expect, test } from "bun:test";
import {
  checkConsoleLockfile,
  checkPackageEntry,
  classifySpecifier,
} from "../../scripts/check-console-lockfile.ts";

const INTEGRITY = "sha512-AbCd+/0123456789==";

function lockWith(
  packages: Record<string, unknown>,
  dependencies: Record<string, string> = { react: "19.3.0" },
): Record<string, unknown> {
  return {
    lockfileVersion: 2,
    configVersion: 1,
    workspaces: { "": { name: "factory-console", dependencies } },
    packages,
  };
}

describe("classifySpecifier", () => {
  test("treats an exact version as a registry dependency", () => {
    expect(classifySpecifier("19.3.0")).toBe("registry");
  });

  test("treats a caret range as a registry dependency", () => {
    expect(classifySpecifier("^1.2.0")).toBe("registry");
  });

  test("treats an npm alias as a registry dependency", () => {
    expect(classifySpecifier("npm:react@19.3.0")).toBe("registry");
  });

  test("forbids git+ URLs", () => {
    expect(classifySpecifier("git+https://github.com/o/r.git#abc")).toBe(
      "forbidden",
    );
  });

  test("forbids github: shorthands", () => {
    expect(classifySpecifier("github:o/r#abc")).toBe("forbidden");
  });

  test("forbids owner/repo shorthands", () => {
    expect(classifySpecifier("o/r#abc")).toBe("forbidden");
  });

  test("forbids tarball URLs", () => {
    expect(classifySpecifier("https://example.com/x.tgz")).toBe("forbidden");
  });

  test("forbids workspace: references", () => {
    expect(classifySpecifier("workspace:*")).toBe("forbidden");
  });

  test("allows file: inside console/", () => {
    expect(classifySpecifier("file:./vendor/x")).toBe("local");
  });

  test("forbids file: outside console/", () => {
    expect(classifySpecifier("file:../x")).toBe("forbidden");
  });

  test("forbids link: to an absolute path", () => {
    expect(classifySpecifier("link:/tmp/x")).toBe("forbidden");
  });

  test("forbids file: to the home directory", () => {
    expect(classifySpecifier("file:~/x")).toBe("forbidden");
  });

  test("forbids an upper-case FILE: prefix", () => {
    expect(classifySpecifier("FILE:x")).toBe("forbidden");
  });

  test("forbids an ssh: URL", () => {
    expect(classifySpecifier("ssh:x")).toBe("forbidden");
  });

  test("forbids a bare tarball file name", () => {
    expect(classifySpecifier("foo.tgz")).toBe("forbidden");
  });

  test("forbids an npm alias to a GitHub shorthand", () => {
    expect(classifySpecifier("npm:x@github:o/r")).toBe("forbidden");
  });

  test("forbids a catalog: reference", () => {
    expect(classifySpecifier("catalog:")).toBe("forbidden");
  });

  test("treats a dist-tag as a registry dependency", () => {
    expect(classifySpecifier("latest")).toBe("registry");
  });

  test("treats a hyphen range as a registry dependency", () => {
    expect(classifySpecifier(">=1.0.0 <2.0.0 || 3.x")).toBe("registry");
  });
});

describe("checkPackageEntry", () => {
  test("accepts a registry package with sha512 integrity", () => {
    expect(checkPackageEntry(["react@19.3.0", "", {}, INTEGRITY])).toBeNull();
  });

  test("accepts a scoped registry package with sha512 integrity", () => {
    expect(
      checkPackageEntry(["@types/react@19.3.0", "", {}, INTEGRITY]),
    ).toBeNull();
  });

  test("rejects a registry package without integrity", () => {
    expect(checkPackageEntry(["react@19.3.0", "", {}])).not.toBeNull();
  });

  test("rejects a sha1 integrity", () => {
    expect(
      checkPackageEntry(["react@19.3.0", "", {}, "sha1-abc="]),
    ).not.toBeNull();
  });

  test("rejects a non-default registry", () => {
    expect(
      checkPackageEntry([
        "react@19.3.0",
        "https://registry.example.com/",
        {},
        INTEGRITY,
      ]),
    ).not.toBeNull();
  });

  test("rejects a git dependency", () => {
    expect(
      checkPackageEntry(["x@git+ssh://git@github.com/o/r.git#abc", {}, "h"]),
    ).not.toBeNull();
  });

  test("accepts a file: dependency inside console/", () => {
    expect(checkPackageEntry(["x@file:./vendor/x", {}])).toBeNull();
  });

  test("rejects an npm alias that hides a git dependency", () => {
    expect(
      checkPackageEntry(["x@npm:y@git+https://h/r", "", {}, INTEGRITY]),
    ).not.toBeNull();
  });

  test("rejects an upper-case FILE: dependency", () => {
    expect(checkPackageEntry(["x@FILE:foo", "", {}, INTEGRITY])).not.toBeNull();
  });

  test("rejects a malformed entry", () => {
    expect(checkPackageEntry({ id: "react@19.3.0" })).not.toBeNull();
  });
});

describe("checkConsoleLockfile", () => {
  test("accepts a lockfile with only registry dependencies", () => {
    expect(
      checkConsoleLockfile(
        lockWith({ react: ["react@19.3.0", "", {}, INTEGRITY] }),
      ),
    ).toEqual([]);
  });

  test("reports a forbidden package entry by its key", () => {
    expect(
      checkConsoleLockfile(lockWith({ x: ["x@github:o/r#abc", {}, "h"] })).map(
        (violation) => violation.key,
      ),
    ).toEqual(["packages.x"]);
  });

  test("reports a forbidden workspace dependency specifier", () => {
    expect(
      checkConsoleLockfile(
        lockWith(
          { react: ["react@19.3.0", "", {}, INTEGRITY] },
          {
            react: "github:o/r",
          },
        ),
      ).map((violation) => violation.key),
    ).toEqual(['workspaces."".dependencies.react']);
  });

  test("reports an extra workspace", () => {
    const lock = lockWith({});
    lock.workspaces = { "": {}, "packages/x": {} };
    expect(
      checkConsoleLockfile(lock).map((violation) => violation.key),
    ).toEqual(["workspaces.packages/x"]);
  });

  test("reports trustedDependencies", () => {
    const lock = lockWith({});
    lock.trustedDependencies = ["esbuild"];
    expect(
      checkConsoleLockfile(lock).map((violation) => violation.key),
    ).toEqual(["trustedDependencies"]);
  });

  test("reports patchedDependencies", () => {
    const lock = lockWith({});
    lock.patchedDependencies = { "react@19.3.0": "patches/react.patch" };
    expect(
      checkConsoleLockfile(lock).map((violation) => violation.key),
    ).toEqual(["patchedDependencies"]);
  });

  test("reports an override that points at GitHub", () => {
    const lock = lockWith({});
    lock.overrides = { react: "github:o/r" };
    expect(
      checkConsoleLockfile(lock).map((violation) => violation.key),
    ).toEqual(["overrides.react"]);
  });

  test("accepts an override to a registry version", () => {
    const lock = lockWith({});
    lock.overrides = { react: "19.3.0" };
    expect(checkConsoleLockfile(lock)).toEqual([]);
  });

  test("reports a catalog entry that points at a tarball", () => {
    const lock = lockWith({});
    lock.catalog = { react: "https://example.com/x.tgz" };
    expect(
      checkConsoleLockfile(lock).map((violation) => violation.key),
    ).toEqual(["catalog.react"]);
  });

  test("reports a named catalog entry that points at git", () => {
    const lock = lockWith({});
    lock.catalogs = { ui: { react: "git+https://h/r" } };
    expect(
      checkConsoleLockfile(lock).map((violation) => violation.key),
    ).toEqual(["catalogs.ui.react"]);
  });

  test("reports a malformed overrides value", () => {
    const lock = lockWith({});
    lock.overrides = "react";
    expect(
      checkConsoleLockfile(lock).map((violation) => violation.key),
    ).toEqual(["overrides"]);
  });

  test("reports an unknown top-level key", () => {
    const lock = lockWith({});
    lock.mystery = {};
    expect(
      checkConsoleLockfile(lock).map((violation) => violation.key),
    ).toEqual(["mystery"]);
  });

  test("reports a lockfile that is not an object", () => {
    expect(checkConsoleLockfile(null)).toHaveLength(1);
  });
});
