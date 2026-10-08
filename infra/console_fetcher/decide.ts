// console_fetcherの判定を、I/Oを持たない純粋関数にまとめる。
// GitHub APIの応答とボリュームの状態を受け取り、何をするか(どの版を取り込み、何を消し、どこへ戻すか)だけを返す。
import { createHash } from "node:crypto";
import { isSafeReleasePath } from "./zip.ts";

export const ARTIFACT_NAME = "console-dist";
export const WORKFLOW_FILE = "ci.yml";
export const WORKFLOW_PATH = ".github/workflows/ci.yml";
export const RELEASE_BRANCH = "main";
export const MANIFEST_FILE = "manifest.json";
export const HISTORY_LIMIT = 20;

/**
 * status.jsonの`error`に書く分類。トークンや応答の本文は書かず、運用者が次の操作を選べる粒度にする。
 */
export type FetchErrorCode =
  | "config_missing"
  | "auth_failed"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "github_unavailable"
  | "unexpected_response"
  | "no_successful_run"
  | "artifact_missing"
  | "artifact_expired"
  | "artifact_mismatch"
  | "artifact_too_large"
  | "digest_missing"
  | "digest_mismatch"
  | "unexpected_redirect"
  | "zip_invalid"
  | "zip_unsafe_entry"
  | "manifest_invalid"
  | "manifest_mismatch"
  | "release_invalid"
  | "asset_conflict"
  | "filesystem_error";

export type FetcherState = "ok" | "failed" | "pinned";

export type FetcherStatus = {
  readonly state: FetcherState;
  readonly sha: string | null;
  readonly checked_at: string;
  readonly error: FetchErrorCode | null;
};

export type FetcherConfig = {
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
};

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9_]+$/;
const REPO_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;
const DOWNLOAD_HOST_SUFFIX = ".blob.core.windows.net";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCommitSha(value: string): boolean {
  return COMMIT_SHA.test(value);
}

/**
 * 環境変数から設定を読む。トークンは英数字と`_`だけを認め、改行などがヘッダーに混ざるのを防ぐ。
 * リポジトリは`https://github.com/<owner>/<repo>`の形だけを認める。満たさなければ`null`。
 */
export function parseFetcherConfig(env: {
  readonly CONSOLE_GITHUB_TOKEN?: string | undefined;
  readonly CONSOLE_GITHUB_REPO?: string | undefined;
}): FetcherConfig | null {
  const token = env.CONSOLE_GITHUB_TOKEN ?? "";
  if (!TOKEN.test(token)) return null;
  const match = REPO_URL.exec(env.CONSOLE_GITHUB_REPO ?? "");
  const owner = match?.[1];
  const repo = match?.[2];
  if (owner === undefined || repo === undefined) return null;
  if (repo === "." || repo === "..") return null;
  return { token, owner, repo };
}

export type WorkflowRun = {
  readonly id: number;
  readonly headSha: string;
  readonly headBranch: string | null;
  readonly event: string;
  readonly status: string | null;
  readonly conclusion: string | null;
  readonly path: string;
  readonly createdAt: string;
};

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** ワークフロー実行の一覧の応答を読む。形の違う要素は飛ばし、全体の形が違えば`null`。 */
export function parseWorkflowRuns(body: unknown): WorkflowRun[] | null {
  if (!isRecord(body) || !Array.isArray(body.workflow_runs)) return null;
  const runs: WorkflowRun[] = [];
  for (const item of body.workflow_runs) {
    if (!isRecord(item)) continue;
    const { id, head_sha, event, path, created_at } = item;
    if (
      typeof id !== "number" ||
      typeof head_sha !== "string" ||
      typeof event !== "string" ||
      typeof path !== "string" ||
      typeof created_at !== "string"
    ) {
      continue;
    }
    runs.push({
      id,
      headSha: head_sha,
      headBranch: nullableString(item.head_branch),
      event,
      status: nullableString(item.status),
      conclusion: nullableString(item.conclusion),
      path,
      createdAt: created_at,
    });
  }
  return runs;
}

/**
 * `main`へのpushで動き、全体が成功した`ci.yml`の実行のうち、最も新しく作られたものを返す。
 * APIの絞り込みに加えてここでも条件を確かめる(APIの仕様が変わっても、別の実行を取り込まないため)。
 */
