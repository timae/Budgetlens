// Structure detection: header row, column roles, file kind and per-file settings.
// Every result is a plain settings object the UI lets the user override.
import { LIMITS } from './limits.js';
import { cleanText, cleanLabel, normalizeKey } from './sanitize.js';
import { detectDecimal, looksNumeric, parseAmount } from './numbers.js';
import { detectDateFormat, parseDate, parseMonth, monthOf } from './dates.js';

export const ROLES = ['ignore', 'date', 'description', 'category', 'amount', 'out', 'in', 'direction', 'budget', 'actual', 'currency', 'month'];
export const ROLE_LABELS = new Map([
  ['ignore', 'Ignore'], ['date', 'Date'], ['description', 'Description'], ['category', 'Category'],
  ['amount', 'Amount (\u00B1)'], ['out', 'Money out'], ['in', 'Money in'], ['direction', 'Debit/credit flag'],
  ['budget', 'Budget'], ['actual', 'Actual spent'], ['currency', 'Currency'], ['month', 'Month'],
]);
export const KINDS = new Map([
  ['transactions', 'Transactions (bank export)'],
  ['category', 'Category sheet (budget and/or actual)'],
  ['wide', 'Wide sheet (one column per month)'],
]);

// [role, priority, phrases]. Phrases are normalised (lowercase, no accents/punctuation).
const TYPE_HEADERS = new Set(['type', 'typ', 'art', 'type of transaction', 'transaction type', 'transaktionstyp', 'buchungsart', 'activity type', 'cd', 'dc']);
const HEADER_RULES = [
  // Columns that look like amounts, currencies or descriptions but must not be used as such.
  ['ignore', 10, ['original amount', 'original currency', 'originalbetrag', 'originalwahrung', 'foreign currency', 'foreign amount', 'fremdwahrung', 'fremdwaehrung', 'devise originale',
    'montant original', 'importo originale', 'valuta originale', 'exchange rate', 'fx rate', 'wechselkurs', 'kurs', 'taux de change', 'tasso di cambio', 'individual amount', 'einzelbetrag',
    'montant individuel', 'importo singolo', 'type', 'typ', 'art', 'type of transaction', 'transaction type', 'transaktionstyp', 'buchungsart', 'activity type', 'label', 'tags', 'payment reference']],
  ['ignore', 9, ['saldo', 'balance', 'solde', 'kontostand', 'saldo chf', 'balance chf', 'fee', 'fees', 'gebuhr', 'gebuhren', 'gebuehr', 'frais', 'commissione', 'commissioni', 'spesen',
    'iban', 'kontonummer', 'account', 'account number', 'konto', 'referenz', 'reference', 'referenznummer', 'reference number', 'zkb referenz', 'zkb reference', 'transaktions nr', 'transaktionsnummer',
    'transaction id', 'id', 'state', 'status', 'product', 'fussnoten', 'footnotes', 'einzelbetrag', 'abschlusszeit', 'time', 'zeit', 'uhrzeit', 'bic', 'swift', 'karte', 'card', 'kartennummer',
    'qr referenz', 'esr', 'mcc', 'location', 'ort', 'tags', 'notes id', 'numero', 'nummer', 'no', 'nr']],
  ['date', 8, ['buchungsdatum', 'booking date', 'booked at', 'started date', 'date', 'datum', 'transaktionsdatum', 'transaction date', 'abschlussdatum', 'trade date',
    'date de comptabilisation', 'date comptable', 'date operation', 'date d operation', 'data', 'data contabile', 'data registrazione', 'data di registrazione', 'data operazione', 'buchungstag', 'tag', 'jour', 'giorno']],
  ['date', 5, ['completed date', 'auftragsdatum', 'ausfuhrungsdatum']],
  ['date', 3, ['valuta', 'valutadatum', 'value date', 'valeur', 'date valeur', 'date de valeur', 'data valuta', 'wertstellung']],
  ['amount', 8, ['credit debit amount', 'debit credit amount', 'betrag', 'amount', 'montant', 'importo', 'umsatz', 'transaktionsbetrag', 'transaction amount', 'betrag chf', 'amount chf',
    'montant chf', 'importo chf', 'buchungsbetrag', 'net amount', 'value', 'wert', 'kosten', 'cost', 'costs', 'ausgabe', 'spesa', 'depense', 'chf']],
  ['out', 9, ['belastung', 'belastungen', 'lastschrift', 'lastschrift in chf', 'debit', 'debits', 'debit amount', 'debit chf', 'money out', 'paid out', 'withdrawal', 'withdrawals',
    'ausgaben', 'ausgang', 'auszahlung', 'auszahlungen', 'debito', 'addebito', 'addebiti', 'uscita', 'uscite', 'sortie', 'sorties', 'belastung chf', 'outflow', 'expense', 'expenses']],
  ['in', 9, ['gutschrift', 'gutschriften', 'gutschrift in chf', 'credit', 'credits', 'credit amount', 'credit chf', 'money in', 'paid in', 'deposit', 'deposits', 'einnahmen', 'eingang',
    'einzahlung', 'einzahlungen', 'credito', 'accredito', 'accrediti', 'entrata', 'entrate', 'entree', 'entrees', 'gutschrift chf', 'inflow', 'income']],
  ['budget', 9, ['budget', 'budgets', 'budgetiert', 'budgetbetrag', 'budget chf', 'plan', 'geplant', 'planned', 'planwert', 'voranschlag', 'budgete', 'budget prevu', 'prevu', 'previsto',
    'preventivo', 'budgetato', 'target', 'monthly budget', 'budget pro monat', 'monatsbudget', 'budget mensuel', 'budget mensile', 'limit']],
  ['actual', 9, ['ist', 'actual', 'actuals', 'effektiv', 'effektive kosten', 'tatsachlich', 'tatsaechlich', 'ausgegeben', 'spent', 'reel', 'realise', 'effettivo', 'consuntivo', 'real', 'actual spent', 'ist chf']],
  ['category', 8, ['kategorie', 'category', 'categorie', 'categoria', 'rubrik', 'rubrique', 'posten', 'budgetposten', 'budget item', 'position', 'ausgabenart', 'kostenart', 'bereich',
    'line item', 'gruppe', 'group', 'item', 'voce', 'poste', 'type de depense', 'expense type', 'sub category', 'unterkategorie']],
  ['description', 7, ['buchungstext', 'booking text', 'beschreibung', 'beschreibung1', 'beschreibung2', 'beschreibung3', 'description', 'details', 'text', 'avisierungstext',
    'verwendungszweck', 'mitteilung', 'zahlungszweck', 'empfanger', 'empfaenger', 'auftraggeber', 'begunstigter', 'payee', 'merchant', 'counterparty', 'gegenpartei', 'libelle',
    'texte', 'descrizione', 'testo', 'causale', 'name', 'transaction', 'memo', 'purpose', 'beneficiary', 'information', 'informations', 'motif', 'zahlungsempfanger', 'haendler', 'handler']],
  ['currency', 8, ['wahrung', 'waehrung', 'currency', 'devise', 'monnaie', 'ccy', 'whg', 'divisa', 'valuta']],
  ['month', 7, ['monat', 'month', 'mois', 'mese', 'periode', 'period', 'periodo', 'buchungsmonat']],
  ['direction', 8, ['soll haben', 's h', 'debit credit', 'credit debit', 'cr dr', 'dr cr', 'd c', 'c d', 'indicator', 'debit credit indicator', 'buchungsart', 'cdi', 'typ soll haben']],
];

