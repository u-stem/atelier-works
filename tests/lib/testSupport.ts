// コマンドを実行するlibモジュール(`workspace.ts`、`claude.ts`)と、GitHubのAPIを呼ぶ`github.ts`の
// smallテストで共有するフェイク。テスト専用で、Windmillにはデプロイしない。
// GitHubのAPIの偽の応答は、`gh api -i`の標準出力の形(ステータス行、ヘッダー、本文)で用意し、`fetch`の応答に写す。

import { spyOn } from "bun:test";
import type {
  CommandResult,
  CommandRunner,
  CommandRunOptions,
} from "../../f/factory/lib/workspace.ts";
import { GITHUB_FETCH_HANDLER_KEY } from "../preload.ts";

/** `fetch`で送ったGitHubのAPIへの要求。偽のrunnerが記録する。 */
export type FakeRequest = {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | null;
  readonly redirect: RequestRedirect | undefined;
};

export type FakeCall = {
  /** GitHubのAPIへの要求は`["fetch", <method>, <パスとクエリ>]`になる。 */
  readonly argv: readonly string[];
  readonly options: CommandRunOptions | undefined;
  /** `fetch`で送った要求のときだけ付く。 */
  readonly request?: FakeRequest;
};

export type FakeCommandRunner = {
  readonly run: CommandRunner;
  readonly calls: FakeCall[];
};

const GITHUB_API_ORIGIN = "https://api.github.com";

/** 偽のrunnerが答える、ジョブのログの取得先。`ghApiRedirect`で指す。 */
export const FAKE_LOG_STORAGE_URL =
  "https://fake.blob.core.windows.net/job-log.txt";

type GitHubFetchHandler = (url: string, init: RequestInit) => Promise<Response>;

/**
 * GitHubのAPIとその取得先への`fetch`に答える関数を置く。
 * `tests/preload.ts`がグローバルの`fetch`を置き換え、鍵の関数に答えさせる。関数はテストのたびに外れる。
 */
function setGitHubFetchHandler(handler: GitHubFetchHandler): void {
  Reflect.set(globalThis, GITHUB_FETCH_HANDLER_KEY, handler);
}

/**
 * `gh api -i`の出力を、ステータス行とヘッダーの部分(改行は`\n`にそろえる)と、本文に分ける。
 * 区切りは最初の空行で、CRLFの空行を先に探す。
 */
function splitGhOutput(stdout: string): {
  readonly head: string;
  readonly bodyText: string;
} {
  const crlf = stdout.indexOf("\r\n\r\n");
  const lf = stdout.indexOf("\n\n");
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return {
      head: stdout.slice(0, crlf).replace(/\r\n/g, "\n"),
      bodyText: stdout.slice(crlf + 4),
    };
  }
  if (lf !== -1) {
    return {
      head: stdout.slice(0, lf).replace(/\r\n/g, "\n"),
      bodyText: stdout.slice(lf + 2),
    };
  }
  return { head: stdout.replace(/\r\n/g, "\n"), bodyText: "" };
}

/** 本文の無いステータス。`Response`はこれらに本文を付けられない。 */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);

/**
 * `gh api -i`の出力を、`fetch`の応答に写す。
 * - timeoutの結果は、締め切りの例外(`TimeoutError`)で拒否する。
 * - ステータス行の無い出力は、応答の無い通信の失敗として拒否する。
 * - 2xxなのに終了コードが0でない出力は、本文の途中で切れる応答にする。
 */
function responseFromGhOutput(result: CommandResult): Response {
  if (result.timedOut) {
    throw new DOMException("The operation timed out.", "TimeoutError");
  }
  // 本文は書き換えずに渡す。`fetch`の本文は、改行を正規化されないため。
  const { head, bodyText } = splitGhOutput(result.stdout);
  const [statusLine = "", ...headerLines] = head.split("\n");
  const statusMatch = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/);
  if (statusMatch?.[1] === undefined) throw new TypeError("fetch failed");
  const status = Number(statusMatch[1]);
  const headers = new Headers();
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  if (NULL_BODY_STATUSES.has(status)) {
    return new Response(null, { status, headers });
  }
  if (result.exitCode !== 0 && status >= 200 && status < 300) {
    const bytes = new TextEncoder().encode(bodyText);
    const cut = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.error(new TypeError("terminated"));
      },
    });
    return new Response(cut, { status, headers });
  }
  return new Response(bodyText, { status, headers });
}