export function selectLatestRun(
  runs: readonly WorkflowRun[],
): WorkflowRun | null {
  let latest: WorkflowRun | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const run of runs) {
    if (
      run.event !== "push" ||
      run.headBranch !== RELEASE_BRANCH ||
      run.status !== "completed" ||
      run.conclusion !== "success" ||
      run.path !== WORKFLOW_PATH ||
      !isCommitSha(run.headSha)
    ) {
      continue;
    }
    const time = Date.parse(run.createdAt);
    if (Number.isNaN(time)) continue;
    if (
      latest === null ||
      time > latestTime ||
      (time === latestTime && run.id > latest.id)
    ) {
      latest = run;
      latestTime = time;
    }
  }
  return latest;
}

export function needsDeploy(
  currentSha: string | null,
  latestSha: string,
): boolean {
  return currentSha !== latestSha;
}

export type Artifact = {
  readonly id: number;
  readonly name: string;
  readonly sizeInBytes: number;
  readonly expired: boolean;
  readonly digest: string | null;
  readonly headSha: string | null;
};

/** 実行の成果物の一覧の応答を読む。形の違う要素は飛ばし、全体の形が違えば`null`。 */
export function parseArtifacts(body: unknown): Artifact[] | null {
  if (!isRecord(body) || !Array.isArray(body.artifacts)) return null;
  const artifacts: Artifact[] = [];
  for (const item of body.artifacts) {
    if (!isRecord(item)) continue;
    const { id, name, size_in_bytes, expired } = item;
    if (
      typeof id !== "number" ||
      typeof name !== "string" ||
      typeof size_in_bytes !== "number" ||
      typeof expired !== "boolean"
    ) {
      continue;
    }
    const run = item.workflow_run;
    artifacts.push({
      id,
      name,
      sizeInBytes: size_in_bytes,
      expired,
      digest: nullableString(item.digest),
      headSha: isRecord(run) ? nullableString(run.head_sha) : null,
    });
  }
  return artifacts;
}

/** `sha256:<64桁のhex>`からhexを取り出す。形が違えば`null`。 */
export function parseDigest(digest: string | null): string | null {
  const match = /^sha256:([0-9a-f]{64})$/.exec(digest ?? "");
  return match?.[1] ?? null;
}

export type ArtifactChoice =
  | { readonly ok: true; readonly artifact: Artifact; readonly sha256: string }
  | { readonly ok: false; readonly code: FetchErrorCode };

/**
 * 取り込む成果物を選ぶ。名前が`console-dist`で期限切れでないもののうち`id`が最大のものを選び、
 * 元のcommit・大きさ・digestを確かめる。元のcommitが分からない成果物は取り込まない。
 */
export function chooseArtifact(
  artifacts: readonly Artifact[],
  expectedSha: string,
  maxBytes: number,
): ArtifactChoice {
  const named = artifacts.filter((artifact) => artifact.name === ARTIFACT_NAME);
  if (named.length === 0) return { ok: false, code: "artifact_missing" };
  const live = named.filter((artifact) => !artifact.expired);
  const [first, ...rest] = live;
  if (first === undefined) return { ok: false, code: "artifact_expired" };
  const chosen = rest.reduce((a, b) => (b.id > a.id ? b : a), first);
  if (chosen.headSha !== expectedSha) {
    return { ok: false, code: "artifact_mismatch" };
  }
  if (chosen.sizeInBytes > maxBytes) {
    return { ok: false, code: "artifact_too_large" };
  }
  const sha256 = parseDigest(chosen.digest);
  if (sha256 === null) return { ok: false, code: "digest_missing" };
  return { ok: true, artifact: chosen, sha256 };
}

/** GitHub APIの失敗の応答を分類する。`rateLimitRemaining`は`x-ratelimit-remaining`の値。 */
export function classifyHttpStatus(
  status: number,
  rateLimitRemaining: string | null,
): FetchErrorCode {
  if (status === 401) return "auth_failed";
  if (status === 403) {
    return rateLimitRemaining === "0" ? "rate_limited" : "forbidden";
  }
  if (status === 404) return "not_found";
  if (status === 410) return "artifact_expired";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "github_unavailable";
  return "unexpected_response";
}

