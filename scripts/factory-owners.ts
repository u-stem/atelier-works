// factory_configのownersを、WindmillのAPIから読む。doctor.shが、収集の対象外の所有者を警告するために使う。
//
// 使い方: factory-owners.ts underscore
//   loginに`_`を含む所有者の名前を、1行に1つ標準出力に出す。読めなければ何も出さず、終了コード2で終わる。
//   宛先は`WM_CHECK_BASE_URL`だけから読む。呼び出し側が死活を確かめた宛先と同じものを渡させ、
//   資格情報を別の宛先へ送らない。管理者の資格情報は環境変数から読み、引数に載せない。
//   出すのは所有者の名前だけで、資格情報も応答の本文も出さない。

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
// 別のプロセスが宛先のポートを使っていても漏らさないため。読めなければnullを返す。
// セッションのトークンはメモリの上だけに置き、読んだ後にログアウトする。
export async function readFactoryOwnerNames(
  baseUrl: string,
  credentials: AdminCredentials,
  fetchFn: typeof fetch = fetch,
): Promise<string[] | null> {
  const api = `${baseUrl.replace(/\/+$/, "")}/api`;
  let token: string | undefined;
  try {
    const version = await fetchFn(`${api}/version`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (!version.ok || !WINDMILL_VERSION_PATTERN.test(await version.text())) {
      return null;
    }
    const login = await fetchFn(`${api}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (!login.ok) {
      return null;
    }
    token = (await login.text()).trim();
    const response = await fetchFn(
      `${api}/w/${WORKSPACE}/resources/get_value/f/factory/factory_config`,
      {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      return null;
    }
    return ownerNames(await response.json());
  } catch {
    return null;
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

async function main(args: readonly string[]): Promise<number> {
  if (args[0] !== "underscore") {
    console.error("usage: factory-owners.ts underscore");
    return 64;
  }
  const baseUrl = process.env.WM_CHECK_BASE_URL ?? "";
  const email = process.env.WM_ADMIN_EMAIL ?? "";
  const password = process.env.WM_ADMIN_PASSWORD ?? "";
  if (baseUrl === "" || email === "" || password === "") {
    return EXIT_UNREADABLE;
  }
  const names = await readFactoryOwnerNames(baseUrl, { email, password });
  if (names === null) {
    return EXIT_UNREADABLE;
  }
  for (const name of ownersWithUnderscore({
    owners: names.map((owner) => ({ name: owner })),
  })) {
    console.log(name);
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
