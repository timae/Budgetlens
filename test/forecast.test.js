import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildForecast, fixedSchedule, goalMonthly, planBaseline, splitContribution } from '../web/js/forecast.js';
import { processFile } from '../web/js/pipeline.js';

const enc = (s) => new TextEncoder().encode(s);

test('fixed costs are scheduled by their rhythm, overdue ones in the first month', () => {
  assert.deepEqual(fixedSchedule({ every: 1, next: '2026-11-01' }, '2026-11', '2027-02'), ['2026-11', '2026-12', '2027-01', '2027-02']);
  assert.deepEqual(fixedSchedule({ every: 3, next: '2026-12-08' }, '2026-11', '2027-06'), ['2026-12', '2027-03', '2027-06']);
  assert.deepEqual(fixedSchedule({ every: 12, next: '2026-09-20' }, '2026-11', '2027-10'), ['2026-11']);
  assert.deepEqual(fixedSchedule({ every: 1 }, '2026-11', '2026-12'), ['2026-11', '2026-12']);
});

test('goals: monthly amount to reach the target by its month', () => {
  assert.deepEqual(goalMonthly({ amount: 6000, saved: 0, by: '2027-10' }, '2026-11'), { monthly: 500, months: 12, left: 6000, done: false });
  assert.equal(goalMonthly({ amount: 1000, saved: 400, by: '2026-11' }, '2026-11').monthly, 600);
  assert.equal(goalMonthly({ amount: 1000, saved: 1000, by: '2027-01' }, '2026-11').done, true);
  assert.equal(goalMonthly({ amount: 1200, saved: 0, by: '2026-01' }, '2026-11').months, 1, 'a past target month means: this month');
});

test('forecast: balance per month and the contribution that never dips below the minimum', () => {
  const f = buildForecast({
    start: '2026-11', months: 12, balance: 2000, buffer: 1000,
    contributions: [{ name: 'Alex', monthly: 6500 }, { name: 'Sam', monthly: 3500 }],
    variable: 3000,
    fixed: [{ payee: 'Rent', amount: 2000, every: 1, next: '2026-11-01' }, { payee: 'Tax', amount: 6000, every: 12, next: '2027-03-31' }, { payee: 'ewz', amount: 150, every: 3, next: '2026-12-08' }],
    goals: [{ name: 'Holidays', amount: 4800, saved: 0, by: '2027-10' }],
  });
  assert.equal(f.rows.length, 12);
  assert.equal(f.rows[0].fixed, 2000);
  assert.equal(f.rows[1].fixed, 2150);
  assert.equal(f.rows[4].fixed, 8150, 'March: rent + yearly tax + quarterly ewz');
  assert.equal(f.rows[0].goals, 400);
  assert.equal(f.rows[0].closing, 2000 + 10000 - 2000 - 3000 - 400);
  // Averages: fixed 2000 + 6000/12 + 150*4/12 = 2550; total out 2550 + 3000 + 400 = 5950.
  assert.equal(f.average, 5950);
  // Required: the binding month is March (tax). After 5 months: base = -(5*5400) - 6000 - 2*150 = -33300.
  assert.equal(f.required, Math.round(((1000 - 2000 + 33300) / 5) * 100) / 100);
  assert.deepEqual(f.shortfallMonths, []);
  const tight = buildForecast({ start: '2026-11', months: 6, balance: 0, buffer: 500, contributions: [{ name: 'A', monthly: 1000 }], variable: 1200 });
  assert.equal(tight.rows[0].belowBuffer, true);
  assert.equal(tight.required, 1700);
});

test('split the required amount like today, or equally', () => {
  const s = splitContribution(9000, [{ name: 'Alex', monthly: 6500 }, { name: 'Sam', monthly: 3500 }]);
  assert.deepEqual(s.map((x) => [x.name, x.amount, x.change]), [['Alex', 5850, -650], ['Sam', 3150, -350]]);
  const e = splitContribution(3001, [{ name: 'A', monthly: 0 }, { name: 'B', monthly: 0 }]);
  assert.deepEqual(e.map((x) => x.amount), [1501, 1500]);
  assert.deepEqual(splitContribution(100, []), []);
  const people = [{ name: 'Alex', monthly: 6500 }, { name: 'Sam', monthly: 3500 }];
  assert.deepEqual(splitContribution(9000, people, { mode: 'equal' }).map((x) => x.amount), [4500, 4500]);
  assert.deepEqual(splitContribution(9000, people, { mode: 'income', weights: new Map([['Alex', 9000], ['Sam', 6000]]) }).map((x) => x.amount), [5400, 3600]);
  assert.deepEqual(splitContribution(9000, people, { mode: 'custom', weights: new Map([['Alex', 70], ['Sam', 30]]) }).map((x) => x.amount), [6300, 2700]);
  assert.deepEqual(splitContribution(9000, people, { mode: 'income', weights: new Map() }).map((x) => x.amount), [4500, 4500], 'no incomes entered yet: equal');
});

test('baseline from complete months: variable spending, income and who pays in', () => {
  const tx = (date, amount, category, desc = '', extra = {}) => ({ date, month: date.slice(0, 7), amount, category, desc, currency: 'CHF', ...extra });
  const txs = [
    tx('2026-09-01', -2000, 'Housing', 'rent', { fixed: true }),
    tx('2026-09-05', -800, 'Groceries'),
    tx('2026-09-25', 6500, 'Transfers & savings', 'Gutschrift Auftraggeber: Alex Muster'),
    tx('2026-09-26', 3500, 'Transfers & savings', 'Gutschrift Konto\u00FCbertrag: Sam Beispiel'),
    tx('2026-09-27', 50, 'Income', 'Zins'),
    tx('2026-10-05', -1200, 'Groceries'),
    tx('2026-10-25', 6500, 'Transfers & savings', 'Gutschrift Auftraggeber: Alex Muster'),
    tx('2026-10-26', 3500, 'Transfers & savings', 'Gutschrift Konto\u00FCbertrag: Sam Beispiel'),
    tx('2026-11-03', -999, 'Groceries'),
  ];
  const b = planBaseline(txs, ['2026-09', '2026-10'], { ownNames: ['Alex', 'Sam'] });
  assert.equal(b.variable, 1000);
  assert.equal(b.otherIncome, 25);
  assert.deepEqual(b.contributions, [{ name: 'Alex', monthly: 6500 }, { name: 'Sam', monthly: 3500 }]);
});

test('latest balance is read from the export (newest-first and oldest-first)', () => {
  const newest = processFile('zkb.csv', enc('"Date";"Booking text";"Debit CHF";"Credit CHF";"Balance CHF"\n"29.10.2026";"Pending";"3.35";"";""\n"28.10.2026";"Coop";"20.15";"";"11788.68"\n"28.10.2026";"Sprungli";"18.80";"";"11808.83"\n"27.10.2026";"Credit";"";"6500.00";"11833.40"\n'));
  assert.deepEqual(newest.hint.balance, { date: '2026-10-28', amount: 11788.68 });
  const oldest = processFile('x.csv', enc('Datum;Text;Betrag;Saldo\n01.10.2026;A;-10;990\n02.10.2026;B;-10;980\n02.10.2026;C;-5;975\n'));
  assert.deepEqual(oldest.hint.balance, { date: '2026-10-02', amount: 975 });
});
