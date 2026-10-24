import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { HoldsSnapshot } from "../../api/guards/holds.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import { HoldsPanel } from "./HoldsPanel.tsx";

const NOW = Date.parse("2026-10-24T03:00:00.000Z");
const T0 = "2026-10-24T02:00:00.000Z";
const T1 = "2026-10-24T04:00:00.000Z";

const HOLD = {
  id: 7,
  scope: "merge",
  target: "octo/repo",
  reason: "wait for the release",
  holder_kind: "session",
  holder: "session:feat/x",
  created_at: T0,
  expires_at: T1,
};

const SCHEDULE = {
  id: "0a1b2c3d",
  target: "f/factory/poll_issues",
  reason: "verify the schedule",
  holder_kind: "human",
  holder: "human",
  created_at: T0,
  expires_at: T1,
};

const DEPLOY = {
  id: "1b2c3d4e",
  reason: "migration window",
  holder_kind: "human",
  holder: "human",
  created_at: T0,
  expires_at: T1,
};

const EMPTY: HoldsSnapshot = {
  holds: { ok: true, rows: [] },
  freezes: { ok: true, schedule: [], deploy: [] },
};

const FULL: HoldsSnapshot = {
  holds: { ok: true, rows: [HOLD] },
  freezes: { ok: true, schedule: [SCHEDULE], deploy: [DEPLOY] },
};

function render(
  data: HoldsSnapshot,
  options: { locked?: readonly string[]; now?: number } = {},
): string {
  const locked = options.locked ?? [];
  return renderToStaticMarkup(
    <TooltipProvider>
      <HoldsPanel
        data={data}
        now={options.now ?? NOW}
        isLocked={(target) =>
          locked.includes(`${target.kind}:${String(target.id)}`)
        }
        onRequestRelease={() => undefined}
        onRetry={() => undefined}
        isFetching={false}
      />
    </TooltipProvider>,
  );
}

function withHold(overrides: Record<string, unknown>): HoldsSnapshot {
  return {
    ...EMPTY,
    holds: { ok: true, rows: [{ ...HOLD, ...overrides }] },
  };
}

describe("HoldsPanel when nothing is active", () => {
  test("says that no hold is active", () => {
    expect(render(EMPTY)).toContain("有効な保留はありません");
  });

  test("says that no freeze or deploy hold is active", () => {
    expect(render(EMPTY)).toContain("有効な凍結とdeployの保留はありません");
  });

  test("tells how to place a hold", () => {
    expect(render(EMPTY)).toContain("mise run hold:place");
  });
});

describe("HoldsPanel rows", () => {
  test("shows the reason of a hold", () => {
    expect(render(FULL)).toContain("wait for the release");
  });

  test("shows the target of a hold", () => {
    expect(render(FULL)).toContain("octo/repo");
  });

  test("labels a merge hold", () => {
    expect(render(FULL)).toContain("マージの保留");
  });

  test("shows who placed a hold", () => {
    expect(render(FULL)).toContain("session:feat/x");
  });

  test("shows the time left", () => {
    expect(render(FULL)).toContain("残り1時間");
  });

  test("shows the schedule that a freeze keeps", () => {
    expect(render(FULL)).toContain("f/factory/poll_issues");
  });

  test("shows the reason of a deploy freeze", () => {
    expect(render(FULL)).toContain("migration window");
  });

  test("names the whole deployment as the target of a deploy freeze", () => {
    expect(render(FULL)).toContain("反映全体");
  });

  test("notes that a claim hold stops nothing", () => {
    expect(
      render(withHold({ scope: "claim", target: "octo/repo#1" })),
    ).toContain("何も止めていません");
  });
});

describe("HoldsPanel release buttons", () => {
  test.each(["hold:7", "freeze:0a1b2c3d", "freeze:1b2c3d4e"])(
    "offers a release button for %s",
    (key) => {
      expect(render(FULL)).toContain(`data-release="${key}"`);
    },
  );

  test("offers no button for a hold that expired on the screen clock", () => {
    const later = Date.parse("2026-10-24T04:00:01.000Z");
    expect(render(FULL, { now: later })).not.toContain('data-release="hold:7"');
  });

  test("says that the hold expired instead", () => {
    const later = Date.parse("2026-10-24T04:00:01.000Z");
    expect(render(FULL, { now: later })).toContain("期限切れ");
  });

  test("shows the time of an expired hold, not a countdown that repeats the word", () => {
    const later = Date.parse("2026-10-24T04:00:01.000Z");
    expect(render(FULL, { now: later })).not.toContain(">期限切れ</time>");
  });

  test("disables the button of a row that is being released", () => {
    expect(render(FULL, { locked: ["hold:7"] })).toMatch(
      /<button(?=[^>]*data-release="hold:7")(?=[^>]*\sdisabled="")[^>]*>/,
    );
  });

  test("says that the row is being released", () => {
    expect(render(FULL, { locked: ["hold:7"] })).toContain("解除中");
  });

  test("leaves the other rows enabled", () => {
    expect(render(FULL, { locked: ["hold:7"] })).not.toMatch(
      /<button(?=[^>]*data-release="freeze:0a1b2c3d")(?=[^>]*\sdisabled="")[^>]*>/,
    );
  });
});

