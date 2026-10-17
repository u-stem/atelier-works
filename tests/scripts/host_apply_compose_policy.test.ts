import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMPOSE_SERVICE_ALLOWLIST,
  type ComposeContext,
  checkCompose,
  checkComposeText,
} from "../../scripts/host_apply/compose_policy.ts";
import { MAX_BLOB_BYTES } from "../../scripts/host_apply/constants.ts";
import { readMiseEnv } from "../../scripts/host_apply/mise_policy.ts";

const REPO_ROOT = join(import.meta.dir, "../..");

const ctx: ComposeContext = {
  root: "/stage",
  composeDir: "/stage/infra",
  env: { WM_BIND: "127.0.0.1", WM_HTTP_PORT: "8080" },
};

function one(
  service: Record<string, unknown>,
  top: Record<string, unknown> = {},
) {
  return { services: { db: { image: "postgres:18", ...service } }, ...top };
}

function textVerdict(text: string, context: ComposeContext = ctx) {
  const result = checkComposeText(text, context);
  return result.ok ? "ok" : `${result.kind}`;
}

function verdict(parsed: unknown, context: ComposeContext = ctx) {
  const result = checkCompose(parsed, context);
  return result.ok ? "ok" : `${result.kind}`;
}

describe("the real infra/docker-compose.yml", () => {
  const parsed: unknown = Bun.YAML.parse(
    readFileSync(join(REPO_ROOT, "infra/docker-compose.yml"), "utf8"),
  );
  const env = readMiseEnv(readFileSync(join(REPO_ROOT, "mise.toml"), "utf8"));

  test("is read by Bun.YAML.parse with anchors expanded", () => {
    const services =
      typeof parsed === "object" && parsed !== null && "services" in parsed
        ? parsed.services
        : null;
    const db =
      typeof services === "object" && services !== null && "db" in services
        ? services.db
        : null;
    const logging =
      typeof db === "object" && db !== null && "logging" in db
        ? db.logging
        : null;
    expect(logging).toEqual({
      driver: "json-file",
      options: {
        "max-size": "${LOG_MAX_SIZE:-20m}",
        "max-file": "${LOG_MAX_FILE:-10}",
        compress: "true",
      },
    });
  });

  test("passes the policy", () => {
    expect(
      checkCompose(parsed, {
        root: REPO_ROOT,
        composeDir: join(REPO_ROOT, "infra"),
        env: env ?? {},
      }),
    ).toEqual({ ok: true });
  });

  test("passes only because WM_BIND resolves to 127.0.0.1", () => {
    expect(
      verdict(parsed, {
        root: REPO_ROOT,
        composeDir: join(REPO_ROOT, "infra"),
        env: { ...(env ?? {}), WM_BIND: "0.0.0.0" },
      }),
    ).toBe("compose_forbidden");
  });
});

describe("service names", () => {
  test("lists the ten allowed services", () => {
    expect([...COMPOSE_SERVICE_ALLOWLIST].sort()).toEqual(
      [
        "db",
        "windmill_server",
        "windmill_worker",
        "windmill_worker_native",
        "windmill_worker_console",
        "windmill_worker_periodic",
        "windmill_extra",
        "caddy",
        "console_fetcher",
        "factory_state_init",
      ].sort(),
    );
  });

  test("rejects a service that is not on the list", () => {
    expect(verdict({ services: { evil: { image: "x" } } })).toBe(
      "unknown_service",
    );
  });

  test("reports an unknown service before an unknown key", () => {
    expect(
      verdict({ services: { evil: { image: "x", privileged: true } } }),
    ).toBe("unknown_service");
  });
});

