import { describe, expect, test } from "bun:test";
import {
  COMMAND_OUTPUT_LIMITS,
  CommandError,
  type CommandSpecInput,
  CREATABLE_KINDS,
  HOST_PROBE_ENV,
  IssuedSpec,
  isIssued,
  issueSpec,
  issueSpecUnchecked,
  UNCREATABLE_KINDS,
} from "../../scripts/host_apply/command.ts";
import {
  COMMAND_KINDS,
  COMMAND_TIMEOUT_MS,
} from "../../scripts/host_apply/constants.ts";
import {
  GIT_BIN,
  PS_BIN,
  SYSCTL_BIN,
} from "../../scripts/host_apply/exec_paths.ts";
import {
  approveGitEnv,
  fetchArgs,
  fetchEnv,
  GIT_FIXED_PREFIX,
  showBlobArgs,
} from "../../scripts/host_apply/git.ts";
import { REMOTE_URL_ARGS } from "../../scripts/host_apply/git_grammar.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const URL = "https://github.com/example/repo.git";

function gitRead(overrides: Partial<CommandSpecInput> = {}): CommandSpecInput {
  return {
    kind: "git_read",
    bin: GIT_BIN,
    args: showBlobArgs(SHA, "mise.toml"),
    env: approveGitEnv(),
    cwd: "/srv/repo",
    timeoutMs: COMMAND_TIMEOUT_MS.git_read,
    ...overrides,
  };
}

function gitFetch(overrides: Partial<CommandSpecInput> = {}): CommandSpecInput {
  return {
    kind: "git_fetch",
    bin: GIT_BIN,
    args: fetchArgs(URL),
    env: { ...approveGitEnv(), ...fetchEnv(null), GIT_DIR: "/srv/repo.git" },
    cwd: "/srv/repo.git",
    timeoutMs: COMMAND_TIMEOUT_MS.git_fetch,
    ...overrides,
  };
}

function probe(overrides: Partial<CommandSpecInput> = {}): CommandSpecInput {
  return {
    kind: "host_probe",
    bin: PS_BIN,
    args: ["-o", "lstart=", "-p", "123"],
    env: { ...HOST_PROBE_ENV },
    cwd: "/",
    timeoutMs: COMMAND_TIMEOUT_MS.host_probe,
    ...overrides,
  };
}

/** 形の検査だけを確かめるときの指定。種類の表を飛ばす。 */
function shape(overrides: Partial<CommandSpecInput> = {}): CommandSpecInput {
  return {
    kind: "git_read",
    bin: "/bin/sh",
    args: ["-c", "true"],
    env: { PATH: "/usr/bin:/bin" },
    cwd: "/tmp",
    timeoutMs: COMMAND_TIMEOUT_MS.git_read,
    ...overrides,
  };
}

describe("the absolute paths of the executables", () => {
  test.each([
    ["git", GIT_BIN, "/usr/bin/git"],
    ["ps", PS_BIN, "/bin/ps"],
    ["sysctl", SYSCTL_BIN, "/usr/sbin/sysctl"],
  ])("pins %s", (_name, actual, expected) => {
    expect(actual).toBe(expected);
  });
});

describe("CommandError", () => {
  test("carries the reason", () => {
    expect(new CommandError("timeout").reason).toBe("timeout");
  });

  test("has a fixed message that names only the reason", () => {
    expect(new CommandError("aborted").message).toBe(
      "external command failed: aborted",
    );
  });
});

describe("the kinds that can be created", () => {
  test("are exactly git_read, git_fetch and host_probe", () => {
    expect([...CREATABLE_KINDS].sort()).toEqual([
      "git_fetch",
      "git_read",
      "host_probe",
    ]);
  });

  test("and the kinds that cannot be created cover every other kind", () => {
    expect([...CREATABLE_KINDS, ...UNCREATABLE_KINDS].sort()).toEqual(
      [...COMMAND_KINDS].sort(),
    );
  });

  test("share no kind with the kinds that cannot be created", () => {
    expect(
      UNCREATABLE_KINDS.filter((kind) => CREATABLE_KINDS.includes(kind)),
    ).toEqual([]);
  });

  test.each([
    "git_worktree_add",
    "docker_inspect",
    "docker_ps",
    "docker_volume_ls",
    "launchctl",
    "compose_dry_run",
    "compose_pull",
    "compose_build",
    "compose_up",
    "host_script",
    "http_fetch",
  ] as const)("rejects the kind %s", (kind) => {
    expect(() => issueSpec(gitRead({ kind }))).toThrow("kind");
  });
});

