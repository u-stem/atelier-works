// 実行ログの要約のように、インラインのコード(`code`)だけを含む短い文章を描く。
// 元の文章は信頼できない入力に由来するので、許す要素は段落とコードだけに絞る。
// 見出し、リスト、強調、リンク、画像は要素にせず、中の文字だけを残す。
// 生のHTMLは`rehype-raw`を使わないので要素にならず、
// `rehype-sanitize`は許す要素を絞る二重の防御である。
// `dangerouslySetInnerHTML`は使わない。

import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

const ALLOWED_ELEMENTS: readonly string[] = ["p", "code"];

type SanitizeSchema = NonNullable<Parameters<typeof rehypeSanitize>[0]>;

const schema: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [...ALLOWED_ELEMENTS],
};

const COMPONENTS: Components = {
  p: ({ children }) => <p className="whitespace-pre-wrap">{children}</p>,
  code: ({ children }) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-small break-all">
      {children}
    </code>
  ),
};

/** インラインのコードだけを描くMarkdown。段落の改行は保つ。 */
export function InlineCodeMarkdown({ children }: { children: string }) {
  return (
    <div
      dir="ltr"
      className="flex flex-col gap-2 text-body break-words [unicode-bidi:isolate]"
    >
      <ReactMarkdown
        allowedElements={ALLOWED_ELEMENTS}
        unwrapDisallowed
        rehypePlugins={[[rehypeSanitize, schema]]}
        components={COMPONENTS}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
