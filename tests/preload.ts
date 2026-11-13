// テストの前にジョブの環境変数を外す。
// 環境にジョブIDがあると、一時ディレクトリを引く処理が実機の`/run/factory-tmp`の下にディレクトリを作るため。
// ジョブIDが要るテストは、環境変数を引数や注入で渡す。
//
// テストが本物のGitHubへ送らないよう、グローバルの`fetch`を置き換える。
// GitHubのAPIと、その取得先のblob storageへの要求は、偽の応答の関数(`GITHUB_FETCH_HANDLER_KEY`)だけに答えさせる。
// 関数が無いときは、例外を投げて本物へは送らない。関数はテストのたびに外す。
// 偽の応答の関数を置くのは`tests/lib/testSupport.ts`である。

import { afterEach } from "bun:test";

delete process.env.WM_JOB_ID;
delete process.env.WM_ROOT_FLOW_JOB_ID;
delete process.env.WM_WORKSPACE;

/** 偽の応答の関数を置く、グローバルのオブジェクトの鍵。`tests/lib/testSupport.ts`と同じ名前を使う。 */
const GITHUB_FETCH_HANDLER_KEY = Symbol.for(
  "atelier-works.tests.github-fetch-handler",
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

afterEach(() => {
  Reflect.deleteProperty(globalThis, GITHUB_FETCH_HANDLER_KEY);
});