describe("service keys", () => {
  test("accepts the common keys", () => {
    expect(
      verdict(
        one({
          restart: "unless-stopped",
          init: true,
          cap_drop: ["ALL"],
          security_opt: ["no-new-privileges:true"],
        }),
      ),
    ).toBe("ok");
  });

  test("rejects a key that is not on the list", () => {
    expect(verdict(one({ some_future_key: 1 }))).toBe("compose_forbidden");
  });

  test.each([
    ["privileged", true],
    ["cap_add", ["SYS_ADMIN"]],
    ["devices", ["/dev/sda:/dev/sda"]],
    ["userns_mode", "host"],
    ["cgroup", "host"],
    ["sysctls", { "net.ipv4.ip_forward": 1 }],
    ["volumes_from", ["other"]],
    ["extends", { file: "x.yml", service: "y" }],
  ])("rejects %s", (key, value) => {
    expect(verdict(one({ [key]: value }))).toBe("compose_forbidden");
  });

  test("rejects a top-level include", () => {
    expect(verdict(one({}, { include: ["other.yml"] }))).toBe(
      "compose_forbidden",
    );
  });

  test("accepts a top-level extension key", () => {
    expect(verdict(one({}, { "x-logging": { driver: "json-file" } }))).toBe(
      "ok",
    );
  });
});

describe("namespaces", () => {
  test.each([
    ["pid", "host"],
    ["ipc", "host"],
    ["uts", "host"],
    ["network_mode", "host"],
    ["network_mode", "container:other"],
    ["network_mode", "service:other"],
    ["pid", "container:other"],
  ])("rejects %s: %s", (key, value) => {
    expect(verdict(one({ [key]: value }))).toBe("compose_forbidden");
  });

  test("accepts network_mode none", () => {
    expect(verdict(one({ network_mode: "none" }))).toBe("ok");
  });
});

describe("security_opt", () => {
  test.each([
    "seccomp=unconfined",
    "apparmor:unconfined",
    "label=disable",
    "label:disable",
  ])("rejects %s", (option) => {
    expect(verdict(one({ security_opt: [option] }))).toBe("compose_forbidden");
  });
});

describe("ports", () => {
  test("accepts a binding to 127.0.0.1 after expanding variables", () => {
    expect(
      verdict(one({ ports: ["${WM_BIND:?x}:${WM_HTTP_PORT:?x}:80"] })),
    ).toBe("ok");
  });

  test("rejects a variable that expands to another address", () => {
    expect(
      verdict(one({ ports: ["${WM_BIND:?x}:8080:80"] }), {
        ...ctx,
        env: { WM_BIND: "0.0.0.0" },
      }),
    ).toBe("compose_forbidden");
  });

  test("rejects a binding to 0.0.0.0", () => {
    expect(verdict(one({ ports: ["0.0.0.0:8080:80"] }))).toBe(
      "compose_forbidden",
    );
  });

  test("rejects a port without an address", () => {
    expect(verdict(one({ ports: ["8080:80"] }))).toBe("compose_forbidden");
  });

  test("rejects a long form without host_ip", () => {
    expect(verdict(one({ ports: [{ target: 80, published: 8080 }] }))).toBe(
      "compose_forbidden",
    );
  });

  test("accepts a long form bound to 127.0.0.1", () => {
    expect(
      verdict(
        one({
          ports: [{ target: 80, published: 8080, host_ip: "127.0.0.1" }],
        }),
      ),
    ).toBe("ok");
  });

  test("rejects an unset variable without a default", () => {
    expect(
      verdict(one({ ports: ["${NOPE:?x}:8080:80"] }), { ...ctx, env: {} }),
    ).toBe("compose_forbidden");
  });
});

describe("paths that leave the checkout", () => {
  test("accepts env_file inside the checkout", () => {
    expect(verdict(one({ env_file: ["./app.env"] }))).toBe("ok");
  });

  test.each(["../../etc/passwd", "/etc/passwd", "~/secret.env", "../.."])(
    "rejects env_file %s",
    (path) => {
      expect(verdict(one({ env_file: [path] }))).toBe("compose_forbidden");
    },
  );

  test("rejects an env_file object that leaves the checkout", () => {
    expect(verdict(one({ env_file: [{ path: "/etc/x" }] }))).toBe(
      "compose_forbidden",
    );
  });

  test("rejects a top-level secret file outside the checkout", () => {
    expect(
      verdict(
        one({ secrets: ["s"] }, { secrets: { s: { file: "/root/.ssh/id" } } }),
      ),
    ).toBe("compose_forbidden");
  });

  test("accepts a top-level secret file inside the checkout", () => {
    expect(
      verdict(one({ secrets: ["s"] }, { secrets: { s: { file: "./s.txt" } } })),
    ).toBe("ok");
  });

  test("rejects a top-level secret taken from the environment", () => {
    expect(
      verdict(
        one({ secrets: ["s"] }, { secrets: { s: { environment: "HOME" } } }),
      ),
    ).toBe("compose_forbidden");
  });

  test("rejects a top-level config file outside the checkout", () => {
    expect(
      verdict(one({ configs: ["c"] }, { configs: { c: { file: "../../x" } } })),
    ).toBe("compose_forbidden");
  });
});

