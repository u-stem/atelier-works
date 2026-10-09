import { describe, expect, test } from "bun:test";
import { type ReferenceElement, referencedUrls } from "./referencedUrls.ts";

const BASE = "https://factory.example/console/";

function element(
  tagName: string,
  attributes: Record<string, string>,
): ReferenceElement {
  return {
    tagName,
    getAttribute: (name) => attributes[name] ?? null,
  };
}

function urls(...elements: ReferenceElement[]): string[] {
  return referencedUrls({ querySelectorAll: () => elements }, BASE);
}

describe("referencedUrls", () => {
  test("queries script and link elements", () => {
    const selectors: string[] = [];
    referencedUrls(
      {
        querySelectorAll: (selector) => {
          selectors.push(selector);
          return [];
        },
      },
      BASE,
    );
    expect(selectors).toEqual(["script, link"]);
  });

  test("collects the src of a script", () => {
    expect(urls(element("SCRIPT", { src: "/console/assets/a.js" }))).toEqual([
      "https://factory.example/console/assets/a.js",
    ]);
  });

  test("collects the href of a stylesheet", () => {
    expect(
      urls(
        element("LINK", { rel: "stylesheet", href: "/console/assets/a.css" }),
      ),
    ).toEqual(["https://factory.example/console/assets/a.css"]);
  });

  test("collects the href of a modulepreload", () => {
    expect(
      urls(
        element("LINK", { rel: "modulepreload", href: "/console/assets/b.js" }),
      ),
    ).toEqual(["https://factory.example/console/assets/b.js"]);
  });

  test("collects a link whose rel has several tokens", () => {
    expect(
      urls(
        element("LINK", {
          rel: "preload stylesheet",
          href: "/console/assets/c.css",
        }),
      ),
    ).toEqual(["https://factory.example/console/assets/c.css"]);
  });

  test("skips a script without src", () => {
    expect(urls(element("SCRIPT", {}))).toEqual([]);
  });

  test("skips a link that is neither a stylesheet nor a modulepreload", () => {
    expect(
      urls(element("LINK", { rel: "icon", href: "/console/assets/i.svg" })),
    ).toEqual([]);
  });

  test("skips a link without rel", () => {
    expect(urls(element("LINK", { href: "/console/assets/x.css" }))).toEqual(
      [],
    );
  });

  test("skips a stylesheet without href", () => {
    expect(urls(element("LINK", { rel: "stylesheet" }))).toEqual([]);
  });

  test("skips an element that is not a script or a link", () => {
    expect(urls(element("IMG", { src: "/console/assets/a.png" }))).toEqual([]);
  });

  test("resolves a relative URL against the base", () => {
    expect(urls(element("SCRIPT", { src: "assets/a.js" }))).toEqual([
      "https://factory.example/console/assets/a.js",
    ]);
  });

  test("keeps an absolute URL of another origin", () => {
    expect(
      urls(element("SCRIPT", { src: "https://cdn.example/x.js" })),
    ).toEqual(["https://cdn.example/x.js"]);
  });

  test("returns an empty list for no elements", () => {
    expect(urls()).toEqual([]);
  });
});
