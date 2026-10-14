import { describe, expect, test } from "bun:test";
import { MAX_FILE_BYTES } from "../../f/factory/lib/metadata_patch_manifest.ts";
import { MAX_SOURCES } from "../../f/factory/lib/metadata_patch_verify.ts";
import {
  addExistingScript,
  BASE,
  BASE_TIP,
  codeOf,
  EMPTY_LOCK,
  EMPTY_LOCK_PATH,
  HASH_NEW,
  HASH_OLD,
  HEAD,
  LOCK,
  OTHER_LOCK,
  scriptYaml,
  verify,
  wmillLock,
  world,
} from "./metadata_patch_verify_world.ts";

describe("verifyMetadataPatch limits the script yaml to changed sources", () => {
  test("rejects the yaml of a script whose imported file changed", async () => {
    const w = world();
    w.pr = {
      ...w.pr,
      diff: [{ path: "f/factory/lib/bar.ts", status: "modified" }],
    };
    expect(await codeOf(w)).toBe("script_not_affected");
  });

  test("accepts the lock of a script whose imported file changed", async () => {
    const w = world();
    w.pr = {
      ...w.pr,
      diff: [{ path: "f/factory/lib/bar.ts", status: "modified" }],
    };
    w.patch.delete("f/factory/foo.script.yaml");
    expect(await codeOf(w)).toBe("ok");
  });

  test("rejects a variable reference in the schema", async () => {
    const w = world();
    w.patch.set(
      "f/factory/foo.script.yaml",
      `${scriptYaml("foo", "string")}  default: $var:u/admin/secret\n`,
    );
    expect(await codeOf(w)).toBe("script_yaml_invalid");
  });

  test("rejects a resource reference in the schema", async () => {
    const w = world();
    w.patch.set(
      "f/factory/foo.script.yaml",
      `${scriptYaml("foo", "string")}  default: $res:u/admin/db\n`,
    );
    expect(await codeOf(w)).toBe("script_yaml_invalid");
  });
});

describe("verifyMetadataPatch keeps the lock of an existing script", () => {
  test("rejects a lock that differs from the head tree", async () => {
    const w = world();
    w.patch.set("f/factory/foo.script.lock", LOCK.replace("1.3.0", "1.4.0"));
    expect(await codeOf(w)).toBe("lock_changed");
  });

  test("rejects a lock with an added dependency", async () => {
    const w = world();
    w.patch.set(
      "f/factory/foo.script.lock",
      LOCK.replace('"left-pad"', '"is-odd": "1.0.0",\n    "left-pad"'),
    );
    expect(await codeOf(w)).toBe("lock_changed");
  });

  test("rejects a lock that differs by one byte", async () => {
    const w = world();
    w.patch.set("f/factory/foo.script.lock", `${LOCK}\n`);
    expect(await codeOf(w)).toBe("lock_changed");
  });

  test("rejects when the lock in the head tree cannot be read", async () => {
    const w = world();
    w.headFailures.add("f/factory/foo.script.lock");
    expect(await codeOf(w)).toBe("head_unreadable");
  });

  test("rejects a lock that equals the head tree but differs from the base tip", async () => {
    const w = world();
    w.base.set("f/factory/foo.script.lock", OTHER_LOCK);
    expect(await codeOf(w)).toBe("lock_changed");
  });

  test("rejects a lock the author edited by hand together with the source", async () => {
    const w = world();
    w.head.set("f/factory/foo.script.lock", OTHER_LOCK);
    w.patch.set("f/factory/foo.script.lock", OTHER_LOCK);
    expect(await codeOf(w)).toBe("lock_changed");
  });

  test("rejects when the base tip has no lock for an existing script", async () => {
    const w = world();
    w.base.delete("f/factory/foo.script.lock");
    expect(await codeOf(w)).toBe("lock_changed");
  });

  test("rejects when the lock in the base tip cannot be read", async () => {
    const w = world();
    w.baseFailures.add("f/factory/foo.script.lock");
    expect(await codeOf(w)).toBe("base_unreadable");
  });

  test("checks the lock of an importer that the manifest does not carry", async () => {
    const w = world();
    addExistingScript(w, "baz", 'import "./foo.ts";\n');
    w.head.set("f/factory/baz.script.lock", OTHER_LOCK);
    expect(await codeOf(w)).toBe("lock_changed");
  });

  test("does not ask a source without a lock for one", async () => {
    const w = world();
    w.head.set("f/factory/x__flow/step.ts", "export const a = 1;\n");
    w.base.set("f/factory/x__flow/step.ts", "export const a = 0;\n");
    w.pr = {
      ...w.pr,
      diff: [
        ...w.pr.diff,
        { path: "f/factory/x__flow/step.ts", status: "modified" },
      ],
    };
    expect(await codeOf(w)).toBe("ok");
  });
});

