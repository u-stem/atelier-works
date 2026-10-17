/**
 * 実行しているコードの出どころの検査。
 * 承認の表示を作るコードが書き換えられていると、人は偽の表示に確認の文言を答える。
 * 検査を実行するのは検査される側のコード自身なので、これは誤操作の防止であり、書き換えた側を止める境界ではない。
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  isAncestorArgs,
  isSha40,
  lsTreeShaArgs,
  ORIGIN_MAIN_REF,
  parseLsTreeShaZ,
  resolveHeadArgs,
  revParseQueryArgs,
  showRefArgs,
} from "./git.ts";
import type { GitRunner } from "./plan_git.ts";
import { escapeDetail } from "./stable.ts";

export type OriginCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type CodeOriginInput = {
  /** スクリプト自身のリポジトリのトップで実行するgit。 */
  readonly run: GitRunner;
  /** スクリプト自身のリポジトリのトップ。 */
  readonly repoRoot: string;
  readonly cwd: string;
};

/** 実行するファイルのうち、1つずつ名前で指すもの。 */
const EXECUTED_FILES: readonly string[] = [
  "scripts/host-apply.ts",
  "bunfig.toml",
  "package.json",
];

/** 実行するファイルのうち、下の全ファイルを対象にするディレクトリ。 */
const EXECUTED_DIR = "scripts/host_apply";

const REGULAR_FILE_MODES: readonly string[] = ["100644", "100755"];

/** gitがファイルの内容につけるオブジェクト名(`blob <長さ>\0<内容>`のsha1)。 */
export function gitBlobSha1(content: Uint8Array): string {
  return createHash("sha1")
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest("hex");
}

function failure(reason: string): OriginCheck {
  return { ok: false, reason };
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** 作業ツリーにある、実行するファイルの相対パスと、通常のファイルかどうか。 */
function listWorkTree(root: string): Map<string, boolean> {
  const found = new Map<string, boolean>();
  const walk = (relative: string) => {
    for (const entry of readdirSync(join(root, relative), {
      withFileTypes: true,
    })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else found.set(path, entry.isFile());
    }
  };
  walk(EXECUTED_DIR);
  for (const path of EXECUTED_FILES) {
    try {
      found.set(path, lstatSync(join(root, path)).isFile());
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return found;
}

/**
 * 実行しているコードが、`origin/main`に含まれるコミットの内容と一致するかを確かめる。
 * - コードがメインのチェックアウトにあり、カレントディレクトリがリポジトリのトップである。
 * - 実行するファイル(入口、`scripts/host_apply/`の全ファイル、`bunfig.toml`、`package.json`)の内容が`HEAD`と一致する。
 *   作業ツリーの内容のハッシュを`HEAD`のtreeと照合するので、`skip-worktree`や`.gitignore`では隠せない。
 * - `HEAD`が`origin/main`の先端の祖先(同じを含む)である。
 * 確かめられないときは、通さない側に倒す。
 */
export async function checkCodeOrigin(
  input: CodeOriginInput,
): Promise<OriginCheck> {
  const { run } = input;
  const query = async (
    name: "git-dir" | "git-common-dir" | "show-toplevel",
  ) => {
    const result = await run(revParseQueryArgs(name));
    return result.code === 0 ? result.stdout.trim() : null;
  };
  const [gitDir, commonDir, toplevel] = [
    await query("git-dir"),
    await query("git-common-dir"),
    await query("show-toplevel"),
  ];
  if (gitDir === null || commonDir === null || toplevel === null) {
    return failure("the repository of the code cannot be read");
  }
  if (gitDir !== commonDir) return failure("the code is in a linked worktree");
  if (
    realpathSync(input.cwd) !== realpathSync(toplevel) ||
    realpathSync(input.repoRoot) !== realpathSync(toplevel)
  ) {
    return failure("run from the top of the repository");
  }

  const head = await run(resolveHeadArgs());
  const tip = await run(showRefArgs(ORIGIN_MAIN_REF));
  const headSha = head.stdout.trim();
  const tipSha = tip.stdout.trim().split(" ")[0] ?? "";
  if (tip.code !== 0 || !isSha40(tipSha)) {
    return failure("origin/main is not found");
  }
  if (head.code !== 0 || !isSha40(headSha)) {
    return failure("HEAD cannot be resolved");
  }

  const listing = await run(
    lsTreeShaArgs(headSha, [...EXECUTED_FILES, EXECUTED_DIR]),
  );
  if (listing.code !== 0) return failure("git ls-tree failed");
  const tracked = new Map<string, string>();
  for (const entry of parseLsTreeShaZ(listing.stdout)) {
    if (entry.type !== "blob" || !REGULAR_FILE_MODES.includes(entry.mode)) {
      return failure(
        `HEAD has an executed path that is not a regular file: ${escapeDetail(entry.path)}`,
      );
    }
    tracked.set(entry.path, entry.sha);
  }
  let onDisk: Map<string, boolean>;
  try {
    onDisk = listWorkTree(input.repoRoot);
  } catch {
    return failure("the executed files cannot be read");
  }
  for (const path of new Set([...tracked.keys(), ...onDisk.keys()])) {
    const expected = tracked.get(path);
    const regular = onDisk.get(path);
    const matches =
      expected !== undefined &&
      regular === true &&
      gitBlobSha1(readFileSync(join(input.repoRoot, path))) === expected;
    if (!matches) {
      return failure(
        `an executed file differs from HEAD: ${escapeDetail(path)}`,
      );
    }
  }

  const ancestor = await run(isAncestorArgs(headSha, tipSha));
  if (ancestor.code === 1) return failure("HEAD is not in origin/main");
  if (ancestor.code !== 0) return failure("git merge-base failed");
  return { ok: true };
}
