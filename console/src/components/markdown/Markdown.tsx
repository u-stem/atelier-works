// 要件定義書のMarkdown本文を描く。
// 元の文章は、信頼できないGitHubのIssueの内容をClaudeが要約したものに由来する。
// そのため、見出し・表・リスト・引用は`react-markdown`と`remark-gfm`で描き、
// `rehype-sanitize`で無害化する。生のHTMLは描かず、`dangerouslySetInnerHTML`も使わない。
// `react-markdown`が無害化済みのhastの木を、直接Reactの要素にする。
//
// リンクは`a`の差し替えで絞る。`rehype-sanitize`の既定は任意の`http(s)`のURLを通すので、
// リンクにするのは、作業項目と同じリポジトリのIssueとPRのURLと、同じページの見出しだけにする
// (`lib/markdownLink.ts`)。それ以外は文字で出す。
// リンクの文字とURLが違うときは、読み手が行き先を判断できるようにURLも添える。
// 添えたURLは、文字の向きを変える制御文字で周りの表示を崩さないよう、`<bdi>`で包む。
//
// 図の参照(`![name](name.drawio)`)は`img`の差し替えで受け取り、壊れた`<img>`ではなく
// `DrawioFrame`で描く。`name.drawio`はworkerのディスクにだけあるファイル名で、URLとして取得できない。
// 図のXMLは`diagrams`から名前で引く。安全の検査を通らず落とした図は、
// 「見つからない」とは別の文で「表示しません」と出す。
//
// 見出しの`id`は、見出しの行から`headings`を引いて付ける(`lib/markdownHeadings.ts`)。
// 目次のリンクと本文のリンクが、同じ`id`を指す。

import {
  Children,
  createContext,
  isValidElement,
  type ReactNode,
  useContext,
  useMemo,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { RequirementsDiagram } from "../../api/guards/requirements.ts";
import { cn } from "../../lib/cn.ts";
import { ALERT_LABELS, stripAlertMarker } from "../../lib/markdownAlerts.ts";
import { type Heading, headingIdAtLine } from "../../lib/markdownHeadings.ts";
import { type RepoRef, resolveMarkdownLink } from "../../lib/markdownLink.ts";
import {
  DRAWIO_IMAGE_SRC,
  diagramSlotState,
} from "../../lib/requirementsView.ts";
import { DrawioFrame } from "../drawio/DrawioFrame.tsx";

/**
 * 無害化のスキーマの型。`hast-util-sanitize`は推移的な依存でしかないので
 * 直接importせず、`rehypeSanitize`の引数の型から導く。
 */
type SanitizeSchema = NonNullable<Parameters<typeof rehypeSanitize>[0]>;

/**
 * 既定(GitHub風)の無害化スキーマに、許可を1つだけ足したもの。
 * `img`の`src`に、相対のファイル名`<name>.drawio`だけを許す。
 * 既定の`img`の`src`は混ぜずに捨てる。裸の`src`はどんな値でも通すので、
 * 要件定義の生成が作らない`http(s)://...`の画像URLまで受け入れてしまうためである。
 * `javascript:`と`data:`のURLは、この形に合わないうえ、
 * スキーマの`protocols.src`(`http`と`https`)の検査にも通らない。
 */
const schema: SanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    img: [["src", DRAWIO_IMAGE_SRC]],
  },
};

function hasChildren(value: unknown): value is { children?: ReactNode } {
  return typeof value === "object" && value !== null && "children" in value;
}

/** 描画済みの子要素を平文に戻す(Reactの要素の木を読むだけ)。リンクの文字との比較に使う。 */
function childrenText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") {
        return String(child);
      }
      if (isValidElement(child) && hasChildren(child.props)) {
        return childrenText(child.props.children ?? null);
      }
      return "";
    })
    .join("");
}

type MarkdownContextValue = {
  readonly headings: readonly Heading[];
  /** 本文では描かないタイトルの行。ページの見出しに出しているため。 */
  readonly hiddenTitleLine: number | null;
  readonly diagrams: readonly RequirementsDiagram[];
  readonly rejectedDiagrams: readonly string[];
  readonly repo: RepoRef | null;
};

