// 開いたままのタブが、自分の版がまだ配信中かを判定する純粋関数。
// ネットワークとDOMには触れない。取得は useReleaseWatch が行う。

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
 * 実行中のモジュールのURLから、配信物の中の自分のファイル名(`assets/<name>`)を返す。
 * `/console/assets/`の下でなければ(開発サーバーなど)nullを返す。nullなら監視しない。
 */
export function ownAssetPath(moduleUrl: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(moduleUrl).pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith(ASSETS_PREFIX)) {
    return null;
  }
  const name = pathname.slice(ASSETS_PREFIX.length);
  return name === "" ? null : `assets/${name}`;
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
  /** 自分のファイル名。監視しないときはnull。 */
  ownAsset: string | null;
  /** 配信中の版のファイル名の集合。取得できなかったときはnull。 */
  manifestFiles: ReadonlySet<string> | null;
  /** 読めなかったときはnull。 */
  status: ReleaseStatus | null;
  /** 自分のファイルを取りに行くと404だったか。確かめていないときはfalse。 */
  ownAssetMissing: boolean;
  /** 前回の判定。 */
  previous: ReleaseNotice;
};

/**
 * 案内の強さを決める。
 * - 自分のファイルが配信中の版にあれば none。
 * - 無ければ suggest。さらに、版を戻して固定している(pinned)か、
 *   自分のファイルがもう取れなければ urge。
 * - manifestを取れなかったときは前回の判定を保つ。
 * - 一度 urge になったら下げない。取り下げられた版は戻らないため。
 */
export function judgeRelease(input: ReleaseJudgement): ReleaseNotice {
  if (input.previous === "urge" || input.manifestFiles === null) {
    return input.previous;
  }
  if (input.ownAsset === null || input.manifestFiles.has(input.ownAsset)) {
    return "none";
  }
  if (input.status?.state === "pinned" || input.ownAssetMissing) {
    return "urge";
  }
  return "suggest";
}
