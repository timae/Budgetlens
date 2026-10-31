// Hard limits for untrusted input. Everything the parser produces is bounded by these.
export const LIMITS = Object.freeze({
  maxFiles: 12,
  maxFileBytes: 15 * 1024 * 1024,
  maxRowsPerFile: 100_000,
  maxTotalRows: 300_000,
  maxColumns: 200,
  maxCellLength: 1_000,
  maxHeaderScanRows: 40,
  maxRules: 200,
  maxKeywordsPerRule: 200,
  maxKeywordLength: 60,
  maxCategoryLength: 60,
});