describe("verifyMetadataPatch refuses a change of dependencies", () => {
  test("rejects a bare import added to a changed script", async () => {
    const w = world();
    w.head.set(
      "f/factory/foo.ts",
      'import { x } from "./lib/bar.ts";\nimport pad from "left-pad@1.4.0";\n',
    );
    expect(await codeOf(w)).toBe("dependency_change_requires_human");
  });

  test("rejects a bare import removed from a changed script", async () => {
    const w = world();
    w.base.set(
      "f/factory/foo.ts",
      'import { x } from "./lib/bar.ts";\nimport pad from "left-pad@1.4.0";\n',
    );
    expect(await codeOf(w)).toBe("dependency_change_requires_human");
  });

  test("rejects another version of the same package", async () => {
    const w = world();
    w.base.set("f/factory/foo.ts", 'import pad from "left-pad@1.3.0";\n');
    w.head.set("f/factory/foo.ts", 'import pad from "left-pad@1.4.0";\n');
    expect(await codeOf(w)).toBe("dependency_change_requires_human");
  });

  test("rejects a bare import that arrives through a changed library", async () => {
    const w = world();
    w.head.set("f/factory/lib/bar.ts", 'import pad from "left-pad@1.4.0";\n');
    expect(await codeOf(w)).toBe("dependency_change_requires_human");
  });

  test("rejects a change in an importer that the manifest does not carry", async () => {
    const w = world();
    addExistingScript(w, "baz", 'import "./foo.ts";\n');
    w.head.set(
      "f/factory/baz.ts",
      'import "./foo.ts";\nimport "evil@1.0.0";\n',
    );
    expect(await codeOf(w)).toBe("dependency_change_requires_human");
  });

  test("rejects an import hidden between quotes in comments", async () => {
    const w = world();
    w.head.set(
      "f/factory/foo.ts",
      '/*\'*/import x from "evil";/*\'*/\nimport { y } from "./lib/bar.ts";\n',
    );
    expect(await codeOf(w)).toBe("dependency_change_requires_human");
  });

  test("accepts an import that only appears in a comment", async () => {
    const w = world();
    w.head.set(
      "f/factory/foo.ts",
      '// import x from "evil";\nimport { y } from "./lib/bar.ts";\n',
    );
    expect(await codeOf(w)).toBe("ok");
  });

  test.each([
    ["a variable", "await import(name);"],
    ["a concatenation", 'await import("./x" + n);'],
    ["a macro attribute", 'import { m } from "./m.ts" with { type: "macro" };'],
  ])(
    "rejects a changed script with an import made of %s",
    async (_label, code) => {
      const w = world();
      w.head.set("f/factory/foo.ts", `${code}\n`);
      expect(await codeOf(w)).toBe("dependency_change_requires_human");
    },
  );

  test("rejects when the source in the base tree cannot be read", async () => {
    const w = world();
    w.baseFailures.add("f/factory/foo.ts");
    expect(await codeOf(w)).toBe("base_unreadable");
  });

  test("rejects when a library in the base tree cannot be read", async () => {
    const w = world();
    w.baseFailures.add("f/factory/lib/bar.ts");
    expect(await codeOf(w)).toBe("base_unreadable");
  });

  test("rejects a script that is not in the base tree and imports a package", async () => {
    const w = world();
    w.base.delete("f/factory/foo.ts");
    w.head.set("f/factory/foo.ts", 'import pad from "left-pad@1.4.0";\n');
    expect(await codeOf(w)).toBe("dependency_change_requires_human");
  });
});

