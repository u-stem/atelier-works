import type { ConfigUpdateInput } from "../../api/writes.ts";
import type { ChangeOffer } from "../../lib/configChange.ts";

export function changeInputOf(
  _offer: ChangeOffer,
  _text: string,
): ConfigUpdateInput | null {
  return null;
}
