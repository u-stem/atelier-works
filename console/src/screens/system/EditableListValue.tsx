import type { ReactElement } from "react";
import { Button } from "../../components/ui/button.tsx";
import type { ChangeOffer } from "../../lib/configChange.ts";

export function ListChangeButton(_props: {
  offer: Extract<ChangeOffer, { kind: "add" | "remove" }>;
  locked: boolean;
  onChoose: (offer: ChangeOffer) => void;
}): ReactElement {
  return <Button variant="outline" size="sm" />;
}
