import { describe, expect, test } from "bun:test";
import { parseMergedPullRequests } from "../../f/factory/lib/self_update_pull_requests.ts";
import { omittedMarker } from "../../f/factory/lib/workspace.ts";

// ログの1件は`%P`、`%s`、`%b`を0x1fで区切り、NULで終える。
const PARENT_A = "1111111111111111111111111111111111111111";
const PARENT_B = "2222222222222222222222222222222222222222";
const TWO_PARENTS = `${PARENT_A} ${PARENT_B}`;
const FACTORY_REPO = "https://github.com/octo-owner/atelier-works.git";

function logEntry(parents: string, subject: string, body = ""): string {
  return `${parents}\x1f${subject}\x1f${body}\0`;
}

function mergeEntry(number: number, head: string, title: string): string {
  return logEntry(
    TWO_PARENTS,
    `Merge pull request #${String(number)} from ${head}`,
    `${title}\n`,
  );
}

describe("parseMergedPullRequests origin", () => {
  test("marks a pull request from a factory implementation branch as factory", () => {
    const output = mergeEntry(7, "octo-owner/factory/issue-3-wi-9", "feat: x");
    expect(parseMergedPullRequests(output, FACTORY_REPO)[0]?.origin).toBe(
      "factory",
    );
  });

  test("marks a pull request from another branch as human", () => {
    const output = mergeEntry(7, "octo-owner/fix/something", "fix: y");
    expect(parseMergedPullRequests(output, FACTORY_REPO)[0]?.origin).toBe(
      "human",
    );
  });

  test("marks a fork branch that imitates the factory branch as human", () => {
    const output = mergeEntry(7, "someone/factory/issue-3-wi-9", "fix: y");
    expect(parseMergedPullRequests(output, FACTORY_REPO)[0]?.origin).toBe(
      "human",
    );
  });

  test("compares the owner of the branch without regard to case", () => {
    const output = mergeEntry(7, "Octo-Owner/factory/issue-3-wi-9", "feat: x");
    expect(parseMergedPullRequests(output, FACTORY_REPO)[0]?.origin).toBe(
      "factory",
    );
  });

  test("does not accept a factory branch name with a suffix", () => {
    const output = mergeEntry(
      7,
      "octo-owner/factory/issue-3-wi-9-extra",
      "feat: x",
    );
    expect(parseMergedPullRequests(output, FACTORY_REPO)[0]?.origin).toBe(
      "human",
    );
  });

  test("reads a squash merge subject as a pull request of unknown origin", () => {
    const output = logEntry(PARENT_A, "feat: squashed change (#12)");
    expect(parseMergedPullRequests(output, FACTORY_REPO)).toEqual([
      {
        number: 12,
        title: "feat: squashed change",
        origin: "unknown",
        url: "https://github.com/octo-owner/atelier-works/pull/12",
      },
    ]);
  });
});

describe("parseMergedPullRequests without a repository url", () => {
  test("reports unknown when the repository owner cannot be compared", () => {
    const output = mergeEntry(7, "octo-owner/fix/something", "fix: y");
    expect(
      parseMergedPullRequests(output, "ssh://example.com/o/r.git")[0]?.origin,
    ).toBe("unknown");
  });
});

describe("parseMergedPullRequests selection", () => {
  test("ignores a merge commit whose subject ends with a pull request number", () => {
    const output = logEntry(TWO_PARENTS, "Merge branch x (#5)");
    expect(parseMergedPullRequests(output, FACTORY_REPO)).toEqual([]);
  });

  test("ignores a single parent commit that imitates a merge subject", () => {
    const output = logEntry(
      PARENT_A,
      "Merge pull request #7 from octo-owner/factory/issue-3-wi-9",
      "feat: spoof",
    );
    expect(parseMergedPullRequests(output, FACTORY_REPO)).toEqual([]);
  });

  test("ignores a commit that mentions no pull request", () => {
    const output = logEntry(PARENT_A, "chore: bump a dependency");
    expect(parseMergedPullRequests(output, FACTORY_REPO)).toEqual([]);
  });

  test("ignores a merge commit that is not a pull request merge", () => {
    const output = logEntry(TWO_PARENTS, "chore: mainに追従する");
    expect(parseMergedPullRequests(output, FACTORY_REPO)).toEqual([]);
  });

  test("keeps the order of the log and drops a repeated number", () => {
    const output =
      mergeEntry(9, "octo-owner/fix/a", "newer") +
      mergeEntry(8, "octo-owner/fix/b", "older") +
      mergeEntry(9, "octo-owner/fix/a", "repeated");
    expect(
      parseMergedPullRequests(output, FACTORY_REPO).map((pr) => pr.number),
    ).toEqual([9, 8]);
  });

  test("keeps at most 100 pull requests", () => {
    const output = Array.from({ length: 150 }, (_, index) =>
      mergeEntry(index + 1, "octo-owner/fix/a", "t"),
    ).join("");
    expect(parseMergedPullRequests(output, FACTORY_REPO)).toHaveLength(100);
  });

  test("returns an empty list for an empty output", () => {
    expect(parseMergedPullRequests("", FACTORY_REPO)).toEqual([]);
  });
});