/**
 * 成果物のダウンロードのリダイレクト先として認めるかを返す。
 * GitHubが実際に返す行き先(Azureのblob storage)の`https:`だけを認め、資格情報やポートを含むURLは拒む。
 */
export function isAllowedDownloadUrl(location: string): boolean {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "" || url.port !== "")
    return false;
  return url.hostname.endsWith(DOWNLOAD_HOST_SUFFIX);
}

export type ConsoleManifest = {
  readonly version: 1;
  readonly sha: string;
  readonly files: ReadonlyMap<string, string>;
};

/**
 * manifest.jsonの中身を読む。形の規則はconsole/scripts/manifest.tsのbuildManifestと同じ。
 * 安全でないパス、入れ子のassets、`index.html`の欠落、不正なハッシュがあれば`null`。
 */
export function parseManifest(value: unknown): ConsoleManifest | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const { sha, files } = value;
  if (typeof sha !== "string" || !isCommitSha(sha) || !isRecord(files)) {
    return null;
  }
  const parsed = new Map<string, string>();
  for (const [path, hash] of Object.entries(files)) {
    if (path === MANIFEST_FILE || !isSafeReleasePath(path)) return null;
    if (path.startsWith("assets/") && path.split("/").length !== 2) return null;
    if (typeof hash !== "string" || !SHA256_HEX.test(hash)) return null;
    parsed.set(path, hash);
  }
  if (!parsed.has("index.html")) return null;
  return { version: 1, sha, files: parsed };
}

/**
 * 展開したファイル(`manifest.json`を除く、パスとsha256の対応)が、マニフェストと過不足なく一致し、
 * マニフェストが取り込む実行のcommitのものかを返す。
 */
export function verifyRelease(
  manifest: ConsoleManifest,
  actual: ReadonlyMap<string, string>,
  expectedSha: string,
): boolean {
  if (manifest.sha !== expectedSha) return false;
  if (actual.size !== manifest.files.size) return false;
  for (const [path, hash] of manifest.files) {
    if (actual.get(path) !== hash) return false;
  }
  return true;
}

/** `current`のsymlinkの中身(`releases/<sha>`)からshaを取り出す。形が違えば`null`。 */
export function currentShaFromLink(target: string): string | null {
  const match = /^releases\/([0-9a-f]{40})$/.exec(target);
  return match?.[1] ?? null;
}

/**
 * `current`のsymlinkの状態。`none`はリンクが無い、`release`は`releases/<sha>`を指す、
 * `unknown`はリンクはあるが中身を読めない(配信中かもしれない)ことを表す。
 */
export type CurrentLink =
  | { readonly kind: "none" }
  | { readonly kind: "release"; readonly sha: string }
  | { readonly kind: "unknown" };

/** `current`のsymlinkの中身を読む。`target`はリンクが無ければ`null`、あればその中身。 */
export function parseCurrentLink(target: string | null): CurrentLink {
  if (target === null) return { kind: "none" };
  const sha = currentShaFromLink(target);
  return sha === null ? { kind: "unknown" } : { kind: "release", sha };
}

/** history.jsonの中身を読む。shaの形でない要素は捨てる。 */
export function parseHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && isCommitSha(item),
  );
}

/**
 * 付け替えの履歴の末尾に`sha`を足し、古い方から`limit`件を超えた分を捨てる。
 * 新しく取り込んだ版へ付け替えたときだけ呼ぶ。戻す操作とpinを外す操作では呼ばない
 * (戻した版を足すと、次に戻すときに`selectRollbackTarget`が新しい方の版を返してしまう)。
 */
export function appendHistory(
  history: readonly string[],
  sha: string,
  limit: number,
): string[] {
  return [...history, sha].slice(-limit);
}

/** 版の中身を表す文字列。`files`が同じ版は同じ文字列になる。 */
function contentKey(manifest: ConsoleManifest): string {
  return JSON.stringify([...manifest.files].sort());
}

/**
 * 版の中身(`files`)のsha256。commitのshaには依らず、`files`が同じ版は同じ値になる。
 * 戻した元の版の中身をpinに記録し、後から同じ中身の版を見分けるために使う。
 */