const INCOMING_WORDS = /(lohn|salar|salary|gehalt|payroll|gutschrift|credit|einzahlung|deposit|refund|ruckerstattung|r\u00FCckerstattung|remboursement|rimborso|zins|interest|dividend|income|einnahme|revenu|entrata)/i;

/** Text that helps recognise the account behind a file: IBAN (preamble or column), header layout, bank. */
export function accountHint(rows, s) {
  const header = s.headerRow >= 0 ? rows[s.headerRow] : [];
  const keys = header.map((x) => normalizeKey(x));
  const layout = keys.length ? keys.join('|') : `cols:${s.columns.length}`;
  const ibans = new Map();
  const scan = (text) => {
    for (const m of String(text).toUpperCase().matchAll(/\b([A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?)\b/g)) {
      const iban = m[1].replace(/ /g, '');
      if (validIban(iban)) ibans.set(iban, (ibans.get(iban) || 0) + 1);
    }
  };
  for (const r of rows.slice(0, Math.max(0, s.headerRow))) scan(r.join(' '));
  for (const r of rows.slice(-8)) scan(r.join(' '));
  keys.forEach((k, c) => { if (/\b(iban|konto|kontonummer|account)\b/.test(k)) for (const r of rows.slice(s.headerRow + 1, s.headerRow + 200)) scan(r[c] || ''); });
  let iban = '';
  let top = 0;
  for (const [k, n] of ibans) if (n > top) { top = n; iban = k; }
  const l = ` ${keys.join(' ')} `;
  const bank = / zkb /.test(l) ? 'ZKB' : / beschreibung1 | description1 /.test(l) ? 'UBS' : / avisierungstext | notification text /.test(l) ? 'PostFinance'
    : / booked at /.test(l) ? 'Raiffeisen' : / started date /.test(l) ? 'Revolut' : / original amount .* wise /.test(l) ? 'neon' : / activity name /.test(l) ? 'Yuh' : '';
  return { iban, layout, bank };
}

function validIban(iban) {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1;
}

const TOTAL_RE = /^(total|totals|summe|summen|gesamt|gesamttotal|gesamtsumme|totale|totali|totaux|somme|saldo|kontostand|schlusssaldo|anfangssaldo|endsaldo|closing balance|opening balance|balance|solde|sum|zwischensumme|zwischentotal|subtotal|sub total|sous total|subtotale|jahrestotal|jahr|year|annual|annuel|anno|ytd)\b/;
export const isTotalLabel = (s) => TOTAL_RE.test(normalizeKey(s));
// Dated rows that only report a balance or a total (bank statement summaries).
const BALANCE_ROW = /^(saldo|kontostand|schlusssaldo|anfangssaldo|endsaldo|balance|closing balance|opening balance|solde|total|summe|gesamttotal|totale)( |$)/;

const OUT_FLAGS = new Set(['s', 'soll', 'd', 'dr', 'db', 'dbit', 'debit', 'belastung', 'lastschrift', '-', 'out', 'ausgang', 'withdrawal', 'card payment', 'card_payment', 'payment']);
const IN_FLAGS = new Set(['h', 'haben', 'c', 'cr', 'crdt', 'credit', 'gutschrift', '+', 'in', 'eingang', 'deposit', 'topup', 'refund']);
const CURRENCY_CODE = /^[A-Z]{3}$/;

function scoreHeader(h) {
  const key = normalizeKey(h);
  const out = [];
  if (!key) return out;
  const padded = ` ${key} `;
  for (const [role, prio, phrases] of HEADER_RULES) {
    let best = 0;
    for (const p of phrases) {
      if (key === p) best = Math.max(best, prio + 5);
      else if (p.length > 2 && padded.includes(` ${p} `)) best = Math.max(best, prio + Math.min(3, p.split(' ').length));
      else if (p.length >= 5 && key.startsWith(p)) best = Math.max(best, prio);
    }
    if (best) out.push({ role, score: best });
  }
  return out.sort((a, b) => b.score - a.score);
}

const looksDate = (v) => !!(parseDate(v, 'DMY') || parseDate(v, 'MDY'));

/** Pick the header row: the row with most header-like cells followed by data-like rows. */
export function detectHeaderRow(rows) {
  const scan = Math.min(rows.length, LIMITS.maxHeaderScanRows);
  const widths = new Map();
  for (let i = 0; i < Math.min(rows.length, 200); i++) {
    const w = rows[i].filter((c) => c !== '').length;
    widths.set(w, (widths.get(w) || 0) + 1);
  }
  let modeWidth = 0, modeN = 0;
  for (const [w, n] of widths) if (n > modeN || (n === modeN && w > modeWidth)) { modeWidth = w; modeN = n; }
  let best = -1, bestScore = -Infinity;
  for (let i = 0; i < scan; i++) {
    const row = rows[i];
    const cells = row.filter((c) => c !== '');
    if (cells.length < 2) continue;
    let kw = 0, text = 0, data = 0;
    for (const c of cells) {
      if (scoreHeader(c).length) kw++;
      if (looksNumeric(c) || looksDate(c)) data++;
      else text++;
    }
    let follow = 0;
    for (let j = i + 1; j < Math.min(rows.length, i + 6); j++) {
      const r = rows[j];
      if (r.filter((c) => c !== '').length >= Math.max(2, cells.length * 0.5) && r.some((c) => looksNumeric(c) || looksDate(c))) follow++;
    }
    const score = kw * 4 + text - data * 3 + follow * 2 + (cells.length >= modeWidth * 0.8 ? 3 : 0) - i * 0.05;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (best === -1) return -1;
  const first = rows[best].filter((c) => c !== '');
  const kw = first.filter((c) => scoreHeader(c).length).length;
  const data = first.filter((c) => looksNumeric(c) || looksDate(c)).length;
  if (kw === 0 && data >= first.length / 2) return -1;
  return best;
}

function columnStats(data, width, header = []) {
  const sample = data.slice(0, 400);
  const stats = [];
  for (let c = 0; c < width; c++) {
    const vals = sample.map((r) => r[c] ?? '').filter((v) => v !== '');
    const n = vals.length || 1;
    // Excel serial numbers look like any amount; only accept them under a date-like header.
    const allowSerial = scoreHeader(header[c] || '').some((x) => x.role === 'date' || x.role === 'month');
    const dateInfo = detectDateFormat(vals, allowSerial);
    const numeric = vals.filter((v) => looksNumeric(v) && !looksDate(v));
    stats.push({
      filled: vals.length / Math.max(1, sample.length),
      dateRatio: vals.length ? dateInfo.ratio : 0,
      dateFormat: dateInfo.format,
      numRatio: numeric.length / n,
      negRatio: numeric.filter((v) => (parseAmount(v, 'dot') ?? 0) < 0).length / n,
      currencyRatio: vals.filter((v) => CURRENCY_CODE.test(v)).length / n,
      avgLen: vals.reduce((s, v) => s + v.length, 0) / n,
      distinct: new Set(vals).size,
      flagRatio: vals.filter((v) => OUT_FLAGS.has(normalizeKey(v)) || IN_FLAGS.has(normalizeKey(v)) || v === '-' || v === '+').length / n,
      values: vals,
    });
  }
  return stats;
}

/** Detect month-like header cells for wide sheets. Returns Map(col -> 'YYYY-MM'). */
function monthColumns(header, stats, year) {
  const out = new Map();
  header.forEach((h, c) => {
    if (!h || isTotalLabel(h)) return;
    const m = parseMonth(h, year);
    if (m && (stats[c]?.numRatio ?? 0) >= 0.5) out.set(c, m);
  });
  return out.size >= 2 ? out : new Map();
}

/**
 * Detect everything about a parsed file. Returns a settings object:
 * { headerRow, kind, columns[], dateFormat, decimal, sign, currency, budgetScope, month, wideMeaning, year, monthCols }
 */
export function detectSettings(rows, { fileName = '', defaultMonth, year } = {}) {
  const headerRow = detectHeaderRow(rows);
  return deriveSettings(rows, headerRow, { fileName, defaultMonth, year });
}

export function deriveSettings(rows, headerRow, { fileName = '', defaultMonth, year } = {}) {
  const width = Math.min(LIMITS.maxColumns, rows.reduce((m, r) => Math.max(m, r.length), 0));
  const header = headerRow >= 0 ? rows[headerRow] : [];
  const data = rows.slice(headerRow + 1);
  const stats = columnStats(data, width, header);
  const headerYear = guessYear(header);
  const yearGuess = year || headerYear || new Date().getFullYear();
  const yearAssumed = !year && !headerYear;
  const columns = new Array(width).fill('ignore');
  const taken = new Set();

  // 1) Header keywords, verified against content.
  const cands = [];
  for (let c = 0; c < width; c++) for (const s of scoreHeader(header[c] || '')) cands.push({ c, ...s });
  const keys = header.map((h) => normalizeKey(h));
  const hasHaben = keys.some((k) => /\bhaben\b/.test(k) && !/\bsoll\b/.test(k));
  const hasIst = keys.some((k) => /^ist\b/.test(k) || k === 'actual');
  cands.sort((a, b) => b.score - a.score);
  const decided = new Set();
  for (const { c, role } of cands) {
    if (decided.has(c)) continue;
    const st = stats[c];
    if (!verify(role, st)) continue;
    if (role !== 'ignore' && role !== 'description' && taken.has(role)) continue;
    columns[c] = role;
    decided.add(c);
    if (role !== 'ignore') taken.add(role);
  }
  // Soll/Haben (debit/credit) vs Soll/Ist (budget/actual).
  keys.forEach((k, c) => {
    if (decided.has(c) || !/^soll\b/.test(k)) return;
    const role = hasHaben ? 'out' : hasIst ? 'budget' : null;
    if (role && verify(role, stats[c]) && !taken.has(role)) { columns[c] = role; decided.add(c); taken.add(role); }
  });
  keys.forEach((k, c) => {
    if (decided.has(c) || !/^haben\b/.test(k)) return;
    if (verify('in', stats[c]) && !taken.has('in')) { columns[c] = 'in'; decided.add(c); taken.add('in'); }
  });
  // "valuta" means currency in Italian and value date in German: content decides.
  keys.forEach((k, c) => {
    if (k === 'valuta' && !decided.has(c) && stats[c].currencyRatio > 0.6 && !taken.has('currency')) { columns[c] = 'currency'; decided.add(c); taken.add('currency'); }
  });

  // 2) Wide sheet: many month-named numeric columns.
  const mcols = monthColumns(header, stats, yearGuess);
  if (mcols.size >= 2 && !taken.has('date')) {
    for (const c of mcols.keys()) { columns[c] = 'ignore'; decided.add(c); }
    let cat = columns.indexOf('category');
    if (cat === -1) cat = columns.indexOf('description');
    if (cat === -1) cat = bestTextColumn(stats, decided, mcols);
    if (cat !== -1) columns[cat] = 'category';
    for (let c = 0; c < width; c++) if (columns[c] === 'description' && c !== cat) columns[c] = 'ignore';
    // Month columns are budgets unless the file name says it holds actual spending.
    const meaning = /(^|[^a-z])(ist|actuals?|ausgaben|spent|spending|effektiv|reel|consuntivo)([^a-z]|$)/i.test(fileName) && !/budget|plan/i.test(fileName) ? 'actual' : 'budget';
    // Month headers like "Jan" without a year need one; header years like "Jan 26" are used as is.
    const monthsHaveYear = [...mcols.keys()].every((c) => /\d{2}/.test(header[c] || ''));
    return finish({ headerRow, kind: 'wide', columns, monthCols: Object.fromEntries(mcols), wideMeaning: meaning, year: yearGuess, yearAssumed: yearAssumed && !monthsHaveYear }, rows, stats, defaultMonth);
  }

  // 3) Content fallbacks.
  if (!taken.has('date')) {
    let best = -1, ratio = 0.8;
    stats.forEach((s, c) => { if (!decided.has(c) && s.dateRatio >= ratio) { best = c; ratio = s.dateRatio; } });
    if (best !== -1) { columns[best] = 'date'; decided.add(best); taken.add('date'); }
  }
  if (!taken.has('amount') && !taken.has('out') && !taken.has('in') && !taken.has('budget') && !taken.has('actual')) {
    const nums = stats.map((s, c) => ({ s, c })).filter(({ s, c }) => !decided.has(c) && s.numRatio >= 0.8 && s.dateRatio < 0.5);
    if (nums.length === 1) { columns[nums[0].c] = 'amount'; decided.add(nums[0].c); taken.add('amount'); }
    else if (nums.length >= 2) {
      const [a, b] = nums;
      const both = data.slice(0, 400).filter((r) => (r[a.c] || '') !== '' && (r[b.c] || '') !== '').length;
      if (both < 0.05 * Math.min(400, data.length)) {
        columns[a.c] = 'out'; columns[b.c] = 'in'; taken.add('out'); taken.add('in');
      } else { columns[a.c] = 'amount'; taken.add('amount'); }
      decided.add(a.c); decided.add(b.c);
    }
  }
  if (!taken.has('description') && !taken.has('category')) {
    const c = bestTextColumn(stats, decided);
    if (c !== -1) { columns[c] = taken.has('date') ? 'description' : 'category'; decided.add(c); }
  }
  if (!taken.has('direction') && (taken.has('amount')) && stats[columns.indexOf('amount')]?.negRatio === 0) {
    const c = stats.findIndex((s, i) => (!decided.has(i) || TYPE_HEADERS.has(keys[i])) && s.flagRatio > 0.9 && s.distinct <= 6);
    if (c !== -1) { columns[c] = 'direction'; decided.add(c); }
  }

  // 4) Kind.
  const has = (r) => columns.includes(r);
  let kind;
  if (has('date') && (has('amount') || has('out') || has('in') || has('actual'))) kind = 'transactions';
  else kind = 'category';
  if (kind === 'transactions' && has('actual') && !has('amount')) columns[columns.indexOf('actual')] = 'amount';
  if (kind === 'category') {
    // A sheet without date: description acts as category; a lone amount is budget or actual by file name.
    if (!has('category') && has('description')) columns[columns.indexOf('description')] = 'category';
    for (let c = 0; c < width; c++) if (columns[c] === 'description') columns[c] = 'ignore';
    if (has('date')) columns[columns.indexOf('date')] = 'month';
    if (has('amount')) {
      const c = columns.indexOf('amount');
      columns[c] = has('budget') ? 'actual' : has('actual') ? 'budget' : /budget|plan/i.test(fileName) ? 'budget' : 'actual';
    }
    if (has('out') && !has('actual')) columns[columns.indexOf('out')] = 'actual';
  }
  return finish({ headerRow, kind, columns, year: yearGuess }, rows, stats, defaultMonth);
}

function finish(s, rows, stats, defaultMonth) {
  const cols = s.columns;
  const dateCol = cols.indexOf('date') !== -1 ? cols.indexOf('date') : cols.indexOf('month');
  s.dateFormat = dateCol !== -1 ? stats[dateCol].dateFormat : 'DMY';
  const numVals = [];
  cols.forEach((r, c) => { if (['amount', 'out', 'in', 'budget', 'actual'].includes(r)) numVals.push(...stats[c].values.slice(0, 200)); });
  if (s.kind === 'wide') for (const c of Object.keys(s.monthCols)) numVals.push(...stats[+c].values.slice(0, 100));
  s.decimal = detectDecimal(numVals);
  const amountCol = cols.indexOf('amount');
  s.sign = 'negative-out';
  s.signGuessed = false;
  if (amountCol !== -1 && stats[amountCol].negRatio === 0 && cols.indexOf('direction') === -1 && stats[amountCol].values.length) {
    // Only positive amounts: an expense log, or a file of incoming money (salary, refunds)?
    const descVals = cols.flatMap((r, c) => (r === 'description' || r === 'category' ? stats[c].values.slice(0, 200) : []));
    const incoming = descVals.filter((v) => INCOMING_WORDS.test(v)).length;
    s.sign = descVals.length && incoming / descVals.length >= 0.5 ? 'negative-out' : 'positive-out';
    s.signGuessed = true;
  }
  const curCol = cols.indexOf('currency');
  s.currency = 'CHF';
  if (curCol !== -1) {
    const counts = new Map();
    for (const v of stats[curCol].values) if (CURRENCY_CODE.test(v)) counts.set(v, (counts.get(v) || 0) + 1);
    let top = 0;
    for (const [k, n] of counts) if (n > top) { top = n; s.currency = k; }
  } else {
    const header = s.headerRow >= 0 ? rows[s.headerRow].join(' ') : '';
    const m = /\b(CHF|EUR|USD|GBP)\b/.exec(header);
    if (m) s.currency = m[1];
  }
  s.budgetScope = 'monthly';
  s.month = defaultMonth || new Date().toISOString().slice(0, 7);
  s.wideMeaning = s.wideMeaning || 'budget';
  s.monthCols = s.monthCols || {};
  return s;
}

function verify(role, st) {
  if (!st) return false;
  switch (role) {
    case 'date': return st.dateRatio >= 0.5;
    case 'month': return st.dateRatio >= 0.5 || st.values.slice(0, 50).filter((v) => parseMonth(v, 2000)).length >= Math.min(st.values.length, 50) * 0.6;
    case 'amount': case 'out': case 'in': case 'budget': case 'actual':
      return st.values.length === 0 || (st.numRatio >= 0.6 && st.dateRatio < 0.6);
    case 'currency': return st.currencyRatio >= 0.6;
    case 'direction': return st.flagRatio >= 0.6;
    case 'category': return st.numRatio < 0.5 && st.dateRatio < 0.5;
    case 'description': return st.dateRatio < 0.8 && (st.numRatio < 0.9 || st.values.length === 0);
    default: return true;
  }
}

function bestTextColumn(stats, decided, exclude = new Map()) {
  let best = -1, len = 0;
  stats.forEach((s, c) => {
    if (decided.has(c) || exclude.has(c)) return;
    if (s.numRatio < 0.5 && s.dateRatio < 0.5 && s.avgLen > len) { best = c; len = s.avgLen; }
  });
  return best;
}

function guessYear(header) {
  for (const h of header) {
    const m = /\b(19\d\d|20\d\d)\b/.exec(h || '');
    if (m) return +m[1];
  }
  return 0;
}

/**
 * Turn rows into normalised records using (possibly user-edited) settings.
 * Returns { transactions, budgets, stats }.
 *   transaction: { date, month, desc, rawCategory, amount (\u2212 = money out), currency, synthetic }
 *   budget:      { category, month|null, amount, currency }
 */
export function extractRecords(rows, s) {
  const cols = s.columns;
  const idx = (role) => cols.indexOf(role);
  const all = (role) => cols.map((r, i) => (r === role ? i : -1)).filter((i) => i !== -1);
  const data = rows.slice(s.headerRow + 1, s.headerRow + 1 + LIMITS.maxRowsPerFile);
  const out = { transactions: [], budgets: [], stats: { rows: data.length, used: 0, skippedTotals: 0, skippedInvalid: 0 } };
  const num = (v) => parseAmount(v, s.decimal);
  const cur = (r) => {
    const c = idx('currency');
    const v = c !== -1 ? (r[c] || '').toUpperCase() : '';
    return CURRENCY_CODE.test(v) ? v : s.currency;
  };

  if (s.kind === 'transactions') {
    const dc = idx('date'), ac = idx('amount'), oc = idx('out'), ic = idx('in'), cc = idx('category'), fc = idx('direction');
    const descCols = all('description');
    if (dc === -1 || (ac === -1 && oc === -1 && ic === -1)) return out;
    for (const r of data) {
      const date = parseDate(r[dc], s.dateFormat);
      const desc = joinDesc(r, descCols);
      if (!date) { (isTotalLabel(desc) || isTotalLabel(r[0] || '') ? out.stats.skippedTotals++ : out.stats.skippedInvalid++); continue; }
      if (BALANCE_ROW.test(normalizeKey(desc))) { out.stats.skippedTotals++; continue; }
      let amount = null;
      if (ac !== -1) {
        const v = num(r[ac]);
        if (v != null) {
          if (fc !== -1) {
            const f = normalizeKey(r[fc]);
            amount = OUT_FLAGS.has(f) ? -Math.abs(v) : IN_FLAGS.has(f) ? Math.abs(v) : (s.sign === 'positive-out' ? -v : v);
          } else amount = s.sign === 'positive-out' ? -v : v;
        }
      }
      if (amount == null && (oc !== -1 || ic !== -1)) {
        const o = oc !== -1 ? num(r[oc]) : null;
        const i = ic !== -1 ? num(r[ic]) : null;
        if (o != null || i != null) amount = (i != null ? Math.abs(i) : 0) - (o != null ? Math.abs(o) : 0);
      }
      if (amount == null || amount === 0) { out.stats.skippedInvalid++; continue; }
      out.transactions.push({ date, month: monthOf(date), desc, rawCategory: cc !== -1 ? cleanLabel(r[cc]) : '', amount: round2(amount), currency: cur(r), synthetic: false });
      out.stats.used++;
    }
    return out;
  }

  if (s.kind === 'wide') {
    const cc = idx('category');
    const entries = Object.entries(s.monthCols || {}).map(([c, m]) => [+c, m]);
    for (const r of data) {
      const cat = cc !== -1 ? cleanLabel(r[cc]) : '';
      if (!cat) { out.stats.skippedInvalid++; continue; }
      if (isTotalLabel(cat)) { out.stats.skippedTotals++; continue; }
      let any = false;
      for (const [c, m] of entries) {
        const v = num(r[c]);
        if (v == null || v === 0) continue;
        any = true;
        if (s.wideMeaning === 'actual') out.transactions.push(synthetic(cat, m, Math.abs(v), cur(r)));
        else out.budgets.push({ category: cat, month: m, amount: round2(Math.abs(v)), currency: cur(r) });
      }
      any ? out.stats.used++ : out.stats.skippedInvalid++;
    }
    return out;
  }

  // Category sheet.
  const cc = idx('category'), bc = idx('budget'), xc = idx('actual'), mc = idx('month');
  if (cc === -1 || (bc === -1 && xc === -1)) return out;
  for (const r of data) {
    const cat = cleanLabel(r[cc]);
    if (!cat) { out.stats.skippedInvalid++; continue; }
    if (isTotalLabel(cat)) { out.stats.skippedTotals++; continue; }
    let month = null;
    if (mc !== -1) {
      const d = parseDate(r[mc], s.dateFormat);
      month = d ? monthOf(d) : parseMonth(r[mc], s.year);
    }
    const b = bc !== -1 ? num(r[bc]) : null;
    const a = xc !== -1 ? num(r[xc]) : null;
    if (b == null && a == null) { out.stats.skippedInvalid++; continue; }
    if (b != null && b !== 0) out.budgets.push({ category: cat, month: month || (s.budgetScope === 'once' ? s.month : null), amount: round2(Math.abs(b)), currency: cur(r) });
    if (a != null && a !== 0) out.transactions.push(synthetic(cat, month || s.month, Math.abs(a), cur(r)));
    out.stats.used++;
  }
  return out;
}

function synthetic(category, month, spent, currency) {
  return { date: `${month}-01`, month, desc: category, rawCategory: category, amount: -round2(spent), currency, synthetic: true };
}

function joinDesc(r, cols) {
  const parts = [];
  for (const c of cols) {
    const v = r[c];
    if (v && !parts.includes(v)) parts.push(v);
  }
  return cleanText(parts.join(' \u00B7 '));
}

const round2 = (n) => Math.round(n * 100) / 100;
