// dependabotのセキュリティ更新PR1件について、GitHubとnpm registryから事実を集め、
// ゲート(`evaluateGate`)の入力を組み立てる。
// ここは事実を集めるだけで、作者、fork、種別などの判定はゲートが行う。
// 更新の対象と種別は、PRのタイトル、本文、ブランチ名に頼らず、ロックファイルの差分から導く。
// 取得はすべて、最初に読んだheadとbaseのshaに固定する。最後にPRとbaseのshaを読み直し、
// 集めている間にheadやbaseが動いていれば、古い事実で判定しないよう待ちにする。
// baseは期待したブランチに限り、比較にはブランチ名でなくshaを使う。

import type { UnverifiedInputName } from "./dependabot_prompt.ts";
import {
  type RegistryFacts,
  RegistryHttpError,
  RegistryResponseError,
  RegistryUnavailableError,
} from "./dependabot_registry.ts";
import {
  ALLOWED_PATHS,
  classifyUpdate,
  detail,
  entryIdentity,
  type GateInput,
  lockfilePackages,
  REQUIRED_CHECKS,
  type UpdateKind,
} from "./dependabot_support.ts";
import {
  type CommitComparison,
  GitHubHttpError,
  GitHubPaginationLimitError,
  GitHubRateLimitError,
  GitHubResponseError,
  type PullRequest,
} from "./github.ts";
import { isCommitSha } from "./main_ci_support.ts";

// ---- 更新の対象の導出 ----

export type DeriveResult =
  | {
      kind: "ok";
      /** 更新の対象のパッケージ名と、更新後の版。 */
      target: { name: string; to: string };
      /** 更新前の版。 */
      from: string;
      update: UpdateKind;
    }
  | { kind: "needs_human"; reason: string };

// 更新の重さの順。同じパッケージの複数のコピーが違う幅で上がるときは、最も重いものを採る。
const UPDATE_WEIGHT: Record<UpdateKind, number> = {
  patch: 0,
  minor: 1,
  major: 2,
  unknown: 3,
};

const LOCKFILE_PATHS: readonly string[] = ALLOWED_PATHS.filter((path) =>
  path.endsWith("bun.lock"),
);

const MAX_LISTED_NAMES = 5;

function humanStop(reason: string): DeriveResult {
  return { kind: "needs_human", reason };
}

type LockfileChange = {
  path: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** 変わったエントリの持ち主のパッケージ名ごとの、最も重い更新の種別。 */
  kinds: Map<string, UpdateKind>;
};

function heavier(a: UpdateKind, b: UpdateKind): UpdateKind {
  return UPDATE_WEIGHT[a] >= UPDATE_WEIGHT[b] ? a : b;
}

/** ロックファイル1つの前後を比べ、変わったエントリの持ち主の名前と更新の種別を求める。 */
function readLockfileChange(file: {
  path: string;
  before: string | null;
  after: string | null;
}): LockfileChange | string {
  if (file.before === null || file.after === null) {
    return `lockfile was added or deleted: ${detail(file.path)}`;
  }
  const before = lockfilePackages(file.before);
  const after = lockfilePackages(file.after);
  if (before === null || after === null) {
    return `lockfile could not be read: ${detail(file.path)}`;
  }
  const kinds = new Map<string, UpdateKind>();
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const hadBefore = Object.hasOwn(before, key);
    const hasAfter = Object.hasOwn(after, key);
    if (
      hadBefore &&
      hasAfter &&
      JSON.stringify(before[key]) === JSON.stringify(after[key])
    ) {
      continue;
    }
    const was = hadBefore ? entryIdentity(before[key]) : null;
    const now = hasAfter ? entryIdentity(after[key]) : null;
    if ((hadBefore && was === null) || (hasAfter && now === null)) {
      return `a package entry is malformed: ${detail(key)}`;
    }
    // 追加と削除は版の上がり方を決められないので、unknownにする。
    const kind =
      was !== null && now !== null
        ? classifyUpdate(was.version, now.version)
        : "unknown";
    for (const identity of [was, now]) {
      if (identity === null) continue;
      const known = kinds.get(identity.name);
      kinds.set(
        identity.name,
        known === undefined ? kind : heavier(known, kind),
      );
    }
  }
  return { path: file.path, before, after, kinds };
}

/** ロックファイルのトップレベルのエントリ`packages[name]`の版。無いか、読めないときは`null`。 */
function topLevelVersion(
  packages: Record<string, unknown>,
  name: string,
): string | null {
  if (!Object.hasOwn(packages, name)) return null;
  const identity = entryIdentity(packages[name]);
  return identity !== null && identity.name === name ? identity.version : null;
}