describe("build", () => {
  test("accepts a build context inside the checkout", () => {
    expect(verdict(one({ build: { context: "./worker" } }))).toBe("ok");
  });

  test("accepts a build context given as a string", () => {
    expect(verdict(one({ build: "./worker" }))).toBe("ok");
  });

  test.each([
    "../../outside",
    "/etc",
    "https://example.com/repo.git",
    "git://example.com/repo.git",
    "git@github.com:x/y.git",
    "github.com/x/y",
  ])("rejects build context %s", (context) => {
    expect(verdict(one({ build: { context } }))).toBe("compose_forbidden");
  });

  test("rejects an additional context outside the checkout", () => {
    expect(
      verdict(
        one({
          build: { context: "./worker", additional_contexts: { x: "/etc" } },
        }),
      ),
    ).toBe("compose_forbidden");
  });

  test("rejects a remote additional context", () => {
    expect(
      verdict(
        one({
          build: {
            context: "./worker",
            additional_contexts: ["x=https://example.com/a.tar"],
          },
        }),
      ),
    ).toBe("compose_forbidden");
  });

  test("rejects a dockerfile that leaves the checkout", () => {
    expect(
      verdict(
        one({
          build: { context: "./worker", dockerfile: "../../../x/Dockerfile" },
        }),
      ),
    ).toBe("compose_forbidden");
  });

  test("rejects a build option that is not on the list", () => {
    expect(
      verdict(one({ build: { context: "./worker", network: "host" } })),
    ).toBe("compose_forbidden");
  });

  test("rejects a build secret", () => {
    expect(
      verdict(one({ build: { context: "./worker", secrets: ["s"] } })),
    ).toBe("compose_forbidden");
  });
});

describe("bind mounts", () => {
  test("accepts a named volume", () => {
    expect(
      verdict(
        one({ volumes: ["data:/var/lib/x"] }, { volumes: { data: null } }),
      ),
    ).toBe("ok");
  });

  test("accepts a read-only bind inside the checkout", () => {
    expect(verdict(one({ volumes: ["./conf:/etc/conf:ro"] }))).toBe("ok");
  });

  test("accepts the Caddyfile bind", () => {
    expect(
      verdict(one({ volumes: ["./Caddyfile:/etc/caddy/Caddyfile"] })),
    ).toBe("ok");
  });

  test("rejects a writable bind of another file inside the checkout", () => {
    expect(verdict(one({ volumes: ["./data:/data"] }))).toBe(
      "compose_forbidden",
    );
  });

  test("rejects a bind outside the checkout", () => {
    expect(verdict(one({ volumes: ["/etc:/host-etc:ro"] }))).toBe(
      "compose_forbidden",
    );
  });

  test("rejects a bind through parent directories", () => {
    expect(verdict(one({ volumes: ["../../..:/h:ro"] }))).toBe(
      "compose_forbidden",
    );
  });

  test("rejects a home directory bind", () => {
    expect(verdict(one({ volumes: ["~/.ssh:/ssh:ro"] }))).toBe(
      "compose_forbidden",
    );
  });

  test("rejects the docker socket in the short form", () => {
    expect(
      verdict(one({ volumes: ["/var/run/docker.sock:/var/run/docker.sock"] })),
    ).toBe("compose_forbidden");
  });

  test("rejects the docker socket in the long form", () => {
    expect(
      verdict(
        one({
          volumes: [
            {
              type: "bind",
              source: "/var/run/docker.sock",
              target: "/var/run/docker.sock",
            },
          ],
        }),
      ),
    ).toBe("compose_forbidden");
  });

  test("accepts a long-form named volume with a subpath", () => {
    expect(
      verdict(
        one(
          {
            volumes: [
              {
                type: "volume",
                source: "state",
                target: "/x",
                read_only: true,
                volume: { subpath: "requirements" },
              },
            ],
          },
          { volumes: { state: null } },
        ),
      ),
    ).toBe("ok");
  });

  test("accepts a long-form read-only bind inside the checkout", () => {
    expect(
      verdict(
        one({
          volumes: [
            { type: "bind", source: "./conf", target: "/c", read_only: true },
          ],
        }),
      ),
    ).toBe("ok");
  });

  test("rejects a long-form writable bind inside the checkout", () => {
    expect(
      verdict(
        one({ volumes: [{ type: "bind", source: "./conf", target: "/c" }] }),
      ),
    ).toBe("compose_forbidden");
  });

  test("rejects a mount type it does not know", () => {
    expect(
      verdict(one({ volumes: [{ type: "npipe", source: "x", target: "/c" }] })),
    ).toBe("compose_forbidden");
  });
});