export function contentDigest(manifest: ConsoleManifest): string {
  return createHash("sha256").update(contentKey(manifest)).digest("hex");
}

/**
 * 消す`releases/<sha>`を返す。付け替えの履歴の新しい方から、`keep`個の「中身の違う版」と、
 * 今の`current`(戻してpinした古い版を含む)を残す。
 * Consoleに触れないマージでも中身の同じ版ができるので、`files`が同じ版は1つと数える
 * (数えないと、無関係なマージが続いたとき、戻せる版が履歴から押し出される)。
 * 数えた中身と同じ版は、数が`keep`を超えても残す。
 * 残っていない版は数えない。
 * マニフェストを読めない版は、比べられないので、それぞれ別の版と数える。
 * 中身の同じ版を別の版と数える側に倒すので、残る版が多くなる方にずれる。
 * 履歴に無い版(付け替える前に止まったもの)は消す。
 * `current`のリンクを読めない(`unknown`)ときは、どの版を配信中か分からないので何も消さない。
 */
export function selectReleasesToDelete(
  existing: readonly string[],
  history: readonly string[],
  current: CurrentLink,
  keep: number,
  manifests: ReadonlyMap<string, ConsoleManifest | null>,
): string[] {
  if (current.kind === "unknown") return [];
  const present = new Set(existing);
  const kept = new Set<string>();
  const versions = new Set<string>();
  for (let index = history.length - 1; index >= 0; index--) {
    const sha = history[index];
    if (sha === undefined || !present.has(sha)) continue;
    const manifest = manifests.get(sha) ?? null;
    const key = manifest === null ? `sha:${sha}` : contentKey(manifest);
    if (!versions.has(key)) {
      if (versions.size >= keep) continue;
      versions.add(key);
    }
    kept.add(sha);
  }
  if (current.kind === "release") kept.add(current.sha);
  return existing.filter((sha) => !kept.has(sha));
}

/** `assets/`の中のファイル。`name`は`assets/`からの相対名(`a.js`)。 */
export type AssetFile = { readonly name: string; readonly mtimeMs: number };

const ASSETS_PREFIX = "assets/";

/**
 * 残す版のマニフェストから、参照している共有の`assets/`のファイル名を集める。
 * 名前は`assets/`からの相対名(マニフェストの`assets/a.js`は`a.js`)にし、`AssetFile.name`と揃える。
 * 読めなかったマニフェスト(`null`)が1つでもあれば、参照が分からないので`null`を返す。
 */
export function referencedAssetNames(
  manifests: readonly (ConsoleManifest | null)[],
): ReadonlySet<string> | null {
  const names = new Set<string>();
  for (const manifest of manifests) {
    if (manifest === null) return null;
    for (const path of manifest.files.keys()) {
      if (path.startsWith(ASSETS_PREFIX)) {
        names.add(path.slice(ASSETS_PREFIX.length));
      }
    }
  }
  return names;
}

/**
 * 消す共有の`assets/`のファイルを返す。残す版から参照されず、最後の更新から`maxAgeMs`を超えたもの。
 * `referenced`と`AssetFile.name`はどちらも`assets/`からの相対名で、`referencedAssetNames`で作る。
 * 参照が分からない(`null`。残す版のマニフェストを読めなかった)ときは何も消さない。
 */
export function selectAssetsToDelete(
  assets: readonly AssetFile[],
  referenced: ReadonlySet<string> | null,
  nowMs: number,
  maxAgeMs: number,
): string[] {
  if (referenced === null) return [];
  return assets
    .filter((asset) => !referenced.has(asset.name))
    .filter((asset) => nowMs - asset.mtimeMs > maxAgeMs)
    .map((asset) => asset.name);
}

/** 2つのマニフェストの`files`(パスとsha256の対応)が過不足なく同じかを返す。 */
function sameFiles(a: ConsoleManifest, b: ConsoleManifest): boolean {
  if (a.files.size !== b.files.size) return false;
  for (const [path, hash] of a.files) {
    if (b.files.get(path) !== hash) return false;
  }
  return true;
}

