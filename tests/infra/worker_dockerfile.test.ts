import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// workerのイメージの構成を静的に確かめる。
// workerのPATHにrootのホームを入れないこと、検査コマンド用の非特権ユーザーを
// 固定のuidで作ることが境界の要なので、Dockerfileの編集で崩れたらここで落とす。
const REPO_ROOT = join(import.meta.dir, "../..");

/**
 * Dockerfileから、コメントを除き、行末の`\`でつながる行を1つにした命令の一覧を返す。
 */
function instructions(): string[] {
  const text = readFileSync(join(REPO_ROOT, "infra/worker/Dockerfile"), "utf8");
  const result: string[] = [];
  let current = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (current === "" && (line === "" || line.startsWith("#"))) continue;
    if (line.endsWith("\\")) {
      current += `${line.slice(0, -1).trim()} `;
      continue;
    }
    result.push(`${current}${line}`.trim());
    current = "";
  }
  return result;
}

function startingWith(keyword: string): string[] {
  return instructions().filter((line) => line.startsWith(`${keyword} `));
}

describe("infra/worker/Dockerfile PATH", () => {
  test("sets PATH explicitly instead of inheriting the base image's", () => {
    const pathEnvs = startingWith("ENV").filter((line) => /\sPATH=/.test(line));
    expect(pathEnvs).toHaveLength(1);
  });

  test("keeps /root/.local/bin out of the PATH", () => {
    const pathEnv = startingWith("ENV").find((line) => /\sPATH=/.test(line));
    expect(pathEnv).not.toContain("/root/.local/bin");
  });

  test("keeps /usr/local/bin in the PATH so the claude symlink resolves by name", () => {
    const pathEnv = startingWith("ENV").find((line) => /\sPATH=/.test(line));
    expect(pathEnv).toContain("/usr/local/bin");
  });

  test("links claude into /usr/local/bin", () => {
    const linked = startingWith("RUN").some((line) =>
      /ln -sf? \/root\/\.local\/bin\/claude \/usr\/local\/bin\/claude/.test(
        line,
      ),
    );
    expect(linked).toBe(true);
  });
});

describe("infra/worker/Dockerfile check user", () => {
  test("creates factory-check with the fixed uid 10001, no home and no login shell", () => {
    const created = startingWith("RUN").some((line) =>
      line.includes("useradd -u 10001 -M -s /usr/sbin/nologin factory-check"),
    );
    expect(created).toBe(true);
  });

  test("installs util-linux for setpriv", () => {
    const installed = startingWith("RUN").some(
      (line) => line.includes("apt-get install") && /\sutil-linux\b/.test(line),
    );
    expect(installed).toBe(true);
  });

  test("installs procps for pkill", () => {
    const installed = startingWith("RUN").some(
      (line) => line.includes("apt-get install") && /\sprocps\b/.test(line),
    );
    expect(installed).toBe(true);
  });

  test("verifies at build time that setpriv can drop to the check uid", () => {
    const verified = startingWith("RUN").some((line) =>
      line.includes(
        "setpriv --reuid=10001 --regid=10001 --clear-groups -- id -u",
      ),
    );
    expect(verified).toBe(true);
  });

  test("does not switch the image to a non-root USER", () => {
    expect(startingWith("USER")).toEqual([]);
  });
});
