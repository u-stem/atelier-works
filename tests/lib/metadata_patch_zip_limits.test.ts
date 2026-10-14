import { describe, expect, test } from "bun:test";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import {
  MAX_ZIP_BYTES,
  readMetadataPatchZip,
} from "../../f/factory/lib/metadata_patch_zip.ts";
import { buildZip } from "../console_fetcher/zip_fixture.ts";

function reason(bytes: Uint8Array): string {
  const result = readMetadataPatchZip(bytes);
  return result.ok ? "ok" : result.reason;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

describe("readMetadataPatchZip limits", () => {
  test("rejects bytes larger than the zip limit", () => {
    expect(reason(new Uint8Array(MAX_ZIP_BYTES + 1))).toBe("too_large");
  });

  test("rejects a zip64 locator before the end record", () => {
    const zip = buildZip([{ name: "a", data: "x" }]);
    const locator = new Uint8Array(20);
    new DataView(locator.buffer).setUint32(0, 0x07064b50, true);
    const end = zip.byteLength - 22;
    const withLocator = concat([
      zip.subarray(0, end),
      locator,
      zip.subarray(end),
    ]);
    expect(reason(withLocator)).toBe("zip64");
  });

  test("rejects a comment length that does not reach the end", () => {
    const zip = buildZip([{ name: "a", data: "x" }]).slice();
    new DataView(zip.buffer).setUint16(zip.byteLength - 22 + 20, 5, true);
    expect(reason(zip)).toBe("no_end_record");
  });

  test("rejects a central directory that runs past the end record", () => {
    const zip = buildZip([{ name: "a", data: "x" }]).slice();
    new DataView(zip.buffer).setUint32(zip.byteLength - 22 + 12, 0xffff, true);
    expect(reason(zip)).toBe("malformed");
  });

  test("rejects a path longer than 255 characters", () => {
    const zip = buildZip([{ name: "a".repeat(256), data: "x" }]);
    expect(reason(zip)).toBe("unsafe_path");
  });

  test("accepts a path of 255 characters", () => {
    const zip = buildZip([{ name: "a".repeat(255), data: "x" }]);
    expect(reason(zip)).toBe("ok");
  });

  test("rejects a name that is not UTF-8", () => {
    const zip = buildZip([{ name: "zz", data: "x" }]).slice();
    for (let i = 0; i < zip.byteLength - 1; i++) {
      if (zip[i] === 0x7a && zip[i + 1] === 0x7a) {
        zip[i] = 0xff;
        zip[i + 1] = 0xfe;
      }
    }
    expect(reason(zip)).toBe("bad_name");
  });
});

describe("inflation stops at the declared size", () => {
  const zeros = new Uint8Array(100 * 1024 * 1024);
  const compressed = new Uint8Array(deflateRawSync(zeros));

  test("inflateRawSync throws when the output passes maxOutputLength", () => {
    expect(() => inflateRawSync(compressed, { maxOutputLength: 10 })).toThrow(
      "larger than 10 bytes",
    );
  });

  test("inflateRawSync stops before it allocates the whole output", () => {
    const before = process.memoryUsage().rss;
    try {
      inflateRawSync(compressed, { maxOutputLength: 10 });
    } catch {
      // 上限で打ち切られる。
    }
    expect(process.memoryUsage().rss - before).toBeLessThan(30 * 1024 * 1024);
  });

  test("stops quickly on a small declared size with a huge real size", () => {
    const zip = buildZip([{ name: "a", data: zeros, declaredSize: 10 }]);
    const started = performance.now();
    const result = readMetadataPatchZip(zip);
    expect([
      result.ok ? "ok" : result.reason,
      performance.now() - started < 2000,
    ]).toEqual(["size_mismatch", true]);
  });
});
