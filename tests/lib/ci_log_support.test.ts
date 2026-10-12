import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import {
  buildCiExcerpt,
  CI_LOG_JOB_MAX_CHARS,
  CI_LOG_MAX_JOBS,
  CI_LOG_TOTAL_MAX_CHARS,
  type CiTextScanner,
  cleanLogText,
  condenseJobLog,
  guardCiRoundText,
  VolatileCiExcerpt,
  VolatileCiLog,
  VolatileCiPrompt,
} from "../../f/factory/lib/ci_log_support.ts";

const cleanScanner: CiTextScanner = async () => ({ ok: true, output: "" });

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

describe("cleanLogText", () => {
  test("strips ANSI color sequences", () => {
    expect(cleanLogText(`${ESC}[31mred${ESC}[0m`)).toBe("red");
  });

  test("strips ANSI cursor sequences with parameters", () => {
    expect(cleanLogText(`a${ESC}[2K${ESC}[1Gb`)).toBe("ab");
  });

  test("strips OSC hyperlink sequences and keeps the visible text", () => {
    const text = `${ESC}]8;;http://evil.example${BEL}link${ESC}]8;;${BEL}`;
    expect(cleanLogText(text)).toBe("link");
  });

  test("strips the timestamp prefix of a log line", () => {
    expect(cleanLogText("2026-10-13T01:02:03.1234567Z hello")).toBe("hello");
  });

  test("strips the timestamp after a byte order mark", () => {
    expect(cleanLogText("\uFEFF2026-10-13T01:02:03.1234567Z hello")).toBe(
      "hello",
    );
  });

  test("strips the timestamp of every line", () => {
    const text = "2026-10-13T01:02:03.1Z one\n2026-10-13T01:02:04.2Z two";
    expect(cleanLogText(text)).toBe("one\ntwo");
  });

  test("keeps a timestamp-like text in the middle of a line", () => {
    expect(cleanLogText("at 2026-10-13T01:02:03Z ok")).toBe(
      "at 2026-10-13T01:02:03Z ok",
    );
  });

  test("removes C0 control characters", () => {
    expect(cleanLogText("a\u0000b\u0007c\u001fd")).toBe("abcd");
  });

  test("removes C1 control characters", () => {
    expect(cleanLogText("a\u0080b\u0090c\u009fd")).toBe("abcd");
  });

  test("strips an 8-bit CSI sequence", () => {
    expect(cleanLogText("a\u009b31mb")).toBe("ab");
  });

  test("removes DEL", () => {
    expect(cleanLogText("a\u007fb")).toBe("ab");
  });

  test("keeps newlines", () => {
    expect(cleanLogText("a\nb")).toBe("a\nb");
  });

  test("turns CRLF into a newline", () => {
    expect(cleanLogText("a\r\nb")).toBe("a\nb");
  });

  test("turns a lone carriage return into a newline", () => {
    expect(cleanLogText("a\rb")).toBe("a\nb");
  });

  test("turns a tab into a space", () => {
    expect(cleanLogText("a\tb")).toBe("a b");
  });

  test("turns the Unicode line separators into a newline", () => {
    expect(cleanLogText("a\u2028b\u2029c\u0085d")).toBe("a\nb\nc\nd");
  });

  test("removes bidirectional control characters", () => {
    expect(cleanLogText("a\u202Eb\u2066c\u2069d\u200Fe\u061Cf")).toBe("abcdef");
  });

  test("removes zero-width and invisible characters", () => {
    expect(cleanLogText("a\u200Bb\u200Dc\u2060d\u00ADe\uFEFFf")).toBe("abcdef");
  });

  test("removes Unicode tag characters", () => {
    expect(cleanLogText("a\u{E0041}\u{E0042}b")).toBe("ab");
  });

  test("removes variation selectors", () => {
    expect(cleanLogText("a\uFE0Fb\u{E0100}c")).toBe("abc");
  });

  test("removes Khmer inherent vowels, which render as nothing", () => {
    expect(cleanLogText("a\u17B4b\u17B5c")).toBe("abc");
  });

  test("removes Mongolian free variation selectors", () => {
    expect(cleanLogText("a\u180Bb\u180Cc\u180Dd\u180Fe")).toBe("abcde");
  });

  test("removes blank-looking filler characters", () => {
    expect(cleanLogText("a\u3164b\u2800c")).toBe("abc");
  });

  test("turns a no-break space into a plain space", () => {
    expect(cleanLogText("a\u00A0b")).toBe("a b");
  });

  test("removes lone surrogates", () => {
    expect(cleanLogText("a\ud800b")).toBe("ab");
  });

  test("keeps Japanese text", () => {
    expect(cleanLogText("エラー: 失敗しました")).toBe("エラー: 失敗しました");
  });
});

