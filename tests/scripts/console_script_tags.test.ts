import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

// Console用workerは`tag: console`のjobだけを受ける。Consoleが呼ぶscriptにだけ付け、
// 1件が止まってもConsole用workerの1枠を塞ぎ続けないよう`timeout`(秒)を付ける。
// 他のscriptに付けると、defaultのworkerが受けない仕事がqueueに溜まる。
// tag `periodic`は定期ジョブ用workerのtagで、付けてよいscriptは`periodic_script_boundary.test.ts`が固定する。

const CONSOLE_SCRIPTS: Readonly<Record<string, number>> = {
  "f/factory/steps/console_query": 60,
  "f/factory/notice_resolve": 30,
  "f/factory/approval_decide": 120,
  "f/factory/retry_work_item": 120,
  "f/factory/audit_kickoff": 120,
  "f/factory/manual_intake_submit": 30,
  "f/factory/console_fetch_watch": 60,
  "f/factory/console_holds": 30,
  "f/factory/hold_release": 30,
  "f/factory/freeze_release": 30,
  "f/factory/console_jobs": 60,
  "f/factory/console_schedules": 60,
  "f/factory/console_config": 30,
  "f/factory/console_job_cancel": 30,
  "f/factory/console_job_rerun": 30,
  "f/factory/console_config_update": 30,
  "f/factory/console_hold_place": 30,
  "f/factory/console_schedule_stop": 30,
};

async function scriptYaml(path: string): Promise<string> {
  return Bun.file(`${path}.script.yaml`).text();
}

async function allScriptYamlPaths(): Promise<string[]> {
  const glob = new Glob("f/**/*.script.yaml");
  const found: string[] = [];
  for await (const file of glob.scan(".")) {
    found.push(file.replace(/\.script\.yaml$/, ""));
  }
  return found;
}

describe("console scripts", () => {
  test("each console script has tag: console", async () => {
    const missing: string[] = [];
    for (const path of Object.keys(CONSOLE_SCRIPTS)) {
      if (!/^tag: console$/m.test(await scriptYaml(path))) missing.push(path);
    }
    expect(missing).toEqual([]);
  });

  test("each console script has its timeout", async () => {
    const wrong: string[] = [];
    for (const [path, seconds] of Object.entries(CONSOLE_SCRIPTS)) {
      const match = (await scriptYaml(path)).match(/^timeout: (\d+)$/m);
      if (match?.[1] !== String(seconds)) wrong.push(path);
    }
    expect(wrong).toEqual([]);
  });

  test("no other script has tag: console", async () => {
    const others: string[] = [];
    for (const path of await allScriptYamlPaths()) {
      if (path in CONSOLE_SCRIPTS) continue;
      if (/^tag: console$/m.test(await scriptYaml(path))) others.push(path);
    }
    expect(others).toEqual([]);
  });

  test("no other script has a tag but periodic", async () => {
    const others: string[] = [];
    for (const path of await allScriptYamlPaths()) {
      if (path in CONSOLE_SCRIPTS) continue;
      const yaml = await scriptYaml(path);
      if (/^tag:/m.test(yaml) && !/^tag: periodic$/m.test(yaml)) {
        others.push(path);
      }
    }
    expect(others).toEqual([]);
  });

  test("no console script runs on behalf of another user", async () => {
    const delegating: string[] = [];
    for (const path of Object.keys(CONSOLE_SCRIPTS)) {
      if (/on_behalf_of/.test(await scriptYaml(path))) delegating.push(path);
    }
    expect(delegating).toEqual([]);
  });

  test("the eighteen console scripts exist", async () => {
    const paths = await allScriptYamlPaths();
    expect(
      Object.keys(CONSOLE_SCRIPTS).filter((path) => !paths.includes(path)),
    ).toEqual([]);
  });
});

// Console用workerと定期ジョブ用workerは、1つずつ動かす前提で書いたscriptがある。
// 再実行は、同じscriptが実行中か待ちかを読んで判断するので、同じtagの枠が1つであることに頼る。
// 設定の変更は、読み直しから書き込みまでの間に、同じscriptの別の呼び出しが入らないことに頼る。
describe("the slots of the workers that the console scripts rely on", () => {
  async function composeServices(): Promise<Record<string, unknown>> {
    const parsed: unknown = Bun.YAML.parse(
      await Bun.file("infra/docker-compose.yml").text(),
    );
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("services" in parsed) ||
      typeof parsed.services !== "object" ||
      parsed.services === null
    ) {
      throw new Error("infra/docker-compose.yml has no services");
    }
    return Object.fromEntries(Object.entries(parsed.services));
  }

  function replicasOf(service: unknown): unknown {
    if (typeof service !== "object" || service === null) return undefined;
    if (!("deploy" in service)) return undefined;
    const deploy = service.deploy;
    if (typeof deploy !== "object" || deploy === null) return undefined;
    return "replicas" in deploy ? deploy.replicas : undefined;
  }

  function environmentOf(service: unknown): string {
    if (typeof service !== "object" || service === null) return "";
    if (!("environment" in service)) return "";
    return JSON.stringify(service.environment);
  }

  test.each(["windmill_worker_console", "windmill_worker_periodic"])(
    "%s runs as one replica",
    async (name) => {
      expect(replicasOf((await composeServices())[name])).toBe(1);
    },
  );

  test.each(["windmill_worker_console", "windmill_worker_periodic"])(
    "%s does not raise the number of workers in a container",
    async (name) => {
      expect(environmentOf((await composeServices())[name])).not.toMatch(
        /NUM_WORKERS/,
      );
    },
  );
});
