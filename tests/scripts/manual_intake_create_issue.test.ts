import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SqlRow } from "../../f/factory/lib/db.ts";
import {
  computeIntakeContentHash,
  intakeMarkerText,
} from "../../f/factory/lib/manual_intake_support.ts";
import {
  buildManualIntakeIssueBody,
  type CreatedIssue,
  createManualIntakeIssue,
  type IntakeKeyRow,
  type IntakeKeyStore,
  type ManualIntakeIssueDeps,
  sqlIntakeKeyStore,
} from "../../f/factory/steps/manual_intake_create_issue.ts";

// `isRepoAllowed`は`f/factory/lib/config.ts`にあり、
// テストは`tests/lib/config.test.ts`にある。

describe("buildManualIntakeIssueBody", () => {
  test("renders the 目的 section from body", () => {
    const rendered = buildManualIntakeIssueBody({
      body: "Add a widget.",
      acceptance_criteria: "It renders.",
    });
    expect(rendered).toContain("### 目的\n\nAdd a widget.");
  });

  test("renders the 受入基準 section from acceptance_criteria", () => {
    const rendered = buildManualIntakeIssueBody({
      body: "Add a widget.",
      acceptance_criteria: "It renders.",
    });
    expect(rendered).toContain("### 受入基準\n\nIt renders.");
  });

  test("renders _No response_ for a blank acceptance_criteria", () => {
    const rendered = buildManualIntakeIssueBody({
      body: "Add a widget.",
      acceptance_criteria: "   ",
    });
    expect(rendered).toContain("### 受入基準\n\n_No response_");
  });

  test("renders _No response_ for a blank body", () => {
    const rendered = buildManualIntakeIssueBody({
      body: "",
      acceptance_criteria: "It renders.",
    });
    expect(rendered).toContain("### 目的\n\n_No response_");
  });
});

describe("the entry point of the issue creation", () => {
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
    readFileSync(
      join(
        import.meta.dir,
        "../../f/factory/steps/manual_intake_create_issue.ts",
      ),
      "utf8",
    ),
  );

  test("takes the profile and defaults it to standard", () => {
    expect(code).toMatch(/\bprofile = "standard"/);
  });

  test("refuses a profile that is not accepted before it creates the issue", () => {
    expect(code.slice(0, code.indexOf("await createIssue("))).toContain(
      "assertAcceptedProfile(profile)",
    );
  });

  test("treats an empty intake key as no key before it checks the key", () => {
    const entry = code.slice(code.indexOf("async function main("));
    expect(entry.slice(0, entry.indexOf("assertIntakeKey(key)"))).toContain(
      "normalizeIntakeKey(intake_key)",
    );
  });

  test("refuses a profile that is not accepted before it reads the token", () => {
    expect(code.slice(0, code.indexOf("github_token"))).toContain(
      "assertAcceptedProfile(profile)",
    );
  });
});

const INTAKE_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ME = "0190aaaa-0000-7000-8000-000000000001";
const OTHER = "0190bbbb-0000-7000-8000-000000000002";
const NOW = new Date("2026-10-31T03:00:00.000Z");
const TEN_MINUTES_AGO = new Date("2026-10-31T02:50:00.000Z");

const INPUT = {
  owner: "octo-owner",
  repo: "widgets",
  title: "Add a widget",
  body: "Add a widget to the page.",
  acceptance_criteria: "It renders.",
  profile: "standard",
};
const HASH = computeIntakeContentHash(INPUT);

/** 表の1行の意味(予約、取り直し、番号の書き込み)を、メモリの上で再現する偽の表。 */
type FakeStore = {
  -readonly [K in keyof IntakeKeyStore]: IntakeKeyStore[K];
} & {
  row: IntakeKeyRow | null;
  /** 取り直しが通る古さの予約か。 */
  stale: boolean;
  readonly calls: string[];
};