describe("the output limits", () => {
  test.each([
    ["git_read", 64 * 1024 * 1024, "kill"],
    ["git_fetch", 64 * 1024, "drain"],
    ["host_probe", 4 * 1024, "kill"],
  ] as const)(
    "limits %s to %d bytes and %s on overflow",
    (kind, bytes, overflow) => {
      expect(COMMAND_OUTPUT_LIMITS[kind]).toEqual({
        ceilingBytes: bytes,
        overflow,
      });
    },
  );

  test("defaults the limit to the ceiling of the kind", () => {
    expect(issueSpec(gitRead()).maxStdoutBytes).toBe(64 * 1024 * 1024);
  });

  test("lets the caller lower the limit", () => {
    expect(issueSpec(gitRead({ maxStdoutBytes: 512 })).maxStdoutBytes).toBe(
      512,
    );
  });

  test("accepts the ceiling itself", () => {
    expect(
      issueSpec(gitRead({ maxStdoutBytes: 64 * 1024 * 1024 })).maxStdoutBytes,
    ).toBe(64 * 1024 * 1024);
  });

  test("rejects a limit above the ceiling", () => {
    expect(() =>
      issueSpec(gitRead({ maxStdoutBytes: 64 * 1024 * 1024 + 1 })),
    ).toThrow("output");
  });

  test.each([0, -1, 1.5, Number.NaN])("rejects the limit %p", (limit) => {
    expect(() => issueSpec(gitRead({ maxStdoutBytes: limit }))).toThrow(
      "output",
    );
  });

  test.each([
    ["git_read", "kill"],
    ["git_fetch", "drain"],
    ["host_probe", "kill"],
  ] as const)("fixes the overflow of %s as %s", (kind, overflow) => {
    const input =
      kind === "git_read"
        ? gitRead()
        : kind === "git_fetch"
          ? gitFetch()
          : probe();
    expect(issueSpec(input).overflow).toBe(overflow);
  });
});

describe("issueSpec", () => {
  test("keeps the fields of a valid specification", () => {
    const spec = issueSpec(gitRead());
    expect({
      kind: spec.kind,
      bin: spec.bin,
      args: [...spec.args],
      cwd: spec.cwd,
      timeoutMs: spec.timeoutMs,
    }).toEqual({
      kind: "git_read",
      bin: GIT_BIN,
      args: showBlobArgs(SHA, "mise.toml"),
      cwd: "/srv/repo",
      timeoutMs: COMMAND_TIMEOUT_MS.git_read,
    });
  });

  test("registers the specification as issued", () => {
    expect(isIssued(issueSpec(gitRead()))).toBe(true);
  });

  test("freezes the specification", () => {
    expect(Object.isFrozen(issueSpec(gitRead()))).toBe(true);
  });

  test("freezes the arguments", () => {
    expect(Object.isFrozen(issueSpec(gitRead()).args)).toBe(true);
  });

  test("freezes the environment", () => {
    expect(Object.isFrozen(issueSpec(gitRead()).env)).toBe(true);
  });

  test("is not changed when the caller later edits the arguments", () => {
    const args = showBlobArgs(SHA, "mise.toml");
    const spec = issueSpec(gitRead({ args }));
    args.push("--output=/tmp/x");
    expect([...spec.args]).toEqual(showBlobArgs(SHA, "mise.toml"));
  });

  test("is not changed when the caller later edits the environment", () => {
    const env = approveGitEnv();
    const spec = issueSpec(gitRead({ env }));
    env.GIT_EXEC_PATH = "/tmp";
    expect("GIT_EXEC_PATH" in spec.env).toBe(false);
  });

  test("does not register a literal that has the same fields", () => {
    expect(isIssued({ ...issueSpec(gitRead()) })).toBe(false);
  });

  test("does not register an instance built outside issueSpec", () => {
    const outside = new IssuedSpec({
      kind: "git_read",
      bin: GIT_BIN,
      args: [],
      env: {},
      cwd: "/",
      timeoutMs: 1,
      maxStdoutBytes: 1,
      overflow: "kill",
    });
    expect(isIssued(outside)).toBe(false);
  });

  test.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "git"],
  ])("does not register %s", (_name, value) => {
    expect(isIssued(value)).toBe(false);
  });
});

