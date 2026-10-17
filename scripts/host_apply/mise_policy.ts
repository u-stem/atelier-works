/** mise設定の静的な読み取りと、承認が要る変更かどうかの判定。`mise`コマンドは使わない。 */

import { MISE_APPROVAL_KEYS, MISE_ENV_KEYS } from "./constants.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

/**
 * 列挙したキーごとの値の形式。
 * `WM_BIND`はloopbackだけにする。値を広げる変更を承認なしで通すと、配信先が外に開くため。
 */
const VALUE_FORMATS: Readonly<Record<string, (value: string) => boolean>> = {
  WM_VERSION: (v) => VERSION.test(v),
  CLAUDE_VERSION: (v) => VERSION.test(v),
  GH_VERSION: (v) => VERSION.test(v),
  GITLEAKS_VERSION: (v) => VERSION.test(v),
  WMILL_VERSION: (v) => VERSION.test(v),
  WM_HTTP_PORT: (v) => /^\d{1,5}$/.test(v) && Number(v) <= 65535,
  WM_BIND: (v) => v === "127.0.0.1",
  WM_SESSION_VALIDITY_SECONDS: (v) => /^\d{1,9}$/.test(v),
  CONSOLE_GITHUB_REPO: (v) =>
    /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(v),
  GTR_REF: (v) => /^v\d+\.\d+\.\d+$/.test(v),
  GTR_COMMIT: (v) => /^[0-9a-f]{40}$/.test(v),
  FACTORY_CHECK_UID: (v) => /^\d{4,6}$/.test(v),
  FACTORY_CHECK_POOL_SIZE: (v) => /^\d{1,3}$/.test(v),
  LOG_MAX_SIZE: (v) => /^\d+[kmg]$/.test(v),
  LOG_MAX_FILE: (v) => /^\d{1,3}$/.test(v),
};

/**
 * 列挙したキーの値が、形式に合う文字列かを返す。
 * テンプレート(`{{`)を含む値と、列挙していないキーは常に不合格にする。
 */
export function validateMiseValue(key: string, value: unknown): boolean {
  if (typeof value !== "string" || value.includes("{{")) return false;
  const format = VALUE_FORMATS[key];
  return format !== undefined && format(value);
}

/**
 * mise設定の候補のパスか。
 * `mise.toml`、`mise.*.toml`、`.mise.toml`、`.mise.*.toml`は、ディレクトリを問わない。
 * `mise/`、`.mise/`、`.config/mise/`の下と、`.tool-versions`も含む。
 * 大文字小文字は区別しない。APFSでは`Mise.toml`も`mise.toml`と同じファイルを指すため。
 */
export function isMiseConfigPath(path: string): boolean {
  const normalized = path.replace(/^\.\//, "").toLowerCase();
  if (
    normalized.startsWith("mise/") ||
    normalized.startsWith(".mise/") ||
    normalized.startsWith(".config/mise/")
  ) {
    return true;
  }
  const basename = normalized.split("/").pop() ?? normalized;
  return (
    /^\.?mise(\.[^/]+)?\.toml$/.test(basename) || basename === ".tool-versions"
  );
}

function parseToml(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = Bun.TOML.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * TOMLとして静的に読み、`[env]`の列挙したキーのうち、文字列のものを返す。
 * 読めない、または`[env]`が無いときは`null`。
 */
export function readMiseEnv(
  text: string,
): Readonly<Record<string, string>> | null {
  const parsed = parseToml(text);
  if (parsed === null || !isRecord(parsed.env)) return null;
  const result: Record<string, string> = {};
  for (const key of MISE_ENV_KEYS) {
    const value = parsed.env[key];
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

export type MiseStaticCheck =
  | { readonly ok: true; readonly env: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly reason: string };

/**
 * 目標の`mise.toml`が、composeに渡せる形かを確かめる。
 * 列挙したキーがすべてあり、値が形式に合うこと。理由に値は含めない。
 */
export function checkMiseStatic(text: string): MiseStaticCheck {
  const env = readMiseEnv(text);
  if (env === null) return { ok: false, reason: "mise.toml is not readable" };
  for (const key of MISE_ENV_KEYS) {
    const value = env[key];
    if (value === undefined) {
      return { ok: false, reason: `${key} is missing or not a string` };
    }
    if (!validateMiseValue(key, value)) {
      return { ok: false, reason: `${key} does not fit its format` };
    }
  }
  return { ok: true, env };
}

/** `none`は内容が同じ、`auto`は承認なしで反映できる変更、`approval`は承認が要る変更。 */
export type MiseChange = "none" | "auto" | "approval";

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function withoutEnumeratedKeys(parsed: Record<string, unknown>): string {
  const copy = JSON.parse(JSON.stringify(parsed));
  if (isRecord(copy) && isRecord(copy.env)) {
    for (const key of MISE_ENV_KEYS) delete copy.env[key];
  }
  return stableStringify(copy);
}

/**
 * `mise.toml`の変更が承認を要するかを返す。
 * 列挙したキーの`[env]`の値だけが、形式に合う値へ変わるときは、承認を要しない。
 * ただし`MISE_APPROVAL_KEYS`のキー(`CONSOLE_GITHUB_REPO`)は、値が変わるなら承認が要る。
 * それ以外の差(ほかのキー、`[tools]`、`[tasks]`、キーの追加と削除、新規作成、読めない内容)は承認が要る。
 * コメントや空白だけの変更は、解釈が同じなので承認を要しない。
 */
export function classifyMiseTomlChange(
  base: string | null,
  target: string,
): MiseChange {
  if (base === target) return "none";
  if (base === null) return "approval";
  const before = parseToml(base);
  const after = parseToml(target);
  if (before === null || after === null) return "approval";
  const beforeEnv = readMiseEnv(base);
  const afterEnv = readMiseEnv(target);
  if (beforeEnv === null || afterEnv === null) return "approval";
  for (const key of MISE_ENV_KEYS) {
    if (!(key in beforeEnv) || !(key in afterEnv)) return "approval";
    if (!validateMiseValue(key, afterEnv[key])) return "approval";
  }
  for (const key of MISE_APPROVAL_KEYS) {
    if (beforeEnv[key] !== afterEnv[key]) return "approval";
  }
  return withoutEnumeratedKeys(before) === withoutEnumeratedKeys(after)
    ? "auto"
    : "approval";
}
