import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Console用workerの構成を静的に確かめる。
// 書き込みマウントを持たないことと、factory_workspacesを共有しないことが境界の要なので、
// composeの編集で崩れたらここで落とす。
const REPO_ROOT = join(import.meta.dir, "../..");

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function service(name: string): Json {
  const parsed: unknown = Bun.YAML.parse(
    readFileSync(join(REPO_ROOT, "infra/docker-compose.yml"), "utf8"),
  );
  if (!isRecord(parsed) || !isRecord(parsed.services)) return {};
  const found = parsed.services[name];
  return isRecord(found) ? found : {};
}

function stringList(svc: Json, key: string): string[] {
  const value = svc[key];
  return isStringArray(value) ? value : [];
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

  test("uses the upstream image pinned by WM_VERSION like the native worker", () => {
    const svc = service("windmill_worker_console");
    const native = service("windmill_worker_native");

    expect(svc.image).toBe(native.image);
  });

  test("uses the upstream windmill image", () => {
    const svc = service("windmill_worker_console");

    expect(svc.image).toStartWith(
      "ghcr.io/windmill-labs/windmill:${WM_VERSION",
    );
  });

  test("runs in worker mode", () => {
    const svc = service("windmill_worker_console");

    expect(stringList(svc, "environment")).toContain("MODE=worker");
  });

  test("belongs to the console worker group", () => {
    const svc = service("windmill_worker_console");

    expect(stringList(svc, "environment")).toContain("WORKER_GROUP=console");
  });

  test("accepts only the console tag", () => {
    const svc = service("windmill_worker_console");

    expect(stringList(svc, "environment")).toContain("WORKER_TAGS=console");
  });

  test("runs a single worker process", () => {
    const svc = service("windmill_worker_console");

    expect(stringList(svc, "environment")).toContain("NUM_WORKERS=1");
  });

  test("connects to the database like the other workers", () => {
    const svc = service("windmill_worker_console");
    const native = service("windmill_worker_native");
    const dbUrl = (s: Json) =>
      stringList(s, "environment").filter((e) => e.startsWith("DATABASE_URL="));

    expect(dbUrl(svc)).toEqual(dbUrl(native));
  });

  test("limits memory to 512M", () => {
    const svc = service("windmill_worker_console");

    expect(limits(svc).memory).toBe("512M");
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

    expect(stringList(svc, "volumes")).toContain(
      "factory_console:/srv/console:ro",
    );
  });

  test("mounts factory_state read-only at /var/lib/factory", () => {
    const svc = service("windmill_worker_console");

    expect(stringList(svc, "volumes")).toContain(
      "factory_state:/var/lib/factory:ro",
    );
  });

  test("mounts worker_logs like the native worker", () => {
    const svc = service("windmill_worker_console");

    expect(stringList(svc, "volumes")).toContain(
      "worker_logs:/tmp/windmill/logs",
    );
  });

  test("does not mount factory_workspaces", () => {
    const svc = service("windmill_worker_console");

    expect(
      stringList(svc, "volumes").filter((v) =>
        v.startsWith("factory_workspaces"),
      ),
    ).toEqual([]);
  });

  test("does not share worker_dependency_cache", () => {
    const svc = service("windmill_worker_console");

    expect(
      stringList(svc, "volumes").filter((v) =>
        v.startsWith("worker_dependency_cache"),
      ),
    ).toEqual([]);
  });

  test("does not mount the docker socket", () => {
    const svc = service("windmill_worker_console");

    expect(
      stringList(svc, "volumes").filter((v) => v.includes("docker.sock")),
    ).toEqual([]);
  });

  test("mounts nothing writable other than worker_logs", () => {
    const svc = service("windmill_worker_console");

    const writable = stringList(svc, "volumes").filter(
      (v) => !v.endsWith(":ro") && !v.startsWith("worker_logs:"),
    );

    expect(writable).toEqual([]);
  });
});
