import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, csvCell, toCSV, normalizeKey } from '../web/js/sanitize.js';
import { detectEncoding, decodeBytes, detectDelimiter, parseCSV } from '../web/js/csv.js';
import { parseAmount, detectDecimal } from '../web/js/numbers.js';
import { parseDate, detectDateFormat, parseMonth, excelSerialToISO, monthRange } from '../web/js/dates.js';
import { LIMITS } from '../web/js/limits.js';

test('cleanText strips control, zero-width and bidi characters', () => {
  assert.equal(cleanText('Mi\u200Bgros\u202E gpj.exe\u202C'), 'Migros gpj.exe');
  assert.equal(cleanText('a\u0000b\u0007c\u009Fd'), 'abcd');
  assert.equal(cleanText(' \u00A0Coop\t\tPronto\u2066x\u2069 '), 'Coop Prontox');
  assert.equal(cleanText('\uFEFFDatum'), 'Datum');
  assert.equal(cleanText('x'.repeat(5000)).length, LIMITS.maxCellLength + 1);
  assert.equal(normalizeKey('W\u00E4hrung'), 'wahrung');
  assert.equal(normalizeKey('Buchungs-Datum '), 'buchungs datum');
});

test('csvCell neutralises formula injection but keeps numbers numeric', () => {
  assert.equal(csvCell('=HYPERLINK("http://x","y")'), `"'=HYPERLINK(""http://x"",""y"")"`);
  for (const p of ['+1+1', '-2+3', '@SUM(A1)', '\uFF1D1+1', '%0A']) assert.ok(csvCell(p).startsWith(`"'`), p);
  assert.equal(csvCell(-12.5), '-12.5');
  assert.equal(csvCell(1234.567), '1234.57');
  assert.equal(csvCell('Migros'), '"Migros"');
  assert.ok(toCSV([['a', 1]]).startsWith('\uFEFF"a",1'));
});

test('encoding detection: BOMs, UTF-16 without BOM, Windows-1252', () => {
  assert.equal(detectEncoding(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])), 'utf-8');
  assert.equal(detectEncoding(new Uint8Array([0xff, 0xfe, 0x41, 0])), 'utf-16le');
  assert.equal(detectEncoding(new Uint8Array([0xfe, 0xff, 0, 0x41])), 'utf-16be');
  const le = new Uint8Array([...'Datum;Betrag\n'].flatMap((c) => [c.charCodeAt(0), 0]));
  assert.equal(detectEncoding(le), 'utf-16le');
  assert.equal(decodeBytes(le, 'utf-16le'), 'Datum;Betrag\n');
  const latin = new Uint8Array([0x57, 0xe4, 0x68, 0x72, 0x75, 0x6e, 0x67]); // "W\u00E4hrung" in cp1252
  assert.equal(detectEncoding(latin), 'windows-1252');
  assert.equal(decodeBytes(latin, 'windows-1252'), 'W\u00E4hrung');
  assert.equal(decodeBytes(new TextEncoder().encode('\uFEFFx'), 'utf-8'), 'x');
});

test('delimiter detection', () => {
  assert.equal(detectDelimiter('a;b;c\n1;2;3\n4;5;6'), ';');
  assert.equal(detectDelimiter('a,b,c\n1,2,3'), ',');
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  assert.equal(detectDelimiter('a|b|c\n1|2|3'), '|');
  // Decimal commas inside quotes must not fool a semicolon file.
  assert.equal(detectDelimiter('"Datum";"Betrag"\n"01.10.2026";"1,50"\n"02.10.2026";"2,50"'), ';');
  // Bank preamble with fewer fields.
  assert.equal(detectDelimiter('Konto:;CH12\nW\u00E4hrung:;CHF\nDatum;Text;Belastung;Gutschrift;Saldo\n1.1.26;x;1;;9\n2.1.26;y;2;;7'), ';');
});

