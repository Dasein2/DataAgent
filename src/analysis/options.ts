export interface AnalysisOptions {
  metadataTtlMs: number;
  metadataConcurrency: number;
  resultCacheTtlMs: number;
  preflight: "off" | "warn" | "enforce";
  maxEstimatedScanRows: number;
  maxEstimatedCost: number;
  maxLocalRows: number;
  maxLocalBytes: number;
  maxSessionBytes: number;
  retentionDays: number;
  maxSeries: number;
  masking: Array<{ column: string; mode: "partial" | "hash" | "deny" }>;
}

export const DEFAULT_ANALYSIS: AnalysisOptions = {
  metadataTtlMs: 300_000,
  metadataConcurrency: 2,
  resultCacheTtlMs: 60_000,
  preflight: "warn",
  maxEstimatedScanRows: 5_000_000,
  maxEstimatedCost: 1_000_000,
  maxLocalRows: 100_000,
  maxLocalBytes: 64 * 1024 * 1024,
  maxSessionBytes: 1024 * 1024 * 1024,
  retentionDays: 0,
  maxSeries: 30,
  masking: [],
};

export function analysisOptions(config: { analysis?: Partial<AnalysisOptions> }): AnalysisOptions {
  return { ...DEFAULT_ANALYSIS, ...config.analysis };
}