/** PRが新しいscriptを足した状態。lockは空lockで、yamlとハッシュも付ける。 */
function withNewScript(source: string) {
  const w = world();
  w.head.set("f/factory/newone.ts", source);
  w.pr = {
    ...w.pr,
    diff: [{ path: "f/factory/newone.ts", status: "added" }],
  };
  w.patch = new Map<string, string | Uint8Array>([
    ["f/factory/newone.script.lock", EMPTY_LOCK],
    ["f/factory/newone.script.yaml", scriptYaml("newone")],
    [
      "wmill-lock.yaml",
      wmillLock({
        "f/factory/foo": HASH_OLD,
        "f/factory/other": HASH_OLD,
        "f/factory/newone": HASH_NEW,
      }),
    ],
  ]);
  w.statuses.set("f/factory/newone.script.lock", "added");
  w.statuses.set("f/factory/newone.script.yaml", "added");
  return w;
}

describe("verifyMetadataPatch accepts only an empty lock for a new script", () => {
  test("accepts the empty lock of a script without imports", async () => {
    expect(await codeOf(withNewScript("export function main() {}\n"))).toBe(
      "ok",
    );
  });

  test("accepts the empty lock of a script that imports a local file", async () => {
    const w = withNewScript('import { x } from "./lib/bar.ts";\n');
    expect(await codeOf(w)).toBe("ok");
  });

  test("rejects a lock with a dependency", async () => {
    const w = withNewScript("export function main() {}\n");
    w.patch.set("f/factory/newone.script.lock", LOCK);
    expect(await codeOf(w)).toBe("dependency_change_requires_human");
  });

  test("rejects a script that imports a package", async () => {
    const w = withNewScript('import pad from "left-pad@1.3.0";\n');
    expect(await codeOf(w)).toBe("dependency_change_requires_human");
  });

  test("rejects a script that imports a package through a local file", async () => {
    const w = withNewScript('import { x } from "./lib/bar.ts";\n');
    w.head.set("f/factory/lib/bar.ts", 'import pad from "left-pad@1.3.0";\n');
    expect(await codeOf(w)).toBe("dependency_change_requires_human");
  });

  test.each([
    ["a variable", "await import(name);"],
    ["a concatenation", 'await import("./x" + n);'],
    ["a template literal", "await import(`./x`);"],
  ])("rejects a script with an import made of %s", async (_label, code) => {
    expect(await codeOf(withNewScript(`${code}\n`))).toBe(
      "dependency_change_requires_human",
    );
  });

  test("rejects a new lock for a source the PR did not add", async () => {
    const w = withNewScript("export function main() {}\n");
    w.pr = {
      ...w.pr,
      diff: [{ path: "f/factory/foo.ts", status: "modified" }],
    };
    w.head.set("f/factory/newone.ts", 'import "./foo.ts";\n');
    w.head.set("f/factory/foo.ts", 'import "./lib/bar.ts";\n');
    expect(await codeOf(w)).toBe("new_script_without_source");
  });

  test("rejects when the reference empty lock cannot be read", async () => {
    const w = withNewScript("export function main() {}\n");
    w.baseFailures.add(EMPTY_LOCK_PATH);
    expect(await codeOf(w)).toBe("base_unreadable");
  });

  test("rejects when the reference empty lock does not exist", async () => {
    const w = withNewScript("export function main() {}\n");
    w.base.delete(EMPTY_LOCK_PATH);
    expect(await codeOf(w)).toBe("base_unreadable");
  });

  test("compares with the bytes of the reference lock, not a fixed value", async () => {
    const w = withNewScript("export function main() {}\n");
    w.base.set(EMPTY_LOCK_PATH, `${EMPTY_LOCK}\n`);
    expect(await codeOf(w)).toBe("dependency_change_requires_human");
  });
});

describe("verifyMetadataPatch requires the metadata of a new script", () => {
  test("rejects a new script whose yaml is missing", async () => {
    const w = withNewScript("export function main() {}\n");
    w.patch.delete("f/factory/newone.script.yaml");
    expect(await codeOf(w)).toBe("new_script_incomplete");
  });

  test("rejects a new script whose lock is missing", async () => {
    const w = withNewScript("export function main() {}\n");
    w.patch.delete("f/factory/newone.script.lock");
    expect(await codeOf(w)).toBe("new_script_incomplete");
  });

  test("accepts a new script whose metadata is already in the head tree", async () => {
    const w = withNewScript("export function main() {}\n");
    w.patch.delete("f/factory/newone.script.lock");
    w.patch.delete("f/factory/newone.script.yaml");
    w.head.set("f/factory/newone.script.lock", EMPTY_LOCK);
    w.head.set("f/factory/newone.script.yaml", scriptYaml("newone"));
    expect(await codeOf(w)).toBe("ok");
  });

  test("does not ask a flow module for metadata", async () => {
    const w = world();
    w.head.set("f/factory/x__flow/step.ts", "export function main() {}\n");
    w.pr = {
      ...w.pr,
      diff: [
        ...w.pr.diff,
        { path: "f/factory/x__flow/step.ts", status: "added" },
      ],
    };
    expect(await codeOf(w)).toBe("ok");
  });
});

