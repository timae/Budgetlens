// Deterministic sample files: a ZKB-style bank export, a Revolut export in EUR and a budget sheet.
import { addMonths } from '../../web/js/dates.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n) => String(n).padStart(2, '0');
const swiss = (n) => n.toFixed(2);

const CARD = 'Einkauf ZKB Visa Debit Karte Nr. xxxx 1234, ';
const VARIABLE = [
  // [description, min, max, times per month]
  [CARD + 'Migros MM Bahnhofstrasse 0801', 18, 140, 6],
  [CARD + 'Coop-1234 ZH City', 12, 160, 6],
  [CARD + 'Denner Z\u00FCrich Wiedikon', 8, 45, 2],
  [CARD + 'Cafe Central 0800 Zurich', 4.5, 19, 5],
  [CARD + 'Confiserie Sprungli AG V', 9, 38, 1],
  [CARD + 'Restaurant Tibits Z\u00FCrich', 28, 96, 2],
  [CARD + 'SV (Schweiz) AG Kantine', 11, 17, 4],
  [CARD + 'Digitec Galaxus AG, Zuri', 25, 260, 1],
  [CARD + 'SBB CFF FFS Mobile', 4.4, 88, 3],
  [CARD + 'Swisscharge A.G.', 4, 18, 3],
  [CARD + 'Apotheke am Platz 0801', 12, 60, 1],
  [CARD + 'H & M 0806 Zurich', 20, 120, 0.5],
  [CARD + 'Kino Arena Sihlcity', 19, 42, 0.6],
];

export function sampleFiles(today = new Date()) {
  const r = rng(20261031);
  const last = `${today.getFullYear()}-${pad(today.getMonth() + 1)}`;
  const months = [];
  for (let i = 5; i >= 0; i--) months.push(addMonths(last, -i));
  const rows = [];
  const lastDay = today.getDate();
  for (const m of months) {
    const [y, mo] = m.split('-').map(Number);
    const dim = new Date(y, mo, 0).getDate();
    const maxDay = m === last ? Math.max(1, lastDay) : dim;
    const at = (d) => `${pad(Math.min(d, maxDay))}.${pad(mo)}.${y}`;
    const add = (d, text, debit, credit) => rows.push([at(d), text, debit ? swiss(debit) : '', credit ? swiss(credit) : '']);
    add(25, 'Gutschrift: Lohn Muster AG, Bahnhofstrasse 1, 8001 Z\u00FCrich', 0, 7800);
    add(1, 'Belastung Dauerauftrag: Immobilien Muster AG Mietzins', 1980, 0);
    add(1, 'Belastung Dauerauftrag: Kita Sonnenschein GmbH', 1450, 0);
    add(2, 'Belastung eBill: Helsana Versicherungen AG, Z\u00FCrichstrasse 130, 8600', 1095.4, 0);
    add(12, 'Belastung eBill: Wingo, Contact Center, 3050 Bern', 49.95, 0);
    add(14, 'Online-Einkauf ZKB Visa Debit Karte Nr. xxxx 1234, Spotify P2F8', 12.95, 0);
    if (mo % 3 === 0) add(8, 'Belastung eBill: Elektrizit\u00E4tswerk der Stadt Z\u00FCrich, Tramstrasse 35', 157 + Math.round(r() * 40), 0);
    if (mo === 3 || mo === 9) add(20, 'Belastung eBill: Kantonales Steueramt Z\u00FCrich', 1850, 0);
    add(28, 'Belastung Mobile Banking: Sparkonto 3a VIAC', 588, 0);
    for (const [text, min, max, times] of VARIABLE) {
      let n = Math.floor(times) + (r() < times % 1 ? 1 : 0);
      if (m === last) n = Math.round(n * Math.min(1, maxDay / dim));
      for (let i = 0; i < n; i++) add(1 + Math.floor(r() * dim), text, min + r() * (max - min), 0);
    }
    if (mo === 7 || mo === 12) add(18, CARD + 'Hotel Bellevue Grindelwald', 640 + Math.round(r() * 300), 0);
    if (r() < 0.5) add(10, 'Gutschrift: R\u00FCckerstattung Migros MM Bahnhofstrasse', 0, 34.95);
  }
  rows.sort((a, b) => b[0].split('.').reverse().join('').localeCompare(a[0].split('.').reverse().join('')));
  let balance = 12000;
  const lines = ['"Datum";"Buchungstext";"Belastung CHF";"Gutschrift CHF";"Saldo CHF"'];
  for (const [d, t, deb, cred] of rows) {
    balance += (Number(cred) || 0) - (Number(deb) || 0);
    lines.push([d, t, deb, cred, swiss(balance)].map((c) => `"${c}"`).join(';'));
  }
  const bank = lines.join('\r\n') + '\r\n';

  const rev = ['Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance'];
  let rb = 600;
  for (const m of months.slice(-3)) {
    for (const [desc, amt] of [['Boulangerie Paul', -8.4], ['Ryanair', -89.99], ['Carrefour', -46.2], ['Uber', -17.5], ['Top-Up by *1234', 300]]) {
      const v = amt * (0.8 + r() * 0.4);
      rb += v;
      const day = pad(3 + Math.floor(r() * 20));
      rev.push(`${amt > 0 ? 'TOPUP' : 'CARD_PAYMENT'},Current,${m}-${day} 10:12:00,${m}-${day} 12:00:00,${desc},${v.toFixed(2)},0.00,EUR,COMPLETED,${rb.toFixed(2)}`);
    }
  }
  const revolut = rev.join('\n') + '\n';

  const budget = [
    'Kategorie;Budget pro Monat',
    'Housing;1980',
    'Childcare & kids;1450',
    'Health;1200',
    'Groceries;1300',
    'Eating out;350',
    'Coffee & bakery;250',
    'Transport;220',
    'Utilities & telecom;150',
    'Shopping;350',
    'Subscriptions & media;30',
    'Leisure & travel;250',
    'Taxes & fees;620',
    'Total;8000',
  ].join('\n') + '\n';

  const enc = new TextEncoder();
  return [
    { name: 'ZKB_Kontoauszug_sample.csv', bytes: enc.encode(bank) },
    { name: 'Revolut_EUR_sample.csv', bytes: enc.encode(revolut) },
    { name: 'Budget_2026_sample.csv', bytes: enc.encode(budget) },
  ];
}
