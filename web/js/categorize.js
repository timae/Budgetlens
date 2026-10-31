// Keyword rules (editable in the UI) and payee clean-up.
import { LIMITS } from './limits.js';
import { cleanLabel, cleanText, normalizeKey } from './sanitize.js';

export const INCOME = 'Income';
export const TRANSFERS = 'Transfers & savings';
export const OTHER = 'Other';

// Order matters: the first matching rule wins (e.g. "Uber Eats" before "Uber").
export const DEFAULT_RULES = [
  [INCOME, 'lohn, salar, salaer, gehalt, salary, salaire, stipendio, payroll, bonus, kinderzulage, familienzulage, ahv rente, rente, pension, dividende, dividend, zinsgutschrift'],
  ['Housing', 'miete, mietzins, mietzinsen, loyer, affitto, rent, hypothek, hypothekarzins, nebenkosten, verwaltung, immobilien, livit, wincasa, privera, apleona, ubs fund management, swiss life immopulse, hausverwaltung, stockwerkeigentum'],
  ['Groceries', 'migros, coop, denner, aldi, lidl, spar, volg, landi, alnatura, farmy, globus delicatessa, manor food, metzgerei, delikatessen, molkerei, kase, bio markt, bachsermart, schmidtis, marche, primo, topcc, prodega, ottos, otto s, filiale, le shop, migros online, coop ch, aldi suisse, lidl schweiz'],
  ['Eating out', 'uber eats, just eat, eat ch, smood, dominos, restaurant*, ristorante*, gastro*, gasthaus, gasthof, wirtschaft, beiz, bistro, brasserie, trattoria, pizzeria, pizza, sushi, kebab, burger, mcdonald*, burger king, kfc, subway, popeyes, five guys, holy cow, tibits, hiltl, nooch, vapiano, bagel, take away, takeaway, imbiss, bar, pub, kantine, mensa, sv schweiz, zfv'],
  ['Coffee & bakery', 'starbucks, cafe, caffe, coffee, kaffee, rosterei, roesterei, vicafe, babus, sprungli, spruengli, confiserie, confiseur, backerei, baeckerei, bakery, boulangerie, panetteria, brezelkonig, brezelkoenig, kkiosk, k kiosk, kiosk, pasticceria, pasticeria, john baker, bachmann, honold, teuscher, laderach, laederach, gelateria'],
  ['Transport', 'sbb, cff, ffs, zvv, vbz, bernmobil, tpg, bvb, tl lausanne, postauto, car postal, autopostale, passengers, halbtax, generalabonnement, uber, taxi, bolt, publibike, voi, lime, tier, mobility, catch a car, parking, parkingpay, parkhaus, parkuhr, easypark, twint parking, shell, bp, migrol, socar, avia, agrola, tamoil, eni, coop pronto tankstelle, ruedi russel, tankstelle, swisscharge, evpass, move mobility, tesla supercharger, ionity, strassenverkehrsamt, vignette'],
  ['Health', 'helsana, css, swica, sanitas, visana, concordia, kpt, assura, groupe mutuel, atupri, okk, oekk, egk, sympany, aquilana, apothek*, pharmaci*, farmaci*, amavita, sunstore, toppharm, benu, drogerie, arzt, arztpraxis, praxis, zahnarzt*, dentist*, dental*, spital, hospital, klinik, medbase, permanence, sihlmed, physio, optiker, fielmann, labor'],
  ['Insurance', 'mobiliar, axa, zurich versicherung, allianz, baloise, generali, helvetia versicherung, vaudoise, smile direct, tcs, emmental versicherung, simpego, wefox, versicherung*, assurance*, assicurazion*'],
  ['Utilities & telecom', 'swisscom, sunrise, salt, wingo, yallo, m budget mobile, coop mobile, init7, quickline, upc, teleboy, serafe, billag, ewz, ekz, bkw, iwb, sig, romande energie, groupe e, axpo, ckw, aew, ewb, sgsw, elektrizitatswerk, energie, wasserversorgung, mr green, entsorgung, kehricht'],
  ['Childcare & kids', 'kita, krippe, kinderkrippe, hort, tagesschule, spielgruppe, tagesmutter, kibesuisse, baby walz, babywalz, vertbaudet, smyths, franz carl weber, spielwaren, little casimir, kinderarzt, musikschule'],
  ['Shopping', 'digitec, galaxus, brack, interdiscount, mediamarkt, media markt, fust, ikea, manor, globus, jelmoli, loeb, h m, h&m, zara, c a, c&a, uniqlo, zalando, about you, amazon, aliexpress, temu, shein, decathlon, ochsner, sportx, sport x, orell fussli, ex libris, thalia, pkz, schuh, schuhhaus, dosenbach, bata, tally weijl, cos, mango, depot, pfister, micasa, hornbach, jumbo, bauhaus, obi, do it garden, conforama, livique, otto, tchibo, nespresso, apple store, samsung'],
  ['Subscriptions & media', 'netflix, spotify, disney, apple com bill, apple com, itunes, google, youtube, amazon prime, prime video, amazon prim, audible, dazn, blue tv, sky, nzz, tages anzeiger, tamedia, ringier, republik, watson, chatgpt, openai, microsoft, adobe, dropbox, patreon, playstation, xbox, nintendo, steam'],
  ['Leisure & travel', 'hotel, booking com, airbnb, expedia, easyjet, swiss international, swiss int, edelweiss, lufthansa, ryanair, helvetic, kino, cinema, pathe, kitag, arena cinemas, ticketcorner, starticket, eventfrog, fitness, activ fitness, kieser, update fitness, holmes place, migros fitness, hallenbad, freibad, museum, zoo, zsc, fcz, gc, sauna, ski, bergbahn, bergbahnen, seilbahn, seekiosk'],
  ['Cash', 'bancomat, atm, geldautomat, bargeld, cash withdrawal, bargeldbezug, postomat, retrait'],
  ['Taxes & fees', 'steueramt, steuerverwaltung, steuer*, kantonales steueramt, gemeindesteuer, impots, imposte, estv, bussgeld, busse, gebuhr, kontofuhrung, kontofuehrung, spesen, kartengebuhr, jahresgebuhr'],
  [TRANSFERS, 'revolut, top up, topup, wise, paypal transfer, uberweisung an, ueberweisung an, kontoubertrag, kontouebertrag, account transfer, transfer to, eigenubertrag, sparkonto, saule 3a, 3a, viac, frankly, finpension, truewealth, selma, swissquote, neon invest, postfinance e trading, yuh, kontoverschiebung'],
];

