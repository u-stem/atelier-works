import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isApprovalTarget } from "../../scripts/host_apply/approval.ts";
import {
  type ApproveArgs,
  type ApproveDeps,
  type ApproveGit,
  addedLines,
  confirmationPhrase,
  createApproveGit,
  EXIT_FAILED,
  EXIT_REFUSED,
  escapeForDisplay,
  findAddedViolations,
  isAgentSuspected,
  isAllowedCodePoint,
  type LimitedGitRunner,
  MAX_DIFF_BYTES,
  PAGE_SIZE,
  parseApproveArgs,
  runApprove,
  showPaged,
} from "../../scripts/host_apply/approve.ts";
import type { ReadApprovedResult } from "../../scripts/host_apply/approved_io.ts";
import type { ApprovedRecord } from "../../scripts/host_apply/approved_store.ts";
import { approveGitEnv } from "../../scripts/host_apply/git.ts";
import type { GitRunner } from "../../scripts/host_apply/plan_git.ts";
import {
  createFixtureRepo,
  type FixtureRepo,
} from "../fixtures/host_apply_repo.ts";

const REPO_ROOT = join(import.meta.dir, "../..");
const MISE = readFileSync(join(REPO_ROOT, "mise.toml"), "utf8");
const COMPOSE = readFileSync(
  join(REPO_ROOT, "infra/docker-compose.yml"),
  "utf8",
);
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "89abcdef0123456789abcdef0123456789abcdef";

describe("isAgentSuspected", () => {
  test("is true for a non-empty CLAUDECODE", () => {
    expect(isAgentSuspected({ CLAUDECODE: "1" })).toBe(true);
  });

  test("is true for CLAUDE_CODE_ENTRYPOINT", () => {
    expect(isAgentSuspected({ CLAUDE_CODE_ENTRYPOINT: "cli" })).toBe(true);
  });

  test("is false when only CLAUDE_CODE_OAUTH_TOKEN is set", () => {
    expect(isAgentSuspected({ CLAUDE_CODE_OAUTH_TOKEN: "tok" })).toBe(false);
  });

  test("is false for an empty CLAUDECODE", () => {
    expect(isAgentSuspected({ CLAUDECODE: "" })).toBe(false);
  });

  test("is false for an empty environment", () => {
    expect(isAgentSuspected({})).toBe(false);
  });
});

describe("isAllowedCodePoint", () => {
  test.each([
    ["ESC", 0x1b],
    ["DEL", 0x7f],
    ["carriage return", 0x0d],
    ["NUL", 0x00],
    ["C1 control NEL", 0x85],
    ["soft hyphen", 0xad],
    ["zero width space", 0x200b],
    ["right-to-left override", 0x202e],
    ["line separator", 0x2028],
    ["hangul filler", 0x3164],
    ["tag letter", 0xe0041],
    ["variation selector", 0xfe0f],
    ["left single quotation mark", 0x2018],
    ["left double quotation mark", 0x201c],
    ["em dash", 0x2014],
    ["multiplication sign", 0xd7],
    ["combining voiced sound mark", 0x3099],
    ["Hangzhou numeral", 0x302a],
    ["ideographic variation mark", 0x303f],
    ["ideographic space", 0x3000],
    ["fullwidth exclamation mark", 0xff01],
    ["long s", 0x17f],
    ["Cyrillic a", 0x430],
    ["Kelvin sign", 0x212a],
  ])("rejects %s", (_name, codePoint) => {
    expect(isAllowedCodePoint(codePoint)).toBe(false);
  });

  test.each([
    ["newline", "\n"],
    ["tab", "\t"],
    ["space", " "],
    ["tilde", "~"],
    ["kanji", "漢"],
    ["hiragana", "あ"],
    ["small hiragana", "ゖ"],
    ["katakana", "カ"],
    ["middle dot", "・"],
    ["long vowel mark", "ー"],
    ["iteration mark", "々"],
    ["ideographic full stop", "。"],
    ["ideographic comma", "、"],
    ["corner bracket", "「"],
    ["black lenticular bracket", "【"],
    ["wave dash", "〜"],
    ["ellipsis", "…"],
    ["reference mark", "※"],
    ["left arrow", "←"],
    ["down arrow", "↓"],
  ])("accepts %s", (_name, char) => {
    expect(isAllowedCodePoint(char.codePointAt(0) ?? -1)).toBe(true);
  });
});

