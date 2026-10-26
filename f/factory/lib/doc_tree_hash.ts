// 要件定義のディレクトリの内容のハッシュと、保存した基準値との照合。
// 承認された要件定義が、承認の後に書き換わっていないことを確かめるために、
// 要件定義の保存、設計の生成、実装の関門が共有する。

import { lstat, readdir, readFile, readlink } from "node:fs/promises";

/** 設計の実行の前に、承認済みの要件定義のディレクトリが基準値と違ったときの`needs_human`の理由。 */
export const REQUIREMENTS_MODIFIED_BEFORE_DESIGN_REASON =
  "approved requirements were modified before design";

/** 設計の実行の間に、承認済みの要件定義のディレクトリが書き換わったときの`needs_human`の理由。 */
export const REQUIREMENTS_MODIFIED_REASON =
  "approved requirements were modified during design";

/** 実装の関門(準備と、Claudeの実行ごとの複製)で、承認済みの要件定義のディレクトリが基準値と違ったときの`needs_human`の理由。 */
export const REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON =
  "approved requirements were modified before implementation";

/**
 * 基準値が保存されているのに、承認済みの要件定義のディレクトリが無いときの`needs_human`の理由。
 * workerやボリュームの作り直しで消えた場合で、書き換えとは原因が違うので分ける。
 */
export const REQUIREMENTS_DIR_MISSING_REASON =
  "approved requirements directory is missing";

/**
 * ディレクトリ以外の項目の種類。
 * 通常のファイルとシンボリックリンクと特殊ファイルを、中身が同じ文字列でも別のものとして数えるために、ハッシュに種類の印を入れる。
 */
export type DirectoryEntryKind = "file" | "link" | "special";

/** 種類ごとの印。ハッシュに入れる。 */
const ENTRY_KIND_MARKS: Readonly<Record<DirectoryEntryKind, string>> = {
  file: "F",
  link: "L",
  special: "S",
};

/** `hashDirectoryTree`が使うディレクトリの読み取り。テストでは差し替える。 */
export type DirectoryEntryIo = {
  readonly readDir: (
    dir: string,
  ) => Promise<{ readonly name: string; readonly isDirectory: boolean }[]>;
  /**
   * ディレクトリ以外の項目の種類と中身を返す。
   * リンクの中身はリンク先の文字列で、特殊ファイルの中身は空である。
   */
  readonly readFile: (path: string) => Promise<{
    readonly kind: DirectoryEntryKind;
    readonly content: Uint8Array;
  }>;
  /** `path`自体がシンボリックリンクか。`path`が無ければ`false`を返す。 */
  readonly isSymbolicLink: (path: string) => Promise<boolean>;
};

/**
 * 基準のルートのディレクトリが、シンボリックリンクに置き換えられていたときの例外。
 * リンクの先に同じ内容のディレクトリを置くと、中身のハッシュは基準値と一致してしまうため、読まずに止める。
 */
export class DocTreeRootSymlinkError extends Error {
  constructor(dir: string) {
    super(`the requirements directory is a symbolic link: ${dir}`);
    this.name = "DocTreeRootSymlinkError";
  }
}

/**
 * 例外が`codes`のどれかを表すか。
 * ファイルシステムの例外には`code`が付くので、あれば`code`だけで判定する。
 * messageにはパスが入り、`ENOENT.md`のような名前のファイルで別の例外が起きても部分一致してしまうためである。
 * `code`が無い(`undefined`)ときだけ、messageの部分一致で判定する。
 */
function hasErrorCode(err: unknown, codes: readonly string[]): boolean {
  if (!(err instanceof Error)) return false;
  const code = Reflect.get(err, "code");
  if (code !== undefined)
    return typeof code === "string" && codes.includes(code);
  return codes.some((candidate) => err.message.includes(candidate));
}

function isMissingError(err: unknown): boolean {
  return hasErrorCode(err, ["ENOENT"]);
}

/** 読んでいる途中で項目が消えた、またはディレクトリがファイルに置き換わった例外か。 */
function isEntryGoneError(err: unknown): boolean {
  return hasErrorCode(err, ["ENOENT", "ENOTDIR"]);
}

/** 本番でルートのディレクトリの有無を調べる。シンボリックリンクはたどらない。消えたか置き換わった例外は「無い」、ほかの例外は投げる。 */
async function realRootExists(dir: string): Promise<boolean> {
  try {
    await lstat(dir);
    return true;
  } catch (err) {
    if (isEntryGoneError(err)) return false;
    throw err;
  }
}

/**
 * `dir`以下の内容(相対パスの一覧と、ファイルの中身)のSHA-256を16進で返す。ディレクトリが無ければ`null`を返す。
 * 名前の一覧は並べ替えて数え、名前と中身は長さを前置きして区切る。名前の終わりと中身の始まりが紛れないようにするため。
 * 通常のファイル、シンボリックリンク、特殊ファイルは、種類の印(`F`、`L`、`S`)を前置きして数える。
 * 中身が`symlink:/x`の通常のファイルと、`/x`へのリンクが、同じハッシュにならないようにするため。
 * `dir`自体がシンボリックリンクなら、たどらずに`DocTreeRootSymlinkError`を投げる。
 * 保存した基準値や実行の前後と比べ、承認済みの要件定義の書き換え(変更、追加、削除、改名)を検出する。
 */
