import { describe, expect, test } from "bun:test";
import {
  LOG_LIMIT_BYTES,
  RESULT_LIMIT_BYTES,
  redactLog,
  redactResult,
  redactText,
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
    const out = redactLog("alpha\nbravo\ncharlie\ndelta\n", 14);
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
    expect(redactLog(raw, limit).text).toBe("last\n");
  });

  test("returns an empty text when the kept tail has no line break", () => {
    expect(redactLog("x".repeat(100), 10).text).toBe("");
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
    const out = redactResult(`${"a".repeat(10)}${"b".repeat(100)}`, 20);
    expect(out.truncated).toBe(true);
  });

  test("keeps the head of a long result", () => {
    expect(redactResult(`head-${"z".repeat(100)}`, 20).text).toBe(
      "head-zzzzzzzzzzzzzzz",
    );
  });

  test("does not cut a multibyte character in half", () => {
    expect(redactResult("あ".repeat(100), 20).text).toBe("あ".repeat(6));
  });

  test("masks a token before the cut, so no part of it is left", () => {
    const value = `${"x ".repeat(5)}${GH_TOKEN}`;
    expect(redactResult(value, 20).text).toBe("x x x x x ***");
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