describe("docker.sock anywhere", () => {
  const head = "services:\n  db:\n    image: postgres:18\n";

  test("rejects the string in an environment value", () => {
    expect(
      textVerdict(
        `${head}    environment:\n      - DOCKER_HOST=unix:///var/run/docker.sock\n`,
      ),
    ).toBe("compose_forbidden");
  });

  test("rejects the string in a command", () => {
    expect(
      textVerdict(`${head}    command: ["ls", "/var/run/docker.sock"]\n`),
    ).toBe("compose_forbidden");
  });

  test("rejects the string in an extension key", () => {
    expect(textVerdict(`x-note: /var/run/docker.sock\n${head}`)).toBe(
      "compose_forbidden",
    );
  });

  test("rejects the string in a comment, since the raw text is searched", () => {
    expect(textVerdict(`# docker.sock\n${head}`)).toBe("compose_forbidden");
  });
});

describe("checkComposeText", () => {
  const head = "services:\n  db:\n    image: postgres:18\n";

  test("accepts a small valid definition", () => {
    expect(textVerdict(head)).toBe("ok");
  });

  test("rejects text that is not valid YAML", () => {
    expect(textVerdict("services: [\n")).toBe("compose_forbidden");
  });

  test("rejects text over the size limit before parsing it", () => {
    const padding = `x-pad: ${"a".repeat(MAX_BLOB_BYTES)}\n`;
    expect(textVerdict(`${padding}${head}`)).toBe("compose_forbidden");
  });

  test("passes the real definition", () => {
    const env = readMiseEnv(readFileSync(join(REPO_ROOT, "mise.toml"), "utf8"));
    expect(
      textVerdict(
        readFileSync(join(REPO_ROOT, "infra/docker-compose.yml"), "utf8"),
        {
          root: REPO_ROOT,
          composeDir: join(REPO_ROOT, "infra"),
          env: env ?? {},
        },
      ),
    ).toBe("ok");
  });

  function bombOf(levels: number): string {
    let bomb = "x-a0: &a0 [x, x, x, x, x, x, x, x, x]\n";
    for (let i = 1; i < levels; i++) {
      bomb += `x-a${i}: &a${i} [${Array(9)
        .fill(`*a${i - 1}`)
        .join(", ")}]\n`;
    }
    return bomb;
  }

  test("does not expand aliases while checking a small alias bomb", () => {
    // 360バイトの入力が、パースでは参照を共有して軽いまま、JSON.stringifyでは22MBに膨らむ。
    const started = performance.now();
    const result = textVerdict(`${bombOf(7)}${head}`);
    expect([result, performance.now() - started < 1000]).toEqual(["ok", true]);
  });

  test("rejects a deeper alias bomb that the parser itself refuses", () => {
    expect(textVerdict(`${bombOf(9)}${head}`)).toBe("compose_forbidden");
  });
});

