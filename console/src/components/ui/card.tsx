import type { ComponentProps } from "react";

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

type CardProps = ComponentProps<"div"> & {
  tag?: CardTag;
  variant?: "default" | "list" | "empty";
  padding?: "none" | "frame" | "compact" | "default" | "spacious";
};

function Card(_props: CardProps) {
  return null;
}

export type { CardProps, CardTag };
export { Card };
