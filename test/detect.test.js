import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processFile } from '../web/js/pipeline.js';

const enc = (s) => new TextEncoder().encode(s);
const roles = (f) => Object.fromEntries(f.settings.columns.map((r, i) => [i, r]).filter(([, r]) => r !== 'ignore'));
const tx = (f) => f.records.transactions;

test('ZKB export (English, semicolon, Debit/Credit columns, pending rows without balance)', () => {
  const f = processFile('zkb.csv', enc(
    '\uFEFF"Date";"Booking text";"ZKB reference";"Reference number";"Debit CHF";"Credit CHF";"Value date";"Balance CHF"\r\n' +
    '"29.10.2026";"Purchase ZKB Visa Debit card No. xxxx 1234, MIGROS VOI";"";"";"3.35";"";"";""\r\n' +
    '"27.10.2026";"Credit originator: A. MUSTER, 8000 ZUERICH";"Z1";"";"";"6200.00";"27.10.2026";"9833.40"\r\n' +
    '"24.10.2026";"Refund ZKB Visa Debit card no. xxxx 5678, Migros MM";"L1";"";"";"34.95";"24.10.2026";"4669.68"\r\n'));
  assert.equal(f.settings.kind, 'transactions');
  assert.equal(f.settings.delimiter, ';');
  assert.deepEqual(roles(f), { 0: 'date', 1: 'description', 4: 'out', 5: 'in' });
  assert.deepEqual(tx(f).map((t) => t.amount), [-3.35, 6200, 34.95]);
  assert.equal(tx(f)[0].date, '2026-10-29');
});

test('PostFinance export with preamble and disclaimer footer', () => {
  const f = processFile('pf.csv', enc([
    'Datum von:;01.09.2026', 'Datum bis:;30.09.2026', 'Buchungsart:;Alle', 'Konto:;CH1209000000123456789', 'W\u00E4hrung:;CHF', '',
    'Buchungsdatum;Avisierungstext;Gutschrift in CHF;Lastschrift in CHF;Valuta;Saldo in CHF',
    '30.09.2026;KAUF/DIENSTLEISTUNG VOM 29.09.2026 KARTEN NR. XXXX1234 COOP-4711 BERN;;-45.20;30.09.2026;1520.10',
    '28.09.2026;GUTSCHRIFT LOHN SEPTEMBER;5200.00;;28.09.2026;1565.30', '',
    'Disclaimer:', 'Dies ist kein durch PostFinance AG erstelltes Dokument.',
  ].join('\n')));
  assert.equal(f.settings.headerRow, 5); // blank lines are dropped
  assert.deepEqual(roles(f), { 0: 'date', 1: 'description', 2: 'in', 3: 'out' });
  assert.deepEqual(tx(f).map((t) => t.amount), [-45.2, 5200]);
  assert.equal(f.records.stats.used, 2);
});

test('UBS export: preamble, Belastung/Gutschrift, Beschreibung1-3 joined, Einzelbetrag ignored', () => {
  const f = processFile('ubs.csv', enc([
    'Kontonummer:;0235 00123456.01;', 'IBAN:;CH12 0023 5235 1234 5601 E;', 'Von:;2026-09-01;', 'Bis:;2026-09-30;', '',
    'Abschlussdatum;Abschlusszeit;Buchungsdatum;Valutadatum;W\u00E4hrung;Belastung;Gutschrift;Einzelbetrag;Saldo;Transaktions-Nr.;Beschreibung1;Beschreibung2;Beschreibung3;Fussnoten',
    '2026-09-29;12:01:02;2026-09-30;2026-09-30;CHF;-21.40;;;1234.10;9999;Migros Genossenschaft;Z\u00FCrich;Debitkarte;',
    '2026-09-25;;2026-09-25;2026-09-25;CHF;;7800.00;;1255.50;9998;Muster AG;Lohn;;',
  ].join('\n')));
  const r = roles(f);
  assert.equal(r[4], 'currency');
  assert.equal(r[5], 'out');
  assert.equal(r[6], 'in');
  assert.equal([r[10], r[11], r[12]].join(), 'description,description,description');
  assert.equal(Object.values(r).filter((x) => x === 'date').length, 1);
  assert.deepEqual(tx(f).map((t) => t.amount), [-21.4, 7800]);
  assert.equal(tx(f)[0].desc, 'Migros Genossenschaft \u00B7 Z\u00FCrich \u00B7 Debitkarte');
});

