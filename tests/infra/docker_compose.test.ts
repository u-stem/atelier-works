import { describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Console用workerの構成を静的に確かめる。
// 書き込めるマウントをworker_logsと専用の依存キャッシュに限ること、
// factory_workspacesを共有しないこと、factory_stateのボリューム全体ではなく
// requirementsのサブパスだけを読み取り専用で付けることが境界の要なので、
// composeの編集で崩れたらここで落とす。
const REPO_ROOT = join(import.meta.dir, "../..");

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function compose(): Json {
  const parsed: unknown = Bun.YAML.parse(
    readFileSync(join(REPO_ROOT, "infra/docker-compose.yml"), "utf8"),
  );
  return isRecord(parsed) ? parsed : {};
}

function service(name: string): Json {
  const parsed = compose();
  if (!isRecord(parsed.services)) return {};
  const found = parsed.services[name];
  return isRecord(found) ? found : {};
}

function stringList(svc: Json, key: string): string[] {
  const value = svc[key];
  if (value === undefined) return [];
  // map形式などの配列でない値は、否定形のテストが空振りしないよう拒否する。
  if (!isStringArray(value)) throw new Error(`${key} must be a string array`);
  return value;
}

type Mount = {
  source: string;
  target: string;
  readOnly: boolean;
  subpath: string | undefined;
};

function parseMount(entry: unknown): Mount {
  if (typeof entry === "string") {
    // 短い書式: <source>:<target>[:<opts>]
    const [source = "", target = "", opts = ""] = entry.split(":");
    return {
      source,
      target,
      readOnly: opts.split(",").includes("ro"),
      subpath: undefined,
    };
  }
  if (isRecord(entry)) {
    // 長い書式: subpathは`volume`の下にある。
    const volume = isRecord(entry.volume) ? entry.volume : {};
    return {
      source: typeof entry.source === "string" ? entry.source : "",
      target: typeof entry.target === "string" ? entry.target : "",
      readOnly: entry.read_only === true,
      subpath: typeof volume.subpath === "string" ? volume.subpath : undefined,
    };
  }
  throw new Error("a volume entry must be a string or a map");
}

// 短い書式と長い書式の両方を同じ形に直す。
// 長い書式を文字列として読むと、否定形のテストが空振りするため。
function mounts(svc: Json): Mount[] {
  const value = svc.volumes;
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("volumes must be an array");
  return value.map(parseMount);
}

function mountsOf(svc: Json, source: string): Mount[] {
  return mounts(svc).filter((m) => m.source === source);
}

// `factory_state_init`のscriptを、`/var/lib/factory`を一時ディレクトリに差し替えて実際に動かす。
function initScript(): string {
  const entrypoint = service("factory_state_init").entrypoint;
  if (!isStringArray(entrypoint) || entrypoint.length !== 3) {
    throw new Error("entrypoint must be [sh, -c, script]");
  }
  return entrypoint[2] ?? "";
}

function runInit(root: string) {
  const script = initScript().replaceAll("/var/lib/factory", root);
  const result = Bun.spawnSync(["sh", "-c", script], { env: {} });
  return { exitCode: result.exitCode, stderr: result.stderr.toString() };
}

function withRoot<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "factory-state-init-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function envEntries(svc: Json, prefix: string): string[] {
  return stringList(svc, "environment").filter((e) => e.startsWith(prefix));
}

function limits(svc: Json): Json {
  const deploy = svc.deploy;
  if (!isRecord(deploy) || !isRecord(deploy.resources)) return {};
  return isRecord(deploy.resources.limits) ? deploy.resources.limits : {};
}

