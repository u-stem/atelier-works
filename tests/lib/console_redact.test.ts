import { describe, expect, test } from "bun:test";
import {
  LOG_LIMIT_BYTES,
  RESULT_LIMIT_BYTES,
  redactLog,
  redactResult,
  redactText,
  redactValue,
} from "../../f/factory/lib/console_redact.ts";

// 形だけが本物らしい偽の値。実在の鍵ではない。
const GH_TOKEN = `ghp_${"0123456789abcdefghijklmnopqrstuvwxyzAB"}`;
const LONG_RUN = "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3";
const SHA40 = "0123456789abcdef0123456789abcdef01234567";
const SHA64 = "0123456789abcdef".repeat(4);
const UUID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const PEM_BODY = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
const PEM = `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n-----END PRIVATE KEY-----`;

/** `jsonLine`が作った行から、`fields.note`を取り出す。 */
function noteOf(line: string): unknown {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null || !("fields" in parsed)) {
    throw new Error("not a log line");
  }
  const { fields } = parsed;
  if (typeof fields !== "object" || fields === null || !("note" in fields)) {
    throw new Error("no note");
  }
  return fields.note;
}

function jsonLine(fields: Record<string, unknown>): string {
  return JSON.stringify({
    ts: "2026-10-26T00:00:00.000Z",
    level: "info",
    stage: "demo",
    message: "m",
    fields,
  });
}

describe("redactLog with a JSON line", () => {
  test("masks a known token that sits in a field value", () => {
    const out = redactLog(jsonLine({ note: `value ${GH_TOKEN}` }));
    expect(noteOf(out.text)).toBe("value ***");
  });

  test("replaces the whole value of a field whose key names a secret", () => {
    const out = redactLog(jsonLine({ my_Password: "short" }));
    expect(out.text).toContain('"my_Password":"***"');
  });

  test("replaces a nested value under a key that names a secret", () => {
    const out = redactLog(jsonLine({ api_key: ["a", { b: "c" }] }));
    expect(out.text).toContain('"api_key":"***"');
  });

  test("keeps the fields that carry no secret", () => {
    const line = jsonLine({ work_item_id: 42, repo: "octo/widgets" });
    expect(redactLog(line).text).toBe(line);
  });

  test("masks a PEM block whose newlines are escaped once", () => {
    const out = redactLog(jsonLine({ note: PEM }));
    expect(noteOf(out.text)).toBe("***");
  });

  test("masks a PEM block whose newlines are escaped twice", () => {
    const doubled = jsonLine({ note: PEM.replaceAll("\n", "\\n") });
    expect(noteOf(redactLog(doubled).text)).toBe("***");
  });

  test("keeps a 40-digit hex sha, a 64-digit hex digest, a uuid and a path", () => {
    const line = jsonLine({
      head_sha: SHA40,
      digest: SHA64,
      job: UUID,
      path: "f/factory/steps/pr_fix_verify",
    });
    expect(redactLog(line).text).toBe(line);
  });

  test("masks a long token-like run of letters and digits", () => {
    const out = redactLog(jsonLine({ note: `see ${LONG_RUN} here` }));
    expect(noteOf(out.text)).toBe("see *** here");
  });

  test("masks a bearer token", () => {
    const out = redactLog(jsonLine({ note: "Bearer abc.def-ghi_jkl" }));
    expect(noteOf(out.text)).toBe("Bearer ***");
  });

  test("masks the userinfo of a URL", () => {
    const out = redactLog(jsonLine({ url: "https://user:pw@example.com/x" }));
    expect(out.text).toContain("https://***@example.com/x");
  });

  test("masks a JWT", () => {
    const jwt = [
      "eyJhbGciOiJIUzI1NiJ9",
      "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
      "abcdefghij",
    ].join(".");
    expect(noteOf(redactLog(jsonLine({ note: jwt })).text)).toBe("***");
  });

  test("masks an AWS access key id", () => {
    const id = `AKIA${"ABCDEFGHIJKLMNOP"}`;
    expect(noteOf(redactLog(jsonLine({ note: id })).text)).toBe("***");
  });

  test("masks a KEY=VALUE pair inside a message even when the value is short", () => {
    const out = redactLog(jsonLine({ note: "API_KEY=abc next" }));
    expect(out.text).toContain("API_KEY=***");
  });

  test("counts no non-JSON line", () => {
    expect(redactLog(jsonLine({ a: 1 })).nonJsonLines).toBe(0);
  });
});

