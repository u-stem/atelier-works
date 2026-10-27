import type { PlaceForm } from "../../lib/holdPlace.ts";

export function HoldPlaceDialog(_props: {
  open: boolean;
  variant: "any" | "stop_prepare";
  form: PlaceForm;
  onChange: (next: PlaceForm) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return null;
}

export function HoldPlaceButton(_props: { onClick: () => void }) {
  return null;
}
