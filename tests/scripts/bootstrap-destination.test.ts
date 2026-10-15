import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BOOTSTRAP = resolve(import.meta.dir, "../../scripts/bootstrap.sh");
const PASSWORD = "a-strong-password-123";

interface FakeServer {
  server: ReturnType<typeof Bun.serve>;
  // 受けたリクエストの`METHOD /path`。
  calls: string[];
  // `/api/version`の本文として送り出したバイト数。
  sentBytes: () => number;
}

interface VersionReply {
  status: number;
  body: string;
  location?: string;
  // 指定があれば、本文の代わりに64KiBの塊をこの数だけ流す。
  streamChunks?: number;
}

const CHUNK_BYTES = 65536;

// `/api/version`の応答を差し替えられる偽のWindmill。
function serveFake(
  version: () => VersionReply,
  loginLocation?: () => string,
): FakeServer {
  const calls: string[] = [];
  let sent = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      calls.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/api/version") {
        const reply = version();
        const headers: Record<string, string> = {};
        if (reply.location !== undefined) {
          headers.Location = reply.location;
        }
        if (reply.streamChunks !== undefined) {
          const chunk = new Uint8Array(CHUNK_BYTES).fill(97);
          let count = 0;
          const stream = new ReadableStream({
            pull(controller) {
              if (count >= (reply.streamChunks ?? 0)) {
                controller.close();
                return;
              }
              count += 1;
              sent += chunk.length;
              controller.enqueue(chunk);
            },
          });
          return new Response(stream, { status: reply.status, headers });
        }
        return new Response(reply.body, { status: reply.status, headers });
      }
      if (url.pathname === "/api/auth/login") {
        if (loginLocation !== undefined) {
          return new Response("", {
            status: 302,
            headers: { Location: loginLocation() },
          });
        }
        return new Response("session-token");
      }
      if (url.pathname === "/api/auth/logout") {
        return new Response("logged out");
      }
      if (url.pathname === "/api/settings/global/custom_tags") {
        return Response.json(["chromium", "console"]);
      }
      if (url.pathname === "/api/workers/custom_tags") {
        return Response.json(["chromium", "console"]);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, calls, sentBytes: () => sent };
}

const windmillVersion = (): VersionReply => ({
  status: 200,
  body: "CE v1.817.0",
});

function loginCalls(fake: FakeServer): string[] {
  return fake.calls.filter((call) => call === "POST /api/auth/login");
}