describe("HoldsPanel when the holds cannot be read", () => {
  const MISSING: HoldsSnapshot = {
    ...FULL,
    holds: { ok: false, kind: "missing_table", reason: "no table" },
  };

  test("says that the table is missing", () => {
    expect(render(MISSING)).toContain("保留の表がありません");
  });

  test("does not say that no hold is active", () => {
    expect(render(MISSING)).not.toContain("有効な保留はありません");
  });

  test("says that merges stop meanwhile", () => {
    expect(render(MISSING)).toContain("止まります");
  });

  test("says that an unreadable table could not be read", () => {
    expect(
      render({
        ...FULL,
        holds: { ok: false, kind: "read_failed", reason: "down" },
      }),
    ).toContain("保留を読めませんでした");
  });

  test("does not say that no hold is active for an unreadable table", () => {
    expect(
      render({
        ...FULL,
        holds: { ok: false, kind: "read_failed", reason: "down" },
      }),
    ).not.toContain("有効な保留はありません");
  });

  test("offers another try for an unreadable table", () => {
    expect(
      render({
        ...FULL,
        holds: { ok: false, kind: "read_failed", reason: "down" },
      }),
    ).toContain("もう一度取得する");
  });

  const CORRUPT: HoldsSnapshot = {
    ...FULL,
    holds: {
      ok: false,
      kind: "corrupt",
      reason: "inspect it with psql, then release the row",
    },
  };

  test("says that a corrupt table cannot be listed", () => {
    expect(render(CORRUPT)).toContain("壊れた行があるため、一覧を出せません");
  });

  test("shows the recovery steps in the reason", () => {
    expect(render(CORRUPT)).toContain("inspect it with psql");
  });

  test("opens the reason of a corrupt table", () => {
    expect(render(CORRUPT)).toContain("<details open");
  });

  test("points at the list command for a corrupt table", () => {
    expect(render(CORRUPT)).toContain("mise run hold:list");
  });

  test("offers no release button and no retry for a corrupt table", () => {
    expect(render(CORRUPT)).not.toContain('data-release="hold:7"');
  });

  test("does not say that no hold is active for a corrupt table", () => {
    expect(render(CORRUPT)).not.toContain("有効な保留はありません");
  });

  test("shows an unknown failure kind as an unreadable table", () => {
    expect(
      render({
        ...FULL,
        holds: { ok: false, kind: "timeout", reason: "slow" },
      }),
    ).toContain("保留を読めませんでした");
  });

  test("still shows the freezes", () => {
    expect(render(MISSING)).toContain("verify the schedule");
  });
});

describe("HoldsPanel when the freezes cannot be read", () => {
  const BROKEN: HoldsSnapshot = {
    ...FULL,
    freezes: { ok: false, reason: "the variable is corrupt; run freeze:reset" },
  };

  test("says that they cannot be read", () => {
    expect(render(BROKEN)).toContain("凍結とdeployの保留を読めません");
  });

  test("shows the recovery steps in the reason", () => {
    expect(render(BROKEN)).toContain("run freeze:reset");
  });

  test("does not say that no freeze is active", () => {
    expect(render(BROKEN)).not.toContain(
      "有効な凍結とdeployの保留はありません",
    );
  });

  test("still shows the holds", () => {
    expect(render(BROKEN)).toContain("wait for the release");
  });
});

describe("HoldsPanel untrusted text", () => {
  const MARKUP = '<a href="https://evil.example">x</a><img src=x>';

  test("escapes markup in the reason", () => {
    expect(render(withHold({ reason: MARKUP }))).toContain(
      "&lt;a href=&quot;https://evil.example&quot;&gt;x&lt;/a&gt;&lt;img src=x&gt;",
    );
  });

  test("does not turn the reason into a link", () => {
    expect(render(withHold({ reason: MARKUP }))).not.toContain("<a ");
  });

  test("does not turn the reason into an image", () => {
    expect(render(withHold({ reason: MARKUP }))).not.toContain("<img");
  });

  test("does not turn a URL in the reason into a link", () => {
    expect(
      render(withHold({ reason: "see https://evil.example/x" })),
    ).not.toContain("<a ");
  });

  test("replaces a bidirectional control character", () => {
    expect(render(withHold({ reason: "a‮b" }))).not.toContain("‮");
  });

  test("replaces a bidirectional control character in the holder", () => {
    expect(render(withHold({ holder: "session:‮x" }))).not.toContain("‮");
  });

  test("isolates the direction of the reason", () => {
    expect(render(withHold({ reason: "x" }))).toContain(
      "[unicode-bidi:isolate]",
    );
  });

  test("escapes markup in a failure reason", () => {
    expect(
      render({
        ...FULL,
        holds: { ok: false, kind: "read_failed", reason: MARKUP },
      }),
    ).not.toContain("<img");
  });
});
