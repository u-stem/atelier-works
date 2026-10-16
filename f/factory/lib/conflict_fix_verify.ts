// 競合回の検証と完了のステップが共有する、解消の検査の流れ。
// 検査の入力を作るI/O(gitの読み取り、gitleaks)は呼び出し側が注入し、判定は`conflict_fix_round.ts`の純関数に任せる。
// 検証のステップはClaudeの後と検査コマンドの後に、完了のステップはpushの前に呼ぶ。
// 検証と完了の間にworktreeが変わっても、pushする内容そのもので判定するためである。

import type { CiFixChange } from "./ci_fix_paths.ts";
import { collectCiFixChanges, guardCiRoundReasons } from "./ci_fix_round.ts";
import type { CiTextScanner } from "./ci_log_support.ts";
import {
  type ConflictFileInput,
  checkConflictResolution,
  conflictResolutionReasons,
  conflictRoundReason,
  evaluateMergedTree,
  mergedTreeStopDetail,
} from "./conflict_fix_round.ts";
import {
  type BothSidesChangedPaths,
  type CommandRunner,
  type ConflictBlobs,
  type GitleaksConfigDir,
  listBothSidesChangedPaths,
  listTreeChanges,
  readBlobText,
  readTreeFileText,
  reconstructConflictText,
  runGitleaksOnTreeDiff,
  stageConflictPathsTree,
} from "./workspace.ts";

/** 作業ツリーの変更を読み切れなかったときの理由。変更を見落としたまま通さない。 */
export const CONFLICT_WORKTREE_UNREAD_REASON = conflictRoundReason(
  "the changes in the working tree could not be read completely",
);

/** 競合ファイルの一覧と、3つの版のblobの一覧が食い違うときの理由。 */
export const CONFLICT_BLOBS_MISMATCH_REASON = conflictRoundReason(
  "the conflict blobs do not match the conflicted paths",
);

/** 両側が変えたパスが秘密値の検査に当たったときの固定の理由。パスも当たった文字列も含めない。 */
export const CONFLICT_BOTH_SIDES_SECRET_REASON = conflictRoundReason(
  "a path changed on both sides matched the secret scan",
);

/**
 * pushの直前に検査したツリーが、検証のステップが通したツリーと違うときの理由。
 * 検証から完了までの間にworktreeが変わったことを表し、待っても解けないので一時の停止には数えない。
 */
export const CONFLICT_VERIFIED_TREE_CHANGED_REASON = conflictRoundReason(
  "the tree changed after the verification",
);

export type ConflictInspectDeps = {
  /** 競合ファイルだけを`add`した索引のツリーを作り、索引を戻す(`stageConflictPathsTree`)。 */
  readonly stageTree: () => Promise<string>;
  /** 基準コミットからツリーまでの変更を読む(`listTreeChanges`)。 */
  readonly listTreeChanges: (treeSha: string) => Promise<CiFixChange[]>;
  /** 基準コミットから作業ツリーまでの変更を読む。未追跡と無視されたファイルを含む(`collectCiFixChanges`)。 */
  readonly listWorktreeChanges: () => Promise<{
    readonly changes: CiFixChange[];
    readonly overflow: boolean;
    readonly timedOut: boolean;
  }>;
  readonly readBlob: (sha: string) => Promise<string>;
  /** 3つの版から、nonce入りのラベルの衝突マーカー付きの本文を作り直す(`reconstructConflictText`)。 */
  readonly reconstruct: (
    blobs: ConflictBlobs,
    nonce: string,
  ) => Promise<string>;
  /** ツリーの中のファイルの本文を読む(`readTreeFileText`)。 */
  readonly readResult: (treeSha: string, path: string) => Promise<string>;
  /** 結果のツリーがどちらの親とも違うパスを求める(`listBothSidesChangedPaths`)。 */
  readonly listBothSides: (treeSha: string) => Promise<BothSidesChangedPaths>;
  /** PRのheadから結果のツリーまでの差のうち、`paths`だけをgitleaksで検査する。検査できなければ例外を投げる。 */
  readonly scanBothSides: (
    treeSha: string,
    paths: readonly string[],
  ) => Promise<{ readonly ok: boolean; readonly output: string }>;
  /** 止める理由の文字列の検査。 */
  readonly scanText: CiTextScanner;
  /** 作り直しと検査が共有するnonceを作る。英数字の8〜64字。 */
  readonly newNonce: () => string;
};

