// SVG/DOM charts built with DOM APIs only.
import { h, s, setChildren } from './dom.js';
import { treemap } from './analyze.js';
import { money0, monthLabel, monthTick, pct } from './format.js';

/** Treemap of tiles as absolutely positioned buttons. items: [{name, value, cls, label, onClick}] */
export function drawTreemap(el, items, { currency, emptyText }) {
  const W = el.clientWidth || 800, H = el.clientHeight || 380;
  const total = items.reduce((a, d) => a + Math.max(0, d.value), 0);
  const tiles = treemap(items, W, H);
  if (!tiles.length) {
    setChildren(el, h('p', { class: 'empty', text: emptyText }));
    return;
  }
  setChildren(el, tiles.map(({ item, x, y, w, h: hh }) => {
    const share = total ? item.value / total : 0;
    const size = w < 38 || hh < 24 ? 'micro' : w < 84 || hh < 52 ? 'tiny' : '';
    const btn = h('button', {
      type: 'button',
      class: ['tile', ...[].concat(item.cls), size],
      attrs: { 'aria-label': `${item.name}: ${currency} ${money0(item.value)}, ${pct(share)} of spending.${item.hint ? ' ' + item.hint : ''}` },
      css: { left: `${(x / W) * 100}%`, top: `${(y / H) * 100}%`, width: `${(w / W) * 100}%`, height: `${(hh / H) * 100}%` },
      on: { click: item.onClick },
    },
    h('span', { class: 't-name', text: item.name }),
    h('span', { class: 't-amt', text: `${currency} ${money0(item.value)}` }),
    h('span', { class: 't-share', text: pct(share) }));
    btn.title = `${item.name} \u00B7 ${currency} ${money0(item.value)} \u00B7 ${pct(share)}`;
    return btn;
  }));
}

function niceStep(max, count = 4) {
  const raw = max / count;
  const pow = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
}

/**
 * Stacked monthly bars with dashed budget marks.
 * months: [{month, byCat: Map, total, budget}], series: [{name, cls}] (bottom to top), otherCls for the rest.
 */
