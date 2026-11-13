import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parseWmillLock } from "../../f/factory/lib/metadata_patch_yaml.ts";
import {
  BlobMismatchError,
  createTreeReader,
  planMetadataRehash,
} from "../../f/factory/lib/metadata_precheck.ts";
import {
  BAR,
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

/** 事前検査が人の手に回す理由を返す。通れば`ok`。 */
async function reasonAfter(change: (w: World) => void): Promise<string> {
  const w = world();
  change(w);
  return outcome(w);
}

describe("planMetadataRehash when the pull request only changes a library", () => {
  test("accepts the change", async () => {
    expect(await outcome(world())).toBe("ok");
  });

  test("recomputes only the hash of the changed library", async () => {
    const result = await plan(world());
    expect(result.ok && result.changedKeys).toEqual(["f/factory/lib/bar"]);
  });

  test("returns a lock that parseWmillLock still reads", async () => {
    const result = await plan(world());
    expect(result.ok && parseWmillLock(result.newLock).ok).toBe(true);
  });

  test("changes exactly one line of the lock", async () => {
    const w = world();
    const result = await plan(w);
    const oldLines = String(w.head.get("wmill-lock.yaml")).split("\n");
    const changed = result.ok
      ? result.newLock.split("\n").filter((line, i) => line !== oldLines[i])
      : [];
    expect(changed.length).toBe(1);
  });

  test("reads the objects of the base tip and the head only", async () => {
    const w = world();
    await plan(w);
    expect([...w.readRefs].sort()).toEqual([BASE_TIP, HEAD].sort());
  });

  test("accepts a change to the body of main", async () => {
    expect(
      await reasonAfter((w) =>
        w.head.set(
          "f/factory/foo.ts",
          FOO.replace("String(x)", "String(x + 1)"),
        ),
      ),
    ).toBe("ok");
  });

  test("recomputes the script that changed together with the library", async () => {
    const w = world();
    w.head.set("f/factory/foo.ts", FOO.replace("String(x)", "String(x + 1)"));
    const result = await plan(w);
    expect(result.ok && result.changedKeys).toEqual([
      "f/factory/foo",
      "f/factory/lib/bar",
    ]);
  });

  test("accepts a head identical to the base tip and leaves the lock as it is", async () => {
    const w = world();
    w.head = new Map(w.base);
    const result = await plan(w);
    expect(result.ok && result.newLock).toBe(
      String(w.base.get("wmill-lock.yaml")),
    );
  });

  test("keeps a stale entry whose file is already gone at the base tip", async () => {
    const w = world();
    const stale = `  f/factory/_gone: ${"9".repeat(64)}\n`;
    const text = String(w.base.get("wmill-lock.yaml"));
    w.base.set("wmill-lock.yaml", `${text}${stale}`);
    w.head.set("wmill-lock.yaml", `${text}${stale}`);
    expect(await outcome(w)).toBe("ok");
  });

  test("accepts a change to a schedule definition", async () => {
    expect(
      await reasonAfter((w) =>
        w.head.set("f/factory/job.schedule.yaml", "schedule: '0 1 * * * *'\n"),
      ),
    ).toBe("ok");
  });

  test("accepts a change outside f/", async () => {
    expect(
      await reasonAfter((w) => w.head.set("docs/readme.md", "# changed\n")),
    ).toBe("ok");
  });
});

describe("planMetadataRehash sends the pull request to a human when", () => {
  test("wmill.yaml differs from the base tip", async () => {
    expect(
      await reasonAfter((w) => w.head.set("wmill.yaml", "defaultTs: deno\n")),
    ).toBe("wmill_yaml_changed");
  });

  test("wmill.yaml is missing in the head", async () => {
    expect(await reasonAfter((w) => w.head.delete("wmill.yaml"))).toBe(
      "wmill_yaml_changed",
    );
  });

  test("the head has workspace dependencies", async () => {
    expect(
      await reasonAfter((w) => w.head.set("dependencies/package.json", "{}")),
    ).toBe("workspace_dependencies");
  });

  test("the head does not contain the tip of the base", async () => {
    expect(
      await reasonAfter((w) => {
        w.ancestor = false;
      }),
    ).toBe("head_lacks_base");
  });

  test("the ancestry cannot be decided", async () => {
    expect(
      await reasonAfter((w) => {
        w.ancestor = null;
      }),
    ).toBe("ancestry_unknown");
  });

  test("the pull request changes a script.lock", async () => {
    expect(
      await reasonAfter((w) =>
        w.head.set("f/factory/foo.script.lock", "{}\n//bun.lock\n<changed>"),
      ),
    ).toBe("lock_file_changed");
  });

  test("the pull request changes a lock of a flow", async () => {
    expect(
      await reasonAfter((w) =>
        w.head.set("f/factory/flow_a__flow/flow.lock", "{ }"),
      ),
    ).toBe("lock_file_changed");
  });

  test("the pull request changes a script.yaml", async () => {
    expect(
      await reasonAfter((w) =>
        w.head.set("f/factory/foo.script.yaml", `${SCRIPT_YAML}# changed\n`),
      ),
    ).toBe("script_yaml_changed");
  });

  test("a bare import is added to a changed script", async () => {
    expect(
      await reasonAfter((w) =>
        w.head.set("f/factory/foo.ts", `import "lodash@4.17.21";\n${FOO}`),
      ),
    ).toBe("dependency_changed");
  });

  test("the version of a bare import changes", async () => {
    expect(
      await reasonAfter((w) =>
        w.head.set(
          "f/factory/foo.ts",
          FOO.replace("windmill-client@1.817.0", "windmill-client@1.818.0"),
        ),
      ),
    ).toBe("dependency_changed");
  });

  test("a library gains a bare import that its importer then reads", async () => {
    expect(
      await reasonAfter((w) =>
        w.head.set("f/factory/lib/bar.ts", `import "lodash@4.17.21";\n${BAR}`),
      ),
    ).toBe("dependency_changed");
  });

  test("a script that the pull request does not touch has an import that cannot be traced", async () => {
    expect(
      await reasonAfter((w) => {
        const other =
          "export async function main(n: string) { await import(n); }\n";
        for (const files of [w.base, w.head]) {
          files.set("f/factory/other.ts", other);
          files.set("f/factory/other.script.yaml", SCRIPT_YAML);
        }
      }),
    ).toBe("dependency_untraceable");
  });

  test("a local import resolves to no file", async () => {
    expect(
      await reasonAfter((w) =>
        w.head.set("f/factory/foo.ts", `import "./lib/missing.ts";\n${FOO}`),
      ),
    ).toBe("dependency_untraceable");
  });

  test("a parameter of main changes", async () => {
    expect(
      await reasonAfter((w) =>
        w.head.set(
          "f/factory/foo.ts",
          FOO.replace("(input: Input)", "(input: Input, extra = 1)"),
        ),
      ),
    ).toBe("main_changed");
  });

  test("the return type of main changes", async () => {
    expect(
      await reasonAfter((w) =>
        w.head.set(
          "f/factory/foo.ts",
          FOO.replace("Promise<string>", "Promise<number>"),
        ),
      ),
    ).toBe("main_changed");
  });

  test("a type declared in the script changes", async () => {
    expect(
      await reasonAfter((w) =>
        w.head.set("f/factory/foo.ts", FOO.replace("a: string", "a: number")),
      ),
    ).toBe("declaration_changed");
  });

  test("main is removed from a changed script", async () => {
    expect(
      await reasonAfter((w) =>
        w.head.set(
          "f/factory/foo.ts",
          FOO.replace("export async function main", "async function run"),
        ),
      ),
    ).toBe("main_presence_changed");
  });

  test("main appears in a changed library", async () => {
    expect(
      await reasonAfter((w) =>
        w.head.set("f/factory/lib/bar.ts", `${BAR}export function main() {}\n`),
      ),
    ).toBe("main_presence_changed");
  });

  test("a changed script has a slash whose meaning cannot be decided", async () => {
    expect(
      await reasonAfter((w) =>
        w.head.set("f/factory/foo.ts", `${FOO}const half = {} / 2;\n`),
      ),
    ).toBe("main_unparsable");
  });

  test("the pull request adds a script", async () => {
    expect(
      await reasonAfter((w) => {
        w.head.set("f/factory/new.ts", "export function main() {}\n");
        w.head.set("f/factory/new.script.yaml", SCRIPT_YAML);
      }),
    ).toBe("script_set_changed");
  });

  test("the pull request deletes a script", async () => {
    expect(
      await reasonAfter((w) => {
        w.head.delete("f/factory/lib/bar.ts");
        w.head.delete("f/factory/lib/bar.script.yaml");
      }),
    ).toBe("script_set_changed");
  });

  test("the pull request renames a script", async () => {
    expect(
      await reasonAfter((w) => {
        w.head.delete("f/factory/lib/bar.ts");
        w.head.set("f/factory/lib/baz.ts", BAR);
      }),
    ).toBe("script_set_changed");
  });

  test("the pull request adds a file to a flow folder", async () => {
    expect(
      await reasonAfter((w) =>
        w.head.set("f/factory/flow_a__flow/step.ts", "x"),
      ),
    ).toBe("script_set_changed");
  });

  test("the pull request changes a script that is not in TypeScript", async () => {
    expect(
      await reasonAfter((w) => {
        w.base.set("f/factory/p.py", "x = 1\n");
        w.base.set("f/factory/p.script.yaml", SCRIPT_YAML);
        w.head.set("f/factory/p.py", "x = 2\n");
        w.head.set("f/factory/p.script.yaml", SCRIPT_YAML);
      }),
    ).toBe("unsupported_script");
  });

  test("a file in f/ is a symbolic link", async () => {
    expect(
      await reasonAfter((w) =>
        w.headModes.set("f/factory/lib/bar.ts", "120000"),
      ),
    ).toBe("special_file");
  });

  test("a file in f/ is a submodule", async () => {
    expect(
      await reasonAfter((w) => w.headModes.set("f/factory/foo.ts", "160000")),
    ).toBe("special_file");
  });

  test("wmill.yaml is a symbolic link", async () => {
    expect(
      await reasonAfter((w) => w.headModes.set("wmill.yaml", "120000")),
    ).toBe("special_file");
  });

  test("a symbolic link in the base tip is not read as a file", async () => {
    expect(
      await reasonAfter((w) => w.baseModes.set("f/factory/foo.ts", "120000")),
    ).toBe("special_file");
  });

  test("f/ has more files than the limit", async () => {
    expect(
      await reasonAfter((w) => {
        for (let index = 0; index <= 5000; index += 1) {
          w.head.set(`f/factory/data/file_${index}.txt`, "x");
          w.base.set(`f/factory/data/file_${index}.txt`, "x");
        }
      }),
    ).toBe("too_many_files");
  });

  test("a file in f/ is larger than the limit", async () => {
    expect(
      await reasonAfter((w) =>
        w.headSizes.set("f/factory/foo.ts", 1024 * 1024 + 1),
      ),
    ).toBe("file_too_large");
  });

  test("a file cannot be read", async () => {
    expect(
      await reasonAfter((w) => w.failedReads.add(`${HEAD}:f/factory/foo.ts`)),
    ).toBe("read_failed");
  });

  test("a port throws", async () => {
    expect(
      await reasonAfter((w) => {
        w.throwOnList = true;
      }),
    ).toBe("port_error");
  });

  test("the lock of the head lacks the key of a script", async () => {
    expect(
      await reasonAfter((w) => {
        const text = String(w.head.get("wmill-lock.yaml"));
        w.head.set(
          "wmill-lock.yaml",
          text
            .split("\n")
            .filter((line) => !line.startsWith("  f/factory/foo:"))
            .join("\n"),
        );
      }),
    ).toBe("lock_key_set_mismatch");
  });

  test("the lock of the head has a key that the base tip did not have", async () => {
    expect(
      await reasonAfter((w) => {
        const text = String(w.head.get("wmill-lock.yaml"));
        w.head.set(
          "wmill-lock.yaml",
          `${text}  f/factory/extra: ${"9".repeat(64)}\n`,
        );
      }),
    ).toBe("lock_key_set_mismatch");
  });

  test("the lock of the head is not in the form wmill writes", async () => {
    expect(
      await reasonAfter((w) =>
        w.head.set("wmill-lock.yaml", "version: v2\nlocks: {}\n"),
      ),
    ).toBe("wmill_lock_invalid");
  });

  test("a script is in a language whose hash is not copied", async () => {
    expect(
      await reasonAfter((w) => {
        w.base.set("f/factory/q.sql", "select 1");
        w.head.set("f/factory/q.sql", "select 1");
      }),
    ).toBe("unsupported_script");
  });
});

// 事前検査が、Windmillの注釈、preprocessor、flow、入力の検証、資源の上限、想定外の失敗で、
// 人の手に回す側に倒れることを確かめる。
describe("metadata_precheck hardening", () => {
  async function reasonAfter(change: (w: World) => void): Promise<string> {
    const w = world();
    change(w);
    return outcome(w);
  }

  describe("planMetadataRehash and Windmill annotations", () => {
    test("sends an added npm annotation to a human", async () => {
      expect(
        await reasonAfter((w) =>
          w.head.set("f/factory/foo.ts", `//npm\n${FOO}`),
        ),
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
        await reasonAfter((w) =>
          w.missingReads.add(`${HEAD}:f/factory/foo.ts`),
        ),
      ).toBe("read_failed");
    });

    test("returns a port error when reading a blob throws", async () => {
      expect(
        await reasonAfter((w) =>
          w.throwingReads.add(`${HEAD}:f/factory/foo.ts`),
        ),
      ).toBe("port_error");
    });

    test("returns an unreadable tree when the listing of a tree cannot be read", async () => {
      expect(
        await reasonAfter((w) => {
          w.unreadableTree = true;
        }),
      ).toBe("tree_unreadable");
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

    test("leaves the kind of the error in the detail of an internal error", async () => {
      const w = world();
      w.brokenReads.add(`${HEAD}:f/factory/foo.ts`);
      const result = await plan(w);
      expect(!result.ok && result.detail).toBe("Error");
    });

    test("keeps a standard error name in the detail of an internal error", async () => {
      const w = world();
      w.brokenReads.add(`${HEAD}:f/factory/foo.ts`);
      w.brokenError = new TypeError("secret path f/x");
      const result = await plan(w);
      expect(!result.ok && result.detail).toBe("TypeError");
    });

    test("replaces a custom error name with Error in the detail of an internal error", async () => {
      const w = world();
      w.brokenReads.add(`${HEAD}:f/factory/foo.ts`);
      const custom = new Error("secret path f/x");
      custom.name = "SecretPathError";
      w.brokenError = custom;
      const result = await plan(w);
      expect(!result.ok && result.detail).toBe("Error");
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
      ).toBe("scan_unavailable");
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
});