/**
 * 戻す先を返す。履歴の中で今の版より前に付け替えた版のうち、まだ残っていて、
 * 今の版と`files`の中身が違う最も新しいもの。
 * Consoleに触れないマージでも版ができるので、中身が同じ版へ戻しても何も変わらない。
 * どちらかのマニフェストを読めない版は、比べられないので飛ばさない。
 * 戻した後にもう一度呼ぶと、さらに1つ前を返す。
 * これは戻す操作とpinを外す操作が履歴に足さないことを前提にする。今の版は履歴の最後の出現で
 * 位置を決めるので、戻した版を足すと、次に戻すときにその前に付け替えた新しい版を返してしまう。
 * 今の版が履歴に無い(付け替えた後、履歴に書く前に止まった)ときは、履歴の中でまだ残っている
 * 最も新しい版を返す。
 */
export function selectRollbackTarget(
  history: readonly string[],
  currentSha: string | null,
  existing: ReadonlySet<string>,
  manifests: ReadonlyMap<string, ConsoleManifest | null>,
): string | null {
  if (currentSha === null) return null;
  const currentManifest = manifests.get(currentSha) ?? null;
  const found = history.lastIndexOf(currentSha);
  const position = found === -1 ? history.length : found;
  for (let index = position - 1; index >= 0; index--) {
    const sha = history[index];
    if (sha === undefined || sha === currentSha || !existing.has(sha)) continue;
    const candidate = manifests.get(sha) ?? null;
    if (
      currentManifest !== null &&
      candidate !== null &&
      sameFiles(currentManifest, candidate)
    ) {
      continue;
    }
    return sha;
  }
  return null;
}

/**
 * `sha`の版と、それと`files`の中身が同じ版を返す(`sha`自身を含む)。
 * 戻すときに、問題の版と同じassetsを指す版も一緒に外すために使う。
 * `sha`のマニフェストを読めないときは、比べられないので`sha`だけを返す。
 */
export function selectIdenticalReleases(
  sha: string,
  manifests: ReadonlyMap<string, ConsoleManifest | null>,
): string[] {
  const target = manifests.get(sha) ?? null;
  const identical = [sha];
  if (target === null) return identical;
  for (const [other, manifest] of manifests) {
    if (other !== sha && manifest !== null && sameFiles(target, manifest)) {
      identical.push(other);
    }
  }
  return identical;
}

/** pinの`rolled_back_from`(戻した元の版のsha)を読む。shaの形でない要素は捨て、無ければ空にする。 */
export function parsePinRevoked(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return parseHistory(value.rolled_back_from);
}

/** pinの`rolled_back_content`(戻した元の版の中身のsha256)を読む。形の違う要素は捨て、無ければ空にする。 */
export function parsePinContent(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.rolled_back_content)) return [];
  return value.rolled_back_content.filter(
    (item): item is string => typeof item === "string" && SHA256_HEX.test(item),
  );
}

/**
 * 戻した元の版の記録(`revoked.json`)。`pin`を外しても残り、戻した元の版が
 * 後から戻し先に選ばれたり、保持の対象として残ったりしないようにする。
 */
export type RevokedState = {
  /** 戻した元の版のsha。消えた版は整理で外す。 */
  readonly shas: readonly string[];
  /** 戻した元の版の中身(`files`のsha256)。同じ中身の新しい版を見分けるために残す。 */
  readonly digests: readonly string[];
};

/** 記録する中身のsha256の上限。超えたら古いものから捨てる。 */
export const REVOKED_DIGEST_LIMIT = 100;

/** `revoked.json`の中身が記録の形(`shas`と`digests`の配列を持つオブジェクト)かを返す。 */
export function isRevokedStateFile(value: unknown): boolean {
  return (
    isRecord(value) && Array.isArray(value.shas) && Array.isArray(value.digests)
  );
}

/** `revoked.json`の中身を読む。形の違う要素は捨て、読めなければ空にする。 */
export function parseRevokedState(value: unknown): RevokedState {
  if (!isRecord(value)) return { shas: [], digests: [] };
  const digests = Array.isArray(value.digests)
    ? value.digests.filter(
        (item): item is string =>
          typeof item === "string" && SHA256_HEX.test(item),
      )
    : [];
  return {
    shas: [...new Set(parseHistory(value.shas))],
    digests: [...new Set(digests)],
  };
}