/**
 * 描画の入力を、差し替えた部品に届ける。
 * `components`を描画のたびに作り直すと、図のiframeが作り直されるため、部品は固定にして文脈で渡す。
 */
const MarkdownContext = createContext<MarkdownContextValue>({
  headings: [],
  hiddenTitleLine: null,
  diagrams: [],
  rejectedDiagrams: [],
  repo: null,
});

const LINK_CLASS =
  "rounded-sm font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring";

function MarkdownAnchor({
  href,
  children,
}: {
  href: string | undefined;
  children: ReactNode;
}) {
  const { repo } = useContext(MarkdownContext);
  const link = resolveMarkdownLink(href, childrenText(children), repo);
  const note =
    link.note === null ? null : (
      <span className="text-muted-foreground">
        {" ("}
        <bdi>{link.note}</bdi>
        {")"}
      </span>
    );
  if (link.kind === "text") {
    return (
      <span className="text-muted-foreground">
        {children}
        {note}
      </span>
    );
  }
  return (
    <>
      <a
        href={link.href}
        className={LINK_CLASS}
        {...(link.external
          ? { target: "_blank", rel: "noopener noreferrer" }
          : {})}
      >
        {children}
      </a>
      {note}
    </>
  );
}

function DiagramSlot({ name }: { name: string }) {
  const { diagrams, rejectedDiagrams } = useContext(MarkdownContext);
  const state = diagramSlotState(name, diagrams, rejectedDiagrams);
  if (state.status === "rejected") {
    return (
      <p role="alert" className="my-4 text-small text-destructive">
        図 {name} は安全の検査を通らなかったので表示しません
      </p>
    );
  }
  if (state.status === "missing") {
    return (
      <p className="my-4 text-small text-muted-foreground">
        図 {name} が見つかりません
      </p>
    );
  }
  return (
    <figure className="my-6 flex flex-col gap-2">
      <DrawioFrame xml={state.xml} title={`図 ${name}`} />
      <figcaption className="text-caption text-subtle">図 {name}</figcaption>
    </figure>
  );
}

const H2_CLASS =
  "mt-10 mb-3 scroll-mt-4 border-t border-border pt-6 text-title font-semibold tracking-tight first:mt-0 first:border-t-0 first:pt-0";
const H3_CLASS = "mt-6 mb-2 scroll-mt-4 text-lead font-semibold tracking-tight";

/** 要素が始まるMarkdownの行。位置を持たない要素では`undefined`。 */
function startLine(
  node: { position?: { start: { line: number } } | undefined } | undefined,
): number | undefined {
  return node?.position?.start.line;
}

function SectionHeading({
  level,
  line,
  children,
}: {
  level: 2 | 3;
  line: number | undefined;
  children: ReactNode;
}) {
  const { headings } = useContext(MarkdownContext);
  const id = headingIdAtLine(headings, line) ?? undefined;
  return level === 2 ? (
    <h2 id={id} className={H2_CLASS}>
      {children}
    </h2>
  ) : (
    <h3 id={id} className={H3_CLASS}>
      {children}
    </h3>
  );
}

function TitleHeading({
  line,
  children,
}: {
  line: number | undefined;
  children: ReactNode;
}) {
  const { hiddenTitleLine } = useContext(MarkdownContext);
  if (line !== undefined && line === hiddenTitleLine) {
    return null;
  }
  return <h2 className={H2_CLASS}>{children}</h2>;
}

/** 図の参照だけを含む段落かを返す。 */
function isSoleImage(
  node: { children: readonly { type: string; tagName?: string }[] } | undefined,
): boolean {
  const only = node?.children.length === 1 ? node.children[0] : undefined;
  return only?.type === "element" && only.tagName === "img";
}

