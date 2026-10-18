// dependabotのセキュリティ更新PRを自動でmergeしてよいかを決める判定部。
// I/Oを持たない純粋関数だけを置く。GitHubの呼び出しとフロー本体は呼び出し側が担い、
// ここは受け取った事実から結論と理由を返す。
// 判定は安全側に倒す。解釈できない入力は、通すのではなく止める。

import { escapeReasonSeparator } from "./log.ts";
import { matchesForbiddenPath } from "./protected_paths.ts";

// 値の出典は、.github/workflows/ci.ymlのジョブIDと、docs/security.mdの必須チェックの節である。
/**
 * mainのrulesetが必須にするチェック名。
 * 判定の基準なので、実行時にも書き換えられないよう凍結する。
 */
export const REQUIRED_CHECKS: readonly string[] = Object.freeze([
  "scope",
  "check",
  "test-db",
  "metadata",
  "console",
  "caddyfile",
  "console-fetcher-image",
]);

/**
 * 更新を許すファイル。依存の版を変えるのは、マニフェストとロックファイルだけである。
 * リポジトリ直下とconsole/配下の2か所に限り、それ以外の階層は許さない。
 * 判定の基準なので、実行時にも書き換えられないよう凍結する。
 */
export const ALLOWED_PATHS: readonly string[] = Object.freeze([
  "package.json",
  "bun.lock",
  "console/package.json",
  "console/bun.lock",
]);

const DAY_MS = 24 * 60 * 60 * 1000;

const DEPENDABOT_LOGIN = "dependabot[bot]";
const DEPENDABOT_TYPE = "Bot";

const MAX_DETAIL_CHARS = 80;

/**
 * 理由の文字列に埋め込む、ファイルやGitHubが書ける文字列を整える。
 * 長い値で理由が膨らまないよう切り詰め、`"; "`で理由が別の項目に割れないようにする。
 */