describe("redactLog with a line that is not JSON", () => {
  test("masks a known token", () => {
    expect(redactLog(`plain ${GH_TOKEN} output`).text).toBe("plain *** output");
  });

  test("masks a lowercase token= pair", () => {
    expect(redactLog("curl --data token=abcd").text).toBe(
      "curl --data token=***",
    );
  });

  test("masks a password: pair", () => {
    expect(redactLog("password: hunter2").text).toBe("password: ***");
  });

  test("masks a PEM block that spans lines", () => {
    expect(redactLog(`before\n${PEM}\nafter`).text).toBe("before\n***\nafter");
  });

  test("counts each non-blank line as non-JSON", () => {
    expect(redactLog("hello\n\nworld").nonJsonLines).toBe(2);
  });
});

describe("redactLog flags", () => {
  test("reports that it masked something", () => {
    expect(redactLog(`x ${GH_TOKEN}`).masked).toBe(true);
  });

  test("reports that it masked nothing", () => {
    expect(redactLog("nothing to hide").masked).toBe(false);
  });

  test("does not report truncation for a short log", () => {
    expect(redactLog("short").truncated).toBe(false);
  });
});

describe("redactLog truncation", () => {
  test("reports truncation for a log longer than the limit", () => {
    expect(redactLog("line\n".repeat(100), 50).truncated).toBe(true);
  });

  test("keeps the tail of the log", () => {
    const raw = `${"old line\n".repeat(50)}the newest line`;
    expect(redactLog(raw, 60).text.endsWith("the newest line")).toBe(true);
  });

  test("stays within the limit", () => {
    const out = redactLog("0123456789\n".repeat(100), 200);
    expect(new TextEncoder().encode(out.text).length).toBeLessThanOrEqual(200);
  });

  test("drops the partial line at the cut", () => {
    const out = redactLog("alpha\nbravo\ncharlie\ndelta\n", 16);
    expect(out.text).toBe("charlie\ndelta\n");
  });

  test("keeps the first line when the cut falls exactly on a line start", () => {
    const out = redactLog("alpha\nbravo\n", 6);
    expect(out.text).toBe("bravo\n");
  });

  test("never shows a piece of a token that straddles the cut", () => {
    const raw = `filler line\ntail ${GH_TOKEN} end\nlast\n`;
    const limit =
      new TextEncoder().encode(`${GH_TOKEN} end\nlast\n`).length - 8;
    expect(redactLog(raw, limit).text).not.toContain("0123456789abcdef");
  });

  test("masks before it cuts, so the token is masked whole when it fits after masking", () => {
    const raw = `filler line\ntail ${GH_TOKEN} end\nlast\n`;
    const limit =
      new TextEncoder().encode(`${GH_TOKEN} end\nlast\n`).length - 8;
    expect(redactLog(raw, limit).text).toBe(
      "filler line\ntail *** end\nlast\n",
    );
  });

  test("returns an empty text when the kept tail has no line break", () => {
    expect(redactLog("x ".repeat(50), 10).text).toBe("");
  });

  test("masks a PEM block whose BEGIN line was cut away by the coarse cut", () => {
    const body = Array.from(
      { length: 10 },
      (_, i) => `Zq9${String(i)}/abcdefghijklmnopqrstuvwxyz01234\n`,
    ).join("");
    const raw = `-----BEGIN PRIVATE KEY-----\n${body}-----END PRIVATE KEY-----\ntail line\n`;
    expect(redactLog(raw, 110).text).not.toContain("Zq9");
  });

  test("keeps the line after a PEM block whose BEGIN line was cut away", () => {
    const body = Array.from(
      { length: 10 },
      (_, i) => `Zq9${String(i)}/abcdefghijklmnopqrstuvwxyz01234\n`,
    ).join("");
    const raw = `-----BEGIN PRIVATE KEY-----\n${body}-----END PRIVATE KEY-----\ntail line\n`;
    expect(redactLog(raw, 110).text.endsWith("tail line\n")).toBe(true);
  });

  test("does not show the END line of a block whose BEGIN line was cut away", () => {
    const body = Array.from(
      { length: 10 },
      (_, i) => `Zq9${String(i)}/abcdefghijklmnopqrstuvwxyz01234\n`,
    ).join("");
    const raw = `-----BEGIN PRIVATE KEY-----\n${body}-----END PRIVATE KEY-----\ntail line\n`;
    expect(redactLog(raw, 110).text).not.toContain("-----END");
  });

  test("masks a token that the final cut would have split", () => {
    const raw = `head line\nkey ${GH_TOKEN}\nlast line\n`;
    expect(redactLog(raw, 40).text).not.toContain("0123456789abcdef");
  });

  test("uses the documented default limit", () => {
    expect(LOG_LIMIT_BYTES).toBe(256 * 1024);
  });
});

