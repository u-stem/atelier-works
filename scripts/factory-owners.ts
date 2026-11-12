// factory_configのownersを、WindmillのAPIから読む。doctor.shが、収集の対象外の所有者を警告するために使う。
//
// 使い方: factory-owners.ts underscore
//   loginに`_`を含む所有者の名前を、1行に1つ標準出力に出す。読めなければ標準出力には何も出さず、
//   失敗した段階を表す理由を1行標準エラーに出して、終了コード2で終わる。
//   宛先は`WM_CHECK_BASE_URL`だけから読む。呼び出し側が死活を確かめた宛先と同じものを渡させ、
//   資格情報を別の宛先へ送らない。管理者の資格情報は環境変数から読み、引数に載せない。
//   標準出力に出すのは所有者の名前だけで、資格情報も応答の本文も出さない。

const WORKSPACE = "factory";

// Windmillの`/api/version`は`CE v1.817.0`のような文字列を返す。
const WINDMILL_VERSION_PATTERN = /^(CE|EE) v\d/;

// 端末に出してよい名前。制御文字を含む名前は出さない。
const PRINTABLE_NAME = /^[A-Za-z0-9_.-]+$/;

const EXIT_UNREADABLE = 2;

interface AdminCredentials {
  email: string;
  password: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// factory_configの値から、所有者の名前を取り出す。ownersが配列でなければnull。
// 名前が文字列でない項目は読み飛ばす。
function ownerNames(config: unknown): string[] | null {
  if (!isRecord(config) || !Array.isArray(config.owners)) {
    return null;
  }
  const names: string[] = [];
  for (const owner of config.owners) {
    if (isRecord(owner) && typeof owner.name === "string") {
      names.push(owner.name);
    }
  }
  return names;
}

// ownersのうち、loginに`_`を含む所有者の名前。EMUのアカウントなどで、収集は扱わない。
// bootstrap.shは環境変数の名前の`_`を`-`に直すので、読み取り用のトークンの対応表のキーに合わない。
export function ownersWithUnderscore(config: unknown): string[] {
  return (ownerNames(config) ?? []).filter(
    (name) => name.includes("_") && PRINTABLE_NAME.test(name),
  );
}

// 管理者でログインし、factory_configのownersの名前を読む。
// ログインの前に`/api/version`がWindmillの応答かを確かめ、そうでなければ資格情報を送らない。
// 別のプロセスが宛先のポートを使っていても漏らさないため。
// 読めなければ、失敗した段階を表す理由を返す。理由に載せるのは、段階の名前、HTTPのstatus、
// 例外の名前だけで、資格情報、トークン、応答の本文、例外のメッセージは載せない。
// セッションのトークンはメモリの上だけに置き、読んだ後にログアウトする。
export type OwnerRead = { names: string[] } | { reason: string };

type Stage = "version" | "login" | "factory_config";

// 例外の名前。端末に出せない名前や、名前の無い値は`unknown`にする。
function exceptionName(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string" &&
    PRINTABLE_NAME.test(error.name)
  ) {
    return error.name;
  }
  return "unknown";
}

export async function readFactoryOwnerNames(
  baseUrl: string,
  credentials: AdminCredentials,
  fetchFn: typeof fetch = fetch,
): Promise<OwnerRead> {
  const api = `${baseUrl.replace(/\/+$/, "")}/api`;
  let token: string | undefined;
  let stage: Stage = "version";
  try {
    const version = await fetchFn(`${api}/version`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (!version.ok) {
      return { reason: `version: status ${version.status}` };
    }
    if (!WINDMILL_VERSION_PATTERN.test(await version.text())) {
      return { reason: "version: unexpected response" };
    }
    stage = "login";
    const login = await fetchFn(`${api}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (!login.ok) {
      return { reason: `login: status ${login.status}` };
    }
    token = (await login.text()).trim();
    stage = "factory_config";
    const response = await fetchFn(
      `${api}/w/${WORKSPACE}/resources/get_value/f/factory/factory_config`,
      {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      return { reason: `factory_config: status ${response.status}` };
    }
    const names = ownerNames(await response.json());
    return names === null
      ? { reason: "factory_config: no owner list" }
      : { names };
  } catch (error) {
    return { reason: `exception: ${exceptionName(error)} (${stage})` };
  } finally {
    if (token !== undefined && token.length > 0) {
      await fetchFn(`${api}/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
    }
  }
}

const REQUIRED_ENVIRONMENT: readonly string[] = [
  "WM_CHECK_BASE_URL",
  "WM_ADMIN_EMAIL",
  "WM_ADMIN_PASSWORD",
];

// 足りない環境変数の名前から理由を作る。値は載せない。全部あればnull。
export function missingEnvironmentReason(
  env: Record<string, string | undefined>,
): string | null {
  const missing = REQUIRED_ENVIRONMENT.filter(
    (name) => (env[name] ?? "") === "",
  );
  return missing.length === 0
    ? null
    : `missing environment: ${missing.join(", ")}`;
}

async function main(args: readonly string[]): Promise<number> {
  if (args[0] !== "underscore") {
    console.error("usage: factory-owners.ts underscore");
    return 64;
  }
  const missing = missingEnvironmentReason(process.env);
  if (missing !== null) {
    console.error(missing);
    return EXIT_UNREADABLE;
  }
  const baseUrl = process.env.WM_CHECK_BASE_URL ?? "";
  const email = process.env.WM_ADMIN_EMAIL ?? "";
  const password = process.env.WM_ADMIN_PASSWORD ?? "";
  const read = await readFactoryOwnerNames(baseUrl, { email, password });
  if ("reason" in read) {
    console.error(read.reason);
    return EXIT_UNREADABLE;
  }
  for (const name of ownersWithUnderscore({
    owners: read.names.map((owner) => ({ name: owner })),
  })) {
    console.log(name);
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
