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
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../../scripts/doctor.sh");
const BASH = Bun.which("bash") ?? "bash";

// このファイルのテストは、どれもdoctor.shの全項目をbashの子プロセスで走らせ、
// カスタムtagの検査では本物のbunの起動も挟む。手元で約0.5秒でも、CIの負荷で
// 伸びてbunの既定の5秒を超えることがあるため、このファイルだけ30秒にする。
setDefaultTimeout(30_000);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "doctor-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Fake = {
  // Console用workerのコンテナID。undefinedならコンテナが無い。
  consoleId: string | undefined;
  // `docker inspect -f '{{.State.Running}}'`が返す値。
  running: boolean;
  // `compose exec`の判定の終了コード。11はボリューム全体がマウントされていない、10はマウントされている、
  // 3はマウント先が見えない。それ以外はcomposeやshellの失敗。
  execStatus: number;
  // `docker version`が返すEngineのAPI版。
  apiVersion: string;
};

const defaults: Fake = {
  consoleId: "abc123",
  running: true,
  execStatus: 11,
  apiVersion: "1.47",
};

// 本物のdockerではなく、版とコンテナの状態を固定して返す偽のdockerをPATHの先頭に置く。
// `compose exec`は、doctorが固定の引数を1回で渡したときだけ設定した終了コードで終わる。
const PROBE =
  "test -e /var/lib/factory/claude || test -e /var/lib/factory/gh || test -e /var/lib/factory/audits && exit 10; test -d /var/lib/factory/requirements || exit 3; test -e /var/lib/factory/requirements/requirements && exit 10; exit 11";

function installFakeDocker(overrides: Partial<Fake>): void {
  const fake = { ...defaults, ...overrides };
  const body = [
    "#!/bin/sh",
    'case "$1" in',
    "  info) exit 0 ;;",
    `  version) echo ${fake.apiVersion} ;;`,
    "  compose)",
    '    case "$2" in',
    "      version) echo 2.40.0 ;;",
    "      *)",
    '        if [ "$4" = ps ] && [ "$6" = windmill_worker_console ]; then',
    ...(fake.consoleId === undefined
      ? []
      : [`          echo '${fake.consoleId}'`]),
    '        elif [ "$4" = ps ]; then',
    "          :",
    '        elif [ "$4" = exec ] && [ "$5" = -T ] && [ "$6" = windmill_worker_console ] \\',
    '          && [ "$7" = sh ] && [ "$8" = -c ] \\',
    `          && [ "$9" = '${PROBE}' ] && [ "$#" = 9 ]; then`,
    `          exit ${fake.execStatus}`,
    "        else",
    "          exit 99",
    "        fi",
    "        ;;",
    "    esac",
    "    ;;",
    "  inspect)",
    '    if [ "$2" = "-f" ]; then',
    `      echo ${fake.running}`,
    "    else",
    "      exit 3",
    "    fi",
    "    ;;",
    "  *) exit 2 ;;",
    "esac",
    "",
  ].join("\n");
  const path = join(dir, "docker");
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function doctorLine(label: string): string {
  const result = Bun.spawnSync([BASH, SCRIPT], {
    env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir },
  });
  const line = result.stdout
    .toString()
    .split("\n")
    .find((l) => l.includes(label));
  return line ?? "";
}