/**
 * PRで変わったマニフェストとロックファイルから、更新の対象を導く。
 * ロックファイルの前後でエントリが変わったパッケージの名前を集め、ちょうど1つのときだけ対象にする。
 * 0個、2個以上(グループ更新)、版を決められないとき、ロックファイルを読めないときは止める。
 * `to`と`from`は、トップレベルのエントリ(`packages[name]`)の更新後と更新前の版で、
 * ロックファイルが複数あるときは、すべてで一致することを求める。
 * `update`は、変わった全エントリの種別のうち最も重いものである。
 * マニフェストの中身は読まない。マニフェストの検査はゲートが行う。
 */
export function deriveTarget(files: GateInput["files"]): DeriveResult {
  const changes: LockfileChange[] = [];
  for (const file of files) {
    if (!LOCKFILE_PATHS.includes(file.path)) continue;
    const change = readLockfileChange(file);
    if (typeof change === "string") return humanStop(change);
    changes.push(change);
  }

  const names = new Set<string>();
  for (const change of changes) {
    for (const name of change.kinds.keys()) names.add(name);
  }
  if (names.size === 0) return humanStop("no package changed in the lockfiles");
  const [name] = names;
  if (names.size > 1 || name === undefined) {
    const listed = [...names].slice(0, MAX_LISTED_NAMES).join(", ");
    return humanStop(`more than one package changed: ${detail(listed)}`);
  }

  let versions: { from: string; to: string } | null = null;
  let update: UpdateKind = "patch";
  for (const change of changes) {
    const kind = change.kinds.get(name);
    if (kind === undefined) continue;
    const from = topLevelVersion(change.before, name);
    const to = topLevelVersion(change.after, name);
    if (from === null || to === null) {
      return humanStop(
        `the target has no top-level entry in ${detail(change.path)}: ${detail(name)}`,
      );
    }
    // 入れ子のコピーだけが変わると、トップレベルの版が更新後の版を表さない。
    if (from === to) {
      return humanStop(
        `the top-level entry of the target did not change: ${detail(name)}`,
      );
    }
    if (versions !== null && (versions.from !== from || versions.to !== to)) {
      return humanStop("the lockfiles resolve the target differently");
    }
    versions = { from, to };
    update = heavier(update, kind);
  }
  if (versions === null)
    return humanStop("no package changed in the lockfiles");
  return {
    kind: "ok",
    target: { name, to: versions.to },
    from: versions.from,
    update,
  };
}

// ---- 事実の収集 ----

/**
 * 外部への呼び出し。GitHubの関数はクライアントとownerを束ねた形で受け取る。
 * `getRegistryFacts`は取得先の`fetch`を束ねた形で受け取る。
 */
export type CollectDeps = {
  getPr: (owner: string, repo: string, number: number) => Promise<PullRequest>;
  getBranchSha: (
    owner: string,
    repo: string,
    branch: string,
  ) => Promise<string>;
  compareCommits: (
    owner: string,
    repo: string,
    baseSha: string,
    headSha: string,
  ) => Promise<CommitComparison>;
  getFileAtRef: (
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ) => Promise<string | null>;
  listPrChecks: (
    owner: string,
    repo: string,
    headSha: string,
  ) => Promise<GateInput["checks"]>;
  getRegistryFacts: (
    name: string,
    from: string,
    to: string,
  ) => Promise<RegistryFacts>;
  now: () => number;
  minPublishedDays: number;
  /** PRのbaseに期待するブランチ名。これと違うPRは人に回す。 */
  expectedBaseRef: string;
};

export type CollectResult =
  | {
      kind: "ready";
      input: GateInput;
      /** 事実を固定したheadのsha。 */
      headSha: string;
      /** PRのbaseのブランチ名。`expectedBaseRef`と一致する。 */
      baseRef: string;
      /** 比較に使ったbaseのブランチの先頭のsha。 */
      baseSha: string;
      /** `files[].before`を読んだmerge-baseのsha。 */
      mergeBaseSha: string;
      /** 更新前の版。影響調査に渡す。 */
      from: string;
      /** registryから読んだ、更新の前後の公開者などの要約。影響調査に渡す。 */
      registryMetadata: string;
      /** 取得できなかった入力。registryの要約に欠けた項目があれば"registry metadata"を含む。 */
      unverifiedInputs: UnverifiedInputName[];
    }
  | { kind: "wait"; reason: string }
  | { kind: "needs_human"; reason: string }
  /** PRが閉じたかmergeされた。人に通知する対象ではない。 */
  | { kind: "closed"; reason: string };

/** PRがopenでないときの`closed`の理由。 */
export const NOT_OPEN = "pull request is not open";

