import {
  Children,
  type ComponentPropsWithoutRef,
  isValidElement,
  type ReactNode,
} from "react";
import ReactMarkdown, {
  type Components,
  type ExtraProps,
} from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { linkNote } from "../../lib/auditMarkdown.ts";
import { cn } from "../../lib/cn.ts";
import { displayableIssueText } from "../../lib/intakeText.ts";

// 監査レポートの本文を描く薄い部品。
// 本文は監査のClaudeが、信頼できない運用記録から書いた文章なので、
// `rehype-raw`を使わないので、本文の生のHTMLは要素にならず、描かずに捨てる。
// `rehype-sanitize`は、変換後の要素と属性を絞る二重の防御である。
// `dangerouslySetInnerHTML`は使わない。
// リンクは張らず、画像は読み込まず、どちらも文字で出す。
// 外のURLを読み込むと、レポートを開いただけで外へ通信が出るためである。

function hasChildren(value: unknown): value is { children?: ReactNode } {
  return typeof value === "object" && value !== null && "children" in value;
}

/** 描画済みの子要素を平文に戻す。リンクの文字とURLを見比べるのに使う。 */
function textOf(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") {
        return String(child);
      }
      if (isValidElement(child) && hasChildren(child.props)) {
        return textOf(child.props.children ?? null);
      }
      return "";
    })
    .join("");
}

function Anchor({
  href,
  children,
}: {
  href: string | undefined;
  children: ReactNode;
}) {
  const note = linkNote(href, textOf(children));
  return (
    <span className="text-muted-foreground underline decoration-dotted underline-offset-2">
      {children}
      {note === null ? null : (
        <span>
          {" ("}
          <bdi>{note}</bdi>
          {")"}
        </span>
      )}
    </span>
  );
}

/** `node`は react-markdown が渡す構文木で、DOMの属性ではないので捨てる。 */
function Pre({
  node: _node,
  className,
  ...props
}: ComponentPropsWithoutRef<"pre"> & ExtraProps) {
  return (
    <pre
      className={cn(
        "my-4 overflow-x-auto rounded-lg bg-muted px-4 py-3 font-mono text-small [&>code]:bg-transparent [&>code]:p-0",
        className,
      )}
      {...props}
    />
  );
}

const COMPONENTS: Components = {
  a: ({ href, children }) => <Anchor href={href}>{children}</Anchor>,
  img: ({ alt }) => (
    <span className="text-muted-foreground">
      (画像は表示しません{alt === undefined || alt === "" ? "" : `: ${alt}`})
    </span>
  ),
  h1: ({ children }) => (
    <h1 className="mt-8 mb-4 text-display font-semibold tracking-tight first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-8 mb-3 border-b border-border pb-2 text-title font-semibold first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-6 mb-2 text-lead font-semibold">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-4 mb-2 text-body font-semibold">{children}</h4>
  ),
  p: ({ children }) => <p className="my-3">{children}</p>,
  ul: ({ children }) => <ul className="my-3 list-disc pl-6">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal pl-6">{children}</ol>,
  li: ({ children }) => <li className="my-1">{children}</li>,
  hr: () => <hr className="my-6 border-border" />,
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  code: ({ children }) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-small">
      {children}
    </code>
  ),
  pre: Pre,
  blockquote: ({ children }) => (
    <blockquote className="my-4 border-l-4 border-border pl-4 text-muted-foreground">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto">
      <table className="w-full border-collapse text-small">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border bg-muted px-3 py-2 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-border px-3 py-2 align-top">{children}</td>
  ),
};

/** 監査レポートのMarkdownを描く。 */
export function AuditMarkdown({ markdown }: { markdown: string }) {
  return (
    <div
      dir="ltr"
      className="break-words text-foreground [unicode-bidi:isolate]"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={COMPONENTS}
      >
        {displayableIssueText(markdown).text}
      </ReactMarkdown>
    </div>
  );
}
