// Renders a requirements document's markdown body with a
// "Confluence-document" look: headings/tables/lists/blockquotes via
// react-markdown + remark-gfm, sanitized by rehype-sanitize so no HTML in
// the source (which ultimately traces back to untrusted GitHub Issue
// content summarized by Claude — see f/factory/lib/drawio.ts's own "never
// trust into Markdown unescaped" note for the sibling case) can inject a
// script or an `href`/`src` with a dangerous protocol. This never uses
// `dangerouslySetInnerHTML`: react-markdown turns the sanitized hast tree
// into React elements directly.
//
// An embedded diagram reference (`![name](name.drawio)`, the drawio-diagram
// skill's contract — see f/factory/lib/requirements_template.ts's
// `DIAGRAM_REF_PATTERN`) is intercepted by the `img` component override and
// rendered inline via DrawioViewer instead of as a broken `<img>` (no
// `name.drawio` URL is ever fetchable — it names a file that only exists on
// the worker's disk). `diagrams` supplies the XML this component looks up
// by name; a reference to a name not in that list renders a "not found"
// placeholder rather than a blank/broken image.

import React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { slugify } from "../lib/extractHeadings";
import { ALERT_LABELS, stripAlertMarker } from "../lib/markdownAlerts";
import type { RequirementsDiagram } from "../lib/types";
import { DrawioViewer } from "./DrawioViewer";

// Same naming contract as the generation side
// (requirements_template.ts's DIAGRAM_NAME_PATTERN / DIAGRAM_REF_PATTERN):
// lowercase alphanumeric and hyphens, ending in `.drawio`.
const DRAWIO_IMG_SRC_PATTERN = /^[a-z0-9-]{1,64}\.drawio$/;

// Extends the default (GitHub-style) sanitize schema with exactly one
// allowance: an `img`'s `src` may be a bare `<name>.drawio` relative
// filename. The default schema's own unrestricted `'src'` entry is dropped
// (not merged) for `img` — a bare `'src'` string means "any value passes",
// which would also accept an `http(s)://...` image URL the requirements
// pipeline never produces; restricting to the one shape this document
// actually uses keeps the allowance no broader than the contract requires.
// `javascript:`/`data:` URLs are already rejected two ways here: they don't
// match this pattern, and (independently) the schema's own
// `protocols.src = ['http', 'https']` check runs before any attribute
// allow-list and only exempts protocol-less (relative) values.
// Derived from rehypeSanitize's own parameter type (rather than importing
// hast-util-sanitize directly, which is only a transitive dependency here)
// so this literal is checked against the real `Schema` shape.
type SanitizeSchema = NonNullable<Parameters<typeof rehypeSanitize>[0]>;

const schema: SanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    img: [["src", DRAWIO_IMG_SRC_PATTERN]],
  },
};

function isChildrenProp(
  value: unknown,
): value is { children?: React.ReactNode } {
  return typeof value === "object" && value !== null && "children" in value;
}

/** Flattens rendered children back into plain text (pure-ish: only reads
 * React's own element tree) — used to derive a heading's slug the same way
 * lib/extractHeadings.ts's `extractHeadings` derives it from raw markdown,
 * so a table-of-contents link always resolves (see that module's doc
 * comment on why the two computations agree). */
function childrenText(children: React.ReactNode): string {
  return React.Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") {
        return String(child);
      }
      if (React.isValidElement(child) && isChildrenProp(child.props)) {
        return childrenText(child.props.children ?? null);
      }
      return "";
    })
    .join("");
}

const components: Components = {
  h1: ({ children }) => <h1>{children}</h1>,
  h2: ({ children }) => {
    const id = slugify(childrenText(children));
    return <h2 id={id}>{children}</h2>;
  },
  h3: ({ children }) => {
    const id = slugify(childrenText(children));
    return <h3 id={id}>{children}</h3>;
  },
  table: ({ children }) => (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  ),
  blockquote: ({ children }) => {
    const items = React.Children.toArray(children);
    const first = items[0];
    if (
      React.isValidElement(first) &&
      isChildrenProp(first.props) &&
      typeof first.props.children === "string"
    ) {
      const stripped = stripAlertMarker(first.props.children);
      if (stripped !== null) {
        const kind = stripped.kind;
        return (
          <div className={`md-panel md-panel-${kind}`}>
            <p className="md-panel-label">{ALERT_LABELS[kind]}</p>
            <p>{stripped.rest}</p>
            {items.slice(1)}
          </div>
        );
      }
    }
    return <blockquote>{children}</blockquote>;
  },
  img: ({ src, alt }) => {
    if (src === undefined || !DRAWIO_IMG_SRC_PATTERN.test(src)) {
      return <span className="md-diagram-invalid">{alt ?? src}</span>;
    }
    const name = src.slice(0, -".drawio".length);
    return <DiagramSlot name={name} />;
  },
  p: ({ node, children }) => {
    // A paragraph containing only a diagram image renders the viewer
    // directly (via the `img` override above) instead of nesting it inside
    // a <p> — DrawioViewer's own container is a <div>, and a <div> is not
    // valid inside a <p> in the DOM.
    const soleChild = node?.children.length === 1 ? node.children[0] : null;
    if (
      soleChild !== undefined &&
      soleChild !== null &&
      soleChild.type === "element" &&
      soleChild.tagName === "img"
    ) {
      return <>{children}</>;
    }
    return <p>{children}</p>;
  },
};

/** Renders `img`'s diagram lookup against the `diagrams` prop passed down
 * from `Markdown` — implemented as a tiny wrapper component (rather than a
 * closure captured per-render in `components`) so `Markdown` can pass
 * `diagrams` through React context without rebuilding the whole
 * `components` map on every render. */
const DiagramsContext = React.createContext<readonly RequirementsDiagram[]>([]);

function DiagramSlot({ name }: { name: string }): React.ReactElement {
  const diagrams = React.useContext(DiagramsContext);
  const diagram = diagrams.find((candidate) => candidate.name === name);
  if (diagram === undefined) {
    return <p className="md-diagram-missing">図 {name} が見つかりません</p>;
  }
  return <DrawioViewer name={diagram.name} xml={diagram.xml} />;
}

export function Markdown({
  markdown,
  diagrams = [],
}: {
  markdown: string;
  diagrams?: readonly RequirementsDiagram[];
}): React.ReactElement {
  return (
    <DiagramsContext.Provider value={diagrams}>
      <div className="markdown">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeSanitize, schema]]}
          components={components}
        >
          {markdown}
        </ReactMarkdown>
      </div>
    </DiagramsContext.Provider>
  );
}
