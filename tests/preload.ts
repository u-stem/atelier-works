// テストの前にジョブの環境変数を外す。
// 環境にジョブIDがあると、一時ディレクトリを引く処理が実機の`/run/factory-tmp`の下にディレクトリを作るため。
// ジョブIDが要るテストは、環境変数を引数や注入で渡す。
//
// テストが本物のGitHubへ送らないよう、グローバルの`fetch`を置き換える。
// GitHubのAPIと、その取得先のblob storageへの要求は、偽の応答の関数(`GITHUB_FETCH_HANDLER_KEY`)だけに答えさせる。
// 関数が無いときは、例外を投げて本物へは送らない。関数はテストのたびに外す。
// `beforeAll`で置いた偽の応答も、最初のテストの後で外れる。
// 偽の応答の関数を置くのは`tests/lib/testSupport.ts`である。
// 偽のrunnerの応答が尽きた後の要求は記録され(`GITHUB_FETCH_EXHAUSTED_KEY`)、そのテストを失敗にする。

import { afterEach } from "bun:test";

delete process.env.WM_JOB_ID;
delete process.env.WM_ROOT_FLOW_JOB_ID;
delete process.env.WM_WORKSPACE;

/** 偽の応答の関数を置く、グローバルのオブジェクトの鍵。`tests/lib/testSupport.ts`が読み込んで使う。 */
export const GITHUB_FETCH_HANDLER_KEY = Symbol.for(
  "atelier-works.tests.github-fetch-handler",
);

/** 偽のrunnerの応答が尽きた後の要求を記録する、グローバルのオブジェクトの鍵。`tests/lib/testSupport.ts`が書く。 */
export const GITHUB_FETCH_EXHAUSTED_KEY = Symbol.for(
  "atelier-works.tests.github-fetch-exhausted",
);

/** GitHubのAPIか、その取得先のblob storageへの要求か。 */
function isGitHubTarget(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === "https://api.github.com" ||
      parsed.hostname.endsWith(".blob.core.windows.net")
    );
  } catch {
    return false;
  }
}

const originalFetch = globalThis.fetch;

const routedFetch = async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  if (!isGitHubTarget(url)) return originalFetch(input, init);
  const handler: unknown = Reflect.get(globalThis, GITHUB_FETCH_HANDLER_KEY);
  if (typeof handler !== "function") {
    throw new Error("tests must not reach GitHub: no fake answers this fetch");
  }
  const response: unknown = await handler(url, init ?? {});
  if (!(response instanceof Response)) {
    throw new Error("the fake GitHub fetch did not return a Response");
  }
  return response;
};

globalThis.fetch = Object.assign(routedFetch, {
  preconnect: originalFetch.preconnect,
});

// 偽のrunnerの応答が尽きた後の要求があったテストは、ここで失敗にする。
// 通信層はその要求を応答の無い失敗として飲み込むので、テストの期待が偶然に通ってしまうのを防ぐ。
afterEach(() => {
  Reflect.deleteProperty(globalThis, GITHUB_FETCH_HANDLER_KEY);
  const exhausted: unknown = Reflect.get(
    globalThis,
    GITHUB_FETCH_EXHAUSTED_KEY,
  );
  Reflect.deleteProperty(globalThis, GITHUB_FETCH_EXHAUSTED_KEY);
  if (typeof exhausted === "string") throw new Error(exhausted);
});
