import { describe, expect, test } from "bun:test";
import {
  CURRENT_BRANCH_SUBSTITUTIONS,
  literalShellInputs,
  miseOptionTakesNext,
  parseCommandLine,
  readShellLaunch,
  readsStandardInput,
  scanMiseGlobalOptions,
  shellInvocation,
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

/** シェルのパラメーター展開の開き。文字列に直接書くとリンターが誤検知するため組み立てる。 */
const OPEN = "$".concat("{");

/** 構文として読めたかどうか。 */
function parses(line: string): boolean {
  return parseCommandLine(line).ok;
}

/** 読めない構文として拒否する語を先頭に置いた行。種類の名前と行の組である。 */
const UNREADABLE_LEADING: readonly (readonly [string, string])[] = [
  ["a precommand modifier", "nocorrect git push"],
  ["a lone dash modifier", "- git push"],
  ["a try-block continuation", "always git push"],
  ["a coprocess without a name", "coproc git push"],
  ["a coprocess with a name", "coproc NAME git push"],
  ["a repeat loop", "repeat 1 git push"],
  ["a function definition keyword", "function git push"],
  ["a case clause with a pattern", "case x in a) git push;; esac"],
  ["a case terminator", "esac git push"],
];

/**
 * `case`の語そのものの拒否を確かめる行。パターンの`)`を含まないので、
 * 構文が`)`で崩れる前に、先頭の語の判定が拒否することになる。
 */
const CASE_WORD_FORMS: readonly (readonly [string, string])[] = [
  ["a case header alone", "case x"],
  ["a case header with in", "case x in a"],
  ["a case terminator alone", "esac"],
  ["a case header behind an assignment", "X=1 case x"],
];

describe("reserved words the parser cannot read", () => {
  test.each(UNREADABLE_LEADING)(
    "rejects %s at the start of a command",
    (_kind, line) => {
      expect(parses(line)).toBe(false);
    },
  );

  test.each(UNREADABLE_LEADING)(
    "rejects %s behind a transparent word",
    (_kind, line) => {
      expect(parses(`then ${line}`)).toBe(false);
    },
  );

  test.each([
    ["env", "env nocorrect git push"],
    ["nice", "nice -n 5 nocorrect git push"],
    ["time", "time nocorrect git push"],
    ["command", "command nocorrect git push"],
    ["an assignment", "X=1 nocorrect git push"],
    ["mise exec", "mise exec -- nocorrect git push"],
    ["a lone dash after env", "env - git push"],
  ])("rejects a reserved word behind %s", (_wrapper, line) => {
    expect(parses(line)).toBe(false);
  });

  test("rejects a case clause with a pattern behind a transparent word in a double-quoted substitution", () => {
    expect(parses('echo "$(then case x in a) :;; esac)"')).toBe(false);
  });

  test("rejects a case clause with a pattern behind a transparent word in a parameter expansion", () => {
    expect(parses(`echo ${OPEN}x:-$(then case x in a) :;; esac)}`)).toBe(false);
  });

  test("rejects a case clause with a pattern behind a transparent word in a here-document body", () => {
    expect(parses("cat <<EOF\n$(then case x in a) :;; esac)\nEOF\n")).toBe(
      false,
    );
  });

  test.each(CASE_WORD_FORMS)("rejects the case word of %s", (_kind, line) => {
    expect(parses(line)).toBe(false);
  });

  test.each(CASE_WORD_FORMS)(
    "rejects the case word of %s behind a transparent word",
    (_kind, line) => {
      expect(parses(`then ${line}`)).toBe(false);
    },
  );

  test.each(CASE_WORD_FORMS)(
    "rejects the case word of %s in a double-quoted substitution",
    (_kind, line) => {
      expect(parses(`echo "$(${line})"`)).toBe(false);
    },
  );

  test.each(CASE_WORD_FORMS)(
    "rejects the case word of %s in a parameter expansion",
    (_kind, line) => {
      expect(parses(`echo ${OPEN}x:-$(${line})}`)).toBe(false);
    },
  );

  test.each(CASE_WORD_FORMS)(
    "rejects the case word of %s in a here-document body",
    (_kind, line) => {
      expect(parses(`cat <<EOF\n$(${line})\nEOF\n`)).toBe(false);
    },
  );

  test.each([
    ["a single-quoted spelling", "'case' x"],
    ["a backslash spelling", "ca\\se x"],
  ])("rejects the case word written with %s", (_spelling, line) => {
    expect(parses(line)).toBe(false);
  });

  test("rejects a coprocess followed by a parenthesis", () => {
    const result = parseCommandLine("coproc (git push)");
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("may start a glob group");
  });

  test("keeps case as a plain word after a command name", () => {
    expect(commandTexts("echo case")).toEqual([["echo", "case"]]);
  });

  test("rejects a zsh foreach loop through its parenthesis", () => {
    expect(parses("foreach x (a b) echo $x end")).toBe(false);
  });

  test("marks a reserved word at the start as unreadable", () => {
    expect(stripWrappers(words("nocorrect", "git", "push")).unreadable).toBe(
      true,
    );
  });

  test("keeps the words of an unreadable command as they were", () => {
    const stripped = stripWrappers(words("nocorrect", "git", "push"));
    expect(stripped.words.map((word) => word.text)).toEqual([
      "nocorrect",
      "git",
      "push",
    ]);
  });

  test("does not mark a plain command as unreadable", () => {
    expect(stripWrappers(words("git", "push")).unreadable).toBe(false);
  });
});

describe("for and select headers", () => {
  test.each([
    ["a for loop with in", "for x in a b; do echo $x; done"],
    ["a select loop with in", "select x in a b; do echo $x; done"],
    ["a for header of two words", "for x\ndo echo $x; done"],
    ["an arithmetic for header", "for ((i=0; i<3; i++)); do echo $i; done"],
  ])("accepts %s", (_form, line) => {
    expect(parses(line)).toBe(true);
  });

  test.each([
    ["a for loop", "for NAME do git push; done"],
    ["a select loop", "select NAME do git push; done"],
    ["a for loop behind a transparent word", "then for NAME do git push; done"],
  ])("rejects %s whose do joins the header command", (_form, line) => {
    expect(parses(line)).toBe(false);
  });
});

describe("conditional expressions", () => {
  test.each([
    ["a conditional alone", "[[ -n x ]]"],
    ["a conditional joined to a command", "[[ a && b ]] && cat a"],
    ["a conditional and a separate command", "[[ -n x ]]; git status"],
  ])("accepts %s", (_form, line) => {
    expect(parses(line)).toBe(true);
  });

  test.each([
    ["a body after the closing", "[[ -n x ]] git push"],
    ["a body after the closing behind &&", "[[ a && b ]] git push"],
    ["a closing at the start", "]] git push"],
  ])("rejects %s in one simple command", (_form, line) => {
    expect(parses(line)).toBe(false);
  });
});

describe("closing braces", () => {
  test.each([
    ["a group", "{ echo a; }"],
    ["a function definition", "f() { echo a; }"],
    ["a brace expansion", "echo {a,b}"],
    ["a word that ends with a brace", "echo a}"],
  ])("accepts %s", (_form, line) => {
    expect(parses(line)).toBe(true);
  });

  test.each([
    ["a bare closing brace", "echo a } git push"],
    ["a quoted closing brace", "echo a '}' git push"],
  ])("rejects %s left in the words", (_form, line) => {
    expect(parses(line)).toBe(false);
  });
});

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

  test("follows a pipe chain back to the echo", () => {
    expect(
      shellInputsOf("echo 'gh pr merge 1' | cat | tee /dev/null | sh"),
    ).toEqual(["gh pr merge 1"]);
  });

  test("returns the here-document of a command earlier in the chain", () => {
    expect(shellInputsOf("cat <<'EOF' | sh\ngh pr merge 1\nEOF\n")).toEqual([
      "gh pr merge 1\n",
    ]);
  });

  test("returns null when an echo earlier in the chain writes a variable", () => {
    expect(shellInputsOf('echo "$X" | cat | sh')).toBeNull();
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

  test("keeps a semicolon inside a word of the split string", () => {
    expect(stripped("env -S 'gh pr merge 1 --subject a;b'")).toEqual([
      "gh",
      "pr",
      "merge",
      "1",
      "--subject",
      "a;b",
    ]);
  });

  test("keeps a quoted word of the split string together", () => {
    expect(stripped("env -S 'echo \"a b\" c'")).toEqual(["echo", "a b", "c"]);
  });

  test("does not treat a pipe as an operator", () => {
    expect(stripped("env -S 'git push | cat'")).toEqual([
      "git",
      "push",
      "|",
      "cat",
    ]);
  });

  test("reads a bundled option before the split string", () => {
    expect(stripped('env -iS "git push -f"')).toEqual(["git", "push", "-f"]);
  });

  test("reads a bundled option with the string attached", () => {
    expect(stripped('env -vS"git push -f"')).toEqual(["git", "push", "-f"]);
  });

  test("marks an unterminated quote as opaque", () => {
    expect(opaque("env -S 'git push \"x'")).toBe(true);
  });

  test("marks a string decided at run time as opaque", () => {
    expect(opaque('env -S "$CMD"')).toBe(true);
  });

  test("does not mark a readable string as opaque", () => {
    expect(opaque("env -S 'git push'")).toBe(false);
  });

  test("tells that the words came from a split string", () => {
    const result = parseCommandLine("env -S 'git push'");
    const first = result.ok ? result.commands[0] : undefined;
    expect(first && stripWrappers(first.words).expanded).toBe(true);
  });
});

function opaque(line: string): boolean {
  const result = parseCommandLine(line);
  if (!result.ok) throw new Error(result.error);
  const first = result.commands[0];
  if (first === undefined) throw new Error("no command");
  return stripWrappers(first.words).opaque;
}

describe("stripWrappers with options that take a value", () => {
  function stripped(line: string): string[] {
    const result = parseCommandLine(line);
    if (!result.ok) throw new Error(result.error);
    const first = result.commands[0];
    if (first === undefined) throw new Error("no command");
    return stripWrappers(first.words).words.map((word) => word.text);
  }

  test.each([
    ["env -P /usr/bin git status", ["git", "status"]],
    ["xargs -J % git status", ["git", "status"]],
    ["xargs -R 1 git status", ["git", "status"]],
    ["xargs -S 255 git status", ["git", "status"]],
    ["xargs --max-args 1 git status", ["git", "status"]],
    ["xargs --max-procs 2 git status", ["git", "status"]],
    ["xargs -n 1 -P 2 git status", ["git", "status"]],
    ["sudo -iu root git status", ["git", "status"]],
    ["env -uFOO git status", ["git", "status"]],
    ["env -iu FOO git status", ["git", "status"]],
  ])("skips the value in %s", (line, expected) => {
    expect(stripped(line)).toEqual(expected);
  });
});

/** 算術の領域の書き方。本体は同じ規則で読む。 */
const REGION_FORMS: readonly (readonly [string, (body: string) => string])[] = [
  ["a command-position region", (body) => `((${body}))`],
  ["a for-header region", (body) => `for ((${body})); do :; done`],
  ["a substitution region", (body) => `echo $((${body}))`],
  ["a double-quoted substitution region", (body) => `echo "$((${body}))"`],
];

/** 領域の本体として読める、日常の形。 */
const REGION_DAILY_BODIES: readonly (readonly [string, string])[] = [
  ["a sum", "a+b"],
  ["spaces around an operator", " x * 2 "],
  ["a nested parenthesis", "n*(n+1)/2"],
  ["an increment", "i++"],
  ["a loop header", "i=0; i<3; i++"],
  ["a command substitution", " $(date +%s) - t "],
  ["a variable", " $x + 1 "],
  ["a base prefix", "16#ff"],
  ["a ternary", "a ? b : c"],
  ["a subscript", "a[1] + b"],
  ["special parameters", "$# + $? + $$"],
  ["a braced parameter", `${OPEN}x:-1} + 1`],
  ["a comparison", "a >= b"],
];

/** 領域の本体で、閉じた集合の外にある形。 */
const REGION_VIOLATIONS: readonly (readonly [string, string])[] = [
  ["a single quote", "'a'"],
  ["a double quote", '"a"'],
  ["a backslash", "a\\b"],
  ["a backquote", "`date`"],
  ["an ANSI-C quote", "$'a'"],
  ["a locale quote", '$"a"'],
  ["a bracket expansion", "$[1]"],
  ["a newline", "1\n+2"],
  ["a NUL", "1\u0000+2"],
  ["a here-document operator", "1 <<EOF"],
  ["a here-string operator", "a <<< b"],
  ["a tab-stripping operator", "a <<-b"],
  ["a shift-assign operator", "a <<= 1"],
  ["an opening brace", "{a}"],
  ["a closing brace", "a } b"],
  ["a character outside the set", "a @ b"],
  ["a non-ASCII letter", "あ"],
  ["a comment start", "a # b"],
  ["a dollar without a name", "$ "],
];

describe("arithmetic regions read the body as commands", () => {
  test.each(REGION_FORMS)("reads the body of %s", (_form, embed) => {
    expect(commandTexts(embed("git push origin main"))).toContainEqual([
      "git",
      "push",
      "origin",
      "main",
    ]);
  });

  test("reads the body of a substitution region inside a shell string", () => {
    expect(
      commandTexts("sh -c 'echo $((git push origin main))'"),
    ).toContainEqual(["git", "push", "origin", "main"]);
  });

  test("reads the body of a command-position region inside a shell string", () => {
    expect(commandTexts("sh -c '((git push origin main))'")).toContainEqual([
      "git",
      "push",
      "origin",
      "main",
    ]);
  });

  test("reads two subshells joined by an operator inside outer parentheses", () => {
    expect(commandTexts("((git push origin main) | (cat))")).toContainEqual([
      "git",
      "push",
      "origin",
      "main",
    ]);
  });

  test("reads a command inside a substitution inside a region", () => {
    expect(
      commandTexts("echo $(( $(git push origin main) + 1 ))"),
    ).toContainEqual(["git", "push", "origin", "main"]);
  });

  test("reads an arithmetic region inside a parameter expansion", () => {
    expect(
      commandTexts(`echo ${OPEN}x:-$((git push origin main))}`),
    ).toContainEqual(["git", "push", "origin", "main"]);
  });
});

describe("arithmetic regions accept the daily bodies", () => {
  describe.each(REGION_FORMS)("in %s", (_form, embed) => {
    test.each(REGION_DAILY_BODIES)("accepts %s", (_body, text) => {
      expect(parses(embed(text))).toBe(true);
    });
  });

  test.each([
    ["a statement after a region", "((i++)); echo $i"],
    ["a region after a control word", "if ((i > 0)); then echo a; fi"],
    ["a region joined by a list operator", "true && ((i++))"],
    ["nested regions", "echo $(( $((1+2)) + 3 ))"],
  ])("accepts %s", (_form, line) => {
    expect(parses(line)).toBe(true);
  });
});

describe("arithmetic regions reject a character outside the closed set", () => {
  describe.each(REGION_FORMS)("in %s", (_form, embed) => {
    test.each(REGION_VIOLATIONS)("rejects %s", (_body, text) => {
      expect(parses(embed(text))).toBe(false);
    });
  });

  test("rejects a here-document operator in a command-position region before the body lines", () => {
    expect(parses("((cat <<EOF))\ngit push -f\nEOF\n")).toBe(false);
  });

  test("rejects a region that never closes", () => {
    expect(parses("((i++")).toBe(false);
  });

  test("rejects a substitution region that never closes", () => {
    expect(parses("echo $((i++")).toBe(false);
  });

  test("rejects a word followed directly by a double parenthesis", () => {
    expect(parses("echo ((a))")).toBe(false);
  });

  test("keeps the closed set inside a substitution opened in a region", () => {
    expect(parses("echo $(( $(echo 'a') + 1 ))")).toBe(false);
  });

  test("keeps the glob group rejection inside a substitution opened in a region", () => {
    expect(parses("echo $(( $(echo a(b)) + 1 ))")).toBe(false);
  });
});

describe("arithmetic regions keep the redirect and word rules", () => {
  test("records the target of a redirect inside a region", () => {
    expect(writeTexts("((a > out.txt))")).toEqual(["out.txt"]);
  });

  test("rejects a lone dash at the start of a region", () => {
    expect(parses("echo $(( - x ))")).toBe(false);
  });
});

/** `${…}`の中の、読める形。 */
const PARAMETER_ACCEPTED: readonly (readonly [string, string])[] = [
  ["a plain name", `${OPEN}x}`],
  ["the number of arguments", `${OPEN}#}`],
  ["a default", `${OPEN}x:-default}`],
  ["a default with a variable", `${OPEN}x:-$y}`],
  ["a default with a command substitution", `${OPEN}x:-$(cmd)}`],
  ["a replacement", `${OPEN}x//a/b}`],
  ["a length", `${OPEN}#x}`],
  ["a length of an array", `${OPEN}#a[@]}`],
  ["a positional parameter", `${OPEN}1}`],
  ["all positional parameters", `${OPEN}@}`],
  ["the status", `${OPEN}?}`],
  ["the process id", `${OPEN}$}`],
  ["a numeric subscript", `${OPEN}a[0]}`],
  ["a negative subscript", `${OPEN}a[-1]}`],
  ["a name subscript", `${OPEN}a[i]}`],
  ["a variable subscript", `${OPEN}a[$i]}`],
  ["an all-elements subscript", `${OPEN}a[*]}`],
  ["a nested default", `${OPEN}x:-${OPEN}y:-z}}`],
  ["an offset", `${OPEN}x:1:2}`],
  ["a signed offset", `${OPEN}x: -1}`],
  ["a prefix trim", `${OPEN}x##*/}`],
  ["a suffix trim", `${OPEN}x%.*}`],
  ["an alternative", `${OPEN}x:+y}`],
  ["an error message", `${OPEN}x:?msg}`],
  ["a closing parenthesis in a pattern", `${OPEN}x//)/y}`],
  ["an arithmetic region", `${OPEN}x:-$((1+2))}`],
];

/** `${…}`の中の、拒否する形。 */
const PARAMETER_REJECTED: readonly (readonly [string, string])[] = [
  ["an indirection", `${OPEN}!x}`],
  ["a brace in the body", `${OPEN}x:-{a}}`],
  ["an escaped brace in the body", `${OPEN}x:-\\{a}`],
  ["a length of the number of arguments", `${OPEN}##}`],
  ["a transformation", `${OPEN}x@Q}`],
  ["a flag group", `${OPEN}(f)x}`],
  ["a tilde start", `${OPEN}~x}`],
  ["an equals start", `${OPEN}=x}`],
  ["a caret start", `${OPEN}^x}`],
  ["a plus start", `${OPEN}+x}`],
  ["a percent start", `${OPEN}%x}`],
  ["a slash start", `${OPEN}/x}`],
  ["a space start", `${OPEN} x}`],
  ["a parenthesis start", `${OPEN}(x)}`],
  ["a case operator", `${OPEN}x^}`],
  ["a lower-case operator", `${OPEN}x,,}`],
  ["a tilde operator", `${OPEN}x~}`],
  ["a dollar before a name", `${OPEN}$x}`],
  ["an empty expansion", `${OPEN}}`],
  ["an expression subscript", `${OPEN}a[1+2]}`],
  ["a substitution subscript", `${OPEN}a[$(date)]}`],
  ["a spaced subscript", `${OPEN}a[b c]}`],
  ["an unclosed subscript", `${OPEN}a[1}`],
  ["an inner expansion without a name", `${OPEN}x:-${OPEN} y}}`],
  ["an inner flag group", `${OPEN}x:-${OPEN}(f)y}}`],
  ["a single quote in the body", `${OPEN}x:-'a b'}`],
  ["a double quote in the body", `${OPEN}x:-"a"}`],
  ["a parenthesis in the body", `${OPEN}x:-(a)}`],
  ["an input process substitution in the body", `${OPEN}x:-<(a)}`],
  ["an output process substitution in the body", `${OPEN}x:->(a)}`],
  ["an equals group in the body", `${OPEN}x:-=(a)}`],
  ["an escaped dollar in the body", `${OPEN}x:-\\$y}`],
  ["an escaped backquote in the body", `${OPEN}x:-\\\`a\\\`}`],
  ["a bracket expansion in the body", `${OPEN}x:-$[1]}`],
  ["an ANSI-C quote in the body", `${OPEN}x:-$'a'}`],
];

describe("parameter expansions read only a closed set of forms", () => {
  test.each(PARAMETER_ACCEPTED)("accepts %s", (_form, text) => {
    expect(parses(`echo ${text}`)).toBe(true);
  });

  test.each(PARAMETER_REJECTED)("rejects %s", (_form, text) => {
    expect(parses(`echo ${text}`)).toBe(false);
  });

  test.each(PARAMETER_REJECTED)(
    "rejects %s inside double quotes",
    (_form, text) => {
      expect(parses(`echo "${text}"`)).toBe(false);
    },
  );

  test("rejects an expansion nested past the depth limit", () => {
    const nested = `${`${OPEN}x:-`.repeat(20)}${"}".repeat(20)}`;
    expect(parses(`echo ${nested}`)).toBe(false);
  });

  test("accepts an expansion nested within the depth limit", () => {
    const nested = `${`${OPEN}x:-`.repeat(3)}z${"}".repeat(3)}`;
    expect(parses(`echo ${nested}`)).toBe(true);
  });

  test("reads a backquote in the body as commands", () => {
    expect(
      commandTexts(`echo ${OPEN}x:-\`git push origin main\`}`),
    ).toContainEqual(["git", "push", "origin", "main"]);
  });
});

describe("parameter expansions inside a region keep the closed set", () => {
  test.each([
    ["a closing parenthesis", `${OPEN}x//)/y}`],
    ["an opening parenthesis", `${OPEN}x:-(1)}`],
    ["a command substitution", `${OPEN}x:-$(date)}`],
    ["a nested region", `${OPEN}x:-$((1))}`],
    ["a single quote", `${OPEN}x:-'a'}`],
    ["a backslash", `${OPEN}x:-\\a}`],
    ["a brace", `${OPEN}x:-{a}}`],
    ["a nested expansion with a parenthesis", `${OPEN}x:-${OPEN}y:-(1)}}`],
  ])("rejects %s", (_form, text) => {
    expect(parses(`echo $(( ${text} + 1 ))`)).toBe(false);
  });

  test.each([
    ["a plain name", `${OPEN}x} + 1`],
    ["a default", `${OPEN}x:-1} + 1`],
    ["a nested default", `${OPEN}x:-${OPEN}y:-1}} + 1`],
    ["a length", `${OPEN}#x} + 1`],
  ])("accepts %s", (_form, text) => {
    expect(parses(`echo $(( ${text} ))`)).toBe(true);
  });
});

describe("bracket expansions are rejected where expansion happens", () => {
  test.each([
    ["outside quotes", "echo $[1+2]"],
    ["inside double quotes", 'echo "$[1+2]"'],
    ["in a parameter expansion body", `echo ${OPEN}x:-$[1]}`],
    ["in an unquoted here-document body", "cat <<EOF\n$[1+2]\nEOF\n"],
    ["in a region", "echo $(( $[1] ))"],
  ])("rejects a bracket expansion %s", (_where, line) => {
    expect(parses(line)).toBe(false);
  });

  test.each([
    ["inside single quotes", "echo '$[1+2]'"],
    ["in a quoted here-document body", "cat <<'EOF'\n$[1+2]\nEOF\n"],
    ["in a backslash-quoted here-document body", "cat <<\\EOF\n$[1+2]\nEOF\n"],
    [
      "in a double-quoted delimiter here-document body",
      'cat <<"EOF"\n$[1+2]\nEOF\n',
    ],
  ])("accepts a bracket expansion %s", (_where, line) => {
    expect(parses(line)).toBe(true);
  });
});

describe("here-documents and the end of input", () => {
  test.each([
    ["an unclosed subshell", "(echo a"],
    ["a here-document without a body", "cat <<EOF"],
    ["a here-document without a closing line", "cat <<EOF\nbody\n"],
    ["a here-document without a closing line at the end", "cat <<EOF\nbody"],
    ["a pending here-document left by a substitution", "echo $(cat <<EOF)"],
    ["a pending here-document left by a backquote", "echo `cat <<EOF`"],
    ["a substitution body without a closing line", "echo $(cat <<EOF\nx\n)"],
  ])("rejects %s", (_state, line) => {
    expect(parses(line)).toBe(false);
  });

  test.each([
    ["a substitution", "cat <<EOF $(echo a\nb)\nbody\nEOF\n"],
    ["a backquote", "cat <<EOF `echo a\nb`\nbody\nEOF\n"],
    ["a parameter expansion", `cat <<EOF ${OPEN}x:-a\nb}\nbody\nEOF\n`],
  ])(
    "rejects a newline in %s while a here-document is pending",
    (_where, line) => {
      expect(parses(line)).toBe(false);
    },
  );

  test.each([
    ["a bare word", "cat <<EOF\nx\nEOF\n"],
    ["a single-quoted word", "cat <<'EOF'\nx\nEOF\n"],
    ["a double-quoted word", 'cat <<"EOF"\nx\nEOF\n'],
    ["a backslash word", "cat <<\\EOF\nx\nEOF\n"],
    ["a tab-stripping word", "cat <<-EOF\n\tx\n\tEOF\n"],
    [
      "a word with dots, dashes, and underscores",
      "cat <<E.O-F_1\nx\nE.O-F_1\n",
    ],
    ["a word before a redirect", "cat <<EOF > out\nx\nEOF\n"],
    ["a word before a pipe", "cat <<EOF | wc\nx\nEOF\n"],
    ["a closing line at the end of input", "cat <<EOF\nx\nEOF"],
    ["two here-documents", "cat <<A <<B\nx\nA\ny\nB\n"],
    [
      "a here-document inside a substitution",
      "echo \"$(cat <<'EOF'\nx\nEOF\n)\"",
    ],
    [
      "a commit message here-document",
      "git commit -m \"$(cat <<'EOF'\nfix: a\n\nbody\nEOF\n)\"",
    ],
  ])("accepts %s", (_form, line) => {
    expect(parses(line)).toBe(true);
  });

  test.each([
    ["an expansion", "cat <<$x\nx\n$x\n"],
    ["a partly quoted word", "cat <<E'O'F\nx\nEOF\n"],
    ["a command substitution", "cat <<$(a)\nx\n"],
    ["a space in single quotes", "cat <<'a b'\nx\na b\n"],
    ["an expansion in double quotes", 'cat <<"$x"\nx\n$x\n'],
    ["a backslash in the middle", "cat <<E\\OF\nx\nEOF\n"],
    ["text after the closing quote", "cat <<'EOF'x\nx\nEOFx\n"],
    ["a backquote word", "cat <<`a`\nx\n`a`\n"],
    ["a non-ASCII word", "cat <<あ\nx\nあ\n"],
    ["an empty quoted word", "cat <<''\nx\n\n"],
    ["a carriage return after a bare word", "cat <<EOF\r\nx\nEOF\n"],
    ["a no-break space after a bare word", "cat <<EOF\u00a0\nx\nEOF\n"],
    ["a carriage return after a quoted word", "cat <<'EOF'\r\nx\nEOF\n"],
    ["a no-break space after a quoted word", 'cat <<"EOF"\u00a0\nx\nEOF\n'],
  ])("rejects a delimiter that is %s", (_form, line) => {
    expect(parses(line)).toBe(false);
  });
});

describe("a newline in a process substitution while a here-document is pending", () => {
  test.each([
    ["an input substitution with a bare word", "cat <<EOF <(echo a\nx\nEOF\n)"],
    [
      "an input substitution with a quoted word",
      "cat <<'EOF' <(echo a\nx\nEOF\n)",
    ],
    [
      "an output substitution with a bare word",
      "cat <<EOF >(echo a\nx\nEOF\n)",
    ],
    [
      "an output substitution with a quoted word",
      "cat <<'EOF' >(echo a\nx\nEOF\n)",
    ],
  ])("rejects %s", (_form, line) => {
    expect(parses(line)).toBe(false);
  });

  test.each([
    [
      "a here-document placed inside a process substitution",
      "cat <(cat <<'EOF'\nx\ny\nEOF\n)",
    ],
    ["a here-document placed inside a subshell", "(cat <<'EOF'\nx\ny\nEOF\n)"],
    [
      "two here-documents placed inside process substitutions",
      "diff <(cat <<EOF\na\nb\nEOF\n) <(cat <<EOF\na\nEOF\n)",
    ],
    [
      "a subshell closed before the here-document is placed",
      "(echo a); cat <<EOF\nx\nEOF\n",
    ],
    [
      "a deeper process substitution closed on the line of an outer here-document",
      "cat <<EOF <(echo a)\nx\nEOF\n",
    ],
  ])("accepts %s", (_form, line) => {
    expect(parses(line)).toBe(true);
  });
});

describe("a parenthesis closed while a here-document is pending", () => {
  test.each([
    ["an input substitution with a bare word", "cat <(cat <<EOF)\nx\nEOF\n"],
    [
      "an input substitution with a quoted word",
      "cat <(cat <<'EOF')\nx\nEOF\n",
    ],
    ["an output substitution with a bare word", "cat >(cat <<EOF)\nx\nEOF\n"],
    [
      "an output substitution with a quoted word",
      "cat >(cat <<'EOF')\nx\nEOF\n",
    ],
    ["a subshell", "(cat <<EOF)\nx\nEOF\n"],
    [
      "a process substitution reopened at the same depth",
      "cat <(cat <<EOF) <(echo a\nx\nEOF\n)",
    ],
    [
      "a nested subshell reopened at the same depth",
      "( (cat <<EOF) ; (echo a\nx\nEOF\n) )",
    ],
  ])("rejects %s", (_form, line) => {
    expect(parses(line)).toBe(false);
  });
});

describe("interactive shells", () => {
  test.each([
    ["a bundled flag with a command string", "zsh -ic 'ls'"],
    ["a bundled flag in bash", "bash -ic ls"],
    ["a lone flag", "bash -i"],
    ["an option name and value", "bash -o interactive -c ls"],
    ["an option name and value with a plus", "bash +o interactive -c ls"],
    ["an upper-case option name", "bash -O interactive -c ls"],
    ["an option and value in one word", "bash -ointeractive -c ls"],
    ["a long name", "bash --interactive -c ls"],
    [
      "a long name with mixed case and underscores",
      "bash --Inter_Active -c ls",
    ],
    ["a plus flag", "bash +i"],
    ["a script file argument", "bash -i script.sh"],
    ["a flag after the script", "bash script.sh -i"],
    ["a here-string input", "zsh -i <<< 'ls'"],
    ["a here-document input", "zsh -i <<'EOF'\nls\nEOF\n"],
    ["a pipe input", "echo ls | zsh -i"],
    ["a prefixed launch", "env zsh -ic ls"],
    ["a launch in a shell string", "sh -c 'zsh -ic ls'"],
    ["a launch in a substitution", "echo $(zsh -ic ls)"],
    ["a launch through busybox", "busybox sh -ic ls"],
    ["a launch through another shell", "ksh -i"],
    ["a bundle with a digit and a command string", "bash -1i -c ls"],
    ["a bundle with a digit and a here-string", "bash -1i <<< 'ls'"],
    ["a bundle with a digit and a pipe input", "echo ls | bash -1i"],
    ["a bundle with a digit and an option value", "bash -1o interactive -c ls"],
    ["a bundle with a digit in another shell", "ksh -2i"],
    [
      "a hyphenated long name with a command string",
      "bash --inter-active -c ls",
    ],
    ["a mixed-case hyphenated long name", "bash --Inter-Active -c ls"],
    [
      "a long name mixing hyphens and underscores",
      "bash --inter_-active -c ls",
    ],
    [
      "a hyphenated long name with a here-string",
      "bash --inter-active <<< 'ls'",
    ],
    [
      "a hyphenated long name with a here-document",
      "bash --inter-active <<'EOF'\nls\nEOF\n",
    ],
    [
      "a hyphenated long name with a pipe input",
      "echo ls | bash --inter-active",
    ],
    [
      "a hyphenated long name with a stdin flag",
      "echo ls | bash -s --inter-active",
    ],
    ["a hyphenated option value", "bash -o inter-active -c ls"],
    ["a mixed-case hyphenated option value", "bash -O Inter-Active <<< 'ls'"],
    [
      "a hyphenated option value with a here-document",
      "bash -o inter-active <<'EOF'\nls\nEOF\n",
    ],
    [
      "a hyphenated option value with a pipe input",
      "echo ls | bash -o inter-active",
    ],
    [
      "a hyphenated option value with a stdin flag",
      "echo ls | bash -s -o inter-active",
    ],
    [
      "a script option that contains the flag name",
      "bash --non-interactive -c ls",
    ],
  ])("rejects %s", (_form, line) => {
    expect(parses(line)).toBe(false);
  });

  test.each([
    ["zsh with a command string", "zsh -c ls"],
    ["bash with a command string", "bash -c ls"],
    ["a script file", "bash script.sh"],
    ["a login shell", "bash --login -c ls"],
    ["an installer script with a long option", "bash -s -- --install-dir"],
    ["a here-string input", "bash <<< 'ls'"],
    ["a here-document input", "bash <<'EOF'\nls\nEOF\n"],
  ])("accepts %s", (_form, line) => {
    expect(parses(line)).toBe(true);
  });
});

describe("forms that change the lexical rules at run time", () => {
  test.each([
    ["a lower-case name", "zsh -c 'histchars=ab'"],
    ["an upper-case name", "zsh -c 'HISTCHARS=ab'"],
    ["a mixed-case name", "zsh -c 'HistChars=ab'"],
    ["a name outside a shell string", "echo histchars"],
    ["a name in a nested shell string", `sh -c "zsh -c 'HistChars=ab'"`],
    ["a name in a here-string", "zsh <<< 'histchars=ab'"],
    ["a quote-split name in a builtin argument", "typeset hist'chars'=ab"],
    ["a quote-split name in an env argument", 'env hist"chars"=ab zsh -c ls'],
    ["a quote-split upper-case name", "typeset HIST'CHARS'=ab"],
    ["a name in a here-document", "zsh <<'EOF'\nhistchars=ab\nEOF\n"],
  ])("rejects %s", (_form, line) => {
    expect(parses(line)).toBe(false);
  });
});

describe("long inputs finish with a decision", () => {
  test.each([
    ["opening parentheses", "(".repeat(50000)],
    ["double opening parentheses", "((".repeat(25000)],
    ["nested substitution regions", "$((".repeat(50000)],
    ["nested parameter expansions", `${OPEN}x:-`.repeat(50000)],
    ["nested parameter expansions in a region", `((${OPEN}x:-`.repeat(25000)],
    ["an odd number of backquotes", "`".repeat(50001)],
  ])("rejects %s", (_form, line) => {
    expect(parses(line)).toBe(false);
  });

  test("accepts deeply balanced parentheses", () => {
    const depth = 20000;
    expect(parses(`${"(".repeat(depth)}${")".repeat(depth)}`)).toBe(true);
  });
});

/** `line`のコマンドから、`text`の語の`glob`の印を集める。 */
function globFlagsOf(line: string, text: string): boolean[] {
  const result = parseCommandLine(line);
  if (!result.ok) throw new Error(result.error);
  return result.commands.flatMap((command) =>
    command.words.filter((word) => word.text === text).map((word) => word.glob),
  );
}

describe("a substitution region that a shell may read as a substitution", () => {
  test.each([
    ["two subshells joined by an operator", "echo $((x) | (y))"],
    ["two parenthesized terms", "echo $((a) + (b))"],
    ["a subshell followed by a word", "echo $((x) y)"],
    [
      "a subshell with a command inside",
      "echo $((git push origin main) | (cat))",
    ],
  ])("rejects %s", (_form, line) => {
    expect(parses(line)).toBe(false);
  });

  test.each([
    ["a parenthesized product", "echo $(( (1+2) * 3 ))"],
    [
      "two parenthesized terms inside outer parentheses",
      "echo $(( (a) + (b) ))",
    ],
    ["a plain sum", "echo $((a+b))"],
    ["a nested call-like group", "echo $((n*(n+1)/2))"],
  ])("accepts %s", (_form, line) => {
    expect(parses(line)).toBe(true);
  });

  test("keeps the command-position region unchanged", () => {
    expect(parses("((x) | (y))")).toBe(true);
  });
});

describe("a lone asterisk in a region is a glob", () => {
  test("directly in a substitution region", () => {
    expect(globFlagsOf("echo $(( x * 2 ))", "*")).toEqual([true]);
  });

  test("for a double asterisk in a substitution region", () => {
    expect(globFlagsOf("echo $(( 2 ** 3 ))", "**")).toEqual([true]);
  });

  test("inside a word of a substitution region", () => {
    expect(
      globFlagsOf("echo $((cat scripts/stop_*))", "scripts/stop_*"),
    ).toEqual([true]);
  });

  test("in a command-position region", () => {
    expect(globFlagsOf("((a * b))", "*")).toEqual([true]);
  });
});

describe("accepted false positives stay rejected", () => {
  test.each([
    ["a bracket expansion", "echo $[1+2]"],
    ["a quoted default", `echo ${OPEN}x:-'a b'}`],
    ["a quote inside a quoted expansion", `echo "${OPEN}x:-"$y"}"`],
    ["a shift in a region", "echo $(( 1 << 2 ))"],
    ["a quote in a region", "echo $(( 'a' ))"],
    ["a backslash in a region", "echo $(( a\\b ))"],
    ["a parenthesized offset", `echo ${OPEN}x:(-1)}`],
    ["a leading dash in a region", "echo $(( - x ))"],
    ["a quote in a substitution in a region", 'echo $(( $(date "+%s") - t ))'],
    ["a case operator", `echo ${OPEN}x,,}`],
    ["an indirection", `echo ${OPEN}!x}`],
  ])("rejects %s", (_form, line) => {
    expect(parses(line)).toBe(false);
  });
});

/** 実行時に決まる語。 */
function dynamicWord(text: string): Word {
  return { text, dynamic: true, glob: false };
}

/** 引用符の外にglobの文字を持つ語。 */
function globWord(text: string): Word {
  return { text, dynamic: false, glob: true };
}

/** NULを含んでいた語。`text`のほかに、NULを除いた綴りを持つ。 */
function variantWord(text: string, other: string): Word {
  return { text, dynamic: false, glob: false, variants: [other] };
}

/** `shell`の起動に`args`を渡したときの読み方を、`出どころ@scriptの位置`の短い表記にする。読み切れなければ`unreadable`。 */
function launchOf(
  shell: string,
  args: readonly (string | Word)[],
  hasStdin = false,
): string {
  const launch = readShellLaunch(
    shell,
    args.map((arg) =>
      typeof arg === "string"
        ? { text: arg, dynamic: false, glob: false }
        : arg,
    ),
    hasStdin,
  );
  if (!launch.ok) return "unreadable";
  return `${launch.source}@${launch.scriptIndex ?? "-"}`;
}

// -cの文字列を、すべてのオプションの並びで読む。
describe("a shell launch reads the command string through every option sequence", () => {
  test.each<[string, string, readonly string[], string]>([
    ["a flag", "bash", ["-c", "cmd"], "command@1"],
    ["a plus flag", "bash", ["+c", "cmd"], "command@1"],
    ["a bundle that ends in the flag", "bash", ["-ec", "cmd"], "command@1"],
    ["a login bundle", "bash", ["-lc", "cmd"], "command@1"],
    ["a flag before the flag", "bash", ["-e", "-c", "cmd"], "command@2"],
    ["a plus flag before the flag", "bash", ["+e", "-c", "cmd"], "command@2"],
    [
      "an upper-case value option",
      "bash",
      ["-O", "extglob", "-c", "cmd"],
      "command@3",
    ],
    [
      "a plus upper-case value option",
      "bash",
      ["+O", "extglob", "-c", "cmd"],
      "command@3",
    ],
    [
      "a lower-case value option",
      "bash",
      ["-o", "pipefail", "-c", "cmd"],
      "command@3",
    ],
    [
      "a plus lower-case value option",
      "bash",
      ["+o", "errexit", "-c", "cmd"],
      "command@3",
    ],
    [
      "a bundle that ends in a value option",
      "bash",
      ["-eo", "pipefail", "-c", "cmd"],
      "command@3",
    ],
    [
      "a value with another case and separators",
      "bash",
      ["-o", "Pipe_Fail", "-c", "cmd"],
      "command@3",
    ],
    ["an rcfile value", "bash", ["--rcfile", "x", "-c", "cmd"], "command@3"],
    [
      "an init-file value",
      "bash",
      ["--init-file", "x", "-c", "cmd"],
      "command@3",
    ],
    [
      "an rcfile value that looks like the flag",
      "bash",
      ["--rcfile", "-c", "-c", "cmd"],
      "command@3",
    ],
    [
      "a long flag before the flag",
      "bash",
      ["--norc", "-c", "cmd"],
      "command@2",
    ],
    [
      "two long flags before the flag",
      "bash",
      ["--noprofile", "--norc", "-c", "cmd"],
      "command@3",
    ],
    [
      "a flag between the flag and the string",
      "bash",
      ["-c", "-e", "cmd"],
      "command@2",
    ],
    [
      "a value option between the flag and the string",
      "bash",
      ["-c", "-o", "pipefail", "cmd"],
      "command@3",
    ],
    [
      "a long flag between the flag and the string",
      "bash",
      ["-c", "--norc", "cmd"],
      "command@2",
    ],
    [
      "a double dash before the string",
      "bash",
      ["-c", "--", "cmd"],
      "command@2",
    ],
    ["a lone dash before the string", "bash", ["-c", "-", "cmd"], "command@2"],
    [
      "a string that starts with a dash after a double dash",
      "bash",
      ["-c", "--", "-x"],
      "command@2",
    ],
    ["words after the string", "bash", ["-c", "cmd", "a", "b"], "command@1"],
    ["a posix bundle in sh", "sh", ["-ec", "cmd"], "command@1"],
    ["a flag before the flag in sh", "sh", ["-e", "-c", "cmd"], "command@2"],
    [
      "a flag between the flag and the string in dash",
      "dash",
      ["-c", "-e", "cmd"],
      "command@2",
    ],
    ["a plain flag in dash", "dash", ["-c", "cmd"], "command@1"],
  ])("reads %s (%s)", (_form, shell, args, expected) => {
    expect(launchOf(shell, args)).toBe(expected);
  });
});

// 出どころの優先。
describe("a shell launch decides where the code comes from", () => {
  test.each<[string, readonly (string | Word)[], string]>([
    ["no arguments", [], "stdin@-"],
    ["a lone s flag", ["-s"], "stdin@-"],
    ["a plus s flag", ["+s"], "stdin@-"],
    ["an s flag with words", ["-s", "a", "b"], "stdin@-"],
    ["an s flag and a double dash", ["-s", "--", "--install-dir"], "stdin@-"],
    ["an s flag in a bundle", ["-es", "a"], "stdin@-"],
    ["a script file", ["script.sh", "a"], "file@-"],
    ["a script file after a double dash", ["--", "script.sh"], "file@-"],
    ["a script file after a lone dash", ["-", "script.sh"], "file@-"],
    [
      "a file name that looks like the flag after a double dash",
      ["--", "-c"],
      "file@-",
    ],
    [
      "a file name that looks like the flag after a lone dash",
      ["-", "-c"],
      "file@-",
    ],
    ["a script file after a flag", ["-e", "script.sh"], "file@-"],
    ["a script file after an rcfile", ["--rcfile", "x", "script.sh"], "file@-"],
    ["an rcfile alone", ["--rcfile", "x"], "stdin@-"],
    ["flags alone", ["-e", "-x"], "stdin@-"],
    ["a double dash alone", ["--"], "stdin@-"],
    ["a lone dash alone", ["-"], "stdin@-"],
    ["an s flag after a script file", ["script.sh", "-s"], "file@-"],
    ["a c flag after a script file", ["script.sh", "-c", "cmd"], "file@-"],
    ["a version request", ["--version"], "none@-"],
    ["a help request", ["--help"], "none@-"],
    ["a version request after a flag", ["-e", "--version"], "none@-"],
  ])("reads %s", (_form, args, expected) => {
    expect(launchOf("bash", args)).toBe(expected);
  });
});

// cとsの併用は、dash・ash系が文字列の後に標準入力も読むので、読み切れない起動として扱う。
describe("a shell launch with both the command flag and the stdin flag is unreadable", () => {
  test.each<[string, string, readonly string[]]>([
    ["both in one bundle", "bash", ["-cs", "cmd"]],
    ["both in a reversed bundle", "bash", ["-sc", "cmd"]],
    ["both as separate flags", "bash", ["-c", "-s", "cmd"]],
    ["the stdin flag first", "bash", ["-s", "-c", "cmd"]],
    ["a plus flag and a minus flag", "bash", ["+c", "-s", "cmd"]],
    ["both in sh", "sh", ["-cs", "cmd"]],
    ["both in dash", "dash", ["-sc", "cmd"]],
  ])("rejects %s", (_form, shell, args) => {
    expect(launchOf(shell, args)).toBe("unreadable");
  });
});

// 読めない起動は拒否する。
describe("a shell launch outside the closed set of options is unreadable", () => {
  test.each<[string, readonly (string | Word)[]]>([
    ["a long name outside the list", ["--bogus", "-c", "cmd"]],
    ["a long name with a value attached", ["--rcfile=x", "-c", "cmd"]],
    ["an interactive long name", ["--interactive", "-c", "cmd"]],
    ["a long name written with one dash", ["-help"]],
    ["a long name written with one dash and a flag", ["-norc", "-c", "cmd"]],
    ["a letter outside the list (k)", ["-k", "-c", "cmd"]],
    ["a letter outside the list (D)", ["-D", "-c", "cmd"]],
    ["a letter outside the list (R)", ["-R", "-c", "cmd"]],
    ["the interactive letter", ["-i", "-c", "cmd"]],
    ["a digit", ["-1", "-c", "cmd"]],
    ["a lone plus", ["+", "-c", "cmd"]],
    ["a plus of a long name", ["++x", "-c", "cmd"]],
    [
      "a value option in the middle of a bundle",
      ["-oe", "pipefail", "-c", "cmd"],
    ],
    ["two value options in one bundle", ["-oO", "errexit", "-c", "cmd"]],
    [
      "a value option that takes a value option",
      ["-o", "-o", "pipefail", "-c", "cmd"],
    ],
    ["a value option without a value", ["-o"]],
    ["a value option without a value after the flag", ["-c", "-o"]],
    ["a value outside the list", ["-o", "bogus", "-c", "cmd"]],
    ["the keyword value", ["-o", "keyword", "-c", "cmd"]],
    ["a value that starts with a dash", ["-o", "-c", "cmd"]],
    ["a value that starts with a plus", ["-o", "+e", "-c", "cmd"]],
    [
      "a value with a leading dash that names a listed option",
      ["-o", "-noglob", "-c", "cmd"],
    ],
    [
      "a value with a leading plus that names a listed option",
      ["-o", "+noglob", "-c", "cmd"],
    ],
    ["an rcfile value with a brace", ["--rcfile", "{a,b}", "-c", "cmd"]],
    ["the debugger long option", ["--debugger", "-c", "cmd"]],
    ["an init-file value with a brace", ["--init-file", "{a,b}", "-c", "cmd"]],
    ["the history expansion letter", ["-H", "-c", "cmd"]],
    ["the history expansion letter in a bundle", ["-Hc", "cmd"]],
    ["a dynamic value", ["-o", dynamicWord("$X"), "-c", "cmd"]],
    ["an rcfile option without a value", ["--rcfile"]],
    [
      "an rcfile option with a dynamic value",
      ["--rcfile", dynamicWord("$F"), "-c", "cmd"],
    ],
    ["the flag without a string", ["-c"]],
    ["the flag followed by flags only", ["-c", "-e"]],
    ["a dynamic option word", [dynamicWord("-$X"), "-c", "cmd"]],
    ["a glob option word", [globWord("-*"), "-c", "cmd"]],
    ["a brace option word", ["-{c,e}", "cmd"]],
    [
      "an option word with a variant spelling",
      [variantWord("-e", "-ex"), "-c", "cmd"],
    ],
  ])("rejects %s", (_form, args) => {
    expect(launchOf("bash", args)).toBe("unreadable");
  });

  test.each<[string, string, readonly string[]]>([
    ["a long flag in dash", "dash", ["--login", "-c", "cmd"]],
    ["an upper-case value option in sh", "sh", ["-O", "extglob", "-c", "cmd"]],
    [
      "an upper-case value option in dash",
      "dash",
      ["-O", "extglob", "-c", "cmd"],
    ],
    ["a long flag in dash without the flag", "dash", ["--norc"]],
    ["a letter that only bash reads, in sh", "sh", ["-l", "-c", "cmd"]],
    [
      "a bundle with a letter that only bash reads, in sh",
      "sh",
      ["-lc", "cmd"],
    ],
    ["a letter that only bash reads, in dash", "dash", ["-p", "-c", "cmd"]],
    ["the history expansion letter in sh", "sh", ["-H", "-c", "cmd"]],
    ["the history expansion letter in dash", "dash", ["-Hc", "cmd"]],
    ["a long option with a value in sh", "sh", ["--rcfile", "x", "-c", "cmd"]],
    [
      "a long option with a value in sh before a script",
      "sh",
      ["--init-file", "x", "script.sh"],
    ],
    ["a long option without a value in sh", "sh", ["--norc", "-c", "cmd"]],
    ["a version request in sh", "sh", ["--version"]],
    ["a help request in sh", "sh", ["--help"]],
    [
      "a long option after a version request in sh",
      "sh",
      ["--version", "-c", "cmd"],
    ],
  ])("rejects %s", (_form, shell, args) => {
    expect(launchOf(shell, args)).toBe("unreadable");
  });
});

// 実行時に決まる語と、グロブ・ブレース・NULを含む語。
describe("a shell launch with a word that is decided at run time", () => {
  test.each<[string, readonly (string | Word)[], boolean, string]>([
    ["a lone operand without input", [dynamicWord("$X")], false, "file@-"],
    ["a lone operand with input", [dynamicWord("$X")], true, "stdin@-"],
    [
      "a lone operand after a double dash",
      ["--", dynamicWord("$X")],
      false,
      "file@-",
    ],
    [
      "a lone operand with the stdin flag",
      ["-s", dynamicWord("$X")],
      false,
      "stdin@-",
    ],
    ["a command string", ["-c", dynamicWord("$X")], false, "command@1"],
    [
      "a command string with input",
      ["-c", dynamicWord("$X")],
      true,
      "command@1",
    ],
    ["a command string with a brace", ["-c", "echo {a,b}"], false, "command@1"],
    [
      "a dynamic word after the command string",
      ["-c", "cmd", dynamicWord("$X")],
      false,
      "command@1",
    ],
    [
      "a dynamic word after a script file",
      ["script.sh", dynamicWord("$X")],
      false,
      "file@-",
    ],
  ])("reads %s", (_form, args, hasStdin, expected) => {
    expect(launchOf("bash", args, hasStdin)).toBe(expected);
  });

  test.each<[string, readonly (string | Word)[]]>([
    ["a dynamic operand followed by a word", [dynamicWord("$X"), "a"]],
    [
      "a dynamic operand followed by a word with the stdin flag",
      ["-s", dynamicWord("$X"), "a"],
    ],
    ["a dynamic string followed by a word", ["-c", dynamicWord("$X"), "a"]],
    ["a glob operand", [globWord("*.sh")]],
    ["a glob operand with the stdin flag", ["-s", globWord("*")]],
    ["a glob string", ["-c", globWord("*")]],
    ["an operand with a variant spelling", [variantWord("a", "ab")]],
    ["a string with a variant spelling", ["-c", variantWord("a", "ab")]],
    ["an operand with a brace", ["{-c,echo}"]],
  ])("rejects %s", (_form, args) => {
    expect(launchOf("bash", args)).toBe("unreadable");
  });
});

// bash・sh・dash以外は、狭い3つの形だけ読む。
describe("a shell other than bash, sh, and dash reads only three forms", () => {
  const OTHERS = [
    "zsh",
    "ksh",
    "mksh",
    "ash",
    "fish",
    "csh",
    "tcsh",
    "busybox",
  ];

  test.each(OTHERS)("reads no arguments of %s as stdin", (shell) => {
    expect(launchOf(shell, [])).toBe("stdin@-");
  });

  test.each(OTHERS)("reads the flag and a string of %s", (shell) => {
    expect(launchOf(shell, ["-c", "cmd"])).toBe("command@1");
  });

  test.each(OTHERS)(
    "reads words without an option of %s as a file",
    (shell) => {
      expect(launchOf(shell, ["script", "a", "b"])).toBe("file@-");
    },
  );

  test.each(OTHERS)("rejects a bundle of flags in %s", (shell) => {
    expect(launchOf(shell, ["-lc", "cmd"])).toBe("unreadable");
  });

  test.each<[string, readonly (string | Word)[], boolean, string]>([
    ["a dynamic string", ["-c", dynamicWord("$X")], false, "command@1"],
    [
      "a dynamic lone operand without input",
      [dynamicWord("$X")],
      false,
      "file@-",
    ],
    ["a dynamic lone operand with input", [dynamicWord("$X")], true, "stdin@-"],
  ])("reads %s in zsh", (_form, args, hasStdin, expected) => {
    expect(launchOf("zsh", args, hasStdin)).toBe(expected);
  });

  test.each<[string, readonly (string | Word)[]]>([
    ["bundled flags with a string", ["-fc", "cmd"]],
    ["a double dash", ["--", "x"]],
    ["a string followed by a word", ["-c", "cmd", "a"]],
    ["the flag without a string", ["-c"]],
    ["a plus flag", ["+c", "cmd"]],
    ["the stdin flag", ["-s"]],
    ["a flag before a file", ["-e", "x"]],
    ["a flag after a file", ["x", "-e"]],
    ["a value option", ["-o", "pipefail", "-c", "cmd"]],
    ["a version request", ["--version"]],
    ["a lone dash", ["-"]],
    ["the interactive flag", ["-i"]],
    ["a glob string", ["-c", globWord("*")]],
    ["a dynamic operand followed by a word", [dynamicWord("$X"), "x"]],
    ["a word followed by a dynamic operand", ["x", dynamicWord("$X")]],
  ])("rejects %s in zsh", (_form, args) => {
    expect(launchOf("zsh", args)).toBe("unreadable");
  });
});

/** `line`の最後の単純コマンド。 */
function lastCommand(line: string) {
  const result = parseCommandLine(line);
  if (!result.ok) throw new Error(result.error);
  const command = result.commands.at(-1);
  if (command === undefined) throw new Error("no command");
  return command;
}

// 標準入力の有無は、1つの関数が求める。
describe("readsStandardInput", () => {
  test.each([
    ["a here-string", "bash <<< 'ls'"],
    ["a here-document", "bash <<'EOF'\nls\nEOF\n"],
    ["a pipe", "echo ls | bash"],
    ["a file redirect", "bash < in.sh"],
    ["a read-write redirect", "bash <> in.sh"],
    ["a descriptor redirect", "bash <&3"],
    ["a file redirect with the stdin flag", "bash -s < in.sh"],
  ])("is true for %s", (_form, line) => {
    expect(readsStandardInput(lastCommand(line))).toBe(true);
  });

  test.each([
    ["a script file", "bash script.sh"],
    ["no redirect", "bash"],
    ["an output redirect", "bash > out.log"],
    ["a descriptor copy", "bash script.sh 2>&1"],
    ["a command after a separator", "echo ls; bash"],
  ])("is false for %s", (_form, line) => {
    expect(readsStandardInput(lastCommand(line))).toBe(false);
  });
});

// シェルの起動語は、busyboxの下をbusyboxとして渡す。
describe("shellInvocation", () => {
  test.each([
    ["a bare name", ["bash", "-c", "x"], "bash", 2],
    ["a path", ["/bin/zsh", "x"], "zsh", 1],
    ["busybox with a shell", ["busybox", "sh", "-c", "x"], "busybox", 2],
    ["busybox with a shell named bash", ["busybox", "bash", "x"], "busybox", 1],
  ])("names the shell of %s", (_form, texts, shell, rest) => {
    const found = shellInvocation(words(...texts));

    expect([found?.shell, found?.args.length]).toEqual([shell, rest]);
  });

  test.each([
    ["a program that is not a shell", ["git", "status"]],
    ["a busybox applet", ["busybox", "ls"]],
    ["no words", []],
  ])("returns nothing for %s", (_form, texts) => {
    expect(shellInvocation(words(...texts))).toBeNull();
  });
});

// 入れ子の文字列は、起動オプションを読んだ位置の語から取り出す。
describe("a shell launch hands the command string to the parser", () => {
  test.each([
    ["a plus flag", "bash +c 'echo marker'"],
    ["a plus flag after a flag", "bash +e -c 'echo marker'"],
    ["an upper-case value option", "bash -O extglob -c 'echo marker'"],
    ["a plus upper-case value option", "bash +O extglob -c 'echo marker'"],
    ["a lower-case value option", "bash -o pipefail -c 'echo marker'"],
    [
      "a bundle that ends in a value option",
      "bash -eo pipefail -c 'echo marker'",
    ],
    ["an rcfile value", "bash --rcfile x -c 'echo marker'"],
    ["an init-file value", "bash --init-file x -c 'echo marker'"],
    ["a flag between the flag and the string", "bash -c -e 'echo marker'"],
    [
      "a long flag between the flag and the string",
      "bash -c --norc 'echo marker'",
    ],
    ["a double dash before the string", "bash -c -- 'echo marker'"],
    ["a lone dash before the string", "bash -c - 'echo marker'"],
    ["a login bundle", "bash -lc 'echo marker'"],
    ["a posix bundle in sh", "sh -ec 'echo marker'"],
    ["a launch behind env", "env bash -c -e 'echo marker'"],
    ["a launch through busybox", "busybox sh -c 'echo marker'"],
    ["a shell string in a shell string", `sh -c "bash +c 'echo marker'"`],
  ])("reads the string of %s", (_form, line) => {
    expect(commandTexts(line)).toContainEqual(["echo", "marker"]);
  });
});

// 読めない起動は構文エラーとして拒否する。
describe("a shell launch that cannot be read is a syntax error", () => {
  test.each([
    ["a long name outside the list", "bash --bogus -c ls"],
    ["a long name written with one dash", "bash -help -c ls"],
    ["a letter outside the list", "bash -k -c ls"],
    ["a debugger letter", "bash -D -c ls"],
    ["a restricted letter", "bash -R -c ls"],
    ["a value option in the middle of a bundle", "bash -oe pipefail -c ls"],
    ["two value options in one bundle", "bash -oO errexit -c ls"],
    ["a value outside the list", "bash -o bogus -c ls"],
    ["the keyword value", "bash -o keyword -c ls"],
    ["a value option without a value", "bash -o"],
    ["a value that starts with a dash", "bash -o -c ls"],
    ["the flag without a string", "bash -c"],
    ["a lone plus", "bash + -c ls"],
    ["a digit", "bash -1 -c ls"],
    ["a dynamic option word", 'bash -"$X" -c ls'],
    ["a dynamic option value", 'bash -o "$X" -c ls'],
    ["a glob option word", "bash -* -c ls"],
    ["a brace option word", "bash -{c,e} ls"],
    ["an rcfile value with a brace", "bash --rcfile {a,b} -c ls"],
    ["an init-file value with a brace", "bash --init-file {a,b} -c ls"],
    [
      "a value with a leading dash that names a listed option",
      "bash -o -noglob -c ls",
    ],
    ["the history expansion letter", "bash -H -c ls"],
    ["the debugger long option", "bash --debugger -c ls"],
    ["a long option with a value in sh", "sh --rcfile x -c ls"],
    ["a long option without a value in sh", "sh --norc -c ls"],
    ["a version request in sh", "sh --version"],
    ["an rcfile option without a value", "bash --rcfile"],
    ["a long flag in dash", "dash --login -c ls"],
    ["both the command flag and the stdin flag", "bash -cs ls"],
    ["both flags as separate words", "bash -c -s ls"],
    ["both flags in sh", "sh -sc ls"],
    ["a dynamic operand followed by a word", 'bash "$X" arg'],
    ["a dynamic string followed by a word", 'bash -c "$X" arg'],
    ["a glob operand", "bash *.sh"],
    ["a glob string", "bash -c *"],
    ["a string with a variant spelling", "bash -c $'a\\x00b'"],
    ["a brace operand", "bash {-c,ls}"],
    ["bundled flags with a string in zsh", "zsh -fc ls"],
    ["a login bundle in zsh", "zsh -lc ls"],
    ["a double dash in zsh", "zsh -- script"],
    ["words after the string in zsh", "zsh -c ls arg"],
    ["words after the string in ksh", "ksh -c ls arg"],
    ["words after the string in fish", "fish -c ls arg"],
    ["a flag after a file in zsh", "zsh script -x"],
    ["a login bundle through busybox", "busybox sh -lc ls"],
    ["a login bundle through busybox with a bash name", "busybox bash -lc ls"],
    ["a launch in a shell string", "sh -c 'bash --bogus -c ls'"],
    ["a launch in a substitution", "echo $(bash --bogus -c ls)"],
  ])("rejects %s", (_form, line) => {
    expect(parses(line)).toBe(false);
  });

  test.each([
    ["a letter outside the list", "bash -k -c ls"],
    ["an unknown long name", "bash --bogus -c ls"],
  ])("explains the reason for %s", (_form, line) => {
    const result = parseCommandLine(line);

    expect(!result.ok && result.error).toContain("shell launch options");
  });

  test("keeps the reason of the interactive check ahead of the option check", () => {
    const result = parseCommandLine("bash --interactive -c ls");

    expect(!result.ok && result.error).toContain("interactive shell");
  });
});

// 日常の読み取りは拒否しない。
describe("a shell launch of the daily forms is read", () => {
  test.each([
    ["a script with an argument", "bash script.sh arg"],
    ["a script under a variable", 'sh "$HOME/x.sh"'],
    ["an installer with a long option", "bash -s -- --install-dir"],
    ["a command string", "bash -c 'echo hi'"],
    ["a command string after a long flag", "bash --norc -c 'cmd'"],
    ["a login command string", "bash -lc 'cmd'"],
    ["a version request", "bash --version"],
    ["a command string in zsh", "zsh -c 'cmd'"],
    ["a script in zsh", "zsh script.zsh"],
    ["a script with arguments in zsh", "zsh script.zsh a b"],
    [
      "a download piped into the shell",
      "curl -fsSL https://example.com/x.sh | bash",
    ],
    ["a command string from a variable", 'bash -c "$CMD"'],
    ["a command string in sh with a posix bundle", "sh -ec 'cmd'"],
  ])("accepts %s", (_form, line) => {
    expect(parses(line)).toBe(true);
  });
});

// 受け入れる誤検知を固定する。
describe("accepted false positives of the shell launch stay rejected", () => {
  test.each([
    ["a dynamic operand followed by words", 'bash "$SCRIPT" a b'],
    ["a name outside the list", "bash --no-such-option script.sh"],
    ["a bundled flag outside bash and sh", "zsh -fc ls"],
    ["both the command flag and the stdin flag", "bash -c -s ls"],
    [
      "a flag that contains the interactive name",
      "bash --non-interactive -c ls",
    ],
  ])("rejects %s", (_form, line) => {
    expect(parses(line)).toBe(false);
  });
});

// 長い引数の並びは、引数の数に比例する作業で終わる。実時間は測らない。
describe("a shell launch with a long argument list finishes", () => {
  const COUNT = 100000;

  test("reads many flags before the string", () => {
    const args = [...Array.from({ length: COUNT }, () => "-e"), "-c", "cmd"];

    expect(launchOf("bash", args)).toBe(`command@${COUNT + 1}`);
  });

  test("reads many words after the string", () => {
    const args = ["-c", "cmd", ...Array.from({ length: COUNT }, () => "a")];

    expect(launchOf("bash", args)).toBe("command@1");
  });

  test("reads many words of a script file", () => {
    const args = ["script.sh", ...Array.from({ length: COUNT }, () => "-e")];

    expect(launchOf("bash", args)).toBe("file@-");
  });

  test("rejects a long line of repeated invalid flags", () => {
    expect(parses(`bash ${"-k ".repeat(COUNT)}-c ls`)).toBe(false);
  });
});
