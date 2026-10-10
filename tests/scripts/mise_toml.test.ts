import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ホストのgitleaks(`[tools]`、pre-commitフックが使う)と、
// workerイメージのgitleaks(`[env]`の`GITLEAKS_VERSION`、Dockerfileのビルド引数)は
// 同じバージョンでなければならない。
// 違うと、implementフローの固定の検査とローカルのフックで、
// 漏洩の判定が食い違いうる。
describe("mise.toml", () => {
  test("pins the same gitleaks version in [tools] and [env]", () => {
    const text = readFileSync(join(import.meta.dir, "../../mise.toml"), "utf8");
    const toolsSection =
      text.match(/^\[tools\]\n([\s\S]*?)(?=^\[)/m)?.[1] ?? "";
    const envSection = text.match(/^\[env\]\n([\s\S]*?)(?=^\[)/m)?.[1] ?? "";
    const toolsVersion = toolsSection.match(/^gitleaks = "([^"]+)"$/m)?.[1];
    const envVersion = envSection.match(/^GITLEAKS_VERSION = "([^"]+)"$/m)?.[1];
    // バージョンの形式を照合するので、両方の項目が無い(どちらもundefined)場合も
    // 等しいとはみなさず失敗する。
    expect([toolsVersion, envVersion]).toEqual([
      expect.stringMatching(/^\d+\.\d+\.\d+$/),
      toolsVersion,
    ]);
  });
});

// スタックを起動するタスクは、起動の前にDockerの版を確かめる。
// 下限を満たさないEngineは`volume.subpath`を黙って無視し、
// Console用workerに`factory_state`の根が付きうるため。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function taskRuns(): Map<string, string[]> {
  const text = readFileSync(join(import.meta.dir, "../../mise.toml"), "utf8");
  const parsed: unknown = Bun.TOML.parse(text);
  const tasks = isRecord(parsed) ? parsed.tasks : undefined;
  if (!isRecord(tasks)) {
    throw new Error("mise.toml has no tasks");
  }
  const runs = new Map<string, string[]>();
  for (const [name, task] of Object.entries(tasks)) {
    if (isRecord(task) && typeof task.run === "string") {
      runs.set(
        name,
        task.run.split("\n").filter((line) => line.trim() !== ""),
      );
    }
  }
  return runs;
}

describe("mise.toml stack tasks", () => {
  const CHECK = "scripts/check-docker-version.sh";
  const isComposeUp = (line: string) => /docker compose\b.*\bup\b/.test(line);

  test("up checks the Docker version first", () => {
    expect(taskRuns().get("up")?.[0]).toBe(CHECK);
  });

  test("deploy checks the Docker version right after git pull", () => {
    const lines = taskRuns().get("deploy") ?? [];
    expect(lines[lines.indexOf(CHECK) - 1]).toBe("git pull --ff-only");
  });

  test("every task that runs docker compose up checks the Docker version before it", () => {
    const unchecked = [...taskRuns()]
      .filter(([, lines]) => lines.some(isComposeUp))
      .filter(([, lines]) => {
        const check = lines.indexOf(CHECK);
        return check === -1 || check > lines.findIndex(isComposeUp);
      })
      .map(([name]) => name);

    expect(unchecked).toEqual([]);
  });
});
