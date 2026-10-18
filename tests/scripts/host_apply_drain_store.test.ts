import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DrainRecord,
  MAX_DRAIN_BYTES,
  parseDrainRecord,
  readDrain,
  serializeDrainRecord,
  writeDrain,
} from "../../scripts/host_apply/drain_store.ts";

const ID = "0123456789abcdef".repeat(4);
const OTHER_ID = "fedcba9876543210".repeat(4);

const ENTRY = {
  container_id: ID,
  started_at: "2026-10-18T01:02:03.123456789Z",
  signaled_at: "2026-10-18T01:05:00.000Z",
  writer: "executor",
};

const RECORD: DrainRecord = {
  schema: 1,
  entries: {
    windmill_worker: {
      container_id: ID,
      started_at: "2026-10-18T01:02:03.123456789Z",
      signaled_at: "2026-10-18T01:05:00.000Z",
      writer: "executor",
    },
    windmill_worker_console: {
      container_id: OTHER_ID,
      started_at: "2026-10-18T02:00:00+09:00",
      signaled_at: "2026-10-18T01:06:00Z",
      writer: "compose_up",
    },
  },
};

/** 正しい本文に、最上位と項目の上書きを重ねて文字列にする。 */
function body(
  top: Record<string, unknown> = {},
  entry: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schema: 1,
    entries: { windmill_worker: { ...ENTRY, ...entry } },
    ...top,
  });
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "host-apply-drain-"));
  roots.push(root);
  return root;
}