describe("cleanLogText worst-case input", () => {
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  // 時間の上限は緩くする。線形なら数十ミリ秒、2乗なら数分かかる入力である。
  const LIMIT_MS = 5000;
  const elapsedMs = (raw: string): number => {
    const started = Date.now();
    cleanLogText(raw);
    return Date.now() - started;
  };

  test.each([
    ["DCS starts without a terminator", `${ESC}P`],
    ["OSC starts without a terminator", `${ESC}]`],
    ["CSI starts without a final byte", `${ESC}[`],
    ["APC starts without a terminator", `${ESC}_`],
    ["DCS starts with a BEL", `${ESC}P${BEL}`],
    ["a lone ESC", ESC],
  ])("finishes quickly when %s repeats on one line", (_label, unit) => {
    expect(elapsedMs(unit.repeat(500_000))).toBeLessThan(LIMIT_MS);
  });

  test("finishes quickly for a DCS start followed by many ESC characters", () => {
    expect(elapsedMs(`${ESC}P${ESC}x`.repeat(300_000))).toBeLessThan(LIMIT_MS);
  });

  test("finishes quickly for many short lines of unterminated sequences", () => {
    expect(elapsedMs(`${ESC}P abc\n`.repeat(300_000))).toBeLessThan(LIMIT_MS);
  });

  test("finishes quickly for many lines just under the line limit", () => {
    expect(elapsedMs(`${"x".repeat(1999)}\n`.repeat(2000))).toBeLessThan(
      LIMIT_MS,
    );
  });

  test("keeps the text of an OSC sequence that ends with BEL out of the result", () => {
    expect(cleanLogText(`${ESC}]0;window title${BEL}after`)).toBe("after");
  });

  test("keeps the text of an OSC hyperlink that ends with ST", () => {
    const text = `${ESC}]8;;http://evil.example${ESC}\\click${ESC}]8;;${ESC}\\ end`;
    expect(cleanLogText(text)).toBe("click end");
  });

  test("an unterminated OSC stops at the end of its line", () => {
    expect(cleanLogText(`${ESC}]0;title without end\nnext line`)).toBe(
      "\nnext line",
    );
  });

  test("a CSI sequence with parameters leaves the text after the final byte", () => {
    expect(cleanLogText(`${ESC}[1;31mred${ESC}[0m`)).toBe("red");
  });

  test("keeps a message after many carriage-return progress updates", () => {
    const text = `${"progress 0%\r".repeat(5000)}\rERROR: build failed`;
    expect(cleanLogText(text)).toEndWith("ERROR: build failed");
  });

  test("keeps a message after many Unicode line separators", () => {
    const text = `${"progress 0%\u2028".repeat(5000)}ERROR: build failed`;
    expect(cleanLogText(text)).toEndWith("ERROR: build failed");
  });

  test("a DCS sequence does not swallow text after the next ESC", () => {
    expect(cleanLogText(`${ESC}Pabc${ESC}[31mred${ESC}[0m tail`)).toBe(
      "red tail",
    );
  });

  test("cuts a very long single line before the matching", () => {
    expect(cleanLogText("x".repeat(100_000)).length).toBeLessThanOrEqual(2000);
  });

  test("keeps the lines after a very long line", () => {
    expect(cleanLogText(`${"x".repeat(100_000)}\nnext`)).toEndWith("\nnext");
  });
});

