import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// console_fetcherのイメージのbunは、ホストのbun(mise.tomlの[tools])と同じ版にし、digestで固定する。
// 版がずれると、テストを通したbunと本番で動くbunが食い違う。
const REPO_ROOT = join(import.meta.dir, "../..");
const miseToml = readFileSync(join(REPO_ROOT, "mise.toml"), "utf8");
const dockerfile = readFileSync(
  join(REPO_ROOT, "infra/console_fetcher/Dockerfile"),
  "utf8",
);
const bunVersion = /^bun = "([^"]+)"$/m.exec(miseToml)?.[1] ?? "<missing>";

describe("infra/console_fetcher/Dockerfile", () => {
  test("uses the slim bun image of the mise bun version pinned by digest", () => {
    expect(dockerfile).toMatch(
      new RegExp(
        `^FROM oven/bun:${bunVersion.replaceAll(".", "\\.")}-slim@sha256:[0-9a-f]{64}$`,
        "m",
      ),
    );
  });

  test("runs as the non-root bun user", () => {
    expect(dockerfile).toMatch(/^USER bun$/m);
  });

  test("starts bun with auto-install disabled", () => {
    expect(dockerfile).toContain(
      'ENTRYPOINT ["bun", "--no-install", "/app/main.ts"]',
    );
  });
});
