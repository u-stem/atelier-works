import { describe, expect, test } from "bun:test";
import {
  type CommandResult,
  type CommandRunner,
  HOST_PROBE_ENV,
  type IssuedSpec,
} from "../../scripts/host_apply/command.ts";
import { PS_BIN, SYSCTL_BIN } from "../../scripts/host_apply/exec_paths.ts";
import { bootId, processStart } from "../../scripts/host_apply/host_probe.ts";

function done(stdout: string, code = 0): CommandResult {
  return {
    kind: "done",
    code,
    stdout,
    stderr: "",
    stdoutDropped: false,
    stderrDropped: false,
  };
}

function runnerReturning(result: CommandResult) {
  const calls: IssuedSpec[] = [];
  const run: CommandRunner = async (spec) => {
    calls.push(spec);
    return result;
  };
  return { calls, run };
}

function startOf(stdout: string, code = 0) {
  return processStart(runnerReturning(done(stdout, code)).run, 123);
}

describe("processStart", () => {
  test("converts the start time to ISO 8601 in UTC", async () => {
    expect(await startOf("Sun Oct 18 10:42:48 2026\n")).toBe(
      "2026-10-18T10:42:48Z",
    );
  });

  test("reads a day that ps pads with a space", async () => {
    expect(await startOf("Sun Oct  4 09:05:03 2026\n")).toBe(
      "2026-10-04T09:05:03Z",
    );
  });

  test("ignores the spaces that ps pads at the end", async () => {
    expect(await startOf("Sun Oct 18 10:42:48 2026    \n")).toBe(
      "2026-10-18T10:42:48Z",
    );
  });

  test("reads midnight", async () => {
    expect(await startOf("Thu Jan  1 00:00:00 1970\n")).toBe(
      "1970-01-01T00:00:00Z",
    );
  });

  test("reads the last second of a day", async () => {
    expect(await startOf("Thu Dec 31 23:59:59 2026\n")).toBe(
      "2026-12-31T23:59:59Z",
    );
  });

  test("reads a leap day", async () => {
    expect(await startOf("Thu Feb 29 12:00:00 2024\n")).toBe(
      "2024-02-29T12:00:00Z",
    );
  });

  test.each([
    ["Jan", "01"],
    ["Feb", "02"],
    ["Mar", "03"],
    ["Apr", "04"],
    ["May", "05"],
    ["Jun", "06"],
    ["Jul", "07"],
    ["Aug", "08"],
    ["Sep", "09"],
    ["Oct", "10"],
    ["Nov", "11"],
    ["Dec", "12"],
  ])("reads the month %s", async (name, number) => {
    expect(await startOf(`Mon ${name} 15 10:00:00 2026\n`)).toBe(
      `2026-${number}-15T10:00:00Z`,
    );
  });

  test("returns null when the process does not exist", async () => {
    expect(await startOf("", 1)).toBeNull();
  });

  test("returns null when the process does not exist and the output is blank", async () => {
    expect(await startOf("\n", 1)).toBeNull();
  });

  test("throws when ps fails with output", async () => {
    await expect(startOf("Sun Oct 18 10:42:48 2026\n", 1)).rejects.toThrow(
      "ps",
    );
  });

  test("throws when ps fails with another exit code", async () => {
    await expect(startOf("", 2)).rejects.toThrow("ps");
  });

  test("throws when ps succeeds with no output", async () => {
    await expect(startOf("", 0)).rejects.toThrow("ps");
  });

  test.each([
    ["a Japanese date", "2026年10月18日 日曜日 10:42:48\n"],
    ["an unknown month", "Sun Foo 18 10:42:48 2026\n"],
    ["a day that does not exist", "Mon Feb 30 10:42:48 2026\n"],
    ["a leap day in a common year", "Mon Feb 29 10:42:48 2026\n"],
    ["day zero", "Mon Oct  0 10:42:48 2026\n"],
    ["hour 24", "Sun Oct 18 24:00:00 2026\n"],
    ["minute 60", "Sun Oct 18 10:60:00 2026\n"],
    ["second 60", "Sun Oct 18 10:42:60 2026\n"],
    ["a year before 1970", "Wed Dec 31 23:59:59 1969\n"],
    ["a missing year", "Sun Oct 18 10:42:48\n"],
    ["two lines", "Sun Oct 18 10:42:48 2026\nSun Oct 18 10:42:48 2026\n"],
    ["a time zone suffix", "Sun Oct 18 10:42:48 2026 JST\n"],
    ["lower case names", "sun oct 18 10:42:48 2026\n"],
    ["plain text", "garbage\n"],
  ])("throws for %s", async (_name, stdout) => {
    await expect(startOf(stdout)).rejects.toThrow("ps");
  });

  test("throws when the output was cut", async () => {
    const run: CommandRunner = async () => ({
      kind: "truncated",
      stderr: "",
      stderrDropped: false,
    });
    await expect(processStart(run, 1)).rejects.toThrow("ps");
  });

  test("throws when output was dropped", async () => {
    const run: CommandRunner = async () => ({
      kind: "done",
      code: 0,
      stdout: "Sun Oct 18 10:42:48 2026\n",
      stderr: "",
      stdoutDropped: true,
      stderrDropped: false,
    });
    await expect(processStart(run, 1)).rejects.toThrow("ps");
  });

  test.each([0, -1, 1.5, Number.NaN, 2 ** 22 + 1, Number.POSITIVE_INFINITY])(
    "refuses the process id %p without running ps",
    async (pid) => {
      const probe = runnerReturning(done(""));
      await processStart(probe.run, pid).catch(() => {});
      expect(probe.calls).toEqual([]);
    },
  );

  test.each([0, -1, 1.5, Number.NaN, 2 ** 22 + 1])(
    "throws for the process id %p",
    async (pid) => {
      await expect(
        processStart(runnerReturning(done("")).run, pid),
      ).rejects.toThrow("pid");
    },
  );

  test("accepts the largest process id", async () => {
    const probe = runnerReturning(done("", 1));
    await processStart(probe.run, 2 ** 22);
    expect(probe.calls.length).toBe(1);
  });

  describe("the specification it runs", () => {
    async function spec(): Promise<IssuedSpec> {
      const probe = runnerReturning(done("", 1));
      await processStart(probe.run, 4321);
      const [first] = probe.calls;
      if (first === undefined) throw new Error("not run");
      return first;
    }

    test("is the host_probe kind", async () => {
      expect((await spec()).kind).toBe("host_probe");
    });

    test("runs the absolute path of ps", async () => {
      expect((await spec()).bin).toBe(PS_BIN);
    });

    test("asks only for the start time of the process", async () => {
      expect([...(await spec()).args]).toEqual(["-o", "lstart=", "-p", "4321"]);
    });

    test("fixes the locale and the time zone", async () => {
      expect({ ...(await spec()).env }).toEqual({ ...HOST_PROBE_ENV });
    });

    test("runs in the root directory", async () => {
      expect((await spec()).cwd).toBe("/");
    });
  });

  test("lets an error of the runner through", async () => {
    const run: CommandRunner = async () => {
      throw new Error("runner failed");
    };
    await expect(processStart(run, 1)).rejects.toThrow("runner failed");
  });
});