describe("reservations and absolute binds", () => {
  test("accepts cpus and memory in reservations", () => {
    expect(
      verdict(
        one({
          deploy: {
            resources: { reservations: { cpus: "0.5", memory: "128M" } },
          },
        }),
      ),
    ).toBe("ok");
  });

  test("rejects devices in reservations", () => {
    expect(
      verdict(
        one({
          deploy: {
            resources: {
              reservations: {
                devices: [
                  { driver: "nvidia", count: 1, capabilities: ["gpu"] },
                ],
              },
            },
          },
        }),
      ),
    ).toBe("compose_forbidden");
  });

  test("rejects a limit key that is not on the list", () => {
    expect(
      verdict(one({ deploy: { resources: { limits: { devices: [] } } } })),
    ).toBe("compose_forbidden");
  });

  test("accepts the limits the real definition uses", () => {
    expect(
      verdict(
        one({ deploy: { resources: { limits: { memory: "1G", pids: 64 } } } }),
      ),
    ).toBe("ok");
  });

  test("rejects an absolute bind source even inside the logical root", () => {
    expect(verdict(one({ volumes: ["/stage/infra/conf:/etc/conf:ro"] }))).toBe(
      "compose_forbidden",
    );
  });

  test("rejects an absolute long-form bind source inside the logical root", () => {
    expect(
      verdict(
        one({
          volumes: [
            {
              type: "bind",
              source: "/stage/infra/Caddyfile",
              target: "/c",
              read_only: true,
            },
          ],
        }),
      ),
    ).toBe("compose_forbidden");
  });

  test("rejects a variable that expands to an absolute path", () => {
    expect(
      verdict(one({ volumes: ["${ROOT_DIR}/conf:/c:ro"] }), {
        ...ctx,
        env: { ROOT_DIR: "/stage/infra" },
      }),
    ).toBe("compose_forbidden");
  });
});

describe("short volume options", () => {
  test.each([
    "ro,rw",
    "rw,ro",
    "ro,rw,z",
    "rw",
    "rw,z",
    "",
    "unknown",
    "ro,unknown",
    "ro,",
  ])("a bind mounted with the option list %p is not read-only", (options) => {
    expect(verdict(one({ volumes: [`./conf:/c:${options}`] }))).toBe(
      "compose_forbidden",
    );
  });

  test.each(["ro", "ro,z", "ro,Z", "z,ro", "ro,rslave"])(
    "accepts a read-only bind with the option list %s",
    (options) => {
      expect(verdict(one({ volumes: [`./conf:/c:${options}`] }))).toBe("ok");
    },
  );

  test("rejects a short volume with more than three fields", () => {
    expect(verdict(one({ volumes: ["./conf:/c:ro:extra"] }))).toBe(
      "compose_forbidden",
    );
  });

  test("rejects an unknown option on a named volume", () => {
    expect(
      verdict(one({ volumes: ["data:/d:weird"] }, { volumes: { data: null } })),
    ).toBe("compose_forbidden");
  });
});

describe("variables in fields checked by value", () => {
  test.each([
    ["network_mode", "${NOPE:-host}"],
    ["pid", "${NOPE:-host}"],
    ["ipc", "${NOPE:-host}"],
    ["uts", "${NOPE:-host}"],
    ["network_mode", "con${NOPE:-}tainer:other"],
  ])("rejects %s: %s", (key, value) => {
    expect(verdict(one({ [key]: value }))).toBe("compose_forbidden");
  });

  test("rejects a security_opt that a variable spells as unconfined", () => {
    expect(
      verdict(one({ security_opt: ["seccomp=unconf${NOPE:-}ined"] })),
    ).toBe("compose_forbidden");
  });

  test("rejects a security_opt spelled by two variables", () => {
    expect(
      verdict(one({ security_opt: ["seccomp=${A:-uncon}${B:-fined}"] })),
    ).toBe("compose_forbidden");
  });

  test("rejects a security_opt that a variable spells as label=disable", () => {
    expect(verdict(one({ security_opt: ["label=${NOPE:-disable}"] }))).toBe(
      "compose_forbidden",
    );
  });

  test("still allows a variable in an environment value", () => {
    expect(verdict(one({ environment: ["A=${DB_PASSWORD:-x}"] }))).toBe("ok");
  });
});

