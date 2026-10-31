import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, comparePeriods, percentDiff, presetRange, treemap, dataMonths } from '../web/js/analyze.js';
import { buildRules, defaultRules, categorize, matchCategory, payeeName, BRANDS, ruleText, INCOME, TRANSFERS } from '../web/js/categorize.js';
import { processFile, prepareTransactions, collectBudgets } from '../web/js/pipeline.js';
import { sampleFiles } from './fixtures/sample.js';

const t = (date, amount, category, desc = category, currency = 'CHF') => ({ date, month: date.slice(0, 7), amount, category, desc, payee: desc, currency });

test('default rules categorise Swiss merchants; whole words unless prefixed with *', () => {
  const rules = defaultRules();
  const cases = [
    ['Purchase ZKB Visa Debit card no. xxxx 5678, Migros MM Bahnhofstrasse 0801', 'Groceries'],
    ['Debit Standing order: Immobilien Muster AG Mietzins', 'Housing'],
    ['Debit Standing order: Kita Sonnenschein GmbH', 'Childcare & kids'],
    ['Debit eBill: Helsana Versicherungen AG', 'Health'],
    ['Purchase ZKB Visa Debit card no. xxxx 1234, GASTRO MUSTER GMB', 'Eating out'],
    ['Restaurant Tibits', 'Eating out'],
    ['Online purchase Swisscharge A.G.', 'Transport'],
    ['Bargeldbezug Bancomat ZKB', 'Cash'],
    ['Sparkonto \u00DCbertrag', TRANSFERS],
    ['Debit eBill: Wingo, Contact Center', 'Utilities & telecom'],
    ['Kauf Lily Factory', ''],
  ];
  for (const [desc, want] of cases) assert.equal(matchCategory(desc, rules), want, desc);
  const custom = buildRules([['Hobby', 'velo*, bike']]);
  assert.equal(matchCategory('Velogesch\u00E4ft AG', custom), 'Hobby');
  assert.equal(matchCategory('Ebike Shop', custom), '');
  assert.equal(ruleText(custom[0]), 'velo*, bike');
});

test('inflows: refunds reduce their category, other inflows are income', () => {
  const rules = defaultRules();
  assert.equal(categorize({ desc: 'Refund Migros MM', amount: 34.95 }, rules), 'Groceries');
  assert.equal(categorize({ desc: 'Credit originator: A. Muster', amount: 6200 }, rules), INCOME);
  assert.equal(categorize({ desc: 'Coop', amount: -10, rawCategory: 'Food' }, rules), 'Food');
  assert.equal(categorize({ desc: 'Coop', amount: -10, rawCategory: 'Food' }, rules, { useFileCategory: false }), 'Groceries');
});

test('payee names are cleaned and chains grouped', () => {
  assert.equal(payeeName('Purchase ZKB Visa Debit card no. xxxx 5678, Migros MM Bahnhofstrasse 0801', BRANDS), 'Migros');
  assert.equal(payeeName('Debit eBill: Parkhaus Muster AG, Musterstrasse 1, 8000 Z\u00FCrich, CH', BRANDS), 'Parkhaus Muster AG');
  assert.equal(payeeName('Purchase ZKB Visa Debit card no. xxxx 1234, GASTRO MUSTER GMB', BRANDS), 'Gastro Muster Gmb');
  assert.equal(payeeName('Purchase ZKB Visa Debit card no. xxxx 5678, SUMUP  *ACHTVIER GMBH 0000', BRANDS), 'Achtvier Gmbh');
  assert.equal(payeeName('Einkauf ZKB Visa Debit Karte Nr. xxxx 1234, Cafe Central 0800 Zurich', BRANDS), 'Cafe Central');
  assert.equal(payeeName('Belastung Mobile Banking: Sparkonto 3a VIAC', BRANDS), 'Sparkonto 3a VIAC');
});

test('analysis totals, shares, budgets, variance and month-over-month', () => {
  const txs = [
    t('2026-09-02', -1000, 'Housing'), t('2026-10-02', -1000, 'Housing'),
    t('2026-09-05', -200, 'Groceries'), t('2026-10-05', -400, 'Groceries'), t('2026-10-06', 50, 'Groceries'),
    t('2026-10-25', 5000, INCOME), t('2026-10-26', -300, TRANSFERS),
  ];
  const budgets = [{ category: 'groceries', month: null, amount: 300, currency: 'CHF' }, { category: 'Housing', month: '2026-10', amount: 1000, currency: 'CHF' }];
  const a = analyze(txs, budgets, { currency: 'CHF', excluded: new Set([TRANSFERS]) });
  assert.equal(a.totals.spent, 2550);
  assert.equal(a.totals.income, 5000);
  assert.equal(a.totals.avgMonthly, 1275);
  const g = a.categories.find((c) => c.name === 'Groceries');
  assert.equal(g.spent, 550);
  assert.equal(g.budget, 600); // 300 per month \u00D7 2 months
  assert.equal(g.status, 'near');
  const h = a.categories.find((c) => c.name === 'Housing');
  assert.equal(h.budget, 1000);
  assert.equal(h.status, 'over'); // 2000 spent vs 1000 (only October budgeted)
  assert.equal(a.totals.budget, 1600);
  assert.equal(a.totals.variance, 1600 - 2550);
  assert.equal(a.categories.find((c) => c.name === TRANSFERS).included, false);
  assert.equal(a.totals.mom.lastMonth, '2026-10');
  assert.equal(a.totals.mom.change, 1350 - 1200);
  assert.ok(Math.abs(a.categories.find((c) => c.name === 'Housing').share - 2000 / 2550) < 1e-9);
  assert.equal(a.monthly.find((m) => m.month === '2026-10').budget, 1300);
  const one = analyze(txs, budgets, { currency: 'CHF', from: '2026-10', to: '2026-10', excluded: new Set([TRANSFERS]) });
  assert.equal(one.totals.spent, 1350);
  assert.equal(one.categories.find((c) => c.name === 'Groceries').budget, 300);
});