describe("escapeForDisplay", () => {
  test("writes ESC as \\x1b", () => {
    expect(escapeForDisplay("a\u001bb")).toBe("a\\x1bb");
  });

  test("writes a carriage return as \\x0d", () => {
    expect(escapeForDisplay("a\rb")).toBe("a\\x0db");
  });

  test("writes a code point above U+00FF as \\u{...}", () => {
    expect(escapeForDisplay("a b")).toBe("a\\u{2028}b");
  });

  test("writes a code point outside the BMP as \\u{...}", () => {
    expect(escapeForDisplay(String.fromCodePoint(0xe0041))).toBe("\\u{e0041}");
  });

  test("keeps Japanese text as it is", () => {
    expect(escapeForDisplay("承認の門。ひらがなカタカナ")).toBe(
      "承認の門。ひらがなカタカナ",
    );
  });

  test("keeps newlines and tabs", () => {
    expect(escapeForDisplay("a\n\tb")).toBe("a\n\tb");
  });
});

describe("addedLines", () => {
  const header = "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n";

  test("returns the lines that start with a plus in a hunk", () => {
    const diff = `${header}@@ -1,2 +1,3 @@\n keep\n+added\n-removed\n+more\n`;
    expect(addedLines(diff)).toEqual(["added", "more"]);
  });

  test("returns an added line whose content starts with ++", () => {
    const diff = `${header}@@ -0,0 +1 @@\n+++ b/evil\n`;
    expect(addedLines(diff)).toEqual(["++ b/evil"]);
  });

  test("does not return the +++ line of the header", () => {
    expect(addedLines(`${header}@@ -1 +1 @@\n x\n`)).toEqual([]);
  });

  test("does not return a removed line that starts with ---", () => {
    expect(addedLines(`${header}@@ -1 +1 @@\n--- b/f\n x\n`)).toEqual([]);
  });

  test("reads every file of a diff", () => {
    const second = "diff --git a/g b/g\n--- a/g\n+++ b/g\n@@ -1 +1 @@\n+two\n";
    expect(addedLines(`${header}@@ -1 +1 @@\n+one\n${second}`)).toEqual([
      "one",
      "two",
    ]);
  });

  test("does not return header lines of a mode-only change", () => {
    expect(
      addedLines("diff --git a/f b/f\nold mode 100644\nnew mode 100755\n"),
    ).toEqual([]);
  });
});

describe("findAddedViolations", () => {
  const header = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -0,0 +1 @@\n";

  test("finds an added line with a character outside the list", () => {
    expect(findAddedViolations(`${header}+a\u001b[31mb\n`)).toEqual([
      { line: "a\u001b[31mb" },
    ]);
  });

  test("ignores a context line with a character outside the list", () => {
    expect(findAddedViolations(`${header} a\u001bb\n`)).toEqual([]);
  });

  test("ignores a removed line with a character outside the list", () => {
    expect(findAddedViolations(`${header}-a\u001bb\n`)).toEqual([]);
  });

  test("accepts an added line with Japanese text and ASCII", () => {
    expect(findAddedViolations(`${header}+承認する: approve()\n`)).toEqual([]);
  });
});

describe("confirmationPhrase", () => {
  test("is approve followed by the first twelve digits", () => {
    expect(confirmationPhrase(SHA)).toBe("approve 0123456789ab");
  });
});

describe("parseApproveArgs", () => {
  test("reads a sha and --applied", () => {
    expect(parseApproveArgs(["abc1234", "--applied", SHA])).toEqual({
      ok: true,
      args: { sha: "abc1234", applied: SHA, stateDir: null },
    });
  });

  test("reads --state-dir", () => {
    const parsed = parseApproveArgs([
      SHA,
      "--applied",
      OTHER,
      "--state-dir",
      "/var/state",
    ]);
    expect(parsed.ok && parsed.args.stateDir).toBe("/var/state");
  });

  test("rejects a six digit sha", () => {
    expect(parseApproveArgs(["abc123", "--applied", SHA]).ok).toBe(false);
  });

  test("rejects a ref name", () => {
    expect(parseApproveArgs(["main", "--applied", SHA]).ok).toBe(false);
  });

  test("rejects an upper case sha", () => {
    expect(parseApproveArgs(["ABC1234", "--applied", SHA]).ok).toBe(false);
  });

  test("rejects a missing --applied", () => {
    expect(parseApproveArgs([SHA]).ok).toBe(false);
  });

  test("rejects an --applied that is not forty digits", () => {
    expect(parseApproveArgs([SHA, "--applied", "abc1234"]).ok).toBe(false);
  });

  test("rejects an unknown flag", () => {
    expect(parseApproveArgs([SHA, "--applied", OTHER, "--force", "1"]).ok).toBe(
      false,
    );
  });

  test("rejects a flag given twice", () => {
    expect(
      parseApproveArgs([SHA, "--applied", OTHER, "--applied", OTHER]).ok,
    ).toBe(false);
  });

  test("rejects a relative --state-dir", () => {
    expect(
      parseApproveArgs([SHA, "--applied", OTHER, "--state-dir", "state"]).ok,
    ).toBe(false);
  });

  test("rejects a --state-dir with a control character", () => {
    expect(
      parseApproveArgs([SHA, "--applied", OTHER, "--state-dir", "/a\tb"]).ok,
    ).toBe(false);
  });

  test("rejects a missing sha", () => {
    expect(parseApproveArgs(["--applied", OTHER]).ok).toBe(false);
  });

  test("rejects a flag without a value", () => {
    expect(parseApproveArgs([SHA, "--applied"]).ok).toBe(false);
  });
});