describe("control characters", () => {
  test("drops an ANSI color sequence", () => {
    expect(redactLog("\u001b[31mred\u001b[0m").text).toBe("red");
  });

  test("masks a token that an ANSI sequence splits", () => {
    const split = `${GH_TOKEN.slice(0, 8)}\u001b[0m${GH_TOKEN.slice(8)}`;
    expect(redactLog(split).text).toBe("***");
  });

  test("drops a bidirectional control character", () => {
    expect(redactLog("a‮b⁦c").text).toBe("abc");
  });

  test("drops a control character that arrives through a JSON escape", () => {
    const line = jsonLine({ note: "a\u001bb" });
    expect(noteOf(redactLog(line).text)).toBe("ab");
  });

  test("drops a control character from the final text of a result", () => {
    expect(JSON.parse(redactResult({ note: "a\u0007b" }).text)).toEqual({
      note: "ab",
    });
  });

  test("keeps a tab and a newline", () => {
    expect(redactLog("a\tb\nc").text).toBe("a\tb\nc");
  });
});

describe("deeply nested input", () => {
  test("does not overflow the stack on a deeply nested log line", () => {
    const deep = `${"[".repeat(5000)}${"]".repeat(5000)}`;
    expect(redactLog(deep).masked).toBe(true);
  });

  test("does not overflow the stack on a deeply nested result", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 5000; i += 1) deep = [deep];
    expect(redactResult(deep).masked).toBe(true);
  });
});

describe("redactResult", () => {
  test("returns an object as JSON text", () => {
    expect(JSON.parse(redactResult({ a: 1, b: ["x"] }).text)).toEqual({
      a: 1,
      b: ["x"],
    });
  });

  test("replaces the value under a secret key", () => {
    expect(JSON.parse(redactResult({ webhook_url: "http://x" }).text)).toEqual({
      webhook_url: "***",
    });
  });

  test("masks a token inside a string value", () => {
    expect(JSON.parse(redactResult({ note: GH_TOKEN }).text)).toEqual({
      note: "***",
    });
  });

  test("returns a string result as it is, without JSON quotes", () => {
    expect(redactResult("done").text).toBe("done");
  });

  test("masks a token in a string result", () => {
    expect(redactResult(`out ${GH_TOKEN}`).text).toBe("out ***");
  });

  test("returns null as the text null", () => {
    expect(redactResult(null).text).toBe("null");
  });

  test("returns an empty text for undefined", () => {
    expect(redactResult(undefined).text).toBe("");
  });

  test("reports truncation for a result longer than the limit", () => {
    const out = redactResult("word ".repeat(40), 20);
    expect(out.truncated).toBe(true);
  });

  test("keeps the head of a long result", () => {
    expect(redactResult(`head ${"word ".repeat(40)}`, 20).text).toBe(
      "head word word word ",
    );
  });

  test("does not cut a multibyte character in half", () => {
    expect(redactResult("あ".repeat(100), 20).text).toBe("あ".repeat(6));
  });

  test("masks a token before the cut, so no part of it is left", () => {
    const value = `${"x ".repeat(5)}${GH_TOKEN}`;
    expect(redactResult(value, 100).text).toBe("x x x x x ***");
  });

  test("leaves no piece of a token that the coarse cut would have split", () => {
    const value = `${"word ".repeat(10)}${GH_TOKEN}`;
    expect(redactResult(value, 35).text).not.toContain("ghp_");
  });

  test("masks before the final cut, so a token inside the limit is masked whole", () => {
    const value = `${"x ".repeat(5)}${GH_TOKEN} tail`;
    expect(redactResult(value, 100).text).toBe("x x x x x *** tail");
  });

  test("uses the documented default limit", () => {
    expect(RESULT_LIMIT_BYTES).toBe(64 * 1024);
  });
});

