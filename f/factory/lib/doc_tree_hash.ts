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

/** `hashDirectoryTree`が使うディレクトリの読み取り。テストでは差し替える。 */
export type DirectoryEntryIo = {
  readonly readDir: (
    dir: string,
  ) => Promise<{ readonly name: string; readonly isDirectory: boolean }[]>;
  readonly readFile: (path: string) => Promise<Uint8Array>;
};

function isMissingError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    Reflect.get(err, "code") === "ENOENT" || err.message.includes("ENOENT")
  );
}

/** 読んでいる途中で項目が消えた、またはディレクトリがファイルに置き換わった例外か。 */
function isEntryGoneError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = Reflect.get(err, "code");
  return (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    err.message.includes("ENOENT") ||
    err.message.includes("ENOTDIR")
  );
}

/**
 * `dir`以下の内容(相対パスの一覧と、ファイルの中身)のSHA-256を16進で返す。ディレクトリが無ければ`null`を返す。
 * 名前の一覧は並べ替えて数え、名前と中身は長さを前置きして区切る。名前の終わりと中身の始まりが紛れないようにするため。
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
      const content = await io.readFile(`${path}/${entry.name}`);
      hasher.update(
        `F${String(relative.length)}:${relative}\n${String(content.length)}:`,
      );
      hasher.update(content);
    }
  };
  // ルートのディレクトリが無いときだけ`null`を返す。途中の項目が消えたときの例外はそのまま投げ、`checkDocTreeHash`が書き換えとして扱う。
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
      return new TextEncoder().encode(`symlink:${await readlink(path)}`);
    }
    if (!stat.isFile()) return new TextEncoder().encode("special");
    return new Uint8Array(await readFile(path));
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
 * ハッシュを数えている途中で項目が消えたか置き換わった例外(ENOENT、ENOTDIR)も`modified`として返す。ほかの例外はそのまま投げる。
 */
export async function checkDocTreeHash(
  dir: string,
  baseline: string | null | undefined,
  hashTree: (dir: string) => Promise<string | null>,
): Promise<DocHashCheck> {
  if (baseline === null || baseline === undefined || baseline.length === 0) {
    return "no_baseline";
  }
  let current: string | null;
  try {
    current = await hashTree(dir);
  } catch (err) {
    // 数えている途中で項目が消えたり置き換わったりしたのは、内容が書き換わったということである。
    if (isEntryGoneError(err)) return "modified";
    throw err;
  }
  if (current === null) return "missing";
  return current === baseline ? "match" : "modified";
}
