import { describe, expect, test } from "bun:test";
import { observeWidth, type WidthObserver } from "./useElementWidth.ts";

type Entries = readonly { readonly contentRect: { readonly width: number } }[];

/** 観測を記録し、大きさの変化を手で起こせる差し替え用の観測器。 */
function fakeObserver() {
  const calls: string[] = [];
  let notify: (entries: Entries) => void = () => {};
  const create = (callback: (entries: Entries) => void) => {
    notify = callback;
    const observer: WidthObserver<FakeElement> = {
      observe: () => {
        calls.push("observe");
      },
      disconnect: () => {
        calls.push("disconnect");
      },
    };
    return observer;
  };
  return {
    calls,
    create,
    resize: (width: number) => notify([{ contentRect: { width } }]),
  };
}

type FakeElement = { getBoundingClientRect(): { width: number } };

const ELEMENT: FakeElement = { getBoundingClientRect: () => ({ width: 640 }) };

describe("observeWidth", () => {
  test("reports the width measured when observation starts", () => {
    const widths: number[] = [];
    observeWidth(ELEMENT, (width) => widths.push(width), fakeObserver().create);
    expect(widths).toEqual([640]);
  });

  test("starts observing the element", () => {
    const fake = fakeObserver();
    observeWidth(ELEMENT, () => {}, fake.create);
    expect(fake.calls).toEqual(["observe"]);
  });

  test("reports the width again when the element is resized", () => {
    const widths: number[] = [];
    const fake = fakeObserver();
    observeWidth(ELEMENT, (width) => widths.push(width), fake.create);
    fake.resize(900);
    expect(widths).toEqual([640, 900]);
  });

  test("stops observing when the returned function is called", () => {
    const fake = fakeObserver();
    const stop = observeWidth(ELEMENT, () => {}, fake.create);
    stop();
    expect(fake.calls).toEqual(["observe", "disconnect"]);
  });
});