const BASE_NOT_EXPECTED = "base branch is not the expected one";

/** 収集を打ち切って、待つか人に回すかを返すための内部の例外。 */
class Stop extends Error {
  readonly kind: "wait" | "needs_human";
  readonly reason: string;

  constructor(kind: "wait" | "needs_human", reason: string) {
    super(reason);
    this.name = "Stop";
    this.kind = kind;
    this.reason = reason;
  }
}

/**
 * 既知の外部の失敗を、待つか人に回すかに分ける。
 * 一時的な失敗(レート制限、5xx、応答の無い通信断、registryの一時的な失敗)は待つ。
 * 応答を読めない、応答が欠けている、registryが拒んだ失敗は、待っても直らないので人に回す。
 * 理由には、応答の本文などの外部由来の文字列を載せない。
 * 知らない失敗は`null`にして、呼び出し側が再度投げる。
 */
function toStop(error: unknown): Stop | null {
  if (error instanceof Stop) return error;
  if (error instanceof GitHubRateLimitError) {
    return new Stop("wait", "GitHub rate limit was hit");
  }
  if (
    error instanceof GitHubHttpError &&
    (error.status === 0 || error.status >= 500)
  ) {
    return new Stop("wait", "GitHub is temporarily unavailable");
  }
  if (error instanceof RegistryUnavailableError) {
    return new Stop("wait", "npm registry is temporarily unavailable");
  }
  if (error instanceof RegistryHttpError) {
    return new Stop("needs_human", "npm registry rejected the request");
  }
  if (
    error instanceof GitHubResponseError ||
    error instanceof GitHubPaginationLimitError
  ) {
    return new Stop("needs_human", "GitHub response could not be used");
  }
  return null;
}

/** 4xxは、待っても読めないファイルとして人に回す。 */
async function readFile(
  deps: CollectDeps,
  pr: { owner: string; repo: string },
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    return await deps.getFileAtRef(pr.owner, pr.repo, path, ref);
  } catch (error) {
    if (
      error instanceof GitHubHttpError &&
      error.status >= 400 &&
      error.status < 500
    ) {
      throw new Stop("needs_human", "a file could not be read from GitHub");
    }
    throw error;
  }
}

/**
 * registryの事実を読む。`dependabot_registry`は、名前の不正、大きすぎる応答、JSONでない応答、
 * packumentの形の不正を`RegistryResponseError`で投げるので、これを人に回す。
 * それ以外の`Error`(`TypeError`など)は不具合なので、そのまま投げる。
 */
async function readRegistryFacts(
  deps: CollectDeps,
  name: string,
  from: string,
  to: string,
): Promise<RegistryFacts> {
  try {
    return await deps.getRegistryFacts(name, from, to);
  } catch (error) {
    if (error instanceof RegistryResponseError) {
      throw new Stop("needs_human", "npm registry response could not be used");
    }
    throw error;
  }
}

type Gathered = {
  kind: "gathered";
  input: Omit<GateInput, "mergeable">;
  mergeBaseSha: string;
  from: string;
  registryMetadata: string;
  unverifiedInputs: UnverifiedInputName[];
};

/** パスの重複を除く。最初に現れた順を保つ。 */
function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

/**
 * headとbaseのshaに固定して事実を集める。人に回す失敗は`needs_human`の結果として返し、
 * 待つ失敗と知らない失敗は投げる。人に回す前にも、PRを読み直して動いていないかを確かめるため。
 */
async function gather(
  deps: CollectDeps,
  pr: { owner: string; repo: string; number: number },
  first: PullRequest,
  baseSha: string,
): Promise<Gathered | { kind: "needs_human"; reason: string }> {
  const headSha = first.headSha;
  try {
    const comparison = await deps.compareCommits(
      pr.owner,
      pr.repo,
      baseSha,
      headSha,
    );
    const { mergeBaseSha } = comparison;
    const changedPaths = unique(
      comparison.files.flatMap((file) =>
        file.previousFilename === null
          ? [file.filename]
          : [file.filename, file.previousFilename],
      ),
    );

    // 許可されたパスだけ内容を読む。許可の外のパスは、パスだけを渡してゲートに止めさせる。
    const files: GateInput["files"] = [];
    for (const path of ALLOWED_PATHS) {
      if (!changedPaths.includes(path)) continue;
      files.push({
        path,
        before: await readFile(deps, pr, path, mergeBaseSha),
        after: await readFile(deps, pr, path, headSha),
      });
    }

    const derived = deriveTarget(files);
    if (derived.kind === "needs_human") return derived;
    const { target, from, update } = derived;

    const facts = await readRegistryFacts(deps, target.name, from, target.to);
    const checks = await deps.listPrChecks(pr.owner, pr.repo, headSha);

    return {
      kind: "gathered",
      mergeBaseSha,
      from,
      registryMetadata: facts.registryMetadata,
      unverifiedInputs: facts.missing.length === 0 ? [] : ["registry metadata"],
      input: {
        authorLogin: first.authorLogin,
        authorType: first.authorType ?? "",
        headRepoFullName: first.headRepoFullName ?? "",
        baseRepoFullName: first.baseRepoFullName,
        commits: comparison.commits,
        checks,
        requiredChecks: REQUIRED_CHECKS,
        update,
        changedPaths,
        files,
        target,
        publishedAtIso: facts.publishedAtIso,
        nowMs: deps.now(),
        minPublishedDays: deps.minPublishedDays,
        installScripts: facts.installScripts,
        registry:
          facts.integrity === null
            ? null
            : {
                name: facts.name,
                version: facts.version,
                integrity: facts.integrity,
              },
      },
    };
  } catch (error) {
    const stop = toStop(error);
    if (stop === null || stop.kind === "wait") throw error;
    return { kind: "needs_human", reason: stop.reason };
  }
}

