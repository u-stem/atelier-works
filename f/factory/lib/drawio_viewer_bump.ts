// draw.ioのビューアの固定(console/drawio-viewer.json)を新しい版へ上げるときの判断と書き換え。
// どの関数も、GitHubへの書き込みやDBに触れない。呼び出し側(`drawio_viewer_bump.ts`)が、
// 取得した値をここへ渡し、返ってきた内容をPRにする。
//
// 上げてよいのは、公式のjgraph/drawioのリリースのうち、公開から`MIN_RELEASE_AGE_DAYS`日以上たったものだけである。
// 欠陥のある版を公開直後に取り込まないための待ち時間である。
// メジャー版が変わる版も、同じ待ち時間と照合を満たせばPRにする。PRの題名と本文で、人に確認を求める。
// ビューアの大きさが急に変わる版は、人の指名が無い限り上げない。
// ここで作る固定のファイルは、`console/scripts/drawio-viewer.ts`の検査を通る形に限る。

import { createHash } from "node:crypto";
import type { GitHubRelease } from "./drawio_viewer_bump_github.ts";
import { isRecord } from "./types.ts";

/** ビューアの取得元のリポジトリ。公式の配布元だけを読む。 */
export const DRAWIO_OWNER = "jgraph";
export const DRAWIO_REPO = "drawio";
/** リポジトリの中のビューアのパス。 */
export const VIEWER_PATH = "src/main/webapp/js/viewer-static.min.js";
/** 固定のファイルと、ビューアを読むページ(Factoryのリポジトリの中のパス)。 */
export const PIN_PATH = "console/drawio-viewer.json";
export const PAGE_PATH = "console/public/drawio.html";

/** 公開からこの日数がたつまで、その版には上げない。 */
export const MIN_RELEASE_AGE_DAYS = 14;
/** 今のビューアの大きさに対する増減の上限(割合)。超える版は、人の承認なしには上げない。 */
export const MAX_SIZE_CHANGE_RATIO = 0.2;
/** ビューアの大きさの上限。CIの取得(`fetch-drawio-viewer.ts`)の上限と同じにする。 */
export const MAX_VIEWER_BYTES = 10 * 1024 * 1024;

const DAY_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 60_000;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const PIN_URL_ORIGIN = "https://raw.githubusercontent.com";
const BRANCH_PREFIX = "factory/drawio-viewer-";

// ---------------------------------------------------------------------------
// 版
// ---------------------------------------------------------------------------

export type Version = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
};

const VERSION_PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** `v32.4.1`か`32.4.1`の形だけを読む。前置きや接尾辞の付いた名前は`null`にする。 */
export function parseReleaseVersion(tag: string): Version | null {
  const match = VERSION_PATTERN.exec(tag);
  if (match === null) return null;
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) {
    return null;
  }
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
  };
}

export function formatVersion(version: Version): string {
  return `${String(version.major)}.${String(version.minor)}.${String(version.patch)}`;
}

/** `a`が新しければ正、古ければ負、同じなら0を返す。 */
export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

// ---------------------------------------------------------------------------
// リリースの選び方
// ---------------------------------------------------------------------------

export type DrawioRelease = {
  /** `v32.4.1`の形のタグ。上の`parseReleaseVersion`を通ったものだけが入る。 */
  readonly tag: string;
  readonly version: Version;
  readonly publishedAt: Date;
  /**
   * 今のcommitでこのタグを最初に見た時刻。まだ見ていなければ`null`。
   * 公開日はリリースを作る側が書き換えられるので、待ちの根拠はこの時刻にも置く。
   */
  readonly firstSeenAt: Date | null;
};

/**
 * GitHubのリリースの一覧から、版として使えるものだけを残す。
 * 下書き、プレリリース、公開日時の無いもの、タグが`v<数>.<数>.<数>`でないものは捨てる。
 */
export function parseReleases(
  releases: readonly GitHubRelease[],
): DrawioRelease[] {
  const result: DrawioRelease[] = [];
  for (const raw of releases) {
    if (raw.draft || raw.prerelease || raw.publishedAt === null) continue;
    const version = parseReleaseVersion(raw.tagName);
    if (version === null) continue;
    const publishedAt = new Date(raw.publishedAt);
    if (Number.isNaN(publishedAt.getTime())) continue;
    result.push({ tag: raw.tagName, version, publishedAt, firstSeenAt: null });
  }
  return result;
}

