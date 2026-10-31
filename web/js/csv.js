import { LIMITS } from './limits.js';
import { cleanText } from './sanitize.js';

export const ENCODINGS = ['utf-8', 'utf-16le', 'utf-16be', 'windows-1252'];
export const DELIMITERS = [',', ';', '\t', '|'];

/**
 * Detect the text encoding of raw bytes: BOM first, then UTF-16 by zero-byte
 * pattern, then strict UTF-8, falling back to Windows-1252 (Latin-1 superset).
 */
export function detectEncoding(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  const n = Math.min(bytes.length, 4000);
  let evenZero = 0, oddZero = 0;
  for (let i = 0; i < n; i++) if (bytes[i] === 0) (i % 2 === 0 ? evenZero++ : oddZero++);
  if (n >= 4) {
    if (oddZero > n / 5 && evenZero < n / 50) return 'utf-16le';
    if (evenZero > n / 5 && oddZero < n / 50) return 'utf-16be';
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, Math.min(bytes.length, 2_000_000)));
    return 'utf-8';
  } catch {
    return 'windows-1252';
  }
}

export function decodeBytes(bytes, encoding) {
  const enc = ENCODINGS.includes(encoding) ? encoding : 'utf-8';
  let text = new TextDecoder(enc, { fatal: false }).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

/** Count delimiter occurrences per line outside quotes and pick the most consistent one. */
export function detectDelimiter(text) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < text.length && lines.length < 60; i++) {
    if (text[i] === '\n') {
      const line = text.slice(start, i).trim();
      if (line) lines.push(line);
      start = i + 1;
    }
  }
  if (lines.length < 60) {
    const last = text.slice(start).trim();
    if (last) lines.push(last);
  }
  let best = ',', bestScore = -1;
  for (const d of DELIMITERS) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const freq = new Map();
    for (const c of counts) if (c > 0) freq.set(c, (freq.get(c) || 0) + 1);
    let mode = 0, modeN = 0;
    for (const [c, k] of freq) if (k > modeN || (k === modeN && c > mode)) { mode = c; modeN = k; }
    if (!mode) continue;
    // Lines agreeing on the modal count matter most; wider tables win ties.
    const score = modeN * 10 + Math.min(mode, 30);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

function countOutsideQuotes(line, d) {
  let n = 0, q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === d && !q) n++;
  }
  return n;
}

/**
 * RFC 4180-style parser with limits. Returns { rows, truncated, maxWidth }.
 * Every cell is cleaned (control/zero-width/bidi characters stripped, length capped).
 */
export function parseCSV(text, delimiter, limits = LIMITS) {
  const rows = [];
  let row = [], cell = '', inQuotes = false, truncated = false, maxWidth = 0, cellOverflow = false;
  const maxRows = limits.maxRowsPerFile + limits.maxHeaderScanRows;
  const pushCell = () => {
    if (row.length < limits.maxColumns) row.push(cleanText(cell, limits.maxCellLength));
    else truncated = true;
    cell = '';
    cellOverflow = false;
  };
  const pushRow = () => {
    pushCell();
    if (row.some((c) => c !== '')) {
      rows.push(row);
      if (row.length > maxWidth) maxWidth = row.length;
    }
    row = [];
  };
  const len = text.length;
  for (let i = 0; i < len; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { if (!cellOverflow) cell += '"'; i++; }
        else inQuotes = false;
      } else if (!cellOverflow) {
        cell += c;
        if (cell.length > limits.maxCellLength * 4) cellOverflow = true;
      }
      continue;
    }
    if (c === '"' && cell.trim() === '') { cell = ''; inQuotes = true; }
    else if (c === delimiter) pushCell();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      pushRow();
      if (rows.length >= maxRows) { truncated = i < len - 1; break; }
    } else if (!cellOverflow) {
      cell += c;
      if (cell.length > limits.maxCellLength * 4) cellOverflow = true;
    }
  }
  if (rows.length < maxRows && (cell !== '' || row.length)) pushRow();
  return { rows, truncated, maxWidth };
}
