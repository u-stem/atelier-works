import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyPackageJsonChange } from "../../scripts/host_apply/package_policy.ts";

const REPO_ROOT = join(import.meta.dir, "../..");
const REAL = readFileSync(join(REPO_ROOT, "package.json"), "utf8");

function pkg(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: "x",
    private: true,
    dependencies: { left: "1.0.0" },
    devDependencies: { right: "^2.0.0" },
    overrides: { katex: "0.18.11" },
    ...extra,
  });
}

describe("classifyPackageJsonChange: version bumps", () => {
  test("is none for identical text", () => {
    expect(classifyPackageJsonChange(pkg(), pkg())).toBe("none");
  });

  test("is auto when a dependency version is bumped", () => {
    expect(
      classifyPackageJsonChange(
        pkg(),
        pkg({ dependencies: { left: "1.0.1" } }),
      ),
    ).toBe("auto");
  });

  test("is auto when a devDependency range is bumped", () => {
    expect(
      classifyPackageJsonChange(
        pkg(),
        pkg({ devDependencies: { right: "^2.1.0" } }),
      ),
    ).toBe("auto");
  });

  test("is auto when an override version is bumped", () => {
    expect(
      classifyPackageJsonChange(
        pkg(),
        pkg({ overrides: { katex: "0.18.12" } }),
      ),
    ).toBe("auto");
  });

  test("is auto when a pre-release version is used", () => {
    expect(
      classifyPackageJsonChange(
        pkg(),
        pkg({ dependencies: { left: "2.0.0-rc.1" } }),
      ),
    ).toBe("auto");
  });

  test("is auto when only whitespace and key order change", () => {
    const target = JSON.stringify(JSON.parse(pkg()), null, 4);
    expect(classifyPackageJsonChange(pkg(), target)).toBe("auto");
  });

  test("is auto for a bump in the real package.json", () => {
    expect(
      classifyPackageJsonChange(
        REAL,
        REAL.replace('"typescript": "^7.0.2"', '"typescript": "^7.0.3"'),
      ),
    ).toBe("auto");
  });
});

describe("classifyPackageJsonChange: only existing names are exempt", () => {
  test.each(["dependencies", "devDependencies", "overrides"])(
    "adding a new name to %s needs approval",
    (key) => {
      const before = JSON.parse(pkg());
      const after = {
        ...before,
        [key]: { ...before[key], brand_new: "1.0.0" },
      };
      expect(classifyPackageJsonChange(pkg(), JSON.stringify(after))).toBe(
        "approval",
      );
    },
  );

  test("adding a name to a map that did not exist needs approval", () => {
    expect(
      classifyPackageJsonChange(
        JSON.stringify({ name: "x" }),
        JSON.stringify({ name: "x", dependencies: { left: "1.0.0" } }),
      ),
    ).toBe("approval");
  });

  test("removing a name stays auto", () => {
    expect(classifyPackageJsonChange(pkg(), pkg({ devDependencies: {} }))).toBe(
      "auto",
    );
  });

  test.each(["peerDependencies", "optionalDependencies", "resolutions"])(
    "a version change in %s needs approval",
    (key) => {
      expect(
        classifyPackageJsonChange(
          pkg({ [key]: { left: "1.0.0" } }),
          pkg({ [key]: { left: "1.0.1" } }),
        ),
      ).toBe("approval");
    },
  );
});

describe("classifyPackageJsonChange: changes that need approval", () => {
  test.each([
    ["adds a scripts field", { scripts: { postinstall: "echo x" } }],
    ["adds a bin field", { bin: { x: "./x.js" } }],
    ["adds workspaces", { workspaces: ["packages/*"] }],
    ["adds trustedDependencies", { trustedDependencies: ["left"] }],
    ["changes the name", { name: "y" }],
    ["adds a top-level key", { anything: 1 }],
    ["changes the type", { type: "module" }],
  ])("%s", (_name, extra) => {
    expect(classifyPackageJsonChange(pkg(), pkg(extra))).toBe("approval");
  });

  test("changes an existing scripts field", () => {
    expect(
      classifyPackageJsonChange(
        pkg({ scripts: { a: "echo a" } }),
        pkg({ scripts: { a: "echo b" } }),
      ),
    ).toBe("approval");
  });

  test.each([
    "github:user/repo",
    "git+https://example.com/x.git",
    "file:../x",
    "npm:evil@1.0.0",
    "https://example.com/x.tgz",
    "user/repo",
    "latest",
    "*",
    "workspace:*",
  ])("a dependency spec of %s", (spec) => {
    expect(
      classifyPackageJsonChange(pkg(), pkg({ dependencies: { left: spec } })),
    ).toBe("approval");
  });

  test("a dependency spec that is not a string", () => {
    expect(
      classifyPackageJsonChange(pkg(), pkg({ dependencies: { left: 1 } })),
    ).toBe("approval");
  });

  test("a nested override that is not a version", () => {
    expect(
      classifyPackageJsonChange(
        pkg(),
        pkg({ overrides: { katex: { left: "github:u/r" } } }),
      ),
    ).toBe("approval");
  });

  test("dependencies that is not an object", () => {
    expect(classifyPackageJsonChange(pkg(), pkg({ dependencies: [] }))).toBe(
      "approval",
    );
  });

  test("a new file", () => {
    expect(classifyPackageJsonChange(null, pkg())).toBe("approval");
  });

  test("a target that is not valid JSON", () => {
    expect(classifyPackageJsonChange(pkg(), "{nope")).toBe("approval");
  });

  test("a base that is not valid JSON", () => {
    expect(classifyPackageJsonChange("{nope", pkg())).toBe("approval");
  });

  test("a target that is not an object", () => {
    expect(classifyPackageJsonChange(pkg(), "[]")).toBe("approval");
  });
});