export function detail(text: string): string {
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

/** 時差つきのISO 8601の日時をミリ秒にする。形が違うか、日時として読めないときは`null`にする。 */
export function parsePublishedAt(publishedAtIso: string): number | null {
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

/** packagesの表の1件から、パッケージ名と版を読む。形が違うときは`null`にする。 */
export function entryIdentity(
  entry: unknown,
): { name: string; version: string } | null {
  if (!Array.isArray(entry)) return null;
  const id: unknown = entry[0];
  return typeof id === "string" ? splitPackageId(id) : null;
}

/**
 * sha512の整合性の形。sha512は64バイトで、base64では86文字と`==`になる。
 * ロックファイルの値とレジストリの値のどちらも、この形でなければ使わない。
 */
export const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;

/** 依存を宣言するpackage.jsonのキー。 */
export const DEPENDENCY_FIELDS: readonly string[] = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

/** 更新される1つのパッケージの名前と、更新後の版。 */
type Member = { name: string; to: string };

/**
 * 依存の表から更新対象の指定を除き、残りが変わっていないかを比べられる形にする。
 * `names`には、対象と、同じPRで同時に更新される対象(coTargets)の名前を渡す。
 */
function withoutMembers(
  container: Record<string, unknown>,
  names: ReadonlySet<string>,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...container };
  for (const field of DEPENDENCY_FIELDS) {
    const deps = copy[field];
    if (isRecord(deps)) {
      copy[field] = Object.fromEntries(
        Object.entries(deps).filter(([name]) => !names.has(name)),
      );
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
  members: readonly Member[],
): string | null {
  if (!isRecord(before) || !isRecord(after)) {
    return JSON.stringify(before) === JSON.stringify(after)
      ? null
      : "dependency list changed";
  }
  for (const member of members) {
    if (
      Object.hasOwn(before, member.name) !== Object.hasOwn(after, member.name)
    ) {
      return "target was added or removed";
    }
  }
  const names = new Set(members.map((member) => member.name));
  const rest = (deps: Record<string, unknown>) =>
    JSON.stringify(Object.entries(deps).filter(([name]) => !names.has(name)));
  if (rest(before) !== rest(after)) return "dependencies changed";
  for (const member of members) {
    if (!Object.hasOwn(before, member.name)) continue;
    const beforeSpec = before[member.name];
    const afterSpec = after[member.name];
    if (beforeSpec !== afterSpec && !specifierPointsAt(afterSpec, member.to)) {
      return `target specifier does not point at ${detail(member.to)}`;
    }
  }
  return null;
}

/**
 * ロックファイルのworkspacesを比べ、更新対象の依存の指定以外が変わっていれば理由を返す。
 * 更新対象は、`target`と、同じPRで同時に更新される`coTargets`である。
 * 各対象の指定は、前と同じ欄にあり、変えるなら、その対象の新しい版を指していることを求める。
 * 作業場所のキーは`Object.keys`で比べる。`__proto__`は`JSON.parse`が持ち主のキーとして作るので、
 * 値を組み立て直さずに比べて、足された作業場所を見逃さない。
 */
function workspacesProblem(
  before: unknown,
  after: unknown,
  members: readonly Member[],
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
      const problem = dependencyFieldProblem(b[field], a[field], members);
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
 * 変わった1つのエントリを検査する。問題があれば理由を、無ければ`null`を返す。
 * `isTarget`は、通ったエントリが`target`のものかを示す。
 * - 前後で名前が違うエントリは、更新前と更新後のどちらの名前が対象に当たっても通さない。
 *   名前の差し替え(aliasなど)で、検査する対象と違うパッケージの取得物を入れられるため。
 * - `target`のエントリは、版、更新幅、レジストリ、整合性まで検査する。
 * - `coTargets`のエントリは、更新後の版がその対象の更新後の版であることだけを求める。
 *   中身の検査は、その対象を`target`にした評価が、同じ差分に対して行う。
 */
function checkChangedEntry(
  before: unknown,
  after: unknown,
  target: Member,
  coTargets: readonly Member[],
): { problem: string | null; isTarget: boolean } {
  const b = entryIdentity(before);
  const a = entryIdentity(after);
  if (b === null || a === null) {
    return { problem: "a package entry is malformed", isTarget: false };
  }
  if (a.name !== b.name) {
    return {
      problem: "a package other than the target changed",
      isTarget: false,
    };
  }
  if (a.name === target.name) {
    return { problem: checkTargetEntry(before, after, target), isTarget: true };
  }
  const coTarget = coTargets.find((candidate) => candidate.name === a.name);
  if (coTarget === undefined) {
    return {
      problem: "a package other than the target changed",
      isTarget: false,
    };
  }
  return {
    problem:
      a.version === coTarget.to
        ? null
        : `a co-target resolved to ${detail(a.version)}, expected ${detail(coTarget.to)}`,
    isTarget: false,
  };
}

/**
 * dependabotがロックファイルに加えた変更が、対象の版の更新だけかを調べる。
 * 対象以外のパッケージの増減と変更、レジストリの変更、版が変わらない整合性の変更、
 * 対象のpatchとminor以外の更新は、依存の差し替えに使えるので`ok: false`にする。
 * `before`と`after`は、bun.lockのテキストである。解釈できないとき、
 * 重複したキーがあるときは`ok: false`にする。
 *
 * `coTargets`は、同じPRで同時に更新される、`target`以外の対象である(グループの更新)。
 * 空なら、`target`だけの更新を検査する。空でないときも、緩めるのは、
 * coTargetのエントリを「更新後の版がその対象の版か」だけで通すことに限る。
 * 緩めても安全なのは、次の前提が崩れないときだけである。前提を変えるときは、この論証を見直す。
 * - 変わったエントリは、すべて「更新前と更新後の名前が同じで、その名前が対象のちょうど1つ」に当たる。
 *   名前が変わるエントリ、キーの追加と削除、エントリ以外のキーの変更は、どの評価でも止める。
 * - coTargetのエントリの中身(版の幅、レジストリ、整合性)は、そのcoTargetを`target`にした評価が、
 *   単独の更新と同じ強さで検査する。呼び出し側は、全対象についてこの関数を呼ぶ。
 * - 変わらないエントリは、キーごとの比較で飛ばすので、baseと同じ内容のままである。
 * - 変更されたすべてのロックファイルで`target`のエントリが変わっていることを、緩めずに求める。
 */
export function checkLockfileDiff(
  before: string,
  after: string,
  target: { name: string; to: string },
  coTargets: readonly { name: string; to: string }[] = [],
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
  const workspaces = workspacesProblem(a.value.workspaces, b.value.workspaces, [
    target,
    ...coTargets,
  ]);
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
    const { problem, isTarget } = checkChangedEntry(
      beforeEntry,
      afterEntry,
      target,
      coTargets,
    );
    if (problem !== null) {
      return { ok: false, reason: `${detail(key)}: ${problem}` };
    }
    if (isTarget) targetUpdated = true;
  }
  if (!targetUpdated) {
    return { ok: false, reason: "target was not updated in the lockfile" };
  }
  return { ok: true };
}

/**
 * bun.lockのpackagesの表を返す。キーは、入れ子のコピーを区別する場所の名前である。
 * 解釈できないとき、重複したキーがあるとき、表が無いときは`null`にする。
 */
export function lockfilePackages(text: string): Record<string, unknown> | null {
  const parsed = parseJsonObject(text, true);
  if (!parsed.ok) return null;
  const packages = parsed.value.packages;
  return isRecord(packages) ? packages : null;
}

/**
 * ロックファイルに入っている、対象の更新後の版のすべてのエントリの整合性を返す。
 * 入れ子のコピーも含める。整合性が文字列でないエントリは、どの値とも一致しない`""`にする。
 * 解釈できないとき、重複したキーがあるとき、packagesの表が無いときは`null`にする。
 * `text`はbun.lockのテキストである。
 */
export function lockfileIntegrity(
  text: string,
  target: { name: string; to: string },
): string[] | null {
  const parsed = parseJsonObject(text, true);
  if (!parsed.ok) return null;
  const packages = parsed.value.packages;
  if (!isRecord(packages)) return null;
  const found: string[] = [];
  for (const entry of Object.values(packages)) {
    const identity = entryIdentity(entry);
    if (
      identity === null ||
      identity.name !== target.name ||
      identity.version !== target.to
    ) {
      continue;
    }
    const integrity: unknown = Array.isArray(entry) ? entry[3] : undefined;
    found.push(typeof integrity === "string" ? integrity : "");
  }
  return found;
}

// ---- package.jsonの差分 ----

export type PackageJsonVerdict = { ok: true } | { ok: false; reason: string };

/**
 * dependabotがpackage.jsonに加えた変更が、対象パッケージの版の指定だけかを調べる。
 * dependencies、devDependencies、optionalDependencies、peerDependenciesのうち、
 * 対象の指定の変更だけを許す。scripts、trustedDependencies、overrides、resolutions、
 * patchedDependencies、binを含む、ほかのキーと依存の増減と変更は`ok: false`にする。
 * 解釈できないとき、重複したキーがあるときも`ok: false`にする。
 *
 * `coTargets`は、同じPRで同時に更新される、`target`以外の対象である(グループの更新)。
 * 空なら、`target`だけの更新を検査する。
 * 更新対象のどの指定も、増減は許さず、変えるなら、その対象の更新後の版を指すことを求める。
 * 緩めるのは「更新されたこと」の条件だけで、`target`か`coTargets`のどれかの指定が変わっていればよい。
 * 推移的な依存はマニフェストに現れないので、`target`の指定が無いか変わらないマニフェストも通す。
 * `target`のエントリがロックファイルで更新されていることは、ロックファイルの検査が、
 * 変更されたすべてのロックファイルで求める。
 */
export function checkPackageJsonDiff(
  before: string,
  after: string,
  target: { name: string; to: string },
  coTargets: readonly { name: string; to: string }[] = [],
): PackageJsonVerdict {
  const a = parseJsonObject(before, false);
  const b = parseJsonObject(after, false);
  if (!a.ok) return { ok: false, reason: `before: ${a.reason}` };
  if (!b.ok) return { ok: false, reason: `after: ${b.reason}` };

  const members = [target, ...coTargets];
  const names = new Set(members.map((member) => member.name));
  if (
    JSON.stringify(withoutMembers(a.value, names)) !==
    JSON.stringify(withoutMembers(b.value, names))
  ) {
    return {
      ok: false,
      reason: "package.json changed outside the target dependency",
    };
  }

  let updated = false;
  for (const field of DEPENDENCY_FIELDS) {
    const beforeDeps = a.value[field];
    const afterDeps = b.value[field];
    if (!isRecord(beforeDeps) || !isRecord(afterDeps)) continue;
    for (const member of members) {
      const hadBefore = Object.hasOwn(beforeDeps, member.name);
      const hasAfter = Object.hasOwn(afterDeps, member.name);
      if (hadBefore !== hasAfter) {
        return {
          ok: false,
          reason: `target was added or removed in ${field}`,
        };
      }
      if (!hadBefore) continue;
      const beforeSpec = beforeDeps[member.name];
      const afterSpec = afterDeps[member.name];
      if (beforeSpec === afterSpec) continue;
      if (!specifierPointsAt(afterSpec, member.to)) {
        return {
          ok: false,
          reason: `target specifier in ${field} does not point at ${detail(member.to)}`,
        };
      }
      updated = true;
    }
  }
  if (!updated) {
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
   * PRのすべてのcommit。判定の規則は`commitProblem`に書いた。
   * 作者かコミッターを取得できなかったものは`null`にする。
   * `parentCount`は親の数で、2以上ならmergeのcommit。
   */
  commits: {
    authorLogin: string | null;
    committerLogin: string | null;
    verified: boolean;
    parentCount: number;
  }[];
  /**
   * `appId`はチェックを作ったAppのid。削除されたAppのチェックでは`null`にする。
   * 必須のチェックは、GitHub Actions(`GITHUB_ACTIONS_APP_ID`)から来たものだけを出揃ったと見なす。
   */
  checks: { name: string; appId: number | null; conclusion: string | null }[];
  requiredChecks: readonly string[];
  update: UpdateKind;
  /** PRで変更されたすべてのパス。`files`に現れないパスがあれば止める。 */
  changedPaths: readonly string[];
  /**
   * 変更されたファイルの更新前と更新後の内容。
   * `before`はPRのbase(merge-base)の内容、`after`はPRのheadの内容にする。
   * `changedPaths`と`files`は、同じbaseとheadの比較から作る。
   * mergeのcommit単位で差分を取ると、持ち込まれた変更を見落とすので、取ってはならない。
   * 無いファイル(追加と削除)は`null`にする。
   */
  files: { path: string; before: string | null; after: string | null }[];
  /** 更新の対象のパッケージと、更新後の版。 */
  target: { name: string; to: string };
  /** GitHubがまだ計算していないときは`null`。 */
  mergeable: boolean | null;
  publishedAtIso: string;
  nowMs: number;
  minPublishedDays: number;
  /**
   * 更新先パッケージのscriptsのうち、preinstall、install、postinstall、prepareだけを抜き出したもの。
   * 取得に失敗したときは`null`にする。
   * `gypfile`が真でinstallが無い版は、`parsePackument`が暗黙のinstallを足して渡す。
   * ルートのpackage.jsonのscriptsは`checkPackageJsonDiff`が止めるので、
   * ここは更新先パッケージ自身のスクリプトを指す。
   */
  installScripts: {
    before: Record<string, string> | null;
    after: Record<string, string> | null;
  };
  /**
   * レジストリが報告する、更新先の版の整合性(`dist.integrity`)。
   * 取得できなかったときと形が不正なときは`null`にする。
   * `name`と`version`は、整合性がどのパッケージのどの版のものかを示し、
   * `target`の名前と更新後の版に一致することを求める。
   * 更新後のロックファイルの対象のエントリが、`integrity`と一致することを求める。
   */
  registry: { name: string; version: string; integrity: string } | null;
};

/**
 * ゲートの結論。止める結論の`notMergeable`は、GitHubがマージできないと判定したことだけが理由のとき真になる。
 * 競合はdependabotがrebaseで直しうるので、取得はこれを待ちとして扱い、フローの準備は人に回す。
 * 理由の文字列で見分けさせないため、種別として返す。
 */
export type GateResult =
  | { ok: true }
  | { ok: false; kind: "wait"; reason: string }
  | { ok: false; kind: "needs_human"; reason: string; notMergeable: boolean };

function stop(reason: string): GateResult {
  return { ok: false, kind: "needs_human", reason, notMergeable: false };
}

function wait(reason: string): GateResult {
  return { ok: false, kind: "wait", reason };
}

/**
 * 内部の評価の入力。`GateInput`に、同じPRで同時に更新される他の対象(`coTargets`)を足す。
 * 外から渡せると、検査を通すべき対象を呼び出し側が選べてしまうので、exportしない。
 * `evaluateGateGroup`が、同じ共通の事実から、全対象についてこの形を組み立てる。
 */
type GateEvaluation = GateInput & { coTargets: readonly Member[] };

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
 * 変更されたパスのすべてが`files`に現れ、追加と削除でなく、検査を通ることを求める。
 * マニフェストが変わったときは、同じディレクトリのロックファイルも変わっていることを求める。
 * ロックファイルだけが変わるとき(推移的な依存だけの更新)は、ロックファイルの検査だけで通す。
 */
function fileProblem(input: GateEvaluation): string | null {
  const { changedPaths, files, target, coTargets } = input;
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
      ? checkPackageJsonDiff(file.before, file.after, target, coTargets)
      : checkLockfileDiff(file.before, file.after, target, coTargets);
    if (!verdict.ok) {
      return `${detail(path)} diff rejected: ${escapeReasonSeparator(verdict.reason)}`;
    }
  }
  return null;
}

/**
 * 更新後のロックファイルの対象のエントリが、レジストリの整合性と一致しないときの理由を返す。無ければ`null`。
 * ロックファイルが差し替えた取得物ではなく、レジストリが公開したものを入れていることを確かめる。
 * 変更されたロックファイルのすべてで、対象のエントリが1件以上あり、すべてが一致することを求める。
 */
function integrityProblem(input: GateInput): string | null {
  const { registry, files, changedPaths, target } = input;
  if (registry === null) return "registry integrity is not available";
  if (!SHA512_INTEGRITY.test(registry.integrity)) {
    return "registry integrity is malformed";
  }
  if (registry.name !== target.name || registry.version !== target.to) {
    return `registry fact is for ${detail(registry.name)}@${detail(registry.version)}, expected ${detail(target.name)}@${detail(target.to)}`;
  }
  for (const { lockfile } of MANIFEST_LOCKFILES) {
    if (!changedPaths.includes(lockfile)) continue;
    const after = files.find((file) => file.path === lockfile)?.after;
    if (after === null || after === undefined) {
      return `lockfile has no content to check: ${detail(lockfile)}`;
    }
    const found = lockfileIntegrity(after, target);
    if (found === null || found.length === 0) {
      return `target entry was not found in ${detail(lockfile)}`;
    }
    if (found.some((value) => !SHA512_INTEGRITY.test(value))) {
      return `a target entry in ${detail(lockfile)} has no valid integrity`;
    }
    const mismatch = found.find((value) => value !== registry.integrity);
    if (mismatch !== undefined) {
      return `integrity in ${detail(lockfile)} differs from the registry: ${detail(mismatch)} / ${detail(registry.integrity)}`;
    }
  }
  return null;
}

/** 更新先パッケージの、install時に実行されるスクリプトの名前。 */
export const INSTALL_SCRIPT_NAMES: readonly string[] = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
];

/** gypfileを持つ版は、installが無ければnpmが実行する暗黙のinstall。 */
export const IMPLICIT_GYP_INSTALL = "node-gyp rebuild";

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

// GitHubが署名するcommitのコミッター。dependabotのcommitと、ブランチの更新のmerge commitに付く。
const WEB_FLOW_LOGIN = "web-flow";

/**
 * PRのcommitを調べ、止める理由を返す。無ければ`null`。
 * 全commitが次のどちらかを満たし、通常のcommitが1件以上あることを求める。
 * - 通常のcommit(親が1つ): 作者が`dependabot[bot]`、コミッターが`dependabot[bot]`か`web-flow`、署名が検証済み。
 * - mergeのcommit(親が2つ以上): コミッターが`web-flow`で、署名が検証済み。ブランチの更新は人やFactoryも行うので、作者は問わない。
 * 親の数が1以上の整数でないcommitは止める。
 * 作者はgitのメタデータで、本人確認にはならない。本体の防御はファイル単位の検査(`files`)で、
 * commitの検査は補助の層である。
 * mergeのcommitが持ち込む差分は、`files`がbaseからheadまでの全体の差分として見る。
 */
function commitProblem(input: GateInput): string | null {
  if (input.commits.length === 0) return "pull request has no commits";
  let ordinary = 0;
  for (const commit of input.commits) {
    const { parentCount } = commit;
    if (!Number.isInteger(parentCount) || parentCount < 1) {
      return `a commit has an invalid parent count: ${parentCount}`;
    }
    if (!commit.verified) return "a commit is not verified";
    if (parentCount >= 2) {
      if (commit.committerLogin !== WEB_FLOW_LOGIN) {
        return `a merge commit was not committed by ${WEB_FLOW_LOGIN}: ${detail(String(commit.committerLogin))}`;
      }
      continue;
    }
    if (
      commit.authorLogin !== DEPENDABOT_LOGIN ||
      (commit.committerLogin !== DEPENDABOT_LOGIN &&
        commit.committerLogin !== WEB_FLOW_LOGIN)
    ) {
      return `a commit was not made by ${DEPENDABOT_LOGIN}: ${detail(String(commit.authorLogin))} / ${detail(String(commit.committerLogin))}`;
    }
    ordinary += 1;
  }
  return ordinary === 0
    ? "pull request has no commit made by dependabot"
    : null;
}

const PASSING_CONCLUSIONS: readonly string[] = ["success", "skipped"];

/** GitHub Actionsが作るチェックの`app.id`。必須チェックの主体を、このAppに限る。 */
export const GITHUB_ACTIONS_APP_ID = 15368;

/**
 * 必須チェックの状態を見る。失敗は止め、未完了と未出現は待つ。
 * 同じ名前のチェックが複数あるときは、すべてが合格するまで通さない。
 * 出揃ったと見なすには、GitHub Actionsから来たチェックが1件以上要る。
 * ほかのAppが同じ名前で成功を報告しても、出揃った証拠にしない。
 * ほかのAppの同名の失敗は止める。成功で失敗を隠さないため。
 */
function checkProblem(input: GateInput): GateResult | null {
  let pending: string | null = null;
  for (const name of input.requiredChecks) {
    const runs = input.checks.filter((check) => check.name === name);
    for (const run of runs) {
      if (run.conclusion === null) {
        pending ??= `required check is not completed: ${detail(name)}`;
      } else if (!PASSING_CONCLUSIONS.includes(run.conclusion)) {
        return stop(
          `required check ${detail(name)} ended with ${detail(run.conclusion)}`,
        );
      }
    }
    if (!runs.some((run) => run.appId === GITHUB_ACTIONS_APP_ID)) {
      pending ??= `required check has not appeared from GitHub Actions: ${detail(name)}`;
    }
  }
  return pending === null ? null : wait(pending);
}

/**
 * 自動でmergeしてよいかを判定する。
 * fork、作者、種別、パスなどの止める条件を先に見て、待つ条件(mergeableの未計算、チェックの未完了、公開日数の不足)を後に見る。
 * 止める条件が1つでもあれば、待つ条件より優先して`needs_human`を返す。
 * 理由に埋め込むファイルやGitHub由来の文字列は、切り詰めて区切りを除いてある。
 */
export function evaluateGate(input: GateInput): GateResult {
  return evaluateWithCoTargets({ ...input, coTargets: [] });
}

function evaluateWithCoTargets(input: GateEvaluation): GateResult {
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
  if (input.mergeable === false) {
    return {
      ok: false,
      kind: "needs_human",
      reason: "pull request is not mergeable",
      notMergeable: true,
    };
  }
  const files = fileProblem(input);
  if (files !== null) return stop(files);
  const integrity = integrityProblem(input);
  if (integrity !== null) return stop(integrity);
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
  if (input.mergeable === null) {
    return wait("mergeability has not been computed yet");
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

/**
 * 1つのPRで同時に更新を認める対象の上限。
 * 影響調査のプロンプトと、registryの取得の大きさが、対象の数で増えるため。
 */
export const MAX_GROUP_TARGETS = 3;

/** 対象に依らない、PRの事実。 */
export type GateCommon = Omit<
  GateInput,
  "target" | "registry" | "installScripts" | "publishedAtIso"
>;

/** 対象ごとに違う事実。`registry`の名前と版は、`target`に一致することが求められる。 */
export type GateTargetFacts = Pick<
  GateInput,
  "target" | "registry" | "installScripts" | "publishedAtIso"
>;

const MAX_LISTED_TARGETS = 5;

type NeedsHuman = Extract<GateResult, { kind: "needs_human" }>;

/**
 * 1つのPRで複数のパッケージが更新されるとき(グループの更新)に、自動でmergeしてよいかを判定する。
 * 対象ごとに`GateInput`を組み立て、他の対象を`coTargets`にして`evaluateGate`と同じ検査を通す。
 * 共通の事実は`common`の1つから作るので、対象ごとに食い違う入力は作れない。
 * 各対象は、その名前を`target`にした評価で、版、更新幅、レジストリ、整合性、
 * インストール時のスクリプトまで、単独の更新と同じ強さで検査される。
 *
 * 対象が空のとき、名前が重複するとき、2つ以上で`allowGroups`が偽のとき、
 * `MAX_GROUP_TARGETS`を超えるときは止める。
 * 1つでも止める結論があれば止め、無ければ1つでも待つ結論があれば待つ。全て通れば通す。
 * 対象が2つ以上のときだけ、理由の先頭に`package <名前>: `を付ける。
 * `notMergeable`は、止める結論のすべてが、マージできないことだけが理由のときに真にする。
 */
export function evaluateGateGroup(
  common: GateCommon,
  targets: readonly GateTargetFacts[],
  allowGroups: boolean,
): GateResult {
  if (targets.length === 0) return stop("no target package");
  const names = targets.map((facts) => facts.target.name);
  if (new Set(names).size !== names.length) {
    return stop(
      `a target package appears more than once: ${detail(names.join(", "))}`,
    );
  }
  if (targets.length >= 2 && !allowGroups) {
    const listed = names.slice(0, MAX_LISTED_TARGETS).join(", ");
    return stop(`more than one package changed: ${detail(listed)}`);
  }
  if (targets.length > MAX_GROUP_TARGETS) {
    return stop(`too many packages changed: ${targets.length}`);
  }

  const stops: { name: string; result: NeedsHuman }[] = [];
  const waits: { name: string; reason: string }[] = [];
  for (const [index, facts] of targets.entries()) {
    const coTargets = targets
      .filter((_, other) => other !== index)
      .map((other) => other.target);
    const result = evaluateWithCoTargets({
      ...common,
      // 対象の値が余分な項目を持っても共通の事実を上書きできないよう、1つずつ取り出す
      target: facts.target,
      registry: facts.registry,
      installScripts: facts.installScripts,
      publishedAtIso: facts.publishedAtIso,
      coTargets,
    });
    if (result.ok) continue;
    const name = facts.target.name;
    if (result.kind === "needs_human") stops.push({ name, result });
    else waits.push({ name, reason: result.reason });
  }

  const label = (name: string, reason: string) =>
    targets.length > 1 ? `package ${detail(name)}: ${reason}` : reason;
  if (stops.length > 0) {
    return {
      ok: false,
      kind: "needs_human",
      reason: stops
        .map(({ name, result }) => label(name, result.reason))
        .join("; "),
      notMergeable: stops.every(({ result }) => result.notMergeable),
    };
  }
  if (waits.length > 0) {
    return {
      ok: false,
      kind: "wait",
      reason: waits.map(({ name, reason }) => label(name, reason)).join("; "),
    };
  }
  return { ok: true };
}

// ---- 影響の評価 ----

export type ImpactAssessment = {
  impact: "none" | "impact";
  evidence: string;
  supplyChainConcerns: string[];
  unverified: string[];
};

// 構造化出力のJSON schemaも、同じ値を上限に使う。
export const MAX_EVIDENCE_CHARS = 4000;
export const MAX_LIST_ITEMS = 20;
export const MAX_ITEM_CHARS = 500;

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
