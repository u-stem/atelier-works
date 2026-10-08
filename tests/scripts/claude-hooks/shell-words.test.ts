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
});