describe("doctor.sh Console worker mount", () => {
  test("reports OK when the probe exits 11", () => {
    installFakeDocker({ execStatus: 11 });

    expect(doctorLine("console worker mount")).toMatch(
      /^\s+OK\s.*ボリューム全体はマウントされていません/,
    );
  });

  test("reports NG when the probe exits 10", () => {
    installFakeDocker({ execStatus: 10 });

    expect(doctorLine("console worker mount")).toMatch(/^\s+NG\s/);
  });

  test("reports NG with the exit code when the probe exits 3", () => {
    installFakeDocker({ execStatus: 3 });

    expect(doctorLine("console worker mount")).toMatch(
      /^\s+NG\s.*終了コード: 3/,
    );
  });

  test("reports OK as unverifiable when the probe exits 1", () => {
    installFakeDocker({ execStatus: 1 });

    expect(doctorLine("console worker mount")).toMatch(
      /^\s+OK\s.*確かめられません/,
    );
  });

  test("reports OK as unverifiable when the probe exits 126", () => {
    installFakeDocker({ execStatus: 126 });

    expect(doctorLine("console worker mount")).toMatch(
      /^\s+OK\s.*確かめられません/,
    );
  });

  test("reports OK as unverifiable when the probe exits 127", () => {
    installFakeDocker({ execStatus: 127 });

    expect(doctorLine("console worker mount")).toMatch(
      /^\s+OK\s.*確かめられません/,
    );
  });

  test("reports OK as unverifiable when the container does not exist", () => {
    installFakeDocker({ consoleId: undefined });

    expect(doctorLine("console worker mount")).toMatch(
      /^\s+OK\s.*確かめられません/,
    );
  });

  test("reports OK as unverifiable when the container is not running", () => {
    installFakeDocker({ running: false, execStatus: 10 });

    expect(doctorLine("console worker mount")).toMatch(
      /^\s+OK\s.*確かめられません/,
    );
  });
});

describe("doctor.sh Docker version check", () => {
  test("reports NG when the Engine API is older than 1.45", () => {
    installFakeDocker({ apiVersion: "1.44" });

    expect(doctorLine("docker version")).toMatch(/^\s+NG\s/);
  });
});

