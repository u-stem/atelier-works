import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import {
  CONSOLE_READ_SCRIPTS,
  CONSOLE_WRITE_SCRIPTS,
  WRITE_SCRIPTS_NAMED_ONLY_BY_THEMSELVES,
} from "../../../scripts/claude-hooks/console-scripts.ts";
import { decide, denyReason } from "./decide.ts";

const URL_BASE = "http://localhost:8000/api/w/factory/jobs";

/** リポジトリのtag consoleのscriptのbasename。 */
async function consoleScriptNames(): Promise<string[]> {
  const names: string[] = [];
  for await (const file of new Glob("f/**/*.script.yaml").scan(".")) {
    if (/^tag: console$/m.test(await Bun.file(file).text())) {
      const path = file.replace(/\.script\.yaml$/, "");
      names.push(path.split("/").pop() ?? path);
    }
  }
  return names.sort();
}

describe("the classification of the console scripts", () => {
  test("covers every script with tag console, as a read or as a write", async () => {
    expect([...CONSOLE_READ_SCRIPTS, ...CONSOLE_WRITE_SCRIPTS].sort()).toEqual(
      await consoleScriptNames(),
    );
  });

  test("lists no script as both a read and a write", () => {
    expect(
      CONSOLE_READ_SCRIPTS.filter((name) =>
        CONSOLE_WRITE_SCRIPTS.includes(name),
      ),
    ).toEqual([]);
  });

  test("lists the scripts that only read as reads", () => {
    expect([...CONSOLE_READ_SCRIPTS].sort()).toEqual([
      "console_config",
      "console_fetch_watch",
      "console_holds",
      "console_jobs",
      "console_query",
      "console_schedules",
    ]);
  });

  test("lists as writes every script that the Console calls to change something", () => {
    expect([...CONSOLE_WRITE_SCRIPTS].sort()).toEqual([
      "approval_decide",
      "audit_kickoff",
      "console_job_cancel",
      "freeze_release",
      "hold_release",
      "manual_intake_submit",
      "notice_resolve",
      "retry_work_item",
    ]);
  });

  test("lists the scripts that only their own files name among the writes", () => {
    expect(
      WRITE_SCRIPTS_NAMED_ONLY_BY_THEMSELVES.filter(
        (name) => !CONSOLE_WRITE_SCRIPTS.includes(name),
      ),
    ).toEqual([]);
  });
});

describe("bash-guard denies running a Console write script", () => {
  test.each([...CONSOLE_WRITE_SCRIPTS])(
    "denies wmill script run on %s in the main session",
    async (name) => {
      expect(await decide(`wmill script run f/factory/${name} -d '{}'`)).toBe(
        "deny",
      );
    },
  );

  test.each([...CONSOLE_WRITE_SCRIPTS])(
    "denies wmill script run on %s in a subagent",
    async (name) => {
      expect(
        await decide(`wmill script run f/factory/${name} -d '{}'`, {
          subagent: true,
        }),
      ).toBe("deny");
    },
  );

  test.each([...CONSOLE_WRITE_SCRIPTS])("denies a curl to %s", async (name) => {
    expect(
      await decide(
        `curl -X POST ${URL_BASE}/run_wait_result/p/f/factory/${name}`,
      ),
    ).toBe("deny");
  });

  test.each([...CONSOLE_WRITE_SCRIPTS])(
    "denies a preview of %s",
    async (name) => {
      expect(await decide(`wmill script preview f/factory/${name}.ts`)).toBe(
        "deny",
      );
    },
  );

  test.each([...CONSOLE_WRITE_SCRIPTS])(
    "denies a script name that is built with a glob for %s",
    async (name) => {
      const glob = `${name.slice(0, -2)}[${name.slice(-2, -1)}]${name.slice(-1)}`;
      expect(await decide(`wmill script run f/factory/${glob}`)).toBe("deny");
    },
  );

  test("denies running the job cancel script through xargs", async () => {
    expect(
      await decide(
        "echo f/factory/console_job_cancel | xargs wmill script run",
      ),
    ).toBe("deny");
  });

  test("says that the Console is where a person runs it", async () => {
    expect(
      await denyReason("wmill script run f/factory/console_job_cancel"),
    ).toContain("Console");
  });

  test("names the job cancel script in the reason", async () => {
    expect(
      await denyReason("wmill script run f/factory/console_job_cancel"),
    ).toContain("console_job_cancel");
  });

  test("keeps saying how to read the source", async () => {
    expect(
      await denyReason("wmill script run f/factory/console_job_cancel"),
    ).toContain("git show");
  });
});

describe("bash-guard allows work near the Console write scripts", () => {
  test.each([...CONSOLE_READ_SCRIPTS])(
    "allows wmill script run on %s",
    async (name) => {
      expect(await decide(`wmill script run f/factory/${name}`)).toBe("allow");
    },
  );

  test.each([...CONSOLE_READ_SCRIPTS])("allows a curl to %s", async (name) => {
    expect(
      await decide(`curl ${URL_BASE}/run_wait_result/p/f/factory/${name}`),
    ).toBe("allow");
  });

  test.each([...CONSOLE_WRITE_SCRIPTS])(
    "allows reading the source of %s",
    async (name) => {
      expect(await decide(`wmill script get f/factory/${name}`)).toBe("allow");
    },
  );

  test.each([...CONSOLE_WRITE_SCRIPTS])("allows testing %s", async (name) => {
    expect(await decide(`bun test tests/scripts/${name}.test.ts`)).toBe(
      "allow",
    );
  });

  test.each([...CONSOLE_WRITE_SCRIPTS])(
    "allows adding %s to a commit",
    async (name) => {
      expect(await decide(`git add f/factory/${name}.ts`)).toBe("allow");
    },
  );

  test.each([...CONSOLE_WRITE_SCRIPTS])(
    "allows searching for %s",
    async (name) => {
      expect(await decide(`rg ${name} docs`)).toBe("allow");
    },
  );

  test("does not take a longer name for the job cancel script", async () => {
    expect(
      await decide("wmill script run f/factory/console_job_cancelled"),
    ).toBe("allow");
  });

  test("does not take the job list script for the job cancel script", async () => {
    expect(await decide("wmill script run f/factory/console_jobs")).toBe(
      "allow",
    );
  });
});
