// dependabotのセキュリティ更新PRを自動でmergeしてよいかを決める判定部。
// I/Oを持たない純粋関数だけを置く。GitHubの呼び出しとフロー本体は呼び出し側が担い、
// ここは受け取った事実から結論と理由を返す。
// 判定は安全側に倒す。解釈できない入力は、通すのではなく止める。

import { escapeReasonSeparator } from "./log.ts";
import { matchesForbiddenPath } from "./protected_paths.ts";

// 値の出典は、.github/workflows/ci.ymlのジョブIDと、docs/security.mdの必須チェックの節である。
/** mainのrulesetが必須にするチェック名。 */
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

const MAX_DETAIL_CHARS = 80;

/**
 * 理由の文字列に埋め込む、ファイルやGitHubが書ける文字列を整える。
 * 長い値で理由が膨らまないよう切り詰め、`"; "`で理由が別の項目に割れないようにする。
 */
function detail(text: string): string {
  const shortened =
    text.length > MAX_DETAIL_CHARS
      ? `${text.slice(0, MAX_DETAIL_CHARS)}...`
      : text;
  return escapeReasonSeparator(shortened);
}

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
 * 0.xは最初の0でない桁が互換性の境界になるので、0.xのminorの変更と、0.0.xのpatchの変更は
 * 破壊的変更を含みうるものとして`major`にする。
 */
export function classifyUpdate(from: string, to: string): UpdateKind {
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (a === null || b === null || !isGreater(b, a)) return "unknown";
  if (a.major !== b.major) return "major";
  if (a.minor !== b.minor) return a.major === 0 ? "major" : "minor";
  if (a.major === 0 && a.minor === 0) return "major";
  return "patch";
}

// ---- 公開からの日数 ----

// 日付と時刻に、末尾のZか±hh:mmの時差が付いた形だけを受け付ける。
// 時差の無い日時は実行環境のタイムゾーンで解釈され、日数の判定がずれるため。
const ISO_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

function parsePublishedAt(publishedAtIso: string): number | null {
  if (!ISO_WITH_ZONE.test(publishedAtIso)) return null;
  const ms = Date.parse(publishedAtIso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * 公開から`minDays`日以上たっているかを返す。ちょうど`minDays`日たった時点で真になる。
 * 時差つきのISO 8601でない日時、公開が未来のとき、`minDays`が有限でないか負のときは偽にする。
 */
export function isPublishedLongEnough(
  publishedAtIso: string,
  nowMs: number,
  minDays: number,
): boolean {
  if (!Number.isFinite(minDays) || minDays < 0) return false;
  const publishedMs = parsePublishedAt(publishedAtIso);
  if (publishedMs === null) return false;
  return nowMs - publishedMs >= minDays * DAY_MS;
}

// ---- JSONの解析 ----

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

/**
 * 構文として正しいJSONの中で、同じオブジェクトに重複したキーがあれば、そのキーを返す。
 * `JSON.parse`は重複を黙って後ろの値にするので、見えない上書きを検出するために使う。
 */
function findDuplicateKey(text: string): string | null {
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") stack.push(new Set());
    else if (ch === "[") stack.push(null);
    else if (ch === "}" || ch === "]") stack.pop();
    else if (ch === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const keys = stack[stack.length - 1];
      let next = j + 1;
      while (next < text.length && /\s/.test(text[next] ?? "")) next++;
      if (keys instanceof Set && text[next] === ":") {
        const key: unknown = JSON.parse(text.slice(i, j + 1));
        if (typeof key === "string") {
          if (keys.has(key)) return key;
          keys.add(key);
        }
      }
      i = j;
    }
  }
  return null;
}

type JsonObjectResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: string };

/** JSONのオブジェクトを解析する。構文の誤りと重複したキーは`ok: false`にする。 */
function parseJsonObject(
  text: string,
  allowTrailingCommas: boolean,
): JsonObjectResult {
  const source = allowTrailingCommas ? stripTrailingCommas(text) : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { ok: false, reason: "file could not be parsed" };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "file is not an object" };
  const duplicate = findDuplicateKey(source);
  if (duplicate !== null) {
    return {
      ok: false,
      reason: `file has a duplicate key: ${detail(duplicate)}`,
    };
  }
  return { ok: true, value: parsed };
}

// ---- ロックファイルの差分 ----

export type LockfileVerdict = { ok: true } | { ok: false; reason: string };

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

/** 依存の表から対象の指定を除き、残りが変わっていないかを比べられる形にする。 */
function withoutTarget(
  container: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...container };
  for (const field of DEPENDENCY_FIELDS) {
    const deps = copy[field];
    if (isRecord(deps)) {
      const { [name]: _removed, ...rest } = deps;
      copy[field] = rest;
    }
  }
  return copy;
}

