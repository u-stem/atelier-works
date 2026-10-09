// 開いたままのタブが、自分の版がまだ配信中かを判定する純粋関数。
// ネットワークとDOMには触れない。取得は releaseCheck.ts、周期の管理は useReleaseWatch が行う。

/** 画面に出す案内の強さ。none は何も出さない。 */
export type ReleaseNotice = "none" | "suggest" | "urge";

export type DeployState = "ok" | "failed" | "pinned";

/** console_fetcher が書く status.json の中身。 */
export type ReleaseStatus = {
  state: DeployState;
  sha: string | null;
  checkedAt: string;
  error: string | null;
};

const ASSETS_PREFIX = "/console/assets/";

/**
 * URLから、配信物の中のファイル名(`assets/<name>`)を返す。
 * 基準のオリジンと違うURL、`/console/assets/`の下でないURL、符号化した名前(`%`を含む)はnullを返す。
 * 符号化した名前は、manifestのキーと突き合わせられないため、常に「無い」と判定してしまう。
 */
export function ownAssetPath(url: string, origin: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== origin || !parsed.pathname.startsWith(ASSETS_PREFIX)) {
    return null;
  }
  const name = parsed.pathname.slice(ASSETS_PREFIX.length);
  return name === "" || name.includes("%") ? null : `assets/${name}`;
}

/**
 * 画面が参照するファイルのURLの一覧から、配信物の中の自分のファイル名の集合を作る。
 * 対象にならないURLは捨てる(条件は`ownAssetPath`)。空なら監視しない。
 */
export function ownAssetPaths(
  urls: readonly string[],
  origin: string,
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const url of urls) {
    const name = ownAssetPath(url, origin);
    if (name !== null) {
      names.add(name);
    }
  }
  return names;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `manifest.json`の応答から、配信中のファイル名の集合を取り出す。
 * 形が違えばnullを返す。
 */
export function parseManifestFiles(value: unknown): ReadonlySet<string> | null {
  if (!isRecord(value) || !isRecord(value.files)) {
    return null;
  }
  const names = new Set<string>();
  for (const [name, digest] of Object.entries(value.files)) {
    if (typeof digest !== "string") {
      return null;
    }
    names.add(name);
  }
  return names;
}

function isDeployState(value: unknown): value is DeployState {
  return value === "ok" || value === "failed" || value === "pinned";
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** `status.json`の応答を検証する。形が違えばnullを返す。 */
export function parseReleaseStatus(value: unknown): ReleaseStatus | null {
  if (!isRecord(value)) {
    return null;
  }
  const { state, sha, checked_at: checkedAt, error } = value;
  if (
    !isDeployState(state) ||
    !isStringOrNull(sha) ||
    typeof checkedAt !== "string" ||
    !isStringOrNull(error)
  ) {
    return null;
  }
  return { state, sha, checkedAt, error };
}

export type ReleaseJudgement = {
  /** 自分のファイル名の集合。空なら監視しないので、前回の判定を保つ。 */
  ownAssets: ReadonlySet<string>;
  /** 配信中の版のファイル名の集合。取得できなかったときはnull。 */
  manifestFiles: ReadonlySet<string> | null;
  /** 読めなかったときはnull。 */
  status: ReleaseStatus | null;
  /** 配信中の版に無い自分のファイルのどれかを取りに行くと404だったか。確かめていないときはfalse。 */
  ownAssetMissing: boolean;
  /** 前回の判定。 */
  previous: ReleaseNotice;
};

/**
 * 案内の強さを決める。
 * - 自分のファイルがすべて配信中の版にあれば none。
 * - 1つでも無ければ suggest。さらに、版を戻して固定している(pinned)か、
 *   無かったファイルのどれかがもう取れなければ urge。
 * - manifestを取れなかったとき、自分のファイルが無いときは前回の判定を保つ。
 * - 一度 urge になったら下げない。取り下げられた版は戻らないため。
 */
export function judgeRelease(input: ReleaseJudgement): ReleaseNotice {
  if (
    input.previous === "urge" ||
    input.manifestFiles === null ||
    input.ownAssets.size === 0
  ) {
    return input.previous;
  }
  const { manifestFiles } = input;
  const allServed = [...input.ownAssets].every((name) =>
    manifestFiles.has(name),
  );
  if (allServed) {
    return "none";
  }
  if (input.status?.state === "pinned" || input.ownAssetMissing) {
    return "urge";
  }
  return "suggest";
}
