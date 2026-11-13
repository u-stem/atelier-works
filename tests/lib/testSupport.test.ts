import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nextTask, restoreTimers, stubLongTimers } from "./testSupport.ts";

const ROOT = join(import.meta.dir, "../..");
const originalSetTimeout = globalThis.setTimeout;

/**
 * `setTimeout`を、渡された待ちの長さを記録し、待たずに発火させる関数に差し替える。
 * `stubLongTimers`が元として掴む関数をこれにして、しきい値を実際に待たずに確かめる。
 */
function recordDelays(): { readonly delays: (number | undefined)[] } {
  const delays: (number | undefined)[] = [];
  const recorder = (handler: TimerHandler, ms?: number, ...args: unknown[]) => {
    delays.push(ms);
    return originalSetTimeout(handler, 0, ...args);
  };
  Reflect.set(globalThis, "setTimeout", recorder);
  return { delays };
}

afterEach(() => {
  restoreTimers();
  Reflect.set(globalThis, "setTimeout", originalSetTimeout);
});

describe("stubLongTimers", () => {
  test("keeps a delay below the threshold", () => {
    const { delays } = recordDelays();
    stubLongTimers();
    setTimeout(() => {}, 999);
    expect(delays).toEqual([999]);
  });

  test("fires a delay at the threshold at once", () => {
    const { delays } = recordDelays();
    stubLongTimers();
    setTimeout(() => {}, 1_000);
    expect(delays).toEqual([0]);
  });

  test("fires a delay above the threshold at once", () => {
    const { delays } = recordDelays();
    stubLongTimers();
    setTimeout(() => {}, 60_000);
    expect(delays).toEqual([0]);
  });

  test("uses the threshold it is given", () => {
    const { delays } = recordDelays();
    stubLongTimers(50);
    setTimeout(() => {}, 50);
    expect(delays).toEqual([0]);
  });

  test("keeps a timer that has no delay", () => {
    const { delays } = recordDelays();
    stubLongTimers();
    setTimeout(() => {});
    expect(delays).toEqual([undefined]);
  });

  test("resolves a one minute wait without waiting", async () => {
    stubLongTimers();
    const value = await new Promise<string>((resolve) => {
      setTimeout(resolve, 60_000, "done");
    });
    expect(value).toBe("done");
  });

  test("passes the extra arguments to the handler", async () => {
    stubLongTimers();
    const received = await new Promise<unknown[]>((resolve) => {
      setTimeout((...args: unknown[]) => resolve(args), 5_000, "a", 2);
    });
    expect(received).toEqual(["a", 2]);
  });

  test("passes the extra arguments of a delay below the threshold", async () => {
    stubLongTimers();
    const received = await new Promise<unknown[]>((resolve) => {
      setTimeout((...args: unknown[]) => resolve(args), 1, "b", 3);
    });
    expect(received).toEqual(["b", 3]);
  });

  test("replaces the global setTimeout until it is restored", () => {
    const { delays } = recordDelays();
    const recorder = globalThis.setTimeout;
    stubLongTimers();
    setTimeout(() => {}, 1_000);
    expect([globalThis.setTimeout === recorder, delays]).toEqual([false, [0]]);
  });
});

describe("restoreTimers", () => {
  test("puts back the setTimeout that was replaced", () => {
    recordDelays();
    const recorder = globalThis.setTimeout;
    stubLongTimers();
    restoreTimers();
    expect(globalThis.setTimeout).toBe(recorder);
  });

  test("stops shortening long delays", () => {
    const { delays } = recordDelays();
    stubLongTimers();
    restoreTimers();
    setTimeout(() => {}, 1_000);
    expect(delays).toEqual([1_000]);
  });

  test("puts back the original after more than one replacement", () => {
    recordDelays();
    const recorder = globalThis.setTimeout;
    stubLongTimers();
    stubLongTimers(10);
    restoreTimers();
    expect(globalThis.setTimeout).toBe(recorder);
  });

  test("does nothing when nothing was replaced", () => {
    const before = globalThis.setTimeout;
    restoreTimers();
    expect(globalThis.setTimeout).toBe(before);
  });
});

