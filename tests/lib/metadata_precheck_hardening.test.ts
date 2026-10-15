// 事前検査が、Windmillの注釈、preprocessor、flow、入力の検証、資源の上限、想定外の失敗で、
// 人の手に回す側に倒れることを確かめる。
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  BlobMismatchError,
  createTreeReader,
  planMetadataRehash,
} from "../../f/factory/lib/metadata_precheck.ts";
import {
  BASE_TIP,
  FOO,
  HEAD,
  outcome,
  plan,
  portsOf,
  SCRIPT_YAML,
  type World,
  world,
} from "./metadata_precheck_world.ts";

async function reasonAfter(change: (w: World) => void): Promise<string> {
  const w = world();
  change(w);
  return outcome(w);
}

describe("planMetadataRehash and Windmill annotations", () => {
  test("sends an added npm annotation to a human", async () => {
    expect(
      await reasonAfter((w) => w.head.set("f/factory/foo.ts", `//npm\n${FOO}`)),
    ).toBe("annotation_changed");
  });

  test("sends an added native annotation to a human", async () => {
    expect(
      await reasonAfter((w) =>
        w.head.set("f/factory/foo.ts", `//native\n${FOO}`),
      ),
    ).toBe("annotation_changed");
  });

  test("sends an added package_json annotation to a human", async () => {
    expect(
      await reasonAfter((w) =>
        w.head.set("f/factory/foo.ts", `// package_json: x\n${FOO}`),
      ),
    ).toBe("annotation_changed");
  });

  test("sends a removed annotation to a human", async () => {
    expect(
      await reasonAfter((w) => {
        w.base.set("f/factory/foo.ts", `//nodejs\n${FOO}`);
        w.head.set("f/factory/foo.ts", FOO);
      }),
    ).toBe("annotation_changed");
  });

  test("accepts a changed ordinary comment", async () => {
    expect(
      await reasonAfter((w) => {
        w.base.set("f/factory/foo.ts", `// first remark\n${FOO}`);
        w.head.set("f/factory/foo.ts", `// second remark\n${FOO}`);
      }),
    ).toBe("ok");
  });

  test("sends an added preprocessor to a human", async () => {
    expect(
      await reasonAfter((w) =>
        w.head.set(
          "f/factory/foo.ts",
          `${FOO}export async function preprocessor(event: string) { return event; }\n`,
        ),
      ),
    ).toBe("preprocessor_changed");
  });
});

describe("planMetadataRehash and flows", () => {
  test("sends a changed flow definition to a human", async () => {
    expect(
      await reasonAfter((w) =>
        w.head.set("f/factory/flow_a__flow/flow.yaml", "summary: changed\n"),
      ),
    ).toBe("flow_changed");
  });

  test("sends a flow with an inline script to a human", async () => {
    expect(
      await reasonAfter((w) => {
        w.base.set("f/factory/flow_a__flow/step.ts", "export const x = 1;\n");
        w.head.set("f/factory/flow_a__flow/step.ts", "export const x = 1;\n");
      }),
    ).toBe("unsupported_script");
  });
});

describe("planMetadataRehash and added or removed files", () => {
  test("sends an added file of an unknown kind to a human", async () => {
    expect(
      await reasonAfter((w) => w.head.set("f/factory/data.bin", "x")),
    ).toBe("script_set_changed");
  });

  test("sends a removed file of an unknown kind to a human", async () => {
    expect(
      await reasonAfter((w) => {
        w.base.set("f/factory/data.bin", "x");
      }),
    ).toBe("script_set_changed");
  });

  test("sends an added trigger definition to a human", async () => {
    expect(
      await reasonAfter((w) =>
        w.head.set("f/factory/hook.http_trigger.yaml", "route_path: x\n"),
      ),
    ).toBe("script_set_changed");
  });

  test("sends an added file with the old trigger suffix to a human", async () => {
    expect(
      await reasonAfter((w) =>
        w.head.set("f/factory/hook.trigger.yaml", "route_path: x\n"),
      ),
    ).toBe("script_set_changed");
  });

  test("accepts an added schedule definition", async () => {
    expect(
      await reasonAfter((w) =>
        w.head.set("f/factory/other.schedule.yaml", "schedule: x\n"),
      ),
    ).toBe("ok");
  });

  test("accepts a removed schedule definition", async () => {
    expect(
      await reasonAfter((w) => w.head.delete("f/factory/job.schedule.yaml")),
    ).toBe("ok");
  });
});

