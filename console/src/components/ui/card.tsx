import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn.ts";

const cardVariants = cva("rounded-xl border", {
  variants: {
    variant: {
      default: "border-border bg-card",
      // 行の区切りは線で引く。行の余白は行が持つので、`padding`は`none`のまま使う。
      list: "divide-y divide-border border-border bg-card",
      // あるはずの面が無いことを伝える。面を塗らず、破線にして、中身のある面と見分ける。空の一覧の標準は、実線の`EmptyNote`である。
      empty: "border-dashed border-border text-small text-muted-foreground",
    },
    // 面の横の余白は`px-5`に固定し、段は縦の余白で分ける。隣り合う面の中身の左端をそろえるためである。
    padding: {
      none: "",
      // 図や表を縁に近づけて収める枠。
      frame: "p-2",
      compact: "px-5 py-3",
      default: "px-5 py-4",
      // 空の知らせを、一覧が入るはずの高さまで広げる。
      spacious: "px-5 py-8",
    },
  },
  defaultVariants: {
    variant: "default",
    padding: "none",
  },
});

type CardTag =
  | "div"
  | "section"
  | "article"
  | "ul"
  | "ol"
  | "li"
  | "dl"
  | "p"
  | "details";

// 要素ごとの型(`ref`など)を持たない共通の属性だけを受ける。描く要素を`tag`で替えても型が合うようにするためである。
type CardProps = HTMLAttributes<HTMLElement> &
  VariantProps<typeof cardVariants> & {
    /** 描く要素。リストや定義リストの意味を保つために選ぶ。 */
    tag?: CardTag;
  };

/**
 * 角丸の枠と面を持つ入れ物。余白は`padding`の段で決め、個別の余白は足さない。
 * 空の知らせ(`variant="empty"`)は、余白を指定しなければ`compact`にする。
 */
function Card({
  tag: Tag = "div",
  variant,
  padding,
  className,
  ...props
}: CardProps) {
  return (
    <Tag
      data-slot="card"
      className={cn(
        cardVariants({
          variant,
          padding: padding ?? (variant === "empty" ? "compact" : "none"),
        }),
        className,
      )}
      {...props}
    />
  );
}

export type { CardProps, CardTag };
export { Card, cardVariants };
