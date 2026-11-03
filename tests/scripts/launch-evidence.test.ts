// 証拠の照合(scripts/launch-evidence.ts)の単体テスト。
// 偽のreadSourceで、欠けの一覧、本文を返さないこと、パスの拒否、コメントの除外、一致の数を確かめる。

import { describe, expect, test } from "bun:test";
import {
  type Evidence,
  findMissingEvidence,
  stripComments,
} from "../../scripts/launch-evidence.ts";

type Edge = { readonly evidence: readonly Evidence[] };

/** ファイル名から本文を引く偽のreadSource。呼ばれたファイルを記録する。 */
function fakeReader(files: Readonly<Record<string, string>>) {
  const calls: string[] = [];
  const read = (file: string): string | undefined => {
    calls.push(file);
    return Object.hasOwn(files, file) ? files[file] : undefined;
  };
  return { read, calls };
}

function edgeOf(...evidence: Evidence[]): Edge {
  return { evidence };
}

describe("stripComments", () => {
  test("keeps code that follows a URL in a string", () => {
    expect(stripComments('const u = "https://x"; // note')).toContain(
      "https://x",
    );
  });

  test("keeps the slashes of a regular expression literal", () => {
    expect(stripComments("const re = /a\\/\\/b/;")).toContain("a\\/\\/b");
  });

  test("drops the words of a block comment", () => {
    expect(stripComments("/* needle */ const a = 1;")).not.toContain("needle");
  });

  test("drops a line comment after code", () => {
    expect(stripComments("const a = 1; // needle")).not.toContain("needle");
  });

  test("drops a line of a block comment that has no leading asterisk", () => {
    const source = ["/*", "needle", "*/", "const a = 1;"].join("\n");

    expect(stripComments(source)).not.toContain("needle");
  });

  test("drops a whole-line comment", () => {
    expect(stripComments("// needle\nconst a = 1;")).not.toContain("needle");
  });

  test("keeps the code of a line that has a comment after it", () => {
    expect(stripComments("const needle = 1; // note")).toContain(
      "const needle",
    );
  });
});

describe("findMissingEvidence", () => {
  test("returns nothing when every piece of evidence is in the code", () => {
    const { read } = fakeReader({ "lib/a.ts": "const x = needle();\n" });

    expect(
      findMissingEvidence(
        [edgeOf({ file: "lib/a.ts", includes: "needle()" })],
        read,
      ),
    ).toEqual([]);
  });

  test("lists what is missing as file and text", () => {
    const { read } = fakeReader({ "lib/a.ts": "const x = 1;\n" });

    expect(
      findMissingEvidence(
        [edgeOf({ file: "lib/a.ts", includes: "needle()" })],
        read,
      ),
    ).toEqual(["lib/a.ts: needle()"]);
  });

  test("never returns the body of a file", () => {
    const { read } = fakeReader({
      "lib/a.ts": "const secret = 'body-text';\n",
    });

    const missing = findMissingEvidence(
      [edgeOf({ file: "lib/a.ts", includes: "needle()" })],
      read,
    );

    expect(missing.join("\n")).not.toContain("body-text");
  });

  test.each([
    "../x.ts",
    "lib/../x.ts",
    "/etc/hosts",
    "/tmp/x.ts",
    "lib/a.js",
    "lib/A.ts",
    "lib/a.ts\n",
    "",
  ])("rejects the path %j and lists it as missing", (file) => {
    const { read } = fakeReader({ [file]: "needle()" });

    expect(
      findMissingEvidence([edgeOf({ file, includes: "needle()" })], read),
    ).toEqual([`${file}: needle()`]);
  });

  test.each(["../x.ts", "lib/../x.ts", "/etc/hosts", "/tmp/x.ts", "lib/a.js"])(
    "never passes the rejected path %j to readSource",
    (file) => {
      const { read, calls } = fakeReader({ [file]: "needle()" });

      findMissingEvidence([edgeOf({ file, includes: "needle()" })], read);

      expect(calls).toEqual([]);
    },
  );

  test("lists a file that does not exist as missing", () => {
    const { read } = fakeReader({});

    expect(
      findMissingEvidence(
        [edgeOf({ file: "lib/none.ts", includes: "needle()" })],
        read,
      ),
    ).toEqual(["lib/none.ts: needle()"]);
  });

  test("ignores a match in a comment", () => {
    const { read } = fakeReader({
      "lib/a.ts": "// needle()\n/* needle() */\n",
    });

    expect(
      findMissingEvidence(
        [edgeOf({ file: "lib/a.ts", includes: "needle()" })],
        read,
      ),
    ).toEqual(["lib/a.ts: needle()"]);
  });

  test("ignores a match after a line comment", () => {
    const { read } = fakeReader({ "lib/a.ts": "const a = 1; // needle()\n" });

    expect(
      findMissingEvidence(
        [edgeOf({ file: "lib/a.ts", includes: "needle()" })],
        read,
      ),
    ).toEqual(["lib/a.ts: needle()"]);
  });

  test("ignores a match in a block comment line without an asterisk", () => {
    const { read } = fakeReader({ "lib/a.ts": "/*\nneedle()\n*/\n" });

    expect(
      findMissingEvidence(
        [edgeOf({ file: "lib/a.ts", includes: "needle()" })],
        read,
      ),
    ).toEqual(["lib/a.ts: needle()"]);
  });

  test("lists a string that matches in two places of the code", () => {
    const { read } = fakeReader({ "lib/a.ts": "needle();\nneedle();\n" });

    expect(
      findMissingEvidence(
        [edgeOf({ file: "lib/a.ts", includes: "needle()" })],
        read,
      ),
    ).toEqual(["lib/a.ts: needle()"]);
  });

  test("counts only the code when a comment repeats the string", () => {
    const { read } = fakeReader({ "lib/a.ts": "needle(); // needle()\n" });

    expect(
      findMissingEvidence(
        [edgeOf({ file: "lib/a.ts", includes: "needle()" })],
        read,
      ),
    ).toEqual([]);
  });

  test("matches a fixed string and never a regular expression", () => {
    const { read } = fakeReader({ "lib/a.ts": "const x = abc;\n" });

    expect(
      findMissingEvidence(
        [edgeOf({ file: "lib/a.ts", includes: "a.c" })],
        read,
      ),
    ).toEqual(["lib/a.ts: a.c"]);
  });

  test("lists each missing piece of every edge in order", () => {
    const { read } = fakeReader({ "lib/a.ts": "const x = 1;\n" });

    expect(
      findMissingEvidence(
        [
          edgeOf({ file: "lib/a.ts", includes: "one" }),
          edgeOf(
            { file: "lib/a.ts", includes: "const x" },
            { file: "lib/a.ts", includes: "two" },
          ),
        ],
        read,
      ),
    ).toEqual(["lib/a.ts: one", "lib/a.ts: two"]);
  });
});
