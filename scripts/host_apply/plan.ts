/** `plan`の判定。gitの読み取りは`PlanGit`として注入し、この関数は何も実行しない。 */

import { join } from "node:path";
import {
  approvalFiles,
  type ChangedFile,
  pickApprovalBase,
} from "./approval.ts";
import { checkComposeText } from "./compose_policy.ts";
import {
  type ComposeViolation,
  checkComposeTablesText,
} from "./compose_tables.ts";
import { isSha40 } from "./git.ts";
import { checkMiseStatic, classifyMiseTomlChange } from "./mise_policy.ts";
import { classifyPackageJsonChange } from "./package_policy.ts";
import { escapeDetail } from "./stable.ts";
import type { RejectionKind } from "./target.ts";

export type TreeEntry = {
  readonly mode: string;
  readonly type: string;
  readonly path: string;
};

/** ファイルの読み取りの結果。`absent`は無い、他は読まなかった理由。 */
export type BlobRead =
  | { readonly kind: "found"; readonly text: string }
  | { readonly kind: "absent" }
  | { readonly kind: "too_large" }
  | { readonly kind: "not_regular" };

/** `plan`が使うgitの読み取り。 */
export type PlanGit = {
  commitExists(sha: string): Promise<boolean>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  changedFiles(base: string, target: string): Promise<ChangedFile[]>;
  /** コミットのtreeの全エントリ。 */
  listTree(sha: string): Promise<TreeEntry[]>;
  /** コミットのファイルの内容。読めない失敗は例外にする。 */
  readBlob(sha: string, path: string): Promise<BlobRead>;
};

export type PlanInput = {
  readonly applied: string;
  readonly target: string;
  readonly approved: string | null;
  /**
   * 承認の記録が示す、承認のときの適用済みのsha。
   * 与えられたとき、実際の適用済みと一致しなければ、承認を使わない。
   * 実際の適用済みより古くても新しくても、承認が見ていない変更(変更して戻した差など)を隠しうるため、祖先や子孫は認めない。
   * 与えなければ(`--approved`)、承認を無条件に使う。
   */
  readonly approvedFrom?: string | null;
  /** パスの内外の判定に使う、ステージングのルートの論理的な絶対パス。実在しなくてよい。 */
  readonly root: string;
};

export type PlanResult =
  | {
      readonly decision: "noop";
      readonly applied: string;
      readonly target: string;
    }
  | {
      readonly decision: "rejected";
      readonly kind: RejectionKind;
      readonly detail: string;
      readonly applied: string;
      readonly target: string;
    }
  | {
      readonly decision: "pending_approval";
      readonly base: string;
      readonly files: readonly string[];
      readonly applied: string;
      readonly target: string;
    }
  | {
      readonly decision: "would_converge";
      readonly ci: "not_checked";
      readonly applied: string;
      readonly target: string;
    };

const MISE_PATH = "mise.toml";
const PACKAGE_PATH = "package.json";
const COMPOSE_PATH = "infra/docker-compose.yml";

/** symlink(120000)とsubmodule(160000)のmode。treeの中にあると、実行役が読むファイルの中身を差し替えられる。 */
const FORBIDDEN_TREE_MODES: readonly string[] = ["120000", "160000"];

/** treeのエントリのうち、symlinkとsubmoduleのパスを返す。 */
export function forbiddenTreePaths(entries: readonly TreeEntry[]): string[] {
  return entries
    .filter((entry) => FORBIDDEN_TREE_MODES.includes(entry.mode))
    .map((entry) => entry.path);
}

/**
 * treeのパスのうち、1つのパスが2つのファイルを指しうるものを返す。
 * - ASCIIの印字できる文字以外(ASCII以外の文字と制御文字)を含むパス。先頭をU+017Fの文字にした`doctor.sh`のパスや、U+212A(ケルビン記号)を使った`docker-compose.yml`のパスは、
 *   大文字小文字を畳む照合やUnicode正規化で、ASCIIのファイルと同じ名前になりうる。
 * - ASCIIの小文字にそろえると、ディレクトリを含めて衝突するパス。大文字小文字を区別しないファイルシステムで同じファイルになる。
 * - composeが自動で読むoverrideファイル。定義を後から上書きできる。
 * 前提は、1つのパスが1つのファイルを指すこと。
 * 別の規則として、`.env`系のファイル(ディレクトリを問わない)も返す。
 * composeが補間に読み、中身は承認の対象にならないため、取り出した木に置かせない。
 */
export function suspiciousTreePaths(entries: readonly TreeEntry[]): string[] {
  const bad = new Set<string>();
  const forms = new Map<string, Set<string>>();
  for (const { path } of entries) {
    if (/[^\x20-\x7e]/.test(path)) bad.add(path);
    const basename = path.split("/").pop() ?? path;
    if (/^(?:docker-)?compose\.override\.ya?ml$/i.test(basename)) {
      bad.add(path);
    }
    if (/^\.env(?:\..*)?$/i.test(basename)) bad.add(path);
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      const key = prefix.toLowerCase();
      const seen = forms.get(key) ?? new Set<string>();
      seen.add(prefix);
      forms.set(key, seen);
    }
  }
  for (const seen of forms.values()) {
    if (seen.size > 1) for (const form of seen) bad.add(form);
  }
  return [...bad];
}