describe("planMetadataRehash and the values from the ports", () => {
  test("refuses a base sha that is not 40 hexadecimal digits", async () => {
    expect(
      await reasonAfter((w) => {
        w.input = { baseSha: "main", headSha: HEAD };
      }),
    ).toBe("invalid_ref");
  });

  test("refuses a head sha in capital letters", async () => {
    expect(
      await reasonAfter((w) => {
        w.input = { baseSha: BASE_TIP, headSha: HEAD.toUpperCase() };
      }),
    ).toBe("invalid_ref");
  });

  test("refuses an object id that is not hexadecimal", async () => {
    expect(
      await reasonAfter((w) =>
        w.headEntryEdits.set("f/factory/foo.ts", { oid: "zz" }),
      ),
    ).toBe("invalid_tree");
  });

  test("refuses a negative size", async () => {
    expect(
      await reasonAfter((w) =>
        w.headEntryEdits.set("docs/readme.md", { size: -1 }),
      ),
    ).toBe("invalid_tree");
  });

  test("refuses a size that is not an integer", async () => {
    expect(
      await reasonAfter((w) =>
        w.headEntryEdits.set("docs/readme.md", { size: 1.5 }),
      ),
    ).toBe("invalid_tree");
  });

  test("refuses a path of the head that holds a replacement character", async () => {
    expect(
      await reasonAfter((w) => w.head.set("f/factory/bad�name.ts", FOO)),
    ).toBe("invalid_tree");
  });

  test("refuses a path of the base that holds a replacement character", async () => {
    expect(
      await reasonAfter((w) => w.base.set("f/factory/bad�name.ts", FOO)),
    ).toBe("invalid_tree");
  });

  test("refuses a tree that lists the same path twice", async () => {
    const w = world();
    const ports = portsOf(w);
    const result = await planMetadataRehash(
      w.input,
      {
        ...ports,
        listTree: async (ref) => {
          const entries = await ports.listTree(ref);
          const first = entries[0];
          return first === undefined || ref !== HEAD
            ? entries
            : [...entries, first];
        },
      },
      w.limits,
      w.selfCheck,
    );
    expect(result.ok ? "ok" : result.reason).toBe("invalid_tree");
  });

  test("accepts a 64 digit object id", async () => {
    expect(
      await reasonAfter((w) =>
        w.headEntryEdits.set("docs/readme.md", { oid: "a".repeat(64) }),
      ),
    ).toBe("ok");
  });

  test("returns a read failure when a listed file is reported as missing", async () => {
    expect(
      await reasonAfter((w) => w.missingReads.add(`${HEAD}:f/factory/foo.ts`)),
    ).toBe("read_failed");
  });

  test("returns a port error when reading a blob throws", async () => {
    expect(
      await reasonAfter((w) => w.throwingReads.add(`${HEAD}:f/factory/foo.ts`)),
    ).toBe("port_error");
  });

  test("returns a port error when the ancestry check throws", async () => {
    expect(
      await reasonAfter((w) => {
        w.throwOnAncestor = true;
      }),
    ).toBe("port_error");
  });

  test("returns an internal error when a port returns a value that breaks the check", async () => {
    expect(
      await reasonAfter((w) => w.brokenReads.add(`${HEAD}:f/factory/foo.ts`)),
    ).toBe("internal_error");
  });

  test("sends a script that is not UTF-8 to a human", async () => {
    expect(
      await reasonAfter((w) =>
        w.head.set("f/factory/foo.ts", new Uint8Array([0xff, 0xfe, 0x00])),
      ),
    ).toBe("dependency_untraceable");
  });

  test("sends metadata that is not UTF-8 to a human", async () => {
    expect(
      await reasonAfter((w) => {
        const broken = new Uint8Array([0xff, 0xfe, 0x00]);
        w.base.set("f/factory/foo.script.yaml", broken);
        w.head.set("f/factory/foo.script.yaml", broken);
      }),
    ).toBe("not_text");
  });
});