/** 記録に`shas`と`digests`を足す。すでにあるものは重ねず、中身は`REVOKED_DIGEST_LIMIT`個まで残す。 */
export function mergeRevokedState(
  state: RevokedState,
  shas: readonly string[],
  digests: readonly string[],
): RevokedState {
  return {
    shas: [...new Set([...state.shas, ...shas])],
    digests: [...new Set([...state.digests, ...digests])].slice(
      -REVOKED_DIGEST_LIMIT,
    ),
  };
}

/**
 * 記録から`digest`を外す。同じ中身の版(`shas`)も外す。
 * 戻した元の版と同じ中身が、`main`の最新の成功した実行として意図して配信し直されたときに使う。
 */
export function clearRevokedContent(
  state: RevokedState,
  digest: string,
  shas: readonly string[],
): RevokedState {
  return {
    shas: state.shas.filter((sha) => !shas.includes(sha)),
    digests: state.digests.filter((item) => item !== digest),
  };
}

/** 版が戻した元の版かを返す。shaが記録にあるか、マニフェストを読めて中身が記録にあるとき。 */
export function isRevokedRelease(
  sha: string,
  manifest: ConsoleManifest | null,
  state: RevokedState,
): boolean {
  if (state.shas.includes(sha)) return true;
  return manifest !== null && state.digests.includes(contentDigest(manifest));
}

/** 残っている版のうち、戻した元の版を返す。 */
export function selectRevokedReleases(
  existing: readonly string[],
  manifests: ReadonlyMap<string, ConsoleManifest | null>,
  state: RevokedState,
): string[] {
  return existing.filter((sha) =>
    isRevokedRelease(sha, manifests.get(sha) ?? null, state),
  );
}

/** 消えた版のshaを記録から外す。中身は、同じ中身の新しい版を見分けるために残す。 */
export function pruneRevokedState(
  state: RevokedState,
  existing: readonly string[],
): RevokedState {
  const present = new Set(existing);
  return {
    shas: state.shas.filter((sha) => present.has(sha)),
    digests: state.digests,
  };
}

/**
 * 戻した元の版だけが参照する共有の`assets/`のファイル名(`assets/`からの相対名)を返す。
 * 戻した元の版のマニフェストを読めないときは、何を消すか分からないので`null`を返す。
 * 呼び出し側は、`null`のときに版を消さず、次の回に確かめ直す。
 * 残る版のうち読めないマニフェストは無視し、読めた残る版が参照するassetsだけを残す。
 * 配信中の版のマニフェストを読めないときは、呼び出し側が先に止める。
 */
export function selectRevokedAssets(
  revoked: readonly (ConsoleManifest | null)[],
  remaining: readonly (ConsoleManifest | null)[],
): string[] | null {
  const candidates = referencedAssetNames(revoked);
  if (candidates === null) return null;
  const stillUsed = referencedAssetNames(
    remaining.filter((manifest) => manifest !== null),
  );
  if (stillUsed === null) return null;
  return [...candidates].filter((name) => !stillUsed.has(name));
}

/** `unpin`のオプション。 */
export type UnpinOptions = {
  /** 最新の実行が戻した元の版かを確かめない。 */
  readonly force: boolean;
  /** 戻した元の版を消せていなくても、pinを外す。 */
  readonly ignoreCleanup: boolean;
};

/** `unpin`の引数を読む。知らない引数があれば`null`。 */
export function parseUnpinFlags(args: readonly string[]): UnpinOptions | null {
  let force = false;
  let ignoreCleanup = false;
  for (const arg of args) {
    if (arg === "--force") force = true;
    else if (arg === "--ignore-cleanup") ignoreCleanup = true;
    else return null;
  }
  return { force, ignoreCleanup };
}

/** `unpin`の引数のうち、知らないものを返す。 */
export function findUnknownUnpinFlags(args: readonly string[]): string[] {
  return args.filter((arg) => arg !== "--force" && arg !== "--ignore-cleanup");
}

/** pinの中身を読めたか(JSONのオブジェクトか)を返す。読めない`pin`は、何を戻したか分からない。 */
export function isReadablePin(value: unknown): boolean {
  return isRecord(value);
}

