// 調査のClaudeが読むworktreeの置き場と、その作成・掃除。
// 保護パスに置く。置き場の検査やsymlink・submoduleの断りを緩めると、調査のClaudeがworkerの秘密に届くため。

import { lstat, readdir, rm } from "node:fs/promises";
import type { CommandRunner, LockFs } from "./workspace.ts";

/**
 * 調査のworktreeを置く親。worker imageがrootの所有・0700で作る。
 * `/run`、`/var/lib/factory`、`/tmp`、`/var/tmp`、`/workspaces`の外に置く。
 * 読み出しを塞ぐ一覧の`/var/lib/factory`は区切りまで一致を見るので、`/var/lib/factory-investigate`は塞がれない。
 */
export const INVESTIGATE_ROOT = "/var/lib/factory-investigate";

/** 隔離の測定が使う作業項目IDの代わり。実在の作業項目のIDと重ならない大きな固定値。 */
export const PROBE_RESERVED_ID = 2 ** 52;

export type InvestigateStat = {
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly uid: number;
  readonly mode: number;
};

export type InvestigateFs = {
  readonly lstat: (path: string) => Promise<InvestigateStat | null>;
  readonly readdir: (path: string) => Promise<string[]>;
  readonly rm: (path: string) => Promise<void>;
};

export const realInvestigateFs: InvestigateFs = {
  lstat: async (path) => {
    try {
      const stat = await lstat(path);
      return {
        isDirectory: stat.isDirectory(),
        isSymbolicLink: stat.isSymbolicLink(),
        uid: stat.uid,
        mode: stat.mode & 0o7777,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
  },
  readdir: (path) => readdir(path),
  rm: (path) => rm(path, { recursive: true, force: true }),
};

export class InvestigateWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvestigateWorkspaceError";
  }
}

export function investigateWorktreeDir(
  _workItemId: number,
  _root: string = INVESTIGATE_ROOT,
): string {
  return "";
}

export async function ensureInvestigateRoot(
  _options: { readonly fs?: InvestigateFs; readonly root?: string } = {},
): Promise<void> {}

export type InvestigateWorkspaceOptions = {
  readonly run: CommandRunner;
  readonly mainRepoDir: string;
  readonly root?: string;
  readonly fs?: InvestigateFs;
  readonly home?: string;
  readonly path?: string;
  readonly lockFs?: LockFs;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
};

export type CreateInvestigateWorktreeOptions = InvestigateWorkspaceOptions & {
  readonly workItemId: number;
  readonly sha: string;
  readonly ghToken: string;
};

export async function createInvestigateWorktree(
  _opts: CreateInvestigateWorktreeOptions,
): Promise<{ readonly dir: string }> {
  return { dir: "" };
}

export type PurgeInvestigateRootOptions = InvestigateWorkspaceOptions & {
  readonly keepId?: number;
};

export async function purgeInvestigateRoot(
  _opts: PurgeInvestigateRootOptions,
): Promise<{ readonly removed: readonly string[] }> {
  return { removed: [] };
}
