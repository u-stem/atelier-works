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

  test("reports a lockfile that is not an object", () => {
    expect(checkConsoleLockfile(null)).toHaveLength(1);
  });
});
