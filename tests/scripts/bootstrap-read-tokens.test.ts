import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const BOOTSTRAP = resolve(import.meta.dir, "../../scripts/bootstrap.sh");
const BASH = Bun.which("bash") ?? "bash";

// bootstrap.shは読み込むだけで実行が始まるので、関数の定義だけを取り出して実行する。
function extractFunction(name: string): string {
  const source = readFileSync(BOOTSTRAP, "utf8");
  const match = new RegExp(
    `^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`,
    "m",
  ).exec(source);
  if (match === null) {
    throw new Error(`function not found: ${name}`);
  }
  return match[0];
}

const FUNCTION = extractFunction("read_token_map_json");

const PAT_ACME = "github_pat_ACMEVALUE0123456789abcdef";
const PAT_OCTO = "github_pat_OCTOVALUE0123456789abcdef";
const PAT_OTHER = "github_pat_OTHERVALUE0123456789abcdef";
const EXISTING = "github_pat_EXISTINGVALUE0123456789abcdef";

type Run = { stdout: string; stderr: string; status: number };

function run(env: Record<string, string>): Run {
  const script = `log() { printf '[bootstrap] %s\\n' "$*" >&2; }\n${FUNCTION}\nread_token_map_json\n`;
  const result = Bun.spawnSync([BASH, "-c", script], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    status: result.exitCode,
  };
}

function parsed(output: Run): unknown {
  return JSON.parse(output.stdout);
}

describe("read_token_map_json", () => {
  test("extracts the function up to its closing brace line", () => {
    expect(FUNCTION.endsWith("\n}\n")).toBe(true);
  });

  test("builds a map from the owner name to the token", () => {
    expect(parsed(run({ GITHUB_READ_TOKEN_ACME: PAT_ACME }))).toEqual({
      acme: PAT_ACME,
    });
  });

  test("lowercases the owner and turns underscores into hyphens", () => {
    expect(parsed(run({ GITHUB_READ_TOKEN_ACME_CORP: PAT_ACME }))).toEqual({
      "acme-corp": PAT_ACME,
    });
  });

  test("keeps every owner in one map", () => {
    expect(
      parsed(
        run({
          GITHUB_READ_TOKEN_ACME: PAT_ACME,
          GITHUB_READ_TOKEN_OCTO: PAT_OCTO,
        }),
      ),
    ).toEqual({ acme: PAT_ACME, octo: PAT_OCTO });
  });

  test("orders the keys so that the output is the same every time", () => {
    const first = run({
      GITHUB_READ_TOKEN_OCTO: PAT_OCTO,
      GITHUB_READ_TOKEN_ACME: PAT_ACME,
    }).stdout;
    expect(first).toBe(`{"acme":"${PAT_ACME}","octo":"${PAT_OCTO}"}\n`);
  });

  test("exits with 0", () => {
    expect(run({ GITHUB_READ_TOKEN_ACME: PAT_ACME }).status).toBe(0);
  });
});

describe("read_token_map_json with no tokens", () => {
  test("prints nothing when no variable has the prefix", () => {
    expect(run({}).stdout).toBe("");
  });

  test("prints nothing when every value is empty", () => {
    expect(run({ GITHUB_READ_TOKEN_ACME: "" }).stdout).toBe("");
  });

  test("skips an empty value without a warning", () => {
    expect(run({ GITHUB_READ_TOKEN_ACME: "" }).stderr).toBe("");
  });

  test("keeps the other owners when one value is empty", () => {
    expect(
      parsed(
        run({
          GITHUB_READ_TOKEN_ACME: "",
          GITHUB_READ_TOKEN_OCTO: PAT_OCTO,
        }),
      ),
    ).toEqual({ octo: PAT_OCTO });
  });

  test("exits with 0 when nothing is left", () => {
    expect(run({ GITHUB_READ_TOKEN_ACME: "" }).status).toBe(0);
  });
});

describe("read_token_map_json with a name that is not a login", () => {
  test("skips a name that has two hyphens in a row", () => {
    expect(
      run({
        GITHUB_READ_TOKEN_A__B: PAT_ACME,
        GITHUB_READ_TOKEN_OCTO: PAT_OCTO,
      }).stdout,
    ).toBe(`{"octo":"${PAT_OCTO}"}\n`);
  });

  test("warns with the name of the variable", () => {
    expect(run({ GITHUB_READ_TOKEN_A__B: PAT_ACME }).stderr).toContain(
      "GITHUB_READ_TOKEN_A__B",
    );
  });

  test("skips a name that is only the prefix", () => {
    expect(run({ GITHUB_READ_TOKEN_: PAT_ACME }).stdout).toBe("");
  });

  test("skips a name longer than a GitHub login", () => {
    const name = `GITHUB_READ_TOKEN_${"A".repeat(40)}`;
    expect(run({ [name]: PAT_ACME }).stdout).toBe("");
  });

  test("skips a name that starts with an underscore after the prefix", () => {
    expect(run({ GITHUB_READ_TOKEN__ACME: PAT_ACME }).stdout).toBe("");
  });

  test("keeps the value out of the warning", () => {
    expect(run({ GITHUB_READ_TOKEN_A__B: PAT_ACME }).stderr).not.toContain(
      "github_pat_",
    );
  });
});