function fakeStore(row: IntakeKeyRow | null = null, stale = false): FakeStore {
  const store: FakeStore = {
    row,
    stale,
    calls: [],
    reserve: (reservation) => {
      store.calls.push("reserve");
      if (store.row !== null) return Promise.resolve(false);
      store.row = {
        intake_key: reservation.intake_key,
        content_hash: reservation.content_hash,
        owner: reservation.owner,
        repo: reservation.repo,
        issue_number: null,
        holder: reservation.holder,
        reserved_at: NOW,
      };
      return Promise.resolve(true);
    },
    read: () => {
      store.calls.push("read");
      return Promise.resolve(store.row);
    },
    takeOver: (_key, holder) => {
      store.calls.push("takeOver");
      if (
        store.row === null ||
        store.row.issue_number !== null ||
        !store.stale
      ) {
        return Promise.resolve(false);
      }
      store.row = { ...store.row, holder, reserved_at: NOW };
      return Promise.resolve(true);
    },
    recordIssue: (_key, holder, issueNumber) => {
      store.calls.push("recordIssue");
      if (store.row === null || store.row.holder !== holder) {
        return Promise.resolve(false);
      }
      store.row = { ...store.row, issue_number: issueNumber };
      return Promise.resolve(true);
    },
  };
  return store;
}

function keyRow(change: Partial<IntakeKeyRow> = {}): IntakeKeyRow {
  return {
    intake_key: INTAKE_ID,
    content_hash: HASH,
    owner: "octo-owner",
    repo: "widgets",
    issue_number: null,
    holder: OTHER,
    reserved_at: TEN_MINUTES_AGO,
    ...change,
  };
}

type Harness = {
  readonly deps: ManualIntakeIssueDeps;
  readonly store: FakeStore;
  readonly created: { title: string; body: string }[];
  readonly searched: { markerText: string; since: Date }[];
  readonly warnings: string[];
  readonly events: string[];
};

function harness(
  options: {
    row?: IntakeKeyRow | null;
    stale?: boolean;
    existing?: CreatedIssue | null;
    createFails?: boolean;
  } = {},
): Harness {
  const store = fakeStore(options.row ?? null, options.stale ?? false);
  const created: { title: string; body: string }[] = [];
  const searched: { markerText: string; since: Date }[] = [];
  const warnings: string[] = [];
  const events: string[] = [];
  const deps: ManualIntakeIssueDeps = {
    store,
    holder: ME,
    now: () => NOW,
    findIssue: (markerText, since) => {
      events.push("find");
      searched.push({ markerText, since });
      return Promise.resolve(options.existing ?? null);
    },
    createIssue: (title, body) => {
      events.push("create");
      created.push({ title, body });
      return options.createFails === true
        ? Promise.reject(new Error("github is down"))
        : Promise.resolve({
            number: 41,
            htmlUrl: "https://github.com/octo-owner/widgets/issues/41",
          });
    },
    log: {
      warn: (message) => {
        warnings.push(message);
      },
    },
  };
  return { deps, store, created, searched, warnings, events };
}

describe("an input without an intake key", () => {
  test("creates the issue without a marker", async () => {
    const { deps, created } = harness();
    await createManualIntakeIssue(INPUT, deps);
    expect(created.map((issue) => issue.body)).toEqual([
      buildManualIntakeIssueBody(INPUT),
    ]);
  });

  test("does not touch the table", async () => {
    const { deps, store } = harness();
    await createManualIntakeIssue(INPUT, deps);
    expect(store.calls).toEqual([]);
  });

  test("does not search for an existing issue", async () => {
    const { deps, searched } = harness();
    await createManualIntakeIssue(INPUT, deps);
    expect(searched).toEqual([]);
  });

  test("is not a reuse", async () => {
    const { deps } = harness();
    expect((await createManualIntakeIssue(INPUT, deps)).reused).toBe(false);
  });

  test("returns the issue it created", async () => {
    const { deps } = harness();
    expect(await createManualIntakeIssue(INPUT, deps)).toEqual({
      owner: "octo-owner",
      repo: "widgets",
      number: 41,
      htmlUrl: "https://github.com/octo-owner/widgets/issues/41",
      title: "Add a widget",
      body: buildManualIntakeIssueBody(INPUT),
      reused: false,
    });
  });
});

