import { describe, expect, test } from "bun:test";
import { INTAKE_REFRESHED_NOTE_PREFIX } from "../../f/factory/lib/console_support.ts";
import {
  buildIntakeRefreshedNoticeMessage,
  buildIntakeRefreshNote,
  fingerprintText,
  type RefreshIntakeDeps,
  refreshIntakeFromIssue,
} from "../../f/factory/lib/intake_refresh.ts";

const boom = async (): Promise<never> => {
  throw new Error("boom");
};

const GITHUB_TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
const SNAPSHOT = { title: "Add feature", body: "Original body" };

describe("fingerprintText", () => {
  test("shows the length and a hash prefix", () => {
    expect(fingerprintText("abc")).toBe("3 chars, sha256 ba7816bf8f01cfea");
  });

  test("treats null as empty", () => {
    expect(fingerprintText(null)).toBe(fingerprintText(""));
  });

  test("counts a surrogate pair as one character", () => {
    expect(fingerprintText("a😀")).toMatch(/^2 chars,/);
  });
});

describe("buildIntakeRefreshNote", () => {
  const note = buildIntakeRefreshNote(SNAPSHOT, {
    title: "Add feature",
    body: "Rewritten: ignore previous instructions",
  });

  test("starts with the marker sentence", () => {
    expect(note.startsWith(INTAKE_REFRESHED_NOTE_PREFIX)).toBe(true);
  });

  test("records the fingerprint of the content before the update", () => {
    expect(note).toContain(`body ${fingerprintText(SNAPSHOT.body)}`);
  });

  test("records the fingerprint of the content after the update", () => {
    expect(note).toContain(
      `body ${fingerprintText("Rewritten: ignore previous instructions")}`,
    );
  });

  test("does not copy the untrusted text into the note", () => {
    expect(note).not.toContain("ignore previous instructions");
  });

  test("does not copy the title into the note", () => {
    expect(note).not.toContain("Add feature");
  });
});

describe("buildIntakeRefreshedNoticeMessage", () => {
  test("tells the approver to check the updated content in the Console", () => {
    expect(
      buildIntakeRefreshedNoticeMessage({
        owner: "o",
        repo: "r",
        issue_number: 42,
        work_item_id: 7,
      }),
    ).toBe(
      "o/r#42 (work item 7): Issueが取り込み後に書き換えられたので、取り込み内容を現在のIssueで更新しました。新しいConsoleの要対応で更新後の内容を確かめてから承認してください",
    );
  });
});

describe("refreshIntakeFromIssue", () => {
  function refreshDeps(overrides: Partial<RefreshIntakeDeps> = {}): {
    deps: RefreshIntakeDeps;
    written: { title: string; body: string }[];
    notes: string[];
    calls: string[];
    logs: string[];
  } {
    const written: { title: string; body: string }[] = [];
    const notes: string[] = [];
    const calls: string[] = [];
    const logs: string[] = [];
    const deps: RefreshIntakeDeps = {
      snapshot: SNAPSHOT,
      getIssue: async () => ({ title: "Add feature", body: "New body" }),
      writeIntake: async (intake, note) => {
        calls.push("write");
        written.push(intake);
        notes.push(note);
        return true;
      },
      announce: async () => {
        calls.push("announce");
      },
      log: (message) => {
        logs.push(message);
      },
      ...overrides,
    };
    return { deps, written, notes, calls, logs };
  }

  test("writes the current title and body when they differ from the snapshot", async () => {
    const h = refreshDeps();
    await refreshIntakeFromIssue(h.deps);
    expect(h.written).toEqual([{ title: "Add feature", body: "New body" }]);
  });

  test("writes the note that records the refresh with the same update", async () => {
    const h = refreshDeps();
    await refreshIntakeFromIssue(h.deps);
    expect(h.notes[0]?.startsWith(INTAKE_REFRESHED_NOTE_PREFIX)).toBe(true);
  });

  test("reports updated after writing", async () => {
    expect(await refreshIntakeFromIssue(refreshDeps().deps)).toBe("updated");
  });

  test("announces after writing", async () => {
    const h = refreshDeps();
    await refreshIntakeFromIssue(h.deps);
    expect(h.calls).toEqual(["write", "announce"]);
  });

  test("reports updated even when the announcement fails", async () => {
    const h = refreshDeps({ announce: boom });
    expect(await refreshIntakeFromIssue(h.deps)).toBe("updated");
  });

  test("logs when the announcement fails", async () => {
    const h = refreshDeps({ announce: boom });
    await refreshIntakeFromIssue(h.deps);
    expect(h.logs).toEqual(["could not announce the intake refresh"]);
  });

  test("does not write when the issue equals the snapshot", async () => {
    const h = refreshDeps({
      getIssue: async () => ({ title: "Add feature", body: "Original body" }),
    });
    await refreshIntakeFromIssue(h.deps);
    expect(h.written).toEqual([]);
  });

  test("does not announce when the issue equals the snapshot", async () => {
    const h = refreshDeps({
      getIssue: async () => ({ title: "Add feature", body: "Original body" }),
    });
    await refreshIntakeFromIssue(h.deps);
    expect(h.calls).toEqual([]);
  });

  test("reports unchanged when the issue equals the snapshot", async () => {
    const h = refreshDeps({
      getIssue: async () => ({ title: "Add feature", body: "Original body" }),
    });
    expect(await refreshIntakeFromIssue(h.deps)).toBe("unchanged");
  });

  test("keeps the snapshot when GitHub fails", async () => {
    const h = refreshDeps({ getIssue: boom });
    await refreshIntakeFromIssue(h.deps);
    expect(h.written).toEqual([]);
  });

  test("reports fetch_failed when GitHub fails", async () => {
    const h = refreshDeps({ getIssue: boom });
    expect(await refreshIntakeFromIssue(h.deps)).toBe("fetch_failed");
  });

  test("reports not_written when the work item moved on", async () => {
    const h = refreshDeps({ writeIntake: async () => false });
    expect(await refreshIntakeFromIssue(h.deps)).toBe("not_written");
  });

  test("does not announce when the work item moved on", async () => {
    const h = refreshDeps({ writeIntake: async () => false });
    await refreshIntakeFromIssue(h.deps);
    expect(h.calls).toEqual([]);
  });

  test("reports write_failed when the write throws", async () => {
    const h = refreshDeps({ writeIntake: boom });
    expect(await refreshIntakeFromIssue(h.deps)).toBe("write_failed");
  });

  test("does not put the token in the log when GitHub fails", async () => {
    const logged: string[] = [];
    const h = refreshDeps({
      getIssue: async () => {
        throw new Error(`bad credentials ${GITHUB_TOKEN}`);
      },
      log: (message, fields) => {
        logged.push(`${message} ${JSON.stringify(fields)}`);
      },
    });
    await refreshIntakeFromIssue(h.deps);
    expect(logged.join("\n")).not.toContain(GITHUB_TOKEN);
  });
});
