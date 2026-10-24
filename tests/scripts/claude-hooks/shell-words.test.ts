import { describe, expect, test } from "bun:test";
import {
  CURRENT_BRANCH_SUBSTITUTIONS,
  literalShellInputs,
  miseOptionTakesNext,
  parseCommandLine,
  scanMiseGlobalOptions,
  stripWrappers,
  type Word,
} from "../../../scripts/claude-hooks/shell-words.ts";

/** 語の文字列だけを並べた形にする。構文エラーならテストを失敗させる。 */
function commandTexts(line: string): string[][] {
  const result = parseCommandLine(line);
  if (!result.ok) throw new Error(result.error);
  return result.commands.map((command) =>
    command.words.map((word) => word.text),
  );
}

function redirectTexts(line: string): string[] {
  const result = parseCommandLine(line);
  if (!result.ok) throw new Error(result.error);
  return result.commands.flatMap((command) =>
    command.redirects.map((word) => word.text),
  );
}

function words(...texts: string[]): Word[] {
  return texts.map((text) => ({ text, dynamic: false, glob: false }));
}

describe("parseCommandLine", () => {
  test("splits commands on && and pipes", () => {
    expect(commandTexts("git status && git log | head")).toEqual([
      ["git", "status"],
      ["git", "log"],
      ["head"],
    ]);
  });

  test("keeps a double-quoted argument as one word", () => {
    expect(commandTexts('git commit -m "a b"')).toEqual([
      ["git", "commit", "-m", "a b"],
    ]);
  });

  test("does not split on operators inside single quotes", () => {
    expect(commandTexts("echo 'a; git push -f'")).toEqual([
      ["echo", "a; git push -f"],
    ]);
  });

  test("skips a here-document body", () => {
    expect(commandTexts("cat <<'EOF'\ngit push -f\nEOF\necho done")).toEqual([
      ["cat"],
      ["echo", "done"],
    ]);
  });

  test("reads a commit message here-document with an apostrophe inside $(...)", () => {
    expect(
      commandTexts("git commit -m \"$(cat <<'EOF'\nfix: don't push\nEOF\n)\""),
    ).toEqual([["cat"], ["git", "commit", "-m", "$(...)"]]);
  });

  test("reads commands inside $(...) as separate commands", () => {
    expect(commandTexts('echo "$(git push -f)"')).toContainEqual([
      "git",
      "push",
      "-f",
    ]);
  });

  test("reads commands inside backquotes as separate commands", () => {
    expect(commandTexts("echo `git push -f`")).toContainEqual([
      "git",
      "push",
      "-f",
    ]);
  });

  test("reads the script of sh -c as separate commands", () => {
    expect(commandTexts('sh -c "git push -f"')).toContainEqual([
      "git",
      "push",
      "-f",
    ]);
  });

  test("reads the arguments of eval as a command line", () => {
    expect(commandTexts("eval git push -f")).toContainEqual([
      "git",
      "push",
      "-f",
    ]);
  });

  test("keeps redirection targets out of the words", () => {
    expect(commandTexts("git push origin feature 2>&1 > out.log")).toEqual([
      ["git", "push", "origin", "feature"],
    ]);
  });

  test("records redirection targets", () => {
    expect(
      redirectTexts("while read l; do echo x; done < secrets.txt"),
    ).toContain("secrets.txt");
  });

  test("marks a word with a variable as dynamic", () => {
    const result = parseCommandLine('git push origin "$BRANCH"');
    expect(result.ok && result.commands[0]?.words[3]?.dynamic).toBe(true);
  });

  test("marks an unquoted glob", () => {
    const result = parseCommandLine("cat *.toml");
    expect(result.ok && result.commands[0]?.words[1]?.glob).toBe(true);
  });

  test("does not mark a quoted asterisk as a glob", () => {
    const result = parseCommandLine('grep "a*b" file');
    expect(result.ok && result.commands[0]?.words[1]?.glob).toBe(false);
  });

  test("reports an unterminated quote", () => {
    expect(parseCommandLine('git commit -m "x').ok).toBe(false);
  });

  test("reports an unexpected closing parenthesis", () => {
    expect(parseCommandLine("echo a)").ok).toBe(false);
  });
});

