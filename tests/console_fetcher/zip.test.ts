import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isSafeReleasePath,
  readZip,
  type ZipResult,
} from "../../infra/console_fetcher/zip.ts";
import { buildZip } from "./zip_fixture.ts";

const LIMITS = { maxEntries: 100, maxTotalBytes: 1024 * 1024 };
const decoder = new TextDecoder();

function paths(result: ZipResult): readonly string[] {
  return result.ok ? result.entries.map((entry) => entry.path) : [];
}

function code(result: ZipResult): string | null {
  return result.ok ? null : result.code;
}

function firstText(result: ZipResult): string | null {
  const entry = result.ok ? result.entries[0] : undefined;
  return entry === undefined ? null : decoder.decode(entry.data);
}

describe("readZip", () => {
  test("reads the entry paths of a real GitHub Actions artifact", () => {
    const bytes = new Uint8Array(
      readFileSync(
        join(
          import.meta.dir,
          "../fixtures/console_fetcher/upload-artifact-sample.zip",
        ),
      ),
    );
    expect(paths(readZip(bytes, LIMITS))).toEqual([
      "to/dir-1/file1.txt",
      "to/dir-2/file2.txt",
    ]);
  });

  test("reads the content of a real GitHub Actions artifact", () => {
    const bytes = new Uint8Array(
      readFileSync(
        join(
          import.meta.dir,
          "../fixtures/console_fetcher/upload-artifact-sample.zip",
        ),
      ),
    );
    expect(firstText(readZip(bytes, LIMITS))).toBe(
      "Lorem ipsum dolor sit amet\n",
    );
  });

  test("inflates a deflated entry", () => {
    const zip = buildZip([{ name: "index.html", data: "<p>hello</p>" }]);
    expect(firstText(readZip(zip, LIMITS))).toBe("<p>hello</p>");
  });

  test("reads a stored entry", () => {
    const zip = buildZip([{ name: "a.txt", data: "stored", method: 0 }]);
    expect(firstText(readZip(zip, LIMITS))).toBe("stored");
  });

  test("leaves directory entries out of the result", () => {
    const zip = buildZip([
      { name: "assets/", unixMode: 0o040755 },
      { name: "assets/a.js", data: "x" },
    ]);
    expect(paths(readZip(zip, LIMITS))).toEqual(["assets/a.js"]);
  });

  test("rejects a parent directory segment", () => {
    const zip = buildZip([{ name: "../escape.txt", data: "x" }]);
    expect(code(readZip(zip, LIMITS))).toBe("zip_unsafe_entry");
  });

  test("rejects an absolute path", () => {
    const zip = buildZip([{ name: "/etc/passwd", data: "x" }]);
    expect(code(readZip(zip, LIMITS))).toBe("zip_unsafe_entry");
  });

  test("rejects a backslash in the name", () => {
    const zip = buildZip([{ name: "assets\\a.js", data: "x" }]);
    expect(code(readZip(zip, LIMITS))).toBe("zip_unsafe_entry");
  });

  test("rejects a symlink entry", () => {
    const zip = buildZip([
      { name: "link", data: "/etc/passwd", unixMode: 0o120777 },
    ]);
    expect(code(readZip(zip, LIMITS))).toBe("zip_unsafe_entry");
  });

  test("rejects a duplicated name", () => {
    const zip = buildZip([
      { name: "a.txt", data: "1" },
      { name: "a.txt", data: "2" },
    ]);
    expect(code(readZip(zip, LIMITS))).toBe("zip_unsafe_entry");
  });

  test("rejects an encrypted entry", () => {
    const zip = buildZip([{ name: "a.txt", data: "x", flags: 0x1 }]);
    expect(code(readZip(zip, LIMITS))).toBe("zip_unsafe_entry");
  });

  test("rejects a local header whose name differs from the central directory", () => {
    const zip = buildZip([{ name: "a.txt", localName: "b.txt", data: "x" }]);
    expect(code(readZip(zip, LIMITS))).toBe("zip_invalid");
  });

  test("rejects an entry that inflates beyond its declared size", () => {
    const zip = buildZip([
      { name: "a.txt", data: "0123456789", declaredSize: 4 },
    ]);
    expect(code(readZip(zip, LIMITS))).toBe("zip_invalid");
  });

  test("rejects an unsupported compression method", () => {
    const zip = buildZip([{ name: "a.txt", data: "x", method: 12 }]);
    expect(code(readZip(zip, LIMITS))).toBe("zip_invalid");
  });

  test("rejects more entries than the limit", () => {
    const zip = buildZip([
      { name: "a.txt", data: "1" },
      { name: "b.txt", data: "2" },
    ]);
    expect(code(readZip(zip, { ...LIMITS, maxEntries: 1 }))).toBe(
      "zip_invalid",
    );
  });

  test("rejects a total size beyond the limit", () => {
    const zip = buildZip([{ name: "a.txt", data: "0123456789" }]);
    expect(code(readZip(zip, { ...LIMITS, maxTotalBytes: 5 }))).toBe(
      "zip_invalid",
    );
  });

  test("rejects bytes that are not a zip", () => {
    expect(code(readZip(new TextEncoder().encode("not a zip"), LIMITS))).toBe(
      "zip_invalid",
    );
  });
});

describe("isSafeReleasePath", () => {
  test("accepts a hashed asset path", () => {
    expect(isSafeReleasePath("assets/index-B1x_9-Qa.js")).toBe(true);
  });

  test("rejects a current directory segment", () => {
    expect(isSafeReleasePath("./index.html")).toBe(false);
  });

  test("rejects a control character", () => {
    expect(isSafeReleasePath("a\u0001b")).toBe(false);
  });
});