describe("read_token_map_json with names that collide", () => {
  const COLLIDING = {
    GITHUB_READ_TOKEN_Acme: PAT_ACME,
    GITHUB_READ_TOKEN_ACME: PAT_OTHER,
    GITHUB_READ_TOKEN_OCTO: PAT_OCTO,
  };

  test("skips both variables", () => {
    expect(parsed(run(COLLIDING))).toEqual({ octo: PAT_OCTO });
  });

  test("names both variables in the warning", () => {
    const stderr = run(COLLIDING).stderr;
    expect(
      ["GITHUB_READ_TOKEN_Acme", "GITHUB_READ_TOKEN_ACME"].filter(
        (name) => !stderr.includes(name),
      ),
    ).toEqual([]);
  });

  test("keeps the values out of the warning", () => {
    expect(run(COLLIDING).stderr).not.toContain("github_pat_");
  });

  test("keeps the values of the skipped variables out of the output", () => {
    const stdout = run(COLLIDING).stdout;
    expect(
      [PAT_ACME, PAT_OTHER].filter((value) => stdout.includes(value)),
    ).toEqual([]);
  });

  test("does not count an empty variable as a collision", () => {
    expect(
      parsed(
        run({
          GITHUB_READ_TOKEN_Acme: "",
          GITHUB_READ_TOKEN_ACME: PAT_ACME,
        }),
      ),
    ).toEqual({ acme: PAT_ACME });
  });
});

describe("read_token_map_json with a value that is not accepted", () => {
  test("skips a value that does not start with github_pat_", () => {
    expect(
      run({ GITHUB_READ_TOKEN_ACME: "ghp_classicTokenValue0123456789" }).stdout,
    ).toBe("");
  });

  test("warns with the name of the variable", () => {
    expect(
      run({ GITHUB_READ_TOKEN_ACME: "ghp_classicTokenValue0123456789" }).stderr,
    ).toContain("GITHUB_READ_TOKEN_ACME");
  });

  test("keeps the rejected value out of the warning", () => {
    expect(
      run({ GITHUB_READ_TOKEN_ACME: "ghp_classicTokenValue0123456789" }).stderr,
    ).not.toContain("classicTokenValue");
  });

  test("skips a value equal to GITHUB_TOKEN", () => {
    expect(
      run({ GITHUB_READ_TOKEN_ACME: EXISTING, GITHUB_TOKEN: EXISTING }).stdout,
    ).toBe("");
  });

  test("skips a value equal to CONSOLE_GITHUB_TOKEN", () => {
    expect(
      run({
        GITHUB_READ_TOKEN_ACME: EXISTING,
        CONSOLE_GITHUB_TOKEN: EXISTING,
      }).stdout,
    ).toBe("");
  });

  test("warns with the name when the value equals an existing token", () => {
    expect(
      run({ GITHUB_READ_TOKEN_ACME: EXISTING, GITHUB_TOKEN: EXISTING }).stderr,
    ).toContain("GITHUB_READ_TOKEN_ACME");
  });

  test("keeps the existing token out of the warning", () => {
    expect(
      run({ GITHUB_READ_TOKEN_ACME: EXISTING, GITHUB_TOKEN: EXISTING }).stderr,
    ).not.toContain("EXISTINGVALUE");
  });

  test("keeps a value that only starts like an existing token", () => {
    expect(
      parsed(
        run({
          GITHUB_READ_TOKEN_ACME: `${EXISTING}x`,
          GITHUB_TOKEN: EXISTING,
        }),
      ),
    ).toEqual({ acme: `${EXISTING}x` });
  });

  test("does not compare with an unset GITHUB_TOKEN", () => {
    expect(
      parsed(run({ GITHUB_READ_TOKEN_ACME: PAT_ACME, GITHUB_TOKEN: "" })),
    ).toEqual({ acme: PAT_ACME });
  });

  test("treats the pattern characters in an existing token literally", () => {
    expect(
      parsed(
        run({
          GITHUB_READ_TOKEN_ACME: PAT_ACME,
          GITHUB_TOKEN: "github_pat_*",
        }),
      ),
    ).toEqual({ acme: PAT_ACME });
  });
});

describe("read_token_map_json keeps the tokens off the command line", () => {
  test("passes no value through --arg", () => {
    expect(FUNCTION).not.toMatch(/--arg\s/);
  });

  test("hands the values to jq through the environment", () => {
    expect(FUNCTION).toMatch(/env\[/);
  });

  test("enumerates the variables by name", () => {
    expect(FUNCTION).toContain("${!GITHUB_READ_TOKEN_@}");
  });

  test("never prints a value to the error output, whatever the mix", () => {
    const stderr = run({
      GITHUB_READ_TOKEN_ACME: PAT_ACME,
      GITHUB_READ_TOKEN_Octo: PAT_OCTO,
      GITHUB_READ_TOKEN_OCTO: PAT_OTHER,
      GITHUB_READ_TOKEN_BAD__NAME: PAT_ACME,
      GITHUB_READ_TOKEN_PLAIN: "plain-value-not-a-pat",
      GITHUB_TOKEN: EXISTING,
    }).stderr;
    expect(stderr).not.toMatch(/VALUE|plain-value/);
  });
});

describe("bootstrap.sh step 7", () => {
  const source = readFileSync(BOOTSTRAP, "utf8");

  test("stores the map in the github_read_tokens variable", () => {
    expect(source).toContain('upsert_variable "f/factory/github_read_tokens"');
  });

  test("builds the map with read_token_map_json", () => {
    expect(source).toMatch(/=\s*"\$\(read_token_map_json\)"/);
  });

  test("describes five secret variables, not four", () => {
    expect(source).not.toContain("4つの秘密の変数");
  });
});
