import { describe, expect, test } from "bun:test";
import type { SqlClient } from "../../f/factory/lib/db.ts";
import { recordViewerObservation } from "../../f/factory/lib/drawio_viewer_observations.ts";

type SqlRow = Record<string, unknown>;
type FakeCall = { text: string; values: unknown[]; kind: "fetch" | "execute" };

const COMMIT = "9034053fba80a435e27d68d374bc564b83917ae9";

/** 呼び出しごとに用意した行を順に返す偽の`SqlClient`。 */
function createFakeSqlClient(responses: SqlRow[][]): {
  sql: SqlClient;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  let index = 0;
  const sql: SqlClient = (strings, ...values) => {
    const text = strings.join(" ? ");
    const rows = responses[index] ?? [];
    index += 1;
    return {
      fetch: () => {
        calls.push({ text, values, kind: "fetch" });
        return Promise.resolve(rows);
      },
      execute: () => {
        calls.push({ text, values, kind: "execute" });
        return Promise.resolve();
      },
    };
  };
  return { sql, calls };
}

describe("recordViewerObservation", () => {
  test("returns the first-seen time of the commit", async () => {
    const { sql } = createFakeSqlClient([
      [],
      [{ first_seen_at: new Date("2026-10-01T00:00:00.000Z") }],
    ]);
    const seen = await recordViewerObservation("v32.5.0", COMMIT, sql);
    expect(seen.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  test("reads a timestamp that comes back as a string", async () => {
    const { sql } = createFakeSqlClient([
      [],
      [{ first_seen_at: "2026-10-01T00:00:00.000Z" }],
    ]);
    const seen = await recordViewerObservation("v32.5.0", COMMIT, sql);
    expect(seen.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  test("restarts the clock only when the commit changed", async () => {
    const { sql, calls } = createFakeSqlClient([
      [],
      [{ first_seen_at: new Date() }],
    ]);
    await recordViewerObservation("v32.5.0", COMMIT, sql);
    expect(calls[0]?.text).toContain(
      "WHERE o.commit_sha <> EXCLUDED.commit_sha",
    );
  });

  test("upserts by tag", async () => {
    const { sql, calls } = createFakeSqlClient([
      [],
      [{ first_seen_at: new Date() }],
    ]);
    await recordViewerObservation("v32.5.0", COMMIT, sql);
    expect(calls[0]?.text).toContain("ON CONFLICT (tag)");
  });

  test("passes the tag and the commit to the upsert", async () => {
    const { sql, calls } = createFakeSqlClient([
      [],
      [{ first_seen_at: new Date() }],
    ]);
    await recordViewerObservation("v32.5.0", COMMIT, sql);
    expect(calls[0]?.values).toEqual(["v32.5.0", COMMIT]);
  });

  test("reads back only the row of the same commit", async () => {
    const { sql, calls } = createFakeSqlClient([
      [],
      [{ first_seen_at: new Date() }],
    ]);
    await recordViewerObservation("v32.5.0", COMMIT, sql);
    expect(calls[1]?.text).toContain("AND commit_sha =");
  });

  test("throws when no row can be read back", async () => {
    const { sql } = createFakeSqlClient([[], []]);
    await expect(
      recordViewerObservation("v32.5.0", COMMIT, sql),
    ).rejects.toThrow("no observation was recorded");
  });

  test("throws for a value that is not a timestamp", async () => {
    const { sql } = createFakeSqlClient([[], [{ first_seen_at: "soon" }]]);
    await expect(
      recordViewerObservation("v32.5.0", COMMIT, sql),
    ).rejects.toThrow("not a timestamp");
  });
});
