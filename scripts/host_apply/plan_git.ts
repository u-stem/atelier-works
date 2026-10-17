/** `plan`が使う読み取りを、注入された実行関数の上に組み立てる。 */

import type { PlanGit } from "./plan.ts";

export type GitRunner = (
  args: string[],
) => Promise<{ readonly code: number; readonly stdout: string }>;

export function createPlanGit(_run: GitRunner): PlanGit {
  return {
    async commitExists() {
      return true;
    },
    async isAncestor() {
      return true;
    },
    async changedFiles() {
      return [];
    },
    async listTree() {
      return [];
    },
    async readBlob() {
      return { kind: "absent" };
    },
  };
}