describe("service networks", () => {
  const top = { networks: { n: { driver: "bridge" } } };

  test("accepts a list of names", () => {
    expect(verdict(one({ networks: ["n"] }, top))).toBe("ok");
  });

  test("accepts aliases and ipv4_address", () => {
    expect(
      verdict(
        one(
          {
            networks: {
              n: { aliases: ["a"], ipv4_address: "172.20.0.5" },
            },
          },
          top,
        ),
      ),
    ).toBe("ok");
  });

  test("accepts a name mapped to nothing", () => {
    expect(verdict(one({ networks: { n: null } }, top))).toBe("ok");
  });

  test("rejects driver_opts on a service network", () => {
    expect(
      verdict(
        one(
          { networks: { n: { driver_opts: { "com.docker.network.x": "1" } } } },
          top,
        ),
      ),
    ).toBe("compose_forbidden");
  });

  test("rejects sysctls on a service network", () => {
    expect(
      verdict(one({ networks: { n: { sysctls: { "net.x": "1" } } } }, top)),
    ).toBe("compose_forbidden");
  });

  test("rejects a network list entry that is not a string", () => {
    expect(verdict(one({ networks: [{ n: 1 }] }, top))).toBe(
      "compose_forbidden",
    );
  });

  test("rejects aliases that are not strings", () => {
    expect(verdict(one({ networks: { n: { aliases: [1] } } }, top))).toBe(
      "compose_forbidden",
    );
  });
});

describe("variables the executor does not know", () => {
  // 検査は列挙した15個のキーだけで変数を展開する。本番の子プロセスには`HOME`なども入るので、
  // 既定値があっても、知らない名前の参照は拒否する。
  test.each([
    ["a short bind", { volumes: ["${HOME-.}:/h:ro"] }],
    [
      "a long bind",
      {
        volumes: [
          { type: "bind", source: "${HOME:-.}", target: "/h", read_only: true },
        ],
      },
    ],
    [
      "a long bind with the - form",
      {
        volumes: [
          { type: "bind", source: "${HOME-.}", target: "/h", read_only: true },
        ],
      },
    ],
    ["an env_file", { env_file: ["${HOME-.}/x.env"] }],
    ["a build context", { build: { context: "${HOME:-.}" } }],
    [
      "a dockerfile",
      { build: { context: "./worker", dockerfile: "${HOME-.}/Dockerfile" } },
    ],
    [
      "an additional context",
      {
        build: {
          context: "./worker",
          additional_contexts: { x: "${HOME:-.}" },
        },
      },
    ],
    ["a port address", { ports: ["${HOME-127.0.0.1}:8080:80"] }],
  ])("rejects %s", (_name, service) => {
    expect(verdict(one(service))).toBe("compose_forbidden");
  });

  test("rejects a top-level secret file", () => {
    expect(
      verdict(
        one({ secrets: ["s"] }, { secrets: { s: { file: "${HOME-.}/s" } } }),
      ),
    ).toBe("compose_forbidden");
  });

  test("rejects a top-level config file", () => {
    expect(
      verdict(
        one({ configs: ["c"] }, { configs: { c: { file: "${HOME:-.}/c" } } }),
      ),
    ).toBe("compose_forbidden");
  });

  test("still expands a known name that has a default", () => {
    expect(
      verdict(
        one({ ports: ["${WM_BIND-127.0.0.1}:${WM_HTTP_PORT:-8080}:80"] }),
      ),
    ).toBe("ok");
  });

  test("still rejects a known name whose value is not loopback", () => {
    expect(
      verdict(one({ ports: ["${WM_BIND-127.0.0.1}:8080:80"] }), {
        ...ctx,
        env: { WM_BIND: "0.0.0.0" },
      }),
    ).toBe("compose_forbidden");
  });
});

