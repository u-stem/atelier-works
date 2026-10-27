import { describe, expect, test } from "bun:test";
import {
  CHORD_IDLE,
  type ChordState,
  type KeyEventLike,
  type OpenDialog,
  type RouteEnv,
  routeKeydown,
} from "./shortcutKeys.ts";

const TARGETS = [
  { key: "1", id: "inbox" },
  { key: "4", id: "jobs" },
] as const;

type Id = (typeof TARGETS)[number]["id"];

const AFTER_G: ChordState = { goAt: 0 };
const NO_DIALOG: readonly OpenDialog[] = [];
const PALETTE_ONLY: readonly OpenDialog[] = [{ isPalette: true }];
const OTHER_DIALOG: readonly OpenDialog[] = [{ isPalette: false }];

function route(
  key: string,
  override: Partial<KeyEventLike> & { defaultPrevented?: boolean } = {},
  routeEnv: Partial<RouteEnv<Id>> = {},
  chord: ChordState = CHORD_IDLE,
) {
  const { defaultPrevented = false, ...rest } = override;
  return routeKeydown(
    {
      key,
      keyCode: 0,
      isComposing: false,
      repeat: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      ...rest,
      defaultPrevented,
    },
    chord,
    {
      now: 0,
      enabled: true,
      typing: false,
      targets: TARGETS,
      platform: "other",
      openDialogs: NO_DIALOG,
      ...routeEnv,
    },
  );
}

const CTRL_K = { ctrlKey: true };

describe("routeKeydown", () => {
  test("does nothing for an event another handler already took", () => {
    expect(
      route("k", { ...CTRL_K, defaultPrevented: true }).togglePalette,
    ).toBe(false);
  });

  test("keeps the chord for an event another handler already took", () => {
    expect(
      route("4", { defaultPrevented: true }, {}, AFTER_G).nextChord,
    ).toEqual(AFTER_G);
  });

  test("toggles the palette with the palette key", () => {
    expect(route("k", CTRL_K).togglePalette).toBe(true);
  });

  test("takes the browser default for the palette key", () => {
    expect(route("k", CTRL_K).preventDefault).toBe(true);
  });

  test("toggles the palette even while typing", () => {
    expect(route("k", CTRL_K, { typing: true }).togglePalette).toBe(true);
  });

  test("toggles the palette even when the shortcuts are off", () => {
    expect(route("k", CTRL_K, { enabled: false }).togglePalette).toBe(true);
  });

  test("closes the palette with the same key while only the palette is open", () => {
    expect(
      route("k", CTRL_K, { openDialogs: PALETTE_ONLY }).togglePalette,
    ).toBe(true);
  });

  test("does nothing with the palette key while another dialog is open", () => {
    expect(
      route("k", CTRL_K, { openDialogs: OTHER_DIALOG }).togglePalette,
    ).toBe(false);
  });

  test("leaves the browser default alone while another dialog is open", () => {
    expect(
      route("k", CTRL_K, { openDialogs: OTHER_DIALOG }).preventDefault,
    ).toBe(false);
  });

  test("does not toggle on an auto-repeated palette key", () => {
    expect(route("k", { ...CTRL_K, repeat: true }).togglePalette).toBe(false);
  });

  test("goes to a screen with g then its digit", () => {
    expect(route("4", {}, { now: 10 }, AFTER_G).go).toBe("jobs");
  });

  test("remembers g for the next key", () => {
    expect(route("g", {}, { now: 7 }).nextChord).toEqual({ goAt: 7 });
  });

  test("does not go while only the palette is open", () => {
    expect(
      route("4", {}, { now: 10, openDialogs: PALETTE_ONLY }, AFTER_G).go,
    ).toBeNull();
  });

  test("drops the chord while only the palette is open", () => {
    expect(
      route("4", {}, { now: 10, openDialogs: PALETTE_ONLY }, AFTER_G).nextChord,
    ).toEqual(CHORD_IDLE);
  });

  test("does not go while another dialog is open", () => {
    expect(
      route("4", {}, { now: 10, openDialogs: OTHER_DIALOG }, AFTER_G).go,
    ).toBeNull();
  });

  test("does not open the help while another dialog is open", () => {
    expect(
      route("?", { shiftKey: true }, { openDialogs: OTHER_DIALOG }).help,
    ).toBe(false);
  });

  test("opens the help with ?", () => {
    expect(route("?", { shiftKey: true }).help).toBe(true);
  });

  test("takes the browser default when it opens the help", () => {
    expect(route("?", { shiftKey: true }).preventDefault).toBe(true);
  });

  test("does not open the help while the shortcuts are off", () => {
    expect(route("?", { shiftKey: true }, { enabled: false }).help).toBe(false);
  });

  test("leaves a plain key alone", () => {
    expect(route("x").preventDefault).toBe(false);
  });
});
