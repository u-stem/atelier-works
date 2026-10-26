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
// Console用workerに`factory_state`のボリューム全体がマウントされうるため。
// 検査に失敗したら必ず止まるよう、タスクの先頭で`set -e`を置く。
// miseの既定のシェルの引数が変わっても、検査の後の行へ進まないためである。
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
  const ERREXIT = "set -e";
  const isComposeUp = (line: string) => /docker compose\b.*\bup\b/.test(line);

  test("up sets errexit and then checks the Docker version first", () => {
    expect(taskRuns().get("up")?.slice(0, 2)).toEqual([ERREXIT, CHECK]);
  });

  test("deploy sets errexit on its first line", () => {
    expect(taskRuns().get("deploy")?.[0]).toBe(ERREXIT);
  });

  test("deploy checks the Docker version right after git pull", () => {
    const lines = taskRuns().get("deploy") ?? [];
    expect(lines[lines.indexOf(CHECK) - 1]).toBe("git pull --ff-only");
  });

  // ホスト側の作業が要る反映の通知は、この印で自動で解決される。
  // 起動のたびに印を書かないと、通知が残り続ける。
  // 印の後に続けてよいのは、旧イメージの掃除の1行だけにする。
  // 掃除は付随の処理なので、印の後に置き、失敗しても反映の記録に影響させない。
  const RECORD = "scripts/record-host-applied.sh";
  const PRUNE: Record<string, string> = {
    up: 'docker image prune -f --filter label=com.atelier-works.prune=true || echo "up: image prune failed (ignored)" >&2',
    deploy:
      'docker image prune -f --filter label=com.atelier-works.prune=true || echo "deploy: image prune failed (ignored)" >&2',
  };

  for (const task of ["up", "deploy"]) {
    const pruneLine = PRUNE[task] ?? "";

    test(`${task} records the applied version right before the image prune`, () => {
      const lines = taskRuns().get(task) ?? [];
      expect(lines.slice(-2)).toEqual([RECORD, pruneLine]);
    });

    test(`${task} runs the image prune only once`, () => {
      const lines = taskRuns().get(task) ?? [];
      expect(lines.filter((line) => line.includes("prune"))).toEqual([
        pruneLine,
      ]);
    });

    test(`${task} limits the image prune to the labeled images`, () => {
      const last = taskRuns().get(task)?.at(-1) ?? "";
      expect(last).toContain(
        "docker image prune -f --filter label=com.atelier-works.prune=true",
      );
    });

    test(`${task} does not run a broad prune`, () => {
      const last = taskRuns().get(task)?.at(-1) ?? "";
      expect(last).not.toMatch(/\s-a\b|--all|volume|system|builder/);
    });

    test(`${task} ignores a failed image prune`, () => {
      const last = taskRuns().get(task)?.at(-1) ?? "";
      expect(last).toMatch(/ \|\| echo "[^"]+" >&2$/);
    });
  }

  // Caddyfileは単一ファイルのbind mountなので、`up -d`はcaddyを作り直さない。
  // 再起動をはさまないと、古い設定のまま印が書かれ、通知が解決されてしまう。
  const RESTART_CADDY =
    "docker compose -f infra/docker-compose.yml restart caddy";
  // `restart`はコンテナを起動できれば0を返す。Caddyfileの誤りで直後に落ちても印が書かれないよう、
  // 再起動の後に、動いているCaddyが設定を読めることを確かめて、失敗したら止める。
  const VALIDATE_CADDY =
    "docker compose -f infra/docker-compose.yml exec -T caddy caddy validate --config /etc/caddy/Caddyfile";

  // 不正なCaddyfileのまま再起動すると、Caddyが落ちて再起動を繰り返し、公開の入口が止まる。
  // `up -d`はCaddyのイメージや設定が変わると作り直すので、`up -d`より前に、一時コンテナで確かめる。
  const PREVALIDATE_CADDY =
    "docker compose -f infra/docker-compose.yml run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile";

  // workerを作り直すと、実行中のジョブが止まる。作り直す`up -d`の直前に、実行中の仕事が無いことを確かめる。
  // 確認と作り直しの隙間を短くするため、取得とビルドは確認の前に済ませ、作り直しでは取得もビルドもしない。
  // dry-runが新しいイメージを見るよう、確認は取得とビルドの後に置く。
  // deployは、pullの後の確認で止まったことを知らせる印を付ける。
  const IDLE: Record<string, string> = {
    up: "bun ./scripts/check-idle.ts --when-worker-recreated",
    deploy: "bun ./scripts/check-idle.ts --when-worker-recreated --after-pull",
  };
  // upは、取得に失敗しても起動できるよう、失敗を無視する。緊急の復旧を、レジストリの障害で止めないため。
  // deployは、取得に失敗したら止まる。
  const PULL: Record<string, string> = {
    up: "docker compose -f infra/docker-compose.yml pull --ignore-pull-failures",
    deploy: "docker compose -f infra/docker-compose.yml pull",
  };
  const BUILD = "docker compose -f infra/docker-compose.yml build";

  for (const task of ["up", "deploy"]) {
    const idleLine = IDLE[task] ?? "";

    test(`${task} checks for running work right before compose up`, () => {
      const lines = taskRuns().get(task) ?? [];
      const up = lines.findIndex(isComposeUp);
      expect(lines.indexOf(idleLine)).toBe(up - 1);
    });

    test(`${task} has a pull line`, () => {
      expect(taskRuns().get(task)).toContain(PULL[task]);
    });

    test(`${task} pulls the images before checking for running work`, () => {
      const lines = taskRuns().get(task) ?? [];
      expect(lines.indexOf(PULL[task] ?? "")).toBeLessThan(
        lines.indexOf(idleLine),
      );
    });

    test(`${task} has a build line`, () => {
      expect(taskRuns().get(task)).toContain(BUILD);
    });

    test(`${task} builds every image before checking for running work`, () => {
      const lines = taskRuns().get(task) ?? [];
      expect(lines.indexOf(BUILD)).toBeLessThan(lines.indexOf(idleLine));
    });

    test(`${task} does not pull when it recreates the containers`, () => {
      const lines = taskRuns().get(task) ?? [];
      expect(lines.find(isComposeUp)).toContain("--pull never");
    });

    test(`${task} does not build when it recreates the containers`, () => {
      const lines = taskRuns().get(task) ?? [];
      expect(lines.find(isComposeUp)).toContain("--no-build");
    });

    test(`${task} checks for running work after the Docker version check`, () => {
      const lines = taskRuns().get(task) ?? [];
      expect(lines.indexOf(idleLine)).toBeGreaterThan(lines.indexOf(CHECK));
    });
  }

  for (const task of ["up", "deploy"]) {
    test(`${task} validates the Caddyfile before compose up`, () => {
      const lines = taskRuns().get(task) ?? [];
      const pre = lines.indexOf(PREVALIDATE_CADDY);
      expect(pre > -1 && pre < lines.findIndex(isComposeUp)).toBe(true);
    });

    test(`${task} validates the Caddyfile after the Docker version check`, () => {
      const lines = taskRuns().get(task) ?? [];
      expect(lines.indexOf(PREVALIDATE_CADDY)).toBeGreaterThan(
        lines.indexOf(CHECK),
      );
    });

    test(`${task} restarts caddy after compose up`, () => {
      const lines = taskRuns().get(task) ?? [];
      expect(lines.indexOf(RESTART_CADDY)).toBeGreaterThan(
        lines.findIndex(isComposeUp),
      );
    });

    test(`${task} validates the running caddy after restarting it`, () => {
      const lines = taskRuns().get(task) ?? [];
      expect(lines.indexOf(VALIDATE_CADDY)).toBeGreaterThan(
        lines.indexOf(RESTART_CADDY),
      );
    });

    test(`${task} validates caddy before recording the applied version`, () => {
      const lines = taskRuns().get(task) ?? [];
      const validate = lines.indexOf(VALIDATE_CADDY);
      expect(validate > -1 && validate < lines.indexOf(RECORD)).toBe(true);
    });

    test(`${task} stops on a failed command`, () => {
      expect(taskRuns().get(task)?.[0]).toBe(ERREXIT);
    });

    test(`${task} restarts caddy before recording the applied version`, () => {
      const lines = taskRuns().get(task) ?? [];
      const restart = lines.indexOf(RESTART_CADDY);
      expect(restart > -1 && restart < lines.indexOf(RECORD)).toBe(true);
    });
  }

  test("every task that runs docker compose up stops on a failed Docker version check", () => {
    const unchecked = [...taskRuns()]
      .filter(([, lines]) => lines.some(isComposeUp))
      .filter(([, lines]) => {
        const check = lines.indexOf(CHECK);
        return (
          lines[0] !== ERREXIT ||
          check === -1 ||
          check > lines.findIndex(isComposeUp)
        );
      })
      .map(([name]) => name);

    expect(unchecked).toEqual([]);
  });
});
