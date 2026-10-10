// 要件定義書のMarkdown本文を、Confluenceの文書のような見た目で描く。
// 見出し・表・リスト・引用は`react-markdown`と`remark-gfm`で描き、
// `rehype-sanitize`で無害化する。元の文章は、信頼できないGitHubのIssueの
// 内容をClaudeが要約したものに由来するため、HTMLでスクリプトや危険な
// プロトコルの`href`・`src`を差し込めないようにする
// (同種の注意は`f/factory/lib/drawio.ts`にもある)。
// リンクは`a`の差し替えで絞る。`rehype-sanitize`の既定は任意の`http(s)`の
// URLを通すので、リンクにするのはGitHubのIssueとPRのURLと、同じページの
// 見出しへのフラグメントだけにする(`lib/markdownLink.ts`)。それ以外は
// リンクにせず文字で出す。リンクの文字とURLが違うときは、読み手が
// 行き先を判断できるようにURLも添える。
// `dangerouslySetInnerHTML`は使わない。`react-markdown`が無害化済みの
// hastの木を直接Reactの要素にする。
//
// 埋め込みの図の参照(`![name](name.drawio)`。drawio-diagramスキルの約束で、
// `f/factory/lib/requirements_template.ts`の`DIAGRAM_REF_PATTERN`を参照)は、
// `img`の差し替えで受け取り、壊れた`<img>`ではなく`DrawioViewer`で描く。
// `name.drawio`はworkerのディスクにだけあるファイル名で、URLとして取得できない。
// XMLは`diagrams`から名前で引き、一覧に無い名前は、空や壊れた画像ではなく
// 「見つからない」という表示にする。

import React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { slugify } from "../lib/extractHeadings";
import { ALERT_LABELS, stripAlertMarker } from "../lib/markdownAlerts";
import { resolveMarkdownLink } from "../lib/markdownLink";
import type { RequirementsDiagram } from "../lib/types";
import { DrawioViewer } from "./DrawioViewer";

/**
 * 図のファイル名の形。生成側(`requirements_template.ts`の
 * `DIAGRAM_NAME_PATTERN`・`DIAGRAM_REF_PATTERN`)と同じく、
 * 英小文字・数字・ハイフンで、`.drawio`で終わる。
 */
const DRAWIO_IMG_SRC_PATTERN = /^[a-z0-9-]{1,64}\.drawio$/;

/**
 * 無害化のスキーマの型。`hast-util-sanitize`は推移的な依存でしかないので
 * 直接importせず、`rehypeSanitize`の引数の型から導く。
 * こうして下のリテラルを本物の`Schema`の形で型検査する。
 */
type SanitizeSchema = NonNullable<Parameters<typeof rehypeSanitize>[0]>;

/**
 * 既定(GitHub風)の無害化スキーマに、許可を1つだけ足したもの。
 * `img`の`src`に、相対のファイル名`<name>.drawio`だけを許す。
 * `img`については既定の無制限の`'src'`を混ぜずに捨てる。裸の`'src'`は
 * どんな値でも通すので、要件定義のパイプラインが作らない
 * `http(s)://...`の画像URLまで受け入れてしまうため。許可は、この文書が
 * 実際に使う1つの形に絞り、約束より広げない。
 * `javascript:`・`data:`のURLは2重に拒否される。このパターンに合わないうえ、
 * それとは別に、スキーマの`protocols.src = ['http', 'https']`の検査が
 * 属性の許可より先に動き、プロトコルの無い(相対の)値だけを通す。
 */
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

/**
 * 描画済みの子要素を平文に戻して返す(Reactの要素の木を読むだけ)。
 * 見出しのslugを、`lib/extractHeadings.ts`の`extractHeadings`が元の
 * Markdownから導くのと同じ方法で導き、目次のリンクが必ず飛べるようにする
 * (2つの計算が一致する理由はそのモジュールのコメントを参照)。
 */
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
  a: ({ href, children }) => {
    const link = resolveMarkdownLink(href, childrenText(children));
    const note =
      link.note === null ? null : (
        <span className="md-link-url"> ({link.note})</span>
      );
    if (link.kind === "text") {
      return (
        <span className="md-link-disabled">
          {children}
          {note}
        </span>
      );
    }
    return (
      <>
        <a
          href={link.href}
          {...(link.external
            ? { target: "_blank", rel: "noopener noreferrer" }
            : {})}
        >
          {children}
        </a>
        {note}
      </>
    );
  },
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
    // 図の画像だけを含む段落は、`<p>`で包まず(上の`img`の差し替えで)
    // ビューアを直接描く。`DrawioViewer`の入れ物は`<div>`で、DOMでは
    // `<p>`の中に`<div>`を置けないため。
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

/**
 * `Markdown`に渡された`diagrams`を、`img`の図の検索に届けるcontext。
 * 描画のたびに`components`の中でクロージャを作らず、小さな包む
 * コンポーネント(`DiagramSlot`)とcontextで渡すことで、描画ごとに
 * `components`全体を作り直さずに済む。
 */
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
