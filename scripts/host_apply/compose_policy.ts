/** composeの定義を静的に検査する。許可する形を列挙し、未知のキーは拒否する。 */

import { isAbsolute, relative, resolve } from "node:path";

export const COMPOSE_SERVICE_ALLOWLIST: readonly string[] = [
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
];

export type ComposeVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly kind: "unknown_service" | "compose_forbidden";
      readonly detail: string;
    };

export type ComposeContext = {
  /** ステージング(チェックアウト)のルートの絶対パス。 */
  readonly root: string;
  /** composeファイルがあるディレクトリの絶対パス。相対パスの基準になる。 */
  readonly composeDir: string;
  /** 変数の展開に使う値。静的に読んだ、列挙したキーだけを渡す。 */
  readonly env: Readonly<Record<string, string>>;
};

/** サービスに書いてよいキー。ここに無いキーは拒否する。 */
const SERVICE_KEYS: ReadonlySet<string> = new Set([
  "image",
  "pull_policy",
  "build",
  "deploy",
  "restart",
  "init",
  "expose",
  "ports",
  "environment",
  "env_file",
  "depends_on",
  "volumes",
  "logging",
  "security_opt",
  "cap_drop",
  "entrypoint",
  "command",
  "user",
  "network_mode",
  "read_only",
  "tmpfs",
  "networks",
  "healthcheck",
  "shm_size",
  "stop_grace_period",
  "working_dir",
  "hostname",
  "labels",
  "secrets",
  "configs",
  "pid",
  "ipc",
  "uts",
]);

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "services",
  "volumes",
  "networks",
  "secrets",
  "configs",
]);

const BUILD_KEYS: ReadonlySet<string> = new Set([
  "context",
  "dockerfile",
  "args",
  "target",
  "additional_contexts",
  "labels",
]);

const MOUNT_KEYS: ReadonlySet<string> = new Set([
  "type",
  "source",
  "target",
  "read_only",
  "volume",
  "bind",
  "tmpfs",
  "consistency",
]);

const PORT_KEYS: ReadonlySet<string> = new Set([
  "target",
  "published",
  "host_ip",
  "protocol",
  "mode",
  "name",
  "app_protocol",
]);

const DEPLOY_KEYS: ReadonlySet<string> = new Set([
  "replicas",
  "resources",
  "restart_policy",
  "labels",
]);

/** 書き込み可能でも、チェックアウトの中でbindしてよいファイル(ルートからの相対パス)。 */
const BIND_ALLOWLIST: readonly string[] = ["infra/Caddyfile"];

const LOGGING_DRIVERS: readonly string[] = ["json-file", "local"];

class Violation extends Error {
  readonly kind: "unknown_service" | "compose_forbidden";

  constructor(kind: "unknown_service" | "compose_forbidden", detail: string) {
    super(detail);
    this.kind = kind;
  }
}

function forbid(detail: string): never {
  throw new Violation("compose_forbidden", detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExtensionKey(key: string): boolean {
  return key.startsWith("x-");
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) return forbid(`${what} must be a mapping`);
  return value;
}

function requireKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  what: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key) && !isExtensionKey(key)) {
      forbid(`${what} has a key that is not allowed: ${key}`);
    }
  }
}

/**
 * composeの`${VAR}`形式の変数を展開する。
 * 値が無く、既定値も無い変数は、評価できないので拒否する。展開後に`$`が残る値も拒否する。
 */
function expand(value: string, env: Readonly<Record<string, string>>): string {
  const expanded = value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])([^}]*))?\}/g,
    (_match, name: string, op: string | undefined, arg: string | undefined) => {
      const current = env[name];
      const unset =
        op?.startsWith(":") === true
          ? current === undefined || current === ""
          : current === undefined;
      if (!unset && current !== undefined) return current;
      if (op === ":-" || op === "-") return arg ?? "";
      return forbid(`variable ${name} is not set`);
    },
  );
  if (expanded.includes("$")) forbid("a value has an unresolved variable");
  return expanded;
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel))
  );
}

/** 変数を展開し、`composeDir`を基準に解決した絶対パスを返す。`~`で始まる値は拒否する。 */
function resolveLocal(
  value: string,
  context: ComposeContext,
  base: string = context.composeDir,
): string {
  const expanded = expand(value, context.env);
  if (expanded.startsWith("~")) forbid("a path starts with ~");
  return resolve(base, expanded);
}

function requireInside(
  value: string,
  context: ComposeContext,
  what: string,
  base?: string,
): string {
  const path = resolveLocal(value, context, base);
  if (!isInside(context.root, path)) forbid(`${what} leaves the checkout`);
  return path;
}

const REMOTE_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|git@|github\.com\/)/i;

function isRemote(value: string): boolean {
  return REMOTE_PATTERN.test(value);
}

function checkNamespace(key: string, value: unknown): void {
  if (typeof value !== "string") forbid(`${key} must be a string`);
  if (
    value === "host" ||
    value.startsWith("container:") ||
    value.startsWith("service:")
  ) {
    forbid(`${key} shares a namespace: ${value}`);
  }
}

