import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// このファイルのテストは、bashの子プロセスを走らせる。並列で負荷が高いとbunの既定の5秒を
// 超えることがあるため、このファイルだけ30秒にする。
setDefaultTimeout(30_000);

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
  // 保存済みの値として返す生の値。形が不正な場合を作るときに使う。
  storedRaw: unknown;
  // 保存済みの値の読み取りが返すステータス。
  storedStatus: number;
  // 実効の値の読み取りが返すステータス。
  effectiveStatus: number;
  // 書き込みが返すステータス。200以外のときは値を保存しない。
  postStatus: number;
  // 書き込みの後、実効の値が新しくなるまでに、古い値を返す読み取りの回数。
  lagReads: number;
  lag: { tags: string[]; reads: number } | undefined;
  posts: unknown[];
  calls: string[];
}

function newInstance(): FakeInstance {
  return {
    stored: undefined,
    storedRaw: undefined,
    storedStatus: 200,
    effectiveStatus: 200,
    postStatus: 200,
    lagReads: 0,
    lag: undefined,
    posts: [],
    calls: [],
  };
}

// 保存済みなら保存済みの値、無ければ既定の["chromium"]が実効の値になる。
function effectiveTags(instance: FakeInstance): string[] {
  return instance.stored ?? ["chromium"];
}

function serveInstance(instance: FakeInstance): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      instance.calls.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/api/version") {
        return new Response("CE v1.817.0");
      }
      if (url.pathname === "/api/auth/login") {
        return new Response("session-token");
      }
      if (url.pathname === "/api/auth/logout") {
        return new Response("logged out");
      }
      if (url.pathname === "/api/settings/global/custom_tags") {
        if (request.method === "POST") {
          const body: unknown = await request.json();
          instance.posts.push(body);
          if (instance.postStatus !== 200) {
            return new Response("failure", { status: instance.postStatus });
          }
          if (
            typeof body === "object" &&
            body !== null &&
            "value" in body &&
            Array.isArray(body.value)
          ) {
            if (instance.lagReads > 0) {
              instance.lag = {
                tags: effectiveTags(instance),
                reads: instance.lagReads,
              };
            }
            instance.stored = body.value.filter(
              (item): item is string => typeof item === "string",
            );
          }
          return new Response("OK");
        }
        if (instance.storedStatus !== 200) {
          return new Response("failure", { status: instance.storedStatus });
        }
        return Response.json(instance.storedRaw ?? instance.stored ?? null);
      }
      if (url.pathname === "/api/workers/custom_tags") {
        if (instance.effectiveStatus !== 200) {
          return new Response("failure", { status: instance.effectiveStatus });
        }
        if (instance.lag !== undefined && instance.lag.reads > 0) {
          instance.lag.reads -= 1;
          return Response.json(instance.lag.tags);
        }
        return Response.json(effectiveTags(instance));
      }
      return new Response("not found", { status: 404 });
    },
  });
}

async function collect(
  proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>,
): Promise<{ code: number; output: string }> {
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, output: stdout + stderr };
}

