import { describe, expect, test } from "bun:test";
import {
  FETCH_ERROR_NEXT_ACTIONS,
  nextActionFor,
  parseFetcherStatus,
} from "../../f/factory/lib/console_status.ts";
import {
  FETCH_ERROR_CODES,
  type FetcherStatus,
} from "../../infra/console_fetcher/decide.ts";

// f/はinfra/をimportできないので、console_fetcherが書くstatus.jsonの形と
// エラーコードの一覧が、f/側の読み方と食い違っていないことをここで確かめる。

describe("status.json contract", () => {
  test("every fetcher error code has its own next action", () => {
    expect(
      FETCH_ERROR_CODES.filter((code) => !(code in FETCH_ERROR_NEXT_ACTIONS)),
    ).toEqual([]);
  });

  test("the next action table has no code the fetcher lacks", () => {
    expect(
      Object.keys(FETCH_ERROR_NEXT_ACTIONS).filter(
        (code) => !FETCH_ERROR_CODES.some((known) => known === code),
      ),
    ).toEqual([]);
  });

  test("every next action is a non-empty sentence", () => {
    expect(
      FETCH_ERROR_CODES.filter((code) => nextActionFor(code).length === 0),
    ).toEqual([]);
  });

  test("the fetcher error codes are unique", () => {
    expect(new Set(FETCH_ERROR_CODES).size).toBe(FETCH_ERROR_CODES.length);
  });

  test("a failed status the fetcher writes is accepted for every code", () => {
    const accepted = FETCH_ERROR_CODES.filter((code) => {
      const written: FetcherStatus = {
        state: "failed",
        sha: null,
        checked_at: "2026-10-09T00:00:00.000Z",
        error: code,
      };
      return parseFetcherStatus(JSON.parse(JSON.stringify(written))) !== null;
    });
    expect(accepted).toEqual([...FETCH_ERROR_CODES]);
  });

  test("an ok status the fetcher writes is accepted", () => {
    const written: FetcherStatus = {
      state: "ok",
      sha: "0123456789abcdef0123456789abcdef01234567",
      checked_at: "2026-10-09T00:00:00.000Z",
      error: null,
    };
    expect(parseFetcherStatus(JSON.parse(JSON.stringify(written)))).toEqual(
      written,
    );
  });

  test("a pinned status the fetcher writes is accepted", () => {
    const written: FetcherStatus = {
      state: "pinned",
      sha: "0123456789abcdef0123456789abcdef01234567",
      checked_at: "2026-10-09T00:00:00.000Z",
      error: null,
    };
    expect(parseFetcherStatus(JSON.parse(JSON.stringify(written)))?.state).toBe(
      "pinned",
    );
  });
});