/** 集めている間に、事実の前提が動いたか。 */
function moved(first: PullRequest, last: PullRequest): boolean {
  return (
    first.headSha !== last.headSha ||
    first.baseRef !== last.baseRef ||
    first.baseRepoFullName !== last.baseRepoFullName ||
    first.headRepoFullName !== last.headRepoFullName ||
    first.authorLogin !== last.authorLogin ||
    first.authorType !== last.authorType
  );
}

async function collect(
  deps: CollectDeps,
  pr: { owner: string; repo: string; number: number },
): Promise<CollectResult> {
  const first = await deps.getPr(pr.owner, pr.repo, pr.number);
  if (first.state !== "open" || first.merged) {
    return { kind: "closed", reason: NOT_OPEN };
  }
  if (!isCommitSha(first.headSha)) {
    return { kind: "needs_human", reason: "head sha is not a full sha" };
  }
  if (first.baseRef !== deps.expectedBaseRef) {
    return { kind: "needs_human", reason: BASE_NOT_EXPECTED };
  }
  const baseSha = await deps.getBranchSha(pr.owner, pr.repo, first.baseRef);

  const gathered = await gather(deps, pr, first, baseSha);

  const last = await deps.getPr(pr.owner, pr.repo, pr.number);
  if (last.state !== "open" || last.merged) {
    return { kind: "closed", reason: NOT_OPEN };
  }
  // `moved`はbaseのブランチ名の変化も見る。通ったあとの`last.baseRef`は`first.baseRef`と同じである。
  if (moved(first, last)) {
    return {
      kind: "wait",
      reason: "pull request changed while its facts were collected",
    };
  }
  const lastBaseSha = await deps.getBranchSha(pr.owner, pr.repo, last.baseRef);
  if (lastBaseSha !== baseSha) {
    return {
      kind: "wait",
      reason: "base branch moved while the facts were collected",
    };
  }
  if (gathered.kind === "needs_human") return gathered;
  return {
    kind: "ready",
    // 計算が遅れることのある値なので、最後に読み直した値を使う。真偽に丸めない。
    input: { ...gathered.input, mergeable: last.mergeable },
    headSha: first.headSha,
    baseRef: first.baseRef,
    baseSha,
    mergeBaseSha: gathered.mergeBaseSha,
    from: gathered.from,
    registryMetadata: gathered.registryMetadata,
    unverifiedInputs: gathered.unverifiedInputs,
  };
}

/**
 * PR1件について、GitHubとnpm registryから事実を集め、ゲートの入力を作る。
 * 手順は、PRを読んでheadのshaとbaseのブランチのshaを固定し、そのshaで比較、ファイル、
 * チェックを読み、registryの事実を読み、PRとbaseのshaを読み直して動いていないことを確かめる。
 * PRが閉じているかmergeされている場合は、何も集めずに`closed`にする。
 * baseが期待したブランチでないときは、`needs_human`にする。
 * 集めている間にheadかbaseのshaが動いたときは、`wait`にして次の周回でやり直す。
 * 一時的な失敗は`wait`、応答を読めない失敗とregistryが拒んだ失敗は`needs_human`にし、
 * 知らない失敗は握りつぶさずに投げる。
 */
export async function collectGateInput(
  deps: CollectDeps,
  pr: { owner: string; repo: string; number: number },
): Promise<CollectResult> {
  try {
    return await collect(deps, pr);
  } catch (error) {
    const stop = toStop(error);
    if (stop === null) throw error;
    return { kind: stop.kind, reason: stop.reason };
  }
}
