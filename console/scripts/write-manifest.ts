#!/usr/bin/env bun
// 組み立ての出力(dist/)の全ファイルのsha256を計算し、dist/manifest.jsonに書く。
// 使い方: bun run scripts/write-manifest.ts <dist> <source-sha>
// symlinkや通常のファイル以外が出力にあれば、失敗して終了する。
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { buildManifest, MANIFEST_FILE, type ManifestFile } from "./manifest.ts";

async function collectFiles(
  root: string,
  dir: string,
): Promise<ManifestFile[]> {
  const files: ManifestFile[] = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const stat = await lstat(path);
    if (stat.isDirectory()) {
      files.push(...(await collectFiles(root, path)));
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`build output contains a non-regular file: ${path}`);
    }
    const relativePath = relative(root, path).split(sep).join("/");
    if (relativePath === MANIFEST_FILE) continue;
    const sha256 = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    files.push({ path: relativePath, sha256 });
  }
  return files;
}

async function main(): Promise<void> {
  const [dist, sha] = process.argv.slice(2);
  if (dist === undefined || sha === undefined) {
    console.error("Usage: write-manifest.ts <dist> <source-sha>");
    process.exit(2);
  }
  const manifest = buildManifest(sha, await collectFiles(dist, dist));
  await writeFile(
    join(dist, MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(
    `Wrote ${MANIFEST_FILE} with ${Object.keys(manifest.files).length} files for ${sha}`,
  );
}

if (import.meta.main) {
  await main();
}