const components: Components = {
  a: ({ href, children }) => (
    <MarkdownAnchor href={href}>{children}</MarkdownAnchor>
  ),
  h1: ({ node, children }) => (
    <TitleHeading line={startLine(node)}>{children}</TitleHeading>
  ),
  h2: ({ node, children }) => (
    <SectionHeading level={2} line={startLine(node)}>
      {children}
    </SectionHeading>
  ),
  h3: ({ node, children }) => (
    <SectionHeading level={3} line={startLine(node)}>
      {children}
    </SectionHeading>
  ),
  h4: ({ children }) => (
    <h4 className="mt-5 mb-2 text-body font-semibold">{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="mt-4 mb-2 text-body font-semibold">{children}</h5>
  ),
  h6: ({ children }) => (
    <h6 className="mt-4 mb-2 text-body font-semibold text-muted-foreground">
      {children}
    </h6>
  ),
  p: ({ node, children }) =>
    isSoleImage(node) ? <>{children}</> : <p className="my-3">{children}</p>,
  ul: ({ children }) => (
    <ul className="my-3 list-disc space-y-1 pl-6">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-3 list-decimal space-y-1 pl-6">{children}</ol>
  ),
  li: ({ children }) => <li className="pl-1">{children}</li>,
  hr: () => <hr className="my-6 border-border" />,
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  code: ({ children }) => (
    <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.92em] break-words">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="my-4 overflow-x-auto rounded-lg bg-muted px-4 py-3 font-mono text-small [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto">
      <table className="w-full border-collapse text-small">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border bg-muted px-3 py-1.5 text-left align-top font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-border px-3 py-1.5 align-top">{children}</td>
  ),
  blockquote: ({ children }) => {
    // 子の先頭には、段落の前の改行の文字列が入るので、最初の要素を探す。
    const items = Children.toArray(children);
    const firstIndex = items.findIndex((item) => isValidElement(item));
    const first = items[firstIndex];
    if (
      isValidElement(first) &&
      hasChildren(first.props) &&
      typeof first.props.children === "string"
    ) {
      const stripped = stripAlertMarker(first.props.children);
      if (stripped !== null) {
        return (
          <div
            className={cn(
              "my-4 rounded-lg border-l-4 px-4 py-2.5",
              stripped.kind === "note" && "border-approval bg-approval/10",
              stripped.kind === "warning" && "border-warning bg-warning/10",
              stripped.kind === "important" && "border-primary bg-primary/10",
            )}
          >
            <p className="text-caption font-bold tracking-wider text-muted-foreground">
              {ALERT_LABELS[stripped.kind]}
            </p>
            <p>{stripped.rest}</p>
            {items.slice(firstIndex + 1)}
          </div>
        );
      }
    }
    return (
      <blockquote className="my-4 border-l-4 border-border pl-4 text-muted-foreground">
        {children}
      </blockquote>
    );
  },
  img: ({ src, alt }) => {
    if (src === undefined || !DRAWIO_IMAGE_SRC.test(src)) {
      return <span className="text-muted-foreground">{alt ?? src}</span>;
    }
    return <DiagramSlot name={src.slice(0, -".drawio".length)} />;
  },
};

type MarkdownProps = {
  /** 画面に出せる形にした本文。 */
  readonly markdown: string;
  readonly headings: readonly Heading[];
  /** 本文では描かないタイトルの行。 */
  readonly hiddenTitleLine?: number | null;
  readonly diagrams: readonly RequirementsDiagram[];
  /** 安全の検査を通らず、表示しない図の名前。 */
  readonly rejectedDiagrams: readonly string[];
  /** 本文が属する作業項目のリポジトリ。このリポジトリのIssueとPRのURLだけをリンクにする。 */
  readonly repo: RepoRef;
};

export function Markdown({
  markdown,
  headings,
  hiddenTitleLine = null,
  diagrams,
  rejectedDiagrams,
  repo,
}: MarkdownProps) {
  const value = useMemo(
    () => ({ headings, hiddenTitleLine, diagrams, rejectedDiagrams, repo }),
    [headings, hiddenTitleLine, diagrams, rejectedDiagrams, repo],
  );
  return (
    <MarkdownContext.Provider value={value}>
      <div className="text-body break-words text-foreground">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeSanitize, schema]]}
          components={components}
        >
          {markdown}
        </ReactMarkdown>
      </div>
    </MarkdownContext.Provider>
  );
}
