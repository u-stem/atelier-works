import { describe, expect, test } from "bun:test";
import {
  type ShellInputSource,
  shellInputSource,
} from "../../../scripts/claude-hooks/env-exposure.ts";
import type { Word } from "../../../scripts/claude-hooks/shell-words.ts";

function words(...texts: string[]): Word[] {
  return texts.map((text) => ({ text, dynamic: false, glob: false }));
}

describe("shellInputSource", () => {
  test.each<[string, string, string[], boolean, ShellInputSource]>([
    ["a command string", "bash", ["-c", "cmd"], false, "command"],
    ["a script file", "bash", ["script.sh"], false, "file"],
    ["no arguments", "bash", [], false, "stdin"],
    ["the stdin flag", "bash", ["-s", "--", "--flag"], false, "stdin"],
    ["a version request", "bash", ["--version"], false, "none"],
    ["a command string in zsh", "zsh", ["-c", "cmd"], false, "command"],
  ])("returns the source of %s", (_form, shell, args, hasStdin, expected) => {
    expect(shellInputSource(shell, words(...args), hasStdin)).toBe(expected);
  });

  test.each([
    ["a long name outside the list", "bash", ["--bogus", "-c", "cmd"]],
    ["a letter outside the list", "bash", ["-k", "-c", "cmd"]],
    ["the command flag and the stdin flag", "bash", ["-cs", "cmd"]],
    ["the command flag without a string", "bash", ["-c"]],
    ["a bundle in zsh", "zsh", ["-lc", "cmd"]],
    ["a version request in sh", "sh", ["--version"]],
    ["a long option with a value in sh", "sh", ["--rcfile", "x", "script.sh"]],
    ["the debugger long option", "bash", ["--debugger", "-c", "cmd"]],
  ])("returns unreadable for %s", (_form, shell, args) => {
    expect(shellInputSource(shell, words(...args), false)).toBe("unreadable");
  });

  test("reads a lone dynamic operand as stdin only when input is given", () => {
    const operand: Word[] = [{ text: "$X", dynamic: true, glob: false }];

    expect([
      shellInputSource("bash", operand, false),
      shellInputSource("bash", operand, true),
    ]).toEqual(["file", "stdin"]);
  });
});