test('currencies are never mixed or converted', () => {
  const txs = [t('2026-10-01', -10, 'Groceries', 'x', 'CHF'), t('2026-10-01', -99, 'Groceries', 'y', 'EUR')];
  assert.equal(analyze(txs, [], { currency: 'CHF' }).totals.spent, 10);
  assert.equal(analyze(txs, [], { currency: 'EUR' }).totals.spent, 99);
});

test('user-derived category names cannot pollute prototypes', () => {
  const txs = [t('2026-10-01', -10, '__proto__'), t('2026-10-01', -5, 'constructor'), t('2026-10-01', -1, 'toString')];
  const a = analyze(txs, [{ category: '__proto__', month: null, amount: 20, currency: 'CHF' }], { currency: 'CHF' });
  assert.equal(a.totals.spent, 16);
  assert.equal(a.categories.find((c) => c.name === '__proto__').budget, 20);
  assert.equal(({}).spent, undefined);
  assert.equal(Object.prototype.budget, undefined);
});

test('compare periods and percentage calculator', () => {
  const txs = [t('2025-10-01', -100, 'A'), t('2026-10-01', -150, 'A'), t('2026-10-02', -50, 'B')];
  const c = comparePeriods(txs, 'CHF', '2025', '2026');
  assert.deepEqual(c.rows.map((r) => [r.name, r.a, r.b]), [['A', 100, 150], ['B', 0, 50]]);
  assert.equal(c.rows[0].pct, 0.5);
  assert.equal(c.rows[1].pct, null);
  assert.equal(c.total.diff, 100);
  const p = percentDiff(80, 100);
  assert.equal(p.change, 0.25);
  assert.ok(Math.abs(p.difference - 20 / 90) < 1e-12);
  assert.equal(p.ratio, 1.25);
  assert.equal(percentDiff(0, 5).change, null);
});

test('period presets are relative to the latest data month', () => {
  const months = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03'];
  assert.deepEqual(presetRange('last-3', months), { from: '2026-01', to: '2026-03' });
  assert.deepEqual(presetRange('this-year', months), { from: '2026-01', to: '2026-03' });
  assert.deepEqual(presetRange('last-year', months), { from: '2025-01', to: '2025-12' });
  assert.deepEqual(presetRange('all', months), { from: '2025-11', to: '2026-03' });
});

test('treemap tiles fill the box proportionally', () => {
  const items = [{ value: 6 }, { value: 6 }, { value: 4 }, { value: 3 }, { value: 2 }, { value: 2 }, { value: 1 }];
  const tiles = treemap(items, 600, 400);
  assert.equal(tiles.length, 7);
  const area = tiles.reduce((s, r) => s + r.w * r.h, 0);
  assert.ok(Math.abs(area - 240000) < 1e-6);
  for (const r of tiles) {
    assert.ok(Math.abs(r.w * r.h - (r.item.value / 24) * 240000) < 1e-6);
    assert.ok(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 600 + 1e-6 && r.y + r.h <= 400 + 1e-6);
  }
});

test('sample data runs end to end through detection and analysis', () => {
  const files = sampleFiles(new Date(2026, 9, 31)).map((s) => processFile(s.name, s.bytes, {}, { defaultMonth: '2026-10' }));
  assert.equal(files[0].settings.kind, 'transactions');
  assert.equal(files[1].settings.currency, 'EUR');
  assert.equal(files[2].settings.kind, 'category');
  assert.equal(files[2].records.budgets.length, 12);
  const txs = prepareTransactions(files, defaultRules());
  const budgets = collectBudgets(files);
  assert.deepEqual(dataMonths(txs.filter((x) => x.currency === 'CHF')), ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
  const a = analyze(txs, budgets, { currency: 'CHF', excluded: new Set([TRANSFERS]) });
  assert.ok(a.totals.spent > 30000 && a.totals.spent < 70000, String(a.totals.spent));
  assert.ok(a.totals.income >= 6 * 7800);
  const names = a.categories.map((c) => c.name);
  for (const n of ['Housing', 'Groceries', 'Childcare & kids', 'Health']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('Other') || a.categories.find((c) => c.name === 'Other').spent < 200);
  const eur = analyze(txs, budgets, { currency: 'EUR', excluded: new Set([TRANSFERS]) });
  assert.ok(eur.totals.spent > 0);
  assert.equal(eur.totals.income, 0);
});