/** Parse the editable rule text into a safe structure: [{category, keywords[]}]. */
export function buildRules(entries) {
  const rules = [];
  for (const [category, text] of entries.slice(0, LIMITS.maxRules)) {
    const name = cleanLabel(category);
    if (!name) continue;
    const keywords = [];
    for (const raw of String(text || '').split(',')) {
      const prefix = raw.trim().endsWith('*');
      const k = normalizeKey(raw).slice(0, LIMITS.maxKeywordLength);
      if (!k) continue;
      // Whole words by default; a trailing * matches word beginnings ("rest*" \u2192 restaurant).
      const needle = prefix ? ` ${k}` : ` ${k} `;
      if (!keywords.includes(needle)) keywords.push(needle);
      if (keywords.length >= LIMITS.maxKeywordsPerRule) break;
    }
    rules.push({ category: name, keywords });
  }
  return rules;
}

export function defaultRules() {
  return buildRules(DEFAULT_RULES);
}

/** Rules back to editable text. */
export function ruleText(rule) {
  return rule.keywords.map((n) => (n.endsWith(' ') ? n.trim() : n.trim() + '*')).join(', ');
}

/** First rule with a keyword that appears as a whole word (or word prefix) in the description. */
export function matchCategory(desc, rules) {
  const hay = ` ${normalizeKey(desc)} `;
  if (hay.length <= 2) return '';
  for (const r of rules) {
    for (const k of r.keywords) if (hay.includes(k)) return r.category;
  }
  return '';
}

/**
 * Category for one transaction. Inflows that match a spending rule are refunds
 * (they reduce that category); other inflows are income.
 */
export function categorize(tx, rules, { useFileCategory = true } = {}) {
  if (useFileCategory && tx.rawCategory) return tx.rawCategory;
  const hit = matchCategory(tx.desc, rules);
  if (tx.amount > 0) return hit && hit !== OTHER ? hit : INCOME;
  return hit || OTHER;
}

