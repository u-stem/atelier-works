// dependabotのセキュリティ更新PRを自動でmergeしてよいかを決める判定部。
// I/Oを持たない純粋関数だけを置く。GitHubの呼び出しとフロー本体は呼び出し側が担い、
// ここは受け取った事実から結論と理由を返す。
// 判定は安全側に倒す。解釈できない入力は、通すのではなく止める。

import { matchesForbiddenPath } from "./protected_paths.ts";

/**
 * mainのrulesetが必須にするチェック名。
 * `.github/workflows/ci.yml`のジョブ名と、docs/security.mdの一覧に合わせる。
 */
export const REQUIRED_CHECKS: readonly string[] = [
  "scope",
  "check",
  "test-db",
  "metadata",
  "console",
  "caddyfile",
  "console-fetcher-image",
];

/**
 * 更新を許すファイル。依存の版を変えるのは、マニフェストとロックファイルだけである。
 * リポジトリ直下とconsole/配下の2か所に限り、それ以外の階層は許さない。
 */
const ALLOWED_PATHS: readonly string[] = [
  "package.json",
  "bun.lock",
  "console/package.json",
  "console/bun.lock",
];

const DAY_MS = 24 * 60 * 60 * 1000;

const DEPENDABOT_LOGIN = "dependabot[bot]";
const DEPENDABOT_TYPE = "Bot";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---- 更新の種別 ----

export type UpdateKind = "patch" | "minor" | "major" | "unknown";

type Version = { major: number; minor: number; patch: number };

const PLAIN_VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

function parseVersion(value: string): Version | null {
  const match = PLAIN_VERSION.exec(value);
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function isGreater(to: Version, from: Version): boolean {
  if (to.major !== from.major) return to.major > from.major;
  if (to.minor !== from.minor) return to.minor > from.minor;
  return to.patch > from.patch;
}

/**
 * 版の上がり方を分類する。
 * プレリリース、dist-tag、版が上がらない変更は、判断できないので`unknown`にする。
 * 0.xのminorの変更は、semverの慣習で破壊的変更を含みうるので`major`として扱う。
 */
export function classifyUpdate(from: string, to: string): UpdateKind {
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (a === null || b === null || !isGreater(b, a)) return "unknown";
  if (a.major !== b.major) return "major";
  if (a.minor !== b.minor) return a.major === 0 ? "major" : "minor";
  return "patch";
}

// ---- 公開からの日数 ----

/**
 * 公開から`minDays`日以上たっているかを返す。ちょうど`minDays`日たった時点で真になる。
 * 日時を解釈できないときと、公開が未来のときは偽にする。
 */
export function isPublishedLongEnough(
  publishedAtIso: string,
  nowMs: number,
  minDays: number,
): boolean {
  const publishedMs = Date.parse(publishedAtIso);
  if (Number.isNaN(publishedMs)) return false;
  return nowMs - publishedMs >= minDays * DAY_MS;
}

// ---- ロックファイルの差分 ----

export type LockfileVerdict = { ok: true } | { ok: false; reason: string };

/**
 * bun.lockの末尾のカンマを取り除く。
 * bun.lockは、末尾のカンマを許すJSONの形式で書かれる。
 * 実行環境のBunに組み込みのパーサーがあるかに頼らないよう、文字列の外のカンマだけを見て自前で処理する。
 */
function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] ?? "")) j++;
      const next = text[j];
      if (next === "}" || next === "]") continue;
    }
    out += ch;
  }
  return out;
}

function parseLockfile(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stripTrailingCommas(text));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function splitPackageId(id: string): { name: string; version: string } | null {
  const at = id.indexOf("@", id.startsWith("@") ? 1 : 0);
  if (at <= 0) return null;
  return { name: id.slice(0, at), version: id.slice(at + 1) };
}

function entryIdentity(
  entry: unknown,
): { name: string; version: string } | null {
  if (!Array.isArray(entry)) return null;
  const id: unknown = entry[0];
  return typeof id === "string" ? splitPackageId(id) : null;
}

const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

const DEPENDENCY_FIELDS: readonly string[] = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

