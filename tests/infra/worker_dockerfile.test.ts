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

/** `ENV PATH="..."`の値を`:`で分けた一覧を返す。無ければ空の配列を返す。 */
function pathDirs(): string[] {
  const pathEnv = startingWith("ENV").find((line) => /\sPATH=/.test(line));
  const value = /\sPATH="?([^"\s]*)"?/.exec(pathEnv ?? "")?.[1] ?? "";
  return value.split(":").filter((dir) => dir !== "");
}

describe("infra/worker/Dockerfile PATH", () => {
  test("sets PATH explicitly instead of inheriting the base image's", () => {
    const pathEnvs = startingWith("ENV").filter((line) => /\sPATH=/.test(line));
    expect(pathEnvs).toHaveLength(1);
  });

  test("keeps /root/.local/bin out of the PATH", () => {
    expect(pathDirs()).not.toContain("/root/.local/bin");
  });

  test("keeps every directory under /tmp out of the PATH", () => {
    expect(pathDirs().filter((dir) => dir.startsWith("/tmp"))).toEqual([]);
  });

  test("keeps the directories the worker's tools live in", () => {
    const required = [
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/local/go/bin",
    ];
    expect(required.filter((dir) => !pathDirs().includes(dir))).toEqual([]);
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

  test("verifies at build time that setpriv drops to the check uid", () => {
    const verified = startingWith("RUN").some((line) =>
      line.includes(
        '[ "$(setpriv --reuid=10001 --regid=10001 --clear-groups -- id -u)" = 10001 ]',
      ),
    );
    expect(verified).toBe(true);
  });

  test("does not switch the image to a non-root USER", () => {
    expect(startingWith("USER")).toEqual([]);
  });
});