export function drawMonthly(el, months, series, { currency, height, onSelect, selected } = {}) {
  const W = Math.max(320, el.clientWidth || 800);
  const H = height || (W < 560 ? 240 : 300);
  const m = { l: 54, r: 10, t: 20, b: 30 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const maxV = Math.max(1, ...months.map((d) => Math.max(d.total, d.budget)));
  const step = niceStep(maxV);
  const top = Math.ceil((maxV * 1.06) / step) * step;
  const y = (v) => m.t + ih - (v / top) * ih;
  const band = iw / Math.max(1, months.length);
  const bw = Math.max(4, Math.min(56, band * 0.62));
  const names = new Set(series.map((x) => x.name));
  const svg = s('svg', { attrs: { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-labelledby': 'monthly-desc' } },
    s('desc', { id: 'monthly-desc', text: `Monthly spending in ${currency}, stacked by category, with budget marks. The same data is in the table below.` }));
  for (let v = 0; v <= top + 1e-9; v += step) {
    svg.append(s('line', { class: v === 0 ? 'axis' : 'grid', attrs: { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) } }));
    svg.append(s('text', { class: 'tick', attrs: { x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, text: money0(v) }));
  }
  const labelEvery = Math.ceil(months.length / Math.max(1, Math.floor(iw / 46)));
  months.forEach((d, i) => {
    const cx = m.l + band * i + band / 2;
    const x = cx - bw / 2;
    let acc = 0;
    const stack = [...series.map((sr) => ({ ...sr, v: Math.max(0, d.byCat.get(sr.name) || 0) }))];
    let other = 0;
    for (const [name, v] of d.byCat) if (!names.has(name)) other += Math.max(0, v);
    if (other > 0) stack.push({ name: 'Other categories', cls: 'cx', v: other });
    for (const seg of stack) {
      if (seg.v <= 0) continue;
      const y0 = y(acc), y1 = y(acc + seg.v);
      acc += seg.v;
      svg.append(s('rect', { class: ['seg', seg.cls, d.full === false ? 'partial' : ''], attrs: { x, y: y1, width: bw, height: Math.max(0.5, y0 - y1) } },
        s('title', { text: `${monthLabel(d.month)}${d.full === false ? ' (incomplete)' : ''} \u00B7 ${seg.name}: ${currency} ${money0(seg.v)}` })));
    }
    if (d.budget > 0) {
      svg.append(s('line', { class: 'budget-mark', attrs: { x1: x - 5, x2: x + bw + 5, y1: y(d.budget), y2: y(d.budget) } },
        s('title', { text: `${monthLabel(d.month)} \u00B7 budget ${currency} ${money0(d.budget)}` })));
    }
    if (d.total > 0 && bw >= 30) svg.append(s('text', { class: 'total-label', attrs: { x: cx, y: Math.min(y(d.total), d.budget ? y(d.budget) : Infinity) - 6, 'text-anchor': 'middle' }, text: money0(d.total) }));
    if (onSelect) {
      const hit = s('rect', {
        class: ['hit', d.month === selected ? 'sel' : ''],
        attrs: { x: cx - band / 2 + 1, y: m.t, width: Math.max(2, band - 2), height: ih, tabindex: 0, role: 'button', 'aria-pressed': d.month === selected ? 'true' : 'false', 'aria-label': `${monthLabel(d.month)}: ${currency} ${money0(d.total)}. Show this month.` },
        on: { click: () => onSelect(d.month), keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(d.month); } } },
      }, s('title', { text: `${monthLabel(d.month)} \u00B7 ${currency} ${money0(d.total)}` }));
      svg.append(hit);
    }
    if (i % labelEvery === 0) {
      const lab = i === 0 || d.month.endsWith('-01') ? `${monthTick(d.month)} ${d.month.slice(2, 4)}` : monthTick(d.month);
      svg.append(s('text', { class: 'tick', attrs: { x: cx, y: H - 10, 'text-anchor': 'middle' }, text: lab }));
    }
  });
  setChildren(el, svg);
}

/**
 * Balance lines over months with a dashed minimum line.
 * series: [{ name, cls, values: [{ month, value }] }]
 */
export function drawBalance(el, series, { currency, buffer = 0 }) {
  const W = Math.max(320, el.clientWidth || 800);
  const H = W < 560 ? 220 : 280;
  const m = { l: 62, r: 14, t: 16, b: 30 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const all = series.flatMap((s0) => s0.values.map((v) => v.value)).concat([buffer, 0]);
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi === lo) hi = lo + 1;
  const step = niceStep(hi - lo);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const months = series[0]?.values.map((v) => v.month) || [];
  const x = (i) => m.l + (months.length > 1 ? (i / (months.length - 1)) * iw : iw / 2);
  const y = (v) => m.t + ih - ((v - lo) / (hi - lo)) * ih;
  const svg = s('svg', { attrs: { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-labelledby': 'balance-desc' } },
    s('desc', { id: 'balance-desc', text: `Forecast account balance per month in ${currency}. The same numbers are in the table below.` }));
  for (let v = lo; v <= hi + 1e-9; v += step) {
    svg.append(s('line', { class: v === 0 ? 'axis' : 'grid', attrs: { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) } }));
    svg.append(s('text', { class: 'tick', attrs: { x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, text: money0(v) }));
  }
  svg.append(s('line', { class: 'budget-mark', attrs: { x1: m.l, x2: W - m.r, y1: y(buffer), y2: y(buffer) } }, s('title', { text: `Minimum ${currency} ${money0(buffer)}` })));
  const every = Math.ceil(months.length / Math.max(1, Math.floor(iw / 52)));
  months.forEach((mo, i) => {
    if (i % every) return;
    svg.append(s('text', { class: 'tick', attrs: { x: x(i), y: H - 10, 'text-anchor': 'middle' }, text: i === 0 || mo.endsWith('-01') ? `${monthTick(mo)} ${mo.slice(2, 4)}` : monthTick(mo) }));
  });
  for (const sr of series) {
    const d = sr.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v.value).toFixed(1)}`).join(' ');
    svg.append(s('path', { class: ['bal-line', sr.cls], attrs: { d, fill: 'none' } }));
    sr.values.forEach((v, i) => svg.append(s('circle', { class: ['bal-dot', sr.cls, v.value < buffer ? 'low' : ''], attrs: { cx: x(i), cy: y(v.value), r: 3.5 } },
      s('title', { text: `${monthLabel(v.month)} \u00B7 ${sr.name}: ${currency} ${money0(v.value)}` }))));
  }
  setChildren(el, svg);
}
