import { describe, expect, test } from "bun:test";
import { parseWmillLock } from "../../f/factory/lib/metadata_patch_yaml.ts";
import {
  BAR,
  BASE_TIP,
  FOO,
  HEAD,
  outcome,
  plan,
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
