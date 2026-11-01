// The phrase logic is shared with the TUI: it lives in src/core/coverage.ts.
export { type CoverageCell, type CoverageSummary, summarize } from "@core/coverage";

/** One coloured share of the coverage bar. */
export type Segment = { readonly key: string; readonly count: number; readonly className: string };
