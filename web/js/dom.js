// Tiny DOM builder. Text is always inserted with createTextNode / textContent,
// never parsed as HTML. Styles go through the CSSOM (allowed by CSP), never style attributes.
const SVG_NS = 'http://www.w3.org/2000/svg';
const BLOCKED_ATTR = /^(on|style$|srcdoc$|formaction$)/i;

function apply(el, props) {
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    switch (k) {
      case 'class': el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v); break;
      case 'text': el.textContent = String(v); break;
      case 'on': for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn); break;
      case 'css': for (const [p, val] of Object.entries(v)) el.style.setProperty(p, String(val)); break;
      case 'attrs':
        for (const [a, val] of Object.entries(v)) {
          if (val == null || val === false) continue;
          if (BLOCKED_ATTR.test(a)) throw new Error(`refusing attribute ${a}`);
          el.setAttribute(a, val === true ? '' : String(val));
        }
        break;
      case 'value': el.value = String(v); break;
      case 'checked': el.checked = !!v; break;
      case 'disabled': el.disabled = !!v; break;
      case 'selected': el.selected = !!v; break;
      case 'hidden': el.hidden = !!v; break;
      case 'id': el.id = String(v); break;
      case 'type': el.setAttribute('type', String(v)); break;
      case 'htmlFor': el.htmlFor = String(v); break;
      default: throw new Error(`unknown prop ${k}`);
    }
  }
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  apply(el, props);
  append(el, children);
  return el;
}

export function s(tag, props, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  apply(el, props);
  append(el, children);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function setChildren(el, ...children) {
  el.replaceChildren();
  append(el, children);
}

export function option(value, label, selected) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  o.selected = !!selected;
  return o;
}