describe("stripWrappers", () => {
  test("removes assignments and wrapper commands", () => {
    const stripped = stripWrappers(
      words("FOO=1", "env", "-u", "X", "nice", "-n", "5", "git", "push"),
    );
    expect(stripped.words.map((word) => word.text)).toEqual(["git", "push"]);
  });

  test("collects leading assignments", () => {
    const stripped = stripWrappers(words("LEFTHOOK=0", "git", "commit"));
    expect(stripped.assignments.map((word) => word.text)).toEqual([
      "LEFTHOOK=0",
    ]);
  });

  test("collects leading append assignments", () => {
    const stripped = stripWrappers(words("LEFTHOOK+=0", "git", "commit"));
    expect(stripped.assignments.map((word) => word.text)).toEqual([
      "LEFTHOOK+=0",
    ]);
  });

  test("skips mise exec up to --", () => {
    const stripped = stripWrappers(
      words("mise", "exec", "--", "bun", "add", "x"),
    );
    expect(stripped.words.map((word) => word.text)).toEqual([
      "bun",
      "add",
      "x",
    ]);
  });

  test("skips the duration of timeout", () => {
    const stripped = stripWrappers(words("timeout", "10", "git", "push"));
    expect(stripped.words.map((word) => word.text)).toEqual(["git", "push"]);
  });

  test("keeps command -v from looking like a program", () => {
    const stripped = stripWrappers(words("command", "-v", "git"));
    expect(stripped.words[0]?.text).toBe("-v");
  });

  test("records xargs as a wrapper", () => {
    const stripped = stripWrappers(words("xargs", "-n", "1", "git", "push"));
    expect(stripped.wrappers).toEqual(["xargs"]);
  });

  test("records no wrapper for a plain command", () => {
    const stripped = stripWrappers(words("git", "push"));
    expect(stripped.wrappers).toEqual([]);
  });
});

/** 最初の単純コマンドに結び付いた入力の語を返す。 */
function inputsOf(line: string): { text: string; dynamic: boolean }[] {
  const result = parseCommandLine(line);
  if (!result.ok) throw new Error(result.error);
  const command = result.commands[0];
  return (command?.inputs ?? []).map(({ text, dynamic }) => ({
    text,
    dynamic,
  }));
}

describe("inputs", () => {
  test("records a here-string as an input", () => {
    expect(inputsOf('bash <<< "echo hi"')).toEqual([
      { text: "echo hi", dynamic: false },
    ]);
  });

  test("records a quoted here-document body as a literal input", () => {
    expect(inputsOf("bash <<'EOF'\ngit status $x\nEOF\n")).toEqual([
      { text: "git status $x\n", dynamic: false },
    ]);
  });

  test("marks an unquoted here-document body with a variable as dynamic", () => {
    expect(inputsOf("bash <<EOF\ngit status $x\nEOF\n")).toEqual([
      { text: "git status $x\n", dynamic: true },
    ]);
  });

  test("strips leading tabs of a <<- here-document body", () => {
    expect(inputsOf("bash <<-EOF\n\tgit status\n\tEOF\n")).toEqual([
      { text: "git status\n", dynamic: false },
    ]);
  });

  test("reads a command substitution in an unquoted here-document", () => {
    expect(commandTexts("cat <<EOF\n$(git push -f)\nEOF\n")).toContainEqual([
      "git",
      "push",
      "-f",
    ]);
  });

  test("does not read a command substitution in a quoted here-document", () => {
    expect(commandTexts("cat <<'EOF'\n$(git push -f)\nEOF\n")).toEqual([
      ["cat"],
    ]);
  });

  test("reads a backquote in an unquoted here-document", () => {
    expect(commandTexts("cat <<EOF\n`git push -f`\nEOF\n")).toContainEqual([
      "git",
      "push",
      "-f",
    ]);
  });
});