export async function hashDirectoryTree(
  dir: string,
  io: DirectoryEntryIo,
): Promise<string | null> {
  const hasher = new Bun.CryptoHasher("sha256");
  const walk = async (
    path: string,
    prefix: string,
    listed: Awaited<ReturnType<DirectoryEntryIo["readDir"]>>,
  ): Promise<void> => {
    const entries = [...listed].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory) {
        hasher.update(`D${String(relative.length)}:${relative}\n`);
        await walk(
          `${path}/${entry.name}`,
          `${relative}/`,
          await io.readDir(`${path}/${entry.name}`),
        );
        continue;
      }
      const { kind, content } = await io.readFile(`${path}/${entry.name}`);
      hasher.update(
        `${ENTRY_KIND_MARKS[kind]}${String(relative.length)}:${relative}\n${String(content.length)}:`,
      );
      hasher.update(content);
    }
  };
  // ルートがリンクなら、中身を読む前に止める。リンクの先の内容は、ルートの内容として数えない。
  if (await io.isSymbolicLink(dir)) throw new DocTreeRootSymlinkError(dir);
  // ルートのディレクトリが無いときだけ`null`を返す。途中の項目が消えたときの例外はそのまま投げ、`checkDocTreeHash`がルートの有無を調べ直して、書き換えか欠落かに分ける。
  let root: Awaited<ReturnType<DirectoryEntryIo["readDir"]>>;
  try {
    root = await io.readDir(dir);
  } catch (err) {
    if (isMissingError(err)) return null;
    throw err;
  }
  await walk(dir, "", root);
  return hasher.digest("hex");
}

/** 本番で`hashDirectoryTree`に渡す読み取り。シンボリックリンクはたどらず、リンク先の文字列を中身として扱う。 */
export const realDirectoryIo: DirectoryEntryIo = {
  readDir: async (dir) =>
    (await readdir(dir, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    })),
  readFile: async (path) => {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      return {
        kind: "link",
        content: new TextEncoder().encode(await readlink(path)),
      };
    }
    if (!stat.isFile()) return { kind: "special", content: new Uint8Array() };
    return { kind: "file", content: new Uint8Array(await readFile(path)) };
  },
  isSymbolicLink: async (path) => {
    try {
      return (await lstat(path)).isSymbolicLink();
    } catch (err) {
      if (isEntryGoneError(err)) return false;
      throw err;
    }
  },
};

/**
 * 基準値との照合の結果。
 * `no_baseline`は基準値が無い(保存前に作られた下書き、列が無い間に保存した下書き)ので、照合できなかったことを表す。
 */
export type DocHashCheck = "match" | "no_baseline" | "missing" | "modified";

/**
 * `dir`の現在のハッシュを`baseline`と比べる。
 * 基準値が`null`、`undefined`、空文字列なら、ディレクトリを読まずに`no_baseline`を返す。
 * 基準値があるのにディレクトリが無ければ`missing`、内容が違えば`modified`を返す。
 * ハッシュを数えている途中で項目が消えたか置き換わった例外(ENOENT、ENOTDIR)を受けたときは、
 * ルートのディレクトリを調べ直す(`rootExists`)。ルートが無ければ`missing`、あれば`modified`を返す。
 * 数える途中でルートごと消えた場合を、中の項目の書き換えと区別するためである。
 * ルートがシンボリックリンクに置き換わっていたときも`modified`を返す。
 * ほかの例外はそのまま投げる。
 */
export async function checkDocTreeHash(
  dir: string,
  baseline: string | null | undefined,
  hashTree: (dir: string) => Promise<string | null>,
  rootExists: (dir: string) => Promise<boolean> = realRootExists,
): Promise<DocHashCheck> {
  if (baseline === null || baseline === undefined || baseline.length === 0) {
    return "no_baseline";
  }
  let current: string | null;
  try {
    current = await hashTree(dir);
  } catch (err) {
    // ルートがリンクに置き換わったのは、内容の書き換えである。
    if (err instanceof DocTreeRootSymlinkError) return "modified";
    // 数えている途中で項目が消えたり置き換わったりしたのは、ルートが残っていれば内容が書き換わったということである。
    if (isEntryGoneError(err)) {
      return (await rootExists(dir)) ? "modified" : "missing";
    }
    throw err;
  }
  if (current === null) return "missing";
  return current === baseline ? "match" : "modified";
}

/** 複製の書き出し。テストでは差し替える。 */
export type CopiedFiles = {
  readonly hash: string | null;
  readonly copied: readonly string[];
};

export async function copyDirectoryTreeWithHash(
  _source: string,
  _destination: string,
  _io: DirectoryEntryIo = realDirectoryIo,
): Promise<string | null> {
  return null;
}

export async function copyFilesWithHash(
  _source: string,
  _destination: string,
  _files: readonly string[],
  _io: DirectoryEntryIo = realDirectoryIo,
): Promise<CopiedFiles> {
  return { hash: null, copied: [] };
}
