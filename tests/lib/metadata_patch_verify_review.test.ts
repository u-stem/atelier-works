import { describe, expect, test } from "bun:test";
import {
  addExistingScript,
  BASE,
  codeOf,
  EMPTY_LOCK,
  EMPTY_LOCK_PATH,
  HASH_NEW,
  HASH_OLD,
  LOCK,
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
  test("rejects a lock that differs from the base tree", async () => {
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

  test("rejects when the lock in the base tree cannot be read", async () => {
    const w = world();
    w.baseFailures.add("f/factory/foo.script.lock");
    expect(await codeOf(w)).toBe("base_unreadable");
  });

  test("accepts a lock that equals the base tree even if head differs", async () => {
    const w = world();
    expect(w.head.get("f/factory/foo.script.lock")).not.toBe(LOCK);
    expect(await codeOf(w)).toBe("ok");
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

describe("verifyMetadataPatch reads the tree of the base sha", () => {
  test("reads the base files at the sha of the manifest", async () => {
    const w = world();
    await verify(w);
    expect([...new Set(w.baseReads)]).toEqual([BASE]);
  });
});