describe("case statements", () => {
  test("reads the commands of every clause", () => {
    expect(commandTexts('case "$x" in a) echo a;; b|c) echo b;; esac')).toEqual(
      [
        ["echo", "a"],
        ["echo", "b"],
      ],
    );
  });

  test("reads a multi-line case with a default clause", () => {
    expect(
      commandTexts("case $x in\n  a) echo a ;;\n  *) echo b ;;\nesac\n"),
    ).toEqual([
      ["echo", "a"],
      ["echo", "b"],
    ]);
  });

  test("reads a clause without a closing double semicolon", () => {
    expect(commandTexts("case $x in a) echo a; esac; echo done")).toEqual([
      ["echo", "a"],
      ["echo", "done"],
    ]);
  });

  test("reads a pattern with a leading parenthesis and quotes", () => {
    expect(commandTexts("case $x in (a|'b)') echo hit;; esac")).toEqual([
      ["echo", "hit"],
    ]);
  });

  test("keeps case as a plain word after a command name", () => {
    expect(commandTexts("echo case")).toEqual([["echo", "case"]]);
  });

  test("reads a command inside a nested case clause", () => {
    expect(
      commandTexts("case $x in a) case $y in b) git push -f;; esac;; esac"),
    ).toContainEqual(["git", "push", "-f"]);
  });
});

/** シェルのパラメーター展開の開き。文字列に直接書くとリンターが誤検知するため組み立てる。 */
const OPEN = "$".concat("{");

describe("parameter expansions", () => {
  test("accepts a closing parenthesis inside a parameter expansion", () => {
    expect(commandTexts(`echo ${OPEN}x//)/y}`)).toEqual([
      ["echo", `${OPEN}...}`],
    ]);
  });

  test("accepts a closing parenthesis in a trim pattern", () => {
    expect(commandTexts(`echo ${OPEN}x%%)*}`)).toEqual([
      ["echo", `${OPEN}...}`],
    ]);
  });

  test("marks a parameter expansion as dynamic", () => {
    const result = parseCommandLine(`echo ${OPEN}x:-a b}`);
    expect(result.ok && result.commands[0]?.words[1]?.dynamic).toBe(true);
  });

  test("reads a command substitution inside a parameter expansion", () => {
    expect(commandTexts(`echo ${OPEN}x:-$(git push -f)}`)).toContainEqual([
      "git",
      "push",
      "-f",
    ]);
  });

  test("reports an unterminated parameter expansion", () => {
    expect(parseCommandLine(`echo ${OPEN}x`).ok).toBe(false);
  });
});

function writeTexts(line: string): string[] {
  const result = parseCommandLine(line);
  if (!result.ok) throw new Error(result.error);
  return result.commands.flatMap((command) =>
    command.writeTargets.map((word) => word.text),
  );
}

describe("write targets", () => {
  test("records the target of >", () => {
    expect(writeTexts("echo x > out.txt")).toEqual(["out.txt"]);
  });

  test("records the target of >>", () => {
    expect(writeTexts("echo x >> out.txt")).toEqual(["out.txt"]);
  });

  test("records the target of >|", () => {
    expect(writeTexts("echo x >| out.txt")).toEqual(["out.txt"]);
  });

  test("records the target of &>", () => {
    expect(writeTexts("echo x &> out.txt")).toEqual(["out.txt"]);
  });

  test("records the target of <>", () => {
    expect(writeTexts("echo x <> out.txt")).toEqual(["out.txt"]);
  });

  test("does not record the source of <", () => {
    expect(writeTexts("cat < in.txt")).toEqual([]);
  });

  test("keeps the source of < in the redirects", () => {
    expect(redirectTexts("cat < in.txt")).toEqual(["in.txt"]);
  });

  test("does not record a file descriptor duplication", () => {
    expect(writeTexts("echo x 2>&1")).toEqual([]);
  });
});