/** 0700の状態ディレクトリを作る。 */
function privateDir(): string {
  const dir = join(tempRoot(), "state");
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

const uid = process.getuid?.() ?? 0;

describe("parseDrainRecord", () => {
  test("reads a valid record", () => {
    expect(parseDrainRecord(JSON.stringify(RECORD))).toEqual(RECORD);
  });

  test("rejects a writer that is unknown", () => {
    expect(parseDrainRecord(body({}, { writer: "human" }))).toBeNull();
  });

  test("rejects a key that is not a worker", () => {
    expect(
      parseDrainRecord(body({ entries: { db: { ...ENTRY } } })),
    ).toBeNull();
  });

  test.each([
    ["12 digits", "0123456789ab"],
    ["63 digits", "a".repeat(63)],
    ["65 digits", "a".repeat(65)],
    ["upper case", "A".repeat(64)],
    ["not hex", "g".repeat(64)],
  ])("rejects a container_id of %s", (_name, containerId) => {
    expect(
      parseDrainRecord(body({}, { container_id: containerId })),
    ).toBeNull();
  });

  test("rejects an unknown key at the top level", () => {
    expect(parseDrainRecord(body({ extra: 1 }))).toBeNull();
  });

  test("rejects an unknown key in an entry", () => {
    expect(parseDrainRecord(body({}, { extra: 1 }))).toBeNull();
  });

  test.each([
    "yesterday",
    "2026-10-18",
    "2026-10-18 01:02:03Z",
    "2026-10-18T01:02:03",
    "2026-10-18T01:02:03.1234567890Z",
    "2026-13-18T01:02:03Z",
  ])("rejects a started_at of %s", (startedAt) => {
    expect(parseDrainRecord(body({}, { started_at: startedAt }))).toBeNull();
  });

  test.each([
    "now",
    "2026-10-18",
    "2026-10-18T01:02:03",
    "2026-10-18T01:02:03+09:00",
  ])("rejects a signaled_at of %s", (signaledAt) => {
    expect(parseDrainRecord(body({}, { signaled_at: signaledAt }))).toBeNull();
  });

  test.each(["started_at", "signaled_at"])(
    "rejects a %s of a day that does not exist",
    (field) => {
      expect(
        parseDrainRecord(body({}, { [field]: "2026-02-30T00:00:00Z" })),
      ).toBeNull();
    },
  );

  test("accepts a started_at in the first year", () => {
    expect(
      parseDrainRecord(body({}, { started_at: "0001-01-01T00:00:00Z" })),
    ).not.toBeNull();
  });

  test("rejects entries that is an array", () => {
    expect(parseDrainRecord(body({ entries: [] }))).toBeNull();
  });

  test("rejects an entries object with a __proto__ key", () => {
    // JSON.stringifyでは作れないので、本文を直接書く。
    const text = `{"schema":1,"entries":{"__proto__":${JSON.stringify(ENTRY)}}}`;
    expect(parseDrainRecord(text)).toBeNull();
  });

  test.each([2, "1", null])("rejects a schema of %p", (schema) => {
    expect(parseDrainRecord(body({ schema }))).toBeNull();
  });

  test("rejects a body over 64 KiB", () => {
    const padded = `${body()}${" ".repeat(MAX_DRAIN_BYTES)}`;
    expect(parseDrainRecord(padded)).toBeNull();
  });

  test("rejects a body that is not JSON", () => {
    expect(parseDrainRecord("not json")).toBeNull();
  });

  test("reads an empty record", () => {
    expect(
      parseDrainRecord(JSON.stringify({ schema: 1, entries: {} })),
    ).toEqual({ schema: 1, entries: {} });
  });
});

describe("serializeDrainRecord", () => {
  test("can be read back as written", () => {
    expect(parseDrainRecord(serializeDrainRecord(RECORD))).toEqual(RECORD);
  });

  test("keeps a started_at with nanoseconds as it is", () => {
    const text = serializeDrainRecord(RECORD);
    expect(parseDrainRecord(text)?.entries.windmill_worker?.started_at).toBe(
      "2026-10-18T01:02:03.123456789Z",
    );
  });

  test("writes an empty record as an empty entries object", () => {
    expect(
      JSON.parse(serializeDrainRecord({ schema: 1, entries: {} })),
    ).toEqual({ schema: 1, entries: {} });
  });

  test("refuses a record whose container_id is malformed", () => {
    const broken: DrainRecord = {
      schema: 1,
      entries: {
        windmill_worker: {
          container_id: "short",
          started_at: ENTRY.started_at,
          signaled_at: ENTRY.signaled_at,
          writer: "executor",
        },
      },
    };
    expect(() => serializeDrainRecord(broken)).toThrow();
  });
});

describe("writeDrain", () => {
  test("keeps drain.json for an empty record", () => {
    const dir = privateDir();
    writeDrain(dir, { schema: 1, entries: {} }, uid);
    expect(existsSync(join(dir, "drain.json"))).toBe(true);
  });

  test("writes drain.json with mode 0600", () => {
    const dir = privateDir();
    writeDrain(dir, RECORD, uid);
    expect(statSync(join(dir, "drain.json")).mode & 0o777).toBe(0o600);
  });

  test("does not create a missing directory", () => {
    const dir = join(tempRoot(), "missing");
    expect(() => writeDrain(dir, RECORD, uid)).toThrow();
  });
});

describe("readDrain", () => {
  test("returns absent when there is no file", () => {
    expect(readDrain(privateDir(), uid)).toEqual({ kind: "absent" });
  });

  test("returns absent when there is no directory", () => {
    expect(readDrain(join(tempRoot(), "none"), uid)).toEqual({
      kind: "absent",
    });
  });

  test("reads back a written record", () => {
    const dir = privateDir();
    writeDrain(dir, RECORD, uid);
    expect(readDrain(dir, uid)).toEqual({ kind: "found", record: RECORD });
  });

  test("returns an empty record as found", () => {
    const dir = privateDir();
    writeDrain(dir, { schema: 1, entries: {} }, uid);
    expect(readDrain(dir, uid)).toEqual({
      kind: "found",
      record: { schema: 1, entries: {} },
    });
  });

  test("reads a started_at with nanoseconds back as it was written", () => {
    const dir = privateDir();
    writeDrain(dir, RECORD, uid);
    const result = readDrain(dir, uid);
    expect(
      result.kind === "found" &&
        result.record.entries.windmill_worker?.started_at,
    ).toBe("2026-10-18T01:02:03.123456789Z");
  });

  test("is invalid with the cause shape for a body of the wrong shape", () => {
    const dir = privateDir();
    writeFileSync(join(dir, "drain.json"), "{}", { mode: 0o600 });
    expect(readDrain(dir, uid)).toMatchObject({
      kind: "invalid",
      cause: "shape",
    });
  });

  test("is invalid with the cause unsafe for a file that others can read", () => {
    const dir = privateDir();
    writeFileSync(join(dir, "drain.json"), serializeDrainRecord(RECORD));
    chmodSync(join(dir, "drain.json"), 0o644);
    expect(readDrain(dir, uid)).toMatchObject({
      kind: "invalid",
      cause: "unsafe",
    });
  });

  test("is invalid with the cause unsafe for a file that is a symlink", () => {
    const dir = privateDir();
    const target = join(tempRoot(), "real.json");
    writeFileSync(target, serializeDrainRecord(RECORD), { mode: 0o600 });
    symlinkSync(target, join(dir, "drain.json"));
    expect(readDrain(dir, uid)).toMatchObject({
      kind: "invalid",
      cause: "unsafe",
    });
  });
});
