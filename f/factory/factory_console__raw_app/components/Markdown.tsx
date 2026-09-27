// A small, safe subset-of-Markdown renderer for requirement drafts.
//
// This never uses `dangerouslySetInnerHTML`: every piece of text ends up as
// a React child (auto-escaped), so nothing in the source markdown — which
// ultimately traces back to untrusted GitHub Issue content summarized by
// Claude (see f/factory/lib/drawio.ts's own "never trust into Markdown
// unescaped" note for the sibling case) — can inject HTML/script. The only
// interpreted attribute is a link's `href`, and only when it matches
// `https?://` (see LINK_PATTERN below), so a `javascript:` URL can never
// reach an anchor tag.
//
// Supported subset: `#`/`##`/`###` headings, `-`/`*` bullet lists, and
// inline `**bold**` / `` `code` `` / `[text](https://...)` links — enough
// for the "## 要約" / "## 未確定事項" shape pipeline_generate.ts's prompts
// produce (see .claude/skills/factory-requirements/SKILL.md). Anything else
// renders as a plain paragraph.

import React from "react";

const INLINE_PATTERN =
  /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let index = 0;
  INLINE_PATTERN.lastIndex = 0;
  let match = INLINE_PATTERN.exec(text);
  while (match !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const [whole, bold, code, linkText, linkUrl] = match;
    if (bold !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-${index}`}>{bold}</strong>);
    } else if (code !== undefined) {
      nodes.push(<code key={`${keyPrefix}-${index}`}>{code}</code>);
    } else if (linkText !== undefined && linkUrl !== undefined) {
      nodes.push(
        <a
          key={`${keyPrefix}-${index}`}
          href={linkUrl}
          target="_blank"
          rel="noreferrer"
        >
          {linkText}
        </a>,
      );
    }
    lastIndex = match.index + whole.length;
    index += 1;
    match = INLINE_PATTERN.exec(text);
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

type Block =
  | { readonly type: "h1" | "h2" | "h3"; readonly text: string }
  | { readonly type: "ul"; readonly items: string[] }
  | { readonly type: "p"; readonly text: string };

const BULLET_PATTERN = /^[-*]\s+/;
const H3_PATTERN = /^###\s+/;
const H2_PATTERN = /^##\s+/;
const H1_PATTERN = /^#\s+/;

function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of markdown.split(/\n{2,}/)) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const lines = trimmed.split("\n").map((line) => line.trim());
    if (lines.every((line) => BULLET_PATTERN.test(line))) {
      blocks.push({
        type: "ul",
        items: lines.map((line) => line.replace(BULLET_PATTERN, "")),
      });
      continue;
    }
    if (H3_PATTERN.test(trimmed)) {
      blocks.push({ type: "h3", text: trimmed.replace(H3_PATTERN, "") });
      continue;
    }
    if (H2_PATTERN.test(trimmed)) {
      blocks.push({ type: "h2", text: trimmed.replace(H2_PATTERN, "") });
      continue;
    }
    if (H1_PATTERN.test(trimmed)) {
      blocks.push({ type: "h1", text: trimmed.replace(H1_PATTERN, "") });
      continue;
    }
    blocks.push({ type: "p", text: trimmed });
  }
  return blocks;
}

export function Markdown({ text }: { text: string }): React.ReactElement {
  const blocks = parseBlocks(text);
  return (
    <div className="markdown">
      {blocks.map((block, blockIndex) => {
        const key = `block-${blockIndex}`;
        switch (block.type) {
          case "ul":
            return (
              <ul key={key}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${item}`}>
                    {renderInline(item, `${key}-${itemIndex}`)}
                  </li>
                ))}
              </ul>
            );
          case "h1":
            return <h1 key={key}>{renderInline(block.text, key)}</h1>;
          case "h2":
            return <h2 key={key}>{renderInline(block.text, key)}</h2>;
          case "h3":
            return <h3 key={key}>{renderInline(block.text, key)}</h3>;
          default:
            return <p key={key}>{renderInline(block.text, key)}</p>;
        }
      })}
    </div>
  );
}