describe("stripWrappers options", () => {
  test("skips the option of command", () => {
    const stripped = stripWrappers(words("command", "-p", "git", "push"));
    expect(stripped.words.map((word) => word.text)).toEqual(["git", "push"]);
  });

  test("skips the option of time", () => {
    const stripped = stripWrappers(words("time", "-p", "git", "push"));
    expect(stripped.words.map((word) => word.text)).toEqual(["git", "push"]);
  });

  test("skips the option and value of exec -a", () => {
    const stripped = stripWrappers(words("exec", "-a", "name", "git", "push"));
    expect(stripped.words.map((word) => word.text)).toEqual(["git", "push"]);
  });
});

describe("stripWrappers with mise exec", () => {
  test("reads the command of a form without --", () => {
    const stripped = stripWrappers(
      words("mise", "exec", "node@22", "git", "push"),
    );
    expect(stripped.words.map((word) => word.text)).toEqual(["git", "push"]);
  });

  test("reads a command that follows no tool", () => {
    const stripped = stripWrappers(words("mise", "exec", "bash"));
    expect(stripped.words.map((word) => word.text)).toEqual(["bash"]);
  });

  test("keeps the raw command that follows --", () => {
    const stripped = stripWrappers(words("mise", "exec", "--", "env"));
    expect(stripped.mise?.inner.map((word) => word.text)).toEqual(["env"]);
  });

  test("reads the command string of -c", () => {
    const stripped = stripWrappers(words("mise", "exec", "-c", "echo hi"));
    expect(stripped.mise?.commandString?.text).toBe("echo hi");
  });

  test("reads the command string of --command", () => {
    const stripped = stripWrappers(
      words("mise", "exec", "--command", "echo hi"),
    );
    expect(stripped.mise?.commandString?.text).toBe("echo hi");
  });

  test("reads the command string of --command=", () => {
    const stripped = stripWrappers(words("mise", "x", "--command=echo hi"));
    expect(stripped.mise?.commandString?.text).toBe("echo hi");
  });

  test("leaves no program after a command string", () => {
    const stripped = stripWrappers(words("mise", "exec", "-c", "echo hi"));
    expect(stripped.words).toEqual([]);
  });

  test("records no mise for a plain command", () => {
    expect(stripWrappers(words("git", "push")).mise).toBeNull();
  });
});

/** 最後の単純コマンドの、パイプの前のコマンドの語を返す。 */
function pipedFromTexts(line: string): string[] | null {
  const result = parseCommandLine(line);
  if (!result.ok) throw new Error(result.error);
  const source = result.commands.at(-1)?.pipedFrom;
  return source ? source.words.map((word) => word.text) : null;
}

describe("pipelines", () => {
  test("records the command before a pipe", () => {
    expect(pipedFromTexts("echo hi | sh")).toEqual(["echo", "hi"]);
  });

  test("records the command before a |& pipe", () => {
    expect(pipedFromTexts("echo hi |& sh")).toEqual(["echo", "hi"]);
  });

  test("records the previous stage of a longer pipeline", () => {
    expect(pipedFromTexts("echo hi | cat | sh")).toEqual(["cat"]);
  });

  test("records the command across a newline after the pipe", () => {
    expect(pipedFromTexts("echo hi |\nsh")).toEqual(["echo", "hi"]);
  });

  test("records nothing after &&", () => {
    expect(pipedFromTexts("echo hi && sh")).toBeNull();
  });

  test("records nothing after ||", () => {
    expect(pipedFromTexts("echo hi || sh")).toBeNull();
  });

  test("records nothing after a semicolon", () => {
    expect(pipedFromTexts("echo hi; sh")).toBeNull();
  });

  test("keeps || out of the commands", () => {
    expect(commandTexts("a || b")).toEqual([["a"], ["b"]]);
  });
});

describe("stripWrappers with paths and --", () => {
  test("strips env given by an absolute path", () => {
    const stripped = stripWrappers(
      words("/usr/bin/env", "FOO=1", "git", "push"),
    );
    expect(stripped.words.map((word) => word.text)).toEqual(["git", "push"]);
  });

  test("records an absolute env as a wrapper", () => {
    expect(stripWrappers(words("/usr/bin/env")).wrappers).toEqual(["env"]);
  });

  test("uses the command after -- when it follows a tool", () => {
    const stripped = stripWrappers(words("mise", "exec", "node", "--", "env"));
    expect(stripped.mise?.inner.map((word) => word.text)).toEqual(["env"]);
  });

  test("skips -- after command", () => {
    const stripped = stripWrappers(words("command", "--", "git", "push"));
    expect(stripped.words.map((word) => word.text)).toEqual(["git", "push"]);
  });

  test("skips a cluster of flags after exec", () => {
    const stripped = stripWrappers(words("exec", "-cl", "git", "push"));
    expect(stripped.words.map((word) => word.text)).toEqual(["git", "push"]);
  });
});

