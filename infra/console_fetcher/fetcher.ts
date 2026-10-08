// console_fetcherの1回分の取り込みと、戻す・pinを外す操作を行う。
// 接続先はapi.github.comと、そこからリダイレクトされた成果物の取得先だけにする。
// 判定はdecide.tsとzip.tsの純粋関数に任せ、ここではネットワークとファイルの操作だけを行う。
// ボリュームの中身は、検証を終えたものだけを書く。失敗したときはcurrentを変えない。
import { createHash, randomBytes } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ARTIFACT_NAME,
  type AssetFile,
  appendHistory,
  type ConsoleManifest,
  type CurrentLink,
  chooseArtifact,
  classifyHttpStatus,
  contentDigest,
  type FetchErrorCode,
  type FetcherConfig,
  type FetcherStatus,
  HISTORY_LIMIT,
  isAllowedDownloadUrl,
  isCommitSha,
  isLockStale,
  isReadablePin,
  isRevokedRelease,
  MANIFEST_FILE,
  mergeRevokedState,
  needsDeploy,
  parseArtifacts,
  parseCurrentLink,
  parseHistory,
  parseManifest,
  parsePinContent,
  parsePinRevoked,
  parseRevokedState,
  parseWorkflowRuns,
  pruneRevokedState,
  RELEASE_BRANCH,
  referencedAssetNames,
  selectAssetsToDelete,
  selectIdenticalReleases,
  selectLatestRun,
  selectReleasesToDelete,
  selectRevokedAssets,
  selectRevokedReleases,
  selectRollbackTarget,
  type UnpinOptions,
  type UnpinResult,
  verifyRelease,
  WORKFLOW_FILE,
  type WorkflowRun,
} from "./decide.ts";
import { readZip, type ZipEntry } from "./zip.ts";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type LogFields = Record<string, string | number | null>;

export type Logger = (event: string, fields?: LogFields) => void;

export type FetcherDeps = {
  readonly fetch: FetchLike;
  readonly now: () => Date;
  readonly root: string;
  readonly config: FetcherConfig;
  readonly log: Logger;
};

export const LIMITS = {
  maxArchiveBytes: 20 * 1024 * 1024,
  maxEntries: 2000,
  maxTotalBytes: 50 * 1024 * 1024,
  releasesToKeep: 3,
  assetMaxAgeMs: 14 * 24 * 60 * 60 * 1000,
} as const;

const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "atelier-works-console-fetcher";
const ASSETS_PREFIX = "assets/";
/** GitHubへの1つの要求(本文の読み取りを含む)の時間切れ。1回の取り込みの長さに上限を付ける。 */
const FETCH_TIMEOUT_MS = 60 * 1000;
/** 持ち主が止まったとみなすロックの古さ。1回の取り込みの最長よりも十分長くする。 */
export const LOCK_STALE_MS = 15 * 60 * 1000;

/** 分類した失敗。`code`だけをstatus.jsonに書き、`message`はログにだけ出す。 */
class FetchFailure extends Error {
  readonly code: FetchErrorCode;

  constructor(code: FetchErrorCode, message: string) {
    super(message);
    this.name = "FetchFailure";
    this.code = code;
  }
}

type Layout = {
  readonly root: string;
  readonly releases: string;
  readonly assets: string;
  readonly tmp: string;
  readonly current: string;
  readonly pin: string;
  readonly revoked: string;
  readonly status: string;
  readonly history: string;
  readonly lock: string;
};

function layoutOf(root: string): Layout {
  return {
    root,
    releases: join(root, "releases"),
    assets: join(root, "assets"),
    tmp: join(root, "tmp"),
    current: join(root, "current"),
    pin: join(root, "pin"),
    revoked: join(root, "revoked.json"),
    status: join(root, "status.json"),
    history: join(root, "history.json"),
    lock: join(root, "lock"),
  };
}

function hasErrorCode(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && err.code === code;
}

/**
 * 分類していない失敗を、ログ用の短い種類(errnoのコードかエラーの名前)にする。
 * bunやOSのエラーの文面は、パスや応答の一部を含みうるので出さない。
 */
function describeUnexpectedError(err: unknown): string {
  if (err instanceof Error && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return err instanceof Error ? err.name : "unknown error";
}

function randomSuffix(): string {
  return randomBytes(6).toString("hex");
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (err) {
    if (hasErrorCode(err, "ENOENT")) return null;
    throw err;
  }
}

async function exists(path: string): Promise<boolean> {
  return (await lstatOrNull(path)) !== null;
}

/** symlinkではない本物のディレクトリかを返す。 */
async function isRealDirectory(path: string): Promise<boolean> {
  const stat = await lstatOrNull(path);
  if (stat === null) return false;
  return stat.isDirectory() && !stat.isSymbolicLink();
}

async function readdirOrEmpty(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (err) {
    if (hasErrorCode(err, "ENOENT")) return [];
    throw err;
  }
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if (hasErrorCode(err, "ENOENT") || err instanceof SyntaxError) return null;
    throw err;
  }
}

