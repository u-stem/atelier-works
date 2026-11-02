// 調査のClaudeに、読み出しを塞ぐ固定の一覧を渡す設定を作る。
// 保護パスに置く。一覧や書き出しの条件を緩めると、調査のClaudeがworkerの秘密に届くため。
//
// 規則は、Claudeのユーザー設定(`CLAUDE_CONFIG_DIR`の`settings.json`)の`permissions.deny`に書く。
// denyは許可に勝つので、一覧の下に作業ディレクトリを置くと、自分のworktreeまで読めなくなる。
// そのため、作業ディレクトリが一覧の下にあれば、起動の前に例外を投げる。

import { realpathSync } from "node:fs";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, posix, resolve } from "node:path";
import { JOB_TMP_ROOT, jobTmpDirPath } from "./job_tmp.ts";

/** 読み出しの拒否の設定を作れない。メッセージに、直すべき点を載せる。 */
export class ReadDenyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadDenyError";
  }
}

/**
 * 常に塞ぐ場所。
 * 呼び出し側は足すことも外すこともできない。実行時に解決する`$HOME`だけが、`buildReadDenyPaths`で加わる。
 * workerはrootで動き、`--restricted`が作業ディレクトリの外の読み出しを閉じるかを確かめていないため、
 * 環境変数(`/proc`)、ジョブの一時領域(`/run`、`/tmp`、`/var/tmp`)、設定と他のリポジトリ(`/etc`、`/workspaces`、`/root`)を、
 * 一覧で塞ぐ。
 */
export const READ_DENY_BASE_PATHS: readonly string[] = [
  "/proc",
  "/dev/fd",
  "/dev/stdin",
  "/run",
  "/var/lib/factory",
  "/root",
  "/tmp",
  "/var/tmp",
  "/etc",
  "/workspaces",
  "/tmp/windmill",
];

/** 規則の書式に紛れ込むと意味が変わる文字。 */
const UNSAFE_PATH_CHARACTERS = /[\0()*?[\]{}!]/;

/**
 * 塞ぐパスとして使える絶対パスか確かめ、末尾のスラッシュを除いて返す。
 * `..`や重なったスラッシュを含む綴りは、別の場所を指しうるので受けない。
 * ルートは全体を塞ぐので受けない。
 */
function normalizeDenyPath(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (
    !trimmed.startsWith("/") ||
    trimmed === "/" ||
    UNSAFE_PATH_CHARACTERS.test(trimmed) ||
    posix.normalize(trimmed) !== trimmed
  ) {
    throw new ReadDenyError(
      `deny path must be a normalized absolute path other than "/" without glob characters: ${JSON.stringify(path)}`,
    );
  }
  return trimmed;
}

/** 固定の一覧に、実行時に解決した`$HOME`を足す。すでに一覧にあるときは足さない。 */
export function buildReadDenyPaths(home: string): readonly string[] {
  const normalized = normalizeDenyPath(home);
  return READ_DENY_BASE_PATHS.includes(normalized)
    ? [...READ_DENY_BASE_PATHS]
    : [...READ_DENY_BASE_PATHS, normalized];
}

/** 各パスについて、パス自身と、その下すべてを塞ぐ規則を返す。 */
export function readDenyRules(paths: readonly string[]): string[] {
  return paths.flatMap((path) => {
    const normalized = normalizeDenyPath(path);
    return [`Read(/${normalized})`, `Read(/${normalized}/**)`];
  });
}

/** `settings.json`の本文。 */
export function buildReadDenySettings(paths: readonly string[]): string {
  return `${JSON.stringify({ permissions: { deny: readDenyRules(paths) } }, null, 2)}\n`;
}