test('Raiffeisen export with signed Credit/Debit Amount', () => {
  const f = processFile('raiffeisen.csv', enc('IBAN;Booked At;Text;Credit/Debit Amount;Balance;Valuta Date\nCH93 8080;2026-10-02 00:00:00.0;Denner Z\u00FCrich;-12.35;100.00;2026-10-02\nCH93 8080;2026-10-03 00:00:00.0;Lohn;5000.00;5100.00;2026-10-03\n'));
  assert.equal(roles(f)[3], 'amount');
  assert.equal(roles(f)[1], 'date');
  assert.equal(f.settings.sign, 'negative-out');
  assert.deepEqual(tx(f).map((t) => [t.date, t.amount]), [['2026-10-02', -12.35], ['2026-10-03', 5000]]);
});

test('Revolut export: comma CSV, ISO date-times, currency column, fee/balance ignored', () => {
  const f = processFile('revolut.csv', enc('Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\nCARD_PAYMENT,Current,2026-10-04 10:12:00,2026-10-05 08:00:00,Carrefour,-46.20,0.00,EUR,COMPLETED,553.80\nTOPUP,Current,2026-10-01 09:00:00,2026-10-01 09:00:00,Top-Up by *1234,300.00,0.00,EUR,COMPLETED,600.00\n'));
  const r = roles(f);
  assert.equal(r[2], 'date');
  assert.equal(r[4], 'description');
  assert.equal(r[5], 'amount');
  assert.equal(r[7], 'currency');
  assert.equal(r[6], undefined);
  assert.equal(f.settings.currency, 'EUR');
  assert.deepEqual(tx(f).map((t) => [t.date, t.amount, t.currency]), [['2026-10-04', -46.2, 'EUR'], ['2026-10-01', 300, 'EUR']]);
});

test('European decimals and positive spending amounts', () => {
  const f = processFile('ausgaben.csv', enc('Datum;Beschreibung;Kategorie;Betrag\n01.10.2026;Miete;Wohnen;1.980,00\n03.10.2026;Migros;Lebensmittel;87,35\nTotal;;;2.067,35\n'));
  assert.equal(f.settings.decimal, 'comma');
  assert.equal(f.settings.sign, 'positive-out');
  assert.deepEqual(tx(f).map((t) => [t.amount, t.rawCategory]), [[-1980, 'Wohnen'], [-87.35, 'Lebensmittel']]);
  assert.equal(f.records.stats.skippedTotals, 1);
});

test('Category/Budget/Actual sheet, Soll/Ist and budget-only files', () => {
  const a = processFile('overview.csv', enc('Category,Budget,Actual\nGroceries,"1,300.00","1,368.35"\nRent,1980,1980\nTotal,3280,3348.35\n'), { month: '2026-10' });
  assert.equal(a.settings.kind, 'category');
  assert.deepEqual(roles(a), { 0: 'category', 1: 'budget', 2: 'actual' });
  assert.equal(a.records.budgets.length, 2);
  assert.equal(a.records.transactions.length, 2);
  assert.equal(a.records.transactions[0].month, '2026-10');
  assert.equal(a.records.stats.skippedTotals, 1);

  const s = processFile('plan.csv', enc('Posten;Soll;Ist\nFerien;400;250\nGeschenke;100;80\n'));
  assert.deepEqual(roles(s), { 0: 'category', 1: 'budget', 2: 'actual' });

  const b = processFile('Budget 2026.csv', enc('Kategorie;Betrag\nHousing;1980\nGroceries;1300\nSumme;3280\n'));
  assert.equal(b.settings.kind, 'category');
  assert.deepEqual(roles(b), { 0: 'category', 1: 'budget' });
  assert.equal(b.records.budgets.length, 2);
  assert.equal(b.records.budgets[0].month, null);
  const once = processFile('Budget 2026.csv', enc('Kategorie;Betrag\nHousing;25000\n'), { budgetScope: 'once', month: '2026-01' });
  assert.equal(once.records.budgets[0].month, '2026-01');
});