/**
 * 呼び出し1回ごとに`responses`を順に返す偽の`CommandRunner`を作る。
 * 応答が`Error`のときは、その例外を投げる。
 * プロセスの起動失敗を表すには`SpawnError`を渡す。
 * 検証のため、各呼び出しのargvとoptionsを`calls`に記録する。
 * 用意した応答が尽きたあとに呼ばれると例外を投げる。
 *
 * GitHubのAPIへの`fetch`(読み取りと書き込みのすべて)も、同じ`responses`の列から順に答える。
 * `gh api -i`の出力の形の応答を`fetch`の応答に写すので、gitなどのコマンドとGitHubのAPIへの要求を1つの列に並べられる。
 * `fetch`の要求は、メソッド、URL、ヘッダー、本文を`calls`の`request`に記録する。
 * `fetch`を受けるのは、そのテストの中で最後に作った偽のrunnerである。テストが終わると外れる(`tests/preload.ts`)。
 */
export function createFakeCommandRunner(
  responses: readonly (CommandResult | Error)[],
): FakeCommandRunner {
  const calls: FakeCall[] = [];
  let index = 0;
  const next = (label: string): CommandResult => {
    const result = responses[index];
    index += 1;
    if (result === undefined) {
      throw new Error(
        `createFakeCommandRunner: no canned response for call #${index} (${label})`,
      );
    }
    if (result instanceof Error) throw result;
    return result;
  };
  const run: CommandRunner = async (argv, options) => {
    calls.push({ argv, options });
    return next(argv.join(" "));
  };
  const handleFetch: GitHubFetchHandler = async (url, init) => {
    const call = fetchCall(url, init);
    calls.push(call);
    return responseFromGhOutput(next(call.argv.join(" ")));
  };
  setGitHubFetchHandler(handleFetch);
  return { run, calls };
}

/**
 * `fetch`の要求を、偽のrunnerが記録する形にする。
 * GitHubのAPIへの要求はパスとクエリを、取得先(blob storage)への要求はURLの全体を、argvの3つ目に置く。
 */
function fetchCall(url: string, init: RequestInit): FakeCall {
  const parsed = new URL(url);
  const method = init.method ?? "GET";
  const target =
    parsed.origin === GITHUB_API_ORIGIN
      ? `${parsed.pathname.slice(1)}${parsed.search}`
      : parsed.href;
  return {
    argv: ["fetch", method, target],
    options: undefined,
    request: {
      url,
      method,
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? init.body : null,
      redirect: init.redirect,
    },
  };
}

/**
 * GitHubのAPIへの`fetch`を、`run`に答えさせる。エンドポイントで応答を選ぶ自前の`run`を使うテストのためのもの。
 * `run`は、`["fetch", <method>, <パスとクエリ>]`のargvで呼ばれ、`gh api -i`の出力の形で答える。
 * そのテストの中で、次に偽のrunnerを作るか、この関数を呼ぶまで続く。テストが終わると外れる。
 */
export function serveGitHubFetchWith(run: CommandRunner): void {
  setGitHubFetchHandler(async (url, init) =>
    responseFromGhOutput(await run(fetchCall(url, init).argv)),
  );
}

/** `stubGlobalFetch`が記録する、送った要求。 */
export type SentRequest = { readonly url: string; readonly init: RequestInit };

const globalFetchStubs: { mockRestore(): void }[] = [];

/**
 * グローバルの`fetch`を、`handler`に答えさせる関数に差し替える。送った要求は`sent`に記録する。
 * 差し替えは`restoreGlobalFetch`で戻す。使うテストのファイルは`afterEach(restoreGlobalFetch)`を置く。
 */
export function stubGlobalFetchWith(
  handler: (request: SentRequest, index: number) => Promise<Response>,
): { readonly sent: SentRequest[] } {
  const sent: SentRequest[] = [];
  const replacement = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = {
      url: input instanceof Request ? input.url : String(input),
      init: init ?? {},
    };
    sent.push(request);
    return handler(request, sent.length - 1);
  };
  globalFetchStubs.push(
    spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(replacement, { preconnect: globalThis.fetch.preconnect }),
    ),
  );
  return { sent };
}

