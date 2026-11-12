import { describe, expect, test } from "bun:test";
import {
  checkScriptLock,
  indexRootLock,
  type RootIndex,
} from "../../scripts/check-script-locks.ts";

const CLIENT_INTEGRITY = "sha512-AbCd+/0123456789==";
const SCOPED_INTEGRITY = "sha512-EfGh+/9876543210==";
const TRANSITIVE_INTEGRITY = "sha512-IjKl+/1357924680==";

// `fast-uri`は、ルートのpackage.jsonが宣言しない推移的な依存として置く。
const ROOT_LOCK = `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "root",
      "devDependencies": {
        "windmill-client": "1.817.0",
        "@scope/x": "2.0.0",
      },
    },
  },
  "packages": {
    "windmill-client": ["windmill-client@1.817.0", "", {}, "${CLIENT_INTEGRITY}"],
    "@scope/x": ["@scope/x@2.0.0", "", {}, "${SCOPED_INTEGRITY}"],
    "fast-uri": ["fast-uri@3.1.9", "", {}, "${TRANSITIVE_INTEGRITY}"],
  }
}
`;

const EMPTY_LOCK = '{\n  "dependencies": {}\n}\n//bun.lock\n<empty>';

const CLIENT_ENTRY = `"windmill-client": ["windmill-client@1.817.0", "", {}, "${CLIENT_INTEGRITY}"],`;

/**
 * scriptの`.script.lock`を、宣言する依存と、bun.lockの`packages`の中身から組み立てる。
 * 宣言の既定は、windmill-clientだけである。
 */
function scriptLock(
  packages: string,
  dependencies: Record<string, string> = { "windmill-client": "1.817.0" },
): string {
  return `${JSON.stringify({ dependencies }, null, 2)}
//bun.lock
{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "dependencies": ${JSON.stringify(dependencies)},
    },
  },
  "packages": {
    ${packages}
  }
}`;
}

function rootIndex(text: string = ROOT_LOCK): RootIndex {
  const result = indexRootLock(text);
  if (!result.ok) throw new Error(result.reason);
  return result.index;
}

describe("checkScriptLock", () => {
  test("accepts a package with the same version and integrity as the root", () => {
    expect(checkScriptLock(scriptLock(CLIENT_ENTRY), rootIndex())).toEqual([]);
  });

  test("accepts a scoped package with the same version and integrity as the root", () => {
    const lock = scriptLock(
      `"@scope/x": ["@scope/x@2.0.0", "", {}, "${SCOPED_INTEGRITY}"],`,
      { "@scope/x": "2.0.0" },
    );
    expect(checkScriptLock(lock, rootIndex())).toEqual([]);
  });

  test("reports a package whose version differs from the root", () => {
    const lock = scriptLock(
      `"windmill-client": ["windmill-client@1.818.0", "", {}, "${CLIENT_INTEGRITY}"],`,
    );
    expect(checkScriptLock(lock, rootIndex())).toEqual([
      {
        key: "packages.windmill-client",
        reason: "version differs from the root bun.lock",
      },
    ]);
  });

  test("reports a package whose integrity differs from the root", () => {
    const lock = scriptLock(
      `"windmill-client": ["windmill-client@1.817.0", "", {}, "${SCOPED_INTEGRITY}"],`,
    );
    expect(checkScriptLock(lock, rootIndex())).toEqual([
      {
        key: "packages.windmill-client",
        reason: "integrity differs from the root bun.lock",
      },
    ]);
  });

  test("reports a package that the root does not have", () => {
    const lock = scriptLock(
      `${CLIENT_ENTRY}\n    "left-pad": ["left-pad@1.3.0", "", {}, "${CLIENT_INTEGRITY}"],`,
    );
    expect(checkScriptLock(lock, rootIndex())).toEqual([
      {
        key: "packages.left-pad",
        reason: "package is not in the root bun.lock",
      },
    ]);
  });

  test("reports a package entry without integrity", () => {
    const lock = scriptLock(
      `"windmill-client": ["windmill-client@1.817.0", "", {}],`,
    );
    expect(checkScriptLock(lock, rootIndex())).toEqual([
      {
        key: "packages.windmill-client",
        reason: "integrity differs from the root bun.lock",
      },
    ]);
  });

  test("reports a malformed package entry", () => {
    const lock = scriptLock(`"windmill-client": "windmill-client@1.817.0",`);
    expect(checkScriptLock(lock, rootIndex())).toEqual([
      {
        key: "packages.windmill-client",
        reason: "package entry is malformed",
      },
    ]);
  });

  test("reports a declared dependency when the packages are empty", () => {
    expect(checkScriptLock(scriptLock(""), rootIndex())).toEqual([
      {
        key: "dependencies.windmill-client",
        reason: "dependency has no package in the bun.lock part",
      },
    ]);
  });

  test("reports a declared dependency that only another package stands for", () => {
    const lock = scriptLock(
      `"@scope/x": ["@scope/x@2.0.0", "", {}, "${SCOPED_INTEGRITY}"],`,
    );
    expect(checkScriptLock(lock, rootIndex())).toEqual([
      {
        key: "dependencies.windmill-client",
        reason: "dependency has no package in the bun.lock part",
      },
    ]);
  });

  test("reports a declared version that differs from the root package.json", () => {
    const lock = scriptLock(CLIENT_ENTRY, { "windmill-client": "1.818.0" });
    expect(checkScriptLock(lock, rootIndex())).toEqual([
      {
        key: "dependencies.windmill-client",
        reason: "declared version differs from the root package.json",
      },
    ]);
  });

  test("reports a declared dependency that the root package.json does not declare", () => {
    const lock = scriptLock(
      `"fast-uri": ["fast-uri@3.1.9", "", {}, "${TRANSITIVE_INTEGRITY}"],`,
      { "fast-uri": "3.1.9" },
    );
    expect(checkScriptLock(lock, rootIndex())).toEqual([
      {
        key: "dependencies.fast-uri",
        reason: "dependency is not declared in the root package.json",
      },
    ]);
  });

  test("accepts an empty lock of a script without dependencies", () => {
    expect(checkScriptLock(EMPTY_LOCK, rootIndex())).toEqual([]);
  });

  test("reports dependencies that have no bun.lock part", () => {
    const lock =
      '{\n  "dependencies": {\n    "windmill-client": "1.817.0"\n  }\n}\n//bun.lock\n<empty>';
    expect(
      checkScriptLock(lock, rootIndex()).map((violation) => violation.key),
    ).toEqual(["bun.lock"]);
  });

  test("reports a manifest without dependencies", () => {
    expect(
      checkScriptLock("{}\n//bun.lock\n<empty>", rootIndex()).map(
        (violation) => violation.key,
      ),
    ).toEqual(["dependencies"]);
  });

  test("reports a lock without the bun.lock separator", () => {
    expect(
      checkScriptLock('{"dependencies": {}}', rootIndex()).map(
        (violation) => violation.key,
      ),
    ).toEqual(["<root>"]);
  });

  test("reports a bun.lock part that is not valid JSONC", () => {
    const lock = '{"dependencies": {}}\n//bun.lock\n{"packages": ';
    expect(
      checkScriptLock(lock, rootIndex()).map((violation) => violation.key),
    ).toEqual(["bun.lock"]);
  });
});

describe("indexRootLock", () => {
  test("rejects a root lockfile without packages", () => {
    expect(indexRootLock('{"lockfileVersion": 2}').ok).toBe(false);
  });
});