describe("cleanLogText on a huge log", () => {
  const HEAD = 128 * 1024;
  const TAIL = 1024 * 1024;
  const MARKER_ROOM = 200;

  test("bounds the result of eight million newlines", () => {
    expect(cleanLogText("\n".repeat(8_000_000)).length).toBeLessThanOrEqual(
      HEAD + TAIL + MARKER_ROOM,
    );
  });

  test("bounds the number of lines of eight million newlines", () => {
    expect(
      cleanLogText("\n".repeat(8_000_000)).split("\n").length,
    ).toBeLessThanOrEqual(HEAD + TAIL + MARKER_ROOM);
  });

  test("keeps the start of a huge log", () => {
    const raw = `START\n${"x\n".repeat(4_000_000)}END`;
    expect(cleanLogText(raw)).toStartWith("START\n");
  });

  test("keeps the end of a huge log", () => {
    const raw = `START\n${"x\n".repeat(4_000_000)}END`;
    expect(cleanLogText(raw)).toEndWith("\nEND");
  });

  test("marks the dropped middle of a huge log", () => {
    const raw = `START\n${"x\n".repeat(4_000_000)}END`;
    expect(cleanLogText(raw)).toContain("[... log middle omitted ...]");
  });

  test("drops an error line in the middle of a huge log", () => {
    const raw = `${"x\n".repeat(2_000_000)}##[error]middle\n${"y\n".repeat(2_000_000)}`;
    expect(cleanLogText(raw)).not.toContain("##[error]middle");
  });

  test("leaves a log within the limits untouched", () => {
    expect(cleanLogText("a\nb")).toBe("a\nb");
  });

  test("does not leave half of a surrogate pair where the middle was dropped", () => {
    const out = cleanLogText("😀".repeat(1_000_000));
    expect(
      /\ud83d\ude00\n\[\.\.\. log middle omitted \.\.\.\]\n\ude00/.test(out),
    ).toBe(false);
  });
});

