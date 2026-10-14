// CIの`metadata`ジョブが出すパッチ(artifact)の、パスの許可リストとmanifestの検査。
// `scripts/metadata-patch.ts`(書く側)と、パッチを受け取る側が、同じ判定をここから読む。
// 副作用を持たない純粋な関数だけを置く。外から来た値は型ガードで1項目ずつ確かめる。

/** 1ファイルの上限。ロックとスキーマは数KBで、これを超えるものは異常として扱う。 */
export const MAX_FILE_BYTES = 1024 * 1024;

/** 1つのパッチに載せる変更の数の上限。 */
export const MAX_ENTRIES = 500;

/** 1つのパッチに載せるファイルの大きさの合計の上限。 */
export const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

export type ChangeStatus = "added" | "modified" | "deleted";

export type ManifestEntry =
  | {
      readonly path: string;
      readonly status: "added" | "modified";
      readonly sha256: string;
      readonly size: number;
    }
  | { readonly path: string; readonly status: "deleted" };

export type Manifest = {
  readonly version: 1;
  /** PRのheadのcommit。 */
  readonly headSha: string;
  /** PRのbaseのcommit。 */
  readonly baseSha: string;
  /** 再生成を行ったmerge木のcommit。 */
  readonly mergeSha: string;
  readonly entries: readonly ManifestEntry[];
};

// SHA-1(40桁)とSHA-256(64桁)の小文字の16進数。
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^[0-9a-f]{64}$/;

// パスの1区間。英数字か`_`で始め、`.`と`..`と隠しファイルを含めない。
const SEGMENT = "[A-Za-z0-9_][A-Za-z0-9_.-]*";
const SCRIPT_METADATA = new RegExp(
  `^f/(?:${SEGMENT}/)*${SEGMENT}\\.script\\.(?:lock|yaml)$`,
);

/**
 * パッチに載せてよいパスか。許可するのは次の3種類だけである。
 * - `wmill-lock.yaml`
 * - `f/**` の `*.script.lock`
 * - `f/**` の `*.script.yaml`
 *
 * 適用側が同じ判定で再検査できるよう、判定はこの1か所に置く。
 * 区間の文字を英数字と`_` `.` `-`に限るのは、`..`、絶対パス、改行、制御文字、
 * 隠しディレクトリを、パスの組み立ての前に必ず弾くため。
 */
export function isAllowedMetadataPath(path: string): boolean {
  return path === "wmill-lock.yaml" || SCRIPT_METADATA.test(path);
}

/** commitのshaとして正しい形(小文字の16進数で40桁か64桁)か。 */
export function isSha(value: unknown): value is string {
  return typeof value === "string" && COMMIT_SHA.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntry(value: unknown): ManifestEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const { path, status } = value;
  if (typeof path !== "string" || !isAllowedMetadataPath(path)) {
    return null;
  }
  if (status === "deleted") {
    return "sha256" in value || "size" in value ? null : { path, status };
  }
  if (status !== "added" && status !== "modified") {
    return null;
  }
  const { sha256, size } = value;
  if (typeof sha256 !== "string" || !DIGEST.test(sha256)) {
    return null;
  }
  if (
    typeof size !== "number" ||
    !Number.isInteger(size) ||
    size < 0 ||
    size > MAX_FILE_BYTES
  ) {
    return null;
  }
  return { path, status, sha256, size };
}

/**
 * `manifest.json`の文字列を読む。形が合わなければnullを返す。
 * 許可リストにないパス、重複、想定外の状態、桁の合わないsha256を拒む。
 * 外から来た値なので、型があると決め打ちせずに1項目ずつ確かめる。
 */
export function parseManifest(json: string): Manifest | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== 1) {
    return null;
  }
  const { headSha, baseSha, mergeSha, entries } = value;
  if (!isSha(headSha) || !isSha(baseSha) || !isSha(mergeSha)) {
    return null;
  }
  if (
    !Array.isArray(entries) ||
    entries.length === 0 ||
    entries.length > MAX_ENTRIES
  ) {
    return null;
  }
  const parsed: ManifestEntry[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    const entry = parseEntry(raw);
    if (entry === null || seen.has(entry.path)) {
      return null;
    }
    seen.add(entry.path);
    parsed.push(entry);
  }
  const total = parsed.reduce(
    (sum, entry) => sum + ("size" in entry ? entry.size : 0),
    0,
  );
  if (total > MAX_TOTAL_BYTES) {
    return null;
  }
  return { version: 1, headSha, baseSha, mergeSha, entries: parsed };
}