describe("verifyMetadataPatch reads the head tree", () => {
  test("rejects when a file of the head tree cannot be read", async () => {
    const w = world();
    w.headFailures.add("f/factory/foo.script.yaml");
    expect(await codeOf(w)).toBe("head_unreadable");
  });

  test("rejects when a source that decides the closure cannot be read", async () => {
    const w = world();
    addExistingScript(w, "baz", 'import "./foo.ts";\n');
    w.patch.set("f/factory/baz.script.lock", LOCK);
    w.headFailures.add("f/factory/baz.ts");
    expect(await codeOf(w)).toBe("head_unreadable");
  });

  test("rejects when the hash file of the head tree cannot be read", async () => {
    const w = world();
    w.headFailures.add("wmill-lock.yaml");
    expect(await codeOf(w)).toBe("head_unreadable");
  });
});

describe("verifyMetadataPatch cleans the detail", () => {
  const unsafe = ["‮", "​", " ", " ", "\u0085", "\u007f", "﻿", "\n"];

  test.each(unsafe.map((char) => [JSON.stringify(char), char]))(
    "removes %s from the detail",
    async (_label, char) => {
      const w = world();
      w.pr = {
        ...w.pr,
        diff: [
          ...w.pr.diff,
          { path: `scripts/a${char}b.ts`, status: "modified" },
        ],
      };
      const result = await verify(w);
      expect(result.ok ? "" : (result.detail ?? "")).not.toContain(char);
    },
  );

  test("replaces backticks in the detail so a code span cannot be closed", async () => {
    const w = world();
    w.pr = {
      ...w.pr,
      diff: [...w.pr.diff, { path: "scripts/a`b``c.ts", status: "modified" }],
    };
    const result = await verify(w);
    expect(result.ok ? "" : (result.detail ?? "")).toBe(
      "\"scripts/a'b''c.ts\"",
    );
  });

  test("cuts a long detail", async () => {
    const w = world();
    w.pr = {
      ...w.pr,
      diff: [
        ...w.pr.diff,
        { path: `scripts/${"a".repeat(500)}`, status: "modified" },
      ],
    };
    const result = await verify(w);
    expect(result.ok ? 0 : (result.detail ?? "").length).toBeLessThan(200);
  });
});

describe("verifyMetadataPatch surfaces port failures", () => {
  test("does not accept a patch when a port throws", async () => {
    const w = world();
    w.ports = {
      readCommitParents: async () => {
        throw new Error("boom");
      },
    };
    await expect(verify(w)).rejects.toThrow("boom");
  });

  test("does not accept a patch when the base port throws", async () => {
    const w = world();
    w.ports = {
      readBaseFile: async () => {
        throw new Error("base down");
      },
    };
    await expect(verify(w)).rejects.toThrow("base down");
  });
});

describe("verifyMetadataPatch reads the tree of the base tip", () => {
  test("reads the base files at the tip of the base branch", async () => {
    const w = world();
    await verify(w);
    expect([...new Set(w.baseReads)]).toEqual([BASE_TIP]);
  });

  test("never reads the tree of the sha in the manifest", async () => {
    const w = world();
    await verify(w);
    expect(w.baseReads).not.toContain(BASE);
  });
});

