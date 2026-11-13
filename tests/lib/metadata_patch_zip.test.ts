import { describe, expect, test } from "bun:test";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { MAX_FILE_BYTES } from "../../f/factory/lib/metadata_patch_manifest.ts";
import {
  MAX_ZIP_BYTES,
  MAX_ZIP_ENTRIES,
  readMetadataPatchZip,
} from "../../f/factory/lib/metadata_patch_zip.ts";
import { buildZip } from "../console_fetcher/zip_fixture.ts";

const text = (bytes: Uint8Array | undefined): string =>
  new TextDecoder().decode(bytes);

function reason(bytes: Uint8Array): string {
  const result = readMetadataPatchZip(bytes);
  return result.ok ? "ok" : result.reason;
}

/** 中央ディレクトリの先頭のエントリの、オフセットを指定した2バイトを書き換える。 */
function patchCentralUint16(
  zip: Uint8Array,
  offsetInHeader: number,
  value: number,
): Uint8Array {
  const copy = zip.slice();
  const view = new DataView(copy.buffer);
  for (let i = 0; i < copy.byteLength - 4; i++) {
    if (view.getUint32(i, true) === 0x02014b50) {
      view.setUint16(i + offsetInHeader, value, true);
      return copy;
    }
  }
  throw new Error("central directory not found");
}

