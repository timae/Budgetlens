import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRecurring, fixedCosts, fixedKey, markFixed, fixedStatus } from '../web/js/recurring.js';
import { saveSettings, loadSettings } from '../web/js/settings.js';
import { processFile, prepareTransactions } from '../web/js/pipeline.js';
import { defaultRules, TRANSFERS } from '../web/js/categorize.js';
import { analyze } from '../web/js/analyze.js';
import { sampleFiles } from './fixtures/sample.js';

const t = (date, amount, payee, category = 'Other', currency = 'CHF') => ({ date, month: date.slice(0, 7), amount, payee, desc: payee, category, currency });

test('monthly payments with a steady amount and day are detected; shopping is not', () => {
  const txs = [];
  for (const m of ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']) {
    txs.push(t(`${m}-01`, -1980, 'Immobilien Muster AG', 'Housing'));
    txs.push(t(`${m}-12`, -49.95, 'Wingo', 'Utilities & telecom'));
    for (const d of ['03', '09', '15', '22']) txs.push(t(`${m}-${d}`, -40 - Math.random() * 80, 'Migros', 'Groceries'));
  }
  txs.push(t('2026-08-20', -180, 'Helsana', 'Health'));
  for (const m of ['2026-07', '2026-08', '2026-09', '2026-10']) txs.push(t(`${m}-02`, -1095.4, 'Helsana', 'Health'));
  const r = detectRecurring(txs);
  const names = r.map((x) => x.payee);
  assert.deepEqual(names, ['Immobilien Muster AG', 'Helsana', 'Wingo']);
  const rent = r[0];
  assert.equal(rent.every, 1);
  assert.equal(rent.amount, 1980);
  assert.equal(rent.confidence, 'high');
  assert.equal(rent.next, '2026-11-01');
  assert.equal(r[1].amount, 1095.4); // the premium, not the deductible bill
});

test('quarterly and yearly rhythms', () => {
  const q = detectRecurring([t('2026-01-08', -157, 'ewz'), t('2026-04-08', -161, 'ewz'), t('2026-07-08', -159, 'ewz'), t('2026-10-08', -158, 'ewz')]);
  assert.equal(q.length, 1);
  assert.equal(q[0].every, 3);
  assert.ok(Math.abs(q[0].monthly - 53) < 1);
  const y = detectRecurring([t('2025-03-20', -335, 'Serafe'), t('2026-03-19', -335, 'Serafe')]);
  assert.equal(y[0].every, 12);
  assert.equal(y[0].confidence, 'medium');
  assert.deepEqual(detectRecurring([t('2026-01-01', -10, 'A'), t('2026-02-15', -400, 'A'), t('2026-03-02', -55, 'A')]), []);
});

test('user choices: dismiss, declare, change amount; matching transactions are flagged', () => {
  const detected = [
    { key: 'CHF|wingo', payee: 'Wingo', category: 'Utilities & telecom', currency: 'CHF', every: 1, amount: 49.95, confidence: 'high', last: '2026-10-12', next: '2026-11-12' },
    { key: 'CHF|spotify', payee: 'Spotify', category: 'Subscriptions & media', currency: 'CHF', every: 1, amount: 12.95, confidence: 'medium', last: '2026-10-14', next: '2026-11-14' },
  ];
  let items = fixedCosts(detected, new Map(), new Map());
  assert.deepEqual(items.map((i) => [i.payee, i.active]), [['Wingo', true], ['Spotify', false]]);
  items = fixedCosts(detected, new Map([['CHF|wingo', { active: false }], ['CHF|spotify', { active: true }]]),
    new Map([['CHF|kita sonnenschein', { key: 'CHF|kita sonnenschein', payee: 'Kita Sonnenschein', category: 'Childcare & kids', currency: 'CHF', amount: null, every: 1 }]]));
  assert.deepEqual(items.filter((i) => i.active).map((i) => [i.payee, i.source]).sort(), [['Kita Sonnenschein', 'declared'], ['Spotify', 'adjusted']]);
  const txs = markFixed([
    t('2026-10-14', -12.95, 'Spotify'), t('2026-10-15', -99, 'Spotify'), t('2026-10-01', -1450, 'Kita Sonnenschein'), t('2026-10-12', -49.95, 'Wingo'),
  ], items);
  assert.deepEqual(txs.map((x) => !!x.fixed), [true, false, true, false]);
  const a = analyze(txs, [], { currency: 'CHF' });
  assert.equal(a.totals.fixed, 1462.95);
  assert.equal(a.categories.find((c) => c.name === 'Other').fixed, 1462.95);
  assert.equal(fixedStatus({ last: '2026-08-01', next: '2026-09-01' }, '2026-10-29'), 'missing');
  assert.equal(fixedStatus({ last: '2026-10-01', next: '2026-11-01' }, '2026-10-29'), 'ok');
});