function checkSecurityOpt(value: unknown): void {
  if (!Array.isArray(value)) forbid("security_opt must be a list");
  for (const option of value) {
    if (typeof option !== "string") forbid("security_opt must be strings");
    if (option.includes("unconfined") || /label[=:]disable/.test(option)) {
      forbid(`security_opt weakens isolation: ${option}`);
    }
  }
}

function checkPorts(value: unknown, context: ComposeContext): void {
  if (!Array.isArray(value)) forbid("ports must be a list");
  for (const entry of value) {
    if (typeof entry === "string") {
      const parts = expand(entry, context.env).split(":");
      if (parts.length !== 3 || parts[0] !== "127.0.0.1") {
        forbid("a port is not bound to 127.0.0.1");
      }
    } else if (isRecord(entry)) {
      requireKeys(entry, PORT_KEYS, "a port");
      const hostIp = entry.host_ip;
      if (
        typeof hostIp !== "string" ||
        expand(hostIp, context.env) !== "127.0.0.1"
      ) {
        forbid("a port is not bound to 127.0.0.1");
      }
    } else {
      forbid("a port has an unexpected form");
    }
  }
}

function checkEnvFile(value: unknown, context: ComposeContext): void {
  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    if (typeof entry === "string") {
      requireInside(entry, context, "env_file");
    } else if (isRecord(entry) && typeof entry.path === "string") {
      requireInside(entry.path, context, "env_file");
    } else {
      forbid("env_file has an unexpected form");
    }
  }
}

function checkContextValue(
  value: unknown,
  context: ComposeContext,
  what: string,
): string {
  if (typeof value !== "string") return forbid(`${what} must be a string`);
  if (isRemote(expand(value, context.env))) {
    forbid(`${what} is remote`);
  }
  return requireInside(value, context, what);
}

function checkAdditionalContexts(
  value: unknown,
  context: ComposeContext,
): void {
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      checkContextValue(item, context, "an additional context");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "string" || !item.includes("=")) {
        forbid("an additional context has an unexpected form");
      }
      checkContextValue(
        item.slice(item.indexOf("=") + 1),
        context,
        "an additional context",
      );
    }
    return;
  }
  forbid("additional_contexts has an unexpected form");
}

function checkBuild(value: unknown, context: ComposeContext): void {
  if (typeof value === "string") {
    checkContextValue(value, context, "the build context");
    return;
  }
  const build = requireRecord(value, "build");
  requireKeys(build, BUILD_KEYS, "build");
  const contextDir = checkContextValue(
    build.context,
    context,
    "the build context",
  );
  if (build.dockerfile !== undefined) {
    if (typeof build.dockerfile !== "string")
      forbid("dockerfile must be a string");
    requireInside(build.dockerfile, context, "the dockerfile", contextDir);
  }
  if (build.additional_contexts !== undefined) {
    checkAdditionalContexts(build.additional_contexts, context);
  }
}

function checkBind(
  source: string,
  readOnly: boolean,
  context: ComposeContext,
): void {
  const path = requireInside(source, context, "a bind mount source");
  const rel = relative(context.root, path);
  if (!readOnly && !BIND_ALLOWLIST.includes(rel)) {
    forbid(`a writable bind mount is not allowed: ${rel}`);
  }
}

const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function checkShortVolume(entry: string, context: ComposeContext): void {
  const parts = entry.split(":");
  if (parts.length === 1) return;
  const source = expand(parts[0] ?? "", context.env);
  const readOnly = (parts[2] ?? "").split(",").includes("ro");
  if (/^[./~]/.test(source)) {
    checkBind(source, readOnly, context);
  } else if (!VOLUME_NAME.test(source)) {
    forbid("a volume name has an unexpected form");
  }
}

function checkLongVolume(
  entry: Record<string, unknown>,
  context: ComposeContext,
): void {
  requireKeys(entry, MOUNT_KEYS, "a mount");
  const type = entry.type;
  if (type === "tmpfs") return;
  if (typeof entry.source !== "string") forbid("a mount has no source");
  if (type === "volume") {
    if (!VOLUME_NAME.test(expand(entry.source, context.env))) {
      forbid("a volume name has an unexpected form");
    }
    return;
  }
  if (type === "bind") {
    checkBind(entry.source, entry.read_only === true, context);
    return;
  }
  forbid(`a mount type is not allowed: ${String(type)}`);
}

function checkVolumes(value: unknown, context: ComposeContext): void {
  if (!Array.isArray(value)) forbid("volumes must be a list");
  for (const entry of value) {
    if (typeof entry === "string") checkShortVolume(entry, context);
    else if (isRecord(entry)) checkLongVolume(entry, context);
    else forbid("a mount has an unexpected form");
  }
}

function checkReferences(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  what: string,
): void {
  if (!Array.isArray(value)) forbid(`${what} must be a list`);
  for (const entry of value) {
    if (typeof entry === "string") continue;
    requireKeys(requireRecord(entry, what), allowedKeys, what);
  }
}

