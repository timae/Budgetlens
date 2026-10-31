// File \u2192 settings \u2192 records \u2192 categorised transactions. No DOM here, so it is unit-testable.
import { LIMITS } from './limits.js';
import { cleanText } from './sanitize.js';
import { decodeBytes, detectDelimiter, detectEncoding, parseCSV } from './csv.js';
import { deriveSettings, detectHeaderRow, extractRecords } from './detect.js';
import { BRANDS, categorize, payeeName } from './categorize.js';
import { parseMonth } from './dates.js';
import { cardOf } from './people.js';

/**
 * Parse one file. `overrides` holds settings the user changed; changing
 * encoding/delimiter/header row re-runs detection for the rest.
 */
export function processFile(name, bytes, overrides = {}, context = {}) {
  const warnings = [];
  if (bytes.length > LIMITS.maxFileBytes) throw new Error(`${cleanText(name, 80)} is larger than ${LIMITS.maxFileBytes / 1024 / 1024} MB.`);
  const encoding = overrides.encoding || detectEncoding(bytes);
  const text = decodeBytes(bytes, encoding);
  if (text.includes('\u0000')) warnings.push('The file contains binary data; check the encoding.');
  const delimiter = overrides.delimiter || detectDelimiter(text);
  const parsed = parseCSV(text, delimiter);
  if (parsed.truncated) warnings.push(`Only the first ${LIMITS.maxRowsPerFile.toLocaleString('en')} rows or ${LIMITS.maxColumns} columns were read.`);
  const rows = parsed.rows;
  const headerRow = overrides.headerRow != null ? Math.max(-1, Math.min(rows.length - 1, overrides.headerRow)) : detectHeaderRow(rows);
  const detected = deriveSettings(rows, headerRow, { fileName: name, defaultMonth: context.defaultMonth, year: overrides.year });
  // Structural overrides re-derive roles; other overrides are applied on top.
  const settings = { ...detected, encoding, delimiter };
  for (const k of ['kind', 'dateFormat', 'decimal', 'sign', 'currency', 'budgetScope', 'month', 'wideMeaning']) {
    if (overrides[k] != null) settings[k] = overrides[k];
  }
  if (overrides.columns && overrides.columns.length === settings.columns.length) settings.columns = [...overrides.columns];
  if (overrides.monthCols) settings.monthCols = { ...overrides.monthCols };
  if (settings.kind === 'wide' && !Object.keys(settings.monthCols).length && headerRow >= 0) {
    rows[headerRow].forEach((h, c) => {
      const m = parseMonth(h, settings.year);
      if (m) settings.monthCols[c] = m;
    });
  }
  const records = extractRecords(rows, settings);
  if (!records.transactions.length && !records.budgets.length) warnings.push('No usable rows found. Check the header row and column roles.');
  return { name: cleanText(name, 120), size: bytes.length, rows, settings, records, warnings };
}

/** Attach payee and category to every transaction from every file. */
export function prepareTransactions(files, rules, { useFileCategories = true } = {}) {
  const out = [];
  let total = 0;
  files.forEach((f, fi) => {
    for (const t of f.records.transactions) {
      if (++total > LIMITS.maxTotalRows) return;
      out.push({
        ...t,
        file: fi,
        payee: t.synthetic ? t.desc : payeeName(t.desc, BRANDS),
        card: t.synthetic ? '' : cardOf(t.desc),
        category: categorize(t, rules, { useFileCategory: useFileCategories }),
      });
    }
  });
  return out;
}

export function collectBudgets(files) {
  return files.flatMap((f) => f.records.budgets);
}
