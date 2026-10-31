import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardOf, assignPeople, cardSummary, personSummary, accountSummary, SHARED, UNASSIGNED } from '../web/js/people.js';
import { applyBudgetEdits, budgetCSV, budgetKey, parseBudgetInput, suggestMonthly } from '../web/js/budget.js';
import { processFile } from '../web/js/pipeline.js';
import { analyze } from '../web/js/analyze.js';
import { INCOME, TRANSFERS } from '../web/js/categorize.js';

test('card numbers are found in common bank description formats', () => {
  assert.equal(cardOf('Purchase ZKB Visa Debit card no. xxxx 1234, Migros'), '1234');
  assert.equal(cardOf('Einkauf ZKB Visa Debit Karte Nr. XXXX5678, Coop'), '5678');
  assert.equal(cardOf('KAUF/DIENSTLEISTUNG VOM 29.09.2026 KARTEN NR. XXXX4321 COOP'), '4321');
  assert.equal(cardOf('Top-Up by *9876'), '9876');
  assert.equal(cardOf('Debitkarte **** 2468 Denner'), '2468');
  assert.equal(cardOf('Debit Standing order: Kita Sonnenschein GmbH, 8000'), '');
  assert.equal(cardOf('SUMUP *ACHTVIER GMBH 0000'), '');
});

const tx = (o) => ({ date: '2026-10-01', month: '2026-10', amount: -10, category: 'Groceries', currency: 'CHF', card: '', file: 0, ...o });

test('people: individual accounts belong to their owner, shared accounts split by card', () => {
  const accounts = [{ name: 'Joint', kind: 'shared', owner: '' }, { name: 'Tim private', kind: 'individual', owner: 'Tim' }, { name: 'K private', kind: 'individual', owner: '' }];
  const txs = assignPeople([
    tx({ card: '1234', amount: -50 }),
    tx({ card: '5678', amount: -30 }),
    tx({ card: '', amount: -2000, category: 'Housing' }),
    tx({ file: 1, card: '5678', amount: -20 }),
    tx({ file: 2, amount: -5 }),
    tx({ amount: 6000, category: INCOME }),
  ], { cardOwners: new Map([['1234', 'Tim'], ['5678', 'K']]), accountOfFile: (i) => accounts[i] });
  assert.deepEqual(txs.map((t) => [t.account, t.person]), [
    ['Joint', 'Tim'], ['Joint', 'K'], ['Joint', SHARED], ['Tim private', 'Tim'], ['K private', UNASSIGNED], ['Joint', SHARED],
  ]);
  const ps = personSummary(txs);
  assert.deepEqual(ps.map((p) => [p.name, p.spent]), [['Tim', 70], ['K', 30], [SHARED, 2000], [UNASSIGNED, 5]]);
  assert.ok(Math.abs(ps.reduce((s, p) => s + p.share, 0) - 1) < 1e-9);
  assert.deepEqual(cardSummary(txs).map((c) => [c.card, c.count]), [['5678', 2], ['1234', 1]]);
  const acc = accountSummary(txs, new Set([TRANSFERS]));
  assert.deepEqual(acc.find((a) => a.name === 'Joint'), { name: 'Joint', spent: 2080, moneyIn: 6000, count: 4 });
});

test('person filter feeds the normal analysis', () => {
  const txs = assignPeople([tx({ card: '1234', amount: -50 }), tx({ card: '5678', amount: -30 })],
    { cardOwners: new Map([['1234', 'Tim']]), accountOfFile: () => ({ name: 'Joint', kind: 'shared', owner: '' }) });
  const a = analyze(txs.filter((t) => t.person === 'Tim'), [], { currency: 'CHF' });
  assert.equal(a.totals.spent, 50);
});

test('budget edits replace file budgets per category and currency', () => {
  const file = [
    { category: 'Groceries', month: null, amount: 1200, currency: 'CHF' },
    { category: 'Housing', month: '2026-10', amount: 2000, currency: 'CHF' },
    { category: 'Groceries', month: null, amount: 300, currency: 'EUR' },
  ];
  const edits = new Map([
    [budgetKey('CHF', 'groceries'), { category: 'Groceries', amount: 1400, currency: 'CHF' }],
    [budgetKey('CHF', 'Eating out'), { category: 'Eating out', amount: 350, currency: 'CHF' }],
    [budgetKey('CHF', 'Housing'), { category: 'Housing', amount: 0, currency: 'CHF' }],
  ]);
  const out = applyBudgetEdits(file, edits);
  assert.deepEqual(out.map((b) => [b.category, b.currency, b.amount, b.month]).sort(), [
    ['Eating out', 'CHF', 350, null], ['Groceries', 'CHF', 1400, null], ['Groceries', 'EUR', 300, null],
  ]);
  const a = analyze([tx({ month: '2026-09', date: '2026-09-01' }), tx({})], out, { currency: 'CHF' });
  assert.equal(a.categories.find((c) => c.name === 'Groceries').budget, 2800);
});

test('budget input parsing and suggestions', () => {
  assert.equal(parseBudgetInput(''), null);
  assert.equal(parseBudgetInput("1'250.50"), 1250.5);
  assert.equal(parseBudgetInput('99,5'), 99.5);
  assert.equal(parseBudgetInput('0'), 0);
  assert.ok(Number.isNaN(parseBudgetInput('-5')));
  assert.ok(Number.isNaN(parseBudgetInput('abc')));
  assert.ok(Number.isNaN(parseBudgetInput('1e12')));
  assert.equal(suggestMonthly(1234, 3), 420);
  assert.equal(suggestMonthly(0, 3), 0);
});

test('downloaded budget CSV loads back as monthly budgets', () => {
  const csv = budgetCSV([{ category: 'Groceries', amount: 1400 }, { category: '=cmd', amount: 10 }, { category: 'Empty', amount: 0 }]);
  assert.ok(csv.includes(`"'=cmd"`));
  const f = processFile('budget-lens-budget_CHF.csv', new TextEncoder().encode(csv));
  assert.equal(f.settings.kind, 'category');
  assert.deepEqual(f.records.budgets.map((b) => [b.category, b.amount, b.month]), [['Groceries', 1400, null], ["'=cmd", 10, null]]);
});
