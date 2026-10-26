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
import { CHECK_NPROC_LIMIT } from "../../f/factory/lib/check_sandbox.ts";
import { DEFAULT_WORKER_SLOTS } from "../../f/factory/lib/worker_load_support.ts";

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

  test("sets no NUM_WORKERS because a non-native worker runs one process", () => {
    const svc = service("windmill_worker_console");

    expect(envEntries(svc, "NUM_WORKERS=")).toEqual([]);
  });

  test("does not acknowledge the unsafe NUM_WORKERS override", () => {
    const svc = service("windmill_worker_console");

    expect(envEntries(svc, "I_ACK_NUM_WORKERS_IS_UNSAFE")).toEqual([]);
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

describe("infra/docker-compose.yml windmill_worker_periodic", () => {
  const name = "windmill_worker_periodic";

  test("is defined as a service", () => {
    const svc = service(name);

    expect(Object.keys(svc).length).toBeGreaterThan(0);
  });

  test("uses the same image as the native worker", () => {
    const svc = service(name);
    const native = service("windmill_worker_native");

    expect(svc.image).toBe(native.image);
  });

  test("runs in worker mode", () => {
    const svc = service(name);

    expect(stringList(svc, "environment")).toContain("MODE=worker");
  });

  test("belongs to the periodic worker group", () => {
    const svc = service(name);

    expect(envEntries(svc, "WORKER_GROUP=")).toEqual(["WORKER_GROUP=periodic"]);
  });

  test("accepts only the periodic tag", () => {
    const svc = service(name);

    expect(envEntries(svc, "WORKER_TAGS=")).toEqual(["WORKER_TAGS=periodic"]);
  });

  test("sets no NUM_WORKERS because a non-native worker runs one process", () => {
    const svc = service(name);

    expect(envEntries(svc, "NUM_WORKERS=")).toEqual([]);
  });

  test("does not acknowledge the unsafe NUM_WORKERS override", () => {
    const svc = service(name);

    expect(envEntries(svc, "I_ACK_NUM_WORKERS_IS_UNSAFE")).toEqual([]);
  });

  test("connects to the database like the other workers", () => {
    const svc = service(name);
    const native = service("windmill_worker_native");
    const dbUrl = (s: Json) =>
      stringList(s, "environment").filter((e) => e.startsWith("DATABASE_URL="));

    expect(dbUrl(svc)).toEqual(dbUrl(native));
  });

  test("limits memory to 1024M", () => {
    const svc = service(name);

    expect(limits(svc).memory).toBe("1024M");
  });

  test("limits processes to 256", () => {
    const svc = service(name);

    expect(limits(svc).pids).toBe(256);
  });

  test("runs an init process", () => {
    const svc = service(name);

    expect(svc.init).toBe(true);
  });

  test("forbids gaining privileges", () => {
    const svc = service(name);

    expect(stringList(svc, "security_opt")).toContain("no-new-privileges:true");
  });

  test("is not privileged", () => {
    const svc = service(name);

    expect(svc.privileged).toBeUndefined();
  });

  test("restarts unless stopped", () => {
    const svc = service(name);

    expect(svc.restart).toBe("unless-stopped");
  });

  test("waits for a healthy database", () => {
    const svc = service(name);
    const dependsOn = isRecord(svc.depends_on) ? svc.depends_on : {};

    expect(dependsOn.db).toEqual({ condition: "service_healthy" });
  });

  test("does not mount factory_workspaces", () => {
    const svc = service(name);

    expect(mountsOf(svc, "factory_workspaces")).toEqual([]);
  });

  test("does not mount factory_state", () => {
    const svc = service(name);

    expect(mountsOf(svc, "factory_state")).toEqual([]);
  });

  test("does not mount factory_console", () => {
    const svc = service(name);

    expect(mountsOf(svc, "factory_console")).toEqual([]);
  });

  test("does not share worker_dependency_cache", () => {
    const svc = service(name);

    expect(mountsOf(svc, "worker_dependency_cache")).toEqual([]);
  });

  test("does not mount the docker socket", () => {
    const svc = service(name);

    expect(mounts(svc).filter((m) => m.source.includes("docker.sock"))).toEqual(
      [],
    );
  });

  test("mounts worker_logs like the native worker", () => {
    const svc = service(name);

    expect(mountsOf(svc, "worker_logs").map((m) => m.target)).toEqual([
      "/tmp/windmill/logs",
    ]);
  });

  test("mounts its own dependency cache", () => {
    const svc = service(name);

    expect(
      mountsOf(svc, "worker_periodic_dependency_cache").map((m) => m.target),
    ).toEqual(["/tmp/windmill/cache"]);
  });

  test("declares its dependency cache as a top-level volume", () => {
    const volumes = compose().volumes;

    expect(
      isRecord(volumes) && "worker_periodic_dependency_cache" in volumes,
    ).toBe(true);
  });

  test("mounts nothing writable other than worker_logs and its own cache", () => {
    const svc = service(name);

    const writable = mounts(svc).filter(
      (m) =>
        !m.readOnly &&
        m.source !== "worker_logs" &&
        m.source !== "worker_periodic_dependency_cache",
    );

    expect(writable).toEqual([]);
  });

  test("drops the same capabilities as the default worker", () => {
    const svc = service(name);

    expect(stringList(svc, "cap_drop")).toEqual(
      stringList(service("windmill_worker"), "cap_drop"),
    );
  });

  test("does not drop every capability", () => {
    const svc = service(name);

    expect(stringList(svc, "cap_drop")).not.toContain("ALL");
  });
});

describe("worker tag lists", () => {
  // composeでdefaultでもnativeでもないワーカーグループのtagを、
  // カスタムtagの許可(bootstrap)、確認(doctor)、負荷の集計の分類と一致させる。
  const composeTags = (): string[] => {
    const services = compose().services;
    if (!isRecord(services)) return [];
    const tags: string[] = [];
    for (const svc of Object.values(services)) {
      if (!isRecord(svc) || !isStringArray(svc.environment)) continue;
      const group = envEntries(svc, "WORKER_GROUP=");
      if (group.length === 0) continue;
      if (group.some((g) => g === "WORKER_GROUP=default")) continue;
      if (group.some((g) => g === "WORKER_GROUP=native")) continue;
      for (const entry of envEntries(svc, "WORKER_TAGS=")) {
        tags.push(...entry.slice("WORKER_TAGS=".length).split(","));
      }
    }
    return tags.sort();
  };

  const scriptTags = (file: string, variable: string): string[] => {
    const text = readFileSync(join(REPO_ROOT, file), "utf8");
    const match = new RegExp(`for ${variable} in ([a-z_ ]+); do`).exec(text);
    return (match?.[1] ?? "")
      .split(/\s+/)
      .filter((t) => t !== "")
      .sort();
  };

  test("the compose services have custom tags", () => {
    expect(composeTags()).not.toEqual([]);
  });

  test("bootstrap allows the tags the compose workers accept", () => {
    expect(scriptTags("scripts/bootstrap.sh", "tag")).toEqual(composeTags());
  });

  test("doctor checks the tags the compose workers accept", () => {
    expect(scriptTags("scripts/doctor.sh", "check_tag")).toEqual(composeTags());
  });

  test("the load sampler does not count the tags the compose workers accept", () => {
    const text = readFileSync(
      join(REPO_ROOT, "f/factory/lib/worker_load_support.ts"),
      "utf8",
    );
    const block =
      /const OTHER_WORKER_TAGS[^=]*= new Set\(\[([^\]]*)\]\)/.exec(text)?.[1] ??
      "";
    const listed = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");

    expect(composeTags().filter((t) => !listed.includes(t))).toEqual([]);
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

  test("passes the number of check slots to the image build", () => {
    const build = service("windmill_worker").build;
    const args = isRecord(build) && isRecord(build.args) ? build.args : {};

    expect(args.FACTORY_CHECK_POOL_SIZE).toBe(
      "${FACTORY_CHECK_POOL_SIZE:?run via mise}",
    );
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

  const miseEnv = (): Json => {
    const parsed: unknown = Bun.TOML.parse(
      readFileSync(join(REPO_ROOT, "mise.toml"), "utf8"),
    );
    return isRecord(parsed) && isRecord(parsed.env) ? parsed.env : {};
  };
  const dockerfileDefault = (name: string): string | undefined =>
    new RegExp(`^ARG ${name}=(\\S+)$`, "m").exec(
      readFileSync(join(REPO_ROOT, "infra/worker/Dockerfile"), "utf8"),
    )?.[1];

  test("mise.toml sets the same default uid as the Dockerfile", () => {
    expect(dockerfileDefault("FACTORY_CHECK_UID")).toBe(
      String(miseEnv().FACTORY_CHECK_UID),
    );
  });

  test("mise.toml sets the same default slot count as the Dockerfile", () => {
    expect(dockerfileDefault("FACTORY_CHECK_POOL_SIZE")).toBe(
      String(miseEnv().FACTORY_CHECK_POOL_SIZE),
    );
  });

  /**
   * nativeでないworkerは、`NUM_WORKERS`にかかわらずジョブを1つずつ動かすので、
   * 同時に動く検査の数も1である。
   */
  const NON_NATIVE_WORKER_PROCESSES = 1;

  /**
   * 片付けられず飛ばす枠が同時に残りうる数。
   * 飛ばした枠の止まらないプロセスは、検査1つの分の外でpidsを使う。
   */
  const TOLERATED_SKIPPED_SLOTS = 2;

  /**
   * workerのコンテナで、検査の外のプロセス(Windmill本体、ジョブのbun、Claude、git)に残す数。
   * 動いているworkerで、待機中が53、起動からの最大が112だったので、その2倍強にする。
   */
  const WORKER_PIDS_RESERVE = 256;

  test("a check at the cap and the skipped slots leave the reserve within the pids limit", () => {
    expect(
      (NON_NATIVE_WORKER_PROCESSES + TOLERATED_SKIPPED_SLOTS) *
        CHECK_NPROC_LIMIT +
        WORKER_PIDS_RESERVE,
    ).toBeLessThanOrEqual(Number(limits(service("windmill_worker")).pids));
  });

  test("there are slots for the running check and the skipped ones", () => {
    expect(Number(miseEnv().FACTORY_CHECK_POOL_SIZE)).toBeGreaterThanOrEqual(
      NON_NATIVE_WORKER_PROCESSES + TOLERATED_SKIPPED_SLOTS,
    );
  });
});

describe("infra/docker-compose.yml windmill_worker concurrency", () => {
  test("sets no NUM_WORKERS because a non-native worker runs one process", () => {
    expect(envEntries(service("windmill_worker"), "NUM_WORKERS=")).toEqual([]);
  });

  test("does not acknowledge the unsafe NUM_WORKERS override", () => {
    expect(
      envEntries(service("windmill_worker"), "I_ACK_NUM_WORKERS_IS_UNSAFE"),
    ).toEqual([]);
  });

  test("keeps the native worker in native mode", () => {
    expect(
      envEntries(service("windmill_worker_native"), "NATIVE_MODE="),
    ).toEqual(["NATIVE_MODE=true"]);
  });
});

describe("infra/docker-compose.yml windmill_worker slots recorded by sample_worker_load", () => {
  test("DEFAULT_WORKER_SLOTS is one because the default worker runs one job at a time", () => {
    expect(DEFAULT_WORKER_SLOTS).toBe(1);
  });
});

describe("infra/docker-compose.yml windmill_worker job environment", () => {
  test("passes CLAUDE_VERSION through to the jobs", () => {
    const names = envEntries(service("windmill_worker"), "WHITELIST_ENVS=")
      .flatMap((entry) => entry.slice("WHITELIST_ENVS=".length).split(","))
      .map((name) => name.trim());

    expect(names).toContain("CLAUDE_VERSION");
  });
});

describe("infra/docker-compose.yml windmill_server session validity", () => {
  test("the server takes the session validity from the mise variable", () => {
    expect(
      envEntries(service("windmill_server"), "MAX_SESSION_VALIDITY_SECONDS="),
    ).toEqual([
      "MAX_SESSION_VALIDITY_SECONDS=${WM_SESSION_VALIDITY_SECONDS:?run via mise}",
    ]);
  });

  test("mise.toml sets the session validity to 30 days", () => {
    const parsed: unknown = Bun.TOML.parse(
      readFileSync(join(REPO_ROOT, "mise.toml"), "utf8"),
    );
    const env = isRecord(parsed) && isRecord(parsed.env) ? parsed.env : {};

    expect(env.WM_SESSION_VALIDITY_SECONDS).toBe("2592000");
  });

  test("no service other than windmill_server sets the session validity", () => {
    const parsed = compose();
    const names = isRecord(parsed.services) ? Object.keys(parsed.services) : [];
    // environmentは配列形式とmap形式の両方があるので、変数名だけを取り出して比べる。
    const setsValidity = (name: string): boolean => {
      const environment = service(name).environment;
      if (isRecord(environment)) {
        return "MAX_SESSION_VALIDITY_SECONDS" in environment;
      }
      return (
        isStringArray(environment) &&
        environment.some((e) => e.startsWith("MAX_SESSION_VALIDITY_SECONDS"))
      );
    };
    const setting = names
      .filter((name) => name !== "windmill_server")
      .filter(setsValidity);

    expect(setting).toEqual([]);
  });
});

// ホストの実行役は、composeの定義にdockerのソケットが無いことを前提に、
// 静的な検査でソケットを含む定義を拒否する。今の定義がその前提を満たすことを確かめる。
describe("infra/docker-compose.yml docker socket", () => {
  test("no service mounts the docker socket", () => {
    const parsed = compose();
    const names = isRecord(parsed.services) ? Object.keys(parsed.services) : [];
    const mounting = names.filter((name) =>
      mounts(service(name)).some((m) => m.source.includes("docker.sock")),
    );

    expect(mounting).toEqual([]);
  });

  test("the parsed definition never names the docker socket", () => {
    expect(JSON.stringify(compose())).not.toContain("docker.sock");
  });
});

// `mise run up`と`mise run deploy`は、このラベルが付いた宙に浮いたイメージだけを消す。
// ラベルを付け忘れた自前ビルドのサービスは、旧イメージが静かに残り続けるため、
// `build`を持つサービスはすべてラベルを持つことを固定する。
describe("infra/docker-compose.yml prune label", () => {
  const LABEL = "com.atelier-works.prune";

  function buildServiceNames(): string[] {
    const parsed = compose();
    const names = isRecord(parsed.services) ? Object.keys(parsed.services) : [];
    return names.filter((name) => service(name).build !== undefined);
  }

  function buildLabel(name: string): unknown {
    const build = service(name).build;
    const labels = isRecord(build) ? build.labels : undefined;
    return isRecord(labels) ? labels[LABEL] : undefined;
  }

  test("builds the two services that the stack builds itself", () => {
    expect(buildServiceNames()).toEqual(
      expect.arrayContaining(["windmill_worker", "console_fetcher"]),
    );
  });

  test("every service with a build carries the prune label", () => {
    const unlabeled = buildServiceNames().filter(
      (name) => buildLabel(name) !== "true",
    );

    expect(unlabeled).toEqual([]);
  });
});