describe("verifyMetadataPatch resolves imports as Windmill does", () => {
  const rooted = 'import { x } from "/f/factory/lib/bar.ts";\n';

  test("treats a rooted import as an edge of the closure", async () => {
    const w = world();
    w.head.set("f/factory/foo.ts", rooted);
    w.base.set("f/factory/foo.ts", rooted);
    w.pr = {
      ...w.pr,
      diff: [{ path: "f/factory/lib/bar.ts", status: "modified" }],
    };
    w.patch.delete("f/factory/foo.script.yaml");
    expect(await codeOf(w)).toBe("ok");
  });

  test("follows a rooted import when it compares the dependencies", async () => {
    const w = world();
    w.head.set("f/factory/foo.ts", rooted);
    w.base.set("f/factory/foo.ts", rooted);
    w.head.set("f/factory/lib/bar.ts", 'import pad from "left-pad@1.4.0";\n');
    expect(await codeOf(w)).toBe("dependency_change_requires_human");
  });

  test.each([
    ["a user script", 'import x from "/u/admin/secret";'],
    ["a path outside the tree", 'import x from "/etc/passwd";'],
    ["a file that does not exist", 'import x from "./gone.ts";'],
    [
      "a rooted file that does not exist",
      'import x from "/f/factory/gone.ts";',
    ],
  ])("rejects a changed script that imports %s", async (_label, code) => {
    const w = world();
    w.head.set("f/factory/foo.ts", `${code}\n`);
    w.base.set("f/factory/foo.ts", `${code}\n`);
    expect(await codeOf(w)).toBe("dependency_change_requires_human");
  });

  test("does not read a decoy without an extension", async () => {
    const w = world();
    w.head.set("f/factory/foo.ts", 'import x from "./decoy";\n');
    w.head.set("f/factory/decoy", 'import pad from "left-pad@9.9.9";\n');
    await verify(w);
    expect(w.headReads).not.toContain("f/factory/decoy");
  });

  test("rejects an import that only a decoy could satisfy", async () => {
    const w = world();
    w.head.set("f/factory/foo.ts", 'import x from "./decoy";\n');
    w.base.set("f/factory/foo.ts", 'import x from "./decoy";\n');
    w.head.set("f/factory/decoy", "export const a = 1;\n");
    expect(await codeOf(w)).toBe("dependency_change_requires_human");
  });

  test("resolves the closure and the trace to the same file", async () => {
    const w = world();
    addExistingScript(w, "baz", 'import x from "/f/factory/foo.ts";\n');
    w.patch.set("f/factory/baz.script.lock", LOCK);
    w.head.set(
      "f/factory/foo.ts",
      'import { x } from "../factory/lib/bar.ts";\n',
    );
    w.base.set(
      "f/factory/foo.ts",
      'import { x } from "../factory/lib/bar.ts";\n',
    );
    w.head.set("f/factory/lib/bar.ts", 'import pad from "left-pad@2.0.0";\n');
    expect(await codeOf(w)).toBe("dependency_change_requires_human");
  });
});

describe("verifyMetadataPatch requires no dependency of a new script", () => {
  test("rejects a new script even when the base tip holds the same content", async () => {
    const w = withNewScript('import pad from "left-pad@1.3.0";\n');
    w.base.set("f/factory/newone.ts", 'import pad from "left-pad@1.3.0";\n');
    expect(await codeOf(w)).toBe("dependency_change_requires_human");
  });

  test("accepts a new script without a dependency when the base tip holds the same", async () => {
    const w = withNewScript("export function main() {}\n");
    w.base.set("f/factory/newone.ts", "export function main() {}\n");
    expect(await codeOf(w)).toBe("ok");
  });
});

describe("verifyMetadataPatch checks the reference empty lock", () => {
  test.each([
    ["a lock with a dependency", LOCK],
    ["a lock without the marker", '{"dependencies": {}}'],
    [
      "a lock with another key",
      '{"dependencies": {}, "scripts": {}}\n//bun.lock\n<empty>',
    ],
    ["a lock with a second half", '{"dependencies": {}}\n//bun.lock\n{"a": 1}'],
    ["a lock with a list", "[]\n//bun.lock\n<empty>"],
    ["text that is not JSON", "x\n//bun.lock\n<empty>"],
    [
      "a lock with two markers",
      '{"dependencies": {}}\n//bun.lock\n//bun.lock\n<empty>',
    ],
  ])("rejects %s as the reference", async (_label, content) => {
    const w = withNewScript("export function main() {}\n");
    w.base.set(EMPTY_LOCK_PATH, content);
    w.patch.set("f/factory/newone.script.lock", content);
    expect(await codeOf(w)).toBe("empty_lock_invalid");
  });

  test("accepts a reference with spaces in the first half", async () => {
    const w = withNewScript("export function main() {}\n");
    const content = '{ "dependencies" : { } }\n//bun.lock\n<empty>';
    w.base.set(EMPTY_LOCK_PATH, content);
    w.patch.set("f/factory/newone.script.lock", content);
    expect(await codeOf(w)).toBe("ok");
  });
});

