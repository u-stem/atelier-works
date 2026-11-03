// Consoleの画面が通すPRの番号を、登録のステップが同じ範囲で受けることを確かめる。
// 画面の検証(`buildPrReviewInput`)は、送る前に誤りを知らせるためのもので、断りの本体は登録のステップにある。
// 範囲が食い違うと、画面が通した番号をステップが断るか、画面が弾いた番号をステップが受ける。
// 比べる相手は、登録のステップが外に出している述語`precheckPrReviewIntake`である。

import { describe, expect, test } from "bun:test";
import { buildPrReviewInput } from "../../console/src/lib/prReviewInput.ts";
import { precheckPrReviewIntake } from "../../f/factory/steps/pr_review_intake_register.ts";

const OWNER = "octo-owner";
const REPO = "widgets";
const REPO_REF = `${OWNER}/${REPO}`;

/** ステップが番号を受けるか。リポジトリの許可は通し、番号の判定だけを見る。 */
function stepAccepts(prNumber: number): boolean {
  return (
    precheckPrReviewIntake(
      { owner: OWNER, repo: REPO, prNumber },
      () => true,
    ) === null
  );
}

function screenAccepts(pr: string): boolean {
  return buildPrReviewInput({ repo: REPO_REF, pr }).ok;
}

/** 数字だけの入力。画面はこの形の入力を整数として読む。 */
const DIGIT_TEXTS = [
  "0",
  "00",
  "000",
  "1",
  "007",
  "12",
  "2147483647",
  "4294967296",
  "9007199254740990",
  "9007199254740991",
  "9007199254740992",
  "9007199254740993",
  "9007199254740994",
  "18014398509481984",
  "99999999999999999999",
  "1".repeat(400),
];

/** 数としての値。文字列にして画面に通し、同じ値をステップに渡す。 */
const NUMBERS = [
  Number.NEGATIVE_INFINITY,
  -Number.MAX_SAFE_INTEGER - 2,
  -1,
  -0.5,
  0,
  0.5,
  1,
  1.5,
  12,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1,
  Number.MAX_SAFE_INTEGER + 2,
  2 ** 60,
  Number.POSITIVE_INFINITY,
  Number.NaN,
];

function textOf(value: number): string {
  return Number.isInteger(value) && value >= 0
    ? BigInt(value).toString()
    : String(value);
}

describe("the number of a pull request", () => {
  test.each(DIGIT_TEXTS)(
    "the screen and the step agree on the digits %j",
    (pr) => {
      expect(screenAccepts(pr)).toBe(stepAccepts(Number(pr)));
    },
  );

  test.each(NUMBERS)(
    "the screen and the step agree on the value %p",
    (value) => {
      expect(screenAccepts(textOf(value))).toBe(stepAccepts(value));
    },
  );

  test("the screen sends a number that the step accepts", () => {
    const built = buildPrReviewInput({ repo: REPO_REF, pr: "12" });
    expect(
      built.ok &&
        precheckPrReviewIntake(
          {
            owner: built.input.owner,
            repo: built.input.repo,
            prNumber: built.input.prNumber,
          },
          () => true,
        ),
    ).toBeNull();
  });
});

describe("a pull request URL", () => {
  test.each([
    "https://github.com/octo-owner/widgets/pull/12",
    "https://github.com/octo-owner/widgets/pull/12/files",
    "github.com/octo-owner/widgets/pull/007",
    "https://www.github.com/octo-owner/widgets/pull/12#issuecomment-1",
  ])("the step accepts what the screen reads from %j", (pr) => {
    const built = buildPrReviewInput({ repo: "", pr });
    expect(
      built.ok &&
        precheckPrReviewIntake(
          {
            owner: built.input.owner,
            repo: built.input.repo,
            prNumber: built.input.prNumber,
          },
          () => true,
        ),
    ).toBeNull();
  });

  test.each([
    "https://github.com/octo-owner/widgets/pull/0",
    "https://github.com/octo-owner/widgets/pull/9007199254740992",
    "https://github.com/octo-owner/widgets/pull/99999999999999999999",
  ])(
    "the screen does not pass a URL whose number the step refuses: %j",
    (pr) => {
      expect(buildPrReviewInput({ repo: "", pr }).ok).toBe(false);
    },
  );
});