describe("parseMergedPullRequests title", () => {
  test("takes the title from the first line of the body", () => {
    const output = logEntry(
      TWO_PARENTS,
      "Merge pull request #7 from octo-owner/fix/a",
      "fix: the title\n\nsecond paragraph\n",
    );
    expect(parseMergedPullRequests(output, FACTORY_REPO)[0]?.title).toBe(
      "fix: the title",
    );
  });

  test("uses a null title when the body is empty", () => {
    const output = logEntry(
      TWO_PARENTS,
      "Merge pull request #7 from octo-owner/fix/a",
    );
    expect(parseMergedPullRequests(output, FACTORY_REPO)[0]?.title).toBeNull();
  });

  test("cuts a long title to 200 characters", () => {
    const output = mergeEntry(7, "octo-owner/fix/a", "あ".repeat(500));
    expect(
      parseMergedPullRequests(output, FACTORY_REPO)[0]?.title?.length,
    ).toBe(200);
  });

  test("replaces control and bidirectional characters in a title", () => {
    const output = logEntry(
      TWO_PARENTS,
      "Merge pull request #7 from octo-owner/fix/a",
      "fix:‮evil\u0007 title",
    );
    expect(parseMergedPullRequests(output, FACTORY_REPO)[0]?.title).toBe(
      "fix: evil title",
    );
  });
});

describe("parseMergedPullRequests url", () => {
  test("builds the pull request url from the factory repository", () => {
    const output = mergeEntry(7, "octo-owner/fix/a", "fix: a");
    expect(parseMergedPullRequests(output, FACTORY_REPO)[0]?.url).toBe(
      "https://github.com/octo-owner/atelier-works/pull/7",
    );
  });

  test("uses a null url when the factory repository is not a github https url", () => {
    const output = mergeEntry(7, "octo-owner/fix/a", "fix: a");
    expect(
      parseMergedPullRequests(output, "ssh://example.com/o/r.git")[0]?.url,
    ).toBeNull();
  });
});

describe("parseMergedPullRequests with capped output", () => {
  const complete = mergeEntry(9, "octo-owner/fix/a", "complete");
  const cutHead = `${TWO_PARENTS}\x1fMerge pull request #8 from octo-owner/fix/b\x1ftit`;
  const cutTail = `le\n\0${mergeEntry(5, "octo-owner/fix/c", "older")}`;
  const capped = `${complete}${cutHead}${omittedMarker(4096)}${cutTail}`;

  test("keeps the complete entries before the omitted marker", () => {
    expect(
      parseMergedPullRequests(capped, FACTORY_REPO).map((pr) => pr.number),
    ).toEqual([9]);
  });

  test("drops the entry that the marker cut", () => {
    expect(
      parseMergedPullRequests(capped, FACTORY_REPO).some(
        (pr) => pr.number === 8,
      ),
    ).toBe(false);
  });

  test("drops the entries after the marker", () => {
    expect(
      parseMergedPullRequests(capped, FACTORY_REPO).some(
        (pr) => pr.number === 5,
      ),
    ).toBe(false);
  });

  test("does not read a fake merge made from the marker text", () => {
    const fake = `${TWO_PARENTS}${omittedMarker(1)}Merge pull request #7 from octo-owner/factory/issue-1-wi-1\x1ftitle\0`;
    expect(parseMergedPullRequests(fake, FACTORY_REPO)).toEqual([]);
  });
});

describe("parseMergedPullRequests title characters", () => {
  test("keeps a zero width joiner in an emoji sequence", () => {
    const output = mergeEntry(
      7,
      "octo-owner/fix/a",
      "fix: \u{1F468}\u200D\u{1F469} family",
    );
    expect(parseMergedPullRequests(output, FACTORY_REPO)[0]?.title).toBe(
      "fix: \u{1F468}\u200D\u{1F469} family",
    );
  });

  test("keeps a zero width non-joiner", () => {
    const output = mergeEntry(7, "octo-owner/fix/a", "fix: \u0645\u200C\u0647");
    expect(parseMergedPullRequests(output, FACTORY_REPO)[0]?.title).toBe(
      "fix: \u0645\u200C\u0647",
    );
  });

  test("replaces the isolate and override controls", () => {
    const output = mergeEntry(7, "octo-owner/fix/a", "a\u2066b\u2069c\u200Ed");
    expect(parseMergedPullRequests(output, FACTORY_REPO)[0]?.title).toBe(
      "a b c d",
    );
  });

  test("replaces invisible operators, the byte order mark and tag characters", () => {
    const output = mergeEntry(
      7,
      "octo-owner/fix/a",
      "a\u2062b\uFEFFc\u{E0041}d",
    );
    expect(parseMergedPullRequests(output, FACTORY_REPO)[0]?.title).toBe(
      "a b c d",
    );
  });
});
