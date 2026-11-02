import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Field, type FieldProps } from "./field.tsx";

function markup(props: Partial<Omit<FieldProps, "children">> = {}): string {
  return renderToStaticMarkup(
    <Field label="題名" {...props}>
      {(control) => <input {...control} />}
    </Field>,
  );
}

/** 開始タグの属性の値。無ければ`null`。 */
function attr(html: string, tag: string, name: string): string | null {
  const open = new RegExp(`<${tag}\\b[^>]*>`).exec(html);
  if (open === null) throw new Error(`no <${tag}> in ${html}`);
  const found = new RegExp(`\\s${name}="([^"]*)"`).exec(open[0]);
  return found === null ? null : (found[1] ?? "");
}

describe("Field", () => {
  test("shows the label text", () => {
    expect(markup()).toMatch(/<label[^>]*>題名<\/label>/);
  });

  test("ties the label to the control by the given id", () => {
    expect(attr(markup({ id: "title" }), "label", "for")).toBe("title");
  });

  test("hands the given id to the control", () => {
    expect(attr(markup({ id: "title" }), "input", "id")).toBe("title");
  });

  test("ties the label to the control when the id is generated", () => {
    const html = markup();
    expect(attr(html, "label", "for")).toBe(attr(html, "input", "id"));
  });

  test("generates an id when none is given", () => {
    expect(attr(markup(), "input", "id")).toBeTruthy();
  });

  test("renders no description without a hint or a problem", () => {
    expect(attr(markup(), "input", "aria-describedby")).toBeNull();
  });

  test("does not mark the control invalid without a problem", () => {
    expect(attr(markup(), "input", "aria-invalid")).toBeNull();
  });

  test("renders the hint under its own id", () => {
    expect(markup({ id: "t", hint: "40字まで" })).toContain(
      '<p id="t-hint" class="text-small text-muted-foreground">40字まで</p>',
    );
  });

  test("describes the control by the hint", () => {
    expect(
      attr(markup({ id: "t", hint: "40字まで" }), "input", "aria-describedby"),
    ).toBe("t-hint");
  });

  test("renders the problem under its own id", () => {
    expect(markup({ id: "t", problem: "必須です" })).toContain(
      '<p id="t-problem" class="text-small text-destructive">必須です</p>',
    );
  });

  test("describes the control by the problem", () => {
    expect(
      attr(
        markup({ id: "t", problem: "必須です" }),
        "input",
        "aria-describedby",
      ),
    ).toBe("t-problem");
  });

  test("marks the control invalid when there is a problem", () => {
    expect(
      attr(markup({ id: "t", problem: "必須です" }), "input", "aria-invalid"),
    ).toBe("true");
  });

  test("describes the control by the hint then the problem", () => {
    expect(
      attr(
        markup({ id: "t", hint: "40字まで", problem: "必須です" }),
        "input",
        "aria-describedby",
      ),
    ).toBe("t-hint t-problem");
  });

  test("renders the counter under its own id", () => {
    expect(markup({ id: "t", counter: "0 / 5文字" })).toMatch(
      /<p id="t-counter"[^>]*>0 \/ 5文字<\/p>/,
    );
  });

  test("describes the control by the counter", () => {
    expect(
      attr(
        markup({ id: "t", counter: "0 / 5文字" }),
        "input",
        "aria-describedby",
      ),
    ).toBe("t-counter");
  });

  test("describes the control by the hint, the counter, then the problem", () => {
    expect(
      attr(
        markup({
          id: "t",
          hint: "40字まで",
          counter: "0 / 5文字",
          problem: "必須です",
        }),
        "input",
        "aria-describedby",
      ),
    ).toBe("t-hint t-counter t-problem");
  });

  test("does not mark the control invalid by the counter alone", () => {
    expect(
      attr(markup({ id: "t", counter: "0 / 5文字" }), "input", "aria-invalid"),
    ).toBeNull();
  });

  test("renders no counter element without a counter", () => {
    expect(markup({ id: "t", hint: "40字まで" })).not.toContain("t-counter");
  });

  test("keeps the hint, the problem and the counter in one row", () => {
    expect(
      markup({ id: "t", problem: "必須です", counter: "0 / 5文字" }),
    ).toContain(
      '<div class="flex flex-wrap items-baseline justify-between gap-2">',
    );
  });

  test("sizes the form label as body text in medium weight", () => {
    expect(attr(markup(), "label", "class")).toBe("text-body font-medium");
  });

  test("sizes the filter label as small muted text", () => {
    expect(attr(markup({ tone: "filter" }), "label", "class")).toBe(
      "text-small text-muted-foreground",
    );
  });

  test("stacks the form field with a 1.5 gap", () => {
    expect(attr(markup(), "div", "class")).toBe("flex flex-col gap-1.5");
  });

  test("stacks the filter field with a 1 gap", () => {
    expect(attr(markup({ tone: "filter" }), "div", "class")).toBe(
      "flex flex-col gap-1",
    );
  });

  test("lets className replace the direction", () => {
    expect(
      attr(
        markup({ tone: "filter", className: "flex-row items-center" }),
        "div",
        "class",
      ),
    ).toBe("flex gap-1 flex-row items-center");
  });
});
