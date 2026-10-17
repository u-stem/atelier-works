/** `plan`が使うgitの読み取りを、注入された実行関数の上に組み立てる。実行はしない。 */

import { parseNameStatusZ } from "./approval.ts";
import { MAX_BLOB_BYTES } from "./constants.ts";
import {
  commitExistsArgs,
  diffNameStatusArgs,
  isAncestorArgs,
  lsTreePathArgs,
  lsTreeRecursiveArgs,
  parseLsTreeZ,
  showBlobArgs,
} from "./git.ts";
import type { PlanGit } from "./plan.ts";

export type GitRunner = (
  args: string[],
) => Promise<{ readonly code: number; readonly stdout: string }>;

const REGULAR_FILE_MODES: readonly string[] = ["100644", "100755"];

/**
 * 読み取りのgitの上に`PlanGit`を作る。
 * ファイルの読み取りは、まず`ls-tree`で存在、種類、大きさを確かめる。
 * 無ければ`absent`にし、通常のファイルでなければ`not_regular`、上限を超えれば`too_large`にして、中身は読まない。
 * `ls-tree`や`show`の失敗は、「無い」と区別するため、例外にする。
 */
export function createPlanGit(run: GitRunner): PlanGit {
  return {
    async commitExists(sha) {
      return (await run(commitExistsArgs(sha))).code === 0;
    },
    async isAncestor(ancestor, descendant) {
      const { code } = await run(isAncestorArgs(ancestor, descendant));
      if (code === 0) return true;
      if (code === 1) return false;
      throw new Error("git merge-base failed");
    },
    async changedFiles(base, target) {
      const { code, stdout } = await run(diffNameStatusArgs(base, target));
      if (code !== 0) throw new Error("git diff failed");
      return parseNameStatusZ(stdout);
    },
    async listTree(sha) {
      const { code, stdout } = await run(lsTreeRecursiveArgs(sha));
      if (code !== 0) throw new Error("git ls-tree failed");
      return parseLsTreeZ(stdout).map(({ mode, type, path }) => ({
        mode,
        type,
        path,
      }));
    },
    async readBlob(sha, path) {
      const listing = await run(lsTreePathArgs(sha, path));
      if (listing.code !== 0) throw new Error("git ls-tree failed");
      const entry = parseLsTreeZ(listing.stdout).find(
        (candidate) => candidate.path === path,
      );
      if (entry === undefined) return { kind: "absent" };
      if (entry.type !== "blob" || !REGULAR_FILE_MODES.includes(entry.mode)) {
        return { kind: "not_regular" };
      }
      if (entry.size === null || entry.size > MAX_BLOB_BYTES) {
        return { kind: "too_large" };
      }
      const shown = await run(showBlobArgs(sha, path));
      if (shown.code !== 0) throw new Error("git show failed");
      return { kind: "found", text: shown.stdout };
    },
  };
}