describe("bootstrap.sh destination", () => {
  let tmp: string;
  let fakes: FakeServer[];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "bootstrap-destination-"));
    fakes = [];
    // `mise exec -- <command>`をそのまま実行する偽のmiseと、本物のbunへのリンク。
    // `wmill`は置かない。送り先の検査が通らなければ、手順2へ進む前に止まる。
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
    for (const fake of fakes) {
      fake.server.stop(true);
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  function serve(
    version: () => VersionReply,
    loginLocation?: () => string,
  ): FakeServer {
    const fake = serveFake(version, loginLocation);
    fakes.push(fake);
    return fake;
  }

  async function runBootstrap(
    env: Record<string, string>,
    options: { script?: string; args?: string[] } = {},
  ): Promise<{ code: number; output: string }> {
    const proc = Bun.spawn(
      [
        "bash",
        options.script ?? BOOTSTRAP,
        ...(options.args ?? ["custom-tags"]),
      ],
      {
        env: {
          PATH: `${join(tmp, "bin")}:${process.env.PATH ?? ""}`,
          HOME: tmp,
          WM_ADMIN_EMAIL: "admin@example.com",
          WM_ADMIN_PASSWORD: PASSWORD,
          // mise.tomlは両方を設定する。指定が無ければ、WM_HTTP_PORTと同じ宛先にする。
          ...(env.WM_HTTP_PORT === undefined
            ? {}
            : { WM_BASE_URL: `http://127.0.0.1:${env.WM_HTTP_PORT}` }),
          ...env,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, output: stdout + stderr };
  }

  function portOf(fake: FakeServer): string {
    return String(fake.server.port);
  }

  // スクリプトを一時ディレクトリへ複製し、隣に`wmill.yaml`を置いて、全手順のモードで動かす。
  // REPO_ROOTがスクリプトの親になるので、複製先の`wmill.yaml`が読まれる。
  async function runFull(
    env: Record<string, string>,
    wmillYaml: string | undefined,
    args: string[] = [],
  ): Promise<{ code: number; output: string }> {
    const scripts = join(tmp, "scripts");
    mkdirSync(scripts, { recursive: true });
    const script = join(scripts, "bootstrap.sh");
    copyFileSync(BOOTSTRAP, script);
    if (wmillYaml !== undefined) {
      writeFileSync(join(tmp, "wmill.yaml"), wmillYaml);
    }
    return runBootstrap(env, { script, args });
  }

  const yamlFor = (port: string): string =>
    `workspaces:\n  factory:\n    baseUrl: http://127.0.0.1:${port}\n    workspaceId: factory\n`;

  describe("when WM_BASE_URL disagrees with WM_HTTP_PORT", () => {
    test("sends nothing to the host that WM_BASE_URL names", async () => {
      const stray = serve(() => ({ status: 200, body: "CE v1.817.0" }));
      const windmill = serve(windmillVersion);

      await runBootstrap({
        WM_BASE_URL: `http://127.0.0.1:${portOf(stray)}`,
        WM_HTTP_PORT: portOf(windmill),
      });

      expect(stray.calls).toEqual([]);
    });

    test("logs in at the WM_HTTP_PORT host", async () => {
      const stray = serve(windmillVersion);
      const windmill = serve(windmillVersion);

      await runBootstrap({
        WM_BASE_URL: `http://127.0.0.1:${portOf(stray)}`,
        WM_HTTP_PORT: portOf(windmill),
      });

      expect(loginCalls(windmill)).toHaveLength(1);
    });
  });

  describe("on the normal path", () => {
    test("exits 0", async () => {
      const windmill = serve(windmillVersion);

      const { code } = await runBootstrap({ WM_HTTP_PORT: portOf(windmill) });

      expect(code).toBe(0);
    });

    test("checks the version before it logs in", async () => {
      const windmill = serve(windmillVersion);

      await runBootstrap({ WM_HTTP_PORT: portOf(windmill) });

      expect(windmill.calls.slice(0, 2)).toEqual([
        "GET /api/version",
        "POST /api/auth/login",
      ]);
    });

    test("accepts an EE version", async () => {
      const windmill = serve(() => ({ status: 200, body: "EE v1.817.0" }));

      const { code } = await runBootstrap({ WM_HTTP_PORT: portOf(windmill) });

      expect(code).toBe(0);
    });
  });

  describe("when the peer does not answer as Windmill", () => {
    const notWindmill: Array<[string, VersionReply]> = [
      ["an unrelated body", { status: 200, body: "hello" }],
      ["an empty body", { status: 200, body: "" }],
      ["an HTML body", { status: 200, body: "<html>CE v1</html>" }],
      ["a lowercase edition", { status: 200, body: "ce v1.817.0" }],
      ["a version without a digit", { status: 200, body: "CE v" }],
      ["a prefix before the edition", { status: 200, body: "x CE v1.0.0" }],
      ["a 204 status without a body", { status: 204, body: "" }],
      ["a 302 status with a Windmill body", { status: 302, body: "CE v1.0" }],
    ];

    for (const [name, reply] of notWindmill) {
      test(`does not log in for ${name}`, async () => {
        const peer = serve(() => reply);

        await runBootstrap({ WM_HTTP_PORT: portOf(peer) });

        expect(loginCalls(peer)).toEqual([]);
      });
    }

    for (const [name, reply] of notWindmill) {
      test(`reports the mismatch for ${name}`, async () => {
        const peer = serve(() => reply);

        const { output } = await runBootstrap({ WM_HTTP_PORT: portOf(peer) });

        expect(output).toContain("did not answer as Windmill");
      });
    }

    test("exits non-zero", async () => {
      const peer = serve(() => ({ status: 200, body: "hello" }));

      const { code } = await runBootstrap({ WM_HTTP_PORT: portOf(peer) });

      expect(code).toBe(1);
    });

    test("names the next step", async () => {
      const peer = serve(() => ({ status: 200, body: "hello" }));

      const { output } = await runBootstrap({ WM_HTTP_PORT: portOf(peer) });

      expect(output).toContain("set WM_HTTP_PORT");
    });

    test("does not print the password", async () => {
      const peer = serve(() => ({ status: 200, body: "hello" }));

      const { output } = await runBootstrap({ WM_HTTP_PORT: portOf(peer) });

      expect(output).not.toContain(PASSWORD);
    });

    test("does not echo the response body", async () => {
      const peer = serve(() => ({ status: 200, body: "secret-banner-text" }));

      const { output } = await runBootstrap({ WM_HTTP_PORT: portOf(peer) });

      expect(output).not.toContain("secret-banner-text");
    });
  });

  describe("when the peer answers with a server error", () => {
    const starting = (): VersionReply => ({
      status: 503,
      body: "CE v1.817.0",
    });

    test("does not log in", async () => {
      const peer = serve(starting);

      await runBootstrap({ WM_HTTP_PORT: portOf(peer) });

      expect(loginCalls(peer)).toEqual([]);
    });

    test("exits non-zero", async () => {
      const peer = serve(starting);

      const { code } = await runBootstrap({ WM_HTTP_PORT: portOf(peer) });

      expect(code).toBe(1);
    });

    test("says that Windmill may still be starting", async () => {
      const peer = serve(starting);

      const { output } = await runBootstrap({ WM_HTTP_PORT: portOf(peer) });

      expect(output).toContain("may still be starting");
    });

    test("tells the operator to wait and run again", async () => {
      const peer = serve(starting);

      const { output } = await runBootstrap({ WM_HTTP_PORT: portOf(peer) });

      expect(output).toContain("wait a few tens of seconds and run again");
    });

    test("still points at another process on the port", async () => {
      const peer = serve(starting);

      const { output } = await runBootstrap({ WM_HTTP_PORT: portOf(peer) });

      expect(output).toContain("another process is using port");
    });

    test("does not claim that another service answered", async () => {
      const peer = serve(starting);

      const { output } = await runBootstrap({ WM_HTTP_PORT: portOf(peer) });

      expect(output).not.toContain("did not answer as Windmill");
    });
  });

  describe("when the version response is huge", () => {
    // 4096バイトを超える本文は、読み切る前に打ち切る。
    const huge = (): VersionReply => ({
      status: 200,
      body: "",
      streamChunks: 800,
    });

    test("does not log in", async () => {
      const peer = serve(huge);

      await runBootstrap({ WM_HTTP_PORT: portOf(peer) });

      expect(loginCalls(peer)).toEqual([]);
    });

    test("reports the mismatch", async () => {
      const peer = serve(huge);

      const { output } = await runBootstrap({ WM_HTTP_PORT: portOf(peer) });

      expect(output).toContain("did not answer as Windmill");
    });

    test("stops reading long before the end of the body", async () => {
      const peer = serve(huge);

      await runBootstrap({ WM_HTTP_PORT: portOf(peer) });

      expect(peer.sentBytes()).toBeLessThan(8 * 1024 * 1024);
    });
  });

  describe("with proxy settings in the environment", () => {
    const proxyVariables = ["http_proxy", "all_proxy", "ALL_PROXY"];

    for (const variable of proxyVariables) {
      test(`does not route through ${variable}`, async () => {
        const proxy = serve(windmillVersion);
        const windmill = serve(windmillVersion);

        await runBootstrap({
          WM_HTTP_PORT: portOf(windmill),
          [variable]: `http://127.0.0.1:${portOf(proxy)}`,
        });

        expect(proxy.calls).toEqual([]);
      });
    }

    test("still logs in at the destination", async () => {
      const proxy = serve(windmillVersion);
      const windmill = serve(windmillVersion);

      await runBootstrap({
        WM_HTTP_PORT: portOf(windmill),
        http_proxy: `http://127.0.0.1:${portOf(proxy)}`,
      });

      expect(loginCalls(windmill)).toHaveLength(1);
    });
  });

  describe("when WM_HTTP_PORT is outside the port range", () => {
    const outOfRange = ["0", "65536", "99999", "08080"];

    for (const port of outOfRange) {
      test(`sends nothing for ${port}`, async () => {
        const windmill = serve(windmillVersion);

        await runBootstrap({
          WM_BASE_URL: `http://127.0.0.1:${portOf(windmill)}`,
          WM_HTTP_PORT: port,
        });

        expect(windmill.calls).toEqual([]);
      });

      test(`explains the range for ${port}`, async () => {
        const windmill = serve(windmillVersion);

        const { output } = await runBootstrap({
          WM_BASE_URL: `http://127.0.0.1:${portOf(windmill)}`,
          WM_HTTP_PORT: port,
        });

        expect(output).toContain("a port number from 1 to 65535");
      });

      test(`exits non-zero for ${port}`, async () => {
        const windmill = serve(windmillVersion);

        const { code } = await runBootstrap({
          WM_BASE_URL: `http://127.0.0.1:${portOf(windmill)}`,
          WM_HTTP_PORT: port,
        });

        expect(code).toBe(1);
      });
    }
  });

  describe("when wmill.yaml names another port", () => {
    test("sends nothing", async () => {
      const windmill = serve(windmillVersion);

      await runFull({ WM_HTTP_PORT: portOf(windmill) }, yamlFor("1"));

      expect(windmill.calls).toEqual([]);
    });

    test("exits non-zero", async () => {
      const windmill = serve(windmillVersion);

      const { code } = await runFull(
        { WM_HTTP_PORT: portOf(windmill) },
        yamlFor("1"),
      );

      expect(code).toBe(1);
    });

    test("names the file to fix", async () => {
      const windmill = serve(windmillVersion);

      const { output } = await runFull(
        { WM_HTTP_PORT: portOf(windmill) },
        yamlFor("1"),
      );

      expect(output).toContain("baseUrl in wmill.yaml");
    });

    test("tells the operator not to commit the change", async () => {
      const windmill = serve(windmillVersion);

      const { output } = await runFull(
        { WM_HTTP_PORT: portOf(windmill) },
        yamlFor("1"),
      );

      expect(output).toContain("do not commit");
    });

    test("stops when wmill.yaml has no baseUrl for the workspace", async () => {
      const windmill = serve(windmillVersion);

      await runFull(
        { WM_HTTP_PORT: portOf(windmill) },
        "workspaces:\n  factory:\n    workspaceId: factory\n",
      );

      expect(windmill.calls).toEqual([]);
    });

    test("skips the check for the custom-tags argument", async () => {
      const windmill = serve(windmillVersion);

      await runFull({ WM_HTTP_PORT: portOf(windmill) }, yamlFor("1"), [
        "custom-tags",
      ]);

      expect(loginCalls(windmill)).toHaveLength(1);
    });
  });

  describe("when wmill.yaml names another host on the same port", () => {
    const localhostYaml = (port: string): string =>
      `workspaces:\n  factory:\n    baseUrl: http://localhost:${port}\n    workspaceId: factory\n`;

    test("sends nothing", async () => {
      const windmill = serve(windmillVersion);

      await runFull(
        { WM_HTTP_PORT: portOf(windmill) },
        localhostYaml(portOf(windmill)),
      );

      expect(windmill.calls).toEqual([]);
    });

    test("tells the operator to set the whole URL", async () => {
      const windmill = serve(windmillVersion);

      const { output } = await runFull(
        { WM_HTTP_PORT: portOf(windmill) },
        localhostYaml(portOf(windmill)),
      );

      expect(output).toContain(
        `set it to http://127.0.0.1:${portOf(windmill)}`,
      );
    });
  });

  describe("when wmill.yaml cannot be read", () => {
    test("says that it could not be read when the file is missing", async () => {
      const windmill = serve(windmillVersion);

      const { output } = await runFull(
        { WM_HTTP_PORT: portOf(windmill) },
        undefined,
      );

      expect(output).toContain("could not read wmill.yaml");
    });

    test("sends nothing when the file is missing", async () => {
      const windmill = serve(windmillVersion);

      await runFull({ WM_HTTP_PORT: portOf(windmill) }, undefined);

      expect(windmill.calls).toEqual([]);
    });

    test("says that it could not be read when the file is malformed", async () => {
      const windmill = serve(windmillVersion);

      const { output } = await runFull(
        { WM_HTTP_PORT: portOf(windmill) },
        "workspaces: [unclosed\n  a: b",
      );

      expect(output).toContain("could not read wmill.yaml");
    });

    test("sends nothing when the file is malformed", async () => {
      const windmill = serve(windmillVersion);

      await runFull(
        { WM_HTTP_PORT: portOf(windmill) },
        "workspaces: [unclosed\n  a: b",
      );

      expect(windmill.calls).toEqual([]);
    });
  });

  describe("when wmill.yaml has no baseUrl", () => {
    const noBaseUrl = "workspaces:\n  factory:\n    workspaceId: factory\n";

    test("says that the baseUrl is unset", async () => {
      const windmill = serve(windmillVersion);

      const { output } = await runFull(
        { WM_HTTP_PORT: portOf(windmill) },
        noBaseUrl,
      );

      expect(output).toContain("baseUrl in wmill.yaml is unset");
    });

    test("does not say that the file could not be read", async () => {
      const windmill = serve(windmillVersion);

      const { output } = await runFull(
        { WM_HTTP_PORT: portOf(windmill) },
        noBaseUrl,
      );

      expect(output).not.toContain("could not read wmill.yaml");
    });

    test("tells the operator to set the whole URL", async () => {
      const windmill = serve(windmillVersion);

      const { output } = await runFull(
        { WM_HTTP_PORT: portOf(windmill) },
        noBaseUrl,
      );

      expect(output).toContain(
        `set it to http://127.0.0.1:${portOf(windmill)}`,
      );
    });
  });

  describe("when wmill.yaml names the same port", () => {
    test("logs in", async () => {
      const windmill = serve(windmillVersion);

      await runFull(
        { WM_HTTP_PORT: portOf(windmill) },
        yamlFor(portOf(windmill)),
      );

      expect(loginCalls(windmill)).toHaveLength(1);
    });
  });

  describe("when WM_HTTP_PORT is unusable", () => {
    test("stops before any request when it is not a number", async () => {
      const windmill = serve(windmillVersion);

      const { code } = await runBootstrap({
        WM_BASE_URL: `http://127.0.0.1:${portOf(windmill)}`,
        WM_HTTP_PORT: "80;echo",
      });

      expect(code).toBe(1);
    });

    test("sends nothing to WM_BASE_URL when it is not a number", async () => {
      const windmill = serve(windmillVersion);

      await runBootstrap({
        WM_BASE_URL: `http://127.0.0.1:${portOf(windmill)}`,
        WM_HTTP_PORT: "80;echo",
      });

      expect(windmill.calls).toEqual([]);
    });

    test("stops when it is unset", async () => {
      const windmill = serve(windmillVersion);

      const { code } = await runBootstrap({
        WM_BASE_URL: `http://127.0.0.1:${portOf(windmill)}`,
      });

      expect(code).toBe(1);
    });

    test("sends nothing to WM_BASE_URL when it is unset", async () => {
      const windmill = serve(windmillVersion);

      await runBootstrap({
        WM_BASE_URL: `http://127.0.0.1:${portOf(windmill)}`,
      });

      expect(windmill.calls).toEqual([]);
    });
  });

  describe("with redirects", () => {
    // curlの既定の設定が`location`でも、リダイレクトを追わないことを確かめる。
    beforeEach(() => {
      writeFileSync(join(tmp, ".curlrc"), "location\nlocation-trusted\n");
    });

    test("does not follow a redirect from the version check", async () => {
      const elsewhere = serve(windmillVersion);
      const peer = serve(() => ({
        status: 302,
        body: "",
        location: `http://127.0.0.1:${portOf(elsewhere)}/api/version`,
      }));

      await runBootstrap({ WM_HTTP_PORT: portOf(peer) });

      expect(elsewhere.calls).toEqual([]);
    });

    test("does not log in after a redirect from the version check", async () => {
      const elsewhere = serve(windmillVersion);
      const peer = serve(() => ({
        status: 301,
        body: "",
        location: `http://127.0.0.1:${portOf(elsewhere)}/api/version`,
      }));

      await runBootstrap({ WM_HTTP_PORT: portOf(peer) });

      expect(loginCalls(peer)).toEqual([]);
    });

    test("does not forward the credentials when the login redirects", async () => {
      const elsewhere = serve(windmillVersion);
      const peer = serve(
        windmillVersion,
        () => `http://127.0.0.1:${portOf(elsewhere)}/api/auth/login`,
      );

      await runBootstrap({ WM_HTTP_PORT: portOf(peer) });

      expect(elsewhere.calls).toEqual([]);
    });
  });
});