function isSameOrBelow(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * 作業ディレクトリが、塞ぐパスの下にないことを確かめる。あれば例外を投げる。
 * 綴りの上の位置と、symlinkをたどった実際の位置の両方を見る。
 * 実際の位置は、存在しないパスでは求まらないので、そのときは綴りだけを見る。
 */
export function assertCwdOutsideDeny(
  cwd: string,
  paths: readonly string[],
  realpathOf: (path: string) => string | null = realpathOrNull,
): void {
  if (!isAbsolute(cwd)) {
    throw new ReadDenyError(`cwd must be an absolute path: ${cwd}`);
  }
  const lexical = resolve(cwd);
  const real = realpathOf(lexical);
  const candidates = real === null ? [lexical] : [lexical, real];
  for (const path of paths) {
    const denied = normalizeDenyPath(path);
    const hit = candidates.find((candidate) =>
      isSameOrBelow(candidate, denied),
    );
    if (hit !== undefined) {
      throw new ReadDenyError(
        `cwd ${cwd} is below the denied path ${denied}: the deny rules would also block the working directory`,
      );
    }
  }
}

/** ジョブの環境と、ジョブごとのディレクトリを置く親。テストで差し替える。 */
export type ReadDenyContext = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly root?: string;
};

/**
 * 使う設定の置き場が、このジョブ専用のディレクトリの下であることを確かめ、正規化して返す。
 * 満たさなければ例外を投げる。人の永続設定や他のジョブの設定に、拒否の規則を書かないためである。
 * 置き場を指定しなかった場合に落ちる環境変数や既定の場所は、このジョブ専用でないので、ここで断られる。
 */
export function assertJobConfigDir(
  configDir: string | undefined,
  context: ReadDenyContext = {},
): string {
  const jobDir = jobTmpDirPath(
    context.env ?? process.env,
    context.root ?? JOB_TMP_ROOT,
  );
  if (jobDir === null) {
    throw new ReadDenyError(
      "WM_JOB_ID is not a job id: the read deny settings need the directory of this job",
    );
  }
  if (configDir === undefined || !isAbsolute(configDir)) {
    throw new ReadDenyError(
      "CLAUDE_CONFIG_DIR must be an absolute path below the directory of this job",
    );
  }
  const resolved = resolve(configDir);
  if (!resolved.startsWith(`${jobDir}/`)) {
    throw new ReadDenyError(
      `CLAUDE_CONFIG_DIR ${configDir} is not below the directory of this job (${jobDir})`,
    );
  }
  return resolved;
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * 拒否の規則を、このジョブの設定の置き場の`settings.json`に書く。起動の前に呼ぶ。
 * 書く前に、作業ディレクトリ、一覧、置き場を確かめ、どれかが満たさなければ何も書かずに例外を投げる。
 * 置き場は、symlinkをたどった実際の位置もジョブのディレクトリの下であることを確かめる。
 * `settings.json`がsymlinkのときは、その先に書かないよう例外を投げる。
 */
export async function prepareReadDenySettings(input: {
  readonly readDenyPaths: readonly string[];
  readonly configDir: string | undefined;
  readonly cwd: string;
  readonly context?: ReadDenyContext;
}): Promise<void> {
  if (input.readDenyPaths.length === 0) {
    throw new ReadDenyError(
      "readDenyPaths must not be empty: an empty list would deny nothing",
    );
  }
  const content = buildReadDenySettings(input.readDenyPaths);
  assertCwdOutsideDeny(input.cwd, input.readDenyPaths);
  const configDir = assertJobConfigDir(input.configDir, input.context);

  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const stat = await lstat(configDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ReadDenyError(
      `CLAUDE_CONFIG_DIR ${configDir} is not a plain directory`,
    );
  }
  const jobDir = jobTmpDirPath(
    input.context?.env ?? process.env,
    input.context?.root ?? JOB_TMP_ROOT,
  );
  if (jobDir === null) {
    throw new ReadDenyError("WM_JOB_ID is not a job id");
  }
  const realConfigDir = await realpath(configDir);
  const realJobDir = await realpath(jobDir);
  if (!realConfigDir.startsWith(`${realJobDir}/`)) {
    throw new ReadDenyError(
      `CLAUDE_CONFIG_DIR ${configDir} resolves outside the directory of this job`,
    );
  }

  const file = `${configDir}/settings.json`;
  const existing = await lstatOrNull(file);
  if (existing !== null && !existing.isFile()) {
    throw new ReadDenyError(`${file} is not a regular file`);
  }
  await writeFile(file, content, { mode: 0o600 });
}