describe("bootId", () => {
  const UUID = "6d26a179-16fd-4600-b9bf-4d7a0905e3eb";

  test("returns the session uuid", async () => {
    expect(await bootId(runnerReturning(done(`${UUID}\n`)).run)).toBe(UUID);
  });

  test("returns it in lower case", async () => {
    expect(
      await bootId(runnerReturning(done(`${UUID.toUpperCase()}\n`)).run),
    ).toBe(UUID);
  });

  test.each([
    ["no output", ""],
    ["text that is not a uuid", "not-a-uuid\n"],
    ["a uuid with a suffix", `${UUID} extra\n`],
    ["two lines", `${UUID}\n${UUID}\n`],
    ["a uuid with a missing part", "6d26a179-16fd-4600-b9bf\n"],
    ["a uuid with a non-hex digit", `${UUID.replace("6d", "zz")}\n`],
  ])("throws for %s", async (_name, stdout) => {
    await expect(bootId(runnerReturning(done(stdout)).run)).rejects.toThrow(
      "sysctl",
    );
  });

  test("throws when sysctl fails", async () => {
    await expect(
      bootId(runnerReturning(done(`${UUID}\n`, 1)).run),
    ).rejects.toThrow("sysctl");
  });

  test("throws when the output was cut", async () => {
    const run: CommandRunner = async () => ({
      kind: "truncated",
      stderr: "",
      stderrDropped: false,
    });
    await expect(bootId(run)).rejects.toThrow("sysctl");
  });

  describe("the specification it runs", () => {
    async function spec(): Promise<IssuedSpec> {
      const probe = runnerReturning(done(`${UUID}\n`));
      await bootId(probe.run);
      const [first] = probe.calls;
      if (first === undefined) throw new Error("not run");
      return first;
    }

    test("is the host_probe kind", async () => {
      expect((await spec()).kind).toBe("host_probe");
    });

    test("runs the absolute path of sysctl", async () => {
      expect((await spec()).bin).toBe(SYSCTL_BIN);
    });

    test("asks only for the boot session", async () => {
      expect([...(await spec()).args]).toEqual(["-n", "kern.bootsessionuuid"]);
    });

    test("fixes the locale and the time zone", async () => {
      expect({ ...(await spec()).env }).toEqual({ ...HOST_PROBE_ENV });
    });
  });
});