describe("planMetadataRehash and the stale keys of the lock", () => {
  const stale = `  f/factory/ghost: ${"9".repeat(64)}\n`;

  function withStaleKey(w: World) {
    for (const files of [w.base, w.head]) {
      files.set(
        "wmill-lock.yaml",
        `${String(files.get("wmill-lock.yaml"))}${stale}`,
      );
    }
  }

  test("keeps a stale key that has no file in the head", async () => {
    expect(await reasonAfter(withStaleKey)).toBe("ok");
  });

  test("sends a stale key to a human when a file of that name exists in the head", async () => {
    expect(
      await reasonAfter((w) => {
        withStaleKey(w);
        w.base.set("f/factory/ghost.md", "x");
        w.head.set("f/factory/ghost.md", "x");
      }),
    ).toBe("lock_key_set_mismatch");
  });
});

describe("planMetadataRehash and the limits on the input", () => {
  /** 1ファイルがほぼ1MiBの、同じ内容の`.ts`をheadとbaseに足す。木の大きさは小さく申告させる。 */
  function addLargeScripts(w: World, count: number) {
    const body = `// ${"x".repeat(1_000_000)}\n`;
    for (let index = 0; index < count; index += 1) {
      const path = `f/factory/lib/large_${index}.ts`;
      w.base.set(path, body);
      w.head.set(path, body);
      w.headSizes.set(path, 1);
      w.baseSizes.set(path, 1);
    }
  }

  test("sends a tree whose declared sizes exceed the limit to a human before reading", async () => {
    const w = world();
    for (let index = 0; index < 70; index += 1) {
      w.headSizes.set(`f/factory/lib/declared_${index}.ts`, 1024 * 1024);
      w.head.set(`f/factory/lib/declared_${index}.ts`, "x");
    }
    expect(await outcome(w)).toBe("too_much_input");
  });

  test("reads no blob when the declared sizes exceed the limit", async () => {
    const w = world();
    for (let index = 0; index < 70; index += 1) {
      w.headSizes.set(`f/factory/lib/declared_${index}.ts`, 1024 * 1024);
      w.head.set(`f/factory/lib/declared_${index}.ts`, "x");
    }
    await outcome(w);
    expect(w.readCount).toBe(0);
  });

  test("stops reading once the bytes actually read exceed the limit", async () => {
    const w = world();
    addLargeScripts(w, 70);
    expect(await outcome(w)).toBe("too_much_input");
  });

  test("stays within the limit while reading many large files", async () => {
    const w = world();
    addLargeScripts(w, 70);
    await outcome(w);
    expect(w.readCount).toBeLessThan(200);
  });

  test("sends a closure that needs more visits than the budget to a human", async () => {
    expect(
      await reasonAfter((w) => {
        w.limits = { maxTraceVisits: 1 };
      }),
    ).toBe("too_much_input");
  });

  test("accepts the same change within the default limits", async () => {
    expect(await reasonAfter(() => undefined)).toBe("ok");
  });

  test("sends a tree with too many bytes to a human when the limit is lowered", async () => {
    expect(
      await reasonAfter((w) => {
        w.limits = { maxReadBytes: 10 };
      }),
    ).toBe("too_much_input");
  });
});

