/**
 * 人が`origin/main`のコミットを承認する道具の本体。
 * 主体、端末、コードの出どころ、確認の文言の門をすべて通ったときだけ、承認の記録を書く。
 * 環境、端末、git、記録の読み書きは注入され、この関数自身は何も実行しない。
 */

import type { ReadApprovedResult } from "./approved_io.ts";
import {
  type ApprovedFile,
  type ApprovedRecord,
  isApprovedStatus,
  serializeApprovedRecord,
} from "./approved_store.ts";
import type { OriginCheck } from "./code_origin.ts";
import {
  diffPatchArgs,
  isSha40,
  ORIGIN_MAIN_REF,
  resolveCommitArgs,
  showRefArgs,
} from "./git.ts";
import { buildPlan, isAbsoluteCleanPath, type PlanGit } from "./plan.ts";
import { createPlanGit, type GitRunner } from "./plan_git.ts";
import { escapeDetail } from "./stable.ts";

/** 差分の標準出力の上限(バイト)。超えた変更は、この道具では承認できない。 */
export const MAX_DIFF_BYTES = 512 * 1024;

/** 差分を一度に表示する行数。 */
export const PAGE_SIZE = 40;

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_REFUSED = 3;

/** `plan`の判定に渡す、ステージングのルートの論理的なパス。実在しなくてよい。 */
const PLAN_ROOT = "/staging";

const PAGER_PROMPT = "-- Enter: next page, q: quit --";

export type ApproveArgs = {
  readonly sha: string;
  readonly applied: string;
  readonly stateDir: string | null;
};

export type ParsedApproveArgs =
  | { readonly ok: true; readonly args: ApproveArgs }
  | { readonly ok: false; readonly error: string };

export type DiffPatch = { readonly text: string; readonly truncated: boolean };

/** `approve`が使うgitの読み取り。 */
export type ApproveGit = PlanGit & {
  /** 7〜40桁の16進を、40桁のコミットに解決する。曖昧か存在しなければ`null`。 */
  resolveCommit(input: string): Promise<string | null>;
  /** `refs/remotes/origin/main`の先端。無ければ`null`。 */
  originMainTip(): Promise<string | null>;
  /** 差分の文字。出力が上限を超えたときは、本文を返さず`truncated`にする。 */
  diffPatch(
    base: string,
    target: string,
    files: readonly string[],
  ): Promise<DiffPatch>;
};

/** 標準出力に上限のあるgitの実行。上限を超えたらプロセスを止めて`truncated`にする。 */
export type LimitedGitRunner = (
  args: string[],
  maxBytes: number,
) => Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly truncated: boolean;
}>;

export type PagerIo = {
  print(line: string): void;
  /** 端末から1行読む。入力が尽きたら`null`。 */
  readLine(): Promise<string | null>;
};

export type ApprovalIo = PagerIo & { error(line: string): void };

export type ApproveDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 実行時のオプション。`--no-env-file`で起動したかの確認に使う。 */
  readonly execArgv: readonly string[];
  /** 標準入力と標準出力の両方が端末か。 */
  readonly isTerminal: () => boolean;
  readonly checkOrigin: () => Promise<OriginCheck>;
  readonly git: ApproveGit;
  readonly readRecord: () => ReadApprovedResult;
  readonly writeRecord: (record: ApprovedRecord) => void;
  readonly now: () => Date;
  readonly io: ApprovalIo;
};

/**
 * Claudeの作業の中で動いている疑いがあるか。
 * 空でない`CLAUDECODE`か、`CLAUDE_CODE_ENTRYPOINT`が環境にあれば真。
 * 接頭辞では判定しない。`CLAUDE_CODE_OAUTH_TOKEN`は人の環境にも入りうるため。
 * 環境変数は消せるので、これは誤操作の防止であり、権限の境界ではない。
 */
export function isAgentSuspected(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    (env.CLAUDECODE ?? "") !== "" || (env.CLAUDE_CODE_ENTRYPOINT ?? "") !== ""
  );
}

/**
 * そのまま端末に出してよい文字か。許可の一覧にない文字は、見えないか、別の文字に見えるものを含む。
 * 許可するのは、ASCIIの印字できる文字、タブ、改行と、日本語の文章に使うひらがな、カタカナ、漢字、
 * 句読点、かぎ括弧、波ダッシュ、中黒、三点リーダー、米印、矢印だけ。
 */
