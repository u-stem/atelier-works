// console_queryが未知のviewを断るときの文を、Console(console/)が版のずれとして見分けられることを確かめる。
// 文は別々に書かれているので、片方だけを変えたときにここで落とす。
// Windmillが失敗の結果を包む形(JSONの`error.message`)を通し、状態は422と500の両方を試す。

import { describe, expect, test } from "bun:test";
import {
  type ApiError,
  classifyRunResponse,
} from "../../console/src/api/errors.ts";
import {
  describeQueryFailure,
  isViewMismatch,
} from "../../console/src/lib/queryFailureView.ts";
import { main } from "../../f/factory/steps/console_query.ts";

/** 4xxの本文からConsoleが持つ文の長さの上限。 */
const DETAIL_LIMIT = 500;

/** DBに触れる前に投げる、未知のviewを断る例外の文。 */
async function refusalMessage(view: string): Promise<string> {
  try {
    await main(view);
  } catch (error) {
    return error instanceof Error ? error.message : "";
  }
  return "";
}

/** Consoleが受け取る分類済みの失敗。 */
async function received(view: string, status: number): Promise<ApiError> {
  const message = await refusalMessage(view);
  const result = classifyRunResponse(
    status,
    JSON.stringify({ error: { name: "Error", message } }),
  );
  return result.ok ? { kind: "network" } : result.error;
}

describe("console_query view refusal as the console receives it", () => {
  test("is recognized as a version mismatch when it arrives as a 422", async () => {
    expect(isViewMismatch(await received("not-a-view", 422))).toBe(true);
  });

  test("is recognized as a version mismatch when it arrives as a failed job", async () => {
    expect(isViewMismatch(await received("not-a-view", 500))).toBe(true);
  });

  test("keeps the requested view at the end of the detail", async () => {
    const error = await received("not-a-view", 422);
    expect(
      describeQueryFailure(error).detail.endsWith('(got "not-a-view")'),
    ).toBe(true);
  });

  test("fits in the limit of the 4xx detail", async () => {
    expect((await refusalMessage("not-a-view")).length).toBeLessThanOrEqual(
      DETAIL_LIMIT,
    );
  });

  test("points to the system screen for an ordinary view", async () => {
    const error = await received("not-a-view", 422);
    expect(describeQueryFailure(error).nextStep).toContain("システムの画面");
  });

  test("does not point to the system screen when system_status was refused", async () => {
    // 実際のsystem_statusは許可された名前なので、断りの文に同じ名前を入れて作る。
    const message = (await refusalMessage("not-a-view")).replace(
      'got "not-a-view"',
      'got "system_status"',
    );
    const result = classifyRunResponse(
      422,
      JSON.stringify({ error: { message } }),
    );
    const error: ApiError = result.ok ? { kind: "network" } : result.error;
    expect(describeQueryFailure(error).nextStep).not.toContain(
      "システムの画面",
    );
  });
});