describe("planMetadataRehash and the imports that remain at run time", () => {
  /** `dep.ts`は、裸のimportを持つlib。`foo.ts`が`dep.ts`をどうimportするかを、baseとheadで変える。 */
  function withDependency(w: World, base: string, head: string) {
    for (const files of [w.base, w.head]) {
      files.set(
        "f/factory/lib/dep.ts",
        'import "left-pad@1.3.0";\nexport type T = string;\nexport const v = 1;\n',
      );
      files.set("f/factory/lib/dep.script.yaml", SCRIPT_YAML);
    }
    w.base.set("f/factory/foo.ts", base);
    w.head.set("f/factory/foo.ts", head);
  }

  const TYPE_ONLY =
    'import type { T } from "./lib/dep.ts";\nexport async function main(a: T) {\n  return a;\n}\n';
  const VALUE_USED =
    'import { T, v } from "./lib/dep.ts";\nexport async function main(a: T) {\n  return v;\n}\n';

  test("sends an import type that becomes a value import used in the body to a human", async () => {
    expect(
      await reasonAfter((w) => withDependency(w, TYPE_ONLY, VALUE_USED)),
    ).toBe("dependency_changed");
  });

  test("accepts a change that keeps the import type", async () => {
    expect(
      await reasonAfter((w) =>
        withDependency(
          w,
          TYPE_ONLY,
          TYPE_ONLY.replace("return a", "return a + a"),
        ),
      ),
    ).toBe("ok");
  });

  test("accepts a value import that is used only in a type position", async () => {
    const typeOnlyUse =
      'import { T } from "./lib/dep.ts";\nexport async function main(a: T) {\n  return a;\n}\n';
    expect(
      await reasonAfter((w) =>
        withDependency(
          w,
          typeOnlyUse,
          typeOnlyUse.replace("return a", "return a + a"),
        ),
      ),
    ).toBe("ok");
  });

  test("accepts dropping the type modifier when the import is still not used as a value", async () => {
    const withoutModifier = TYPE_ONLY.replace("import type", "import");
    expect(
      await reasonAfter((w) => withDependency(w, TYPE_ONLY, withoutModifier)),
    ).toBe("ok");
  });

  test("sends a value import used only in a type position that starts to be used as a value to a human", async () => {
    const typeOnlyUse =
      'import { T, v } from "./lib/dep.ts";\nexport async function main(a: T) {\n  return a;\n}\n';
    expect(
      await reasonAfter((w) => withDependency(w, typeOnlyUse, VALUE_USED)),
    ).toBe("dependency_changed");
  });
});

describe("planMetadataRehash and the metadata of the base tip", () => {
  function staleHash(text: string, key: string): string {
    return text
      .split("\n")
      .map((line) =>
        line.startsWith(`  ${key}:`) ? `  ${key}: ${"0".repeat(64)}` : line,
      )
      .join("\n");
  }

  test("sends a base tip whose lock has an old hash to a human", async () => {
    expect(
      await reasonAfter((w) => {
        w.settle = false;
        w.base.set(
          "wmill-lock.yaml",
          staleHash(String(w.base.get("wmill-lock.yaml")), "f/factory/foo"),
        );
      }),
    ).toBe("base_stale");
  });

  test("sends a base tip whose script changed after its hash was made to a human", async () => {
    expect(
      await reasonAfter((w) => {
        w.settle = false;
        for (const files of [w.base, w.head]) {
          files.set("f/factory/foo.ts", `${FOO}// remark about foo\n`);
        }
      }),
    ).toBe("base_stale");
  });

  test("sends a base tip whose script.yaml changed after its hash was made to a human", async () => {
    expect(
      await reasonAfter((w) => {
        w.settle = false;
        for (const files of [w.base, w.head]) {
          files.set("f/factory/foo.script.yaml", `${SCRIPT_YAML}# edited\n`);
        }
      }),
    ).toBe("base_stale");
  });

  test("sends a base tip that lacks the hash of a script to a human", async () => {
    expect(
      await reasonAfter((w) => {
        w.settle = false;
        const text = String(w.base.get("wmill-lock.yaml"))
          .split("\n")
          .filter((line) => !line.startsWith("  f/factory/lib/bar:"))
          .join("\n");
        w.base.set("wmill-lock.yaml", text);
        w.head.set("wmill-lock.yaml", text);
      }),
    ).toBe("base_stale");
  });

  test("accepts the base tip when its lock was settled", async () => {
    expect(await reasonAfter(() => undefined)).toBe("ok");
  });

  test("repairs a hash of a script that the pull request did not change when the lock was resolved wrongly", async () => {
    expect(
      await reasonAfter((w) => {
        w.head.set(
          "wmill-lock.yaml",
          staleHash(String(w.head.get("wmill-lock.yaml")), "f/factory/foo"),
        );
      }),
    ).toBe("ok");
  });

  test("restores the hash of the base tip for that script", async () => {
    const w = world();
    w.head.set(
      "wmill-lock.yaml",
      staleHash(String(w.head.get("wmill-lock.yaml")), "f/factory/foo"),
    );
    const result = await plan(w);
    expect(result.ok && result.changedKeys).toContain("f/factory/foo");
  });

  test("limits the changed keys to the scripts the pull request changed", async () => {
    const w = world();
    w.head.set("f/factory/foo.ts", FOO.replace("String(x)", "String(x + 1)"));
    const result = await plan(w);
    expect(result.ok && result.changedKeys).toEqual([
      "f/factory/foo",
      "f/factory/lib/bar",
    ]);
  });
});

