#!/usr/bin/env bun
// draw.ioのビューアを固定のURLから取得し、sha256を照合して<assets>に書く。
// 使い方: bun run scripts/fetch-drawio-viewer.ts <dist/drawio> [<キャッシュのディレクトリ>]
// キャッシュのファイルも、使う前に固定のsha256と照合する。照合に通らなければ、取得し直す。
// 照合に失敗したときは何も書かず、失敗して終了する。ビューアはリポジトリに入れない。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type DrawioViewerPin,
  parseDrawioViewerPin,
  verifyViewer,
  viewerAssetName,
} from "./drawio-viewer.ts";

const PIN_FILE = join(import.meta.dir, "..", "drawio-viewer.json");
const FETCH_TIMEOUT_MS = 60_000;

/** ビューアの大きさの上限。固定のsha256と一致しない巨大な応答を、メモリに読み込まない。 */
export const MAX_VIEWER_BYTES = 10 * 1024 * 1024;
/** 一時的な失敗(ネットワーク、429、5xx)の再試行の上限。待ちは1秒から倍にする。 */
export const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;
export type WriteImpl = (name: string, bytes: Uint8Array) => Promise<void>;
export type SleepImpl = (ms: number) => Promise<void>;
/** キャッシュにあるビューアを返す。無ければ`null`。 */
export type ReadCacheImpl = (name: string) => Promise<Uint8Array | null>;

export type FetchViewerResult =
  | { readonly ok: true; readonly name: string; readonly size: number }
  | { readonly ok: false; readonly reason: string };

type Attempt =
  | { readonly kind: "done"; readonly result: FetchViewerResult }
  | { readonly kind: "retry"; readonly reason: string };

function fail(reason: string): Attempt {
  return { kind: "done", result: { ok: false, reason } };
}

/** 上限を超えたら読むのをやめて`null`を返す。 */
async function readLimited(
  response: Response,
  limit: number,
): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return new Uint8Array();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function attemptOnce(
  pin: DrawioViewerPin,
  fetchImpl: FetchImpl,
  writeImpl: WriteImpl,
): Promise<Attempt> {
  let response: Response;
  try {
    response = await fetchImpl(pin.url, {
      // 固定のURLはリダイレクトしない。3xxは、中身を見ずに失敗させる。
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return { kind: "retry", reason: `network error: ${message}` };
  }
  if (isRetryableStatus(response.status)) {
    return { kind: "retry", reason: `HTTP ${response.status}` };
  }
  if (!response.ok) {
    return fail(`HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_VIEWER_BYTES) {
    return fail(`response too large: ${declared} bytes`);
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await readLimited(response, MAX_VIEWER_BYTES);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return { kind: "retry", reason: `network error: ${message}` };
  }
  if (bytes === null) {
    return fail(`response too large: over ${MAX_VIEWER_BYTES} bytes`);
  }
  const verification = verifyViewer(bytes, pin);
  if (!verification.ok) {
    return fail(verification.reason);
  }
  await writeImpl(verification.name, bytes);
  return {
    kind: "done",
    result: { ok: true, name: verification.name, size: bytes.length },
  };
}

/**
 * ビューアを取得して照合し、通ったときだけ`writeImpl`で書く。
 * キャッシュに固定のsha256と一致するものがあれば、取得せずにそれを書く。
 * 一時的な失敗(ネットワーク、429、5xx)は、待ちを倍にしながら`MAX_RETRIES`回まで再試行する。
 * 4xx、リダイレクト、上限超え、sha256の不一致は再試行せず、何も書かずに失敗を返す。
 */
export async function fetchViewer(
  pin: DrawioViewerPin,
  fetchImpl: FetchImpl,
  writeImpl: WriteImpl,
  sleep: SleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  readCache: ReadCacheImpl = async () => null,
): Promise<FetchViewerResult> {
  // キャッシュの中身は信用しない。固定のsha256と一致したときだけ使う。
  const cached = await readCache(viewerAssetName(pin));
  if (cached !== null) {
    const verification = verifyViewer(cached, pin);
    if (verification.ok) {
      await writeImpl(verification.name, cached);
      return { ok: true, name: verification.name, size: cached.length };
    }
  }
  let lastReason = "";
  for (let retry = 0; retry <= MAX_RETRIES; retry++) {
    if (retry > 0) {
      await sleep(BASE_BACKOFF_MS * 2 ** (retry - 1));
    }
    const attempt = await attemptOnce(pin, fetchImpl, writeImpl);
    if (attempt.kind === "done") {
      return attempt.result;
    }
    lastReason = attempt.reason;
  }
  return { ok: false, reason: `gave up after retries: ${lastReason}` };
}

async function main(): Promise<void> {
  const [assetsDir, cacheDir] = process.argv.slice(2);
  if (assetsDir === undefined) {
    console.error(
      "Usage: fetch-drawio-viewer.ts <dist/drawio> [<cache directory>]",
    );
    process.exit(2);
  }
  const pin = parseDrawioViewerPin(
    JSON.parse(await readFile(PIN_FILE, "utf8")),
  );
  const result = await fetchViewer(
    pin,
    fetch,
    async (name, bytes) => {
      await mkdir(assetsDir, { recursive: true });
      await writeFile(join(assetsDir, name), bytes);
      if (cacheDir !== undefined) {
        await mkdir(cacheDir, { recursive: true });
        await writeFile(join(cacheDir, name), bytes);
      }
    },
    undefined,
    async (name) => {
      if (cacheDir === undefined) return null;
      try {
        return new Uint8Array(await readFile(join(cacheDir, name)));
      } catch {
        return null;
      }
    },
  );
  if (!result.ok) {
    console.error(`The draw.io viewer was rejected: ${result.reason}`);
    process.exit(1);
  }
  console.log(
    `Wrote ${result.name} (draw.io ${pin.version}, ${result.size} bytes)`,
  );
}

if (import.meta.main) {
  await main();
}