const DETAIL_PATH_LIMIT = 5;

/** `BlobRead`が読めなかった理由を、ログに書ける短い文にする。ファイルの中身は含めない。 */
function unreadableReason(read: BlobRead, name: string): string {
  if (read.kind === "too_large") return `${name} is over the size limit`;
  if (read.kind === "not_regular") return `${name} is not a regular file`;
  return `${name} is missing`;
}

export type StaticRejection = {
  readonly ok: false;
  readonly kind: RejectionKind;
  readonly detail: string;
};

export type StaticPass = {
  readonly ok: true;
  /** 承認すれば通せるcomposeの違反。今の`plan`の判定は変えない。 */
  readonly violations: readonly ComposeViolation[];
};

/**
 * 目標のtreeの検査。symlink、submodule、1つのパスが2つのファイルを指しうるパス、`.env`系を拒否する。
 * 承認の判定より前に行う。通れば`null`。
 */
export async function checkTargetTree(
  git: PlanGit,
  input: { readonly target: string },
): Promise<{ kind: RejectionKind; detail: string } | null> {
  const tree = await git.listTree(input.target);
  const forbiddenPaths = [
    ...new Set([...forbiddenTreePaths(tree), ...suspiciousTreePaths(tree)]),
  ];
  if (forbiddenPaths.length === 0) return null;
  return {
    kind: "tree_forbidden",
    detail: forbiddenPaths
      .slice(0, DETAIL_PATH_LIMIT)
      .map(escapeDetail)
      .join(", "),
  };
}

/**
 * 目標のmise設定とcomposeの静的な検査。承認の判定より後に行う。
 * composeが方針に合い、表の検査が拒否しなければ、承認すれば通せる違反を添えて返す。
 */
export async function checkTargetConfig(
  git: PlanGit,
  input: { readonly target: string; readonly root: string },
): Promise<StaticRejection | StaticPass> {
  const { target } = input;
  const rejected = (kind: RejectionKind, detail: string): StaticRejection => ({
    ok: false,
    kind,
    detail,
  });
  const targetRead = await git.readBlob(target, MISE_PATH);
  if (targetRead.kind !== "found") {
    return rejected("mise_forbidden", unreadableReason(targetRead, MISE_PATH));
  }
  const mise = checkMiseStatic(targetRead.text);
  if (!mise.ok) return rejected("mise_forbidden", mise.reason);

  const composeRead = await git.readBlob(target, COMPOSE_PATH);
  if (composeRead.kind !== "found") {
    return rejected(
      "compose_forbidden",
      unreadableReason(composeRead, COMPOSE_PATH),
    );
  }
  const compose = checkComposeText(composeRead.text, {
    root: input.root,
    composeDir: join(input.root, "infra"),
    env: mise.env,
  });
  if (!compose.ok) return rejected(compose.kind, compose.detail);
  const tables = checkComposeTablesText(composeRead.text);
  if (!tables.ok) return rejected("compose_forbidden", tables.detail);
  return { ok: true, violations: tables.violations };
}

/**
 * 目標のtreeとmise設定とcomposeの静的な検査の全体。祖先の検査と承認は含まない。
 * `init`が適用済みのtreeに当てる入口。
 */
export async function checkTargetStatic(
  git: PlanGit,
  input: { readonly target: string; readonly root: string },
): Promise<StaticRejection | StaticPass> {
  const tree = await checkTargetTree(git, input);
  if (tree !== null) return { ok: false, ...tree };
  return checkTargetConfig(git, input);
}

/**
 * 反映が進むかを、gitのオブジェクトの読み取りだけで判定する。CIの確認はしない(ネットワークに触れない)。
 * 手順は実行役と同じ順にする。
 * 先端が適用済みと同じか祖先ならnoop、子孫でなければ`not_ff`、treeにsymlinkかsubmoduleがあれば`tree_forbidden`、
 * 承認が要る変更があれば承認待ち、
 * 静的な検査(mise設定、composeの許可リスト)に通らなければ拒否、すべて通れば`would_converge`にする。
 * 承認の基準は、適用済みと承認済みのうち新しい方。承認は、`approvedFrom`が与えられたとき、それが適用済みと一致する場合だけ使う。
 * shaが40桁の16進でない、またはコミットが無いときは例外にする。
 */
