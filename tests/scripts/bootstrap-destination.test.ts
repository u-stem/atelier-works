import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
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
}

interface VersionReply {
  status: number;
  body: string;
  location?: string;
}

// `/api/version`の応答を差し替えられる偽のWindmill。
function serveFake(
  version: () => VersionReply,
  loginLocation?: () => string,
): FakeServer {
  const calls: string[] = [];
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
  return { server, calls };
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
  ): Promise<{ code: number; output: string }> {
    const proc = Bun.spawn(["bash", BOOTSTRAP, "custom-tags"], {
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
    });
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
      ["an error status", { status: 500, body: "CE v1.817.0" }],
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
