// パンくずの並びを決める純関数。最後の1つが今の画面で、その前が戻り先になる。

export type Crumb = {
  readonly label: string;
  /** 戻り先の経路。最後の1つ(今の画面)は持たない。 */
  readonly to?: string | undefined;
};

export function itemDetailCrumbs(_workItemId: number | null): Crumb[] {
  return [];
}

export function itemRequirementsCrumbs(_workItemId: number | null): Crumb[] {
  return [];
}

export function auditReportCrumbs(_workItemId: number | null): Crumb[] {
  return [];
}