describe("current branch substitutions", () => {
  test("accepts git branch --show-current as a static word", () => {
    const result = parseCommandLine(
      'git push origin "$(git branch --show-current)"',
    );
    expect(result.ok && result.commands.at(-1)?.words[3]?.dynamic).toBe(false);
  });

  test("accepts git rev-parse --abbrev-ref HEAD as a static word", () => {
    const result = parseCommandLine(
      "git push origin $(git rev-parse --abbrev-ref HEAD)",
    );
    expect(result.ok && result.commands.at(-1)?.words[3]?.dynamic).toBe(false);
  });

  test("keeps the substitution marker as the text", () => {
    const result = parseCommandLine(
      'git push origin "$(git branch --show-current)"',
    );
    expect(result.ok && result.commands.at(-1)?.words[3]?.text).toBe(
      CURRENT_BRANCH_SUBSTITUTIONS[0],
    );
  });

  test("keeps another substitution dynamic", () => {
    const result = parseCommandLine('git push origin "$(git rev-parse HEAD)"');
    expect(result.ok && result.commands.at(-1)?.words[3]?.dynamic).toBe(true);
  });

  test("keeps a word that mixes the substitution with text dynamic", () => {
    const result = parseCommandLine(
      'git push origin "x/$(git branch --show-current)"',
    );
    expect(result.ok && result.commands.at(-1)?.words[3]?.dynamic).toBe(true);
  });
});

describe("more shells", () => {
  test.each(["fish", "ash", "mksh", "tcsh", "csh"])(
    "reads the script of %s -c",
    (shell) => {
      expect(commandTexts(`${shell} -c "git push -f"`)).toContainEqual([
        "git",
        "push",
        "-f",
      ]);
    },
  );

  test("reads the script of busybox sh -c", () => {
    expect(commandTexts('busybox sh -c "git push -f"')).toContainEqual([
      "git",
      "push",
      "-f",
    ]);
  });
});

describe("ANSI-C quoted words", () => {
  test.each([
    ["echo $'a\\x62c'", "abc"],
    ["echo $'a\\x6z'", "a\u0006z"],
    ["echo $'a\\142c'", "abc"],
    ["echo $'a\\0c'", "a"],
    ["echo $'a\\u0062c'", "abc"],
    ["echo $'a\\U00000062c'", "abc"],
    ["echo $'a\\u3042c'", "aあc"],
    ["echo $'a\\nb'", "a\nb"],
    ["echo $'a\\tb'", "a\tb"],
    ["echo $'a\\eb'", "a\u001bb"],
    ["echo $'a\\\\b'", "a\\b"],
    ["echo $'a\\'b'", "a'b"],
    ["echo $'a\\\"b'", 'a"b'],
    ["echo $'a\\qb'", "a\\qb"],
    ["echo $'a\\x00b'", "a"],
  ])("%s expands to one word", (line, expected) => {
    expect(commandTexts(line)).toEqual([["echo", expected]]);
  });

  test("keeps a word that joins an escape with plain text", () => {
    expect(commandTexts("echo pre$'\\x66'ix")).toEqual([["echo", "prefix"]]);
  });
});

