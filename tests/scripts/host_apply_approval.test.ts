import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  matchesForbiddenPath,
  matchesImplementProtectedPath,
} from "../../f/factory/lib/protected_paths.ts";
import {
  approvalFiles,
  type ChangedFile,
  isApprovalTarget,
  parseNameStatusZ,
  pickApprovalBase,
} from "../../scripts/host_apply/approval.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

function changed(...paths: string[]): ChangedFile[] {
  return paths.map((path) => ({ path, status: "M" }));
}

describe("isApprovalTarget", () => {
  test.each([
    "scripts/doctor.sh",
    "scripts/bootstrap.sh",
    "scripts/check-docker-version.sh",
    "scripts/custom-tags.ts",
    "scripts/record-host-applied.sh",
    "scripts/host-install.sh",
    "scripts/host-apply.ts",
    "scripts/host-apply.sh",
    "scripts/host_apply/ci.ts",
    "scripts/host_apply/sub/deep.ts",
    "package.json",
    "bunfig.toml",
    ".npmrc",
    ".env",
    ".env.local",
    ".node-version",
    ".bun-version",
    ".nvmrc",
    ".python-version",
    ".ruby-version",
    "mise.toml",
    "mise.production.toml",
    ".mise.toml",
    "mise/config.toml",
    ".mise/config.toml",
    ".config/mise/config.toml",
    ".tool-versions",
    ".github/workflows/ci.yml",
    "scripts/ci-scope.ts",
  ])("requires approval for %s", (path) => {
    expect(isApprovalTarget(path)).toBe(true);
  });

  test.each([
    "infra/docker-compose.yml",
    "infra/Caddyfile",
    "infra/worker/Dockerfile",
    "docs/security.md",
    "f/factory/self_update.ts",
    "console/package.json",
    "scripts/lint-docs.ts",
    "bun.lock",
    "bun.lockb",
    ".github/workflows/other.yml",
    "tests/scripts/host_apply_ci.test.ts",
  ])("does not require approval for %s", (path) => {
    expect(isApprovalTarget(path)).toBe(false);
  });
});

describe("isApprovalTarget: letter case", () => {
  // APFSは大文字小文字を区別しないので、別の綴りでも同じファイルを指す。
  test.each([
    "Bunfig.toml",
    "BUNFIG.TOML",
    ".NPMRC",
    ".ENV",
    ".Env.local",
    ".Node-version",
    ".BUN-VERSION",
    ".Tool-versions",
    "Mise.toml",
    "Mise.local.toml",
    "MISE/config.toml",
    ".MISE/config.toml",
    ".Config/Mise/config.toml",
    "scripts/Host-install.sh",
    "Scripts/Doctor.sh",
    "scripts/DOCTOR.SH",
    "scripts/Host_apply/x.ts",
    "scripts/HOST-APPLY.ts",
    ".GitHub/Workflows/CI.yml",
    "Scripts/CI-Scope.ts",
  ])("requires approval for %s", (path) => {
    expect(isApprovalTarget(path)).toBe(true);
  });

  test("requires approval for Package.json", () => {
    expect(isApprovalTarget("Package.json")).toBe(true);
  });

  test.each(["BUN.LOCK", "Docs/Security.md", "console/package.json"])(
    "does not require approval for %s",
    (path) => {
      expect(isApprovalTarget(path)).toBe(false);
    },
  );
});

describe("approvalFiles", () => {
  test("lists the files that touch an approval target", () => {
    expect(
      approvalFiles(
        changed("docs/a.md", "scripts/doctor.sh", "bunfig.toml"),
        new Set(),
      ),
    ).toEqual(["scripts/doctor.sh", "bunfig.toml"]);
  });

  test("counts a deletion as touching the file", () => {
    expect(
      approvalFiles([{ path: "scripts/doctor.sh", status: "D" }], new Set()),
    ).toEqual(["scripts/doctor.sh"]);
  });

  test("counts a new file as touching the file", () => {
    expect(
      approvalFiles([{ path: "mise/config.toml", status: "A" }], new Set()),
    ).toEqual(["mise/config.toml"]);
  });

  test("leaves out a path exempted by the mise policy", () => {
    expect(
      approvalFiles(changed("mise.toml", "docs/a.md"), new Set(["mise.toml"])),
    ).toEqual([]);
  });

  test("returns nothing when only ordinary files changed", () => {
    expect(
      approvalFiles(changed("docs/a.md", "infra/Caddyfile"), new Set()),
    ).toEqual([]);
  });
});