/**
 * 依存の指定が、版そのもの、または先頭に^か~が付いた版かを返す。
 * URLやタグなど、別の取得元を指せる指定を通さないため。
 */
function specifierPointsAt(specifier: unknown, version: string): boolean {
  return (
    typeof specifier === "string" && specifier.replace(/^[\^~]/, "") === version
  );
}

function dependencyFieldProblem(
  before: unknown,
  after: unknown,
  target: { name: string; to: string },
): string | null {
  if (!isRecord(before) || !isRecord(after)) {
    return JSON.stringify(before) === JSON.stringify(after)
      ? null
      : "dependency list changed";
  }
  const hadTarget = Object.hasOwn(before, target.name);
  if (hadTarget !== Object.hasOwn(after, target.name)) {
    return "target was added or removed";
  }
  const rest = (deps: Record<string, unknown>) =>
    JSON.stringify(
      Object.entries(deps).filter(([name]) => name !== target.name),
    );
  if (rest(before) !== rest(after)) return "dependencies changed";
  if (hadTarget) {
    const beforeSpec = before[target.name];
    const afterSpec = after[target.name];
    if (beforeSpec !== afterSpec && !specifierPointsAt(afterSpec, target.to)) {
      return `target specifier does not point at ${detail(target.to)}`;
    }
  }
  return null;
}

/**
 * ロックファイルのworkspacesを比べ、対象の依存の指定以外が変わっていれば理由を返す。
 * 対象の指定は、前と同じ欄にあり、変えるなら新しい版を指していることを要る。
 * 作業場所のキーは`Object.keys`で比べる。`__proto__`は`JSON.parse`が持ち主のキーとして作るので、
 * 値を組み立て直さずに比べて、足された作業場所を見逃さない。
 */
function workspacesProblem(
  before: unknown,
  after: unknown,
  target: { name: string; to: string },
): string | null {
  if (!isRecord(before) || !isRecord(after)) {
    return JSON.stringify(before) === JSON.stringify(after)
      ? null
      : "workspaces changed";
  }
  if (
    JSON.stringify(Object.keys(before)) !== JSON.stringify(Object.keys(after))
  ) {
    return "workspaces were added or removed";
  }
  for (const key of Object.keys(before)) {
    const b = before[key];
    const a = after[key];
    if (!isRecord(b) || !isRecord(a)) {
      if (JSON.stringify(b) !== JSON.stringify(a)) return "workspaces changed";
      continue;
    }
    const others = (workspace: Record<string, unknown>) =>
      JSON.stringify(
        Object.entries(workspace).filter(
          ([field]) => !DEPENDENCY_FIELDS.includes(field),
        ),
      );
    if (others(b) !== others(a)) return "workspace settings changed";
    for (const field of DEPENDENCY_FIELDS) {
      const problem = dependencyFieldProblem(b[field], a[field], target);
      if (problem !== null) return `${field}: ${problem}`;
    }
  }
  return null;
}

