import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type PlaceForm, placeEffectLines } from "../../lib/holdPlace.ts";
import { HoldPlaceButton, HoldPlaceDialog } from "./HoldPlaceDialog.tsx";

const FORM: PlaceForm = {
  kind: "merge",
  target: "octo-owner/widgets",
  minutesText: "60",
  reason: "check the workers",
};

function render(
  form: PlaceForm = FORM,
  variant: "any" | "stop_prepare" = "any",
  open = true,
) {
  return renderToStaticMarkup(
    <HoldPlaceDialog
      open={open}
      variant={variant}
      form={form}
      onChange={() => undefined}
      onConfirm={() => undefined}
      onCancel={() => undefined}
    />,
  );
}

/** 確認のボタン(取り消すの次のボタン)が押せないか。 */
function confirmIsDisabled(html: string, label: string): boolean {
  return new RegExp(`<button[^>]*\\sdisabled=""[^>]*>${label}</button>`).test(
    html,
  );
}

describe("HoldPlaceDialog for any kind", () => {
  test("asks what to place", () => {
    expect(render()).toContain("保留か凍結を置きますか");
  });

  test("labels the confirming button apart from the dismissing one", () => {
    expect(render()).toContain(">置く<");
  });

  test("offers the three kinds in a labelled box", () => {
    const html = render();
    expect(html).toMatch(/<label[^>]*>種類<\/label>/);
  });

  test.each(["マージの保留", "deployの保留", "scheduleの凍結"])(
    "offers %s",
    (label) => {
      expect(render()).toContain(`>${label}<`);
    },
  );

  test("selects the kind of the form", () => {
    expect(render({ ...FORM, kind: "deploy" })).toMatch(
      /<option[^>]*value="deploy"[^>]*selected|<option[^>]*selected[^>]*value="deploy"/,
    );
  });

  test("has a labelled box for the target", () => {
    expect(render()).toMatch(/<label[^>]*>対象<\/label>/);
  });

  test("shows the target that was typed", () => {
    expect(render()).toContain('value="octo-owner/widgets"');
  });

  test("hides the target of a deploy hold, which has none", () => {
    expect(render({ ...FORM, kind: "deploy" })).not.toMatch(
      /<label[^>]*>対象<\/label>/,
    );
  });

  test("has a labelled box for the minutes, with the limit", () => {
    expect(render()).toMatch(/<label[^>]*>期限\(分\)<\/label>/);
  });

  test("states the limit of the kind next to the minutes", () => {
    expect(render({ ...FORM, kind: "deploy" })).toContain("最大120分");
  });

  test("shows the minutes that were typed", () => {
    expect(render()).toContain('value="60"');
  });

  test("has a labelled box for the reason", () => {
    expect(render()).toMatch(/<label[^>]*>理由<\/label>/);
  });

  test("shows the reason that was typed", () => {
    expect(render()).toContain("check the workers");
  });

  test("gives the reason box a limit of 200 characters", () => {
    expect(render()).toContain('maxLength="200"');
  });

  test.each(["merge", "deploy", "freeze"] as const)(
    "says what a %s does and how it ends",
    (kind) => {
      const html = render({
        ...FORM,
        kind,
        target: kind === "freeze" ? "f/factory/collect_github" : FORM.target,
      });
      expect(placeEffectLines(kind).every((line) => html.includes(line))).toBe(
        true,
      );
    },
  );

  test("shows none of its content while closed", () => {
    expect(render(FORM, "any", false)).not.toContain("保留か凍結を置きますか");
  });

  test("lets the person confirm a form that is complete", () => {
    expect(confirmIsDisabled(render(), "置く")).toBe(false);
  });

  test("keeps the confirming button off while the reason is empty", () => {
    expect(confirmIsDisabled(render({ ...FORM, reason: "" }), "置く")).toBe(
      true,
    );
  });

  test("keeps the confirming button off for a deploy hold over the limit", () => {
    expect(
      confirmIsDisabled(
        render({ ...FORM, kind: "deploy", minutesText: "121" }),
        "置く",
      ),
    ).toBe(true);
  });

  test("explains a minutes value over the limit", () => {
    expect(render({ ...FORM, kind: "deploy", minutesText: "121" })).toContain(
      "期限は最大120分です",
    );
  });

  test("does not scold an empty box that nobody typed in", () => {
    expect(render({ ...FORM, minutesText: "" })).not.toContain(
      "期限を分で入力してください",
    );
  });

  test("marks the box with a problem as invalid", () => {
    expect(render({ ...FORM, minutesText: "abc" })).toContain(
      'aria-invalid="true"',
    );
  });
});

describe("HoldPlaceDialog to prepare a stop", () => {
  const PREPARE: PlaceForm = {
    kind: "freeze",
    target: "f/factory/collect_github",
    minutesText: "60",
    reason: "check the workers",
  };

  test("asks whether to prepare", () => {
    expect(render(PREPARE, "stop_prepare")).toContain(
      "scheduleを止める準備をしますか",
    );
  });

  test("labels the confirming button as placing the freeze", () => {
    expect(render(PREPARE, "stop_prepare")).toContain(">凍結を置く<");
  });

  test("names the schedule as text, not as a box", () => {
    const html = render(PREPARE, "stop_prepare");
    expect([
      html.includes("f/factory/collect_github"),
      /<label[^>]*>対象<\/label>/.test(html),
    ]).toEqual([true, false]);
  });

  test("has no box for the kind", () => {
    expect(render(PREPARE, "stop_prepare")).not.toMatch(
      /<label[^>]*>種類<\/label>/,
    );
  });

  test("still asks for the minutes and the reason", () => {
    const html = render(PREPARE, "stop_prepare");
    expect([
      /<label[^>]*>期限\(分\)<\/label>/.test(html),
      /<label[^>]*>理由<\/label>/.test(html),
    ]).toEqual([true, true]);
  });

  test("tells how long to wait before the stop", () => {
    expect(render(PREPARE, "stop_prepare")).toContain("7分");
  });

  test("tells the cost of stopping this schedule", () => {
    expect(render(PREPARE, "stop_prepare")).toContain("通知");
  });
});

describe("HoldPlaceButton", () => {
  test("is a button that names what it opens", () => {
    expect(
      renderToStaticMarkup(<HoldPlaceButton onClick={() => undefined} />),
    ).toContain(">保留や凍結を置く<");
  });
});