describe("the first input with an intake key", () => {
  const KEYED = { ...INPUT, intake_key: INTAKE_ID };

  test("reserves the key before it creates the issue", async () => {
    const { deps, store, events } = harness();
    store.calls.length = 0;
    await createManualIntakeIssue(KEYED, deps);
    expect([store.calls[0], events.includes("create")]).toEqual([
      "reserve",
      true,
    ]);
  });

  test("reserves it for this job with the hash of the content", async () => {
    const { deps, store } = harness();
    await createManualIntakeIssue(KEYED, deps);
    expect(store.row).toMatchObject({
      intake_key: INTAKE_ID,
      content_hash: HASH,
      holder: ME,
      owner: "octo-owner",
      repo: "widgets",
    });
  });

  test("searches for the marker before it creates the issue", async () => {
    const { deps, events } = harness();
    await createManualIntakeIssue(KEYED, deps);
    expect(events).toEqual(["find", "create"]);
  });

  test("searches for the marker line of the key", async () => {
    const { deps, searched } = harness();
    await createManualIntakeIssue(KEYED, deps);
    expect(searched[0]?.markerText).toBe(intakeMarkerText(INTAKE_ID));
  });

  test("searches from the time it reserved the key", async () => {
    const { deps, searched } = harness();
    await createManualIntakeIssue(KEYED, deps);
    expect(searched[0]?.since).toEqual(NOW);
  });

  test("ends the issue body on the marker line", async () => {
    const { deps, created } = harness();
    await createManualIntakeIssue(KEYED, deps);
    expect(created[0]?.body).toBe(
      `${buildManualIntakeIssueBody(INPUT)}\n\n<!-- factory:intake:${INTAKE_ID} -->`,
    );
  });

  test("records the number of the issue for this job", async () => {
    const { deps, store } = harness();
    await createManualIntakeIssue(KEYED, deps);
    expect(store.row?.issue_number).toBe(41);
  });

  test("is not a reuse", async () => {
    const { deps } = harness();
    expect((await createManualIntakeIssue(KEYED, deps)).reused).toBe(false);
  });

  test("returns the body without the marker", async () => {
    const { deps } = harness();
    expect((await createManualIntakeIssue(KEYED, deps)).body).toBe(
      buildManualIntakeIssueBody(INPUT),
    );
  });

  test("returns the number even when it could not record it", async () => {
    const { deps, store } = harness();
    store.recordIssue = () => Promise.resolve(false);
    expect((await createManualIntakeIssue(KEYED, deps)).number).toBe(41);
  });

  test("warns when it could not record the number", async () => {
    const { deps, store, warnings } = harness();
    store.recordIssue = () => Promise.resolve(false);
    await createManualIntakeIssue(KEYED, deps);
    expect(warnings).toHaveLength(1);
  });
});

describe("a resend of an input that already created its issue", () => {
  const KEYED = { ...INPUT, intake_key: INTAKE_ID };
  const DONE = keyRow({ issue_number: 17, holder: OTHER });

  test("does not create an issue", async () => {
    const { deps, created } = harness({ row: DONE });
    await createManualIntakeIssue(KEYED, deps);
    expect(created).toEqual([]);
  });

  test("does not search for an issue", async () => {
    const { deps, searched } = harness({ row: DONE });
    await createManualIntakeIssue(KEYED, deps);
    expect(searched).toEqual([]);
  });

  test("returns the first issue as a reuse", async () => {
    const { deps } = harness({ row: DONE });
    expect(await createManualIntakeIssue(KEYED, deps)).toMatchObject({
      owner: "octo-owner",
      repo: "widgets",
      number: 17,
      reused: true,
    });
  });

  test("takes the repository from the row", async () => {
    const { deps } = harness({
      row: keyRow({ issue_number: 17, owner: "row-owner", repo: "row-repo" }),
    });
    expect(await createManualIntakeIssue(KEYED, deps)).toMatchObject({
      owner: "row-owner",
      repo: "row-repo",
    });
  });

  test.each([
    ["owner", { owner: "bad owner" }],
    ["repo", { repo: "a/b" }],
    ["owner that is empty", { owner: "" }],
  ])(
    "throws when the %s of the row is not a GitHub name",
    async (_name, change) => {
      const { deps } = harness({
        row: keyRow({ issue_number: 17, ...change }),
      });
      await expect(createManualIntakeIssue(KEYED, deps)).rejects.toThrow(
        "manual_intake: the stored intake key is damaged",
      );
    },
  );

  test("does not take the reservation over", async () => {
    const { deps, store } = harness({ row: DONE, stale: true });
    await createManualIntakeIssue(KEYED, deps);
    expect(store.calls).toEqual(["reserve", "read"]);
  });
});