test('CSV parser handles quotes, embedded delimiters/newlines and limits', () => {
  const { rows } = parseCSV('a;"b;c";"d ""e"""\r\n1;"multi\nline";3\n\n', ';');
  assert.deepEqual(rows, [['a', 'b;c', 'd "e"'], ['1', 'multi line', '3']]);
  const many = 'x\n'.repeat(50);
  const lim = { ...LIMITS, maxRowsPerFile: 10, maxHeaderScanRows: 0 };
  const r = parseCSV(many, ',', lim);
  assert.equal(r.rows.length, 10);
  assert.equal(r.truncated, true);
  const wide = Array.from({ length: 300 }, (_, i) => i).join(',');
  const w = parseCSV(wide, ',');
  assert.equal(w.rows[0].length, LIMITS.maxColumns);
  assert.equal(w.truncated, true);
  const big = parseCSV(`"${'y'.repeat(100000)}",1`, ',');
  assert.ok(big.rows[0][0].length <= LIMITS.maxCellLength + 1);
  assert.equal(big.rows[0][1], '1');
});

test('amount parsing across Swiss, European and accounting formats', () => {
  const cases = [
    ["1'234.50", 'dot', 1234.5], ['1\u2019234.50', 'dot', 1234.5], ['1,234.50', 'dot', 1234.5], ['1 234.50', 'dot', 1234.5],
    ['1.234,50', 'comma', 1234.5], ['1 234,50', 'comma', 1234.5], ['-45,00', 'comma', -45], ['12,5', 'dot', 12.5],
    ['(45.00)', 'dot', -45], ['120.00-', 'dot', -120], ['\u22123.35', 'dot', -3.35], ['+7800', 'dot', 7800],
    ['CHF 1980.00', 'dot', 1980], ['1980.00 CHF', 'dot', 1980], ['\u20AC -8.40', 'dot', -8.4], ['Fr. 12.\u2013', 'dot', 12],
    ['', 'dot', null], ['abc', 'dot', null], ['1.2.3', 'dot', null], ['01.10.2026', 'comma', null], ['1e5', 'dot', null],
  ];
  for (const [raw, dec, want] of cases) assert.equal(parseAmount(raw, dec), want, `${raw} (${dec})`);
  assert.equal(detectDecimal(['1.234,50', '45,00', '3,35']), 'comma');
  assert.equal(detectDecimal(["1'234.50", '45.00', '3.35']), 'dot');
  assert.equal(detectDecimal(['1.234', '2.500', '12.000']), 'comma');
});

test('date parsing and format detection', () => {
  assert.equal(parseDate('31.10.2026', 'DMY'), '2026-10-31');
  assert.equal(parseDate('1.2.26', 'DMY'), '2026-02-01');
  assert.equal(parseDate('10/31/2026', 'MDY'), '2026-10-31');
  assert.equal(parseDate('2026-10-01 12:34:56', 'DMY'), '2026-10-01');
  assert.equal(parseDate('2026-10-01T08:00:00Z', 'MDY'), '2026-10-01');
  assert.equal(parseDate('31.02.2026', 'DMY'), null);
  assert.equal(parseDate('46296', 'serial'), '2026-10-01');
  assert.equal(excelSerialToISO(45658), '2025-01-01');
  assert.equal(parseDate('01 Oct 2026', 'DMY'), '2026-10-01');
  assert.equal(parseDate('1. Oktober 2026', 'DMY'), '2026-10-01');
  assert.equal(parseDate('Oct 5, 2026', 'DMY'), '2026-10-05');
  assert.equal(parseDate('3 f\u00E9vr. 2026', 'DMY'), '2026-02-03');
  assert.equal(detectDateFormat(['10/31/2026', '11/01/2026']).format, 'MDY');
  assert.equal(detectDateFormat(['31/10/2026', '01/11/2026']).format, 'DMY');
  assert.equal(detectDateFormat(['46296', '46297']).format, 'serial');
  assert.equal(parseMonth('2026-10'), '2026-10');
  assert.equal(parseMonth('10.2026'), '2026-10');
  assert.equal(parseMonth('Okt 26'), '2026-10');
  assert.equal(parseMonth('M\u00E4rz', 2025), '2025-03');
  assert.equal(parseMonth('Total', 2025), null);
  assert.deepEqual(monthRange('2025-11', '2026-02'), ['2025-11', '2025-12', '2026-01', '2026-02']);
});