describe("infra/docker-compose.yml windmill_worker_console", () => {
  test("is defined as a service", () => {
    const svc = service("windmill_worker_console");

    expect(Object.keys(svc).length).toBeGreaterThan(0);
  });

  test("uses the upstream windmill image pinned by WM_VERSION", () => {
    const svc = service("windmill_worker_console");

    expect(svc.image).toStartWith(
      "ghcr.io/windmill-labs/windmill:${WM_VERSION",
    );
  });

  test("uses the same image as the native worker", () => {
    const svc = service("windmill_worker_console");
    const native = service("windmill_worker_native");

    expect(svc.image).toBe(native.image);
  });

  test("runs in worker mode", () => {
    const svc = service("windmill_worker_console");

    expect(stringList(svc, "environment")).toContain("MODE=worker");
  });

  test("belongs to the console worker group", () => {
    const svc = service("windmill_worker_console");

    expect(envEntries(svc, "WORKER_GROUP=")).toEqual(["WORKER_GROUP=console"]);
  });

  test("accepts only the console tag", () => {
    const svc = service("windmill_worker_console");

    expect(envEntries(svc, "WORKER_TAGS=")).toEqual(["WORKER_TAGS=console"]);
  });

  test("runs two worker processes", () => {
    const svc = service("windmill_worker_console");

    expect(envEntries(svc, "NUM_WORKERS=")).toEqual(["NUM_WORKERS=2"]);
  });

  test("connects to the database like the other workers", () => {
    const svc = service("windmill_worker_console");
    const native = service("windmill_worker_native");
    const dbUrl = (s: Json) =>
      stringList(s, "environment").filter((e) => e.startsWith("DATABASE_URL="));

    expect(dbUrl(svc)).toEqual(dbUrl(native));
  });

  test("limits memory to 1024M", () => {
    const svc = service("windmill_worker_console");

    expect(limits(svc).memory).toBe("1024M");
  });

  test("limits processes to 256", () => {
    const svc = service("windmill_worker_console");

    expect(limits(svc).pids).toBe(256);
  });

  test("runs an init process", () => {
    const svc = service("windmill_worker_console");

    expect(svc.init).toBe(true);
  });

  test("forbids gaining privileges", () => {
    const svc = service("windmill_worker_console");

    expect(stringList(svc, "security_opt")).toContain("no-new-privileges:true");
  });

  test("is not privileged", () => {
    const svc = service("windmill_worker_console");

    expect(svc.privileged).toBeUndefined();
  });

  test("mounts factory_console read-only at /srv/console", () => {
    const svc = service("windmill_worker_console");

    expect(mountsOf(svc, "factory_console")).toEqual([
      {
        source: "factory_console",
        target: "/srv/console",
        readOnly: true,
        subpath: undefined,
      },
    ]);
  });

  test("mounts exactly one factory_state path", () => {
    const svc = service("windmill_worker_console");

    expect(mountsOf(svc, "factory_state")).toHaveLength(1);
  });

  test("does not mount the factory_state root", () => {
    const svc = service("windmill_worker_console");

    expect(
      mountsOf(svc, "factory_state").filter(
        (m) => m.subpath === undefined || m.target === "/var/lib/factory",
      ),
    ).toEqual([]);
  });

  test("mounts the factory_state requirements subpath read-only at the same path", () => {
    const svc = service("windmill_worker_console");

    expect(mountsOf(svc, "factory_state")).toEqual([
      {
        source: "factory_state",
        target: "/var/lib/factory/requirements",
        readOnly: true,
        subpath: "requirements",
      },
    ]);
  });

  test("mounts worker_logs like the native worker", () => {
    const svc = service("windmill_worker_console");

    expect(mountsOf(svc, "worker_logs").map((m) => m.target)).toEqual([
      "/tmp/windmill/logs",
    ]);
  });

  test("does not mount factory_workspaces", () => {
    const svc = service("windmill_worker_console");

    expect(mountsOf(svc, "factory_workspaces")).toEqual([]);
  });

  test("does not share worker_dependency_cache", () => {
    const svc = service("windmill_worker_console");

    expect(mountsOf(svc, "worker_dependency_cache")).toEqual([]);
  });

  test("does not mount the docker socket", () => {
    const svc = service("windmill_worker_console");

    expect(mounts(svc).filter((m) => m.source.includes("docker.sock"))).toEqual(
      [],
    );
  });

  test("mounts its own dependency cache", () => {
    const svc = service("windmill_worker_console");

    expect(
      mountsOf(svc, "worker_console_dependency_cache").map((m) => m.target),
    ).toEqual(["/tmp/windmill/cache"]);
  });

  test("declares its dependency cache as a top-level volume", () => {
    const volumes = compose().volumes;

    expect(
      isRecord(volumes) && "worker_console_dependency_cache" in volumes,
    ).toBe(true);
  });

  test("mounts nothing writable other than worker_logs and its own cache", () => {
    const svc = service("windmill_worker_console");

    const writable = mounts(svc).filter(
      (m) =>
        !m.readOnly &&
        m.source !== "worker_logs" &&
        m.source !== "worker_console_dependency_cache",
    );

    expect(writable).toEqual([]);
  });

  test("default worker does not mount factory_console", () => {
    const defaultWorker = service("windmill_worker");

    expect(mountsOf(defaultWorker, "factory_console")).toEqual([]);
  });

  test("waits for factory_state_init to complete successfully", () => {
    const svc = service("windmill_worker_console");
    const dependsOn = isRecord(svc.depends_on) ? svc.depends_on : {};

    expect(dependsOn.factory_state_init).toEqual({
      condition: "service_completed_successfully",
    });
  });
});

