// Pure helpers for 工程5 (audit): period math and labels. Extended in the
// audit-flow PR with evidence collection and kickoff decisions.

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` of `date`'s JST calendar day (fixed UTC+9, no DST). */
export function formatJstDate(date: Date): string {
  const shifted = new Date(date.getTime() + JST_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Human label for a `[start, end)` audit period: the last *included* JST
 * day is `end - 1 day`, so a period ending 09-29 00:00 reads "〜09-28". */
export function formatAuditPeriodLabel(start: Date, end: Date): string {
  return `${formatJstDate(start)}〜${formatJstDate(new Date(end.getTime() - DAY_MS))}`;
}