/**
 * 上げてよいだけ時間がたっているか。次の両方を満たす。
 * - 公開日から`MIN_RELEASE_AGE_DAYS`日以上たっている。
 * - 今と同じcommitを、`MIN_RELEASE_AGE_DAYS`日以上前から見ている(`firstSeenAt`)。
 *   見ていない版と、タグの付け替えで見直した版は、待ちを数え直す。
 */
export function isOldEnough(release: DrawioRelease, now: Date): boolean {
  if (release.firstSeenAt === null) return false;
  const wait = MIN_RELEASE_AGE_DAYS * DAY_MS;
  return (
    now.getTime() - release.publishedAt.getTime() >= wait &&
    now.getTime() - release.firstSeenAt.getTime() >= wait
  );
}

/** 一度に観測するリリースの数の上限。新しい順に数える。 */
export const MAX_OBSERVED_RELEASES = 20;

/**
 * 観測の記録を取るリリースを選ぶ。今の版より新しいものを、新しい順に`MAX_OBSERVED_RELEASES`件まで返す。
 * 公開から日が浅い版も含める。早く見始めるほど、待ちの数え始めが早くなるためである。
 * `currentVersion`が`32.4.1`の形でなければ、固定が壊れているので例外を投げる。
 */
export function releasesToObserve(
  currentVersion: string,
  releases: readonly DrawioRelease[],
): DrawioRelease[] {
  const current = parseReleaseVersion(currentVersion);
  if (current === null) {
    throw new Error(
      `the pinned version is not a plain version: ${currentVersion}`,
    );
  }
  return releases
    .filter((release) => compareVersions(release.version, current) > 0)
    .sort((a, b) => compareVersions(b.version, a.version))
    .slice(0, MAX_OBSERVED_RELEASES);
}

export type BumpDecision = {
  /** 上げる版。上げるものが無ければ`null`。 */
  readonly target: DrawioRelease | null;
  /** 今より新しいが、公開から日が浅く待っている版があるか。 */
  readonly waiting: boolean;
};

function newest(releases: readonly DrawioRelease[]): DrawioRelease | null {
  let best: DrawioRelease | null = null;
  for (const release of releases) {
    if (best === null || compareVersions(release.version, best.version) > 0) {
      best = release;
    }
  }
  return best;
}

/**
 * 上げる版を決める。
 * 今より新しく、公開から十分たった版のうち、メジャー版を問わず最新を選ぶ。
 * `approvedTag`で人が指名した版が、その条件を満たすなら、最新でなくてもその版を選ぶ。
 * 指名した版にも、公開からの待ち時間は課す。
 * `currentVersion`が`32.4.1`の形でなければ、固定が壊れているので例外を投げる。
 */
export function decideBump(
  currentVersion: string,
  releases: readonly DrawioRelease[],
  now: Date,
  approvedTag: string | null,
): BumpDecision {
  const current = parseReleaseVersion(currentVersion);
  if (current === null) {
    throw new Error(
      `the pinned version is not a plain version: ${currentVersion}`,
    );
  }
  const newer = releases.filter(
    (release) => compareVersions(release.version, current) > 0,
  );
  const eligible = newer.filter((release) => isOldEnough(release, now));
  const waiting = eligible.length < newer.length;

  const approvedVersion =
    approvedTag === null ? null : parseReleaseVersion(approvedTag);
  const approved =
    approvedVersion === null
      ? undefined
      : eligible.find(
          (release) => compareVersions(release.version, approvedVersion) === 0,
        );
  if (approved !== undefined) {
    return { target: approved, waiting };
  }
  return { target: newest(eligible), waiting };
}

/** 固定の版`currentVersion`から`to`への更新が、メジャー版の変更か。 */
export function isMajorBump(currentVersion: string, to: Version): boolean {
  const current = parseReleaseVersion(currentVersion);
  if (current === null) {
    throw new Error(
      `the pinned version is not a plain version: ${currentVersion}`,
    );
  }
  return current.major !== to.major;
}