describe("a resend of a different input", () => {
  const KEYED = { ...INPUT, intake_key: INTAKE_ID, title: "Add a gadget" };

  test("throws intake_key_conflict", async () => {
    const { deps } = harness({ row: keyRow({ issue_number: 17 }) });
    await expect(createManualIntakeIssue(KEYED, deps)).rejects.toThrow(
      "intake_key_conflict",
    );
  });

  test("creates no issue", async () => {
    const { deps, created } = harness({ row: keyRow({ issue_number: 17 }) });
    await createManualIntakeIssue(KEYED, deps).catch(() => undefined);
    expect(created).toEqual([]);
  });

  test("throws the conflict even while the reservation is in flight", async () => {
    const { deps } = harness({ row: keyRow() });
    await expect(createManualIntakeIssue(KEYED, deps)).rejects.toThrow(
      "intake_key_conflict",
    );
  });

  test("does not take the reservation over", async () => {
    const { deps, store } = harness({ row: keyRow(), stale: true });
    await createManualIntakeIssue(KEYED, deps).catch(() => undefined);
    expect(store.calls).not.toContain("takeOver");
  });

  test("keeps the input out of the message", async () => {
    const { deps } = harness({ row: keyRow({ issue_number: 17 }) });
    const error = await createManualIntakeIssue(KEYED, deps).catch(
      (caught: unknown) => caught,
    );
    expect(String(error)).not.toMatch(/gadget|0190a1b2/);
  });
});

describe("a resend while the first input is still creating its issue", () => {
  const KEYED = { ...INPUT, intake_key: INTAKE_ID };

  test("throws intake_key_in_flight", async () => {
    const { deps } = harness({ row: keyRow() });
    await expect(createManualIntakeIssue(KEYED, deps)).rejects.toThrow(
      "intake_key_in_flight",
    );
  });

  test("creates no issue", async () => {
    const { deps, created } = harness({ row: keyRow() });
    await createManualIntakeIssue(KEYED, deps).catch(() => undefined);
    expect(created).toEqual([]);
  });

  test("searches for no issue", async () => {
    const { deps, searched } = harness({ row: keyRow() });
    await createManualIntakeIssue(KEYED, deps).catch(() => undefined);
    expect(searched).toEqual([]);
  });

  test("keeps the key out of the message", async () => {
    const { deps } = harness({ row: keyRow() });
    const error = await createManualIntakeIssue(KEYED, deps).catch(
      (caught: unknown) => caught,
    );
    expect(String(error)).not.toContain(INTAKE_ID);
  });

  test("throws intake_key_in_flight when another job takes the reservation first", async () => {
    const { deps, store } = harness({ row: keyRow(), stale: true });
    store.takeOver = () => Promise.resolve(false);
    await expect(createManualIntakeIssue(KEYED, deps)).rejects.toThrow(
      "intake_key_in_flight",
    );
  });

  test("throws intake_key_in_flight when the row vanished after the conflict", async () => {
    const { deps, store } = harness();
    store.reserve = () => Promise.resolve(false);
    await expect(createManualIntakeIssue(KEYED, deps)).rejects.toThrow(
      "intake_key_in_flight",
    );
  });
});

describe("a resend after an old reservation", () => {
  const KEYED = { ...INPUT, intake_key: INTAKE_ID };

  test("takes the reservation over for this job", async () => {
    const { deps, store } = harness({ row: keyRow(), stale: true });
    await createManualIntakeIssue(KEYED, deps);
    expect(store.row?.holder).toBe(ME);
  });

  test("creates the issue", async () => {
    const { deps, created } = harness({ row: keyRow(), stale: true });
    await createManualIntakeIssue(KEYED, deps);
    expect(created).toHaveLength(1);
  });

  test("records the number of the issue", async () => {
    const { deps, store } = harness({ row: keyRow(), stale: true });
    await createManualIntakeIssue(KEYED, deps);
    expect(store.row?.issue_number).toBe(41);
  });

  test("searches from the time of the old reservation", async () => {
    const { deps, searched } = harness({ row: keyRow(), stale: true });
    await createManualIntakeIssue(KEYED, deps);
    expect(searched[0]?.since).toEqual(TEN_MINUTES_AGO);
  });

  test("uses the issue that the marker finds instead of creating one", async () => {
    const { deps, created } = harness({
      row: keyRow(),
      stale: true,
      existing: { number: 33, htmlUrl: "https://github.com/o/r/issues/33" },
    });
    await createManualIntakeIssue(KEYED, deps);
    expect(created).toEqual([]);
  });

  test("records the number that the marker finds", async () => {
    const { deps, store } = harness({
      row: keyRow(),
      stale: true,
      existing: { number: 33, htmlUrl: "https://github.com/o/r/issues/33" },
    });
    await createManualIntakeIssue(KEYED, deps);
    expect(store.row?.issue_number).toBe(33);
  });

  test("registers the issue that the marker finds", async () => {
    const { deps } = harness({
      row: keyRow(),
      stale: true,
      existing: { number: 33, htmlUrl: "https://github.com/o/r/issues/33" },
    });
    expect(await createManualIntakeIssue(KEYED, deps)).toMatchObject({
      number: 33,
      htmlUrl: "https://github.com/o/r/issues/33",
      reused: false,
    });
  });
});

