// Regression tests for the issues found in the logic review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processFile, prepareTransactions } from '../web/js/pipeline.js';
import { defaultRules, TRANSFERS, INCOME } from '../web/js/categorize.js';
import { analyze, monthCoverage } from '../web/js/analyze.js';
import { detectRecurring } from '../web/js/recurring.js';
import { clusterAccounts, dedupe, defaultAccountName, fingerprint, markOwnTransfers, matchSaved } from '../web/js/accounts.js';

const enc = (s) => new TextEncoder().encode(s);
const rules = defaultRules();
const HEAD = 'Datum;Buchungstext;Belastung;Gutschrift\n';
const load = (files) => {
  const results = files.map(([name, csv]) => processFile(name, enc(csv)));
  const txs = prepareTransactions(results, rules);
  const fps = results.map((r, i) => (r.settings.kind === 'transactions' ? fingerprint(r, txs.filter((t) => t.file === i)) : null));
  const { clusters, of } = clusterAccounts(fps);
  return { results, txs: txs.map((t) => ({ ...t, account: of[t.file] })), clusters, of, fps };
};

test('1. overlapping exports of one account are not counted twice', () => {
  const sep = '15.09.2026;Kauf Karte xxxx 1234 Migros;50.00;\n20.09.2026;Kauf Karte xxxx 1234 Coop;30.00;\n20.09.2026;Kauf Karte xxxx 1234 Coop;30.00;\n';
  const oct = '05.10.2026;Kauf Karte xxxx 1234 Migros;40.00;\n';
  const { txs, clusters, of } = load([['zkb_sep.csv', HEAD + sep], ['zkb_sep_oct.csv', HEAD + sep + oct]]);
  assert.equal(clusters.length, 1);
  const { txs: kept, removed } = dedupe(txs, (f) => of[f]);
  assert.equal(kept.reduce((s, t) => s - t.amount, 0), 150); // two identical Coop rows in one file stay
  assert.equal(removed.get(1), 3);
});

test('1b. different accounts with identical rows are kept apart', () => {
  const a = HEAD + '01.10.2026;Kauf Karte xxxx 1111 Coop;10.00;\n';
  const b = HEAD + '01.10.2026;Kauf Karte xxxx 2222 Coop;10.00;\n';
  const { clusters } = load([['a.csv', a], ['b.csv', b]]);
  assert.equal(clusters.length, 2);
});

test('accounts are recognised by IBAN, or by layout plus cards, and get readable names', () => {
  const pf = (iban, row) => `Konto:;${iban}\nW\u00E4hrung:;CHF\n\nBuchungsdatum;Avisierungstext;Gutschrift in CHF;Lastschrift in CHF;Saldo in CHF\n${row}\n`;
  const { clusters, fps } = load([
    ['pf1.csv', pf('CH93 0076 2011 6238 5295 7', '01.09.2026;Coop;;-10.00;100')],
    ['pf2.csv', pf('CH9300762011623852957', '01.10.2026;Migros;;-20.00;80')],
    ['pf3.csv', pf('CH56 0483 5012 3456 7800 9', '01.10.2026;Migros;;-20.00;80')],
  ]);
  assert.equal(fps[0].iban, 'CH9300762011623852957');
  assert.equal(clusters.length, 2);
  assert.equal(defaultAccountName(clusters[0]), 'PostFinance \u20262957');
  const saved = [{ iban: '', layout: 'x', cards: ['1234'] }, { iban: 'CH9300762011623852957', layout: '', cards: [] }];
  assert.equal(matchSaved(clusters[0], saved), 1);
  const z = load([['Account statement 1.csv', HEAD + '01.10.2026;Kauf Karte xxxx 7777 Coop;10.00;\n'], ['Account statement 2.csv', HEAD + '02.11.2026;Kauf Karte xxxx 7777 Coop;12.00;\n']]);
  assert.equal(z.clusters.length, 1, 'monthly exports with the same card are one account');
  assert.equal(matchSaved(z.clusters[0], [{ iban: '', layout: z.clusters[0].layout, cards: ['7777'] }]), 0);
});

test('2. incomplete months: no misleading month-over-month, prorated budgets, average of full months', () => {
  const tx = (date, amount, category = 'Groceries') => ({ date, month: date.slice(0, 7), amount, category, currency: 'CHF', payee: 'x', desc: 'x', account: 'a' });
  const txs = [tx('2026-08-01', -100), tx('2026-08-31', -2000, 'Housing'), tx('2026-09-02', -100), tx('2026-09-30', -2000, 'Housing'), tx('2026-10-03', -100), tx('2026-10-15', -50)];
  const cov = monthCoverage(txs);
  assert.equal(cov.get('2026-08').full, true);
  assert.equal(cov.get('2026-09').full, true);
  assert.equal(cov.get('2026-10').full, false);
  assert.ok(Math.abs(cov.get('2026-10').fraction - 15 / 31) < 1e-9);
  const a = analyze(txs, [{ category: 'Groceries', month: null, amount: 310, currency: 'CHF' }], { currency: 'CHF', coverage: cov });
  assert.equal(a.totals.mom.lastMonth, '2026-09');
  assert.equal(a.totals.mom.prevMonth, '2026-08');
  assert.equal(a.totals.avgMonthly, 2100);
  assert.equal(a.categories.find((c) => c.name === 'Groceries').budget, 310 + 310 + 150);
  assert.deepEqual(a.partialMonths.map((p) => p.month), ['2026-10']);
});