test('Soll/Haben is debit/credit when dated', () => {
  const f = processFile('bank.csv', enc('Datum;Text;Soll;Haben;Saldo\n02.10.2026;Coop;45.10;;100\n03.10.2026;Gutschrift;;200.00;300\n'));
  assert.deepEqual(roles(f), { 0: 'date', 1: 'description', 2: 'out', 3: 'in' });
  assert.deepEqual(tx(f).map((t) => t.amount), [-45.1, 200]);
});

test('Wide sheet with one column per month, Total column and Total row skipped', () => {
  const f = processFile('budget-2026.csv', enc('Kategorie;Jan;Feb;M\u00E4rz;Total\nMiete;1980;1980;1980;5940\nFerien;0;800;0;800\nTotal;1980;2780;1980;7172\n'), { year: 2026 });
  assert.equal(f.settings.kind, 'wide');
  assert.deepEqual(f.settings.monthCols, { 1: '2026-01', 2: '2026-02', 3: '2026-03' });
  assert.equal(f.settings.wideMeaning, 'budget');
  assert.deepEqual(f.records.budgets.map((b) => [b.category, b.month, b.amount]), [['Miete', '2026-01', 1980], ['Miete', '2026-02', 1980], ['Miete', '2026-03', 1980], ['Ferien', '2026-02', 800]]);
  const g = processFile('ausgaben_ist.csv', enc('Category,2026-01,2026-02,Sum\nFood,500,600,1100\n'));
  assert.equal(g.settings.wideMeaning, 'actual');
  assert.deepEqual(g.records.transactions.map((t) => [t.month, t.amount]), [['2026-01', -500], ['2026-02', -600]]);
});

test('Headerless file and direction flag column', () => {
  const f = processFile('noheader.csv', enc('2026-10-01,Migros Z\u00FCrich,45.20\n2026-10-02,Coop,12.00\n2026-10-03,SBB,3.40\n'));
  assert.equal(f.settings.headerRow, -1);
  assert.equal(f.settings.kind, 'transactions');
  assert.equal(tx(f).length, 3);
  const d = processFile('dc.csv', enc('Date,Payee,Amount,Type\n01/10/2026,Coop,45.20,DBIT\n02/10/2026,Salary,5000,CRDT\n'));
  assert.equal(roles(d)[3], 'direction');
  assert.deepEqual(tx(d).map((t) => t.amount), [-45.2, 5000]);
});

test('Excel serial dates and Windows-1252 encoding', () => {
  const bytes = new Uint8Array([...enc('Datum;Empf'), 0xe4, ...enc('nger;Betrag\n46296;Z'), 0xfc, ...enc('rich Versicherung;-80.00\n46297;Migros;-12.00\n')]);
  const f = processFile('excel.csv', bytes);
  assert.equal(f.settings.encoding, 'windows-1252');
  assert.equal(f.settings.dateFormat, 'serial');
  assert.equal(tx(f)[0].date, '2026-10-01');
  assert.equal(tx(f)[0].desc, 'Z\u00FCrich Versicherung');
});

test('User overrides are applied (columns, sign, decimal)', () => {
  const base = processFile('x.csv', enc('Date,Text,Value\n2026-10-01,Coop,45.20\n2026-10-02,Refund,-5.00\n'));
  const cols = [...base.settings.columns];
  const f = processFile('x.csv', enc('Date,Text,Value\n2026-10-01,Coop,45.20\n2026-10-02,Refund,-5.00\n'), { sign: 'positive-out', columns: cols });
  assert.deepEqual(tx(f).map((t) => t.amount), [-45.2, 5]);
});

test('Hostile content stays inert text', () => {
  const f = processFile('evil.csv', enc('Datum;Text;Betrag\n01.10.2026;"<img src=x onerror=alert(1)>\u202Egnp.exe";-1.00\n02.10.2026;=HYPERLINK("http://evil");-2.00\n03.10.2026;__proto__;-3.00\n'));
  assert.equal(tx(f)[0].desc, '<img src=x onerror=alert(1)>gnp.exe');
  assert.equal(tx(f)[1].desc, '=HYPERLINK("http://evil")');
  assert.equal(({}).polluted, undefined);
});

test('File size limit', () => {
  assert.throws(() => processFile('big.csv', { length: 16 * 1024 * 1024 }), /larger than/);
});