describe("stripWrappers with global options of mise", () => {
  test.each([
    [["-q"]],
    [["-v"]],
    [["-vv"]],
    [["-y"]],
    [["-qy"]],
    [["--quiet"]],
    [["--no-config"]],
    [["--cd=/repo"]],
    [["-C", "/repo"]],
    [["--cd", "/repo"]],
    [["-E", "ci"]],
    [["--env", "ci"]],
    [["-P", "dev"]],
    [["-qC", "/repo"]],
    [["-q", "-C", "/repo", "-E", "ci"]],
  ])("reads the command that follows mise %p exec --", (options: string[]) => {
    const stripped = stripWrappers(
      words("mise", ...options, "exec", "--", "git", "push"),
    );
    expect(stripped.words.map((word) => word.text)).toEqual(["git", "push"]);
  });

  test("reads the command of x with a global option", () => {
    const stripped = stripWrappers(words("mise", "-q", "x", "--", "env"));
    expect(stripped.mise?.inner.map((word) => word.text)).toEqual(["env"]);
  });

  test("leaves mise alone when run follows the global options", () => {
    const stripped = stripWrappers(words("mise", "-q", "run", "check"));
    expect(stripped.words.map((word) => word.text)).toEqual([
      "mise",
      "-q",
      "run",
      "check",
    ]);
  });
});

describe("NUL in an ANSI-C quoted word", () => {
  test.each([
    ["echo $'a\\000b'", "a"],
    ["echo $'a\\u0000b'", "a"],
    ["echo $'a\\0b\\'c'd", "ad"],
  ])("%s is cut at the NUL, as bash does", (line, expected) => {
    expect(commandTexts(line)).toEqual([["echo", expected]]);
  });

  test("keeps the spelling without the NUL as a variant", () => {
    const result = parseCommandLine("echo $'hol\\x00d'");
    const variants = result.ok ? result.commands[0]?.words[1]?.variants : null;

    expect(variants).toEqual(["hold"]);
  });

  test("gives a word without a NUL no variant", () => {
    const result = parseCommandLine("echo hold");
    const variants = result.ok ? result.commands[0]?.words[1]?.variants : null;

    expect(variants).toBeUndefined();
  });
});

describe("dollar double quotes", () => {
  test('reads $"..." as a double quoted word', () => {
    expect(commandTexts('echo $"a b"')).toEqual([["echo", "a b"]]);
  });

  test('joins $"..." with the text around it', () => {
    expect(commandTexts('echo x/$"hold".ts')).toEqual([["echo", "x/hold.ts"]]);
  });

  test("keeps a dollar inside double quotes", () => {
    expect(commandTexts('echo "a$"')).toEqual([["echo", "a$"]]);
  });
});

describe("zsh =command words", () => {
  test("reads =git as git", () => {
    const stripped = stripWrappers(words("=git", "push"));
    expect(stripped.words.map((word) => word.text)).toEqual(["git", "push"]);
  });

  test("strips =env as a wrapper", () => {
    const stripped = stripWrappers(words("=env", "git", "push"));
    expect(stripped.words.map((word) => word.text)).toEqual(["git", "push"]);
  });

  test("keeps a word that is not a command name", () => {
    const stripped = stripWrappers(words("=", "x"));
    expect(stripped.words.map((word) => word.text)).toEqual(["=", "x"]);
  });
});

describe("global options of mise", () => {
  test.each(["--log-level", "--output", "-s", "--shell", "-t", "--tool"])(
    "%s takes the next word",
    (option) => {
      expect(miseOptionTakesNext(option)).toBe(true);
    },
  );

  test("takes the next word at the end of a bundle", () => {
    expect(miseOptionTakesNext("-qE")).toBe(true);
  });

  test("keeps the value inside a bundle where the first value letter is not last", () => {
    expect(miseOptionTakesNext("-EC")).toBe(false);
  });

  test("reads a command after a bundle with an inline value", () => {
    const stripped = stripWrappers(words("mise", "-EC", "x", "--", "env"));
    expect(stripped.mise?.inner.map((word) => word.text)).toEqual(["env"]);
  });

  test.each(["--log-level", "--output", "-s", "--shell", "-t", "--tool"])(
    "reads the command that follows mise %s <value> x --",
    (option) => {
      const stripped = stripWrappers(
        words("mise", option, "v", "x", "--", "env"),
      );
      expect(stripped.mise?.inner.map((word) => word.text)).toEqual(["env"]);
    },
  );

  test("reports an unknown long option", () => {
    expect(
      scanMiseGlobalOptions(words("mise", "--future", "x"), 1).unknown,
    ).toBe(true);
  });

  test("does not report a known flag", () => {
    expect(
      scanMiseGlobalOptions(words("mise", "--quiet", "x"), 1).unknown,
    ).toBe(false);
  });

  test("does not report a long option with =", () => {
    expect(
      scanMiseGlobalOptions(words("mise", "--future=1", "x"), 1).unknown,
    ).toBe(false);
  });

  test("falls back to the first exec word after an unknown option", () => {
    const stripped = stripWrappers(
      words("mise", "--future", "v", "x", "--", "env"),
    );
    expect(stripped.mise?.inner.map((word) => word.text)).toEqual(["env"]);
  });
});

