import { describe, expect, test } from "bun:test";
import { MAX_FILE_BYTES } from "../../f/factory/lib/metadata_patch_manifest.ts";
import { buildLock } from "./metadata_patch_fixtures.ts";
import {
  codeOf,
  HASH_NEW,
  HASH_OLD,
  OLD_LOCK,
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

describe("verifyMetadataPatch ties the lock to the imports", () => {
  test("rejects a new package when the imports did not change", async () => {
    const w = world();
    w.head.set("f/factory/foo.ts", 'import pad from "left-pad@1.3.0";\n');
    w.patch.set(
      "f/factory/foo.script.lock",
      buildLock({
        deps: { "left-pad": "1.3.0", "is-odd": "1.0.0" },
        packages: {
          "left-pad": { ident: "left-pad@1.3.0" },
          "is-odd": { ident: "is-odd@1.0.0" },
        },
      }),
    );
    expect(await codeOf(w)).toBe("lock_changed_without_import_change");
  });

  test("rejects a raised version when the imports did not change", async () => {
    const w = world();
    w.head.set("f/factory/foo.ts", 'import pad from "left-pad@1.3.0";\n');
    expect(await codeOf(w)).toBe("lock_changed_without_import_change");
  });

  test("accepts the lock of main when the imports did not change", async () => {
    const w = world();
    w.head.set("f/factory/foo.ts", 'import pad from "left-pad@1.3.0";\n');
    w.patch.set("f/factory/foo.script.lock", OLD_LOCK);
    expect(await codeOf(w)).toBe("ok");
  });

  test("follows the imports of the files that the script imports", async () => {
    const w = world();
    w.head.set("f/factory/foo.ts", 'import { x } from "./lib/bar.ts";\n');
    w.base.set("f/factory/foo.ts", 'import { x } from "./lib/bar.ts";\n');
    w.head.set("f/factory/lib/bar.ts", 'import pad from "left-pad@1.4.0";\n');
    expect(await codeOf(w)).toBe("ok");
  });

  test("rejects a lock for a script that has no imports in main", async () => {
    const w = world();
    w.head.set("f/factory/foo.ts", "export const a = 1;\n");
    w.base.set("f/factory/foo.ts", "export const a = 1;\n");
    expect(await codeOf(w)).toBe("lock_changed_without_import_change");
  });

  test("rejects an import that is a variable in the script", async () => {
    const w = world();
    w.head.set("f/factory/foo.ts", "await import(name);\n");
    expect(await codeOf(w)).toBe("untraceable_import");
  });

  test("rejects an import that is a template literal in an imported file", async () => {
    const w = world();
    w.head.set("f/factory/lib/bar.ts", "await import(`./\x24{x}.ts`);\n");
    w.head.set(
      "f/factory/foo.ts",
      'import { x } from "./lib/bar.ts";\nimport pad from "left-pad@1.4.0";\n',
    );
    expect(await codeOf(w)).toBe("untraceable_import");
  });

  test("rejects a require with a variable in main", async () => {
    const w = world();
    w.base.set("f/factory/foo.ts", "const m = require(name);\n");
    expect(await codeOf(w)).toBe("untraceable_import");
  });

  test("rejects a script larger than the file limit", async () => {
    const w = world();
    w.head.set("f/factory/foo.ts", " ".repeat(MAX_FILE_BYTES + 1));
    expect(await codeOf(w)).toBe("untraceable_import");
  });

  test("finishes on a script made of repeated import keywords", async () => {
    const w = world();
    w.head.set("f/factory/foo.ts", "import ".repeat(MAX_FILE_BYTES / 7));
    const started = performance.now();
    await verify(w);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test("rejects when the source in main cannot be read", async () => {
    const w = world();
    w.baseFailures.add("f/factory/foo.ts");
    expect(await codeOf(w)).toBe("base_unreadable");
  });

  test("rejects when the lock in main cannot be read", async () => {
    const w = world();
    w.baseFailures.add("f/factory/foo.script.lock");
    expect(await codeOf(w)).toBe("base_unreadable");
  });
});

describe("verifyMetadataPatch checks the registry answer", () => {
  test.each([
    ["not a number", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["negative", -1],
  ])("rejects an age that is %s", async (_label, age) => {
    const w = world();
    w.age = () => age;
    expect(await codeOf(w)).toBe("registry_unavailable");
  });

  test("rejects an age of zero days against a one day minimum", async () => {
    const w = world();
    w.config = { ...w.config, minPublishedDays: 1 };
    w.age = () => 0;
    expect(await codeOf(w)).toBe("version_too_new");
  });

  test.each([[0], [-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    "rejects a minimum of %s days",
    async (days) => {
      const w = world();
      w.config = { ...w.config, minPublishedDays: days };
      expect(await codeOf(w)).toBe("invalid_config");
    },
  );
});

describe("verifyMetadataPatch rejects lowered versions", () => {
  test("rejects a version lower than the one in main", async () => {
    const w = world();
    w.patch.set(
      "f/factory/foo.script.lock",
      buildLock({
        deps: { "left-pad": "1.2.0" },
        packages: { "left-pad": { ident: "left-pad@1.2.0" } },
      }),
    );
    expect(await codeOf(w)).toBe("version_downgrade");
  });
});

describe("verifyMetadataPatch checks that the diff is whole", () => {
  test("rejects a diff that GitHub cut short", async () => {
    const w = world();
    w.pr = { ...w.pr, diffTruncated: true };
    expect(await codeOf(w)).toBe("pr_diff_incomplete");
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

  test("does not accept a patch when the registry port throws", async () => {
    const w = world();
    w.ports = {
      publishedAgeDays: async () => {
        throw new Error("registry down");
      },
    };
    await expect(verify(w)).rejects.toThrow("registry down");
  });
});

describe("verifyMetadataPatch limits the lock hashes", () => {
  test("rejects a hash for a script whose source is protected", async () => {
    const w = world();
    w.head.set("f/factory/steps/dependabot_assess.ts", "export const a = 1;\n");
    w.pr = {
      ...w.pr,
      diff: [
        ...w.pr.diff,
        { path: "f/factory/steps/dependabot_assess.ts", status: "modified" },
      ],
    };
    w.head.set(
      "wmill-lock.yaml",
      wmillLock({
        "f/factory/foo": HASH_OLD,
        "f/factory/other": HASH_OLD,
        "f/factory/steps/dependabot_assess": HASH_OLD,
      }),
    );
    w.patch.set(
      "wmill-lock.yaml",
      wmillLock({
        "f/factory/foo": HASH_NEW,
        "f/factory/other": HASH_OLD,
        "f/factory/steps/dependabot_assess": HASH_NEW,
      }),
    );
    expect(await codeOf(w)).toBe("wmill_lock_key_not_allowed");
  });
});