export type ConflictInspectInput = {
  readonly conflictedPaths: readonly string[];
  readonly conflictBlobs: readonly ConflictBlobs[];
  /** 基準コミットのツリー。競合の無いmergeは、このツリーをそのままpushする。 */
  readonly autoTreeSha: string;
};

/** 競合の無いmergeのツリーが、基準コミットのツリーと違うときの理由。 */
export const CONFLICT_CLEAN_TREE_CHANGED_REASON = conflictRoundReason(
  "the tree of a merge without conflicts differs from the baseline commit",
);

export type ConflictInspection = {
  /** 検査したツリー。pushするmergeコミットのツリーになる。 */
  readonly treeSha: string;
  /** 止める理由。空なら通してよい。外へ出してよい形(検査済み)である。 */
  readonly reasons: string[];
};

export type GitConflictInspectOptions = {
  readonly run: CommandRunner;
  readonly worktreeDir: string;
  readonly conflictedPaths: readonly string[];
  /** 基準コミット。変更はこのコミットとの差で数える。 */
  readonly baselineSha: string;
  /** mergeの第1親のPRのhead。 */
  readonly prHeadSha: string;
  /** mergeの第2親のbaseの先頭。 */
  readonly baseSha: string;
  readonly scanText: CiTextScanner;
  /** 両側が変えたパスの差分を検査するgitleaksの1回のタイムアウト(ミリ秒)。 */
  readonly gitleaksTimeoutMs: number;
  readonly home?: string;
  readonly path?: string;
  readonly newNonce?: () => string;
  readonly createConfigDir?: () => Promise<GitleaksConfigDir>;
};

