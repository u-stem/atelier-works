import { describe, expect, test } from "bun:test";
import {
  FAILURE_REASON_HEAD_LENGTH,
  failureReasonText,
  isPullRequestListTruncated,
  PULL_REQUEST_RECORD_LIMIT,
  pullRequestHref,
  pullRequestTitleText,
  pullRequestTruncationNote,
  shortSha,
  versionText,
} from "./updateHistory.ts";

const SHA_A = "0123456789abcdef0123456789abcdef01234567";
const SHA_B = "fedcba9876543210fedcba9876543210fedcba98";

describe("failureReasonText", () => {
  test("shows the reason of a failure", () => {
    expect(failureReasonText({ result: "failed", error: "boom" })).toBe("boom");
  });

  test("shows nothing for a success", () => {
    expect(failureReasonText({ result: "success", error: null })).toBeNull();
  });

  test(`cuts the reason to its first ${String(FAILURE_REASON_HEAD_LENGTH)} characters`, () => {
    const head = "h".repeat(FAILURE_REASON_HEAD_LENGTH);
    expect(failureReasonText({ result: "failed", error: `${head}TAIL` })).toBe(
      `${head}…`,
    );
  });

  test("keeps a reason of exactly the head length", () => {
    const head = "h".repeat(FAILURE_REASON_HEAD_LENGTH);
    expect(failureReasonText({ result: "failed", error: head })).toBe(head);
  });

  test("puts a reason with line breaks on one line", () => {
    expect(failureReasonText({ result: "failed", error: "a\n\nb  c" })).toBe(
      "a b c",
    );
  });

  test("states that a failure with a null reason has no reason", () => {
    expect(failureReasonText({ result: "failed", error: null })).toBe(
      "理由の記録はありません",
    );
  });

  test("states that a failure without the reason field has no reason", () => {
    expect(failureReasonText({ result: "failed" })).toBe(
      "理由の記録はありません",
    );
  });

  test("states that a failure with a blank reason has no reason", () => {
    expect(failureReasonText({ result: "failed", error: " \n " })).toBe(
      "理由の記録はありません",
    );
  });
});

describe("shortSha", () => {
  test("keeps the first seven characters of a full sha", () => {
    expect(shortSha(SHA_A)).toBe("0123456");
  });

  test("does not show a value that is not a sha", () => {
    expect(shortSha("<img src=x onerror=alert(1)>")).toBe("不明");
  });
});

describe("versionText", () => {
  test("joins the two versions with an arrow", () => {
    expect(versionText(SHA_A, SHA_B)).toBe("0123456 → fedcba9");
  });

  test("says the first deployment when there is no previous version", () => {
    expect(versionText(null, SHA_B)).toBe("初回 → fedcba9");
  });
});

describe("pullRequestHref", () => {
  test("returns a pull request url whose number matches", () => {
    expect(
      pullRequestHref({ number: 7, url: "https://github.com/o/r/pull/7" }),
    ).toBe("https://github.com/o/r/pull/7");
  });

  test("returns null for an issue url", () => {
    expect(
      pullRequestHref({ number: 7, url: "https://github.com/o/r/issues/7" }),
    ).toBeNull();
  });

  test("returns null when the number in the url differs", () => {
    expect(
      pullRequestHref({ number: 7, url: "https://github.com/o/r/pull/8" }),
    ).toBeNull();
  });

  test("returns null for a script url", () => {
    expect(
      pullRequestHref({ number: 7, url: "javascript:alert(1)" }),
    ).toBeNull();
  });

  test("returns null for a url on another host", () => {
    expect(
      pullRequestHref({ number: 7, url: "https://evil.example/o/r/pull/7" }),
    ).toBeNull();
  });

  test("returns null when there is no url", () => {
    expect(pullRequestHref({ number: 7, url: null })).toBeNull();
  });
});

describe("pullRequestTitleText", () => {
  test("returns the title as text", () => {
    expect(pullRequestTitleText({ number: 7, title: "fix: a" })).toBe("fix: a");
  });

  test("does not interpret markup in a title", () => {
    expect(
      pullRequestTitleText({ number: 7, title: "<b>bold</b> [x](http://e)" }),
    ).toBe("<b>bold</b> [x](http://e)");
  });

  test("falls back to the number when the title is missing", () => {
    expect(pullRequestTitleText({ number: 7, title: null })).toBe(
      "題名なし(#7)",
    );
  });
});

describe("isPullRequestListTruncated", () => {
  test("is false below the record limit", () => {
    expect(isPullRequestListTruncated(PULL_REQUEST_RECORD_LIMIT - 1)).toBe(
      false,
    );
  });

  test("is true at the record limit", () => {
    expect(isPullRequestListTruncated(PULL_REQUEST_RECORD_LIMIT)).toBe(true);
  });
});

describe("pullRequestTruncationNote", () => {
  test("builds the number from the record limit", () => {
    expect(pullRequestTruncationNote()).toContain(
      `${PULL_REQUEST_RECORD_LIMIT}件`,
    );
  });

  test("does not state that older pull requests are missing", () => {
    expect(pullRequestTruncationNote()).toContain(
      "表示していない場合があります",
    );
  });
});
