#!/usr/bin/env bun
// draw.ioのビューアを固定のURLから取得し、sha256を照合して<assets>に書く。
// 使い方: bun run scripts/fetch-drawio-viewer.ts <dist/assets>
// 照合に失敗したときは何も書かず、失敗して終了する。ビューアはgitに入れない。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDrawioViewerPin, verifyViewer } from "./drawio-viewer.ts";

const PIN_FILE = join(import.meta.dir, "..", "drawio-viewer.json");
const FETCH_TIMEOUT_MS = 60_000;

async function main(): Promise<void> {
  const [assetsDir] = process.argv.slice(2);
  if (assetsDir === undefined) {
    console.error("Usage: fetch-drawio-viewer.ts <dist/assets>");
    process.exit(2);
  }
  const pin = parseDrawioViewerPin(
    JSON.parse(await readFile(PIN_FILE, "utf8")),
  );
  // 固定のURLはリダイレクトしない。別の場所へ飛ばされたら、中身を見ずに失敗させる。
  const response = await fetch(pin.url, {
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    console.error(
      `Failed to fetch the draw.io viewer: HTTP ${response.status}`,
    );
    process.exit(1);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const result = verifyViewer(bytes, pin);
  if (!result.ok) {
    console.error(`The draw.io viewer was rejected: ${result.reason}`);
    process.exit(1);
  }
  await mkdir(assetsDir, { recursive: true });
  await writeFile(join(assetsDir, result.name), bytes);
  console.log(
    `Wrote ${result.name} (draw.io ${pin.version}, ${bytes.length} bytes)`,
  );
}

if (import.meta.main) {
  await main();
}