/** 既定のnonce。ハイフンを除いたUUIDで、英数字の32字になる。 */
function randomNonce(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

/**
 * `inspectConflictResolution`の入力を、worktreeのgitから読む実装にする。
 * 呼び出し側は、`assertWorktreeGitPointer`を通した後で`inspectConflictResolution`を呼ぶ。
 * 読み取りは`workspace.ts`の関数で行い、いずれも作業ファイルのテキストを使わない。
 * 検査の入力にする変更は、基準コミットからのツリーの差と、作業ツリーの差(未追跡と無視されたファイルを含む)から作る。
 */
export function gitConflictInspectDeps(
  opts: GitConflictInspectOptions,
): ConflictInspectDeps {
  const base = {
    run: opts.run,
    worktreeDir: opts.worktreeDir,
    ...(opts.home !== undefined ? { home: opts.home } : {}),
    ...(opts.path !== undefined ? { path: opts.path } : {}),
  };
  return {
    stageTree: () =>
      stageConflictPathsTree({
        ...base,
        conflictedPaths: opts.conflictedPaths,
      }),
    listTreeChanges: (treeSha) =>
      listTreeChanges({
        ...base,
        fromSha: opts.baselineSha,
        toTreeSha: treeSha,
      }),
    listWorktreeChanges: () =>
      collectCiFixChanges(opts.run, opts.worktreeDir, opts.baselineSha, {
        source: "worktree",
      }),
    readBlob: (sha) => readBlobText({ ...base, sha }),
    reconstruct: (blobs, nonce) =>
      reconstructConflictText({ ...base, blobs, nonce }),
    readResult: (treeSha, filePath) =>
      readTreeFileText({ ...base, treeSha, filePath }),
    listBothSides: (treeSha) =>
      listBothSidesChangedPaths({
        ...base,
        prHeadSha: opts.prHeadSha,
        baseSha: opts.baseSha,
        treeSha,
      }),
    scanBothSides: (treeSha, paths) =>
      runGitleaksOnTreeDiff({
        ...base,
        fromSha: opts.prHeadSha,
        toTreeSha: treeSha,
        paths,
        timeoutMs: opts.gitleaksTimeoutMs,
        ...(opts.createConfigDir !== undefined
          ? { createConfigDir: opts.createConfigDir }
          : {}),
      }),
    scanText: opts.scanText,
    newNonce: opts.newNonce ?? randomNonce,
  };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return (
    a.length === b.length &&
    new Set(a).size === a.length &&
    a.every((path) => b.includes(path))
  );
}

/**
 * 解消後のツリーを検査し、止める理由を返す。理由が空なら、そのツリーをpushしてよい。
 * 次の順に進み、理由が出た時点で、それ以降の読み取りと検査はしない。
 * 1. 競合ファイルだけをステージしたツリーを作る。競合の無いmergeは、基準コミットのツリーと同じでなければならない。
 * 2. 結果のツリーがどちらの親とも違うパスを求め、保護パス、workflow、安全でないパスを調べる(`evaluateMergedTree`)。
 * 3. 基準コミットからの変更を集める。ツリーの差に、作業ツリーにだけある変更(競合ファイル以外の編集と新規ファイル)を足す。
 * 4. 競合ファイルごとに3つの版と作り直した本文、解消後の本文を読み、`checkConflictResolution`で調べる。
 * 5. 両側が変えたパスのPRのheadからの差を、gitleaksで検査する。
 * 作り直しと検査は同じnonceを使う。別の値にすると、ブロックの境目が食い違う。
 * 理由に入るパスは外部由来なので、返す前にまとめて1回検査する。
 */
export async function inspectConflictResolution(
  deps: ConflictInspectDeps,
  input: ConflictInspectInput,
): Promise<ConflictInspection> {
  const treeSha = await deps.stageTree();
  const reasons = await findReasons(deps, input, treeSha);
  return {
    treeSha,
    reasons: await guardCiRoundReasons(reasons, deps.scanText),
  };
}

async function findReasons(
  deps: ConflictInspectDeps,
  input: ConflictInspectInput,
  treeSha: string,
): Promise<string[]> {
  const { conflictedPaths } = input;
  if (conflictedPaths.length === 0 && treeSha !== input.autoTreeSha) {
    return [CONFLICT_CLEAN_TREE_CHANGED_REASON];
  }
  const bothSides = await deps.listBothSides(treeSha);
  const tree = evaluateMergedTree({ conflictedPaths, bothSides });
  if (!tree.ok) return [conflictRoundReason(mergedTreeStopDetail(tree.reason))];

  if (
    !sameSet(
      conflictedPaths,
      input.conflictBlobs.map((blobs) => blobs.path),
    )
  ) {
    return [CONFLICT_BLOBS_MISMATCH_REASON];
  }

  const treeChanges = await deps.listTreeChanges(treeSha);
  const worktree = await deps.listWorktreeChanges();
  if (worktree.overflow || worktree.timedOut) {
    return [CONFLICT_WORKTREE_UNREAD_REASON];
  }
  const inTree = new Set(treeChanges.map((change) => change.path));
  const changes = [
    ...treeChanges,
    ...worktree.changes.filter((change) => !inTree.has(change.path)),
  ];

  const nonce = deps.newNonce();
  const deleted = new Set(
    treeChanges
      .filter((change) => change.status === "deleted")
      .map((change) => change.path),
  );
  const files: ConflictFileInput[] = [];
  for (const blobs of input.conflictBlobs) {
    files.push({
      path: blobs.path,
      base: await deps.readBlob(blobs.baseBlob),
      ours: await deps.readBlob(blobs.oursBlob),
      theirs: await deps.readBlob(blobs.theirsBlob),
      reconstructed: await deps.reconstruct(blobs, nonce),
      result: deleted.has(blobs.path)
        ? null
        : await deps.readResult(treeSha, blobs.path),
    });
  }
  const verdict = checkConflictResolution({ nonce, files, changes });
  if (!verdict.ok) return conflictResolutionReasons(verdict.violations);

  if (bothSides.bothSides.length > 0) {
    const scan = await deps.scanBothSides(treeSha, bothSides.bothSides);
    if (!scan.ok) return [CONFLICT_BOTH_SIDES_SECRET_REASON];
  }
  return [];
}
