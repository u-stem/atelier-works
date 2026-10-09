import { describe, expect, test } from "bun:test";
import {
  parseCommandLine,
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
