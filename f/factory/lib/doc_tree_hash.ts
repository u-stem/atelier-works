// 要件定義のディレクトリの内容のハッシュと、保存した基準値との照合。

/** `hashDirectoryTree`が使うディレクトリの読み取り。テストでは差し替える。 */
export type DirectoryEntryIo = {
  readonly readDir: (
    dir: string,
  ) => Promise<{ readonly name: string; readonly isDirectory: boolean }[]>;
  readonly readFile: (path: string) => Promise<Uint8Array>;
};

export async function hashDirectoryTree(
  _dir: string,
  _io: DirectoryEntryIo,
): Promise<string | null> {
  return "";
}

export const realDirectoryIo: DirectoryEntryIo = {
  readDir: async () => [],
  readFile: async () => new Uint8Array(),
};

export const REQUIREMENTS_MODIFIED_BEFORE_DESIGN_REASON = "";
export const REQUIREMENTS_MODIFIED_REASON = "";
export const REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON = "";
export const REQUIREMENTS_DIR_MISSING_REASON = "";

export type DocHashCheck = "match" | "no_baseline" | "missing" | "modified";

export async function checkDocTreeHash(
  _dir: string,
  _baseline: string | null | undefined,
  _hashTree: (dir: string) => Promise<string | null>,
): Promise<DocHashCheck> {
  return "match";
}