export function isAllowedCodePoint(codePoint: number): boolean {
  if (codePoint >= 0x20 && codePoint <= 0x7e) return true;
  if (codePoint === 0x09 || codePoint === 0x0a) return true;
  const ranges: readonly (readonly [number, number])[] = [
    [0x3041, 0x3096],
    [0x3005, 0x3005],
    [0x30a1, 0x30fa],
    [0x30fb, 0x30fc],
    [0x4e00, 0x9fff],
    [0x3001, 0x3002],
    [0x300c, 0x300f],
    [0x3010, 0x3011],
    [0x301c, 0x301c],
    [0x2026, 0x2026],
    [0x203b, 0x203b],
    [0x2190, 0x2193],
  ];
  return ranges.some(([from, to]) => codePoint >= from && codePoint <= to);
}

/**
 * 端末に出す形にする。許可の一覧の外の文字は、`\x1b`や`\u{2028}`のように見える表記にする。
 * 制御文字が端末を操作するのと、見えない文字が表示を偽るのを防ぐため。
 */
export function escapeForDisplay(text: string): string {
  let out = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (isAllowedCodePoint(codePoint)) out += char;
    else if (codePoint <= 0xff) {
      out += `\\x${codePoint.toString(16).padStart(2, "0")}`;
    } else out += `\\u{${codePoint.toString(16)}}`;
  }
  return out;
}

function hasDisallowedChar(text: string): boolean {
  for (const char of text) {
    if (!isAllowedCodePoint(char.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

type DiffFile = {
  /** `diff --git`から最初の`@@`の前までの行。 */
  readonly header: string[];
  /** 最初の`@@`以降の行。 */
  readonly body: string[];
};

/**
 * `git diff`の出力を、ファイルごとのヘッダーと本文に分ける。
 * 本文の行は先頭の1文字が`+`、`-`、空白、`\`のどれかなので、`diff --git`で始まる行は必ずヘッダーである。
 * そのため、内容が`+++`で始まる追加行も、ヘッダーの`+++`の行と区別できる。
 */
function splitDiff(diff: string): DiffFile[] {
  const files: { header: string[]; body: string[] }[] = [];
  let current: { header: string[]; body: string[] } | null = null;
  let inBody = false;
  const lines = diff.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      current = { header: [line], body: [] };
      files.push(current);
      inBody = false;
    } else if (current === null) {
    } else if (inBody) {
      current.body.push(line);
    } else if (line.startsWith("@@")) {
      inBody = true;
      current.body.push(line);
    } else {
      current.header.push(line);
    }
  }
  return files;
}

/** 差分の追加行の内容(先頭の`+`を除く)。ヘッダーの`+++`の行は含めない。 */
export function addedLines(diff: string): string[] {
  const found: string[] = [];
  for (const file of splitDiff(diff)) {
    for (const line of file.body) {
      if (line.startsWith("+")) found.push(line.slice(1));
    }
  }
  return found;
}

export type AddedViolation = { readonly line: string };

/** 追加行のうち、許可の一覧の外の文字を含むもの。 */
export function findAddedViolations(diff: string): AddedViolation[] {
  return addedLines(diff)
    .filter(hasDisallowedChar)
    .map((line) => ({ line }));
}

/** 確認で入力させる文言。内容を見ずに反射で答えるのを止めるためのもので、agentを止める守りではない。 */
export function confirmationPhrase(target: string): string {
  return `approve ${target.slice(0, 12)}`;
}

const APPROVE_FLAGS: readonly string[] = ["--applied", "--state-dir"];

/**
 * `approve`の引数を読む。形は`<sha> --applied <sha> [--state-dir <絶対パス>]`。
 * `<sha>`は7〜40桁の小文字の16進、`--applied`は40桁。refの名前は受け付けない。
 */
export function parseApproveArgs(argv: readonly string[]): ParsedApproveArgs {
  const [sha, ...rest] = argv;
  if (sha === undefined || !/^[0-9a-f]{7,40}$/.test(sha)) {
    return { ok: false, error: "<sha> must be 7 to 40 lowercase hex digits" };
  }
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === undefined || !APPROVE_FLAGS.includes(flag)) {
      return {
        ok: false,
        error: `unknown argument: ${escapeDetail(flag ?? "")}`,
      };
    }
    if (value === undefined) {
      return { ok: false, error: `${flag} needs a value` };
    }
    if (values.has(flag)) return { ok: false, error: `${flag} given twice` };
    values.set(flag, value);
  }
  const applied = values.get("--applied");
  if (applied === undefined || !isSha40(applied)) {
    return { ok: false, error: "--applied must be a 40-digit sha" };
  }
  const stateDir = values.get("--state-dir") ?? null;
  if (stateDir !== null && !isAbsoluteCleanPath(stateDir)) {
    return {
      ok: false,
      error: "--state-dir must be an absolute path without control characters",
    };
  }
  return { ok: true, args: { sha, applied, stateDir } };
}