function checkTargetEntry(
  before: unknown,
  after: unknown,
  target: { name: string; to: string },
): string | null {
  const b = entryIdentity(before);
  const a = entryIdentity(after);
  if (b === null || a === null) return "a package entry is malformed";
  if (a.name !== target.name || b.name !== target.name) {
    return "a package other than the target changed";
  }
  if (a.version !== target.to) {
    return `target resolved to ${detail(a.version)}, expected ${detail(target.to)}`;
  }
  if (b.version === a.version) {
    return "target changed without a version change";
  }
  // 入れ子のコピーなど、対象が複数の版で入っていても、各コピーの更新幅を確かめる。
  const kind = classifyUpdate(b.version, a.version);
  if (kind !== "patch" && kind !== "minor") {
    return `target jumped from ${detail(b.version)} to ${detail(a.version)} (${kind})`;
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
 * 対象以外のパッケージの増減と変更、レジストリの変更、版が変わらない整合性の変更、
 * 対象のpatchとminor以外の更新は、依存の差し替えに使えるので`ok: false`にする。
 * `before`と`after`は、bun.lockのテキストである。解釈できないとき、
 * 重複したキーがあるときは`ok: false`にする。
 */
export function checkLockfileDiff(
  before: string,
  after: string,
  target: { name: string; to: string },
): LockfileVerdict {
  const a = parseJsonObject(before, true);
  const b = parseJsonObject(after, true);
  if (!a.ok) return { ok: false, reason: `before: ${a.reason}` };
  if (!b.ok) return { ok: false, reason: `after: ${b.reason}` };
  const aPackages = a.value.packages;
  const bPackages = b.value.packages;
  if (!isRecord(aPackages) || !isRecord(bPackages)) {
    return { ok: false, reason: "lockfile has no packages table" };
  }

  const otherKeys = (lock: Record<string, unknown>) =>
    JSON.stringify(
      Object.entries(lock).filter(
        ([key]) => key !== "packages" && key !== "workspaces",
      ),
    );
  if (otherKeys(a.value) !== otherKeys(b.value)) {
    return { ok: false, reason: "lockfile settings changed" };
  }
  const workspaces = workspacesProblem(
    a.value.workspaces,
    b.value.workspaces,
    target,
  );
  if (workspaces !== null) return { ok: false, reason: workspaces };

  const keys = new Set([...Object.keys(aPackages), ...Object.keys(bPackages)]);
  let targetUpdated = false;
  for (const key of keys) {
    if (!Object.hasOwn(aPackages, key)) {
      return { ok: false, reason: `package added: ${detail(key)}` };
    }
    if (!Object.hasOwn(bPackages, key)) {
      return { ok: false, reason: `package removed: ${detail(key)}` };
    }
    const beforeEntry = aPackages[key];
    const afterEntry = bPackages[key];
    if (JSON.stringify(beforeEntry) === JSON.stringify(afterEntry)) continue;
    const problem = checkTargetEntry(beforeEntry, afterEntry, target);
    if (problem !== null) {
      return { ok: false, reason: `${detail(key)}: ${problem}` };
    }
    targetUpdated = true;
  }
  if (!targetUpdated) {
    return { ok: false, reason: "target was not updated in the lockfile" };
  }
  return { ok: true };
}

// ---- package.jsonの差分 ----

export type PackageJsonVerdict = { ok: true } | { ok: false; reason: string };

/**
 * dependabotがpackage.jsonに加えた変更が、対象パッケージの版の指定だけかを調べる。
 * dependencies、devDependencies、optionalDependencies、peerDependenciesのうち、
 * 対象の指定の変更だけを許す。scripts、trustedDependencies、overrides、resolutions、
 * patchedDependencies、binを含む、ほかのキーと依存の増減と変更は`ok: false`にする。
 * 解釈できないとき、重複したキーがあるときも`ok: false`にする。
 */
export function checkPackageJsonDiff(
  before: string,
  after: string,
  target: { name: string; to: string },
): PackageJsonVerdict {
  const a = parseJsonObject(before, false);
  const b = parseJsonObject(after, false);
  if (!a.ok) return { ok: false, reason: `before: ${a.reason}` };
  if (!b.ok) return { ok: false, reason: `after: ${b.reason}` };

  if (
    JSON.stringify(withoutTarget(a.value, target.name)) !==
    JSON.stringify(withoutTarget(b.value, target.name))
  ) {
    return {
      ok: false,
      reason: "package.json changed outside the target dependency",
    };
  }

  let targetUpdated = false;
  for (const field of DEPENDENCY_FIELDS) {
    const beforeDeps = a.value[field];
    const afterDeps = b.value[field];
    if (!isRecord(beforeDeps) || !isRecord(afterDeps)) continue;
    const hadBefore = Object.hasOwn(beforeDeps, target.name);
    const hasAfter = Object.hasOwn(afterDeps, target.name);
    if (hadBefore !== hasAfter) {
      return {
        ok: false,
        reason: `target was added or removed in ${field}`,
      };
    }
    if (!hadBefore) continue;
    const beforeSpec = beforeDeps[target.name];
    const afterSpec = afterDeps[target.name];
    if (beforeSpec === afterSpec) continue;
    if (!specifierPointsAt(afterSpec, target.to)) {
      return {
        ok: false,
        reason: `target specifier in ${field} does not point at ${detail(target.to)}`,
      };
    }
    targetUpdated = true;
  }
  if (!targetUpdated) {
    return { ok: false, reason: "target was not updated in package.json" };
  }
  return { ok: true };
}

// ---- ゲート ----

export type GateInput = {
  authorLogin: string;
  authorType: string;
  headRepoFullName: string;
  baseRepoFullName: string;
  /**
   * PRのすべてのcommit。
   * 作者とコミッターの両方が`dependabot[bot]`で、署名が検証済みであることを要る。
   * 作者を取得できなかったものは`null`にする。
   */
  commits: {
    authorLogin: string | null;
    committerLogin: string | null;
    verified: boolean;
  }[];
  checks: { name: string; conclusion: string | null }[];
  requiredChecks: readonly string[];
  update: UpdateKind;
  /** PRで変更されたすべてのパス。`files`に現れないパスがあれば止める。 */
  changedPaths: readonly string[];
  /**
   * 変更されたファイルの更新前と更新後の内容。
   * 無いファイル(追加と削除)は`null`にする。
   */
  files: { path: string; before: string | null; after: string | null }[];
  /** 更新の対象のパッケージと、更新後の版。 */
  target: { name: string; to: string };
  mergeable: boolean;
  publishedAtIso: string;
  nowMs: number;
  minPublishedDays: number;
  /**
   * 更新先パッケージのscriptsのうち、preinstall、install、postinstall、prepareだけを抜き出したもの。
   * 取得に失敗したときは`null`にする。
   * binding.gypによる暗黙のinstallは、呼び出し側(後続のタスク)が扱う。
   * ルートのpackage.jsonのscriptsは`checkPackageJsonDiff`が止めるので、
   * ここは更新先パッケージ自身のスクリプトを指す。
   */
  installScripts: {
    before: Record<string, string> | null;
    after: Record<string, string> | null;
  };
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

/**
 * 変更されたパスのうち、保護パスか許可外のものの理由を返す。無ければ`null`。
 * 許可リストだけで足りるが、保護パスは理由の文言を分けるために先に判定する。
 */
function pathProblem(paths: readonly string[]): string | null {
  if (paths.length === 0) return "no changed paths";
  for (const path of paths) {
    if (matchesForbiddenPath(path)) {
      return `protected path changed: ${detail(path)}`;
    }
    if (!ALLOWED_PATHS.includes(path)) {
      return `path outside the allowed set changed: ${detail(path)}`;
    }
  }
  return null;
}

// マニフェストと、同じディレクトリのロックファイルの対応。
const MANIFEST_LOCKFILES: readonly { manifest: string; lockfile: string }[] = [
  { manifest: "package.json", lockfile: "bun.lock" },
  { manifest: "console/package.json", lockfile: "console/bun.lock" },
];

/**
 * 変更されたファイルの中身を検査し、止める理由を返す。無ければ`null`。
 * 変更されたパスのすべてが`files`に現れ、追加と削除でなく、検査を通ることを要る。
 * マニフェストが変わったときは、同じディレクトリのロックファイルも変わっていることを要る。
 * ロックファイルだけが変わるとき(推移的な依存だけの更新)は、ロックファイルの検査だけで通す。
 */
function fileProblem(input: GateInput): string | null {
  const { changedPaths, files, target } = input;
  for (const path of changedPaths) {
    const matches = files.filter((file) => file.path === path);
    if (matches.length === 0) {
      return `changed path was not inspected: ${detail(path)}`;
    }
    if (matches.length > 1) {
      return `changed path appears more than once: ${detail(path)}`;
    }
  }
  for (const { manifest, lockfile } of MANIFEST_LOCKFILES) {
    if (changedPaths.includes(manifest) && !changedPaths.includes(lockfile)) {
      return `${manifest} changed without ${lockfile}`;
    }
  }
  for (const path of changedPaths) {
    const file = files.find((candidate) => candidate.path === path);
    if (file === undefined) continue;
    if (file.before === null || file.after === null) {
      return `file was added or deleted: ${detail(path)}`;
    }
    const isManifest = MANIFEST_LOCKFILES.some(
      (pair) => pair.manifest === path,
    );
    const verdict = isManifest
      ? checkPackageJsonDiff(file.before, file.after, target)
      : checkLockfileDiff(file.before, file.after, target);
    if (!verdict.ok) {
      return `${detail(path)} diff rejected: ${escapeReasonSeparator(verdict.reason)}`;
    }
  }
  return null;
}

const INSTALL_SCRIPT_NAMES: readonly string[] = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
];

/** 更新先パッケージが、新しくinstall時のスクリプトを持つようになったときの理由を返す。無ければ`null`。 */
function installScriptProblem(input: GateInput): string | null {
  const { before, after } = input.installScripts;
  if (before === null || after === null) {
    return "install scripts of the target could not be fetched";
  }
  for (const name of INSTALL_SCRIPT_NAMES) {
    if (!Object.hasOwn(after, name)) continue;
    if (!Object.hasOwn(before, name) || before[name] !== after[name]) {
      return `the target adds or changes the ${name} script`;
    }
  }
  return null;
}

function commitProblem(input: GateInput): string | null {
  if (input.commits.length === 0) return "pull request has no commits";
  for (const commit of input.commits) {
    if (
      commit.authorLogin !== DEPENDABOT_LOGIN ||
      commit.committerLogin !== DEPENDABOT_LOGIN
    ) {
      return `a commit was not made by ${DEPENDABOT_LOGIN}: ${detail(String(commit.authorLogin))} / ${detail(String(commit.committerLogin))}`;
    }
    if (!commit.verified) return "a commit is not verified";
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
      pending ??= `required check has not appeared: ${detail(name)}`;
      continue;
    }
    for (const run of runs) {
      if (run.conclusion === null) {
        pending ??= `required check is not completed: ${detail(name)}`;
      } else if (!PASSING_CONCLUSIONS.includes(run.conclusion)) {
        return stop(
          `required check ${detail(name)} ended with ${detail(run.conclusion)}`,
        );
      }
    }
  }
  return pending === null ? null : wait(pending);
}

/**
 * 自動でmergeしてよいかを判定する。
 * fork、作者、種別、パスなどの止める条件を先に見て、待つ条件(チェックの未完了、公開日数の不足)を後に見る。
 * 止める条件が1つでもあれば、待つ条件より優先して`needs_human`を返す。
 * 理由に埋め込むファイルやGitHub由来の文字列は、切り詰めて区切りを除いてある。
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
      `author is not ${DEPENDABOT_LOGIN}: ${detail(input.authorLogin)} (${detail(input.authorType)})`,
    );
  }
  const commits = commitProblem(input);
  if (commits !== null) return stop(commits);
  if (input.update !== "patch" && input.update !== "minor") {
    return stop(`update kind is ${input.update}`);
  }
  const pathReason = pathProblem(input.changedPaths);
  if (pathReason !== null) return stop(pathReason);
  if (!input.mergeable) return stop("pull request is not mergeable");
  const files = fileProblem(input);
  if (files !== null) return stop(files);
  const scripts = installScriptProblem(input);
  if (scripts !== null) return stop(scripts);
  if (parsePublishedAt(input.publishedAtIso) === null) {
    return stop("publish date is invalid");
  }
  if (!Number.isFinite(input.minPublishedDays) || input.minPublishedDays < 0) {
    return stop("minimum published days is invalid");
  }
  if (input.requiredChecks.length === 0) {
    return stop("no required check is configured");
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

const MAX_EVIDENCE_CHARS = 4000;
const MAX_LIST_ITEMS = 20;
const MAX_ITEM_CHARS = 500;

function isBoundedStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_LIST_ITEMS &&
    value.every(
      (item) => typeof item === "string" && item.length <= MAX_ITEM_CHARS,
    )
  );
}

/**
 * Claudeの構造化出力を影響の評価として検証する。
 * 形が違うとき、根拠が空のとき、長さと件数の上限を超えるときは例外にして、
 * 未検証の値や際限なく長い値を後続の判断とコメントに渡さない。
 * 未知のキーは捨てる。
 */
export function parseImpactAssessment(raw: unknown): ImpactAssessment {
  if (!isRecord(raw)) throw new Error("impact assessment is not an object");
  const { impact, evidence, supplyChainConcerns, unverified } = raw;
  if (impact !== "none" && impact !== "impact") {
    throw new Error("impact assessment has an invalid impact");
  }
  if (
    typeof evidence !== "string" ||
    evidence.trim().length === 0 ||
    evidence.length > MAX_EVIDENCE_CHARS
  ) {
    throw new Error("impact assessment has an invalid evidence");
  }
  if (!isBoundedStringArray(supplyChainConcerns)) {
    throw new Error("impact assessment has an invalid supplyChainConcerns");
  }
  if (!isBoundedStringArray(unverified)) {
    throw new Error("impact assessment has an invalid unverified");
  }
  return { impact, evidence, supplyChainConcerns, unverified };
}

export type ImpactOutcome = {
  outcome: "merge" | "fix" | "needs_human";
  reason: string;
};

/**
 * 影響の評価から次の動作を決める。
 * サプライチェーンの懸念か未検証の項目が1つでもあれば、人に渡す。
 * 懸念も未検証も無いときは、影響が無ければmerge、あれば修正に進む。
 */
export function decideImpactOutcome(a: ImpactAssessment): ImpactOutcome {
  if (a.supplyChainConcerns.length > 0) {
    return {
      outcome: "needs_human",
      reason: `${a.supplyChainConcerns.length} supply chain concern(s) were reported`,
    };
  }
  if (a.unverified.length > 0) {
    return {
      outcome: "needs_human",
      reason: `${a.unverified.length} unverified item(s) remain`,
    };
  }
  return a.impact === "none"
    ? { outcome: "merge", reason: "no impact and nothing is left unverified" }
    : { outcome: "fix", reason: "the update affects this repository" };
}