describe("verifyMetadataPatch accepts the hash file in the diff", () => {
  test("accepts a PR that already updated the hash file", async () => {
    const w = world();
    w.pr = {
      ...w.pr,
      diff: [...w.pr.diff, { path: "wmill-lock.yaml", status: "modified" }],
    };
    expect(await codeOf(w)).toBe("ok");
  });

  test("rejects a path below the hash file name", async () => {
    const w = world();
    w.pr = {
      ...w.pr,
      diff: [...w.pr.diff, { path: "wmill-lock.yaml/x", status: "modified" }],
    };
    expect(await codeOf(w)).toBe("pr_diff_not_allowed");
  });

  test("rejects a hash file in another folder", async () => {
    const w = world();
    w.pr = {
      ...w.pr,
      diff: [...w.pr.diff, { path: "sub/wmill-lock.yaml", status: "modified" }],
    };
    expect(await codeOf(w)).toBe("pr_diff_not_allowed");
  });
});

describe("verifyMetadataPatch keeps the work bounded", () => {
  test("rejects a tree with too many sources", async () => {
    const w = world();
    for (let i = 0; i < MAX_SOURCES + 1; i++) {
      w.head.set(`f/gen/s${String(i)}.ts`, "export const a = 1;\n");
    }
    expect(await codeOf(w)).toBe("too_many_sources");
  });

  test("reads and scans each file once for many scripts", async () => {
    const w = world();
    const body = 'import { c } from "./common.ts";\n'.repeat(20);
    w.head.set("f/gen/common.ts", "export const c = 1;\n");
    w.base.set("f/gen/common.ts", "export const c = 0;\n");
    for (let i = 0; i < 300; i++) {
      const path = `f/gen/s${String(i)}.ts`;
      w.head.set(path, body);
      w.base.set(path, body);
    }
    w.pr = {
      ...w.pr,
      diff: [...w.pr.diff, { path: "f/gen/common.ts", status: "modified" }],
    };
    await verify(w);
    const counts = new Map<string, number>();
    for (const path of w.headReads) {
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
    expect(Math.max(...counts.values())).toBe(1);
  });

  test("reads each file of the base tip once for many scripts", async () => {
    const w = world();
    const body = 'import { c } from "./common.ts";\n';
    w.head.set("f/gen/common.ts", "export const c = 1;\n");
    w.base.set("f/gen/common.ts", "export const c = 0;\n");
    for (let i = 0; i < 100; i++) {
      const path = `f/gen/s${String(i)}.ts`;
      w.head.set(path, body);
      w.base.set(path, body);
    }
    w.pr = {
      ...w.pr,
      diff: [...w.pr.diff, { path: "f/gen/common.ts", status: "modified" }],
    };
    await verify(w);
    const counts = new Map<string, number>();
    for (const path of w.basePaths) {
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
    expect(Math.max(...counts.values())).toBe(1);
  });

  test("finishes on many files that are close to the size limit", async () => {
    const w = world();
    const body = 'import { c } from "./common.ts";\n'.repeat(
      Math.floor((MAX_FILE_BYTES - 1000) / 33),
    );
    w.head.set("f/gen/common.ts", "export const c = 1;\n");
    w.base.set("f/gen/common.ts", "export const c = 0;\n");
    for (let i = 0; i < 15; i++) {
      const path = `f/gen/big${String(i)}.ts`;
      w.head.set(path, body);
      w.base.set(path, body);
    }
    w.pr = {
      ...w.pr,
      diff: [...w.pr.diff, { path: "f/gen/common.ts", status: "modified" }],
    };
    const started = performance.now();
    await verify(w);
    expect(performance.now() - started).toBeLessThan(20000);
  });
});

describe("verifyMetadataPatch requires the head to hold the base tip", () => {
  test("rejects a head that lacks the tip of the base branch", async () => {
    const w = world();
    w.isAncestor = (ancestor, descendant) =>
      !(ancestor === BASE_TIP && descendant === HEAD);
    expect(await codeOf(w)).toBe("head_lacks_base");
  });

  test("asks whether the head holds the tip", async () => {
    const w = world();
    const asked: string[] = [];
    w.isAncestor = (ancestor, descendant) => {
      asked.push(`${ancestor}:${descendant}`);
      return true;
    };
    await verify(w);
    expect(asked).toEqual([`${BASE}:${BASE_TIP}`, `${BASE_TIP}:${HEAD}`]);
  });
});
