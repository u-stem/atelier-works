// Windmillインスタンスのカスタムtag(global settingの`custom_tags`)を扱う。
//
// superadminでない主体は、インスタンスが許可したカスタムtag以外のtagを持つ
// scriptを実行できない。Consoleが呼ぶscriptは`console`のtagを持つので、
// このtagをインスタンスに許可しておく必要がある。
//
// 次の2つの入口がある。どちらも秘密を引数に載せない。
//   - `plan`: bootstrap.shが使う。保存済みの値と実効の値を環境変数から読み、
//     何をするかをJSONで標準出力に出す。
//   - `check <tag>`: doctor.shが使う。管理者でログインし、tagが許可されているかを
//     終了コードで返す(0=許可済み、1=未許可、2=確認できない)。

export type CustomTagPlan =
  | { kind: "present" }
  | { kind: "add"; tags: string[] }
  | { kind: "unreadable" };

// 文字列の配列だけを受け取る。それ以外(未設定のnullを含む)はundefinedにする。
export function parseCustomTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return undefined;
    }
    tags.push(item);
  }
  return tags;
}

// 保存済みのcustom_tagsにtagを足す計画を立てる。
// 保存済みの値が無い(null)ときは、インスタンスが実際に許可している値(実効の値)を
// 起点にする。保存済みの値を空の配列から作り直すと、既定のtagを失うため。
// 既存のtagは順序ごと保ち、tagが既にあれば何もしない。
export function planCustomTag(
  stored: unknown,
  effective: unknown,
  tag: string,
): CustomTagPlan {
  const base =
    stored === null ? parseCustomTags(effective) : parseCustomTags(stored);
  if (base === undefined) {
    return { kind: "unreadable" };
  }
  if (base.includes(tag)) {
    return { kind: "present" };
  }
  return { kind: "add", tags: [...base, tag] };
}

export type CustomTagCheck = "present" | "missing" | "unknown";

interface AdminCredentials {
  email: string;
  password: string;
}

// 管理者でログインし、インスタンスが許可するカスタムtagにtagがあるかを確かめる。
// 取得の途中で失敗したときは"unknown"を返し、tagの有無を断定しない。
// セッションのトークンはメモリの上だけに置き、確認の後にログアウトする。
export async function checkInstanceCustomTag(
  baseUrl: string,
  credentials: AdminCredentials,
  tag: string,
): Promise<CustomTagCheck> {
  const api = `${baseUrl.replace(/\/+$/, "")}/api`;
  let token: string | undefined;
  try {
    const login = await fetch(`${api}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
      signal: AbortSignal.timeout(10_000),
    });
    if (!login.ok) {
      return "unknown";
    }
    token = (await login.text()).trim();
    const response = await fetch(`${api}/workers/custom_tags`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return "unknown";
    }
    const tags = parseCustomTags(await response.json());
    if (tags === undefined) {
      return "unknown";
    }
    return tags.includes(tag) ? "present" : "missing";
  } catch {
    return "unknown";
  } finally {
    if (token !== undefined && token.length > 0) {
      await fetch(`${api}/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
    }
  }
}

function parseJsonEnv(name: string): unknown {
  const text = process.env[name] ?? "null";
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function main(args: readonly string[]): Promise<number> {
  const [mode, tag] = args;
  if (mode === "plan" && tag !== undefined) {
    const plan = planCustomTag(
      parseJsonEnv("WM_TMP_STORED"),
      parseJsonEnv("WM_TMP_EFFECTIVE"),
      tag,
    );
    process.stdout.write(JSON.stringify(plan));
    return 0;
  }
  if (mode === "check" && tag !== undefined) {
    const baseUrl = process.env.WM_BASE_URL ?? "";
    const email = process.env.WM_ADMIN_EMAIL ?? "";
    const password = process.env.WM_ADMIN_PASSWORD ?? "";
    if (baseUrl === "" || email === "" || password === "") {
      return 2;
    }
    const result = await checkInstanceCustomTag(
      baseUrl,
      { email, password },
      tag,
    );
    if (result === "present") {
      return 0;
    }
    return result === "missing" ? 1 : 2;
  }
  console.error("usage: custom-tags.ts plan <tag> | check <tag>");
  return 64;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