describe("readMetadataPatchZip", () => {
  test("reads a deflated file", () => {
    const zip = buildZip([{ name: "manifest.json", data: "{}" }]);
    const result = readMetadataPatchZip(zip);
    expect(result.ok && text(result.files.get("manifest.json"))).toBe("{}");
  });

  test("reads a stored file", () => {
    const zip = buildZip([{ name: "a.txt", data: "abc", method: 0 }]);
    const result = readMetadataPatchZip(zip);
    expect(result.ok && text(result.files.get("a.txt"))).toBe("abc");
  });

  test("skips directory entries", () => {
    const zip = buildZip([
      { name: "files/", unixMode: 0o040755 },
      { name: "files/a", data: "x" },
    ]);
    const result = readMetadataPatchZip(zip);
    expect(result.ok && [...result.files.keys()]).toEqual(["files/a"]);
  });

  test("rejects a symlink", () => {
    const zip = buildZip([{ name: "files/a", data: "x", unixMode: 0o120777 }]);
    expect(reason(zip)).toBe("symlink");
  });

  test("rejects a special file", () => {
    const zip = buildZip([{ name: "files/a", data: "", unixMode: 0o010644 }]);
    expect(reason(zip)).toBe("special_file");
  });

  test("rejects a directory entry with a file mode", () => {
    const zip = buildZip([{ name: "files/", unixMode: 0o100644 }]);
    expect(reason(zip)).toBe("special_file");
  });

  test("rejects duplicate names", () => {
    const zip = buildZip([
      { name: "files/a", data: "1" },
      { name: "files/a", data: "2" },
    ]);
    expect(reason(zip)).toBe("duplicate");
  });

  test("rejects names that differ only in case", () => {
    const zip = buildZip([
      { name: "files/f/Lock", data: "1" },
      { name: "files/F/lock", data: "2" },
    ]);
    expect(reason(zip)).toBe("case_collision");
  });

  test("rejects a file that is also a directory of another file", () => {
    const zip = buildZip([
      { name: "files/a", data: "1" },
      { name: "files/a/b", data: "2" },
    ]);
    expect(reason(zip)).toBe("path_conflict");
  });

  test.each([
    ["a parent reference", "files/../x"],
    ["a leading parent reference", "../x"],
    ["an absolute path", "/etc/passwd"],
    ["a backslash", "files\\x"],
    ["a drive letter", "C:/x"],
    ["a control character", "files/a\u0001b"],
    ["a newline", "files/a\nb"],
    ["a dot segment", "files/./x"],
    ["an empty segment", "files//x"],
  ])("rejects %s", (_label, name) => {
    const zip = buildZip([{ name, data: "x" }]);
    expect(reason(zip)).toBe("unsafe_path");
  });

  test("rejects a declared size smaller than the real size", () => {
    const zip = buildZip([{ name: "a", data: "hello", declaredSize: 2 }]);
    expect(reason(zip)).toBe("size_mismatch");
  });

  test("rejects a declared size larger than the real size", () => {
    const zip = buildZip([{ name: "a", data: "hello", declaredSize: 9 }]);
    expect(reason(zip)).toBe("size_mismatch");
  });

  test("rejects a zip bomb by the declared total before inflating", () => {
    const big = new Uint8Array(MAX_FILE_BYTES);
    const entries = Array.from({ length: 6 }, (_, i) => ({
      name: `files/${String(i)}`,
      data: big,
    }));
    expect(reason(buildZip(entries))).toBe("too_large");
  });

  test("rejects a single file over the file limit", () => {
    const zip = buildZip([
      { name: "a", data: new Uint8Array(MAX_FILE_BYTES + 1) },
    ]);
    expect(reason(zip)).toBe("too_large");
  });

  test("stops inflating at the declared size", () => {
    const real = new Uint8Array(MAX_FILE_BYTES);
    const zip = buildZip([{ name: "a", data: real, declaredSize: 10 }]);
    expect(reason(zip)).toBe("size_mismatch");
  });

  test("rejects too many entries", () => {
    const entries = Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => ({
      name: `files/${String(i)}`,
      data: "x",
    }));
    expect(reason(buildZip(entries))).toBe("too_many_entries");
  });

  test("rejects an unsupported compression method", () => {
    const zip = buildZip([{ name: "a", data: "x", method: 12 }]);
    expect(reason(zip)).toBe("unsupported_method");
  });

  test("rejects an encrypted entry", () => {
    const zip = buildZip([{ name: "a", data: "x", flags: 1 }]);
    expect(reason(zip)).toBe("encrypted");
  });

  test("rejects a local header whose name differs from the central one", () => {
    const zip = buildZip([
      { name: "files/a", data: "x", localName: "files/b" },
    ]);
    expect(reason(zip)).toBe("malformed");
  });

  test("rejects bytes that are not a zip", () => {
    expect(
      reason(new TextEncoder().encode("PK not really a zip file.....")),
    ).toBe("no_end_record");
  });

  test("rejects input shorter than an end record", () => {
    expect(reason(new Uint8Array(5))).toBe("too_short");
  });

  test("rejects a zip64 marker in the entry count", () => {
    const zip = buildZip([{ name: "a", data: "x" }]);
    const copy = zip.slice();
    const view = new DataView(copy.buffer);
    view.setUint16(copy.byteLength - 22 + 10, 0xffff, true);
    view.setUint16(copy.byteLength - 22 + 8, 0xffff, true);
    expect(reason(copy)).toBe("zip64");
  });

  test("rejects a multi-disk archive", () => {
    const zip = buildZip([{ name: "a", data: "x" }]);
    const copy = zip.slice();
    new DataView(copy.buffer).setUint16(copy.byteLength - 22 + 4, 1, true);
    expect(reason(copy)).toBe("multi_disk");
  });

  test("rejects a raw name with high bytes when the UTF-8 flag is clear", () => {
    const zip = patchCentralUint16(
      buildZip([{ name: "a\u00e9", data: "x" }]),
      8,
      0,
    );
    expect(reason(zip)).toBe("bad_name");
  });

  test("rejects an inflated entry that exceeds its compressed bounds", () => {
    const raw = new TextEncoder().encode("hello");
    const body = new Uint8Array(deflateRawSync(raw));
    const zip = buildZip([{ name: "a", data: raw }]);
    const copy = zip.slice();
    const view = new DataView(copy.buffer);
    for (let i = 0; i < copy.byteLength - 4; i++) {
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint32(i + 20, body.byteLength + 1000, true);
        break;
      }
    }
    expect(reason(copy)).toBe("malformed");
  });

  test("exposes a zip size limit above the total content limit", () => {
    expect(MAX_ZIP_BYTES).toBeGreaterThan(4 * 1024 * 1024);
  });
});

describe("metadata_patch_zip limits", () => {
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
      new DataView(zip.buffer).setUint32(
        zip.byteLength - 22 + 12,
        0xffff,
        true,
      );
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

    // 実時間が要る。申告の大きさが小さいzipに巨大な実データがあるとき、膨張させずに、申告の大きさで読むのを止めることを、経過時間の上限で確かめる。
    // 全部を展開すれば、上限を大きく超える。
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
});