// Prefixes that banks put in front of the merchant name.
const PREFIXES = [
  /^(online )?(purchase|kauf|einkauf|achat|acquisto)( dienstleistung)?( vom \d{1,2}\.\d{1,2}\.\d{2,4})?\s*/i,
  /^(zkb|ubs|pf|raiffeisen|cs|bkb|lukb|bcv|bcge)?\s*(visa|mastercard|maestro|debit mastercard|debitkarte|debit card|v pay)( debit)?( card| karte| carte| carta)?( no\.?| nr\.?| n\u00B0| number)?\s*(x{2,}\s*\d{2,4}|\*{2,}\s*\d{2,4}|\d{2,4})?\s*,?\s*/i,
  /^(debit|credit|belastung|gutschrift|lastschrift|zahlung|payment|paiement|pagamento|bezug|auftrag)\s*(ebill|e bill|lsv|standing order|dauerauftrag|mobile banking|e banking|account transfer|originator|twint|qr rechnung|qr bill|esr)?\s*:?\s*/i,
  /^(ebill|lsv\+?|dauerauftrag|standing order|e-?banking[- ]auftrag|mobile banking|account transfer|originator|twint|einzahlung|sammelauftrag|kartenzahlung|card payment|card no\.?)\s*:?\s*/i,
  /^(sumup|sq|sp|wal|ls|pp|paypal|zettle|izettle|twint|payrexx|stripe|mol|crv)\s*\*+\s*/i,
  /^(sumup|wal|ls|sp)\s+/i,
];

/** Clean a bank description into a short payee name. */
export function payeeName(desc, brands) {
  let s = cleanText(desc, 300);
  if (!s) return '\u2014';
  const key = ` ${normalizeKey(s)} `;
  for (const [needle, name] of brands) if (key.includes(` ${needle} `)) return name;
  for (let i = 0; i < 3; i++) for (const re of PREFIXES) s = s.replace(re, '');
  s = s.split(/ \u00B7 |, (?=[A-Z\u00C4\u00D6\u00DCa-z\u00E4\u00F6\u00FC .\-]*\d{1,4}\b)|,\s*\d{4}\s/)[0];
  s = s
    .replace(/\b(xxxx|\*{4})\s*\d{2,4}\b/gi, '')
    .replace(/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g, '')
    .replace(/\b\d{1,2}:\d{2}\b/g, '')
    .replace(/[-#]?\b\d{3,}\b/g, '')
    .replace(/\b(CH|ZH|BE|BS|LU|SG|VD)\s*$/g, '')
    .replace(/\b(Z(ue|u|\u00FC)rich|Zuerich|Bern|Basel|Luzern|Gen[e\u00E8]ve|Lausanne|Winterthur|St\.? ?Gallen)\b\s*$/i, '')
    .replace(/[,;:*\s]+$/g, '')
    .replace(/^[,;:*\-\s]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!s) s = /card|karte|carte|carta/i.test(desc) ? 'Card purchase' : cleanText(desc, 40);
  if (s === s.toUpperCase() && /[A-Z]{3}/.test(s)) s = s.toLowerCase().replace(/(^|[\s\-/&.(])([a-z\u00E0-\u00FF])/g, (_, a, b) => a + b.toUpperCase());
  return s.length > 40 ? s.slice(0, 39).trimEnd() + '\u2026' : s;
}

// Chains and well-known payees that appear under many store names.
export const BRANDS = [
  ['migros', 'Migros'], ['coop pronto', 'Coop Pronto'], ['coop', 'Coop'], ['denner', 'Denner'], ['lidl', 'Lidl'], ['aldi', 'Aldi'], ['spar', 'Spar'],
  ['volg', 'Volg'], ['manor', 'Manor'], ['globus', 'Globus'], ['digitec', 'Digitec Galaxus'], ['galaxus', 'Digitec Galaxus'], ['ikea', 'IKEA'],
  ['sbb', 'SBB'], ['cff', 'SBB'], ['zvv', 'ZVV'], ['swisscom', 'Swisscom'], ['sunrise', 'Sunrise'], ['salt', 'Salt'], ['wingo', 'Wingo'],
  ['helsana', 'Helsana'], ['css', 'CSS'], ['swica', 'Swica'], ['sanitas', 'Sanitas'], ['visana', 'Visana'], ['starbucks', 'Starbucks'],
  ['mcdonald', "McDonald's"], ['amazon', 'Amazon'], ['netflix', 'Netflix'], ['spotify', 'Spotify'], ['apple com', 'Apple'], ['google', 'Google'],
  ['revolut', 'Revolut'], ['twint', 'TWINT'], ['swisscharge', 'Swisscharge'], ['migrol', 'Migrol'], ['shell', 'Shell'], ['socar', 'Socar'],
  ['ewz', 'ewz'], ['elektrizitatswerk der stadt zurich', 'ewz'], ['serafe', 'Serafe'], ['zalando', 'Zalando'], ['h m', 'H&M'], ['c a mode', 'C&A'],
  ['vicafe', 'Vicafe'], ['sprungli', 'Spr\u00FCngli'], ['brezelkonig', 'Brezelk\u00F6nig'], ['kkiosk', 'k kiosk'], ['k kiosk', 'k kiosk'], ['apotheke', 'Apotheke'],
];
