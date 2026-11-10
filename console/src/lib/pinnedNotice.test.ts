import { describe, expect, test } from "bun:test";
import { createPinnedNoticeStore } from "./pinnedNotice.ts";
import type { ReleaseNotice } from "./writeNotices.ts";

const REFUSAL: ReleaseNotice = {
  tone: "info",
  message: "変更しませんでした。",
  nextStep: "端末から変更します。",
};

describe("createPinnedNoticeStore", () => {
  test("holds no notice at first", () => {
    expect(createPinnedNoticeStore().get()).toBeNull();
  });

  test("holds the notice that was pinned, with the item it is about", () => {
    const store = createPinnedNoticeStore();
    store.pin("daily_budget_usd", REFUSAL);
    expect(store.get()).toMatchObject({
      item: "daily_budget_usd",
      notice: REFUSAL,
    });
  });

  test("replaces the notice with the one that is pinned next", () => {
    const store = createPinnedNoticeStore();
    store.pin("daily_budget_usd", REFUSAL);
    store.pin("implement_enabled", {
      tone: "warning",
      message: "確かめます。",
    });
    expect(store.get()?.item).toBe("implement_enabled");
  });

  test("gives a new id to a notice with the same words, so that it is announced again", () => {
    const store = createPinnedNoticeStore();
    store.pin("daily_budget_usd", REFUSAL);
    const first = store.get()?.id;
    store.pin("daily_budget_usd", REFUSAL);
    expect(store.get()?.id).not.toBe(first);
  });

  test("holds nothing after the notice is closed", () => {
    const store = createPinnedNoticeStore();
    store.pin("daily_budget_usd", REFUSAL);
    store.dismiss();
    expect(store.get()).toBeNull();
  });

  test("returns the same object until something changes", () => {
    const store = createPinnedNoticeStore();
    store.pin("daily_budget_usd", REFUSAL);
    expect(store.get()).toBe(store.get());
  });

  test("tells a listener when a notice is pinned", () => {
    const store = createPinnedNoticeStore();
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.pin("daily_budget_usd", REFUSAL);
    expect(calls).toBe(1);
  });

  test("tells a listener when the notice is closed", () => {
    const store = createPinnedNoticeStore();
    store.pin("daily_budget_usd", REFUSAL);
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.dismiss();
    expect(calls).toBe(1);
  });

  test("tells no listener when there is nothing to close", () => {
    const store = createPinnedNoticeStore();
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.dismiss();
    expect(calls).toBe(0);
  });

  test("tells no listener after it unsubscribed", () => {
    const store = createPinnedNoticeStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    unsubscribe();
    store.pin("daily_budget_usd", REFUSAL);
    expect(calls).toBe(0);
  });
});
