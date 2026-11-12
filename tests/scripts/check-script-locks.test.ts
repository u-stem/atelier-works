import { describe, expect, test } from "bun:test";
import {
  checkScriptLock,
  indexRootLock,
  type RootIndex,
  WORKER_DEPENDENCIES,
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

const SCOPED_ENTRY = `"@scope/x": ["@scope/x@2.0.0", "", {}, "${SCOPED_INTEGRITY}"],`;

const CLIENT_DEPENDENCIES: Record<string, string> = {
  "windmill-client": "1.817.0",
};

type LockShape = {
  /** 前半のpackage.jsonに足す欄。 */
  readonly manifestFields?: Record<string, unknown>;
  /** 後半の`workspaces[""]`。既定は前半と同じ`dependencies`を持つ。 */
  readonly workspace?: Record<string, unknown>;
  /** 後半の`workspaces`に足すworkspace。 */
  readonly extraWorkspaces?: Record<string, unknown>;
  /** 後半の最上位に足す欄。 */
  readonly lockFields?: Record<string, unknown>;
};

/**
 * scriptの`.script.lock`を、宣言する依存と、bun.lockの`packages`の中身から組み立てる。
 * 宣言の既定は、windmill-clientだけである。
 */
function scriptLock(
  packages: string,
  dependencies: Record<string, string> = CLIENT_DEPENDENCIES,
  shape: LockShape = {},
): string {
  const manifest = { dependencies, ...shape.manifestFields };
  const workspaces = {
    "": shape.workspace ?? { dependencies },
    ...shape.extraWorkspaces,
  };
  const extra = Object.entries(shape.lockFields ?? {})
    .map(
      ([key, value]) => `\n  ${JSON.stringify(key)}: ${JSON.stringify(value)},`,
    )
    .join("");
  return `${JSON.stringify(manifest, null, 2)}
//bun.lock
{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": ${JSON.stringify(workspaces)},${extra}
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

function keysOf(text: string, workers?: ReadonlySet<string>): string[] {
  return checkScriptLock(text, rootIndex(), workers).map(
    (violation) => violation.key,
  );
}

describe("checkScriptLock", () => {
  test("accepts a package with the same version and integrity as the root", () => {
    expect(checkScriptLock(scriptLock(CLIENT_ENTRY), rootIndex())).toEqual([]);
  });

  test("accepts a scoped transitive package with the same version and integrity as the root", () => {
    const lock = scriptLock(`${CLIENT_ENTRY}\n    ${SCOPED_ENTRY}`);
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

  test("reports a top-level key whose entry names another package", () => {
    const lock = scriptLock(
      `"windmill-client": ["@scope/x@2.0.0", "", {}, "${SCOPED_INTEGRITY}"],`,
    );
    expect(checkScriptLock(lock, rootIndex())).toEqual([
      {
        key: "packages.windmill-client",
        reason: "package entry names another package than its key",
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
    expect(checkScriptLock(scriptLock(SCOPED_ENTRY), rootIndex())).toEqual([
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
    expect(checkScriptLock(lock, rootIndex(), new Set(["fast-uri"]))).toEqual([
      {
        key: "dependencies.fast-uri",
        reason: "dependency is not declared in the root package.json",
      },
    ]);
  });

  test("reports a declared dependency that the worker list does not allow", () => {
    const lock = scriptLock(SCOPED_ENTRY, { "@scope/x": "2.0.0" });
    expect(checkScriptLock(lock, rootIndex())).toEqual([
      {
        key: "dependencies.@scope/x",
        reason: "dependency is not in the worker dependency list",
      },
    ]);
  });

  test("accepts a declared dependency that the worker list allows", () => {
    const lock = scriptLock(SCOPED_ENTRY, { "@scope/x": "2.0.0" });
    expect(keysOf(lock, new Set(["@scope/x"]))).toEqual([]);
  });

  test("allows windmill-client in the worker list", () => {
    expect(WORKER_DEPENDENCIES.has("windmill-client")).toBe(true);
  });

  test("reports a manifest field other than dependencies", () => {
    const lock = scriptLock(CLIENT_ENTRY, CLIENT_DEPENDENCIES, {
      manifestFields: { devDependencies: { "@scope/x": "2.0.0" } },
    });
    expect(keysOf(lock)).toEqual(["devDependencies"]);
  });

  test("reports a workspace whose dependencies differ from the manifest", () => {
    const lock = scriptLock(CLIENT_ENTRY, CLIENT_DEPENDENCIES, {
      workspace: { dependencies: { "windmill-client": "1.818.0" } },
    });
    expect(keysOf(lock)).toEqual(['workspaces."".dependencies']);
  });

  test("reports a workspace field other than dependencies", () => {
    const lock = scriptLock(CLIENT_ENTRY, CLIENT_DEPENDENCIES, {
      workspace: {
        dependencies: CLIENT_DEPENDENCIES,
        devDependencies: { "@scope/x": "2.0.0" },
      },
    });
    expect(keysOf(lock)).toEqual(['workspaces."".devDependencies']);
  });

  test("reports an extra workspace", () => {
    const lock = scriptLock(CLIENT_ENTRY, CLIENT_DEPENDENCIES, {
      extraWorkspaces: { "packages/x": { dependencies: {} } },
    });
    expect(keysOf(lock)).toEqual(["workspaces.packages/x"]);
  });

  test("reports trustedDependencies in the bun.lock part", () => {
    const lock = scriptLock(CLIENT_ENTRY, CLIENT_DEPENDENCIES, {
      lockFields: { trustedDependencies: ["windmill-client"] },
    });
    expect(keysOf(lock)).toEqual(["bun.lock.trustedDependencies"]);
  });

  test("reports overrides in the bun.lock part", () => {
    const lock = scriptLock(CLIENT_ENTRY, CLIENT_DEPENDENCIES, {
      lockFields: { overrides: { "windmill-client": "1.818.0" } },
    });
    expect(keysOf(lock)).toEqual(["bun.lock.overrides"]);
  });

  test("reports patchedDependencies in the bun.lock part", () => {
    const lock = scriptLock(CLIENT_ENTRY, CLIENT_DEPENDENCIES, {
      lockFields: {
        patchedDependencies: { "windmill-client@1.817.0": "patches/x.patch" },
      },
    });
    expect(keysOf(lock)).toEqual(["bun.lock.patchedDependencies"]);
  });

  test("accepts an empty lock of a script without dependencies", () => {
    expect(checkScriptLock(EMPTY_LOCK, rootIndex())).toEqual([]);
  });

  test("reports dependencies that have no bun.lock part", () => {
    const lock =
      '{\n  "dependencies": {\n    "windmill-client": "1.817.0"\n  }\n}\n//bun.lock\n<empty>';
    expect(keysOf(lock)).toEqual(["bun.lock"]);
  });

  test("reports a manifest without dependencies", () => {
    expect(keysOf("{}\n//bun.lock\n<empty>")).toEqual(["dependencies"]);
  });

  test("reports a lock without the bun.lock separator", () => {
    expect(keysOf('{"dependencies": {}}')).toEqual(["<root>"]);
  });

  test("reports a bun.lock part that is not valid JSONC", () => {
    expect(keysOf('{"dependencies": {}}\n//bun.lock\n{"packages": ')).toEqual([
      "bun.lock",
    ]);
  });
});

describe("indexRootLock", () => {
  test("rejects a root lockfile without packages", () => {
    expect(indexRootLock('{"lockfileVersion": 2}').ok).toBe(false);
  });
});