describe("planMetadataRehash and the limits", () => {
  test.each([
    ["NaN", Number.NaN],
    ["zero", 0],
    ["a negative number", -1],
    ["a fraction", 1.5],
    ["infinity", Number.POSITIVE_INFINITY],
  ])("refuses a read limit that is %s", async (_name, value) => {
    expect(
      await reasonAfter((w) => {
        w.limits = { maxReadBytes: value };
      }),
    ).toBe("invalid_limit");
  });

  test("refuses a visit limit that is NaN", async () => {
    expect(
      await reasonAfter((w) => {
        w.limits = { maxTraceVisits: Number.NaN };
      }),
    ).toBe("invalid_limit");
  });

  test("accepts limits that are positive safe integers", async () => {
    expect(
      await reasonAfter((w) => {
        w.limits = { maxReadBytes: 1_000_000, maxTraceVisits: 10_000 };
      }),
    ).toBe("ok");
  });
});

describe("planMetadataRehash and the self check of the reading", () => {
  test("stops when the self check of the reading fails", async () => {
    expect(
      await reasonAfter((w) => {
        w.selfCheck = () => false;
      }),
    ).toBe("internal_error");
  });

  test("leaves the version of Bun in the detail of the failure", async () => {
    const w = world();
    w.selfCheck = () => false;
    const result = await plan(w);
    expect(!result.ok && result.detail).toContain(Bun.version);
  });

  test("runs the real self check by default", async () => {
    expect(await reasonAfter(() => undefined)).toBe("ok");
  });
});

describe("planMetadataRehash and the shape of what readBlob returns", () => {
  test("returns a port error when the kind is not one of the three", async () => {
    expect(
      await reasonAfter((w) =>
        w.malformedReads.set(`${HEAD}:f/factory/foo.ts`, '{"kind":"odd"}'),
      ),
    ).toBe("port_error");
  });

  test("returns a port error when the content of a found file is a string", async () => {
    expect(
      await reasonAfter((w) =>
        w.malformedReads.set(
          `${HEAD}:f/factory/foo.ts`,
          '{"kind":"found","content":"text"}',
        ),
      ),
    ).toBe("port_error");
  });

  test("returns a port error when the result is null", async () => {
    expect(
      await reasonAfter((w) =>
        w.malformedReads.set(`${HEAD}:f/factory/foo.ts`, "null"),
      ),
    ).toBe("port_error");
  });

  test("refuses a found file at a path that is not in the tree", async () => {
    const read = createTreeReader(
      HEAD,
      new Map(),
      async () => ({ kind: "found", content: new Uint8Array([1]) }),
      1000,
    );
    await expect(read("f/factory/phantom.ts")).rejects.toBeInstanceOf(
      BlobMismatchError,
    );
  });

  test("returns missing for a path that is not in the tree and not found", async () => {
    const read = createTreeReader(
      HEAD,
      new Map(),
      async () => ({ kind: "missing" }),
      1000,
    );
    expect(await read("f/factory/phantom.ts")).toEqual({ kind: "missing" });
  });
});

describe("planMetadataRehash and the content of a blob", () => {
  test("refuses a blob whose content does not match the object id of the tree", async () => {
    expect(
      await reasonAfter((w) =>
        w.headEntryEdits.set("f/factory/foo.ts", { oid: "1".repeat(40) }),
      ),
    ).toBe("blob_mismatch");
  });

  test("refuses a blob that does not match when the object id has 64 digits", async () => {
    expect(
      await reasonAfter((w) => {
        w.sha256Oids = true;
        w.headEntryEdits.set("f/factory/foo.ts", { oid: "1".repeat(64) });
      }),
    ).toBe("blob_mismatch");
  });

  test("accepts a tree of a repository whose object ids have 64 digits", async () => {
    expect(
      await reasonAfter((w) => {
        w.sha256Oids = true;
      }),
    ).toBe("ok");
  });

  test("does not accept the hash of the bare content as the object id", async () => {
    expect(
      await reasonAfter((w) =>
        w.headEntryEdits.set("f/factory/foo.ts", {
          oid: createHash("sha1").update(FOO).digest("hex"),
        }),
      ),
    ).toBe("blob_mismatch");
  });
});