describe("ensure_instance_custom_tag", () => {
  let tmp: string;
  let instance: FakeInstance;
  let server: ReturnType<typeof Bun.serve>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "bootstrap-custom-tags-"));
    instance = newInstance();
    server = serveInstance(instance);
  });

  afterEach(() => {
    server.stop(true);
    rmSync(tmp, { recursive: true, force: true });
  });

  async function run(
    invocation = "ensure_instance_custom_tag console",
  ): Promise<{ code: number; output: string }> {
    const script = [
      "set -euo pipefail",
      'log() { printf "%s\\n" "$*"; }',
      'die() { printf "DIE: %s\\n" "$*"; exit 1; }',
      `REPO_ROOT=${JSON.stringify(REPO_ROOT)}`,
      `API="http://127.0.0.1:${server.port}/api"`,
      `RESP_FILE=${JSON.stringify(join(tmp, "resp.txt"))}`,
      `AUTH_HEADER_FILE=${JSON.stringify(join(tmp, "none"))}`,
      "CUSTOM_TAGS_READBACK_ATTEMPTS=5",
      "CUSTOM_TAGS_READBACK_INTERVAL=0.01",
      'bun() { "$BUN_BIN" "$@"; }',
      'run_in_repo() { (cd -- "$REPO_ROOT" && "$@"); }',
      'bun_eval() { run_in_repo bun -e "$1"; }',
      extractFunction("curl_local"),
      extractFunction("api_get"),
      extractFunction("api_post"),
      extractFunction("custom_tags_set_body"),
      extractFunction("ensure_instance_custom_tag"),
      extractFunction("ensure_instance_custom_tags"),
      invocation,
    ].join("\n");
    const proc = Bun.spawn(["bash", "-c", script], {
      env: { ...process.env, BUN_BIN: process.execPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    return collect(proc);
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

  test("treats a missing stored setting as unset and starts from the effective tags", async () => {
    instance.storedStatus = 404;

    await run();

    expect(instance.posts).toEqual([{ value: ["chromium", "console"] }]);
  });

  test("fails when reading the stored setting fails with another status", async () => {
    instance.storedStatus = 500;

    const { output } = await run();

    expect(output).toContain(
      "DIE: failed to read the instance custom_tags setting (status 500)",
    );
  });

  test("does not write when reading the stored setting fails", async () => {
    instance.storedStatus = 500;

    await run();

    expect(instance.posts).toEqual([]);
  });

  test("fails with the status when nothing is stored and the effective tags cannot be read", async () => {
    instance.effectiveStatus = 503;

    const { output } = await run();

    expect(output).toContain(
      "DIE: failed to read effective custom tags (status 503)",
    );
  });

  test("does not report a malformed shape when the effective tags cannot be read", async () => {
    instance.effectiveStatus = 503;

    const { output } = await run();

    expect(output).not.toContain("unexpected shape");
  });

  test("does not write when the effective tags cannot be read", async () => {
    instance.effectiveStatus = 503;

    await run();

    expect(instance.posts).toEqual([]);
  });

  test("fails when the write is refused", async () => {
    instance.stored = ["chromium"];
    instance.postStatus = 500;

    const { output } = await run();

    expect(output).toContain(
      "DIE: failed to set the instance custom_tags (status 500)",
    );
  });

  test("fails when console is not listed after the write", async () => {
    instance.lagReads = 100;

    const { output } = await run();

    expect(output).toContain("is not listed when read back");
  });

  test("fails with a non-zero exit when console is not listed after the write", async () => {
    instance.lagReads = 100;

    const { code } = await run();

    expect(code).toBe(1);
  });

  test("retries the read back until the write is reflected", async () => {
    instance.lagReads = 2;

    const { code } = await run();

    expect(code).toBe(0);
  });

  test("reads the effective tags again for each retry", async () => {
    instance.stored = ["chromium"];
    instance.lagReads = 2;

    await run();

    // 書き込みの前の読み取りは、保存済みの値があれば行わない。
    // 古い値を返す2回と、反映された1回で、読み戻しは3回になる。
    expect(
      instance.calls.filter((call) => call === "GET /api/workers/custom_tags"),
    ).toHaveLength(3);
  });

  test("adds periodic when it is asked for periodic", async () => {
    instance.stored = ["chromium"];

    await run("ensure_instance_custom_tag periodic");

    expect(instance.stored).toEqual(["chromium", "periodic"]);
  });

  test("adds console and periodic together with the plural entry point", async () => {
    instance.stored = ["chromium"];

    await run("ensure_instance_custom_tags");

    expect(instance.stored).toEqual(["chromium", "console", "periodic"]);
  });

  test("does not write when console and periodic are already stored", async () => {
    instance.stored = ["chromium", "console", "periodic"];

    await run("ensure_instance_custom_tags");

    expect(instance.posts).toEqual([]);
  });

  test("writes only periodic when console is already stored", async () => {
    instance.stored = ["chromium", "console"];

    await run("ensure_instance_custom_tags");

    expect(instance.posts).toEqual([
      { value: ["chromium", "console", "periodic"] },
    ]);
  });

  test("fails without writing when the stored value is malformed", async () => {
    instance.storedRaw = "chromium";

    const { code } = await run();

    expect(code).toBe(1);
  });

  test("does not write when the stored value is malformed", async () => {
    instance.storedRaw = "chromium";

    await run();

    expect(instance.posts).toEqual([]);
  });
});

describe("bootstrap.sh custom-tags argument", () => {
  let tmp: string;
  let instance: FakeInstance;
  let server: ReturnType<typeof Bun.serve>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "bootstrap-custom-tags-arg-"));
    instance = newInstance();
    server = serveInstance(instance);
    // `mise exec -- <command>`をそのまま実行する偽のmiseと、本物のbunへのリンク。
    // `wmill`は置かない。引数の分岐が壊れて手順2へ進めば、wmillが無くて失敗する。
    const bin = join(tmp, "bin");
    mkdirSync(bin);
    const mise = join(bin, "mise");
    writeFileSync(
      mise,
      '#!/bin/sh\nshift\n[ "$1" = -- ] && shift\nexec "$@"\n',
    );
    chmodSync(mise, 0o755);
    symlinkSync(process.execPath, join(bin, "bun"));
  });

  afterEach(() => {
    server.stop(true);
    rmSync(tmp, { recursive: true, force: true });
  });

  async function runBootstrap(
    ...args: string[]
  ): Promise<{ code: number; output: string }> {
    const proc = Bun.spawn(["bash", BOOTSTRAP, ...args], {
      env: {
        PATH: `${join(tmp, "bin")}:${process.env.PATH ?? ""}`,
        HOME: tmp,
        WM_HTTP_PORT: String(server.port),
        WM_ADMIN_EMAIL: "admin@example.com",
        WM_ADMIN_PASSWORD: "a-strong-password-123",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return collect(proc);
  }

  test("only sets the custom tags and logs out", async () => {
    await runBootstrap("custom-tags");

    expect(instance.calls).toEqual([
      "GET /api/version",
      "POST /api/auth/login",
      "GET /api/settings/global/custom_tags",
      "GET /api/workers/custom_tags",
      "POST /api/settings/global/custom_tags",
      "GET /api/workers/custom_tags",
      "GET /api/settings/global/custom_tags",
      "POST /api/settings/global/custom_tags",
      "GET /api/workers/custom_tags",
      "POST /api/auth/logout",
    ]);
  });

  test("exits 0 after the custom tag is set", async () => {
    const { code } = await runBootstrap("custom-tags");

    expect(code).toBe(0);
  });

  test("rejects an unknown argument", async () => {
    const { output } = await runBootstrap("bogus");

    expect(output).toContain("unknown argument: bogus");
  });

  test("does not call the instance for an unknown argument", async () => {
    await runBootstrap("bogus");

    expect(instance.calls).toEqual([]);
  });
});