test('sample bank export: rent, childcare, insurance, phone and streaming are found', () => {
  const files = sampleFiles(new Date(2026, 9, 31)).map((s) => processFile(s.name, s.bytes));
  const txs = prepareTransactions(files, defaultRules());
  const r = detectRecurring(txs).filter((x) => x.confidence === 'high').map((x) => x.payee);
  for (const p of ['Immobilien Muster AG Mietzins', 'Kita Sonnenschein GmbH', 'Helsana', 'Wingo', 'Spotify']) assert.ok(r.includes(p), `${p} in ${r.join(', ')}`);
  for (const p of ['Migros', 'Coop', 'Apotheke', 'Carrefour', 'Boulangerie Paul']) assert.ok(!r.includes(p), `${p} should not be a fixed cost`);
  assert.equal(fixedKey('CHF', 'Wingo'), 'CHF|wingo');
});

const stateLike = () => ({
  budgetEdits: new Map([['CHF|groceries', { category: 'Groceries', amount: 1300, currency: 'CHF' }]]),
  cardOwners: new Map([['1234', 'Alex']]),
  accounts: new Map([['joint', { name: 'Joint', kind: 'shared', owner: '' }], ['alex private', { name: 'Alex private', kind: 'individual', owner: 'Alex' }]]),
  fileAccounts: [['ZKB_2026.csv', 'Joint']],
  fixedOverrides: new Map([['CHF|wingo', { active: false }]]),
  fixedManual: new Map([['CHF|kita', { key: 'CHF|kita', payee: 'Kita', category: 'Childcare & kids', currency: 'CHF', amount: 1450, every: 1 }]]),
  excluded: new Set([TRANSFERS]),
  ruleEntries: [['Groceries', 'migros, coop']],
  useFileCategories: false,
});

test('settings file round trip', () => {
  const back = loadSettings(saveSettings(stateLike()));
  assert.equal(back.budgetEdits.get('CHF|groceries').amount, 1300);
  assert.equal(back.cardOwners.get('1234'), 'Alex');
  assert.equal(back.accounts.get('alex private').kind, 'individual');
  assert.equal(back.fileAccounts.get('zkb 2026 csv'), 'Joint');
  assert.equal(back.fixedOverrides.get('CHF|wingo').active, false);
  assert.equal(back.fixedManual.get('CHF|kita').amount, 1450);
  assert.ok(back.excluded.has(TRANSFERS));
  assert.deepEqual(back.rules, [['Groceries', 'migros, coop']]);
  assert.equal(back.useFileCategories, false);
});

test('settings loader rejects or cleans hostile input', () => {
  assert.throws(() => loadSettings('not json'), /not a valid/);
  assert.throws(() => loadSettings('{"app":"other","version":1}'), /not a Budget Lens/);
  assert.throws(() => loadSettings('x'.repeat(2 * 1024 * 1024)), /too large/);
  const evil = JSON.stringify({
    app: 'budget-lens', version: 1,
    __proto__: { polluted: 1 },
    budgets: [{ currency: 'CHF', category: '<img src=x onerror=alert(1)>\u202E', monthly: 5 }, { currency: 'chf', category: 'x', monthly: 1 }, { currency: 'CHF', category: 'y', monthly: -1 }],
    cards: [{ card: '12345', owner: 'x' }, { card: '9999', owner: '\u200BBob' }],
    fixed: { overrides: [{ key: 'constructor', active: true }, { key: 'CHF|ok', amount: 'NaN', every: 7 }], declared: [{ key: '../x', currency: 'CHF' }] },
    rules: 'nope',
  });
  const s = loadSettings(evil);
  assert.equal(({}).polluted, undefined);
  assert.equal(s.budgetEdits.size, 1);
  assert.equal([...s.budgetEdits.values()][0].category, '<img src=x onerror=alert(1)>');
  assert.deepEqual([...s.cardOwners], [['9999', 'Bob']]);
  assert.deepEqual([...s.fixedOverrides.keys()], ['CHF|ok']);
  assert.deepEqual(s.fixedOverrides.get('CHF|ok'), {});
  assert.equal(s.fixedManual.size, 0);
  assert.equal(s.rules, null);
});