describe("showPaged", () => {
  function lines(count: number): string[] {
    return Array.from({ length: count }, (_, i) => `line ${i + 1}`);
  }

  function io(answers: (string | null)[]) {
    const printed: string[] = [];
    let reads = 0;
    return {
      printed,
      reads: () => reads,
      io: {
        print: (line: string) => {
          printed.push(line);
        },
        readLine: async () => {
          reads += 1;
          if (answers.length === 0) return "";
          return answers.shift() ?? null;
        },
      },
    };
  }

  test("uses forty lines per page", () => {
    expect(PAGE_SIZE).toBe(40);
  });

  test("prints every line when each answer is Enter", async () => {
    const h = io([]);
    await showPaged(lines(100), h.io);
    expect(h.printed.filter((line) => line.startsWith("line "))).toEqual(
      lines(100),
    );
  });

  test("asks once per page break", async () => {
    const h = io([]);
    await showPaged(lines(100), h.io);
    expect(h.reads()).toBe(2);
  });

  test("does not ask after the last page", async () => {
    const h = io([]);
    await showPaged(lines(40), h.io);
    expect(h.reads()).toBe(0);
  });

  test("returns done after the last page", async () => {
    const h = io([]);
    expect(await showPaged(lines(100), h.io)).toBe("done");
  });

  test("returns quit when the answer is q", async () => {
    const h = io(["q"]);
    expect(await showPaged(lines(100), h.io)).toBe("quit");
  });

  test("prints no more lines after q", async () => {
    const h = io(["q"]);
    await showPaged(lines(100), h.io);
    expect(h.printed.filter((line) => line.startsWith("line ")).length).toBe(
      40,
    );
  });

  test("returns quit when the input ends", async () => {
    const h = io([null]);
    expect(await showPaged(lines(100), h.io)).toBe("quit");
  });

  test("starts every page break prompt with two dashes", async () => {
    const h = io([]);
    await showPaged(lines(50), h.io);
    expect(h.printed.filter((line) => line.startsWith("-- ")).length).toBe(1);
  });

  test("honors a page size argument", async () => {
    const h = io([]);
    await showPaged(lines(10), h.io, 5);
    expect(h.reads()).toBe(1);
  });
});

describe("createApproveGit", () => {
  const SHA_LINE = `${SHA} refs/remotes/origin/main\n`;

  function git(
    run: GitRunner,
    limited: LimitedGitRunner = async () => ({
      code: 0,
      stdout: "",
      truncated: false,
    }),
  ): ApproveGit {
    return createApproveGit(run, limited);
  }

  test("resolveCommit returns the full sha", async () => {
    const g = git(async () => ({ code: 0, stdout: `${SHA}\n` }));
    expect(await g.resolveCommit("0123456")).toBe(SHA);
  });

  test("resolveCommit returns null when git cannot resolve it", async () => {
    const g = git(async () => ({ code: 1, stdout: "" }));
    expect(await g.resolveCommit("0123456")).toBeNull();
  });

  test("resolveCommit returns null for an ambiguous abbreviation", async () => {
    const g = git(async () => ({ code: 128, stdout: "" }));
    expect(await g.resolveCommit("0123456")).toBeNull();
  });

  test("resolveCommit returns null for output that is not a sha", async () => {
    const g = git(async () => ({ code: 0, stdout: "garbage\n" }));
    expect(await g.resolveCommit("0123456")).toBeNull();
  });

  test("originMainTip returns the sha of the full ref name", async () => {
    const g = git(async () => ({ code: 0, stdout: SHA_LINE }));
    expect(await g.originMainTip()).toBe(SHA);
  });

  test("originMainTip returns null when the ref is missing", async () => {
    const g = git(async () => ({ code: 128, stdout: "" }));
    expect(await g.originMainTip()).toBeNull();
  });

  test("diffPatch returns the text of the difference", async () => {
    const g = git(
      async () => ({ code: 0, stdout: "" }),
      async () => ({ code: 0, stdout: "diff text", truncated: false }),
    );
    expect(await g.diffPatch(SHA, OTHER, ["a"])).toEqual({
      text: "diff text",
      truncated: false,
    });
  });

  test("diffPatch reports a truncated output", async () => {
    const g = git(
      async () => ({ code: 0, stdout: "" }),
      async () => ({ code: -1, stdout: "part", truncated: true }),
    );
    expect(await g.diffPatch(SHA, OTHER, ["a"])).toEqual({
      text: "",
      truncated: true,
    });
  });

  test("diffPatch asks for at most 512 KiB", async () => {
    const limits: number[] = [];
    const g = git(
      async () => ({ code: 0, stdout: "" }),
      async (_args, max) => {
        limits.push(max);
        return { code: 0, stdout: "", truncated: false };
      },
    );
    await g.diffPatch(SHA, OTHER, ["a"]);
    expect(limits).toEqual([512 * 1024]);
  });

  test("diffPatch throws when git fails", async () => {
    const g = git(
      async () => ({ code: 0, stdout: "" }),
      async () => ({ code: 128, stdout: "", truncated: false }),
    );
    await expect(g.diffPatch(SHA, OTHER, ["a"])).rejects.toThrow("git diff");
  });

  test("exposes the size limit as 512 KiB", () => {
    expect(MAX_DIFF_BYTES).toBe(512 * 1024);
  });
});

