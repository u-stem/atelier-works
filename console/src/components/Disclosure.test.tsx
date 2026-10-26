import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JUMP_OPEN_ATTRIBUTE } from "../lib/sectionJump.ts";
import { Disclosure } from "./Disclosure.tsx";

function render(props: { jumpOpen?: boolean; initiallyOpen?: boolean } = {}) {
  return renderToStaticMarkup(
    <Disclosure summary="履歴(3件)" {...props}>
      <p>本文</p>
    </Disclosure>,
  );
}

describe("Disclosure", () => {
  test("is a details element", () => {
    expect(render()).toMatch(/^<details/);
  });

  test("shows the summary line", () => {
    expect(render()).toMatch(/<summary[^>]*>.*履歴\(3件\)/);
  });

  test("is closed by default", () => {
    expect(render()).not.toMatch(/^<details[^>]* open/);
  });

  test("can start open", () => {
    expect(render({ initiallyOpen: true })).toMatch(/^<details[^>]* open/);
  });

  test("keeps the body in the markup while closed", () => {
    expect(render()).toContain("本文");
  });

  test("carries the jump attribute when asked", () => {
    expect(render({ jumpOpen: true })).toContain(`${JUMP_OPEN_ATTRIBUTE}=""`);
  });

  test("does not carry the jump attribute by default", () => {
    expect(render()).not.toContain(JUMP_OPEN_ATTRIBUTE);
  });

  test("draws an arrow that screen readers skip", () => {
    expect(render()).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  test("shows a focus ring on the summary", () => {
    expect(render()).toContain("focus-visible:ring-2");
  });
});
