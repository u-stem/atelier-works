// 手動投入が作業項目に保存する本文は、GitHubに投稿したIssueの本文そのものでなければならない。
// 承認の前の確認(`issueChangedSinceIntake`)が、作業項目の本文と現在のIssueの本文を比べるため、
// 区切りの行や目印の分だけ食い違うと、承認が常に「変わった」として断られる。

import { describe, expect, test } from "bun:test";
import {
  buildImplementPrBody,
  issueChangedSinceIntake,
} from "../../f/factory/lib/implement_support.ts";
import {
  buildPostedIssueBody,
  issueHtmlUrl,
  withIntakeEnd,
  withIntakeMarker,
} from "../../f/factory/lib/manual_intake_support.ts";
import {
  buildManualIntakeIssueBody,
  type CreatedIssue,
  createManualIntakeIssue,
  type IntakeKeyStore,
  type ManualIntakeIssueDeps,
} from "../../f/factory/steps/manual_intake_create_issue.ts";

const INTAKE_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const FIELDS = {
  body: "Fix the typo.",
  acceptance_criteria: "It is gone.",
};
const INPUT = {
  owner: "octo-owner",
  repo: "widgets",
  title: "Fix the typo",
  ...FIELDS,
  profile: "direct",
};
const ASSEMBLED = buildManualIntakeIssueBody(FIELDS);

describe("buildPostedIssueBody", () => {
  test("ends a body without a key on the end line", () => {
    expect(buildPostedIssueBody(FIELDS, undefined)).toBe(
      withIntakeEnd(ASSEMBLED),
    );
  });

  test("ends a body with a key on the end line and the marker", () => {
    expect(buildPostedIssueBody(FIELDS, INTAKE_ID)).toBe(
      withIntakeMarker(ASSEMBLED, INTAKE_ID),
    );
  });
});

describe("issueHtmlUrl", () => {
  test("builds the address of the issue", () => {
    expect(issueHtmlUrl("octo-owner", "widgets", 41)).toBe(
      "https://github.com/octo-owner/widgets/issues/41",
    );
  });
});

/** 作業項目の本文と、GitHubが返す本文の組。作成のステップが返す本文と、投稿した本文を使う。 */
async function created(key: string | undefined) {
  const posted: string[] = [];
  const store: IntakeKeyStore = {
    reserve: async () => true,
    read: async () => null,
    takeOver: async () => false,
    recordIssue: async () => true,
  };
  const deps: ManualIntakeIssueDeps = {
    store,
    holder: "0190aaaa-0000-7000-8000-000000000001",
    now: () => new Date("2026-10-31T03:00:00.000Z"),
    findIssue: async (): Promise<(CreatedIssue & { body: string }) | null> =>
      null,
    createIssue: async (_title, body) => {
      posted.push(body);
      return { number: 41, htmlUrl: issueHtmlUrl("octo-owner", "widgets", 41) };
    },
    log: { warn() {} },
  };
  const result = await createManualIntakeIssue(
    { ...INPUT, ...(key === undefined ? {} : { intake_key: key }) },
    deps,
  );
  return { result, live: posted[0] ?? "" };
}

describe("the stored body against the live issue", () => {
  test("is unchanged for a body without a key", async () => {
    const { result, live } = await created(undefined);
    expect(
      issueChangedSinceIntake(
        { title: result.title, body: result.body },
        { title: "Fix the typo", body: live },
      ),
    ).toBe(false);
  });

  test("is unchanged for a body with a key", async () => {
    const { result, live } = await created(INTAKE_ID);
    expect(
      issueChangedSinceIntake(
        { title: result.title, body: result.body },
        { title: "Fix the typo", body: live },
      ),
    ).toBe(false);
  });

  test("adds no note about a changed issue to the pull request", async () => {
    const { result, live } = await created(INTAKE_ID);
    const body = buildImplementPrBody({
      summary: "直しました。",
      spec: { kind: "issue", profile: "direct" },
      profileWarnings: [],
      checks: { kind: "ran", results: [{ command: "bun test", ok: true }] },
      protectedChanges: [],
      notesForReviewer: [],
      issueNumber: 41,
      changedPaths: ["README.md"],
      deployChecklist: false,
      issueUpdatedAfterIntake: issueChangedSinceIntake(
        { title: result.title, body: result.body },
        { title: "Fix the typo", body: live },
      ),
      intakeRefreshed: false,
    });
    expect(body).not.toContain("その後にIssueの題名か本文が更新されています");
  });
});