describe("a failure to create the issue", () => {
  const KEYED = { ...INPUT, intake_key: INTAKE_ID };

  test("throws the failure", async () => {
    const { deps } = harness({ createFails: true });
    await expect(createManualIntakeIssue(KEYED, deps)).rejects.toThrow(
      "github is down",
    );
  });

  test("keeps the reservation", async () => {
    const { deps, store } = harness({ createFails: true });
    await createManualIntakeIssue(KEYED, deps).catch(() => undefined);
    expect(store.row).toMatchObject({
      intake_key: INTAKE_ID,
      issue_number: null,
    });
  });

  test("records no number", async () => {
    const { deps, store } = harness({ createFails: true });
    await createManualIntakeIssue(KEYED, deps).catch(() => undefined);
    expect(store.calls).not.toContain("recordIssue");
  });
});

describe("a key that is not a lower case uuid", () => {
  test("throws before it touches the table", async () => {
    const { deps, store } = harness();
    await createManualIntakeIssue(
      { ...INPUT, intake_key: INTAKE_ID.toUpperCase() },
      deps,
    ).catch(() => undefined);
    expect(store.calls).toEqual([]);
  });

  test("throws a fixed message", async () => {
    const { deps } = harness();
    await expect(
      createManualIntakeIssue({ ...INPUT, intake_key: "secret-key" }, deps),
    ).rejects.toThrow("manual_intake: the intake key is not accepted");
  });
});

