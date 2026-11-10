import type { ConfigItemView, DesignStageView } from "../../api/jobsQueries.ts";
import type { ChangeOffer } from "../../lib/configChange.ts";

export function ConfigSwitchTable(_props: {
  items: readonly ConfigItemView[];
  designStage: DesignStageView | undefined;
  onChoose: (offer: ChangeOffer) => void;
  isLocked: (offer: ChangeOffer) => boolean;
}) {
  return null;
}
