import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manualDue, manualMonthly, manualTransactions, OUTSIDE } from '../web/js/manual.js';
import { buildForecast } from '../web/js/forecast.js';
import { analyze } from '../web/js/analyze.js';
import { loadSettings, saveSettings } from '../web/js/settings.js';

const gym = { name: 'Gym', category: 'Leisure & travel', amount: 89, every: 1, start: '2026-01', end: '', person: 'Alex', currency: 'CHF' };
const tax = { name: 'Taxes', category: 'Taxes & fees', amount: 6000, every: 12, start: '2026-03', end: '', person: '', currency: 'CHF' };
const bike = { name: 'New bike', category: 'Shopping', amount: 1200, every: 0, start: '2026-09', end: '', person: 'Sam', currency: 'CHF' };
const FULL = { get: () => ({ fraction: 1, full: true }) };

test('manual costs become monthly-share transactions in the analysed months', () => {
  const txs = manualTransactions([gym, tax, bike], ['2026-08', '2026-09', '2026-10']);
  assert.equal(txs.length, 7);
  assert.deepEqual(txs.filter((t) => t.payee === 'Taxes').map((t) => t.amount), [-500, -500, -500]);
  assert.deepEqual(txs.filter((t) => t.payee === 'New bike').map((t) => t.month), ['2026-09']);
  assert.ok(txs.every((t) => t.account === OUTSIDE && t.synthetic && t.manual));
  assert.equal(txs.find((t) => t.payee === 'Gym').person, 'Alex');
  assert.equal(txs.find((t) => t.payee === 'Taxes').fixed, true);
  assert.equal(txs.find((t) => t.payee === 'New bike').fixed, false);
  const a = analyze(txs, [], { currency: 'CHF', coverage: FULL });
  assert.equal(a.totals.spent, 89 * 3 + 1500 + 1200);
  assert.equal(a.categories.find((c) => c.name === 'Taxes & fees').fixed, 1500);
  assert.equal(manualTransactions([{ ...gym, end: '2026-08' }], ['2026-08', '2026-09']).length, 1, 'ends after its last month');
  assert.equal(manualMonthly(tax), 500);
  assert.equal(manualMonthly(bike), 0);
});

test('in the forecast, manual costs are due in their real months', () => {
  assert.deepEqual(manualDue(tax, '2026-11', '2027-10'), [{ month: '2027-03', amount: 6000 }]);
  assert.deepEqual(manualDue(gym, '2026-11', '2027-01').map((d) => d.month), ['2026-11', '2026-12', '2027-01']);
  assert.deepEqual(manualDue(bike, '2026-11', '2027-10'), []);
  const f = buildForecast({ start: '2026-11', months: 12, balance: 0, contributions: [{ name: 'A', monthly: 1000 }], due: manualDue(tax, '2026-11', '2027-10').map((d) => ({ ...d, payee: 'Taxes' })) });
  assert.equal(f.rows[4].fixed, 6000);
  assert.equal(f.rows[4].fixedItems[0].payee, 'Taxes');
});

test('manual costs are saved in the settings file and validated on load', () => {
  const base = { budgetEdits: new Map(), cardOwners: new Map(), accountSettings: [], payeeRules: new Map(), categoryAliases: new Map(), ownNames: '', fixedOverrides: new Map(), fixedManual: new Map(), excluded: new Set(), ruleEntries: [], useFileCategories: true, plan: null };
  const back = loadSettings(saveSettings({ ...base, manualItems: [gym, tax, bike] }));
  assert.deepEqual(back.manualItems.map((m) => [m.name, m.every, m.amount, m.start]), [['Gym', 1, 89, '2026-01'], ['Taxes', 12, 6000, '2026-03'], ['New bike', 0, 1200, '2026-09']]);
  const evil = loadSettings(JSON.stringify({ app: 'budget-lens', version: 2, manualItems: [{ name: '<b>x</b>', category: 'A', amount: -5, every: 7, start: 'soon', currency: 'chf' }, { name: 'ok', category: 'B', amount: 10, every: 3, start: '2026-01', currency: 'EUR', end: '2025-01' }] }));
  assert.deepEqual(evil.manualItems.map((m) => [m.name, m.every, m.currency, m.end]), [['ok', 3, 'EUR', '']]);
});
