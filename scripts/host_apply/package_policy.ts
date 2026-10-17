/** ルートの`package.json`の変更が、承認を要するかの判定。 */

import { isRecord, stableStringify } from "./stable.ts";

/** `none`は内容が同じ、`auto`は依存の版の変更だけ、`approval`は承認が要る変更。 */
export type PackageChange = "none" | "auto" | "approval";

/** 依存の版を書くキー。値の変更が版の指定なら、承認を求めない。 */
const VERSION_MAPS: readonly string[] = [
  "dependencies",
  "devDependencies",
  "overrides",
];

/**
 * 版の指定として認める書式。`1.2.3`、`^1.2.3`、`~1.2`、`>=1.2.3`、`1.2.3-rc.1`など。
 * URL、gitやfileの指定、`npm:`の別名、`latest`、`*`は、取得元や中身を変えうるので認めない。
 */
const VERSION_SPEC =
  /^[\^~<>=]*\s?v?\d+(?:\.(?:\d+|[xX*]))*(?:-[0-9A-Za-z.]+)?(?:\+[0-9A-Za-z.]+)?$/;

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function withoutVersionMaps(parsed: Record<string, unknown>): string {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!VERSION_MAPS.includes(key)) rest[key] = value;
  }
  return stableStringify(rest);
}

/**
 * 版の指定のキーの変更が、既存の名前の版の文字列への変更だけか。
 * 変更前に無い名前が増えたら、新しい依存を足す変更なので、認めない。名前を消す変更は認める。
 */
function onlyVersionChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  for (const key of VERSION_MAPS) {
    const next = after[key];
    if (next === undefined) continue;
    if (!isRecord(next)) return false;
    const previous = isRecord(before[key]) ? before[key] : {};
    for (const [name, spec] of Object.entries(next)) {
      if (!Object.hasOwn(previous, name)) return false;
      if (stableStringify(previous[name]) === stableStringify(spec)) continue;
      if (typeof spec !== "string" || !VERSION_SPEC.test(spec)) return false;
    }
  }
  return true;
}

/**
 * `package.json`の変更が承認を要するかを返す。
 * 依存の版の文字列だけが変わるときは、承認を要しない(dependabotの更新を止めないため)。
 * `scripts`、`bin`、`workspaces`、`trustedDependencies`、`devEngines`、`packageManager`などの
 * ほかのキーの変更と、版でない指定への変更、新規作成、読めない内容は、承認が要る。
 * ほかのキーは、中身を個別に判断せず、変更があれば承認にする。
 */
export function classifyPackageJsonChange(
  base: string | null,
  target: string,
): PackageChange {
  if (base === target) return "none";
  if (base === null) return "approval";
  const before = parseObject(base);
  const after = parseObject(target);
  if (before === null || after === null) return "approval";
  if (withoutVersionMaps(before) !== withoutVersionMaps(after)) {
    return "approval";
  }
  return onlyVersionChanges(before, after) ? "auto" : "approval";
}