/**
 * グローバルの`fetch`を、`steps`を順に返す関数に差し替える。`Error`を渡すと、その回は拒否する。
 * 用意した応答が尽きた後に呼ばれると例外を投げる。
 * 差し替えは`restoreGlobalFetch`で戻す。使うテストのファイルは`afterEach(restoreGlobalFetch)`を置く。
 */
export function stubGlobalFetch(steps: readonly (Response | Error)[]): {
  readonly sent: SentRequest[];
} {
  return stubGlobalFetchWith(async (_request, index) => {
    const step = steps[index];
    if (step === undefined) {
      throw new Error(
        `stubGlobalFetch: no stubbed response for request #${index + 1}`,
      );
    }
    if (step instanceof Error) throw step;
    return step;
  });
}

/** `stubGlobalFetch`の差し替えをすべて戻す。 */
export function restoreGlobalFetch(): void {
  for (const stub of globalFetchStubs.splice(0).reverse()) stub.mockRestore();
}

/** 本文の`prefix`を渡した後、読み取りの途中で`error`で失敗する応答。 */
export function cutBody(status: number, error: Error, prefix = ""): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(prefix));
      controller.error(error);
    },
  });
  return new Response(stream, { status });
}

/** `Location`で署名付きURLを指す302の応答。 */
export function redirectTo(location: string, status = 302): Response {
  return new Response(null, { status, headers: { Location: location } });
}

export function ok(stdout = "", stderr = ""): CommandResult {
  return { stdout, stderr, exitCode: 0, timedOut: false };
}

export function fail(stderr: string, exitCode = 1): CommandResult {
  return { stdout: "", stderr, exitCode, timedOut: false };
}

export function timeout(stderr = ""): CommandResult {
  return { stdout: "", stderr, exitCode: 137, timedOut: true };
}

/**
 * `gh api -i`の標準出力と同じ形の文字列を作る。
 * ステータス行、CRLFで区切ったヘッダー、空行、本文の順に並べる。
 * 形は実際の`gh api -i`の出力を採取して合わせた。
 * 用意する`CommandResult.stdout`として使う。
 */
export function ghApiStdout(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): string {
  const bodyText = typeof body === "string" ? body : JSON.stringify(body);
  const headerLines = Object.entries(headers).map(
    ([key, value]) => `${key}: ${value}`,
  );
  return [`HTTP/2.0 ${status} Status`, ...headerLines, "", bodyText].join(
    "\r\n",
  );
}

export function ghApiOk(
  body: unknown,
  headers: Record<string, string> = {},
): CommandResult {
  return ok(ghApiStdout(200, body, headers));
}

/** `location`へ302で渡す応答。ジョブのログとartifactのAPIの応答に使う。 */
export function ghApiRedirect(
  location: string = FAKE_LOG_STORAGE_URL,
): CommandResult {
  return ok(ghApiStdout(302, "", { location }));
}

/**
 * 付与者の確認のGraphQL(`timelineItems`の`LABELED_EVENT` / `UNLABELED_EVENT`)の
 * 応答のノード1件。形は本物のAPIの応答から採った。
 * `login`が`null`のときは`actor`が無い。
 */
export function labelEventNode(
  kind: "labeled" | "unlabeled",
  login: string | null,
  label: string,
  createdAt = "2026-09-28T03:13:41Z",
  actorType = "User",
  databaseId?: unknown,
) {
  const prefix = kind === "labeled" ? "LE" : "UNLE";
  return {
    __typename: kind === "labeled" ? "LabeledEvent" : "UnlabeledEvent",
    id: `${prefix}_${createdAt}_${label}`,
    createdAt,
    actor:
      login === null
        ? null
        : {
            login,
            __typename: actorType,
            ...(databaseId === undefined ? {} : { databaseId }),
          },
    label: { name: label },
  };
}

/**
 * 付与者の確認のGraphQLの応答。
 * `hasPreviousPage`は、読んだ範囲より古いラベルのイベントが残っているか。
 */
export function labelEventsOk(
  nodes: readonly unknown[],
  hasPreviousPage = false,
): CommandResult {
  return ghApiOk({
    data: {
      repository: {
        issueOrPullRequest: {
          timelineItems: { pageInfo: { hasPreviousPage }, nodes },
        },
      },
    },
  });
}