describe("the statements of the intake key table", () => {
  type Call = { text: string; values: unknown[] };

  function recordingSql(rows: SqlRow[] = []): {
    sql: Parameters<typeof sqlIntakeKeyStore>[0];
    calls: Call[];
  } {
    const calls: Call[] = [];
    return {
      calls,
      sql: (strings, ...values) => {
        calls.push({ text: strings.join(" ? "), values });
        return {
          fetch: () => Promise.resolve(rows),
          execute: () => Promise.resolve(),
        };
      },
    };
  }

  const RESERVATION = {
    intake_key: INTAKE_ID,
    content_hash: HASH,
    owner: "octo-owner",
    repo: "widgets",
    holder: ME,
  };

  test("reserves with an insert that does nothing on a conflict", async () => {
    const { sql, calls } = recordingSql([{ intake_key: INTAKE_ID }]);
    await sqlIntakeKeyStore(sql).reserve(RESERVATION);
    expect(calls[0]?.text).toMatch(
      /INSERT INTO factory\.manual_intake_keys[\s\S]*ON CONFLICT \(intake_key\) DO NOTHING[\s\S]*RETURNING/,
    );
  });

  test("binds the reservation as parameters", async () => {
    const { sql, calls } = recordingSql([{ intake_key: INTAKE_ID }]);
    await sqlIntakeKeyStore(sql).reserve(RESERVATION);
    expect(calls[0]?.values).toEqual([
      INTAKE_ID,
      HASH,
      "octo-owner",
      "widgets",
      ME,
    ]);
  });

  test("tells a reservation that went in from one that did not", async () => {
    const { sql } = recordingSql([]);
    expect(await sqlIntakeKeyStore(sql).reserve(RESERVATION)).toBe(false);
  });

  test("takes over with one statement", async () => {
    const { sql, calls } = recordingSql([{ intake_key: INTAKE_ID }]);
    await sqlIntakeKeyStore(sql).takeOver(INTAKE_ID, ME);
    expect(calls).toHaveLength(1);
  });

  test("takes over only an old reservation that has no number", async () => {
    const { sql, calls } = recordingSql([{ intake_key: INTAKE_ID }]);
    await sqlIntakeKeyStore(sql).takeOver(INTAKE_ID, ME);
    expect(calls[0]?.text).toMatch(
      /UPDATE factory\.manual_intake_keys[\s\S]*SET holder =\s+\?\s+, reserved_at = now\(\)[\s\S]*WHERE intake_key =\s+\?[\s\S]*AND issue_number IS NULL[\s\S]*AND reserved_at < now\(\) - interval '10 minutes'[\s\S]*RETURNING/,
    );
  });

  test("binds the holder and the key when it takes over", async () => {
    const { sql, calls } = recordingSql([{ intake_key: INTAKE_ID }]);
    await sqlIntakeKeyStore(sql).takeOver(INTAKE_ID, ME);
    expect(calls[0]?.values).toEqual([ME, INTAKE_ID]);
  });

  test("tells a takeover that won from one that lost", async () => {
    const { sql } = recordingSql([]);
    expect(await sqlIntakeKeyStore(sql).takeOver(INTAKE_ID, ME)).toBe(false);
  });

  test("writes the number only where the holder is this job", async () => {
    const { sql, calls } = recordingSql([{ intake_key: INTAKE_ID }]);
    await sqlIntakeKeyStore(sql).recordIssue(INTAKE_ID, ME, 41);
    expect(calls[0]?.text).toMatch(
      /UPDATE factory\.manual_intake_keys[\s\S]*SET issue_number =\s+\?\s+::integer[\s\S]*WHERE intake_key =\s+\?[\s\S]*AND holder =\s+\?[\s\S]*RETURNING/,
    );
  });

  test("binds the number, the key, and the holder when it writes the number", async () => {
    const { sql, calls } = recordingSql([{ intake_key: INTAKE_ID }]);
    await sqlIntakeKeyStore(sql).recordIssue(INTAKE_ID, ME, 41);
    expect(calls[0]?.values).toEqual([41, INTAKE_ID, ME]);
  });

  test("tells a write that landed from one that did not", async () => {
    const { sql } = recordingSql([]);
    expect(await sqlIntakeKeyStore(sql).recordIssue(INTAKE_ID, ME, 41)).toBe(
      false,
    );
  });

  test("reads the row of the key", async () => {
    const { sql, calls } = recordingSql([]);
    await sqlIntakeKeyStore(sql).read(INTAKE_ID);
    expect(calls[0]?.text).toMatch(
      /FROM factory\.manual_intake_keys\s+WHERE intake_key =\s+\?/,
    );
  });

  test("returns no row when the key is not in the table", async () => {
    const { sql } = recordingSql([]);
    expect(await sqlIntakeKeyStore(sql).read(INTAKE_ID)).toBeNull();
  });

  test("reads the columns of the row", async () => {
    const { sql } = recordingSql([
      {
        intake_key: INTAKE_ID,
        content_hash: HASH,
        owner: "octo-owner",
        repo: "widgets",
        issue_number: null,
        holder: ME,
        reserved_at: "2026-10-31T02:50:00.000Z",
      },
    ]);
    expect(await sqlIntakeKeyStore(sql).read(INTAKE_ID)).toEqual(
      keyRow({ holder: ME, issue_number: null }),
    );
  });

  test("reads an issue number that arrives as a numeric string", async () => {
    const { sql } = recordingSql([
      {
        intake_key: INTAKE_ID,
        content_hash: HASH,
        owner: "octo-owner",
        repo: "widgets",
        issue_number: "17",
        holder: ME,
        reserved_at: "2026-10-31T02:50:00.000Z",
      },
    ]);
    expect((await sqlIntakeKeyStore(sql).read(INTAKE_ID))?.issue_number).toBe(
      17,
    );
  });
});

describe("the SQL of the intake key", () => {
  const code = readFileSync(
    join(import.meta.dir, "../../f/factory/lib/db.ts"),
    "utf8",
  );
  const start = code.indexOf("export function sqlIntakeKeyStore(");
  // 関数の本体は、行頭の閉じ括弧で終わる。
  const store = code.slice(start, code.indexOf("\n}\n", start));

  test("is found in the store function", () => {
    expect(store).toContain("factory.manual_intake_keys");
  });

  test("builds no statement by joining strings", () => {
    expect(store).not.toMatch(/sql\(|sql\.unsafe|\.query\(/);
  });
});