describe("parseNameStatusZ", () => {
  test("parses NUL-separated status and path pairs", () => {
    expect(parseNameStatusZ("M\0a.txt\0A\0dir/b.txt\0D\0c.txt\0")).toEqual([
      { status: "M", path: "a.txt" },
      { status: "A", path: "dir/b.txt" },
      { status: "D", path: "c.txt" },
    ]);
  });

  test("keeps a path with a newline and a space intact", () => {
    expect(parseNameStatusZ("M\0weird name\nx.txt\0")).toEqual([
      { status: "M", path: "weird name\nx.txt" },
    ]);
  });

  test("returns nothing for empty output", () => {
    expect(parseNameStatusZ("")).toEqual([]);
  });
});

describe("pickApprovalBase", () => {
  test("uses the applied sha when nothing was approved", () => {
    expect(
      pickApprovalBase({
        applied: A,
        approved: null,
        approvedFollowsApplied: false,
        approvedPrecedesTarget: false,
      }),
    ).toBe(A);
  });

  test("uses the approved sha when it is newer than the applied sha", () => {
    expect(
      pickApprovalBase({
        applied: A,
        approved: B,
        approvedFollowsApplied: true,
        approvedPrecedesTarget: true,
      }),
    ).toBe(B);
  });

  test("uses the applied sha when the approved sha is older", () => {
    expect(
      pickApprovalBase({
        applied: B,
        approved: A,
        approvedFollowsApplied: false,
        approvedPrecedesTarget: true,
      }),
    ).toBe(B);
  });

  test("ignores an approved sha that is not an ancestor of the target", () => {
    expect(
      pickApprovalBase({
        applied: A,
        approved: B,
        approvedFollowsApplied: true,
        approvedPrecedesTarget: false,
      }),
    ).toBe(A);
  });
});

describe("approval covers changes up to the approved sha only", () => {
  // 基準より後の差だけを評価する。承認の後に対象のファイルが変われば、また承認が要る。
  const beforeApproval = changed("scripts/doctor.sh");
  const afterApproval = changed("docs/a.md");
  const laterEdit = changed("scripts/doctor.sh");

  test("the earlier change needs approval from the applied sha", () => {
    expect(approvalFiles(beforeApproval, new Set())).toEqual([
      "scripts/doctor.sh",
    ]);
  });

  test("a diff taken from the approved sha without target files needs no approval", () => {
    expect(approvalFiles(afterApproval, new Set())).toEqual([]);
  });

  test("a later change to a target file needs approval again", () => {
    expect(approvalFiles(laterEdit, new Set())).toEqual(["scripts/doctor.sh"]);
  });
});

describe("how the host scripts start the custom-tags script", () => {
  // `bun run scripts/x.ts`は、同名のpackage.jsonのscriptがあるとそちらを実行する。
  // `./`で始め、`run`を付けない形なら、必ずファイルを実行する。
  const readScript = (path: string) =>
    readFileSync(join(import.meta.dir, "../..", path), "utf8");

  test.each(["scripts/doctor.sh", "scripts/bootstrap.sh"])(
    "%s never uses bun run for it",
    (path) => {
      expect(readScript(path)).not.toMatch(/bun run scripts\/custom-tags\.ts/);
    },
  );

  test.each(["scripts/doctor.sh", "scripts/bootstrap.sh"])(
    "%s starts it as bun ./scripts/custom-tags.ts",
    (path) => {
      expect(readScript(path)).toMatch(/bun \.\/scripts\/custom-tags\.ts /);
    },
  );
});

describe("scripts/ci-scope.ts", () => {
  test("is an approval target and also a protected path of both flows, as separate lists", () => {
    expect([
      isApprovalTarget("scripts/ci-scope.ts"),
      matchesForbiddenPath("scripts/ci-scope.ts"),
      matchesImplementProtectedPath("scripts/ci-scope.ts"),
    ]).toEqual([true, true, true]);
  });
});
