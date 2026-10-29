// 設計書の全文を、見えない文字を表記に置き換えて描くための部品(スタブ)。

export type BlankLine = {
  readonly spaces: number;
  readonly tabs: number;
};

export type VisibleSegment =
  | { readonly kind: "plain"; readonly source: string }
  | { readonly kind: "code"; readonly source: string; readonly label: string }
  | {
      readonly kind: "blank-run";
      readonly source: string;
      readonly lines: readonly BlankLine[];
    }
  | { readonly kind: "space-run"; readonly source: string }
  | { readonly kind: "line-break"; readonly source: "\n" };

export function visibleText(_text: string): readonly VisibleSegment[] {
  return [];
}

export function restoreText(_segments: readonly VisibleSegment[]): string {
  return "";
}

export type DesignAnomalies = {
  readonly invisible: number;
  readonly strongRtl: number;
  readonly blankRuns: number;
  readonly spaceRuns: number;
  readonly markLookalikes: number;
  readonly total: number;
};

export function countDesignAnomalies(_text: string): DesignAnomalies {
  return {
    invisible: 0,
    strongRtl: 0,
    blankRuns: 0,
    spaceRuns: 0,
    markLookalikes: 0,
    total: 0,
  };
}

export const BLANK_RUN_MARK_PREFIX = "";
export const SPACE_RUN_MARK_PREFIX = "";
export const END_MARK_PREFIX = "";

export function blankRunMark(_lines: number): string {
  return "";
}

export function spaceRunMark(_count: number): string {
  return "";
}

export function endMark(_lines: number, _codePoints: number): string {
  return "";
}

export function textStats(_text: string): {
  readonly lines: number;
  readonly codePoints: number;
} {
  return { lines: 0, codePoints: 0 };
}

export type DesignApprovalInput = {
  readonly approvalRequestId: number;
  readonly snapshot: "loading" | "failed" | "empty" | "ready";
  readonly doc: {
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly data:
      | {
          readonly approval_request_id: number;
          readonly text: string;
          readonly truncated: boolean;
          readonly approval_status: string;
        }
      | null
      | undefined;
  };
  readonly workItemStatus: string | null | undefined;
};

export function designApprovalBlock(
  _input: DesignApprovalInput,
): string | null {
  return null;
}