/** workspacesから対象の依存の指定を除き、残りが変わっていないかを比べられる形にする。 */
function workspacesWithoutTarget(workspaces: unknown, name: string): unknown {
  if (!isRecord(workspaces)) return workspaces;
  const result: Record<string, unknown> = {};
  for (const [key, workspace] of Object.entries(workspaces)) {
    if (!isRecord(workspace)) {
      result[key] = workspace;
      continue;
    }
    const copy: Record<string, unknown> = { ...workspace };
    for (const field of DEPENDENCY_FIELDS) {
      const deps = copy[field];
      if (isRecord(deps)) {
        const { [name]: _removed, ...rest } = deps;
        copy[field] = rest;
      }
    }
    result[key] = copy;
  }
  return result;
}

function checkTargetEntry(
  before: unknown,
  after: unknown,
  target: { name: string; to: string },
): string | null {
  const b = entryIdentity(before);
  const a = entryIdentity(after);
  if (b === null || a === null || a.name !== target.name) {
    return "a package other than the target changed";
  }
  if (b.name !== target.name) return "a package other than the target changed";
  if (a.version !== target.to) {
    return `target resolved to ${a.version}, expected ${target.to}`;
  }
  if (b.version === a.version) {
    return "target changed without a version change";
  }
  if (!Array.isArray(after) || after[1] !== "") {
    return "target is resolved from a non-default registry";
  }
  const integrity: unknown = after[3];
  if (typeof integrity !== "string" || !SHA512_INTEGRITY.test(integrity)) {
    return "target has no sha512 integrity";
  }
  return null;
}

/**
 * dependabotがロックファイルに加えた変更が、対象の版の更新だけかを調べる。
 * 対象以外のパッケージの増減と変更、レジストリの変更、版が変わらない整合性の変更は、
 * 依存の差し替えに使えるので`ok: false`にする。
 * `before`と`after`は、bun.lockのテキストである。解釈できなければ`ok: false`にする。
 */
export function checkLockfileDiff(
  before: string,
  after: string,
  target: { name: string; to: string },
): LockfileVerdict {
  const a = parseLockfile(before);
  const b = parseLockfile(after);
  if (a === null || b === null) {
    return { ok: false, reason: "lockfile could not be parsed" };
  }
  const aPackages = a.packages;
  const bPackages = b.packages;
  if (!isRecord(aPackages) || !isRecord(bPackages)) {
    return { ok: false, reason: "lockfile has no packages table" };
  }

  const otherKeys = (lock: Record<string, unknown>) =>
    JSON.stringify(
      Object.entries(lock).filter(
        ([key]) => key !== "packages" && key !== "workspaces",
      ),
    );
  if (otherKeys(a) !== otherKeys(b)) {
    return { ok: false, reason: "lockfile settings changed" };
  }
  if (
    JSON.stringify(workspacesWithoutTarget(a.workspaces, target.name)) !==
    JSON.stringify(workspacesWithoutTarget(b.workspaces, target.name))
  ) {
    return { ok: false, reason: "workspace dependencies changed" };
  }

  const keys = new Set([...Object.keys(aPackages), ...Object.keys(bPackages)]);
  let targetUpdated = false;
  for (const key of keys) {
    if (!(key in aPackages)) {
      return { ok: false, reason: `package added: ${key}` };
    }
    if (!(key in bPackages)) {
      return { ok: false, reason: `package removed: ${key}` };
    }
    const beforeEntry = aPackages[key];
    const afterEntry = bPackages[key];
    if (JSON.stringify(beforeEntry) === JSON.stringify(afterEntry)) continue;
    const problem = checkTargetEntry(beforeEntry, afterEntry, target);
    if (problem !== null) return { ok: false, reason: `${key}: ${problem}` };
    targetUpdated = true;
  }
  if (!targetUpdated) {
    return { ok: false, reason: "target was not updated in the lockfile" };
  }
  return { ok: true };
}

// ---- ゲート ----

export type GateInput = {
  authorLogin: string;
  authorType: string;
  headRepoFullName: string;
  baseRepoFullName: string;
  checks: { name: string; conclusion: string | null }[];
  requiredChecks: readonly string[];
  update: UpdateKind;
  changedPaths: readonly string[];
  mergeable: boolean;
  publishedAtIso: string;
  nowMs: number;
  minPublishedDays: number;
  lockfile: LockfileVerdict;
  hasNewLifecycleScript: boolean;
};

export type GateResult =
  | { ok: true }
  | { ok: false; kind: "wait" | "needs_human"; reason: string };

function stop(reason: string): GateResult {
  return { ok: false, kind: "needs_human", reason };
}