test('3. a standing order that moves between the 1st and the 31st is monthly', () => {
  const so = ['31.05.2026', '01.07.2026', '31.07.2026', '01.09.2026', '30.09.2026', '30.10.2026'].map((d) => `${d};Belastung Dauerauftrag: Miete Verwaltung AG;2000.00;`).join('\n');
  const { txs } = load([['so.csv', HEAD + so]]);
  const r = detectRecurring(txs);
  assert.equal(r.length, 1);
  assert.equal(r[0].every, 1);
  assert.equal(r[0].monthly, 2000);
  assert.equal(r[0].confidence, 'high');
  assert.ok(r[0].reasons.includes('standing order or eBill'));
});

test('3b. eBills paid on varying days and premiums seen twice are still found', () => {
  const rows = ['12.08.2026;Belastung eBill: Wingo;49.95;', '31.08.2026;Belastung eBill: Wingo;49.95;', '30.09.2026;Belastung eBill: Wingo;49.95;',
    '01.09.2026;Belastung eBill: Helsana Versicherungen AG;1095.40;', '21.08.2026;Belastung eBill: Helsana Versicherungen AG;210.00;', '01.10.2026;Belastung eBill: Helsana Versicherungen AG;1095.40;'];
  const r = detectRecurring(load([['x.csv', HEAD + rows.join('\n')]]).txs);
  const wingo = r.find((x) => x.payee === 'Wingo');
  const helsana = r.find((x) => x.payee === 'Helsana');
  assert.equal(wingo.every, 1);
  assert.equal(helsana.amount, 1095.4);
  assert.equal(helsana.confidence, 'medium');
  assert.ok(helsana.reasons.some((x) => x.startsWith('only seen 2')));
});

test('4. a file of only positive amounts is read by its content', () => {
  const salary = processFile('salary.csv', enc('Date,Description,Amount\n2026-09-25,Salary ACME,7800\n2026-10-25,Salary ACME,7800\n'));
  assert.deepEqual(salary.records.transactions.map((t) => t.amount), [7800, 7800]);
  assert.ok(salary.warnings.some((w) => w.includes('money in')));
  const spend = processFile('ausgaben.csv', enc('Date,Description,Amount\n2026-09-25,Migros,78\n2026-10-25,Coop,12\n'));
  assert.deepEqual(spend.records.transactions.map((t) => t.amount), [-78, -12]);
  assert.ok(spend.warnings.some((w) => w.includes('money out')));
});

test('5. foreign-currency, individual-amount and type columns are not misread', () => {
  const neon = processFile('neon.csv', enc('"Date";"Amount";"Original amount";"Original currency";"Exchange rate";"Description"\n"2026-10-04";"-35.20";"-36.00";"EUR";"0.98";"Booking.com"\n'));
  assert.equal(neon.records.transactions[0].currency, 'CHF');
  assert.equal(neon.records.transactions[0].amount, -35.2);
  const ubs = processFile('ubs.csv', enc('Trade date;Booking date;Currency;Debit;Credit;Individual amount;Balance;Description1\n2026-10-04;2026-10-04;CHF;-500.00;;-300.00;700;Collective order\n'));
  assert.equal(ubs.records.transactions[0].amount, -500);
  const pf = processFile('pf.csv', enc('Date;Type of transaction;Notification text;Credit in CHF;Debit in CHF\n05.10.2026;Credit;SALARY ACME AG;5200.00;\n'));
  const t = prepareTransactions([pf], rules)[0];
  assert.equal(t.payee, 'Salary Acme Ag');
  const dc = processFile('dc.csv', enc('Date,Payee,Amount,Type\n01/10/2026,Coop,45.20,DBIT\n02/10/2026,Salary,5000,CRDT\n'));
  assert.deepEqual(dc.records.transactions.map((x) => x.amount), [-45.2, 5000]);
});

test('6. money between own accounts is a transfer, not income', () => {
  const joint = HEAD + '25.10.2026;Gutschrift Auftraggeber: Tim Muster, Z\u00FCrich;;6500.00\n26.10.2026;Gutschrift Konto\u00FCbertrag: K Muster;;3500.00\n27.10.2026;Gutschrift Lohn ACME AG;;100.00\n';
  const priv = 'Date,Description,Amount\n2026-10-24,Transfer to joint account,-6500\n2026-10-25,Salary ACME,9000\n';
  const { txs } = load([['joint.csv', joint], ['tim.csv', priv]]);
  const marked = markOwnTransfers(txs, ['Muster']);
  const cats = marked.map((t) => `${t.amount}:${t.category}`);
  assert.deepEqual(cats, ['6500:Transfers & savings', '3500:Transfers & savings', '100:Income', '-6500:Transfers & savings', '9000:Income']);
  const pairOnly = markOwnTransfers(txs, []);
  assert.equal(pairOnly.find((t) => t.amount === 6500).category, TRANSFERS, 'matched by amount and date across accounts');
  assert.equal(pairOnly.find((t) => t.amount === 9000).category, INCOME);
});

test('11. user payee categories and file category aliases win over keyword rules', () => {
  const f = processFile('x.csv', enc('Date;Text;Kategorie;Betrag\n01.10.2026;Kauf Karte xxxx 1234 Cafe Central;;-5.00\n02.10.2026;Spoon Enge;;-15.00\n03.10.2026;Coop;Food;-30.00\n'));
  const txs = prepareTransactions([f], rules, { payeeRules: new Map([['spoon enge', 'Eating out']]), aliases: new Map([['food', 'Groceries']]) });
  assert.deepEqual(txs.map((t) => t.category), ['Coffee & bakery', 'Eating out', 'Groceries']);
});