// ---------------------------------------------------------------------------
// 大きさと照合
// ---------------------------------------------------------------------------

export type SizeVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** `invalid`は承認でも通せない値、`changed`は承認で通せる増減。 */
      readonly kind: "invalid" | "changed";
      readonly reason: string;
    };

/**
 * 新しいビューアの大きさを確かめる。
 * 空のファイルと、CIの取得の上限を超えるファイルは、承認があっても通さない。
 * 今の大きさから`MAX_SIZE_CHANGE_RATIO`を超えて増減したら、承認(`approved`)が無い限り通さない。
 */
export function sizeChangeVerdict(
  oldSize: number,
  newSize: number,
  approved: boolean,
): SizeVerdict {
  if (newSize <= 0) {
    return { ok: false, kind: "invalid", reason: "the new viewer is empty" };
  }
  if (newSize > MAX_VIEWER_BYTES) {
    return {
      ok: false,
      kind: "invalid",
      reason: `the new viewer is ${String(newSize)} bytes, over the ${String(MAX_VIEWER_BYTES)} byte limit of the console build`,
    };
  }
  if (approved) return { ok: true };
  const ratio = Math.abs(newSize - oldSize) / Math.max(oldSize, 1);
  if (ratio > MAX_SIZE_CHANGE_RATIO) {
    return {
      ok: false,
      kind: "changed",
      reason: `the size changed from ${String(oldSize)} to ${String(newSize)} bytes, beyond ${String(MAX_SIZE_CHANGE_RATIO * 100)}%`,
    };
  }
  return { ok: true };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** gitのblobのオブジェクトID(`git hash-object`と同じ値)。 */
export function gitBlobSha1(bytes: Uint8Array): string {
  return createHash("sha1")
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest("hex");
}

// ---------------------------------------------------------------------------
// 固定のファイルとページの書き換え
// ---------------------------------------------------------------------------

export type Pin = {
  readonly version: string;
  readonly commit: string;
  readonly url: string;
  readonly sha256: string;
};

/** commitに固定した、ビューアの取得元のURL。CIの取得が受け付ける形と同じ。 */
export function pinUrlFor(commit: string): string {
  return `${PIN_URL_ORIGIN}/${DRAWIO_OWNER}/${DRAWIO_REPO}/${commit}/${VIEWER_PATH}`;
}

function readPinString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${PIN_PATH}: "${key}" must be a non-empty string`);
  }
  return value;
}

/** 固定のファイルの中身を読む。形が違えば例外を投げる。 */
export function parsePinText(text: string): Pin {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${PIN_PATH} is not valid JSON`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${PIN_PATH} must be an object`);
  }
  const pin: Pin = {
    version: readPinString(parsed, "version"),
    commit: readPinString(parsed, "commit"),
    url: readPinString(parsed, "url"),
    sha256: readPinString(parsed, "sha256"),
  };
  if (!COMMIT_SHA.test(pin.commit)) {
    throw new Error(`${PIN_PATH}: "commit" must be a 40-digit hex sha`);
  }
  if (!SHA256_HEX.test(pin.sha256)) {
    throw new Error(`${PIN_PATH}: "sha256" must be 64 lowercase hex`);
  }
  return pin;
}

/** 固定のファイルの書式。2桁のインデントと末尾の改行は、今のファイルと同じ。 */
export function renderPin(pin: Pin): string {
  return `${JSON.stringify(
    {
      version: pin.version,
      commit: pin.commit,
      url: pin.url,
      sha256: pin.sha256,
    },
    null,
    2,
  )}\n`;
}

function viewerScriptPath(sha256: string): string {
  return `/console/drawio/drawio-viewer-${sha256.slice(0, 8)}.js`;
}

/**
 * ページが読むビューアのscriptの名前を、古いsha256のものから新しいものへ書き換える。
 * 古い名前がちょうど1か所に無ければ、固定とページが食い違っているので例外を投げる。
 */
export function rewriteViewerReference(
  html: string,
  oldSha256: string,
  newSha256: string,
): string {
  const oldPath = viewerScriptPath(oldSha256);
  const count = html.split(oldPath).length - 1;
  if (count !== 1) {
    throw new Error(
      `${PAGE_PATH} must load ${oldPath} exactly once, found ${String(count)}`,
    );
  }
  return html.replace(oldPath, viewerScriptPath(newSha256));
}

// ---------------------------------------------------------------------------
// 既にあるブランチの中身の確認
// ---------------------------------------------------------------------------

export type BranchVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * PRの無い既存のブランチを、そのままPRの元にしてよいかを確かめる。
 * 同じ名前のブランチを他の人が作っておくと、中身を確かめずにPRにすれば、
 * 想定していない変更が更新のPRに混ざるためである。
 * - 各ファイルのgit blobのIDが、今回作る内容のIDと一致する。
 * - 基点のブランチとの差分が、今回書き換えるファイルだけである。
 * `readBlobSha`は、ブランチ上のファイルのgit blobのIDを返す(無ければ`null`)。
 * `listChangedPaths`は、基点との差分のパスを返す。
 */
export async function verifyBranchContents(
  files: readonly { readonly path: string; readonly content: string }[],
  readBlobSha: (path: string) => Promise<string | null>,
  listChangedPaths: () => Promise<readonly string[]>,
): Promise<BranchVerdict> {
  for (const file of files) {
    const actual = await readBlobSha(file.path);
    const expected = gitBlobSha1(new TextEncoder().encode(file.content));
    if (actual !== expected) {
      return {
        ok: false,
        reason: `${file.path} on the branch differs from the expected content`,
      };
    }
  }
  const changed = [...(await listChangedPaths())].sort();
  const expectedPaths = files.map((file) => file.path).sort();
  if (
    changed.length !== expectedPaths.length ||
    changed.some((path, index) => path !== expectedPaths[index])
  ) {
    return {
      ok: false,
      reason: `the branch changes ${changed.join(", ")}, expected ${expectedPaths.join(", ")}`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// PRの組み立て
// ---------------------------------------------------------------------------

export function bumpBranchPrefix(): string {
  return BRANCH_PREFIX;
}

/** 版ごとのブランチ名。同じ版のPRを重ねて作らないための目印になる。 */
export function bumpBranchName(tag: string): string {
  const version = parseReleaseVersion(tag);
  if (version === null) {
    throw new Error(`the tag is not a plain version: ${tag}`);
  }
  return `${BRANCH_PREFIX}${formatVersion(version)}`;
}

const MAJOR_TITLE_PREFIX = "[major] ";

/** PRの題名。メジャー版の更新は、一覧で目に付くよう`[major]`を先頭に付ける。 */
export function buildBumpTitle(from: string, to: Version): string {
  const subject = `chore: draw.ioのビューアを${formatVersion(to)}へ上げる`;
  return isMajorBump(from, to) ? `${MAJOR_TITLE_PREFIX}${subject}` : subject;
}

/** commitのメッセージ。題名の接頭辞は付けず、conventional commitsの形にする。 */
export function buildBumpCommitMessage(from: string, to: Version): string {
  const version = formatVersion(to);
  return `chore: draw.ioのビューアを${version}へ上げる\n\n固定を${from}から${version}へ自動で更新した。`;
}

function majorWarning(from: string, to: string): string {
  return `メジャー版の更新(${from} → ${to})。破壊的変更の可能性があるため、リリースノートとCSP / sandbox / drawio_frame_isolationの確認を人が行う`;
}

export type BumpPrBodyInput = {
  readonly from: string;
  readonly to: DrawioRelease;
  readonly commit: string;
  readonly sha256: string;
  readonly oldSize: number;
  readonly newSize: number;
  readonly now: Date;
  /** 大きさの変化の制限を、人の指名で外したか。 */
  readonly sizeApproved: boolean;
};

function wholeDaysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

/**
 * `.github/PULL_REQUEST_TEMPLATE.md`の節の順にPR本文を組み立てる。
 * 入るのは、検証した値(版、commit、sha256、大きさ、日付)と固定の文だけで、外から来た文は入れない。
 */
export function buildBumpPrBody(input: BumpPrBodyInput): string {
  const to = formatVersion(input.to.version);
  const ageDays = wholeDaysBetween(input.to.publishedAt, input.now);
  const published = input.to.publishedAt.toISOString().slice(0, 10);
  const releaseUrl = `https://github.com/${DRAWIO_OWNER}/${DRAWIO_REPO}/releases/tag/${input.to.tag}`;
  const attention = [
    `- \`${PIN_PATH}\`と\`${PAGE_PATH}\`は保護パスです。人が内容を確かめてからマージしてください。`,
    "- 新しい版でも図が描かれるかは、自動では確かめていません。マージ後に、Consoleの要件定義書の図を開いて確かめてください。",
    ...(input.sizeApproved
      ? ["- 大きさの変化の制限は、人の指名で外しています。"]
      : []),
  ];
  const warning = isMajorBump(input.from, input.to.version)
    ? [majorWarning(input.from, to), ""]
    : [];
  return [
    ...warning,
    "## 概要",
    "",
    `Consoleが同梱するdraw.ioのビューアの固定を、${input.from}から${to}へ上げます。`,
    "`f/factory/drawio_viewer_bump`が週に1回、公式のリリースを確かめて自動で作りました。",
    "",
    "## 受入条件",
    "",
    "- [ ] CIの`console`ジョブが、固定のURLからビューアを取得し、sha256が一致する",
    `- [ ] \`${PAGE_PATH}\`が読むビューアの名前が、新しいsha256の先頭8桁と一致する`,
    "- [ ] CSPと図の隔離のテストが通る",
    "",
    "## 動作確認結果",
    "",
    `- 版: ${to}(${published}に公開、公開から${String(ageDays)}日)`,
    `- commit: \`${input.commit}\``,
    `- sha256: \`${input.sha256}\``,
    `- 大きさ: ${String(input.oldSize)}バイトから${String(input.newSize)}バイト`,
    `- 取得したバイト列のgit blobのIDが、GitHubのAPIが返すこのcommitのファイルのIDと一致することを確かめました`,
    "- lintとテストは、このPRのCIが確かめます",
    "",
    "## 確認して欲しい点",
    "",
    ...attention,
    "",
    "## 関連リンク",
    "",
    `- ${releaseUrl}`,
    "",
    "## 備考",
    "",
    "### Windmillへの反映",
    "",
    "- [ ] マージ後に`self_update`が自動で反映する(`f/`・`migrations/`・`.claude/skills/`の変更)",
    "- [ ] 次に`mise run up`で起動したときに反映される(`infra/`、`mise.toml`の`[tools]`・`[env]`の変更)",
    "- [x] マージ後、CIが通れば数分で`console_fetcher`が反映する(`console/`の変更)",
    "- [ ] 反映するものは無い",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// ビューアの取得
// ---------------------------------------------------------------------------

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** 上限を超えたら読むのをやめて`null`を返す。 */
async function readLimited(
  response: Response,
  limit: number,
): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/**
 * commitに固定したURLからビューアを取得する。CIの取得と同じ取得元で、リダイレクトは許さない。
 * 応答が`MAX_VIEWER_BYTES`を超えるときは読み込まずに例外を投げる。
 * 一時的な失敗は再試行せず、例外を投げてジョブを失敗させる(次の週に再び試す)。
 */
export async function downloadViewer(
  commit: string,
  fetchImpl: FetchLike,
): Promise<Uint8Array> {
  if (!COMMIT_SHA.test(commit)) {
    throw new Error("the commit must be a 40-digit hex sha");
  }
  const response = await fetchImpl(pinUrlFor(commit), {
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `the viewer download failed: HTTP ${String(response.status)}`,
    );
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_VIEWER_BYTES) {
    throw new Error(
      `the viewer response is too large: ${String(declared)} bytes`,
    );
  }
  const bytes = await readLimited(response, MAX_VIEWER_BYTES);
  if (bytes === null) {
    throw new Error(
      `the viewer response is too large: over ${String(MAX_VIEWER_BYTES)} bytes`,
    );
  }
  return bytes;
}