/**
 * 行を`pageSize`行ずつ表示する。最後のページより前では、Enterで次へ進み、`q`か入力の終わりで止める。
 * 最後のページの後には何も尋ねない。確認はその後に、呼び出し側が求める。
 */
export async function showPaged(
  lines: readonly string[],
  io: PagerIo,
  pageSize: number = PAGE_SIZE,
): Promise<"done" | "quit"> {
  for (let start = 0; start < lines.length; start += pageSize) {
    for (const line of lines.slice(start, start + pageSize)) io.print(line);
    if (start + pageSize < lines.length) {
      io.print(PAGER_PROMPT);
      const answer = await io.readLine();
      if (answer === null || answer.trim().toLowerCase() === "q") {
        return "quit";
      }
    }
  }
  return "done";
}

/** 注入された実行関数の上に、`approve`が使うgitの読み取りを組み立てる。実行はしない。 */
export function createApproveGit(
  run: GitRunner,
  runLimited: LimitedGitRunner,
): ApproveGit {
  return {
    ...createPlanGit(run),
    async resolveCommit(input) {
      const result = await run(resolveCommitArgs(input));
      const sha = result.stdout.trim();
      return result.code === 0 && isSha40(sha) ? sha : null;
    },
    async originMainTip() {
      const result = await run(showRefArgs(ORIGIN_MAIN_REF));
      const sha = result.stdout.trim().split(" ")[0] ?? "";
      return result.code === 0 && isSha40(sha) ? sha : null;
    },
    async diffPatch(base, target, files) {
      const result = await runLimited(
        diffPatchArgs(base, target, files),
        MAX_DIFF_BYTES,
      );
      if (result.truncated) return { text: "", truncated: true };
      if (result.code !== 0) throw new Error("git diff failed");
      return { text: result.stdout, truncated: false };
    },
  };
}

function isEnvFile(path: string): boolean {
  const basename = path.split("/").pop() ?? path;
  return /^\.env(\..*)?$/i.test(basename);
}

