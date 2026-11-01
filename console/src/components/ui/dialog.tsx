import type { ComponentProps, Ref } from "react";

type DialogProps = Omit<
  ComponentProps<"dialog">,
  "open" | "onClose" | "ref"
> & {
  open: boolean;
  onOpened?: () => void;
  onClose: () => void;
  placement?: "center" | "top";
  ref?: Ref<HTMLDialogElement>;
};

function Dialog(_props: DialogProps) {
  return null;
}

export type { DialogProps };
export { Dialog };
