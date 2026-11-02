import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Field } from "./NewItemScreen.tsx";

function draw(hint?: string, problem?: string): string {
  return renderToStaticMarkup(
    <Field id="x" label="題名" hint={hint} problem={problem}>
      {(describedBy) => <input id="x" aria-describedby={describedBy} />}
    </Field>,
  );
}

describe("Field", () => {
  test("ties the hint to the input", () => {
    expect(draw("補足")).toContain('aria-describedby="x-hint"');
  });

  test("ties the problem to the input", () => {
    expect(draw(undefined, "誤り")).toContain('aria-describedby="x-problem"');
  });

  test("ties both the hint and the problem to the input", () => {
    expect(draw("補足", "誤り")).toContain(
      'aria-describedby="x-hint x-problem"',
    );
  });

  test("ties nothing when there is neither", () => {
    expect(draw()).not.toContain("aria-describedby");
  });

  test("gives the hint the id that the input points to", () => {
    expect(draw("補足")).toContain('id="x-hint"');
  });

  test("gives the problem the id that the input points to", () => {
    expect(draw(undefined, "誤り")).toContain('id="x-problem"');
  });

  test("still takes plain children", () => {
    expect(
      renderToStaticMarkup(
        <Field id="y" label="題名">
          <input id="y" />
        </Field>,
      ),
    ).toContain('<input id="y"/>');
  });
});