describe("nextTask", () => {
  test("runs the pending microtasks before it resolves", async () => {
    const order: string[] = [];
    void Promise.resolve()
      .then(() => {
        order.push("first");
      })
      .then(() => {
        order.push("second");
      });
    await nextTask();
    expect(order).toEqual(["first", "second"]);
  });

  test("does not use setTimeout", async () => {
    const { delays } = recordDelays();
    await nextTask();
    expect(delays).toEqual([]);
  });
});

/**
 * コメントと文字列の中身を空白に置き換える。改行の位置は変えない。
 * 文字列は、`'`、`"`、`` ` `` で囲まれたものを読む。
 * 限りがある。正規表現リテラルの中の引用符は、文字列の始まりと読み違えうる。
 * テンプレートリテラルの`${}`の中のコードも、文字列の一部として空白にする。
 */
function maskNonCode(text: string): string {
  const out: string[] = [];
  let quote = "";
  let comment: "" | "line" | "block" = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    const next = text.charAt(i + 1);
    const blank = ch === "\n" ? "\n" : " ";
    if (comment === "line") {
      out.push(blank);
      if (ch === "\n") comment = "";
    } else if (comment === "block") {
      out.push(blank);
      if (ch === "*" && next === "/") {
        out.push(" ");
        i += 1;
        comment = "";
      }
    } else if (quote !== "") {
      out.push(blank);
      if (ch === "\\") {
        out.push(next === "\n" ? "\n" : " ");
        i += 1;
      } else if (ch === quote) {
        quote = "";
      }
    } else if (ch === "/" && next === "/") {
      comment = "line";
      out.push(" ");
    } else if (ch === "/" && next === "*") {
      comment = "block";
      out.push(" ");
    } else if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out.push(" ");
    } else {
      out.push(ch);
    }
  }
  return out.join("");
}

/** `open`の位置の`(`に対応する`)`の手前までの文字列を返す。対応が無ければ末尾までを返す。 */
function argumentAt(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const ch = code.charAt(i);
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return code.slice(open + 1);
}

/** ファイルの最上位(波括弧の外)に置かれた`afterEach`の引数を、出てきた順に返す。 */
function topLevelAfterEachArguments(code: string): string[] {
  const found: string[] = [];
  let depth = 0;
  for (let i = 0; i < code.length; i += 1) {
    const ch = code.charAt(i);
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (depth === 0 && code.startsWith("afterEach(", i)) {
      found.push(argumentAt(code, i + "afterEach".length));
    }
  }
  return found;
}