describe("doctor.sh custom tag check", () => {
  const ADMIN_EMAIL = "admin@example.com";
  const ADMIN_PASSWORD = "correct-horse-battery";

  interface Windmill {
    server: ReturnType<typeof Bun.serve>;
    calls: string[];
  }

  // 死活の確認にも使う偽のWindmill。管理者の資格情報が合うときだけログインを通す。
  function startWindmill(tags: string[]): Windmill {
    const calls: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        calls.push(`${request.method} ${url.pathname}`);
        if (url.pathname === "/api/version") {
          return new Response("CE v1.817.0");
        }
        if (url.pathname === "/api/auth/login") {
          const body: unknown = await request.json();
          const accepted =
            typeof body === "object" &&
            body !== null &&
            "email" in body &&
            "password" in body &&
            body.email === ADMIN_EMAIL &&
            body.password === ADMIN_PASSWORD;
          return accepted
            ? new Response("session-token")
            : new Response("denied", { status: 401 });
        }
        if (url.pathname === "/api/workers/custom_tags") {
          return Response.json(tags);
        }
        return new Response("ok");
      },
    });
    return { server, calls };
  }

  // 他のローカルプロセスを模す。呼ばれた経路を記録する。
  function startDecoy(): Windmill {
    const calls: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        calls.push(`${request.method} ${new URL(request.url).pathname}`);
        return new Response("CE v1.817.0");
      },
    });
    return { server, calls };
  }

  // `mise exec -- <command>`を、そのまま実行する偽のmise。
  // bunは本物へのリンクにするか、与えられた本文のスクリプトにする。
  function installFakeMise(bunBody?: string): void {
    const mise = join(dir, "mise");
    writeFileSync(
      mise,
      [
        "#!/bin/sh",
        'case "$1" in',
        '  exec) shift; [ "$1" = -- ] && shift; exec "$@" ;;',
        "  --version) echo 2026.1.0 ;;",
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(mise, 0o755);
    const bun = join(dir, "bun");
    if (bunBody === undefined) {
      symlinkSync(process.execPath, bun);
    } else {
      writeFileSync(bun, `#!/bin/sh\n${bunBody}\n`);
      chmodSync(bun, 0o755);
    }
  }

  async function tagLines(env: Record<string, string>): Promise<string[]> {
    const proc = Bun.spawn([BASH, SCRIPT], {
      env: {
        PATH: `${dir}:/usr/bin:/bin`,
        HOME: dir,
        WM_ADMIN_EMAIL: ADMIN_EMAIL,
        WM_ADMIN_PASSWORD: ADMIN_PASSWORD,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    return stdout.split("\n").filter((l) => l.includes("カスタムtag"));
  }

  async function tagLine(env: Record<string, string>): Promise<string> {
    return (await tagLines(env))[0] ?? "";
  }

  function lineFor(lines: string[], tag: string): string {
    return lines.find((l) => l.includes(tag)) ?? "";
  }

  test("reports OK when the instance allows console", async () => {
    installFakeMise();
    const windmill = startWindmill(["chromium", "console"]);

    const line = await tagLine({ WM_HTTP_PORT: String(windmill.server.port) });

    windmill.server.stop(true);
    expect(line).toMatch(/^\s+OK\s.*consoleが許可されています/);
  });

  test("reports NG when the instance does not allow console", async () => {
    installFakeMise();
    const windmill = startWindmill(["chromium"]);

    const line = await tagLine({ WM_HTTP_PORT: String(windmill.server.port) });

    windmill.server.stop(true);
    expect(line).toMatch(/^\s+NG\s.*consoleが許可されていません/);
  });

  test("reports OK when the instance allows periodic", async () => {
    installFakeMise();
    const windmill = startWindmill(["chromium", "console", "periodic"]);

    const lines = await tagLines({
      WM_HTTP_PORT: String(windmill.server.port),
    });

    windmill.server.stop(true);
    expect(lineFor(lines, "periodic")).toMatch(
      /^\s+OK\s.*periodicが許可されています/,
    );
  });

  test("reports NG when the instance allows console but not periodic", async () => {
    installFakeMise();
    const windmill = startWindmill(["chromium", "console"]);

    const lines = await tagLines({
      WM_HTTP_PORT: String(windmill.server.port),
    });

    windmill.server.stop(true);
    expect(lineFor(lines, "periodic")).toMatch(
      /^\s+NG\s.*periodicが許可されていません/,
    );
  });

  test("sends the credentials to the port it probed, not to WM_BASE_URL", async () => {
    installFakeMise();
    const windmill = startWindmill(["console"]);
    const decoy = startDecoy();

    await tagLine({
      WM_HTTP_PORT: String(windmill.server.port),
      WM_BASE_URL: `http://127.0.0.1:${decoy.server.port}`,
    });

    windmill.server.stop(true);
    decoy.server.stop(true);
    expect(decoy.calls).toEqual([]);
  });

  test("reports WARN, not NG, when the check crashes with exit 1", async () => {
    installFakeMise("echo 'error: boom' >&2; exit 1");
    const windmill = startWindmill(["chromium"]);

    const line = await tagLine({ WM_HTTP_PORT: String(windmill.server.port) });

    windmill.server.stop(true);
    expect(line).toMatch(/^\s+WARN\s/);
  });

  test("shows the first line of stderr in the WARN", async () => {
    installFakeMise("echo 'error: boom' >&2; echo 'second' >&2; exit 1");
    const windmill = startWindmill(["chromium"]);

    const line = await tagLine({ WM_HTTP_PORT: String(windmill.server.port) });

    windmill.server.stop(true);
    expect(line).toContain("error: boom");
  });

  test("shows only the first line of stderr in the WARN", async () => {
    installFakeMise("echo 'error: boom' >&2; echo 'second line' >&2; exit 1");
    const windmill = startWindmill(["chromium"]);

    const line = await tagLine({ WM_HTTP_PORT: String(windmill.server.port) });

    windmill.server.stop(true);
    expect(line).not.toContain("second line");
  });

  test("masks the admin password in the WARN", async () => {
    installFakeMise(`echo "failed with ${ADMIN_PASSWORD}" >&2; exit 1`);
    const windmill = startWindmill(["chromium"]);

    const line = await tagLine({ WM_HTTP_PORT: String(windmill.server.port) });

    windmill.server.stop(true);
    expect(line).not.toContain(ADMIN_PASSWORD);
  });

  test("masks the admin password that straddles the 200th character", async () => {
    const padding = "x".repeat(190);
    installFakeMise(`echo "${padding}${ADMIN_PASSWORD}" >&2; exit 1`);
    const windmill = startWindmill(["chromium"]);

    const line = await tagLine({ WM_HTTP_PORT: String(windmill.server.port) });

    windmill.server.stop(true);
    expect(line).not.toContain(ADMIN_PASSWORD.slice(0, 8));
  });

  test("explains a refused login in the WARN", async () => {
    installFakeMise();
    const windmill = startWindmill(["console"]);

    const line = await tagLine({
      WM_HTTP_PORT: String(windmill.server.port),
      WM_ADMIN_PASSWORD: "a-different-password",
    });

    windmill.server.stop(true);
    expect(line).toMatch(/^\s+WARN\s.*login was refused \(status 401\)/);
  });
});

describe("doctor.sh read-only token check", () => {
  const PAT_ONE = "github_pat_ONEVALUE0123456789abcdef";
  const PAT_TWO = "github_pat_TWOVALUE0123456789abcdef";

  function tokenLines(env: Record<string, string>): string[] {
    const result = Bun.spawnSync([BASH, SCRIPT], {
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, ...env },
    });
    return result.stdout
      .toString()
      .split("\n")
      .filter((l) => l.includes("読み取りトークン"));
  }

  function output(env: Record<string, string>): string {
    const result = Bun.spawnSync([BASH, SCRIPT], {
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, ...env },
    });
    return result.stdout.toString() + result.stderr.toString();
  }

  test("warns, not fails, when no token variable is set", () => {
    expect(tokenLines({})[0]).toMatch(/^\s+WARN\s.*GITHUB_READ_TOKEN_<OWNER>/);
  });

  test("warns when every token variable is empty", () => {
    expect(tokenLines({ GITHUB_READ_TOKEN_ACME: "" })[0]).toMatch(/^\s+WARN\s/);
  });

  test("reports OK when a token variable has a value", () => {
    expect(tokenLines({ GITHUB_READ_TOKEN_ACME: PAT_ONE })[0]).toMatch(
      /^\s+OK\s.*1件/,
    );
  });

  test("counts every owner that has a value", () => {
    expect(
      tokenLines({
        GITHUB_READ_TOKEN_ACME: PAT_ONE,
        GITHUB_READ_TOKEN_OCTO: PAT_TWO,
        GITHUB_READ_TOKEN_EMPTY: "",
      })[0],
    ).toMatch(/^\s+OK\s.*2件/);
  });

  test("warns about a name that is not a login, with the name only", () => {
    const lines = tokenLines({
      GITHUB_READ_TOKEN_ACME: PAT_ONE,
      GITHUB_READ_TOKEN_A__B: PAT_TWO,
    });
    expect(lines.find((line) => line.includes("WARN"))).toContain(
      "GITHUB_READ_TOKEN_A__B",
    );
  });

  test("warns about names that collide, with both names", () => {
    const lines = tokenLines({
      GITHUB_READ_TOKEN_Acme: PAT_ONE,
      GITHUB_READ_TOKEN_ACME: PAT_TWO,
    });
    const warning = lines.find((line) => line.includes("WARN")) ?? "";
    expect(
      ["GITHUB_READ_TOKEN_Acme", "GITHUB_READ_TOKEN_ACME"].filter(
        (name) => !warning.includes(name),
      ),
    ).toEqual([]);
  });

  test("does not count an empty variable as a collision", () => {
    expect(
      tokenLines({
        GITHUB_READ_TOKEN_Acme: "",
        GITHUB_READ_TOKEN_ACME: PAT_ONE,
      }).filter((line) => line.includes("WARN")),
    ).toEqual([]);
  });

  test("never prints a token value", () => {
    expect(
      output({
        GITHUB_READ_TOKEN_ACME: PAT_ONE,
        GITHUB_READ_TOKEN_Octo: PAT_TWO,
        GITHUB_READ_TOKEN_OCTO: PAT_TWO,
        GITHUB_READ_TOKEN_A__B: PAT_ONE,
      }),
    ).not.toMatch(/ONEVALUE|TWOVALUE/);
  });

  test("does not add a failure", () => {
    expect(output({})).not.toMatch(/NG\s+読み取りトークン/);
  });
});

describe("doctor.sh owners that the collection cannot handle", () => {
  const ADMIN_EMAIL = "admin@example.com";
  const ADMIN_PASSWORD = "correct-horse-battery";

  function startWindmill(config: unknown, status = 200) {
    return Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/version") {
          return new Response("CE v1.817.0");
        }
        if (url.pathname === "/api/auth/login") {
          return new Response("session-token");
        }
        if (url.pathname.startsWith("/api/w/factory/resources/get_value/")) {
          return Response.json(config, { status });
        }
        if (url.pathname === "/api/workers/custom_tags") {
          return Response.json(["console", "periodic"]);
        }
        return new Response("ok");
      },
    });
  }

  function installFakeMise(): void {
    const mise = join(dir, "mise");
    writeFileSync(
      mise,
      [
        "#!/bin/sh",
        'case "$1" in',
        '  exec) shift; [ "$1" = -- ] && shift; exec "$@" ;;',
        "  --version) echo 2026.1.0 ;;",
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(mise, 0o755);
    symlinkSync(process.execPath, join(dir, "bun"));
  }

  async function ownerLines(port: number): Promise<string[]> {
    const proc = Bun.spawn([BASH, SCRIPT], {
      env: {
        PATH: `${dir}:/usr/bin:/bin`,
        HOME: dir,
        WM_HTTP_PORT: String(port),
        WM_ADMIN_EMAIL: ADMIN_EMAIL,
        WM_ADMIN_PASSWORD: ADMIN_PASSWORD,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    return stdout.split("\n").filter((l) => l.includes("収集の対象外"));
  }

  test("warns with the name of an owner whose login has an underscore", async () => {
    installFakeMise();
    const server = startWindmill({
      owners: [{ name: "acme" }, { name: "emu_user" }],
    });

    const lines = await ownerLines(server.port ?? 0);

    server.stop(true);
    expect(lines[0]).toMatch(/^\s+WARN\s.*emu_user/);
  });

  test("does not mention an owner whose login has no underscore", async () => {
    installFakeMise();
    const server = startWindmill({
      owners: [{ name: "acme" }, { name: "emu_user" }],
    });

    const lines = await ownerLines(server.port ?? 0);

    server.stop(true);
    expect(lines.join("\n")).not.toContain("acme");
  });

  test("says nothing when every login is plain", async () => {
    installFakeMise();
    const server = startWindmill({ owners: [{ name: "acme" }] });

    const lines = await ownerLines(server.port ?? 0);

    server.stop(true);
    expect(lines).toEqual([]);
  });

  test("says nothing when the config cannot be read", async () => {
    installFakeMise();
    const server = startWindmill({ message: "not found" }, 404);

    const lines = await ownerLines(server.port ?? 0);

    server.stop(true);
    expect(lines).toEqual([]);
  });

  test("does not print the admin password", async () => {
    installFakeMise();
    const server = startWindmill({ owners: [{ name: "emu_user" }] });

    const lines = await ownerLines(server.port ?? 0);

    server.stop(true);
    expect(lines.join("\n")).not.toContain(ADMIN_PASSWORD);
  });
});