/** 差分のうち、ファイルごとの追加行と削除行の数。 */
function countLines(file: DiffFile): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of file.body) {
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

const MAX_SHOWN_VIOLATIONS = 5;

/**
 * 承認を求める。終了コードを返す。
 * 0は承認を記録した、1は実行の失敗、3は承認しない(門を通らない、判定が承認に値しない、確認が一致しない)。
 * 記録を書くのは、すべての門と確認を通った後の1回だけ。
 */
export async function runApprove(
  args: ApproveArgs,
  deps: ApproveDeps,
): Promise<number> {
  const { io, git } = deps;
  const refuse = (reason: string): number => {
    io.error(`host-apply: refused: ${reason}`);
    return EXIT_REFUSED;
  };
  const fail = (reason: string): number => {
    io.error(`host-apply: ${reason}`);
    return EXIT_FAILED;
  };

  if (!deps.execArgv.includes("--no-env-file")) {
    return refuse("start approve with bun --no-env-file");
  }
  if (isAgentSuspected(deps.env)) {
    return refuse("the environment looks like an agent session");
  }
  if (!deps.isTerminal()) {
    return refuse("stdin and stdout must both be a terminal");
  }
  let origin: OriginCheck;
  try {
    origin = await deps.checkOrigin();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    return refuse(`code origin check failed: ${escapeDetail(reason)}`);
  }
  if (!origin.ok) return refuse(`code origin check failed: ${origin.reason}`);

  try {
    const target = await git.resolveCommit(args.sha);
    if (target === null) return fail("the commit cannot be resolved");
    if (!target.startsWith(args.sha)) {
      return refuse("the input resolved to a commit that it does not start");
    }
    const tip = await git.originMainTip();
    if (tip === null) return refuse("origin/main is not found");
    if (!(await git.isAncestor(target, tip))) {
      return refuse("the commit is not in origin/main");
    }

    const stored = deps.readRecord();
    const prev =
      stored.kind === "found" && stored.record.applied === args.applied
        ? stored.record
        : null;
    const before = await buildPlan(git, {
      applied: args.applied,
      target,
      approved: prev?.sha ?? null,
      approvedFrom: prev?.applied ?? null,
      root: PLAN_ROOT,
    });
    if (before.decision === "noop") {
      return refuse("nothing to approve: the commit is already applied");
    }
    if (before.decision === "would_converge") {
      return refuse("nothing to approve: the change needs no approval");
    }
    if (before.decision === "rejected") {
      return refuse(
        `the change cannot be approved (${before.kind}): ${escapeDetail(before.detail)}`,
      );
    }

    const after = await buildPlan(git, {
      applied: args.applied,
      target,
      approved: target,
      approvedFrom: args.applied,
      root: PLAN_ROOT,
    });
    if (after.decision === "rejected") {
      return refuse(
        `the change is rejected even if approved (${after.kind}): ${escapeDetail(after.detail)}`,
      );
    }
    if (after.decision !== "would_converge") {
      return fail("the plan after approval is not would_converge");
    }

    const { base } = before;
    const changed = await git.changedFiles(base, target);
    const files: ApprovedFile[] = [];
    for (const path of before.files) {
      const status = changed.find((file) => file.path === path)?.status;
      if (status === undefined) return fail("a changed file is not listed");
      if (!isApprovedStatus(status)) {
        return refuse(
          `a file type change is not approved: ${escapeDetail(path)}`,
        );
      }
      files.push({ path, status });
    }
    if (files.some((file) => isEnvFile(file.path))) {
      return refuse(
        "a .env file is in the change: its body could show secrets, so this tool does not approve it",
      );
    }

    const buildRecord = (): ApprovedRecord => ({
      schema: 1,
      sha: target,
      applied: args.applied,
      approved_at: deps.now().toISOString(),
      files,
    });
    try {
      serializeApprovedRecord(buildRecord());
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      return refuse(`the record cannot be written: ${escapeDetail(reason)}`);
    }

    const patch = await git.diffPatch(
      base,
      target,
      files.map((file) => file.path),
    );
    if (patch.truncated) {
      io.error(
        `host-apply: refused: the difference is over ${MAX_DIFF_BYTES / 1024} KiB, so this tool cannot approve it.`,
      );
      io.error("  Before the merge, split the pull request into smaller ones.");
      io.error(
        "  After the merge, approve the commits on main one by one in order. Each approval moves the base forward.",
      );
      io.error(
        "  If a single commit is over the limit, read its diff yourself and run mise run up by hand.",
      );
      return EXIT_REFUSED;
    }
    const violations = findAddedViolations(patch.text);
    if (violations.length > 0) {
      io.error(
        `host-apply: refused: ${violations.length} added line(s) have a character outside the allowed list:`,
      );
      for (const violation of violations.slice(0, MAX_SHOWN_VIOLATIONS)) {
        io.error(`  +${escapeForDisplay(violation.line)}`);
      }
      return EXIT_REFUSED;
    }
    const sections = splitDiff(patch.text);
    if (sections.length !== files.length) {
      return fail("the difference does not match the changed files");
    }

    const lines: string[] = [
      `target: ${target}`,
      `base: ${base}`,
      `applied: ${args.applied} (given by you)`,
      `origin/main: ${tip}`,
      "Compare the origin/main tip with the main branch on GitHub. The ref can be written by your own user.",
      "files:",
      ...files.map((file, index) => {
        const counts = countLines(sections[index] ?? { header: [], body: [] });
        return `  ${file.status} ${escapeForDisplay(file.path)} (+${counts.added} -${counts.removed})`;
      }),
      `plan after approval: ${after.decision}`,
      "--- difference ---",
      ...patch.text
        .split("\n")
        .slice(0, patch.text.endsWith("\n") ? -1 : undefined)
        .map(escapeForDisplay),
    ];
    if ((await showPaged(lines, io)) === "quit") {
      return refuse("stopped before the end of the difference");
    }

    const phrase = confirmationPhrase(target);
    io.print(`Type "${phrase}" to approve. Anything else cancels:`);
    const typed = await io.readLine();
    if (typed !== phrase) return refuse("the confirmation did not match");

    deps.writeRecord(buildRecord());
    io.print(`approved ${target}`);
    return EXIT_OK;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    return fail(escapeDetail(reason));
  }
}
