export const STOPPABLE_SWITCHES: readonly string[] = [];

export type NumberRule = {
  readonly integer: boolean;
  readonly minimum: number;
  readonly minimumExclusive: boolean;
};

export const LOWERABLE_NUMBERS: Readonly<Record<string, NumberRule>> = {};
