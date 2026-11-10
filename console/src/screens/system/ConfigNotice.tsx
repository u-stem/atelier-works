import type { ReleaseNotice } from "../../lib/writeNotices.ts";

export const CONFIG_NOTICE_TITLE_ID = "config-notice-title";

export function ConfigNotice(_props: {
  item: string;
  notice: ReleaseNotice;
  onClose: () => void;
}) {
  return null;
}