function wait(reason: string): GateResult {
  return { ok: false, kind: "wait", reason };
}

/** 変更されたパスのうち、保護パスか許可外のものの理由を返す。無ければ`null`。 */
function pathProblem(paths: readonly string[]): string | null {
  if (paths.length === 0) return "no changed paths";
  for (const path of paths) {
    if (matchesForbiddenPath(path)) return `protected path changed: ${path}`;
    if (!ALLOWED_PATHS.includes(path)) {
      return `path outside the allowed set changed: ${path}`;
    }
  }
  return null;
}

const PASSING_CONCLUSIONS: readonly string[] = ["success", "skipped"];

/**
 * 必須チェックの状態を見る。失敗は止め、未完了と未出現は待つ。
 * 同じ名前のチェックが複数あるときは、すべてが合格するまで通さない。
 */
function checkProblem(input: GateInput): GateResult | null {
  let pending: string | null = null;
  for (const name of input.requiredChecks) {
    const runs = input.checks.filter((check) => check.name === name);
    if (runs.length === 0) {
      pending ??= `required check has not appeared: ${name}`;
      continue;
    }
    for (const run of runs) {
      if (run.conclusion === null) {
        pending ??= `required check is not completed: ${name}`;
      } else if (!PASSING_CONCLUSIONS.includes(run.conclusion)) {
        return stop(`required check ${name} ended with ${run.conclusion}`);
      }
    }
  }
  return pending === null ? null : wait(pending);
}

/**
 * 自動でmergeしてよいかを判定する。
 * fork、作者、種別、パスなどの止める条件を先に見て、待つ条件(チェックの未完了、公開日数の不足)を後に見る。
 * 止める条件が1つでもあれば、待つ条件より優先して`needs_human`を返す。
 */
export function evaluateGate(input: GateInput): GateResult {
  if (input.headRepoFullName !== input.baseRepoFullName) {
    return stop("pull request comes from a fork");
  }
  if (
    input.authorLogin !== DEPENDABOT_LOGIN ||
    input.authorType !== DEPENDABOT_TYPE
  ) {
    return stop(
      `author is not ${DEPENDABOT_LOGIN}: ${input.authorLogin} (${input.authorType})`,
    );
  }
  if (input.update !== "patch" && input.update !== "minor") {
    return stop(`update kind is ${input.update}`);
  }
  const pathReason = pathProblem(input.changedPaths);
  if (pathReason !== null) return stop(pathReason);
  if (!input.mergeable) return stop("pull request is not mergeable");
  if (!input.lockfile.ok) {
    return stop(`lockfile diff rejected: ${input.lockfile.reason}`);
  }
  if (input.hasNewLifecycleScript) {
    return stop("a new lifecycle script was added");
  }
  if (Number.isNaN(Date.parse(input.publishedAtIso))) {
    return stop("publish date is invalid");
  }

  const checks = checkProblem(input);
  if (checks !== null && !checks.ok && checks.kind === "needs_human") {
    return checks;
  }
  if (
    !isPublishedLongEnough(
      input.publishedAtIso,
      input.nowMs,
      input.minPublishedDays,
    )
  ) {
    return wait(
      `version was published less than ${input.minPublishedDays} days ago`,
    );
  }
  return checks ?? { ok: true };
}

// ---- 影響の評価 ----

export type ImpactAssessment = {
  impact: "none" | "impact";
  evidence: string;
  supplyChainConcerns: string[];
  unverified: string[];
};

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/**
 * Claudeの構造化出力を影響の評価として検証する。
 * 形が違うときは例外にして、未検証の値を後続の判断に渡さない。
 * 未知のキーは捨てる。
 */
export function parseImpactAssessment(raw: unknown): ImpactAssessment {
  if (!isRecord(raw)) throw new Error("impact assessment is not an object");
  const { impact, evidence, supplyChainConcerns, unverified } = raw;
  if (impact !== "none" && impact !== "impact") {
    throw new Error("impact assessment has an invalid impact");
  }
  if (typeof evidence !== "string") {
    throw new Error("impact assessment has an invalid evidence");
  }
  if (!isStringArray(supplyChainConcerns)) {
    throw new Error("impact assessment has an invalid supplyChainConcerns");
  }
  if (!isStringArray(unverified)) {
    throw new Error("impact assessment has an invalid unverified");
  }
  return { impact, evidence, supplyChainConcerns, unverified };
}