/** 最後の単純コマンドに結び付いた、標準入力で渡る文字列を返す。 */
function shellInputsOf(line: string): readonly string[] | null {
  const result = parseCommandLine(line);
  if (!result.ok) throw new Error(result.error);
  const last = result.commands.at(-1);
  if (last === undefined) throw new Error("no command");
  return literalShellInputs(last);
}

describe("literalShellInputs", () => {
  test("returns the body of a here-document", () => {
    expect(shellInputsOf("sh <<'EOF'\ngh pr merge 1\nEOF\n")).toEqual([
      "gh pr merge 1\n",
    ]);
  });

  test("returns the text of a here-string", () => {
    expect(shellInputsOf('sh <<< "gh pr merge 1"')).toEqual(["gh pr merge 1"]);
  });

  test("returns the text that echo writes", () => {
    expect(shellInputsOf("echo 'gh pr merge 1' | sh")).toEqual([
      "gh pr merge 1",
    ]);
  });

  test("skips the options of echo", () => {
    expect(shellInputsOf("echo -n 'gh pr merge 1' | sh")).toEqual([
      "gh pr merge 1",
    ]);
  });

  test("returns every argument that printf writes", () => {
    expect(shellInputsOf("printf '%s\\n' 'a' | sh")).toEqual(["%s\n", "a"]);
  });

  test("turns a backslash n of echo into a newline", () => {
    expect(shellInputsOf("echo 'a\\nb' | sh")).toEqual(["a\nb"]);
  });

  test("returns null when echo writes a variable", () => {
    expect(shellInputsOf('echo "$X" | sh')).toBeNull();
  });

  test("returns nothing readable for a pipe from another program", () => {
    expect(shellInputsOf("curl example.test | sh")).toEqual([]);
  });

  test("returns nothing without a pipe or an input", () => {
    expect(shellInputsOf("sh")).toEqual([]);
  });

  test("looks through a wrapper before the echo", () => {
    expect(shellInputsOf("env echo 'gh pr merge 1' | sh")).toEqual([
      "gh pr merge 1",
    ]);
  });
});

describe("stripWrappers with env -S", () => {
  function stripped(line: string): string[] {
    const result = parseCommandLine(line);
    if (!result.ok) throw new Error(result.error);
    const first = result.commands[0];
    if (first === undefined) throw new Error("no command");
    return stripWrappers(first.words).words.map((word) => word.text);
  }

  test("reads the command in the split string", () => {
    expect(stripped("env -S 'git push --force'")).toEqual([
      "git",
      "push",
      "--force",
    ]);
  });

  test("reads the long option", () => {
    expect(stripped("env --split-string='git push -f'")).toEqual([
      "git",
      "push",
      "-f",
    ]);
  });

  test("reads an attached value", () => {
    expect(stripped("env -S'git push -f'")).toEqual(["git", "push", "-f"]);
  });

  test("keeps the words after the split string", () => {
    expect(stripped("env -S 'git push' --force")).toEqual([
      "git",
      "push",
      "--force",
    ]);
  });

  test("skips the options before the split string", () => {
    expect(stripped("env -i -S 'git push -f'")).toEqual(["git", "push", "-f"]);
  });

  test("leaves a split string decided at run time as it is", () => {
    expect(stripped('env -S "$CMD"')).toEqual([]);
  });
});