describe("infra/docker-compose.yml factory_state_init", () => {
  test("uses the same image as the console worker", () => {
    const svc = service("factory_state_init");
    const consoleWorker = service("windmill_worker_console");

    expect(svc.image).toBe(consoleWorker.image);
  });

  test("runs a fixed sh -c script", () => {
    const svc = service("factory_state_init");

    expect(svc.entrypoint).toEqual([
      "sh",
      "-c",
      expect.stringContaining("mkdir -p -m 0755 /var/lib/factory/requirements"),
    ]);
  });

  test("does not expand variables in the script", () => {
    expect(initScript()).not.toMatch(/[$`]/);
  });

  test("fails when requirements is a symlink", () => {
    expect(
      withRoot((root) => {
        symlinkSync(root, join(root, "requirements"));
        return runInit(root).exitCode;
      }),
    ).toBe(1);
  });

  test("says that requirements is a symlink", () => {
    expect(
      withRoot((root) => {
        symlinkSync(root, join(root, "requirements"));
        return runInit(root).stderr;
      }),
    ).toContain("is a symlink");
  });

  test("leaves the symlink as it is", () => {
    expect(
      withRoot((root) => {
        symlinkSync(root, join(root, "requirements"));
        runInit(root);
        return lstatSync(join(root, "requirements")).isSymbolicLink();
      }),
    ).toBe(true);
  });

  test("creates requirements with mode 0755 when it is missing", () => {
    expect(
      withRoot((root) => {
        runInit(root);
        return statSync(join(root, "requirements")).mode & 0o777;
      }),
    ).toBe(0o755);
  });

  test("succeeds when requirements already exists", () => {
    expect(
      withRoot((root) => {
        mkdirSync(join(root, "requirements"));
        return runInit(root).exitCode;
      }),
    ).toBe(0);
  });

  test("mounts only factory_state", () => {
    const svc = service("factory_state_init");

    expect(mounts(svc).map((m) => m.source)).toEqual(["factory_state"]);
  });

  test("mounts the factory_state root writable", () => {
    const svc = service("factory_state_init");

    expect(mounts(svc)).toEqual([
      {
        source: "factory_state",
        target: "/var/lib/factory",
        readOnly: false,
        subpath: undefined,
      },
    ]);
  });

  test("has no network", () => {
    const svc = service("factory_state_init");

    expect(svc.network_mode).toBe("none");
  });

  test("drops all capabilities", () => {
    const svc = service("factory_state_init");

    expect(stringList(svc, "cap_drop")).toEqual(["ALL"]);
  });

  test("forbids gaining privileges", () => {
    const svc = service("factory_state_init");

    expect(stringList(svc, "security_opt")).toContain("no-new-privileges:true");
  });

  test("has a read-only root filesystem", () => {
    const svc = service("factory_state_init");

    expect(svc.read_only).toBe(true);
  });

  test("is not restarted after it exits", () => {
    const svc = service("factory_state_init");

    expect(svc.restart).toBe("no");
  });

  test("is not privileged", () => {
    const svc = service("factory_state_init");

    expect(svc.privileged).toBeUndefined();
  });
});

// 検査コマンドをworker内で非特権のuidに落として動かすための構成を確かめる。
// 落とさないケーパビリティが欠けると、worktreeの所有権の受け渡しや`setpriv`が動かなくなる。
describe("infra/docker-compose.yml windmill_worker check sandbox", () => {
  const NEEDED_BY_THE_SANDBOX = [
    "CHOWN",
    "DAC_OVERRIDE",
    "FOWNER",
    "SETUID",
    "SETGID",
    "SETPCAP",
    "KILL",
  ];

  test("passes the check uid to the image build", () => {
    const build = service("windmill_worker").build;
    const args = isRecord(build) && isRecord(build.args) ? build.args : {};

    expect(args.FACTORY_CHECK_UID).toBe("${FACTORY_CHECK_UID:?run via mise}");
  });

  test("drops the capabilities no job of the worker uses", () => {
    expect(stringList(service("windmill_worker"), "cap_drop")).toEqual([
      "NET_RAW",
      "MKNOD",
      "SETFCAP",
      "AUDIT_WRITE",
    ]);
  });

  test("keeps the capabilities the check sandbox needs", () => {
    const dropped = stringList(service("windmill_worker"), "cap_drop");

    expect(
      NEEDED_BY_THE_SANDBOX.filter((cap) => dropped.includes(cap)),
    ).toEqual([]);
  });

  test("does not drop every capability", () => {
    expect(stringList(service("windmill_worker"), "cap_drop")).not.toContain(
      "ALL",
    );
  });

  test("still forbids gaining privileges", () => {
    expect(stringList(service("windmill_worker"), "security_opt")).toContain(
      "no-new-privileges:true",
    );
  });

  test("is not privileged", () => {
    expect(service("windmill_worker").privileged).toBeUndefined();
  });

  test("does not mount the docker socket", () => {
    expect(
      mounts(service("windmill_worker")).filter((m) =>
        m.source.includes("docker.sock"),
      ),
    ).toEqual([]);
  });

  test("the verification script drops the same capabilities as the worker", () => {
    const script = readFileSync(
      join(REPO_ROOT, "scripts/verify-check-sandbox.sh"),
      "utf8",
    );
    const listed = /^CAP_DROP=\(([^)]*)\)$/m.exec(script)?.[1]?.split(/\s+/);

    expect(listed).toEqual(stringList(service("windmill_worker"), "cap_drop"));
  });

  test("mise.toml sets the same default uid as the Dockerfile", () => {
    const parsed: unknown = Bun.TOML.parse(
      readFileSync(join(REPO_ROOT, "mise.toml"), "utf8"),
    );
    const env = isRecord(parsed) && isRecord(parsed.env) ? parsed.env : {};
    const dockerfile = readFileSync(
      join(REPO_ROOT, "infra/worker/Dockerfile"),
      "utf8",
    );

    expect(/^ARG FACTORY_CHECK_UID=(\S+)$/m.exec(dockerfile)?.[1]).toBe(
      String(env.FACTORY_CHECK_UID),
    );
  });
});