describe("security_opt allowlist", () => {
  test.each(["no-new-privileges:true", "no-new-privileges=true"])(
    "accepts %s",
    (option) => {
      expect(verdict(one({ security_opt: [option] }))).toBe("ok");
    },
  );

  test.each([
    "no-new-privileges:false",
    "no-new-privileges",
    "seccomp=default",
    "seccomp=/etc/profile.json",
    "apparmor=docker-default",
    "apparmor=my-profile",
    "label=type:spc_t",
    "label=user:u",
    "systempaths=unconfined",
    "something-new=1",
  ])("rejects %s", (option) => {
    expect(verdict(one({ security_opt: [option] }))).toBe("compose_forbidden");
  });

  test("rejects a list that mixes an allowed and a rejected option", () => {
    expect(
      verdict(
        one({ security_opt: ["no-new-privileges:true", "seccomp=default"] }),
      ),
    ).toBe("compose_forbidden");
  });
});

describe("absolute paths in file references", () => {
  test.each([
    ["an env_file", { env_file: ["/stage/infra/app.env"] }],
    ["a build context", { build: { context: "/stage/infra/worker" } }],
    [
      "a dockerfile",
      {
        build: {
          context: "./worker",
          dockerfile: "/stage/infra/worker/Dockerfile",
        },
      },
    ],
    [
      "an additional context",
      {
        build: {
          context: "./worker",
          additional_contexts: { x: "/stage/infra/x" },
        },
      },
    ],
  ])("rejects %s inside the logical root", (_name, service) => {
    expect(verdict(one(service))).toBe("compose_forbidden");
  });

  test("rejects a top-level secret file inside the logical root", () => {
    expect(
      verdict(
        one({ secrets: ["s"] }, { secrets: { s: { file: "/stage/infra/s" } } }),
      ),
    ).toBe("compose_forbidden");
  });

  test("rejects a top-level config file inside the logical root", () => {
    expect(
      verdict(
        one({ configs: ["c"] }, { configs: { c: { file: "/stage/infra/c" } } }),
      ),
    ).toBe("compose_forbidden");
  });

  test("rejects an env_file object with an absolute path", () => {
    expect(verdict(one({ env_file: [{ path: "/stage/infra/app.env" }] }))).toBe(
      "compose_forbidden",
    );
  });

  test("still accepts a relative env_file", () => {
    expect(verdict(one({ env_file: ["./app.env"] }))).toBe("ok");
  });
});

describe("top-level volumes and networks", () => {
  test("accepts a named volume with the local driver", () => {
    expect(verdict(one({}, { volumes: { v: { driver: "local" } } }))).toBe(
      "ok",
    );
  });

  test("rejects a driver that is not local", () => {
    expect(verdict(one({}, { volumes: { v: { driver: "nfs" } } }))).toBe(
      "compose_forbidden",
    );
  });

  test("rejects driver_opts", () => {
    expect(
      verdict(
        one(
          {},
          {
            volumes: {
              v: {
                driver: "local",
                driver_opts: { type: "none", o: "bind", device: "/" },
              },
            },
          },
        ),
      ),
    ).toBe("compose_forbidden");
  });

  test("rejects an external volume", () => {
    expect(verdict(one({}, { volumes: { v: { external: true } } }))).toBe(
      "compose_forbidden",
    );
  });

  test("rejects a network with driver_opts", () => {
    expect(
      verdict(
        one(
          {},
          {
            networks: {
              n: { driver: "bridge", driver_opts: { parent: "en0" } },
            },
          },
        ),
      ),
    ).toBe("compose_forbidden");
  });

  test("accepts a bridge network", () => {
    expect(verdict(one({}, { networks: { n: { driver: "bridge" } } }))).toBe(
      "ok",
    );
  });
});

describe("input shape", () => {
  test("rejects a document that is not an object", () => {
    expect(verdict("services: {}")).toBe("compose_forbidden");
  });

  test("rejects a document without services", () => {
    expect(verdict({ volumes: {} })).toBe("compose_forbidden");
  });
});
