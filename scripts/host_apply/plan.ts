/** `plan`の判定。gitの読み取りは`PlanGit`として注入し、この関数は何も実行しない。 */

import { join } from "node:path";
import {
  approvalFiles,
  type ChangedFile,
  pickApprovalBase,
} from "./approval.ts";
import { checkComposeText } from "./compose_policy.ts";
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
 * - ASCIIの印字できる文字以外(ASCII以外の文字と制御文字)を含むパス。`ſcripts/doctor.sh`や、ケルビン記号の`K`を使った`docKer-compose.yml`は、
 *   大文字小文字を畳む照合やUnicode正規化で、ASCIIのファイルと同じ名前になりうる。
 * - ASCIIの小文字にそろえると、ディレクトリを含めて衝突するパス。大文字小文字を区別しないファイルシステムで同じファイルになる。
 * - composeが自動で読むoverrideファイル。定義を後から上書きできる。
 * 前提は、1つのパスが1つのファイルを指すこと。
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

/**
 * 反映が進むかを、gitのオブジェクトの読み取りだけで判定する。CIの確認はしない(ネットワークに触れない)。
 * 手順は実行役と同じ順にする。
 * 先端が適用済みと同じか祖先ならnoop、子孫でなければ`not_ff`、treeにsymlinkかsubmoduleがあれば`tree_forbidden`、
 * 承認が要る変更があれば承認待ち、
 * 静的な検査(mise設定、composeの許可リスト)に通らなければ拒否、すべて通れば`would_converge`にする。
 * 承認の基準は、適用済みと承認済みのうち新しい方。
 * shaが40桁の16進でない、またはコミットが無いときは例外にする。
 */
export async function buildPlan(
  git: PlanGit,
  input: PlanInput,
): Promise<PlanResult> {
  const { applied, target } = input;
  for (const sha of [applied, target, input.approved]) {
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

  const tree = await git.listTree(target);
  const forbiddenPaths = [
    ...new Set([...forbiddenTreePaths(tree), ...suspiciousTreePaths(tree)]),
  ];
  if (forbiddenPaths.length > 0) {
    return reject(
      "tree_forbidden",
      forbiddenPaths.slice(0, DETAIL_PATH_LIMIT).map(escapeDetail).join(", "),
    );
  }

  let approved = input.approved;
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

  const targetRead = await git.readBlob(target, MISE_PATH);
  const targetMise = targetRead.kind === "found" ? targetRead.text : null;
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

  if (targetMise === null) {
    return reject("mise_forbidden", unreadableReason(targetRead, MISE_PATH));
  }
  const mise = checkMiseStatic(targetMise);
  if (!mise.ok) return reject("mise_forbidden", mise.reason);

  const composeRead = await git.readBlob(target, COMPOSE_PATH);
  if (composeRead.kind !== "found") {
    return reject(
      "compose_forbidden",
      unreadableReason(composeRead, COMPOSE_PATH),
    );
  }
  const compose = checkComposeText(composeRead.text, {
    root: input.root,
    composeDir: join(input.root, "infra"),
    env: mise.env,
  });
  if (!compose.ok) return reject(compose.kind, compose.detail);

  return { decision: "would_converge", ci: "not_checked", applied, target };
}

export type PlanArgs = {
  readonly repo: string;
  readonly applied: string;
  readonly target: string;
  readonly approved: string | null;
};

export type ParsedPlanArgs =
  | { readonly ok: true; readonly args: PlanArgs }
  | { readonly ok: false; readonly error: string };

const PLAN_FLAGS: readonly string[] = [
  "--repo",
  "--applied",
  "--target",
  "--approved",
];

/**
 * `plan`の引数を読む。
 * `--repo`、`--applied`、`--target`が必須で、`--approved`は任意。shaは40桁の16進だけを受け付ける。
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
  return { ok: true, args: { repo, applied, target, approved } };
}
