import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const BOOTSTRAP = join(REPO_ROOT, "scripts/bootstrap.sh");

// bootstrap.shは読み込むだけで実行が始まるので、関数の定義だけを取り出して動かす。
function extractFunction(name: string): string {
  const source = readFileSync(BOOTSTRAP, "utf8");
  const match = new RegExp(
    `^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`,
    "m",
  ).exec(source);
  if (match === null) {
    throw new Error(`function not found: ${name}`);
  }
  return match[0];
}

interface FakeInstance {
  // 保存済みのcustom_tags。未設定はundefined。
  stored: string[] | undefined;
  posts: unknown[];
}

describe("ensure_instance_custom_tag", () => {
  let tmp: string;
  let instance: FakeInstance;
  let server: ReturnType<typeof Bun.serve>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "bootstrap-custom-tags-"));
    instance = { stored: undefined, posts: [] };
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/settings/global/custom_tags") {
          if (request.method === "POST") {
            const body: unknown = await request.json();
            instance.posts.push(body);
            if (
              typeof body === "object" &&
              body !== null &&
              "value" in body &&
              Array.isArray(body.value)
            ) {
              instance.stored = body.value.filter(
                (item): item is string => typeof item === "string",
              );
            }
            return new Response("OK");
          }
          return Response.json(instance.stored ?? null);
        }
        if (url.pathname === "/api/workers/custom_tags") {
          return Response.json(instance.stored ?? ["chromium"]);
        }
        return new Response("not found", { status: 404 });
      },
    });
  });

  afterEach(() => {
    server.stop(true);
    rmSync(tmp, { recursive: true, force: true });
  });

  async function run(): Promise<{ code: number; output: string }> {
    const script = [
      "set -euo pipefail",
      'log() { printf "%s\\n" "$*"; }',
      'die() { printf "DIE: %s\\n" "$*"; exit 1; }',
      `REPO_ROOT=${JSON.stringify(REPO_ROOT)}`,
      `API="http://127.0.0.1:${server.port}/api"`,
      `RESP_FILE=${JSON.stringify(join(tmp, "resp.txt"))}`,
      `AUTH_HEADER_FILE=${JSON.stringify(join(tmp, "none"))}`,
      'CONSOLE_TAG="console"',
      'bun() { "$BUN_BIN" "$@"; }',
      'run_in_repo() { (cd -- "$REPO_ROOT" && "$@"); }',
      'bun_eval() { run_in_repo bun -e "$1"; }',
      extractFunction("api_get"),
      extractFunction("api_post"),
      extractFunction("custom_tags_set_body"),
      extractFunction("ensure_instance_custom_tag"),
      "ensure_instance_custom_tag",
    ].join("\n");
    const proc = Bun.spawn(["bash", "-c", script], {
      env: { ...process.env, BUN_BIN: process.execPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, output: stdout + stderr };
  }

  test("adds console to the effective tags when nothing is stored", async () => {
    await run();

    expect(instance.stored).toEqual(["chromium", "console"]);
  });

  test("keeps the stored tags when it adds console", async () => {
    instance.stored = ["chromium", "gpu"];

    await run();

    expect(instance.stored).toEqual(["chromium", "gpu", "console"]);
  });

  test("does not write when console is already stored", async () => {
    instance.stored = ["chromium", "console"];

    await run();

    expect(instance.posts).toEqual([]);
  });

  test("posts the tags under the value key", async () => {
    instance.stored = ["chromium"];

    await run();

    expect(instance.posts).toEqual([{ value: ["chromium", "console"] }]);
  });

  test("succeeds when it adds the tag", async () => {
    const { code } = await run();

    expect(code).toBe(0);
  });

  test("fails without writing when the stored value is malformed", async () => {
    server.stop(true);
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (request.method === "POST") {
          instance.posts.push(url.pathname);
        }
        return Response.json("chromium");
      },
    });

    const { code } = await run();

    expect([code, instance.posts]).toEqual([1, []]);
  });
});
