// メタデータのパッチの検査のテストで共有する、bun.lockの形のlockの組み立て。

export const INTEGRITY = `sha512-${"A".repeat(86)}==`;
export const OTHER_INTEGRITY = `sha512-${"B".repeat(86)}==`;

export type PackageSpec = {
  readonly key?: string;
  readonly ident?: string;
  readonly registry?: string;
  readonly meta?: unknown;
  readonly integrity?: string;
};

/** bun.lockの形のロックを組み立てる。`front`と`back`で、それぞれの構造を差し替えられる。 */
export function buildLock(
  options: {
    readonly front?: unknown;
    readonly back?: unknown;
    readonly packages?: Record<string, PackageSpec | unknown[]>;
    readonly deps?: Record<string, string>;
  } = {},
): string {
  const deps = options.deps ?? { "left-pad": "1.3.0" };
  const front = options.front ?? { dependencies: deps };
  const packages = options.packages ?? {
    "left-pad": { ident: "left-pad@1.3.0" },
  };
  const entries: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(packages)) {
    if (Array.isArray(spec)) {
      entries[key] = spec;
      continue;
    }
    entries[key] = [
      spec.ident ?? `${key}@1.0.0`,
      spec.registry ?? "",
      spec.meta ?? {},
      spec.integrity ?? INTEGRITY,
    ];
  }
  const back = options.back ?? {
    lockfileVersion: 2,
    configVersion: 1,
    workspaces: { "": { dependencies: deps } },
    packages: entries,
  };
  return `${JSON.stringify(front, null, 2)}\n//bun.lock\n${JSON.stringify(back, null, 2)}`;
}