describe("the checks of the shape of a specification", () => {
  test("accepts a valid shape", () => {
    expect(() => issueSpecUnchecked(shape())).not.toThrow();
  });

  test.each([
    ["a relative bin", { bin: "git" }],
    ["a bin with a parent segment", { bin: "/usr/../bin/git" }],
    ["a bin with a NUL", { bin: "/usr/bin/git\0" }],
    ["a relative cwd", { cwd: "repo" }],
    ["a cwd with a parent segment", { cwd: "/srv/../etc" }],
    ["a cwd with a NUL", { cwd: "/srv\0/repo" }],
    ["an argument with a NUL", { args: ["a\0b"] }],
    ["an env key in lower case", { env: { path: "/bin" } }],
    ["an env key with a dash", { env: { "A-B": "1" } }],
    ["an env key that starts with a digit", { env: { "1A": "1" } }],
    ["an env value with a NUL", { env: { A: "1\0" } }],
    ["a timeout that differs from the table", { timeoutMs: 1 }],
  ])("rejects %s", (_name, overrides) => {
    expect(() => issueSpecUnchecked(shape(overrides))).toThrow(
      "invalid command spec",
    );
  });

  test("accepts a path whose name contains two dots", () => {
    expect(() =>
      issueSpecUnchecked(shape({ bin: "/opt/my..tool", cwd: "/tmp/my..repo" })),
    ).not.toThrow();
  });

  test("applies the same checks to the checked entry", () => {
    expect(() => issueSpec(gitRead({ cwd: "repo" }))).toThrow(
      "invalid command spec",
    );
  });
});

describe("issueSpecUnchecked", () => {
  test("accepts an executable that the tables do not list", () => {
    expect(issueSpecUnchecked(shape()).bin).toBe("/bin/sh");
  });

  test("freezes the specification", () => {
    expect(Object.isFrozen(issueSpecUnchecked(shape()))).toBe(true);
  });

  test("is not an issued specification by default", () => {
    expect(isIssued(issueSpecUnchecked(shape()))).toBe(false);
  });

  test("is an issued specification once the runner accepts unchecked ones", () => {
    expect(isIssued(issueSpecUnchecked(shape()), true)).toBe(true);
  });

  test("does not make a checked specification pass as unchecked", () => {
    expect(isIssued(issueSpec(gitRead()), false)).toBe(true);
  });
});

describe("git_read specifications", () => {
  test("accepts a read command in the fixed environment", () => {
    expect(isIssued(issueSpec(gitRead()))).toBe(true);
  });

  test("rejects an executable other than git", () => {
    expect(() => issueSpec(gitRead({ bin: "/bin/sh" }))).toThrow("bin");
  });

  test("rejects a git found by name", () => {
    expect(() => issueSpec(gitRead({ bin: "git" }))).toThrow(
      "invalid command spec",
    );
  });

  test("rejects an alias set after the prefix", () => {
    expect(() =>
      issueSpec(
        gitRead({
          args: [...GIT_FIXED_PREFIX, "-c", "alias.x=!sh", "show", `${SHA}:a`],
        }),
      ),
    ).toThrow("git");
  });

  test("rejects an output flag of diff", () => {
    expect(() =>
      issueSpec(
        gitRead({
          args: [
            ...GIT_FIXED_PREFIX,
            "diff",
            "--no-ext-diff",
            "--name-status",
            "--output=/tmp/x",
            `${SHA}..${SHA}`,
          ],
        }),
      ),
    ).toThrow("git");
  });

  test.each([
    ["GIT_EXEC_PATH", "/tmp"],
    ["LD_PRELOAD", "/tmp/x.so"],
    ["DYLD_INSERT_LIBRARIES", "/tmp/x.dylib"],
    ["GIT_DIR", "/tmp/x"],
  ])("rejects the extra environment key %s", (name, value) => {
    expect(() =>
      issueSpec(gitRead({ env: { ...approveGitEnv(), [name]: value } })),
    ).toThrow("environment");
  });

  test("rejects a changed PATH", () => {
    expect(() =>
      issueSpec(gitRead({ env: { ...approveGitEnv(), PATH: "/tmp" } })),
    ).toThrow("environment");
  });

  test("rejects the arguments of a fetch", () => {
    expect(() => issueSpec(gitRead({ args: fetchArgs(URL) }))).toThrow("git");
  });
});