describe("redactText", () => {
  test("masks a known token", () => {
    expect(redactText(`x ${GH_TOKEN}`).text).toBe("x ***");
  });

  test("keeps plain text", () => {
    expect(redactText("plain text").text).toBe("plain text");
  });
});

describe("adversarial input", () => {
  /** 敵対的な入力でも、伏せ字が1秒未満で終わること。正規表現の計算量が膨らむと超える。 */
  function secondsToRedactLog(body: string): number {
    const started = performance.now();
    redactLog(`\n${body}\n`);
    return (performance.now() - started) / 1000;
  }

  test.each([
    ["many PEM BEGIN markers", "-----BEGIN X-----".repeat(15000)],
    ["a dotted chain that looks like a scheme", "a.".repeat(131072)],
    ["a repeated JWT head without a dot", "eyJab-".repeat(43690)],
    ["a repeated scheme separator", "://".repeat(85000)],
    ["a repeated key word", "TOKEN".repeat(50000)],
    ["a repeated Bearer", "Bearer ".repeat(36000)],
    ["a repeated JWT head with dots", "eyJabcde.abcdeabcde.".repeat(13000)],
  ])("redactLog finishes %s in under a second", (_name, body) => {
    expect(secondsToRedactLog(body)).toBeLessThan(1);
  });

  test("redactResult finishes a 500KB result in under a second", () => {
    const started = performance.now();
    redactResult("a. ".repeat(170000));
    expect((performance.now() - started) / 1000).toBeLessThan(1);
  });

  test("redactResult finishes a 500KB object result in under a second", () => {
    const value = {
      items: Array.from({ length: 6000 }, (_, i) => ({
        id: i,
        note: "some words ".repeat(7),
      })),
    };
    const started = performance.now();
    redactResult(value);
    expect((performance.now() - started) / 1000).toBeLessThan(1);
  });

  test("redactLog keeps the text before a flood of BEGIN markers", () => {
    const text = redactLog(`before\n${"-----BEGIN X-----\n".repeat(200)}`).text;
    expect(text.startsWith("before\n")).toBe(true);
  });

  test("redactLog shows none of a flood of BEGIN markers", () => {
    const raw = `before\n${"-----BEGIN X-----\nSECRETBODY\n".repeat(200)}`;
    expect(redactLog(raw).text).not.toContain("SECRETBODY");
  });
});

describe("redactValue", () => {
  test("keeps the structure and masks a token inside", () => {
    expect(redactValue({ list: [`x ${GH_TOKEN}`], n: 1 }).value).toEqual({
      list: ["x ***"],
      n: 1,
    });
  });

  test("replaces the value under a secret key", () => {
    expect(redactValue({ discord_webhook: "http://x" }).value).toEqual({
      discord_webhook: "***",
    });
  });

  test("reports that it masked something", () => {
    expect(redactValue({ a: GH_TOKEN }).masked).toBe(true);
  });

  test("reports that it masked nothing", () => {
    expect(redactValue({ a: "plain" }).masked).toBe(false);
  });
});
