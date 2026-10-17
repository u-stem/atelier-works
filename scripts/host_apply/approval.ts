/** 人の承認が要る変更の判定。差のパスが、ホストで実行されるファイルに触れるかを見る。 */

import { isMiseConfigPath } from "./mise_policy.ts";

export type ChangedFile = { readonly path: string; readonly status: string };

/**
 * `git diff --name-status -z --no-renames`の出力を読む。
 * パスに改行や空白があっても壊れないよう、NUL区切りで読む。
 * 状態とパスの組になっていない出力は、判定を誤らせないよう例外にする。
 */
export function parseNameStatusZ(output: string): ChangedFile[] {
  const fields = output.split("\0");
  if (fields[fields.length - 1] === "") fields.pop();
  if (fields.length % 2 !== 0) {
    throw new Error("unexpected name-status output");
  }
  const files: ChangedFile[] = [];
  for (let i = 0; i < fields.length; i += 2) {
    files.push({ status: fields[i] ?? "", path: fields[i + 1] ?? "" });
  }
  return files;
}

/**
 * 承認の対象のうち、リポジトリのルートにあるファイル(小文字で書く)。
 * 実行役が、ホストのユーザーの権限で、秘密値を渡して動かす道具と、その判断の前提を決めるもの。
 * `.github/workflows/ci.yml`は、必須チェックを出すworkflowで、書き換えるとチェックを`skipped`にして通せる。
 * `scripts/ci-scope.ts`は、`scope`ジョブとして、どのジョブを動かすかを決める。出力を変えると、同じく必須チェックを`skipped`にできる。
 * `package.json`は含めるが、依存の版だけの変更は`approvalFiles`の免除で外す。
 * `bun run scripts/x.ts`は、同名の`package.json`のscriptがあるとそちらを実行するため。
 * `bun.lock`は含めない。コードを実行する欄を持たないため。
 */
const APPROVAL_EXACT_PATHS: readonly string[] = [
  "scripts/doctor.sh",
  "scripts/bootstrap.sh",
  "scripts/check-docker-version.sh",
  "scripts/custom-tags.ts",
  "scripts/record-host-applied.sh",
  "scripts/host-install.sh",
  "package.json",
  "bunfig.toml",
  ".npmrc",
  ".github/workflows/ci.yml",
  "scripts/ci-scope.ts",
];

/** 承認の対象のディレクトリ(小文字で書く)。実行役の実装。 */
const APPROVAL_PREFIXES: readonly string[] = ["scripts/host_apply/"];

/** 承認の対象のファイル名(小文字で書く)。ディレクトリを問わない。 */
const APPROVAL_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env(\..*)?$/,
  // miseは、設定で有効にしたツールについて、これらをバージョンの指定として読む。
  /^\.[a-z0-9]+-version$/,
  /^\.nvmrc$/,
];

/**
 * `path`が、承認の対象(ホストで実行されるファイル)か。
 * mise設定の全候補を含む。ただし`mise.toml`の値だけの変更は、呼び出し側が`approvalFiles`の免除で外す。
 * APFSは大文字小文字を区別しないので、小文字にそろえて照合する。`Bunfig.toml`も`bunfig.toml`と同じファイルを指す。
 */
export function isApprovalTarget(path: string): boolean {
  const normalized = path.replace(/^\.\//, "").toLowerCase();
  if (APPROVAL_EXACT_PATHS.includes(normalized)) return true;
  if (/^scripts\/host-apply\.[^/]+$/.test(normalized)) return true;
  if (APPROVAL_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return true;
  }
  const basename = normalized.split("/").pop() ?? normalized;
  if (APPROVAL_BASENAME_PATTERNS.some((pattern) => pattern.test(basename))) {
    return true;
  }
  return isMiseConfigPath(normalized);
}

/**
 * 差を取る基準のshaを返す。
 * 適用済みと承認済みのうち新しい方を使う。承認済みが適用済みの子孫で、目標の祖先であるときだけ、承認済みを使う。
 * 基準より後の差だけを評価するので、承認の後に対象のファイルが変われば、また承認が要る。
 */
export function pickApprovalBase(input: {
  readonly applied: string;
  readonly approved: string | null;
  readonly approvedFollowsApplied: boolean;
  readonly approvedPrecedesTarget: boolean;
}): string {
  if (input.approved === null) return input.applied;
  if (!input.approvedFollowsApplied || !input.approvedPrecedesTarget) {
    return input.applied;
  }
  return input.approved;
}

/**
 * 差のうち、承認の対象に触れるファイルのパスを返す。追加、変更、削除のどれも触れたとみなす。
 * `exemptPaths`は、mise設定の値だけの変更として承認を免除するパス。
 */
export function approvalFiles(
  changed: readonly ChangedFile[],
  exemptPaths: ReadonlySet<string>,
): string[] {
  return changed
    .filter(
      (file) => isApprovalTarget(file.path) && !exemptPaths.has(file.path),
    )
    .map((file) => file.path);
}
