#!/usr/bin/env bun
// console/bun.lockの依存の取得元を検査する。
// Consoleのバンドルは運用者のブラウザで同じオリジンのまま動くので、依存はregistryから
// integrity付きで取ったものに限る。git・GitHub・tarballのURLと、console/の外を指す
// file:・link:は、内容の固定がregistryより弱いか、リポジトリの外のコードを取り込むため拒む。
// 使い方: bun run scripts/check-console-lockfile.ts [path](既定はconsole/bun.lock)
// 違反を`path: key: reason`の形で出力して終了コード1、無ければ0。

export type SpecifierKind = "registry" | "local" | "forbidden";

export type LockfileViolation = {
  readonly key: string;
  readonly reason: string;
};

const FORBIDDEN_PREFIXES: readonly string[] = [
  "git+",
  "git:",
  "github:",
  "gitlab:",
  "bitbucket:",
  "http:",
  "https:",
  "workspace:",
];

const LOCAL_PREFIXES: readonly string[] = ["file:", "link:"];

const DEPENDENCY_FIELDS: readonly string[] = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `file:`・`link:`の後のパスが、console/の中に留まる相対パスかを返す。 */
function isInsideConsole(path: string): boolean {
  if (path.length === 0) return false;
  if (path.startsWith("/") || path.startsWith("~") || path.includes("\\")) {
    return false;
  }
  if (/^[A-Za-z]:/.test(path)) return false;
  return !path.split("/").includes("..");
}

/**
 * 依存の指定(package.jsonの値、またはbun.lockの`name@resolution`の`resolution`)を分類する。
 * `/`を含む指定は、`npm:`の別名を除いてGitHubの省略形かパスなので拒む。
 */
export function classifySpecifier(specifier: string): SpecifierKind {
  if (FORBIDDEN_PREFIXES.some((prefix) => specifier.startsWith(prefix))) {
    return "forbidden";
  }
  for (const prefix of LOCAL_PREFIXES) {
    if (specifier.startsWith(prefix)) {
      return isInsideConsole(specifier.slice(prefix.length))
        ? "local"
        : "forbidden";
    }
  }
  if (specifier.startsWith("npm:")) return "registry";
  return specifier.includes("/") ? "forbidden" : "registry";
}

/**
 * bun.lockの`packages`の1項目を検査し、違反の理由を返す。問題が無ければ`null`。
 * registryの項目は`["name@version", "", {...}, "sha512-..."]`の形で、
 * 2番目の空文字は既定のregistryを表す。
 */
export function checkPackageEntry(entry: unknown): string | null {
  if (!Array.isArray(entry)) return "package entry is malformed";
  const id: unknown = entry[0];
  if (typeof id !== "string") return "package entry is malformed";
  const at = id.indexOf("@", id.startsWith("@") ? 1 : 0);
  if (at <= 0) return "package id has no resolution";
  const kind = classifySpecifier(id.slice(at + 1));
  if (kind === "forbidden") return "package is not resolved from the registry";
  if (kind === "local") return null;
  const registry: unknown = entry[1];
  if (registry !== "") return "package is resolved from a non-default registry";
  const integrity: unknown = entry[3];
  if (typeof integrity !== "string" || !SHA512_INTEGRITY.test(integrity)) {
    return "package has no sha512 integrity";
  }
  return null;
}

function checkWorkspaces(workspaces: unknown): LockfileViolation[] {
  if (!isRecord(workspaces)) {
    return [{ key: "workspaces", reason: "workspaces is missing" }];
  }
  const violations: LockfileViolation[] = [];
  for (const [name, workspace] of Object.entries(workspaces)) {
    if (name !== "") {
      violations.push({
        key: `workspaces.${name}`,
        reason: "the console must not have extra workspaces",
      });
      continue;
    }
    if (!isRecord(workspace)) {
      violations.push({
        key: 'workspaces.""',
        reason: "workspace is malformed",
      });
      continue;
    }
    for (const field of DEPENDENCY_FIELDS) {
      const dependencies = workspace[field];
      if (dependencies === undefined) continue;
      if (!isRecord(dependencies)) {
        violations.push({
          key: `workspaces."".${field}`,
          reason: "dependency list is malformed",
        });
        continue;
      }
      for (const [dependency, specifier] of Object.entries(dependencies)) {
        if (
          typeof specifier !== "string" ||
          classifySpecifier(specifier) === "forbidden"
        ) {
          violations.push({
            key: `workspaces."".${field}.${dependency}`,
            reason:
              "dependency must be a registry version or a path inside console/",
          });
        }
      }
    }
  }
  return violations;
}

/** 解析済みのbun.lock全体を検査し、違反の一覧を返す。 */
export function checkConsoleLockfile(lock: unknown): LockfileViolation[] {
  if (!isRecord(lock)) {
    return [{ key: "<root>", reason: "lockfile is not an object" }];
  }
  const violations: LockfileViolation[] = [];
  if (typeof lock.lockfileVersion !== "number") {
    violations.push({
      key: "lockfileVersion",
      reason: "lockfileVersion is missing",
    });
  }
  if ("trustedDependencies" in lock) {
    violations.push({
      key: "trustedDependencies",
      reason: "trustedDependencies lets dependency install scripts run",
    });
  }
  violations.push(...checkWorkspaces(lock.workspaces));
  const packages = lock.packages;
  if (!isRecord(packages)) {
    violations.push({ key: "packages", reason: "packages is missing" });
    return violations;
  }
  for (const [key, entry] of Object.entries(packages)) {
    const reason = checkPackageEntry(entry);
    if (reason !== null) violations.push({ key: `packages.${key}`, reason });
  }
  return violations;
}

async function main(): Promise<void> {
  const path = process.argv[2] ?? "console/bun.lock";
  const file = Bun.file(path);
  if (!(await file.exists())) {
    console.error(`${path}: lockfile not found`);
    process.exit(1);
  }
  const lock: unknown = Bun.JSONC.parse(await file.text());
  const violations = checkConsoleLockfile(lock);
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`${path}: ${violation.key}: ${violation.reason}`);
    }
    console.error(`\nFound ${violations.length} lockfile policy violation(s).`);
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