const REFERENCE_KEYS: ReadonlySet<string> = new Set([
  "source",
  "target",
  "uid",
  "gid",
  "mode",
]);

function checkDeploy(value: unknown): void {
  const deploy = requireRecord(value, "deploy");
  requireKeys(deploy, DEPLOY_KEYS, "deploy");
  if (deploy.resources !== undefined) {
    const resources = requireRecord(deploy.resources, "deploy.resources");
    requireKeys(resources, new Set(["limits", "reservations"]), "resources");
  }
}

function checkLogging(value: unknown): void {
  const logging = requireRecord(value, "logging");
  requireKeys(logging, new Set(["driver", "options"]), "logging");
  if (
    typeof logging.driver !== "string" ||
    !LOGGING_DRIVERS.includes(logging.driver)
  ) {
    forbid("the logging driver is not allowed");
  }
}

function checkService(
  service: Record<string, unknown>,
  context: ComposeContext,
): void {
  requireKeys(service, SERVICE_KEYS, "a service");
  for (const key of ["pid", "ipc", "uts", "network_mode"]) {
    if (service[key] !== undefined) checkNamespace(key, service[key]);
  }
  if (service.security_opt !== undefined) {
    checkSecurityOpt(service.security_opt);
  }
  if (service.ports !== undefined) checkPorts(service.ports, context);
  if (service.env_file !== undefined) checkEnvFile(service.env_file, context);
  if (service.build !== undefined) checkBuild(service.build, context);
  if (service.volumes !== undefined) checkVolumes(service.volumes, context);
  if (service.secrets !== undefined) {
    checkReferences(service.secrets, REFERENCE_KEYS, "secrets");
  }
  if (service.configs !== undefined) {
    checkReferences(service.configs, REFERENCE_KEYS, "configs");
  }
  if (service.deploy !== undefined) checkDeploy(service.deploy);
  if (service.logging !== undefined) checkLogging(service.logging);
}

function checkFileDefinitions(
  value: unknown,
  context: ComposeContext,
  what: string,
): void {
  const definitions = requireRecord(value, what);
  for (const definition of Object.values(definitions)) {
    const entry = requireRecord(definition, `a ${what} entry`);
    requireKeys(entry, new Set(["file"]), `a ${what} entry`);
    if (typeof entry.file !== "string") forbid(`a ${what} entry has no file`);
    requireInside(entry.file, context, `a ${what} file`);
  }
}

function checkNamedDefinitions(
  value: unknown,
  allowed: ReadonlySet<string>,
  driver: string,
  what: string,
): void {
  const definitions = requireRecord(value, what);
  for (const definition of Object.values(definitions)) {
    if (definition === null) continue;
    const entry = requireRecord(definition, `a ${what} entry`);
    requireKeys(entry, allowed, `a ${what} entry`);
    if (entry.driver !== undefined && entry.driver !== driver) {
      forbid(`a ${what} driver is not ${driver}`);
    }
  }
}

function validate(parsed: unknown, context: ComposeContext): void {
  const document = requireRecord(parsed, "the document");
  requireKeys(document, TOP_LEVEL_KEYS, "the document");
  const services = requireRecord(document.services, "services");
  for (const name of Object.keys(services)) {
    if (!COMPOSE_SERVICE_ALLOWLIST.includes(name)) {
      throw new Violation("unknown_service", `service is not allowed: ${name}`);
    }
  }
  if (JSON.stringify(parsed).includes("docker.sock")) {
    forbid("the docker socket is referenced");
  }
  for (const service of Object.values(services)) {
    checkService(requireRecord(service, "a service"), context);
  }
  if (document.volumes !== undefined) {
    checkNamedDefinitions(
      document.volumes,
      new Set(["driver", "labels"]),
      "local",
      "volume",
    );
  }
  if (document.networks !== undefined) {
    checkNamedDefinitions(
      document.networks,
      new Set(["driver", "internal", "labels"]),
      "bridge",
      "network",
    );
  }
  if (document.secrets !== undefined) {
    checkFileDefinitions(document.secrets, context, "secret");
  }
  if (document.configs !== undefined) {
    checkFileDefinitions(document.configs, context, "config");
  }
}

/**
 * composeの定義が方針を満たすかを返す。
 * サービス名は許可リストにあること。キーは許可する形だけにする。
 * 特権、名前空間の共有、`127.0.0.1`以外のポート、チェックアウトの外のパスと書き込み可能なbind、
 * リモートのbuild context、外部やdriver_optsを持つボリュームと`docker.sock`を拒否する。
 * 静的な検査なので、パスの途中のsymlinkは見ない。変数は`context.env`で展開する。
 */
export function checkCompose(
  parsed: unknown,
  context: ComposeContext,
): ComposeVerdict {
  try {
    validate(parsed, context);
    return { ok: true };
  } catch (error) {
    if (error instanceof Violation) {
      return { ok: false, kind: error.kind, detail: error.message };
    }
    throw error;
  }
}