export async function buildPlan(
  git: PlanGit,
  input: PlanInput,
): Promise<PlanResult> {
  const { applied, target } = input;
  for (const sha of [
    applied,
    target,
    input.approved,
    input.approvedFrom ?? null,
  ]) {
    if (sha !== null && !isSha40(sha)) {
      throw new Error("sha must be 40 lowercase hex digits");
    }
  }
  if (!(await git.commitExists(applied)) || !(await git.commitExists(target))) {
    throw new Error("commit not found");
  }
  const reject = (kind: RejectionKind, detail: string): PlanResult => ({
    decision: "rejected",
    kind,
    detail,
    applied,
    target,
  });

  if (target === applied || (await git.isAncestor(target, applied))) {
    return { decision: "noop", applied, target };
  }
  if (!(await git.isAncestor(applied, target))) {
    return reject("not_ff", "the target does not descend from the applied sha");
  }

  const treeRejection = await checkTargetTree(git, { target });
  if (treeRejection !== null) {
    return reject(treeRejection.kind, treeRejection.detail);
  }

  let approved = input.approved;
  if (input.approvedFrom !== undefined && input.approvedFrom !== applied) {
    approved = null;
  }
  if (approved !== null && !(await git.commitExists(approved))) approved = null;
  const base = pickApprovalBase({
    applied,
    approved,
    approvedFollowsApplied:
      approved !== null && (await git.isAncestor(applied, approved)),
    approvedPrecedesTarget:
      approved !== null && (await git.isAncestor(approved, target)),
  });
  const changed = await git.changedFiles(base, target);

  const exempt = new Set<string>();
  const exemptIfNotApproval = async (
    path: string,
    classify: (base: string | null, target: string) => string,
  ) => {
    if (!changed.some((file) => file.path === path)) return;
    const targetFile = await git.readBlob(target, path);
    if (targetFile.kind !== "found") return;
    const baseFile = await git.readBlob(base, path);
    const baseText = baseFile.kind === "found" ? baseFile.text : null;
    if (classify(baseText, targetFile.text) !== "approval") exempt.add(path);
  };
  await exemptIfNotApproval(MISE_PATH, classifyMiseTomlChange);
  await exemptIfNotApproval(PACKAGE_PATH, classifyPackageJsonChange);
  const files = approvalFiles(changed, exempt);
  if (files.length > 0) {
    return { decision: "pending_approval", base, files, applied, target };
  }

  const config = await checkTargetConfig(git, { target, root: input.root });
  if (!config.ok) return reject(config.kind, config.detail);

  return { decision: "would_converge", ci: "not_checked", applied, target };
}

export type PlanArgs = {
  readonly repo: string;
  readonly applied: string;
  readonly target: string;
  readonly approved: string | null;
  /** 承認の記録を置いたディレクトリ。`--approved`とは同時に指定できない。 */
  readonly stateDir: string | null;
};

export type ParsedPlanArgs =
  | { readonly ok: true; readonly args: PlanArgs }
  | { readonly ok: false; readonly error: string };

/** `/`で始まり、制御文字(NUL、DEL、C1を含む)を含まないパスか。 */
export function isAbsoluteCleanPath(value: string): boolean {
  if (!value.startsWith("/")) return false;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

const PLAN_FLAGS: readonly string[] = [
  "--repo",
  "--applied",
  "--target",
  "--approved",
  "--state-dir",
];

/**
 * `plan`の引数を読む。
 * `--repo`、`--applied`、`--target`が必須で、`--approved`と`--state-dir`は任意。shaは40桁の16進だけを受け付ける。
 * `--state-dir`は、制御文字を含まない絶対パスだけを受け付ける。`--approved`とは同時に指定できない。
 * 未知のフラグ、重複、値の無いフラグは拒否する。
 */
export function parsePlanArgs(argv: readonly string[]): ParsedPlanArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined || !PLAN_FLAGS.includes(flag)) {
      return { ok: false, error: `unknown flag: ${flag ?? ""}` };
    }
    if (value === undefined) {
      return { ok: false, error: `${flag} needs a value` };
    }
    if (values.has(flag)) return { ok: false, error: `${flag} given twice` };
    values.set(flag, value);
  }
  const repo = values.get("--repo");
  const applied = values.get("--applied");
  const target = values.get("--target");
  const approved = values.get("--approved") ?? null;
  if (repo === undefined || repo === "") {
    return { ok: false, error: "--repo is required" };
  }
  if (applied === undefined || !isSha40(applied)) {
    return { ok: false, error: "--applied must be a 40-digit sha" };
  }
  if (target === undefined || !isSha40(target)) {
    return { ok: false, error: "--target must be a 40-digit sha" };
  }
  if (approved !== null && !isSha40(approved)) {
    return { ok: false, error: "--approved must be a 40-digit sha" };
  }
  const stateDir = values.get("--state-dir") ?? null;
  if (stateDir !== null && !isAbsoluteCleanPath(stateDir)) {
    return {
      ok: false,
      error: "--state-dir must be an absolute path without control characters",
    };
  }
  if (approved !== null && stateDir !== null) {
    return { ok: false, error: "--approved and --state-dir are exclusive" };
  }
  return { ok: true, args: { repo, applied, target, approved, stateDir } };
}