describe("git_fetch specifications", () => {
  test("accepts the fetch of a url", () => {
    expect(isIssued(issueSpec(gitFetch()))).toBe(true);
  });

  test("accepts the read of the remote url", () => {
    expect(
      isIssued(
        issueSpec(
          gitFetch({
            args: [...REMOTE_URL_ARGS],
            env: { ...approveGitEnv(), GIT_DIR: "/srv/repo.git" },
          }),
        ),
      ),
    ).toBe(true);
  });

  test("rejects the arguments of a read", () => {
    expect(() => issueSpec(gitFetch({ args: showBlobArgs(SHA, "a") }))).toThrow(
      "git",
    );
  });

  test("rejects a fetch whose GIT_DIR differs from the working directory", () => {
    expect(() => issueSpec(gitFetch({ cwd: "/elsewhere" }))).toThrow("GIT_DIR");
  });

  test("rejects an executable other than git", () => {
    expect(() => issueSpec(gitFetch({ bin: "/usr/bin/curl" }))).toThrow("bin");
  });
});

describe("host_probe specifications", () => {
  test("accepts the start time of a process", () => {
    expect(isIssued(issueSpec(probe()))).toBe(true);
  });

  test("accepts the boot session of the host", () => {
    expect(
      isIssued(
        issueSpec(
          probe({ bin: SYSCTL_BIN, args: ["-n", "kern.bootsessionuuid"] }),
        ),
      ),
    ).toBe(true);
  });

  test("fixes the environment to the locale and the time zone", () => {
    expect({ ...HOST_PROBE_ENV }).toEqual({
      PATH: "/usr/bin:/bin",
      LC_ALL: "C",
      TZ: "UTC",
    });
  });

  test.each(["0", "-1", "01", "4194305", "1;2", "12 3", "", "abc", "1e3"])(
    "rejects the process id %p",
    (pid) => {
      expect(() =>
        issueSpec(probe({ args: ["-o", "lstart=", "-p", pid] })),
      ).toThrow("host_probe");
    },
  );

  test("accepts the largest process id", () => {
    expect(
      isIssued(issueSpec(probe({ args: ["-o", "lstart=", "-p", "4194304"] }))),
    ).toBe(true);
  });

  test.each([
    ["an extra flag", ["-ww", "-o", "lstart=", "-p", "1"]],
    ["another column", ["-o", "command=", "-p", "1"]],
    ["no process id", ["-o", "lstart="]],
    ["a trailing argument", ["-o", "lstart=", "-p", "1", "-A"]],
  ])("rejects ps with %s", (_name, args) => {
    expect(() => issueSpec(probe({ args }))).toThrow("host_probe");
  });

  test.each([
    ["another key", ["-n", "kern.hostname"]],
    ["a listing", ["-a"]],
    ["a write", ["-w", "kern.bootsessionuuid=1"]],
  ])("rejects sysctl with %s", (_name, args) => {
    expect(() => issueSpec(probe({ bin: SYSCTL_BIN, args }))).toThrow(
      "host_probe",
    );
  });

  test("rejects a bin other than ps and sysctl", () => {
    expect(() => issueSpec(probe({ bin: "/bin/ls" }))).toThrow("bin");
  });

  test("rejects git as the bin", () => {
    expect(() => issueSpec(probe({ bin: GIT_BIN }))).toThrow("bin");
  });

  test.each([
    ["a missing locale", { PATH: "/usr/bin:/bin", TZ: "UTC" }],
    ["a missing time zone", { PATH: "/usr/bin:/bin", LC_ALL: "C" }],
    [
      "another time zone",
      { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "Asia/Tokyo" },
    ],
    [
      "an extra key",
      { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC", HOME: "/" },
    ],
  ])("rejects %s", (_name, env) => {
    expect(() => issueSpec(probe({ env }))).toThrow("environment");
  });

  test("rejects a working directory other than the root", () => {
    expect(() => issueSpec(probe({ cwd: "/tmp" }))).toThrow("host_probe");
  });
});