describe("condenseJobLog", () => {
  const numbered = (count: number, prefix = "line") =>
    Array.from({ length: count }, (_, i) => `${prefix} ${String(i)}`).join(
      "\n",
    );

  test("returns a short log as is", () => {
    expect(condenseJobLog("a\nb\nc", 3000)).toBe("a\nb\nc");
  });

  test("returns an empty string for an empty log", () => {
    expect(condenseJobLog("", 3000)).toBe("");
  });

  test("drops blank lines", () => {
    expect(condenseJobLog("a\n\n\nb", 3000)).toBe("a\nb");
  });

  test("drops end-of-group and debug markers", () => {
    expect(
      condenseJobLog("##[group]Run x\nbody\n##[endgroup]\n##[debug]y", 3000),
    ).toBe("##[group]Run x\nbody");
  });

  test("compresses consecutive duplicate lines", () => {
    const log = Array.from({ length: 50 }, () => "warn: same").join("\n");
    expect(condenseJobLog(log, 3000)).toBe(
      "warn: same [repeated 49 more times]",
    );
  });

  test("keeps duplicate lines that are not consecutive", () => {
    expect(condenseJobLog("a\nb\na", 3000)).toBe("a\nb\na");
  });

  test("never exceeds the character limit", () => {
    expect(condenseJobLog(numbered(5000), 3000).length).toBeLessThanOrEqual(
      3000,
    );
  });

  test("keeps the last lines of a long log", () => {
    expect(condenseJobLog(numbered(5000), 3000)).toContain("line 4999");
  });

  test("keeps the first lines of a long log", () => {
    expect(condenseJobLog(numbered(5000), 3000)).toContain("line 0\n");
  });

  test("marks the omitted lines", () => {
    expect(condenseJobLog(numbered(5000), 3000)).toMatch(
      /\[\.\.\. \d+ lines omitted \.\.\.\]/,
    );
  });

  test("keeps an error line from the middle of a long log", () => {
    const lines = numbered(5000).split("\n");
    lines[2500] = "##[error]Cannot find name 'foo'";
    expect(condenseJobLog(lines.join("\n"), 3000)).toContain(
      "##[error]Cannot find name 'foo'",
    );
  });

  test("keeps the last error line when there are many", () => {
    const lines = numbered(3000).split("\n");
    for (let i = 100; i < 2000; i += 10)
      lines[i] = `##[error]problem ${String(i)}`;
    lines[2500] = "##[error]Process completed with exit code 1.";
    expect(condenseJobLog(lines.join("\n"), 3000)).toContain(
      "Process completed with exit code 1.",
    );
  });

  test("limits the share of error lines so the tail stays", () => {
    const lines = numbered(3000).split("\n");
    for (let i = 100; i < 2000; i += 2)
      lines[i] = `##[error]problem ${String(i)} ${"x".repeat(80)}`;
    expect(condenseJobLog(lines.join("\n"), 3000)).toContain("line 2999");
  });

  test("keeps a long line within the line limit including the ellipsis", () => {
    const out = condenseJobLog(`${"x".repeat(1000)}\nnext`, 3000);
    expect(out.split("\n")[0]?.length).toBe(300);
  });

  test("marks a cut line with an ellipsis", () => {
    const out = condenseJobLog(`${"x".repeat(1000)}\nnext`, 3000);
    expect(out.split("\n")[0]).toEndWith("…");
  });

  test("cuts a very long single line", () => {
    const out = condenseJobLog(`${"x".repeat(100_000)}\nnext`, 3000);
    expect(out.length).toBeLessThan(1000);
  });

  test("does not leave half of a surrogate pair at a cut", () => {
    const out = condenseJobLog("😀".repeat(5000), 3000);
    expect(/[\ud800-\udbff]$/.test(out)).toBe(false);
  });

  test("handles a log of eight megabytes quickly", () => {
    const big = numbered(400_000, "some moderately long log line number");
    const started = Date.now();
    condenseJobLog(cleanLogText(big), 3000);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("VolatileCiExcerpt", () => {
  const excerpt = VolatileCiExcerpt.fromSanitized([
    {
      jobName: "check",
      failedSteps: ["Run lint"],
      text: "SECRET-LOOKING-TEXT",
    },
  ]);

  test("refuses to be serialized to JSON", () => {
    expect(() => JSON.stringify({ excerpt })).toThrow("must not be serialized");
  });

  test("does not show its content when converted to a string", () => {
    expect(String(excerpt)).not.toContain("SECRET-LOOKING-TEXT");
  });

  test("does not show its content when inspected", () => {
    expect(inspect(excerpt)).not.toContain("SECRET-LOOKING-TEXT");
  });

  test("hands out the jobs to a reader", () => {
    expect(excerpt.read()[0]?.text).toBe("SECRET-LOOKING-TEXT");
  });
});

describe("VolatileCiPrompt", () => {
  const prompt = VolatileCiPrompt.of("PROMPT-WITH-LOG-TEXT");

  test("refuses to be serialized to JSON", () => {
    expect(() => JSON.stringify({ prompt })).toThrow("must not be serialized");
  });

  test("does not show its content when converted to a string", () => {
    expect(`${prompt}`).not.toContain("LOG-TEXT");
  });

  test("does not show its content when inspected", () => {
    expect(inspect(prompt)).not.toContain("LOG-TEXT");
  });

  test("reveals the text for the caller that starts Claude", () => {
    expect(prompt.reveal()).toBe("PROMPT-WITH-LOG-TEXT");
  });
});

describe("VolatileCiLog", () => {
  const log = VolatileCiLog.of("RAW-LOG-TEXT");

  test("refuses to be serialized to JSON", () => {
    expect(() => JSON.stringify({ log })).toThrow("must not be serialized");
  });

  test("does not show its content when converted to a string", () => {
    expect(`${log}`).not.toContain("RAW-LOG-TEXT");
  });

  test("does not show its content when inspected", () => {
    expect(inspect(log)).not.toContain("RAW-LOG-TEXT");
  });

  test("reveals the text for the caller that builds the excerpt", () => {
    expect(log.reveal()).toBe("RAW-LOG-TEXT");
  });
});

describe("buildCiExcerpt", () => {
  const job = (overrides: Record<string, unknown> = {}) => ({
    name: "check",
    failedSteps: ["Run lint"],
    log: "2026-10-13T01:02:03.1Z ##[error]lint failed\n2026-10-13T01:02:04.1Z done",
    ...overrides,
  });

  test("returns a clean excerpt with the cleaned log", async () => {
    const outcome = await buildCiExcerpt([job()], { scan: cleanScanner });
    expect(
      outcome.kind === "clean" ? outcome.excerpt.read()[0]?.text : null,
    ).toBe("##[error]lint failed\ndone");
  });

  test("keeps the job name and the failed steps", async () => {
    const outcome = await buildCiExcerpt([job()], { scan: cleanScanner });
    expect(
      outcome.kind === "clean"
        ? [
            outcome.excerpt.read()[0]?.jobName,
            outcome.excerpt.read()[0]?.failedSteps,
          ]
        : null,
    ).toEqual(["check", ["Run lint"]]);
  });

  test("sanitizes and shortens an external job name", async () => {
    const name = `che\u202Eck\n${"x".repeat(200)}`;
    const outcome = await buildCiExcerpt([job({ name })], {
      scan: cleanScanner,
    });
    const jobName =
      outcome.kind === "clean" ? outcome.excerpt.read()[0]?.jobName : "";
    expect(jobName).toBe(`check ${"x".repeat(54)}`);
  });

  test("shortens a step name", async () => {
    const outcome = await buildCiExcerpt(
      [job({ failedSteps: ["s".repeat(500)] })],
      { scan: cleanScanner },
    );
    expect(
      outcome.kind === "clean"
        ? outcome.excerpt.read()[0]?.failedSteps[0]?.length
        : 0,
    ).toBe(60);
  });

  test("keeps at most five failed steps", async () => {
    const steps = Array.from({ length: 9 }, (_, i) => `step ${String(i)}`);
    const outcome = await buildCiExcerpt([job({ failedSteps: steps })], {
      scan: cleanScanner,
    });
    expect(
      outcome.kind === "clean"
        ? outcome.excerpt.read()[0]?.failedSteps.length
        : 0,
    ).toBe(5);
  });

  test("uses at most the first jobs", async () => {
    const jobs = Array.from({ length: CI_LOG_MAX_JOBS + 2 }, (_, i) =>
      job({ name: `job ${String(i)}` }),
    );
    const outcome = await buildCiExcerpt(jobs, { scan: cleanScanner });
    expect(outcome.kind === "clean" ? outcome.excerpt.read().length : 0).toBe(
      CI_LOG_MAX_JOBS,
    );
  });

  test("limits each job and the whole excerpt", async () => {
    const big = Array.from(
      { length: 5000 },
      (_, i) => `line ${String(i)}`,
    ).join("\n");
    const jobs = [job({ log: big }), job({ log: big }), job({ log: big })];
    const outcome = await buildCiExcerpt(jobs, { scan: cleanScanner });
    const total =
      outcome.kind === "clean"
        ? outcome.excerpt.read().reduce((sum, j) => sum + j.text.length, 0)
        : Number.POSITIVE_INFINITY;
    expect(total).toBeLessThanOrEqual(CI_LOG_TOTAL_MAX_CHARS);
  });

  test("limits one job to its own character limit", async () => {
    const big = Array.from(
      { length: 5000 },
      (_, i) => `line ${String(i)}`,
    ).join("\n");
    const outcome = await buildCiExcerpt([job({ log: big })], {
      scan: cleanScanner,
    });
    expect(
      outcome.kind === "clean" ? outcome.excerpt.read()[0]?.text.length : 0,
    ).toBeLessThanOrEqual(CI_LOG_JOB_MAX_CHARS);
  });

  test("scans the full text of each job and then the excerpt", async () => {
    let calls = 0;
    await buildCiExcerpt([job(), job({ name: "second" })], {
      scan: async () => {
        calls += 1;
        return { ok: true, output: "" };
      },
    });
    expect(calls).toBe(3);
  });

  test("scans at most the number of jobs plus one", async () => {
    let calls = 0;
    const jobs = Array.from({ length: CI_LOG_MAX_JOBS + 2 }, () => job());
    await buildCiExcerpt(jobs, {
      scan: async () => {
        calls += 1;
        return { ok: true, output: "" };
      },
    });
    expect(calls).toBe(CI_LOG_MAX_JOBS + 1);
  });

  // 省略される中間の行に置いた目印。抜粋には入らず、全文のスキャンだけが見る。
  const longLogWith = (middle: string) => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${String(i)}`);
    lines[2500] = middle;
    return lines.join("\n");
  };

  test("returns secret_detected when a token is only in the omitted middle", async () => {
    const token = `ghp_${"A".repeat(36)}`;
    const outcome = await buildCiExcerpt(
      [job({ log: longLogWith(`leaked ${token}`) })],
      { scan: async (text) => ({ ok: !/ghp_/.test(text), output: "" }) },
    );
    expect(outcome).toEqual({ kind: "secret_detected", reason: "gitleaks" });
  });

  test("scans the full text before the token-shaped strings are masked", async () => {
    const token = `ghp_${"A".repeat(36)}`;
    const seen: string[] = [];
    await buildCiExcerpt([job({ log: `use ${token}` })], {
      scan: async (text) => {
        seen.push(text);
        return { ok: true, output: "" };
      },
    });
    expect(seen[0]).toContain(token);
  });

  test("stops at the first detection without scanning the other jobs", async () => {
    let calls = 0;
    await buildCiExcerpt([job(), job({ name: "second" })], {
      scan: async () => {
        calls += 1;
        return { ok: false, output: "- generic-api-key" };
      },
    });
    expect(calls).toBe(1);
  });

  test("fails closed when the scan of the full text throws", async () => {
    const outcome = await buildCiExcerpt(
      [job({ log: longLogWith("OMITTED-MARKER") })],
      {
        scan: async (text) => {
          if (text.includes("OMITTED-MARKER")) throw new Error("timed out");
          return { ok: true, output: "" };
        },
      },
    );
    expect(outcome).toEqual({ kind: "secret_detected", reason: "scan_failed" });
  });

  test("continues with the masked excerpt when only a prefix fragment is cut", async () => {
    const log = `${"x".repeat(285)} ghp_${"A".repeat(5)} tail`;
    const outcome = await buildCiExcerpt([job({ log })], {
      scan: cleanScanner,
    });
    expect(outcome.kind).toBe("clean");
  });

  test("scans the excerpt again after the full text was clean", async () => {
    const outcome = await buildCiExcerpt([job()], {
      scan: async (text) => ({ ok: !text.startsWith("job:"), output: "" }),
    });
    expect(outcome).toEqual({ kind: "secret_detected", reason: "gitleaks" });
  });

  test("scans the job name, the step names, and the log", async () => {
    let seen = "";
    await buildCiExcerpt([job({ name: "NAME-X", failedSteps: ["STEP-X"] })], {
      scan: async (text) => {
        seen = text;
        return { ok: true, output: "" };
      },
    });
    expect(
      ["NAME-X", "STEP-X", "lint failed"].every((s) => seen.includes(s)),
    ).toBe(true);
  });

  test("returns secret_detected when gitleaks finds something", async () => {
    const outcome = await buildCiExcerpt([job()], {
      scan: async () => ({ ok: false, output: "- github-pat" }),
    });
    expect(outcome).toEqual({ kind: "secret_detected", reason: "gitleaks" });
  });

  test("does not hand out any text when gitleaks finds something", async () => {
    const outcome = await buildCiExcerpt([job()], {
      scan: async () => ({ ok: false, output: "- github-pat" }),
    });
    expect("excerpt" in outcome).toBe(false);
  });

  test("fails closed when gitleaks throws", async () => {
    const outcome = await buildCiExcerpt([job()], {
      scan: async () => {
        throw new Error("gitleaks timed out after 1000ms");
      },
    });
    expect(outcome).toEqual({ kind: "secret_detected", reason: "scan_failed" });
  });

  test("masks a known token format that the scanner missed", async () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const outcome = await buildCiExcerpt([job({ log: `token is ${token}` })], {
      scan: cleanScanner,
    });
    expect(
      outcome.kind === "clean" ? outcome.excerpt.read()[0]?.text : "",
    ).toBe("token is ***");
  });

  test("masks a token cut in half at the line limit", async () => {
    const token = `ghp_${"A".repeat(36)}`;
    const log = `${"x".repeat(285)} ${token} tail`;
    const outcome = await buildCiExcerpt([job({ log })], {
      scan: cleanScanner,
    });
    expect(
      outcome.kind === "clean" ? outcome.excerpt.read()[0]?.text : "",
    ).not.toContain("ghp_");
  });

  test("leaves no fragment of a token cut at the line limit", async () => {
    const token = `ghp_${"A".repeat(36)}`;
    const log = `${"x".repeat(290)} ${token} tail`;
    const outcome = await buildCiExcerpt([job({ log })], {
      scan: cleanScanner,
    });
    expect(
      outcome.kind === "clean" ? outcome.excerpt.read()[0]?.text : "",
    ).not.toContain("AAAA");
  });

  test.each([
    ["a fine-grained token", `github_pat_${"B".repeat(40)}`],
    ["an Anthropic key", `sk-ant-api03-${"C".repeat(40)}`],
    ["an OAuth token", `gho_${"D".repeat(36)}`],
    ["a server token", `ghs_${"E".repeat(36)}`],
  ])("masks %s before the line is cut", async (_label, token) => {
    const log = `${"x".repeat(285)} ${token} tail`;
    const outcome = await buildCiExcerpt([job({ log })], {
      scan: cleanScanner,
    });
    const text =
      outcome.kind === "clean" ? (outcome.excerpt.read()[0]?.text ?? "") : "";
    expect(/github_pat_|sk-ant-|gh[os]_|BBBB|CCCC|DDDD|EEEE/.test(text)).toBe(
      false,
    );
  });

  test("scans the text after the token was masked", async () => {
    let seen = "";
    const token = `ghp_${"A".repeat(36)}`;
    await buildCiExcerpt([job({ log: `use ${token}` })], {
      scan: async (text) => {
        seen = text;
        return { ok: true, output: "" };
      },
    });
    expect(seen).not.toContain(token);
  });

  test("returns empty when no job has any log text", async () => {
    const outcome = await buildCiExcerpt([job({ log: "\n\n" })], {
      scan: cleanScanner,
    });
    expect(outcome).toEqual({ kind: "empty" });
  });

  test("returns empty for no jobs", async () => {
    const outcome = await buildCiExcerpt([], { scan: cleanScanner });
    expect(outcome).toEqual({ kind: "empty" });
  });

  test("does not call the scanner when there is nothing to scan", async () => {
    let calls = 0;
    await buildCiExcerpt([], {
      scan: async () => {
        calls += 1;
        return { ok: true, output: "" };
      },
    });
    expect(calls).toBe(0);
  });

  test("scans the text after invisible characters are removed", async () => {
    let seen = "";
    await buildCiExcerpt([job({ log: "ab\u200Bcd_split" })], {
      scan: async (text) => {
        seen = text;
        return { ok: true, output: "" };
      },
    });
    expect(seen).toContain("abcd_split");
  });
});

describe("guardCiRoundText", () => {
  const fields = {
    commit_subject: "fix: lintエラーを直す",
    commit_body: "- 未使用の変数を消した",
    summary: "lintの指摘を直しました。",
    blocked_reason: null,
  };

  test("returns the fields as they are when nothing is found", async () => {
    const outcome = await guardCiRoundText(fields, { scan: cleanScanner });
    expect(outcome).toEqual({ kind: "clean", fields });
  });

  test("masks a known token format in every field", async () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const outcome = await guardCiRoundText(
      { ...fields, summary: `leaked ${token}`, commit_body: token },
      { scan: cleanScanner },
    );
    expect(outcome.kind === "clean" ? outcome.fields.summary : "").toBe(
      "leaked ***",
    );
  });

  test("keeps null fields null", async () => {
    const outcome = await guardCiRoundText(fields, { scan: cleanScanner });
    expect(outcome.kind === "clean" ? outcome.fields.blocked_reason : "x").toBe(
      null,
    );
  });

  test("scans every non-null field in one run", async () => {
    let seen = "";
    let calls = 0;
    await guardCiRoundText(
      { ...fields, blocked_reason: "BLOCKED-X" },
      {
        scan: async (text) => {
          seen = text;
          calls += 1;
          return { ok: true, output: "" };
        },
      },
    );
    expect(
      calls === 1 &&
        [
          fields.commit_subject,
          fields.commit_body,
          fields.summary,
          "BLOCKED-X",
        ].every((part) => seen.includes(part)),
    ).toBe(true);
  });

  test("returns secret_detected when gitleaks finds something", async () => {
    const outcome = await guardCiRoundText(fields, {
      scan: async () => ({ ok: false, output: "- generic-api-key" }),
    });
    expect(outcome).toEqual({ kind: "secret_detected", reason: "gitleaks" });
  });

  test("fails closed when gitleaks throws", async () => {
    const outcome = await guardCiRoundText(fields, {
      scan: async () => {
        throw new Error("boom");
      },
    });
    expect(outcome).toEqual({ kind: "secret_detected", reason: "scan_failed" });
  });
});
