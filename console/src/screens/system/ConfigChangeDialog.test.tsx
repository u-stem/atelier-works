import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type ChangeOffer, changeOfferOf } from "../../lib/configChange.ts";
import { ConfigChangeDialog } from "./ConfigChangeDialog.tsx";

function offerFor(key: string, value: unknown): ChangeOffer {
  const offer = changeOfferOf({ key, kind: "value", value, masked: false });
  if (offer === null) throw new Error(`no offer for ${key}`);
  return offer;
}

function render(offer: ChangeOffer | null, text = "") {
  return renderToStaticMarkup(
    <ConfigChangeDialog
      offer={offer}
      text={text}
      onTextChange={() => undefined}
      onConfirm={() => undefined}
      onCancel={() => undefined}
    />,
  );
}

describe("ConfigChangeDialog for a switch", () => {
  const offer = offerFor("implement_enabled", true);

  test("asks whether to stop it", () => {
    expect(render(offer)).toContain("この設定を止めますか");
  });

  test("names the item", () => {
    expect(render(offer)).toContain("implement_enabled");
  });

  test("shows the current value and the new one", () => {
    const html = render(offer);
    expect([html.includes(">true<"), html.includes(">false<")]).toEqual([
      true,
      true,
    ]);
  });

  test("has no box to type a value", () => {
    expect(render(offer)).not.toContain("<input");
  });

  test("labels the button that runs the change apart from the one that dismisses", () => {
    expect(render(offer)).toContain(">止める<");
  });

  test("says that a person undoes it in Windmill", () => {
    expect(render(offer)).toContain("元に戻すには、人がWindmillで編集します");
  });
});

describe("ConfigChangeDialog for a number", () => {
  const offer = offerFor("daily_budget_usd", 50);

  test("asks whether to lower it", () => {
    expect(render(offer)).toContain("この設定の値を下げますか");
  });

  test("shows the current value", () => {
    expect(render(offer)).toContain(">50<");
  });

  test("has a box to type the new value, with a label", () => {
    expect(render(offer)).toMatch(/<label[^>]*>変更後の値<\/label>/);
  });

  test("shows the text that was typed", () => {
    expect(render(offer, "20")).toContain('value="20"');
  });

  test("labels the button that runs the change", () => {
    expect(render(offer, "20")).toContain(">下げる<");
  });

  test("says nothing about the value before anything is typed", () => {
    expect(render(offer, "")).not.toContain("現在の値より小さい");
  });

  test("says why a value that is not lower cannot be used", () => {
    expect(render(offer, "60")).toContain("現在の値より小さい");
  });

  test("says why a text that is not a number cannot be used", () => {
    expect(render(offer, "abc")).toContain("数字");
  });

  test("keeps the confirm button off while the value cannot be used", () => {
    const element = ConfigChangeDialog({
      offer,
      text: "60",
      onTextChange: () => undefined,
      onConfirm: () => undefined,
      onCancel: () => undefined,
    });
    expect(element.props.confirmDisabled).toBe(true);
  });

  test("keeps the confirm button off while the box is empty", () => {
    const element = ConfigChangeDialog({
      offer,
      text: "",
      onTextChange: () => undefined,
      onConfirm: () => undefined,
      onCancel: () => undefined,
    });
    expect(element.props.confirmDisabled).toBe(true);
  });

  test("turns the confirm button on for a value that can be used", () => {
    const element = ConfigChangeDialog({
      offer,
      text: "20",
      onTextChange: () => undefined,
      onConfirm: () => undefined,
      onCancel: () => undefined,
    });
    expect(element.props.confirmDisabled).toBe(false);
  });
});

describe("ConfigChangeDialog handlers", () => {
  const offer = offerFor("daily_budget_usd", 50);

  test("hands the confirmation to the confirm handler", () => {
    const onConfirm = () => undefined;
    const element = ConfigChangeDialog({
      offer,
      text: "20",
      onTextChange: () => undefined,
      onConfirm,
      onCancel: () => undefined,
    });
    expect(element.props.onConfirm).toBe(onConfirm);
  });

  test("hands both the cancel button and Esc to the dismiss handler", () => {
    const onCancel = () => undefined;
    const element = ConfigChangeDialog({
      offer,
      text: "20",
      onTextChange: () => undefined,
      onConfirm: () => undefined,
      onCancel,
    });
    expect(element.props.onCancel).toBe(onCancel);
  });

  test("opens the dialog only for an offer", () => {
    const element = ConfigChangeDialog({
      offer: null,
      text: "",
      onTextChange: () => undefined,
      onConfirm: () => undefined,
      onCancel: () => undefined,
    });
    expect(element.props.open).toBe(false);
  });

  test("asks nothing when no item is chosen", () => {
    expect(render(null)).not.toContain("この設定");
  });
});