/** `stubLongTimers`の呼び出しがある。定義(`function stubLongTimers(`)は数えない。 */
function callsStubLongTimers(code: string): boolean {
  return /(?<!function\s)\bstubLongTimers\(/.test(code);
}

/**
 * `stubLongTimers`を呼ぶのに、最上位の`afterEach`で`restoreTimers`を呼ばないファイルのパスを返す。
 * 戻し忘れた差し替えは、同じワーカーの後続のテストに残るためである。
 * コメントと文字列の中は見ない。
 * `afterEach`は、ファイルの最上位に置く規則とする。入れ子の`describe`の中だけにある`afterEach`は、戻したものと数えない。
 * 最上位の`afterEach`の引数が`restoreTimers`そのものか、その中で`restoreTimers(`を呼べば、戻したと数える。
 * 見落とす範囲がある。`afterEach`の中の条件分岐の先でだけ呼ぶ場合と、引数に別の関数を渡して中で呼ぶ場合は、戻したと数える。
 * 誤って検出する範囲がある。入れ子の`describe`だけに`afterEach`を置いた場合は、その中の差し替えでも検出する。
 */
function filesWithoutRestore(sources: Readonly<Record<string, string>>) {
  return Object.entries(sources)
    .map(([path, text]) => [path, maskNonCode(text)] as const)
    .filter(([, code]) => callsStubLongTimers(code))
    .filter(
      ([, code]) =>
        !topLevelAfterEachArguments(code).some(
          (arg) =>
            /^\s*restoreTimers\s*$/.test(arg) ||
            /\brestoreTimers\s*\(/.test(arg),
        ),
    )
    .map(([path]) => path);
}

describe("the files that call stubLongTimers", () => {
  test("flags a file that never restores the timers", () => {
    const sources = { "a.test.ts": "stubLongTimers();\n" };
    expect(filesWithoutRestore(sources)).toEqual(["a.test.ts"]);
  });

  test("flags a file that restores outside afterEach", () => {
    const sources = { "a.test.ts": "stubLongTimers();\nrestoreTimers();\n" };
    expect(filesWithoutRestore(sources)).toEqual(["a.test.ts"]);
  });

  test("accepts afterEach with restoreTimers itself", () => {
    const sources = {
      "a.test.ts": "afterEach(restoreTimers);\nstubLongTimers();\n",
    };
    expect(filesWithoutRestore(sources)).toEqual([]);
  });

  test("accepts afterEach with a block that calls restoreTimers", () => {
    const sources = {
      "a.test.ts":
        "afterEach(() => {\n  restoreGlobalFetch();\n  restoreTimers();\n});\nstubLongTimers();\n",
    };
    expect(filesWithoutRestore(sources)).toEqual([]);
  });

  test("accepts a block that closes another brace before restoreTimers", () => {
    const sources = {
      "a.test.ts":
        "afterEach(() => {\n  if (a) {\n    b();\n  }\n  restoreTimers();\n});\nstubLongTimers();\n",
    };
    expect(filesWithoutRestore(sources)).toEqual([]);
  });

  test("flags a file whose only afterEach is in a comment", () => {
    const sources = {
      "a.test.ts":
        "// afterEach(restoreTimers);\n/* afterEach(() => { restoreTimers(); }); */\nstubLongTimers();\n",
    };
    expect(filesWithoutRestore(sources)).toEqual(["a.test.ts"]);
  });

  test("flags a file whose only afterEach is in a string", () => {
    const sources = {
      "a.test.ts": 'const s = "afterEach(restoreTimers)";\nstubLongTimers();\n',
    };
    expect(filesWithoutRestore(sources)).toEqual(["a.test.ts"]);
  });

  test("ignores a call that is only in a comment", () => {
    const sources = { "a.test.ts": "// stubLongTimers();\n" };
    expect(filesWithoutRestore(sources)).toEqual([]);
  });

  test("flags a file whose only afterEach is in a nested describe", () => {
    const sources = {
      "a.test.ts":
        'describe("a", () => {\n  afterEach(restoreTimers);\n});\ndescribe("b", () => {\n  stubLongTimers();\n});\n',
    };
    expect(filesWithoutRestore(sources)).toEqual(["a.test.ts"]);
  });

  test("flags a helper file that calls it without an afterEach", () => {
    const sources = {
      "helper.ts": "export function f() {\n  stubLongTimers();\n}\n",
    };
    expect(filesWithoutRestore(sources)).toEqual(["helper.ts"]);
  });

  test("does not count the definition as a call", () => {
    const sources = {
      "testSupport.ts": "export function stubLongTimers(ms = 1) {}\n",
    };
    expect(filesWithoutRestore(sources)).toEqual([]);
  });

  test("ignores a file that does not call stubLongTimers", () => {
    expect(filesWithoutRestore({ "a.test.ts": "const a = 1;\n" })).toEqual([]);
  });
});

describe("the files under tests that call stubLongTimers", () => {
  const sources = Object.fromEntries(
    Array.from(new Bun.Glob("tests/**/*.ts").scanSync({ cwd: ROOT })).map(
      (path) => [path, readFileSync(join(ROOT, path), "utf8")],
    ),
  );

  test("include at least one file", () => {
    const callers = Object.entries(sources).filter(([, text]) =>
      callsStubLongTimers(maskNonCode(text)),
    );
    expect(callers.length).toBeGreaterThan(0);
  });

  test("restore the timers in every one of them", () => {
    expect(filesWithoutRestore(sources)).toEqual([]);
  });
});