/** `unpin`がpinを外さなかった理由。 */
export type UnpinRefusal =
  | { readonly ok: false; readonly reason: "pin_unreadable" }
  | {
      readonly ok: false;
      readonly reason: "latest_run_is_revoked";
      readonly sha: string;
    }
  | {
      readonly ok: false;
      readonly reason: "latest_run_has_revoked_content";
      readonly sha: string;
    }
  | { readonly ok: false; readonly reason: "lookup_failed" }
  | {
      readonly ok: false;
      readonly reason: "content_undeterminable";
      readonly sha: string;
    }
  | { readonly ok: false; readonly reason: "cleanup_incomplete" };

export type UnpinResult = { readonly ok: true } | UnpinRefusal;

const FORCE_HINT =
  'To unpin without these checks, run "mise run console:unpin -- --force".';
const IGNORE_CLEANUP_HINT =
  'To unpin without removing it, run "mise run console:unpin -- --ignore-cleanup".';

/** pinを外さなかったときに、運用者に見せる文面(理由と次の操作)を返す。 */
export function describeUnpinRefusal(refusal: UnpinRefusal): string {
  switch (refusal.reason) {
    case "pin_unreadable":
      return `Not unpinned: the pin file could not be parsed, so it is unknown which release you rolled back from and whether unpinning would serve it again. Check the latest CI result first. ${FORCE_HINT}`;
    case "latest_run_is_revoked":
      return `Not unpinned: the latest successful run on main (${refusal.sha}) is the release you rolled back from, so unpinning would serve it again. Merge a fix into main, wait until its CI succeeds, and run this again. ${FORCE_HINT}`;
    case "latest_run_has_revoked_content":
      return `Not unpinned: the latest successful run on main (${refusal.sha}) has the same files as the release you rolled back from, so unpinning would serve the same Console again. Merge a fix that changes console/ into main, wait until its CI succeeds, and run this again. ${FORCE_HINT}`;
    case "lookup_failed":
      return `Not unpinned: could not look up the latest successful run on main, so it is unknown whether unpinning would serve the release you rolled back from again. Check the GitHub settings and the network, then run this again. ${FORCE_HINT}`;
    case "content_undeterminable":
      return `Not unpinned: could not read the files of the latest successful run on main (${refusal.sha}), so it is unknown whether they match the release you rolled back from. Check the GitHub settings and the network, then run this again. ${FORCE_HINT}`;
    case "cleanup_incomplete":
      return `Not unpinned: the release you rolled back from could not be removed yet. See the revoked_cleanup_* events in this command's output or in the console_fetcher logs, fix the cause, and run this again. ${IGNORE_CLEANUP_HINT}`;
  }
}

/**
 * `rollback`の後に、運用者に伝えることがあれば文面を返す。無ければ`null`。
 * 戻した元の版の削除が終わっていないこと(`cleanup`)と、その版の中身をpinに記録できなかったこと
 * (`contentRecorded`)を伝える。
 */
export function describeRollbackNotice(
  cleanup: "done" | "pending",
  contentRecorded: boolean,
): string | null {
  const notices: string[] = [];
  if (cleanup === "pending") {
    notices.push(
      "The rollback succeeded, but removing the release rolled back from did not finish. console_fetcher resumes the removal within 5 minutes.",
    );
  }
  if (!contentRecorded) {
    notices.push(
      "The files of the release rolled back from could not be recorded in the pin, so unpinning cannot tell whether a later commit has the same files. Check the latest build before unpinning.",
    );
  }
  return notices.length === 0 ? null : notices.join("\n");
}

/**
 * ロックファイルの中身(`{"acquired_at": ISO文字列}`)から、持ち主が止まって残った古いロックかを返す。
 * 中身を読めないロックも古いとみなす(作ってから書くまでの間に止まったもの)。
 * `staleMs`を超えて未来の時刻のロックも古いとみなす(時計のずれや壊れた日付で取り込みが止まり続けないため)。
 */
export function isLockStale(
  content: unknown,
  nowMs: number,
  staleMs: number,
): boolean {
  if (!isRecord(content) || typeof content.acquired_at !== "string")
    return true;
  const acquiredAt = Date.parse(content.acquired_at);
  return (
    Number.isNaN(acquiredAt) ||
    nowMs - acquiredAt > staleMs ||
    acquiredAt - nowMs > staleMs
  );
}