/** 同じボリュームの`tmp/`に書いてから`rename`で置き換え、読み手に書きかけを見せない。 */
async function writeAtomically(
  layout: Layout,
  target: string,
  content: string | Uint8Array,
): Promise<void> {
  const temporary = join(layout.tmp, `write-${randomSuffix()}`);
  await writeFile(temporary, content, { mode: 0o644, flag: "wx" });
  await rename(temporary, target);
}

/**
 * `tmp/`に書いてから`link`で`target`に置く。`target`が既にあれば置かずに`false`を返す。
 * `rename`と違い、既にあるファイルを置き換えない。
 */
async function placeWithoutOverwrite(
  layout: Layout,
  target: string,
  content: Uint8Array,
): Promise<boolean> {
  const temporary = join(layout.tmp, `place-${randomSuffix()}`);
  await writeFile(temporary, content, { mode: 0o644, flag: "wx" });
  try {
    await link(temporary, target);
    return true;
  } catch (err) {
    if (hasErrorCode(err, "EEXIST")) return false;
    throw err;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function prepareLayout(layout: Layout): Promise<void> {
  await mkdir(layout.releases, { recursive: true });
  await mkdir(layout.assets, { recursive: true });
  await mkdir(layout.tmp, { recursive: true });
  for (const name of await readdir(layout.tmp)) {
    await rm(join(layout.tmp, name), { recursive: true, force: true });
  }
  for (const name of await readdir(layout.root)) {
    if (/^current\.[0-9a-f]{12}$/.test(name)) {
      await rm(join(layout.root, name), { force: true });
    }
  }
}

/** `current`のsymlinkを読む。symlinkでないもの(EINVAL)は中身を読めないので`unknown`にする。 */
async function readCurrentLink(layout: Layout): Promise<CurrentLink> {
  try {
    return parseCurrentLink(await readlink(layout.current));
  } catch (err) {
    if (hasErrorCode(err, "ENOENT")) return parseCurrentLink(null);
    if (hasErrorCode(err, "EINVAL")) return { kind: "unknown" };
    throw err;
  }
}

function shaOf(current: CurrentLink): string | null {
  return current.kind === "release" ? current.sha : null;
}

async function readHistory(layout: Layout): Promise<string[]> {
  return parseHistory(await readJsonFile(layout.history));
}

async function send(
  deps: FetcherDeps,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await deps.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new FetchFailure("github_unavailable", "network request failed");
  }
}

function apiUrl(config: FetcherConfig, path: string): string {
  const owner = encodeURIComponent(config.owner);
  const repo = encodeURIComponent(config.repo);
  return `${API_ORIGIN}/repos/${owner}/${repo}${path}`;
}

function apiHeaders(config: FetcherConfig): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${config.token}`,
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": USER_AGENT,
  };
}

/** GitHub APIを呼び、JSONを返す。リダイレクトはたどらず失敗として扱う。 */
async function getJson(deps: FetcherDeps, path: string): Promise<unknown> {
  const response = await send(deps, apiUrl(deps.config, path), {
    headers: apiHeaders(deps.config),
    redirect: "manual",
  });
  if (!response.ok) {
    throw new FetchFailure(
      classifyHttpStatus(
        response.status,
        response.headers.get("x-ratelimit-remaining"),
      ),
      `GitHub API returned ${response.status}`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new FetchFailure(
      "unexpected_response",
      "GitHub API returned invalid JSON",
    );
  }
}

async function findLatestRun(deps: FetcherDeps): Promise<WorkflowRun> {
  const query = new URLSearchParams({
    branch: RELEASE_BRANCH,
    event: "push",
    status: "success",
    exclude_pull_requests: "true",
    per_page: "20",
  });
  const runs = parseWorkflowRuns(
    await getJson(deps, `/actions/workflows/${WORKFLOW_FILE}/runs?${query}`),
  );
  if (runs === null) {
    throw new FetchFailure(
      "unexpected_response",
      "workflow run list has an unexpected shape",
    );
  }
  const latest = selectLatestRun(runs);
  if (latest === null) {
    throw new FetchFailure(
      "no_successful_run",
      "no successful push run on main",
    );
  }
  return latest;
}

/** 本文の次の断片を読む。途中で切れた接続や時間切れは`github_unavailable`にする。 */
async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>) {
  try {
    return await reader.read();
  } catch {
    // bunのエラーの文面はログに出さない。
    throw new FetchFailure("github_unavailable", "artifact download failed");
  }
}

/** 本文を読む。APIが申告した大きさではなく、実際に受け取ったバイト数で上限を確かめる。 */
async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await readChunk(reader);
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new FetchFailure(
        "artifact_too_large",
        "artifact download exceeded the size limit",
      );
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * 成果物のzipを取得する。APIの302の`Location`を確かめてから、トークンを付けずに取得する
 * (署名付きURLにトークンは要らず、別のホストへ送らないため)。取得先からのリダイレクトはたどらない。
 */
async function downloadArtifact(
  deps: FetcherDeps,
  artifactId: number,
): Promise<Uint8Array> {
  const redirect = await send(
    deps,
    apiUrl(deps.config, `/actions/artifacts/${artifactId}/zip`),
    { headers: apiHeaders(deps.config), redirect: "manual" },
  );
  if (redirect.status < 300 || redirect.status >= 400) {
    throw new FetchFailure(
      classifyHttpStatus(
        redirect.status,
        redirect.headers.get("x-ratelimit-remaining"),
      ),
      `artifact download returned ${redirect.status}`,
    );
  }
  const location = redirect.headers.get("location");
  if (location === null || !isAllowedDownloadUrl(location)) {
    throw new FetchFailure(
      "unexpected_redirect",
      "artifact download redirected to an unexpected host",
    );
  }
  const response = await send(deps, location, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "error",
  });
  if (!response.ok) {
    throw new FetchFailure(
      "github_unavailable",
      `artifact storage returned ${response.status}`,
    );
  }
  return readBodyWithLimit(response, LIMITS.maxArchiveBytes);
}

function parseJsonBytes(data: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(data));
  } catch {
    return null;
  }
}

/** 取得・照合したエントリとマニフェストを返す。照合に通らなければ例外。ボリュームには何も書かない。 */
async function fetchVerifiedRelease(
  deps: FetcherDeps,
  run: WorkflowRun,
): Promise<{
  readonly entries: readonly ZipEntry[];
  readonly manifest: ConsoleManifest;
}> {
  const query = new URLSearchParams({ name: ARTIFACT_NAME, per_page: "10" });
  const artifacts = parseArtifacts(
    await getJson(deps, `/actions/runs/${run.id}/artifacts?${query}`),
  );
  if (artifacts === null) {
    throw new FetchFailure(
      "unexpected_response",
      "artifact list has an unexpected shape",
    );
  }
  const choice = chooseArtifact(artifacts, run.headSha, LIMITS.maxArchiveBytes);
  if (!choice.ok) throw new FetchFailure(choice.code, "artifact was rejected");
  const archive = await downloadArtifact(deps, choice.artifact.id);
  if (sha256Hex(archive) !== choice.sha256) {
    throw new FetchFailure("digest_mismatch", "artifact digest does not match");
  }
  const zip = readZip(archive, {
    maxEntries: LIMITS.maxEntries,
    maxTotalBytes: LIMITS.maxTotalBytes,
  });
  if (!zip.ok) throw new FetchFailure(zip.code, zip.detail);
  const manifestEntry = zip.entries.find(
    (entry) => entry.path === MANIFEST_FILE,
  );
  if (manifestEntry === undefined) {
    throw new FetchFailure("manifest_invalid", "manifest.json is missing");
  }
  const manifest = parseManifest(parseJsonBytes(manifestEntry.data));
  if (manifest === null) {
    throw new FetchFailure("manifest_invalid", "manifest.json is malformed");
  }
  const actual = new Map(
    zip.entries
      .filter((entry) => entry.path !== MANIFEST_FILE)
      .map((entry) => [entry.path, sha256Hex(entry.data)] as const),
  );
  if (!verifyRelease(manifest, actual, run.headSha)) {
    throw new FetchFailure(
      "manifest_mismatch",
      "release does not match its manifest",
    );
  }
  return { entries: zip.entries, manifest };
}

/** 共有の`assets/`の`target`が`data`と同じ中身の通常のファイルかを返す。無ければ`null`。 */
async function sameSharedAsset(
  target: string,
  data: Uint8Array,
): Promise<boolean | null> {
  const stat = await lstatOrNull(target);
  if (stat === null) return null;
  if (!stat.isFile()) {
    throw new FetchFailure(
      "release_invalid",
      "shared asset path is not a regular file",
    );
  }
  return sha256Hex(await readFile(target)) === sha256Hex(data);
}

function assetConflict(): FetchFailure {
  return new FetchFailure(
    "asset_conflict",
    "a shared asset with the same name has different content",
  );
}

/**
 * ハッシュ付きのファイルを共有の`assets/`に置く。同じ名前で同じ中身なら何もしない。
 * 同じ名前で中身が違えば、置き換えずに`asset_conflict`で止める。書き込みは原子的なので
 * 書きかけは残らず、違いは本当の衝突(名前にハッシュの無いファイルなど)を表す。
 * 置き換えると、その名前を参照する配信中の版が別の中身を読むことになる。
 * 先にすべての名前を確かめてから書くので、衝突したときは何も書かない。
 */
async function publishAssets(
  layout: Layout,
  entries: readonly ZipEntry[],
): Promise<void> {
  const pending: { readonly target: string; readonly data: Uint8Array }[] = [];
  for (const entry of entries) {
    if (!entry.path.startsWith(ASSETS_PREFIX)) continue;
    const target = join(layout.assets, entry.path.slice(ASSETS_PREFIX.length));
    const same = await sameSharedAsset(target, entry.data);
    if (same === false) throw assetConflict();
    if (same === null) pending.push({ target, data: entry.data });
  }
  for (const { target, data } of pending) {
    if (await placeWithoutOverwrite(layout, target, data)) continue;
    // 確かめた後に置かれていた。中身が同じなら置いたのと同じ。
    if ((await sameSharedAsset(target, data)) !== true) throw assetConflict();
  }
}

async function writeRelease(
  layout: Layout,
  sha: string,
  entries: readonly ZipEntry[],
): Promise<void> {
  const stage = join(layout.tmp, `${sha}-${randomSuffix()}`);
  for (const entry of entries) {
    const target = join(stage, entry.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.data, { mode: 0o644, flag: "wx" });
  }
  try {
    await rename(stage, join(layout.releases, sha));
  } catch (err) {
    if (hasErrorCode(err, "EEXIST") || hasErrorCode(err, "ENOTEMPTY")) {
      await rm(stage, { recursive: true, force: true });
      return;
    }
    throw err;
  }
}

/** `releases/<sha>`が本物のディレクトリであることを確かめてから、`current`を原子的に付け替える。 */
async function switchCurrent(layout: Layout, sha: string): Promise<void> {
  if (!(await isRealDirectory(join(layout.releases, sha)))) {
    throw new FetchFailure(
      "release_invalid",
      "release is not a real directory",
    );
  }
  const temporary = join(layout.root, `current.${randomSuffix()}`);
  await symlink(`releases/${sha}`, temporary);
  await rename(temporary, layout.current);
}

/** 新しく取り込んだ版へ付け替えたときだけ呼ぶ。戻す操作とpinを外す操作では呼ばない。 */
async function recordHistory(layout: Layout, sha: string): Promise<void> {
  const history = await readHistory(layout);
  if (history.at(-1) === sha) return;
  await writeAtomically(
    layout,
    layout.history,
    `${JSON.stringify(appendHistory(history, sha, HISTORY_LIMIT))}\n`,
  );
}

/** 版のマニフェストを読む。無いとき、壊れているとき、読めないときは`null`。 */
async function readManifest(
  layout: Layout,
  sha: string,
): Promise<ConsoleManifest | null> {
  try {
    return parseManifest(
      await readJsonFile(join(layout.releases, sha, MANIFEST_FILE)),
    );
  } catch {
    return null;
  }
}

/**
 * `releases/<sha>`が配信できる版かを返す。本物のディレクトリで、マニフェストを読め、
 * 参照する共有の`assets/`のファイルがすべて通常のファイルとして揃っているとき。
 * 揃っていない版を配信すると、ページが壊れる。取り込みの再利用と、戻し先の選択が同じ定義を使う。
 * 読み込み済みのマニフェストがあれば`manifest`に渡す(渡さなければ読む)。
 */
async function isCompleteRelease(
  layout: Layout,
  sha: string,
  manifest?: ConsoleManifest | null,
): Promise<boolean> {
  if (!(await isRealDirectory(join(layout.releases, sha)))) return false;
  const parsed =
    manifest === undefined ? await readManifest(layout, sha) : manifest;
  if (parsed === null) return false;
  for (const path of parsed.files.keys()) {
    if (!path.startsWith(ASSETS_PREFIX)) continue;
    const stat = await lstatOrNull(
      join(layout.assets, path.slice(ASSETS_PREFIX.length)),
    );
    if (stat === null || !stat.isFile()) return false;
  }
  return true;
}

/** `revoked.json`を読む。無いときや読めないときは空の記録。 */
async function readRevokedState(layout: Layout) {
  return parseRevokedState(await readJsonFile(layout.revoked));
}

/** 戻した元の版のshaと中身を`revoked.json`に足す。足すものが無ければ何もしない。 */
async function recordRevoked(
  layout: Layout,
  shas: readonly string[],
  digests: readonly string[],
): Promise<void> {
  if (shas.length === 0 && digests.length === 0) return;
  await mkdir(layout.tmp, { recursive: true });
  const state = mergeRevokedState(
    await readRevokedState(layout),
    shas,
    digests,
  );
  await writeAtomically(layout, layout.revoked, `${JSON.stringify(state)}\n`);
}

/**
 * 戻した元の版(`revoked`)の`releases/<sha>`と、その版だけが参照する共有の`assets/`のファイルを消す。
 * 戻した後も問題の版のassetsを`/console/assets/`から読めるままにしないため、更新日時にかかわらず消す。
 * 配信中の版と、残る版が参照するassetsは消さない。通常のファイルでないassetsも消さない。
 * 消すassetsを決められないとき(`current`のリンクと、配信中の版と、戻した元の版のマニフェストのどれかを
 * 読めないとき)は、版も消さずに警告を出す。版を消すと、残ったassetsを後から決められなくなるため。
 * 配信中でない残る版のマニフェストを読めないときは、その版を無視して消す。
 * 無視しないと、壊れた版が1つあるだけで、戻した元の版を消せなくなる。
 * 無視した版が配信されることは無い。`rollback`は、`isCompleteRelease`を満たさない版を戻し先に選ばず、
 * 取り込みは、揃っていない版を消して取り直すため。
 * 途中で止まっても、同じ`revoked`で呼び直せば続きを消せる。
 * 戻した元の版を残さず消せた(消す版が無かった場合を含む)ときだけ`true`を返す。
 */
async function removeRevoked(
  layout: Layout,
  log: Logger,
  revoked: readonly string[],
): Promise<boolean> {
  const current = await readCurrentLink(layout);
  const existing = (await readdirOrEmpty(layout.releases)).filter(isCommitSha);
  const present = existing.filter((sha) => revoked.includes(sha));
  if (current.kind === "unknown") {
    if (present.length > 0) {
      log("revoked_cleanup_skipped", { reason: "current_unreadable" });
    }
    return present.length === 0;
  }
  const serving = shaOf(current);
  const doomed = present.filter((sha) => sha !== serving);
  if (doomed.length === 0) return true;
  if (serving !== null && (await readManifest(layout, serving)) === null) {
    log("revoked_cleanup_skipped", { reason: "current_manifest_unreadable" });
    return false;
  }
  const doomedManifests: (ConsoleManifest | null)[] = [];
  for (const sha of doomed) {
    doomedManifests.push(await readManifest(layout, sha));
  }
  const remaining: (ConsoleManifest | null)[] = [];
  for (const sha of existing.filter((sha) => !doomed.includes(sha))) {
    remaining.push(await readManifest(layout, sha));
  }
  const names = selectRevokedAssets(doomedManifests, remaining);
  if (names === null) {
    log("revoked_cleanup_skipped", { reason: "assets_undeterminable" });
    return false;
  }
  // 先にassetsを消し、止まったときも続きの版の削除を呼び直せるようにする。
  for (const name of names) {
    const path = join(layout.assets, name);
    if ((await lstatOrNull(path))?.isFile()) await rm(path, { force: true });
  }
  for (const sha of doomed) {
    const dir = join(layout.releases, sha);
    if (await isRealDirectory(dir)) {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return true;
}

async function listAssetFiles(layout: Layout): Promise<AssetFile[]> {
  const files: AssetFile[] = [];
  for (const name of await readdir(layout.assets)) {
    const stat = await lstat(join(layout.assets, name));
    if (stat.isFile()) files.push({ name, mtimeMs: stat.mtimeMs });
  }
  return files;
}

/**
 * 古い版と、どの版からも参照されない古いassetを消す。削除はsymlinkをたどらない。
 * 残す版は、中身の違う版を`releasesToKeep`個まで数えて決める。
 * `current`はここで読み直し、ディスクの今の状態で残す版を決める。
 */
async function cleanup(deps: FetcherDeps, layout: Layout): Promise<void> {
  const revokedState = await readRevokedState(layout);
  const manifests = new Map<string, ConsoleManifest | null>();
  for (const sha of (await readdir(layout.releases)).filter(isCommitSha)) {
    manifests.set(sha, await readManifest(layout, sha));
  }
  // 戻した元の版は、保持の数え方にかかわらず先に消す。
  const revoked = selectRevokedReleases(
    [...manifests.keys()],
    manifests,
    revokedState,
  );
  if (revoked.length > 0) {
    try {
      await removeRevoked(layout, deps.log, revoked);
    } catch (err) {
      deps.log("revoked_cleanup_failed", {
        error: describeUnexpectedError(err),
      });
    }
  }
  const existing = (await readdir(layout.releases)).filter(isCommitSha);
  const toDelete = selectReleasesToDelete(
    existing,
    await readHistory(layout),
    await readCurrentLink(layout),
    LIMITS.releasesToKeep,
    manifests,
  );
  for (const sha of toDelete) {
    const dir = join(layout.releases, sha);
    if (await isRealDirectory(dir)) {
      await rm(dir, { recursive: true, force: true });
      deps.log("release_removed", { sha });
    }
  }
  const kept = existing.filter((sha) => !toDelete.includes(sha));
  const stale = selectAssetsToDelete(
    await listAssetFiles(layout),
    referencedAssetNames(kept.map((sha) => manifests.get(sha) ?? null)),
    deps.now().getTime(),
    LIMITS.assetMaxAgeMs,
  );
  for (const name of stale) {
    await rm(join(layout.assets, name), { force: true });
  }
  const pruned = pruneRevokedState(revokedState, kept);
  if (pruned.shas.length !== revokedState.shas.length) {
    await writeAtomically(
      layout,
      layout.revoked,
      `${JSON.stringify(pruned)}\n`,
    );
  }
}

async function finish(
  deps: FetcherDeps,
  layout: Layout,
  status: FetcherStatus,
): Promise<FetcherStatus> {
  await writeAtomically(layout, layout.status, `${JSON.stringify(status)}\n`);
  deps.log("status", {
    state: status.state,
    sha: status.sha,
    error: status.error,
  });
  return status;
}

/**
 * 1回分の取り込みを行い、status.jsonに書いた状態を返す。例外は投げない。
 * pinがあればGitHubに問い合わせない。取り込みや検証で失敗したときはcurrentを変えない。
 */
export async function runOnce(deps: FetcherDeps): Promise<FetcherStatus> {
  const layout = layoutOf(deps.root);
  const checkedAt = deps.now().toISOString();
  let currentSha: string | null = null;
  try {
    await prepareLayout(layout);
    currentSha = shaOf(await readCurrentLink(layout));
    if (await exists(layout.pin)) {
      // rollbackが途中で止まっていたときのために、戻した元の版の削除を続ける。
      // 削除に失敗しても、pinの状態は変えず、次の回に続きを消す。
      try {
        await removeRevoked(
          layout,
          deps.log,
          parsePinRevoked(await readJsonFile(layout.pin)),
        );
      } catch (err) {
        deps.log("revoked_cleanup_failed", {
          error: describeUnexpectedError(err),
        });
      }
      return await finish(deps, layout, {
        state: "pinned",
        sha: currentSha,
        checked_at: checkedAt,
        error: null,
      });
    }
    const run = await findLatestRun(deps);
    if (needsDeploy(currentSha, run.headSha)) {
      // assetsが欠けた版(戻した元の版の削除が途中で止まったものなど)は、消して取り直す。
      if (!(await isCompleteRelease(layout, run.headSha))) {
        await rm(join(layout.releases, run.headSha), {
          recursive: true,
          force: true,
        });
        const { entries } = await fetchVerifiedRelease(deps, run);
        await publishAssets(layout, entries);
        await writeRelease(layout, run.headSha, entries);
      }
      // rollbackと同時に動いたときは、人の判断を優先して付け替えない。
      if (await exists(layout.pin)) {
        return await finish(deps, layout, {
          state: "pinned",
          sha: currentSha,
          checked_at: checkedAt,
          error: null,
        });
      }
      await switchCurrent(layout, run.headSha);
      // 履歴に残せなくても、status.jsonには付け替えた後の版を書く。
      currentSha = run.headSha;
      await recordHistory(layout, run.headSha);
      deps.log("deployed", { sha: run.headSha, run_id: run.id });
    }
    await cleanup(deps, layout);
    return await finish(deps, layout, {
      state: "ok",
      sha: currentSha,
      checked_at: checkedAt,
      error: null,
    });
  } catch (err) {
    const code: FetchErrorCode =
      err instanceof FetchFailure ? err.code : "filesystem_error";
    const detail =
      err instanceof FetchFailure ? err.message : describeUnexpectedError(err);
    deps.log("failed", { error: code, detail });
    const status: FetcherStatus = {
      state: "failed",
      sha: currentSha,
      checked_at: checkedAt,
      error: code,
    };
    try {
      return await finish(deps, layout, status);
    } catch {
      deps.log("status_write_failed", { error: code });
      return status;
    }
  }
}

/**
 * 5分ごとの繰り返しの1回分を実行する。投げられた例外では止まらず、1行のログにして次の回を待つ。
 * ロックを作れない(EACCESなど)ときのように、`runOnce`の外で起きた失敗もここで受け止める。
 * ログには分類した失敗の種類だけを出し、スタックトレースや詳細は出さない。
 */
export async function runLoopIteration(
  action: () => Promise<void>,
  log: Logger,
): Promise<void> {
  try {
    await action();
  } catch (err) {
    const code: FetchErrorCode =
      err instanceof FetchFailure ? err.code : "filesystem_error";
    log("failed", { error: code });
  }
}

/** 設定が無いときに、その旨をstatus.jsonに書く。currentは変えない。 */
export async function recordConfigFailure(
  root: string,
  now: () => Date,
  log: Logger,
): Promise<FetcherStatus> {
  const layout = layoutOf(root);
  await prepareLayout(layout);
  const status: FetcherStatus = {
    state: "failed",
    sha: shaOf(await readCurrentLink(layout)),
    checked_at: now().toISOString(),
    error: "config_missing",
  };
  await writeAtomically(layout, layout.status, `${JSON.stringify(status)}\n`);
  log("status", { state: status.state, sha: status.sha, error: status.error });
  return status;
}

export type RollbackResult =
  | {
      readonly ok: true;
      readonly sha: string;
      /** 戻した元の版の削除。`pending`なら、次の取り込みが続きを消す。 */
      readonly cleanup: "done" | "pending";
      /** 戻した元の版の中身をpinに記録できたか。マニフェストを読めなかったときは`false`。 */
      readonly contentRecorded: boolean;
    }
  | { readonly ok: false; readonly reason: "no_previous_release" };

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (hasErrorCode(err, "ENOENT")) return null;
    throw err;
  }
}

/**
 * 付け替えに失敗したときに、pinを書く前の状態(`previous`。無ければ無し)へ戻す。
 * 戻せなくても、呼び出し側が投げる元の失敗を隠さないよう、ログだけを出す。
 */
async function restorePin(
  layout: Layout,
  previous: string | null,
  log: Logger,
): Promise<void> {
  try {
    if (previous === null) {
      await rm(layout.pin, { force: true });
    } else {
      await writeAtomically(layout, layout.pin, previous);
    }
  } catch (err) {
    log("pin_restore_failed", { error: describeUnexpectedError(err) });
  }
}

/** `removeRevoked`を呼び、失敗を投げずに結果(`done`か`pending`)にする。 */
async function tryRemoveRevoked(
  layout: Layout,
  log: Logger,
  revoked: readonly string[],
): Promise<"done" | "pending"> {
  try {
    return (await removeRevoked(layout, log, revoked)) ? "done" : "pending";
  } catch (err) {
    log("revoked_cleanup_failed", { error: describeUnexpectedError(err) });
    return "pending";
  }
}

/**
 * currentを直前の版に戻し、pinを置く。pinがある間、runOnceは付け替えない。
 * 戻す先は、今の版と中身が違い、配信できる(`isCompleteRelease`)、履歴の直前の版にする。
 * 戻した元の版(`revoked.json`の記録にあるshaか中身の版)は、`pin`を外した後も戻し先にしない。
 * `switchTo`は付け替えの代わりに呼ぶ関数で、テストが付け替えの失敗を再現するために差し替える。
 * pinを先に置いてから付け替え、同時に動いたrunOnceが新しい版へ戻さないようにする。
 * 付け替えに失敗したときは、pinを元の状態に戻してから失敗を投げる(戻せなくても元の失敗を投げる)。
 * pinだけが残ると、版が動かないまま自動の付け替えが止まるため。
 * 戻した元の版の中身(`files`のsha256)は、`rolled_back_content`に記録する。
 * `unpin`が、新しいcommitが同じ中身の版を作っていないかを確かめるために使う。
 * 履歴には足さない(足すと、次に戻すときに新しい方の版を選んでしまう)。
 * 戻した元の版と、それと中身が同じ版は、pinの`rolled_back_from`に記録して、
 * その版と、その版だけが使うassetsを消す(戻した後も問題のscriptを読めるままにしないため)。
 * 消すのに失敗しても戻す操作は成功とし、`cleanup: "pending"`を返す。続きは次の取り込みが消す。
 * 戻した元の版のshaと中身は、`revoked.json`にも記録する(`pin`を外しても残る)。
 * 消した版は、pinを外した後の取り込みで、最新の実行から取り直される。
 */
export async function rollback(
  root: string,
  now: () => Date,
  log: Logger = () => {},
  switchTo?: (sha: string) => Promise<void>,
): Promise<RollbackResult> {
  const layout = layoutOf(root);
  const switchCurrentTo =
    switchTo ?? ((sha: string) => switchCurrent(layout, sha));
  await mkdir(layout.tmp, { recursive: true });
  const currentSha = shaOf(await readCurrentLink(layout));
  const releases = (await readdirOrEmpty(layout.releases)).filter(isCommitSha);
  const manifests = new Map<string, ConsoleManifest | null>();
  for (const sha of releases) {
    manifests.set(sha, await readManifest(layout, sha));
  }
  // 配信できない版と、戻した元の版(後から残った版を含む)は、戻し先にしない。
  const revokedState = await readRevokedState(layout);
  const usable = new Set<string>();
  for (const sha of releases) {
    const manifest = manifests.get(sha) ?? null;
    if (
      !isRevokedRelease(sha, manifest, revokedState) &&
      (await isCompleteRelease(layout, sha, manifest))
    ) {
      usable.add(sha);
    }
  }
  const target = selectRollbackTarget(
    await readHistory(layout),
    currentSha,
    usable,
    manifests,
  );
  if (target === null || currentSha === null) {
    return { ok: false, reason: "no_previous_release" };
  }
  const previousPin = await readTextOrNull(layout.pin);
  const previousPinJson = await readJsonFile(layout.pin);
  if (previousPin !== null && !isReadablePin(previousPinJson)) {
    log("rollback_previous_pin_unreadable", {});
  }
  const revoked = [
    ...new Set([
      ...parsePinRevoked(previousPinJson),
      ...selectIdenticalReleases(currentSha, manifests),
    ]),
  ];
  const currentManifest = manifests.get(currentSha) ?? null;
  if (currentManifest === null) {
    log("rollback_content_unrecorded", { sha: currentSha });
  }
  const revokedContent = [
    ...new Set([
      ...parsePinContent(previousPinJson),
      ...(currentManifest === null ? [] : [contentDigest(currentManifest)]),
    ]),
  ];
  const pinnedAt = now().toISOString();
  await writeAtomically(
    layout,
    layout.pin,
    `${JSON.stringify({ sha: target, pinned_at: pinnedAt, rolled_back_from: revoked, rolled_back_content: revokedContent })}\n`,
  );
  try {
    await switchCurrentTo(target);
  } catch (err) {
    await restorePin(layout, previousPin, log);
    throw err;
  }
  await recordRevoked(layout, revoked, revokedContent);
  const status: FetcherStatus = {
    state: "pinned",
    sha: target,
    checked_at: pinnedAt,
    error: null,
  };
  await writeAtomically(layout, layout.status, `${JSON.stringify(status)}\n`);
  return {
    ok: true,
    sha: target,
    cleanup: await tryRemoveRevoked(layout, log, revoked),
    contentRecorded: currentManifest !== null,
  };
}

export type UnpinDeps = {
  readonly fetch: FetchLike;
  readonly now: () => Date;
  readonly root: string;
  /** GitHubの設定。無ければ最新の実行を確かめられないので、`force`なしでは外せない。 */
  readonly config: FetcherConfig | null;
  readonly log: Logger;
};

/** 最新の成功した実行を返す。設定が無いときと、問い合わせに失敗したときは`null`。 */
async function lookupLatestRun(deps: UnpinDeps): Promise<WorkflowRun | null> {
  if (deps.config === null) return null;
  try {
    return await findLatestRun({ ...deps, config: deps.config });
  } catch (err) {
    deps.log("unpin_lookup_failed", {
      error: err instanceof FetchFailure ? err.code : "unexpected_error",
    });
    return null;
  }
}

/**
 * `run`の版の中身(`files`)のsha256を返す。ディスクに版があればそのマニフェストを使い、
 * 無ければ`run`の成果物を取得して照合する(ボリュームには何も書かない)。分からなければ`null`。
 */
async function latestRunDigest(
  deps: UnpinDeps,
  layout: Layout,
  run: WorkflowRun,
): Promise<string | null> {
  const onDisk = await readManifest(layout, run.headSha);
  if (onDisk !== null) return contentDigest(onDisk);
  if (deps.config === null) return null;
  try {
    const { manifest } = await fetchVerifiedRelease(
      { ...deps, config: deps.config },
      run,
    );
    return contentDigest(manifest);
  } catch (err) {
    deps.log("unpin_content_lookup_failed", {
      error: err instanceof FetchFailure ? err.code : "unexpected_error",
    });
    return null;
  }
}

/**
 * pinを外す。次の取り込み(5分以内)から、最新の版への自動の付け替えに戻る。
 * 外す前に、戻した元の版の削除を終え、その版のshaと中身を`revoked.json`に記録する。
 * 記録は`pin`を外しても残り、取り込みの整理が、消せなかった版を先に消す。
 * 次の取り込みが最新の実行を取り直したとき、問題の版が再び配信されるのを防ぐため、
 * 次の場合は、pinを外さずに理由を返す。
 * - 最新の成功した実行のshaが、戻した元の版のshaである。
 * - 最新の成功した実行の中身(`files`)が、戻した元の版と同じである。
 *   Consoleに触れないマージも、同じ中身の版を新しいshaで作るため、shaだけでは見分けられない。
 * - 最新の実行や、その中身を調べられない(分からないときは外さない)。
 * - 戻した元の版を消せていない。
 * `force`は最新の実行についての確認を、`ignoreCleanup`は削除についての確認を飛ばす。
 * pinを読めないときも、何を戻したか分からないので外さない(`force`なら外す)。
 * `rolled_back_from`も`rolled_back_content`も無いpinは、確かめる版が無いので、問い合わせずに外す。
 * 中身を記録していないpinは、shaだけを確かめる。
 */
export async function unpin(
  deps: UnpinDeps,
  options: UnpinOptions,
): Promise<UnpinResult> {
  const layout = layoutOf(deps.root);
  if (!(await exists(layout.pin))) return { ok: true };
  const pin = await readJsonFile(layout.pin);
  if (!options.force && !isReadablePin(pin)) {
    return { ok: false, reason: "pin_unreadable" };
  }
  const revoked = parsePinRevoked(pin);
  const revokedContent = parsePinContent(pin);
  if (!options.force && (revoked.length > 0 || revokedContent.length > 0)) {
    const run = await lookupLatestRun(deps);
    if (run === null) return { ok: false, reason: "lookup_failed" };
    if (revoked.includes(run.headSha)) {
      return { ok: false, reason: "latest_run_is_revoked", sha: run.headSha };
    }
    if (revokedContent.length > 0) {
      const digest = await latestRunDigest(deps, layout, run);
      if (digest === null) {
        return {
          ok: false,
          reason: "content_undeterminable",
          sha: run.headSha,
        };
      }
      if (revokedContent.includes(digest)) {
        return {
          ok: false,
          reason: "latest_run_has_revoked_content",
          sha: run.headSha,
        };
      }
    }
  }
  let complete = false;
  try {
    complete = await removeRevoked(layout, deps.log, revoked);
  } catch (err) {
    if (!options.ignoreCleanup) throw err;
    deps.log("revoked_cleanup_failed", {
      error: describeUnexpectedError(err),
    });
  }
  if (!complete && !options.ignoreCleanup) {
    return { ok: false, reason: "cleanup_incomplete" };
  }
  await recordRevoked(layout, revoked, revokedContent);
  await rm(layout.pin, { force: true });
  return { ok: true };
}

export type LockResult<T> =
  | { readonly acquired: true; readonly value: T }
  | { readonly acquired: false };

async function tryCreateLock(
  lockPath: string,
  now: () => Date,
): Promise<boolean> {
  try {
    await writeFile(
      lockPath,
      `${JSON.stringify({ acquired_at: now().toISOString() })}\n`,
      { mode: 0o644, flag: "wx" },
    );
    return true;
  } catch (err) {
    if (hasErrorCode(err, "EEXIST")) return false;
    throw err;
  }
}

/**
 * ボリュームのロック(`lock`)を取って`action`を実行し、終わったら(失敗しても)外す。
 * loop・once・rollback・unpinが同じロックを使い、`tmp/`や`current`を同時に触らない。
 * 他が持っていれば`action`を実行せず`acquired: false`を返す。
 * 持ち主が止まって残ったロック(取ってから`LOCK_STALE_MS`を超えたもの)は取り除いて取り直す。
 */
export async function withLock<T>(
  root: string,
  now: () => Date,
  action: () => Promise<T>,
): Promise<LockResult<T>> {
  const lockPath = layoutOf(root).lock;
  if (!(await tryCreateLock(lockPath, now))) {
    const content = await readJsonFile(lockPath);
    if (!isLockStale(content, now().getTime(), LOCK_STALE_MS)) {
      return { acquired: false };
    }
    await rm(lockPath, { force: true });
    if (!(await tryCreateLock(lockPath, now))) return { acquired: false };
  }
  try {
    return { acquired: true, value: await action() };
  } finally {
    await rm(lockPath, { force: true });
  }
}