// 実際のgitのリポジトリに対して、承認の流れ全体を動かす。
describe("runApprove", () => {
  const repos: FixtureRepo[] = [];
  afterAll(() => {
    for (const repo of repos) repo.cleanup();
  });

  const BASE_FILES = {
    "package.json": JSON.stringify({
      name: "x",
      dependencies: {},
      devDependencies: { typescript: "^7.0.2" },
    }),
    "mise.toml": MISE,
    "infra/docker-compose.yml": COMPOSE,
    "scripts/doctor.sh": "#!/bin/sh\n",
    "docs/a.md": "a\n",
  };
  const DOCTOR = { "scripts/doctor.sh": "#!/bin/sh\necho changed\n" };
  const NOW = new Date("2026-10-18T01:02:03.000Z");

  function realGit(repo: FixtureRepo): ApproveGit {
    const run: GitRunner = async (args) => {
      const proc = Bun.spawn(["/usr/bin/git", ...args], {
        cwd: repo.dir,
        env: approveGitEnv(),
        stdout: "pipe",
        stderr: "ignore",
      });
      const stdout = await new Response(proc.stdout).text();
      return { code: await proc.exited, stdout };
    };
    const limited: LimitedGitRunner = async (args, max) => {
      const result = await run(args);
      return { ...result, truncated: result.stdout.length > max };
    };
    return createApproveGit(run, limited);
  }

  /** applied、変更、`origin/main`の先端がそろったリポジトリ。 */
  function scenario(change: Record<string, string | null> = DOCTOR) {
    const repo = createFixtureRepo();
    repos.push(repo);
    const applied = repo.commit(BASE_FILES, "base");
    const target = repo.commit(change, "change");
    repo.setOriginMain(target);
    return { repo, applied, target };
  }

  type Options = {
    env?: Record<string, string>;
    execArgv?: string[];
    isTerminal?: boolean;
    originOk?: boolean;
    /** 出どころの検査が例外を投げる。 */
    originThrows?: boolean;
    git?: (real: ApproveGit) => ApproveGit;
    stored?: ReadApprovedResult;
    /** 確認の入力。`undefined`なら表示された文言を打つ。 */
    confirm?: string | null;
    pager?: string | null;
    writeFails?: boolean;
    sha?: string;
  };

  async function approve(
    s: { repo: FixtureRepo; applied: string; target: string },
    options: Options = {},
  ) {
    const written: ApprovedRecord[] = [];
    const printed: string[] = [];
    const errors: string[] = [];
    const real = realGit(s.repo);
    const deps: ApproveDeps = {
      env: options.env ?? {},
      execArgv: options.execArgv ?? ["--no-env-file"],
      isTerminal: () => options.isTerminal ?? true,
      checkOrigin: async () => {
        if (options.originThrows) throw new Error("cannot read \u001b[2J");
        return options.originOk === false
          ? { ok: false, reason: "the code is not at origin/main" }
          : { ok: true };
      },
      git: options.git ? options.git(real) : real,
      readRecord: () => options.stored ?? { kind: "absent" },
      writeRecord: (record) => {
        if (options.writeFails) throw new Error("disk full");
        written.push(record);
      },
      now: () => NOW,
      io: {
        print: (line) => {
          printed.push(line);
        },
        error: (line) => {
          errors.push(line);
        },
        readLine: async () => {
          const last = printed[printed.length - 1] ?? "";
          if (last.startsWith("-- ")) {
            return options.pager === undefined ? "" : options.pager;
          }
          if (options.confirm !== undefined) return options.confirm;
          return /"(approve [0-9a-f]{12})"/.exec(last)?.[1] ?? "no phrase";
        },
      },
    };
    const args: ApproveArgs = {
      sha: options.sha ?? s.target,
      applied: s.applied,
      stateDir: null,
    };
    const code = await runApprove(args, deps);
    return { code, written, printed, errors };
  }

  async function outcome(
    s: { repo: FixtureRepo; applied: string; target: string },
    options: Options = {},
  ) {
    const result = await approve(s, options);
    return { code: result.code, wrote: result.written.length };
  }

  const REFUSED = { code: EXIT_REFUSED, wrote: 0 };

  describe("the gates", () => {
    const gates: [string, Options, string][] = [
      [
        "the environment looks like an agent",
        { env: { CLAUDECODE: "1" } },
        "agent",
      ],
      [
        "the environment names the Claude entry point",
        { env: { CLAUDE_CODE_ENTRYPOINT: "cli" } },
        "agent",
      ],
      ["stdin or stdout is not a terminal", { isTerminal: false }, "terminal"],
      ["the code origin check fails", { originOk: false }, "code origin"],
      ["--no-env-file is missing", { execArgv: [] }, "--no-env-file"],
    ];

    test.each(gates)("%s: refuses and writes nothing", async (_n, options) => {
      expect(await outcome(scenario(), options)).toEqual(REFUSED);
    });

    test.each(gates)("%s: says which gate stopped it", async (_n, o, word) => {
      const result = await approve(scenario(), o);
      expect(result.errors.join("\n")).toContain(word);
    });

    test.each(gates)("%s: never asks for the confirmation", async (_n, o) => {
      const result = await approve(scenario(), o);
      expect(result.printed).toEqual([]);
    });

    test("the agent gate does not mention the terminal gate", async () => {
      const result = await approve(scenario(), { env: { CLAUDECODE: "1" } });
      expect(result.errors.join("\n")).not.toContain("terminal");
    });

    test("the terminal gate does not mention the agent gate", async () => {
      const result = await approve(scenario(), { isTerminal: false });
      expect(result.errors.join("\n")).not.toContain("agent");
    });

    test("passes when CLAUDE_CODE_OAUTH_TOKEN is the only Claude variable", async () => {
      const result = await outcome(scenario(), {
        env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
      });
      expect(result).toEqual({ code: 0, wrote: 1 });
    });
  });

  describe("what can be approved", () => {
    test("approves a commit that waits for approval", async () => {
      expect(await outcome(scenario())).toEqual({ code: 0, wrote: 1 });
    });

    test("records the target, the applied sha and the time", async () => {
      const s = scenario();
      const { written } = await approve(s);
      expect(written[0]).toMatchObject({
        schema: 1,
        sha: s.target,
        applied: s.applied,
        approved_at: "2026-10-18T01:02:03.000Z",
      });
    });

    test("records the files with their status", async () => {
      const { written } = await approve(scenario());
      expect(written[0]?.files).toEqual([
        { path: "scripts/doctor.sh", status: "M" },
      ]);
    });

    test("records an added and a deleted file", async () => {
      const s = scenario({
        "scripts/check-idle.ts": "export {};\n",
        "scripts/doctor.sh": null,
      });
      const { written } = await approve(s);
      expect(written[0]?.files).toEqual([
        { path: "scripts/check-idle.ts", status: "A" },
        { path: "scripts/doctor.sh", status: "D" },
      ]);
    });

    test("approves an abbreviated sha", async () => {
      const s = scenario();
      expect(await outcome(s, { sha: s.target.slice(0, 10) })).toEqual({
        code: 0,
        wrote: 1,
      });
    });

    test("records the full sha for an abbreviated input", async () => {
      const s = scenario();
      const { written } = await approve(s, { sha: s.target.slice(0, 10) });
      expect(written[0]?.sha).toBe(s.target);
    });

    test("refuses a target that is already applied", async () => {
      const s = scenario();
      expect(await outcome(s, { sha: s.applied })).toEqual(REFUSED);
    });

    test("refuses a change that needs no approval", async () => {
      const s = scenario({ "docs/a.md": "changed\n" });
      expect(await outcome(s)).toEqual(REFUSED);
    });

    test("refuses a target that the static checks reject", async () => {
      const repo = createFixtureRepo();
      repos.push(repo);
      const applied = repo.commit(BASE_FILES, "base");
      const target = repo.symlink("docs/link.md", "../secret");
      repo.setOriginMain(target);
      expect(await outcome({ repo, applied, target })).toEqual(REFUSED);
    });

    test("refuses a change that is rejected once it is approved", async () => {
      const s = scenario({ ...DOCTOR, "infra/docker-compose.yml": null });
      expect(await outcome(s)).toEqual(REFUSED);
    });

    test("says why a change is rejected once it is approved", async () => {
      const s = scenario({ ...DOCTOR, "infra/docker-compose.yml": null });
      const { errors } = await approve(s);
      expect(errors.join("\n")).toContain("compose_forbidden");
    });

    test("refuses a change that touches a .env file", async () => {
      const s = scenario({ ".env": "SECRET_VALUE=hunter2\n" });
      expect(await outcome(s)).toEqual(REFUSED);
    });

    test("never prints the body of a .env file", async () => {
      const s = scenario({ ".env": "SECRET_VALUE=hunter2\n" });
      const { printed, errors } = await approve(s);
      expect([...printed, ...errors].join("\n")).not.toContain("hunter2");
    });

    test("refuses a file type change", async () => {
      const s = scenario();
      const outcomeOf = await outcome(s, {
        git: (real) => ({
          ...real,
          changedFiles: async (base, target) =>
            base === target ? [] : [{ path: "scripts/doctor.sh", status: "T" }],
        }),
      });
      expect(outcomeOf).toEqual(REFUSED);
    });

    test("refuses an added line with an escape character", async () => {
      const s = scenario({ "scripts/doctor.sh": "echo \u001b[2Jhidden\n" });
      expect(await outcome(s)).toEqual(REFUSED);
    });

    test("shows the offending line with the character escaped", async () => {
      const s = scenario({ "scripts/doctor.sh": "echo \u001b[2Jhidden\n" });
      const { errors } = await approve(s);
      expect(errors.join("\n")).toContain("echo \\x1b[2Jhidden");
    });

    test("never writes a raw escape character to the output", async () => {
      const s = scenario({ "scripts/doctor.sh": "echo \u001b[2Jhidden\n" });
      const { printed, errors } = await approve(s);
      expect([...printed, ...errors].join("\n")).not.toContain("\u001b");
    });

    test("refuses a curly quote in an added line", async () => {
      const s = scenario({ "scripts/doctor.sh": "echo “x”\n" });
      expect(await outcome(s)).toEqual(REFUSED);
    });

    test("approves an added line with Japanese text", async () => {
      const s = scenario({ "scripts/doctor.sh": "echo 承認する\n" });
      expect(await outcome(s)).toEqual({ code: 0, wrote: 1 });
    });

    test("escapes a bad character in a context line of the display", async () => {
      const repo = createFixtureRepo();
      repos.push(repo);
      const applied = repo.commit(
        { ...BASE_FILES, "scripts/doctor.sh": "old \u001b[2J\nkeep\n" },
        "base",
      );
      const target = repo.commit(
        { "scripts/doctor.sh": "old \u001b[2J\nkeep\nnext\n" },
        "change",
      );
      repo.setOriginMain(target);
      const { printed } = await approve({ repo, applied, target });
      expect(printed.join("\n")).toContain("old \\x1b[2J");
    });

    test("refuses a difference over the size limit", async () => {
      const s = scenario();
      expect(
        await outcome(s, {
          git: (real) => ({
            ...real,
            diffPatch: async () => ({ text: "", truncated: true }),
          }),
        }),
      ).toEqual(REFUSED);
    });

    test("explains what to do about a difference over the limit", async () => {
      const s = scenario();
      const { errors } = await approve(s, {
        git: (real) => ({
          ...real,
          diffPatch: async () => ({ text: "", truncated: true }),
        }),
      });
      expect(errors.join("\n")).toContain("split");
    });

    test("exits 1 for an abbreviation that git cannot resolve", async () => {
      const s = scenario();
      const result = await outcome(s, {
        git: (real) => ({ ...real, resolveCommit: async () => null }),
      });
      expect(result).toEqual({ code: EXIT_FAILED, wrote: 0 });
    });

    test("refuses an input that resolved to a commit it does not start", async () => {
      const s = scenario();
      expect(
        await outcome(s, {
          git: (real) => ({ ...real, resolveCommit: async () => s.applied }),
        }),
      ).toEqual(REFUSED);
    });

    test("refuses a commit that origin/main does not contain", async () => {
      const s = scenario();
      s.repo.setOriginMain(s.applied);
      expect(await outcome(s)).toEqual(REFUSED);
    });

    test("refuses when origin/main does not exist", async () => {
      const s = scenario();
      expect(
        await outcome(s, {
          git: (real) => ({ ...real, originMainTip: async () => null }),
        }),
      ).toEqual(REFUSED);
    });

    test("refuses when the origin check throws", async () => {
      expect(await outcome(scenario(), { originThrows: true })).toEqual(
        REFUSED,
      );
    });

    test("escapes the message of an origin check that throws", async () => {
      const { errors } = await approve(scenario(), { originThrows: true });
      expect(errors.join("\n")).toContain("cannot read \\u001b[2J");
    });

    test("refuses a record that would be over 64 KiB, before asking", async () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 1200; i++) {
        files[
          `scripts/host_apply/generated/file${String(i).padStart(4, "0")}.ts`
        ] = "export {};\n";
      }
      const s = scenario(files);
      const { code, printed, written } = await approve(s);
      expect({
        code,
        wrote: written.length,
        asked: printed.some((line) => line.includes('"approve ')),
      }).toEqual({ code: EXIT_REFUSED, wrote: 0, asked: false });
    });

    test("exits 1 when the record cannot be written", async () => {
      expect(await outcome(scenario(), { writeFails: true })).toEqual({
        code: EXIT_FAILED,
        wrote: 0,
      });
    });

    test("exits 1 for an applied sha that does not exist", async () => {
      const s = scenario();
      const result = await approve({ ...s, applied: "e".repeat(40) });
      expect(result.code).toBe(EXIT_FAILED);
    });
  });

  describe("the display", () => {
    test("shows the full target sha", async () => {
      const s = scenario();
      const { printed } = await approve(s);
      expect(printed.join("\n")).toContain(s.target);
    });

    test("shows the base and the applied sha", async () => {
      const s = scenario();
      const { printed } = await approve(s);
      expect(printed.join("\n")).toContain(`base: ${s.applied}`);
    });

    test("shows the tip of origin/main and asks to compare it with GitHub", async () => {
      const s = scenario();
      const later = s.repo.commit({ "docs/b.md": "b\n" }, "later");
      s.repo.setOriginMain(later);
      const { printed } = await approve(s);
      expect(printed.join("\n")).toContain(`origin/main: ${later}`);
    });

    test("tells the person to check the tip against GitHub", async () => {
      const { printed } = await approve(scenario());
      expect(printed.join("\n")).toContain("GitHub");
    });

    test("lists each file with its status and counts", async () => {
      const { printed } = await approve(scenario());
      expect(printed.join("\n")).toContain("M scripts/doctor.sh (+1 -0)");
    });

    test("shows the body of the difference", async () => {
      const { printed } = await approve(scenario());
      expect(printed.join("\n")).toContain("+echo changed");
    });

    test("shows the mode lines of a mode-only change", async () => {
      const repo = createFixtureRepo();
      repos.push(repo);
      const applied = repo.commit(BASE_FILES, "base");
      repo.git(["update-index", "--chmod=+x", "scripts/doctor.sh"]);
      repo.git(["commit", "-q", "-m", "mode"]);
      const target = repo.git(["rev-parse", "HEAD"]);
      repo.setOriginMain(target);
      const { printed } = await approve({ repo, applied, target });
      expect(printed.join("\n")).toContain("new mode 100755");
    });

    test("says that the state after approval would converge", async () => {
      const { printed } = await approve(scenario());
      expect(printed.join("\n")).toContain("would_converge");
    });

    test("tells the exact phrase to type", async () => {
      const s = scenario();
      const { printed } = await approve(s);
      expect(printed.join("\n")).toContain(
        `"approve ${s.target.slice(0, 12)}"`,
      );
    });

    test("pages a long difference and still approves", async () => {
      const body = Array.from({ length: 150 }, (_, i) => `echo ${i}`).join(
        "\n",
      );
      const s = scenario({ "scripts/doctor.sh": `${body}\n` });
      expect(await outcome(s)).toEqual({ code: 0, wrote: 1 });
    });

    test("asks for the phrase only after the last page", async () => {
      const body = Array.from({ length: 150 }, (_, i) => `echo ${i}`).join(
        "\n",
      );
      const s = scenario({ "scripts/doctor.sh": `${body}\n` });
      const { printed } = await approve(s);
      const phraseAt = printed.findIndex((line) => line.includes('"approve '));
      const lastPage = printed
        .map((l) => l.startsWith("-- "))
        .lastIndexOf(true);
      expect(phraseAt).toBeGreaterThan(lastPage);
    });

    test("stops at q in the pager and writes nothing", async () => {
      const body = Array.from({ length: 150 }, (_, i) => `echo ${i}`).join(
        "\n",
      );
      const s = scenario({ "scripts/doctor.sh": `${body}\n` });
      expect(await outcome(s, { pager: "q" })).toEqual(REFUSED);
    });

    test("does not ask for the phrase after q in the pager", async () => {
      const body = Array.from({ length: 150 }, (_, i) => `echo ${i}`).join(
        "\n",
      );
      const s = scenario({ "scripts/doctor.sh": `${body}\n` });
      const { printed } = await approve(s, { pager: "q" });
      expect(printed.some((line) => line.includes('"approve '))).toBe(false);
    });
  });

  describe("the confirmation", () => {
    test("refuses a different phrase", async () => {
      expect(await outcome(scenario(), { confirm: "approve" })).toEqual(
        REFUSED,
      );
    });

    test("refuses the phrase with trailing text", async () => {
      const s = scenario();
      const phrase = `approve ${s.target.slice(0, 12)} `;
      expect(await outcome(s, { confirm: phrase })).toEqual(REFUSED);
    });

    test("refuses an empty answer", async () => {
      expect(await outcome(scenario(), { confirm: "" })).toEqual(REFUSED);
    });

    test("refuses when the input ends", async () => {
      expect(await outcome(scenario(), { confirm: null })).toEqual(REFUSED);
    });

    test("refuses the phrase of another commit", async () => {
      const s = scenario();
      expect(
        await outcome(s, { confirm: `approve ${s.applied.slice(0, 12)}` }),
      ).toEqual(REFUSED);
    });
  });

  describe("an earlier record", () => {
    function chain() {
      const repo = createFixtureRepo();
      repos.push(repo);
      const applied = repo.commit(BASE_FILES, "base");
      const first = repo.commit(DOCTOR, "doctor");
      const second = repo.commit(
        { "scripts/check-idle.ts": "export {};\n" },
        "check-idle",
      );
      repo.setOriginMain(second);
      return { repo, applied, first, second };
    }

    function record(sha: string, applied: string): ReadApprovedResult {
      return {
        kind: "found",
        record: {
          schema: 1,
          sha,
          applied,
          approved_at: "2026-10-17T00:00:00.000Z",
          files: [{ path: "scripts/doctor.sh", status: "M" }],
        },
      };
    }

    test("starts the difference at the earlier approved sha", async () => {
      const c = chain();
      const { written } = await approve(
        { repo: c.repo, applied: c.applied, target: c.second },
        { stored: record(c.first, c.applied) },
      );
      expect(written[0]?.files).toEqual([
        { path: "scripts/check-idle.ts", status: "A" },
      ]);
    });

    test("shows the earlier approved sha as the base", async () => {
      const c = chain();
      const { printed } = await approve(
        { repo: c.repo, applied: c.applied, target: c.second },
        { stored: record(c.first, c.applied) },
      );
      expect(printed.join("\n")).toContain(`base: ${c.first}`);
    });

    test("keeps the applied sha that the person gave", async () => {
      const c = chain();
      const { written } = await approve(
        { repo: c.repo, applied: c.applied, target: c.second },
        { stored: record(c.first, c.applied) },
      );
      expect(written[0]?.applied).toBe(c.applied);
    });

    test("ignores a record made for another applied sha", async () => {
      const c = chain();
      const { written } = await approve(
        { repo: c.repo, applied: c.applied, target: c.second },
        { stored: record(c.first, c.second) },
      );
      expect(written[0]?.files.map((f) => f.path)).toEqual([
        "scripts/check-idle.ts",
        "scripts/doctor.sh",
      ]);
    });

    test("ignores a broken record", async () => {
      const c = chain();
      const { written } = await approve(
        { repo: c.repo, applied: c.applied, target: c.second },
        { stored: { kind: "invalid", reason: "broken" } },
      );
      expect(written[0]?.files.map((f) => f.path)).toEqual([
        "scripts/check-idle.ts",
        "scripts/doctor.sh",
      ]);
    });

    test("refuses a commit that the earlier record already covers", async () => {
      const c = chain();
      expect(
        await outcome(
          { repo: c.repo, applied: c.applied, target: c.first },
          { stored: record(c.first, c.applied) },
        ),
      ).toEqual(REFUSED);
    });
  });
});

describe("the files that the approval shows", () => {
  const tracked = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: REPO_ROOT,
  })
    .stdout.toString()
    .split("\0")
    .filter((path) => path !== "");
  const targets = tracked.filter((path) => isApprovalTarget(path));

  test("finds the approval targets, so that the checks below are not empty", () => {
    expect(targets).toContain("mise.toml");
  });

  test("contain no character outside the allowed list", () => {
    const bad: string[] = [];
    for (const path of targets) {
      const text = readFileSync(join(REPO_ROOT, path), "utf8");
      for (const char of text) {
        const codePoint = char.codePointAt(0) ?? -1;
        if (!isAllowedCodePoint(codePoint)) {
          bad.push(`${path}: U+${codePoint.toString(16).toUpperCase()}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  test("do not include a tracked .env file", () => {
    expect(tracked.filter((path) => /(^|\/)\.env(\..*)?$/.test(path))).toEqual(
      [],
    );
  });
});
