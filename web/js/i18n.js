// AutoGlow 2 - page language (Settings › This browser › Language). The pages are written in English;
// in German this translates what the page shows as it appears: text, placeholders, tooltips and
// aria labels. The dictionaries (web/js/i18n/*.js) are keyed by the English text, like the Bridge
// extension's chrome_extension/i18n.js, so both use the same words.
//   'Save': 'Speichern'                      exact text
//   '{} saved': '{} gespeichert'             {} is any text; it is translated too when it is a key
//   '{} of {}': '{2} von {1}'                {1} {2} pick the parts by position
//   'Click {0} and select:': 'Klicke {0}…'   text with elements in it ({0} = the first element)
// Loaded in <head>, so nothing shows in English first. Marks: translate="no" keeps a part as it is.
(() => {
  if (window.agI18n) return;
  const KEY = 'autoglow.lang';

  function choice() {
    try { const v = localStorage.getItem(KEY); if (v === 'en' || v === 'de') return v; } catch { /* storage blocked */ }
    return '';
  }
  const browserLang = () => (/^de\b/i.test((navigator.languages && navigator.languages[0]) || navigator.language || '') ? 'de' : 'en');
  const lang = choice() || browserLang();
  document.documentElement.lang = lang;

  const DE = new Map();      // exact
  const PATTERNS = [];       // [regex, german, literal length]
  const MIXED = new Map();   // templates with {0} elements
  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const norm = s => s.replace(/\s+/g, ' ').trim();

  function add(dict) {
    for (const [en, de] of Object.entries(dict)) {
      const k = norm(en);
      if (/\{\d\}/.test(k)) MIXED.set(k, de);
      else if (k.includes('{}')) {
        const re = new RegExp('^' + k.split('{}').map(escRe).join('(.+?)') + '$');
        PATTERNS.push([re, de, k.replace(/\{\}/g, '').length]);
        PATTERNS.sort((a, b) => b[2] - a[2]);
      } else DE.set(k, de);
    }
    cache.clear();
  }

  const cache = new Map();
  // A filled-in part: translated when it is a key itself, also when the page wrote it in lower case
  function part(p) {
    const k = p.trim();
    if (!/[A-Za-z]/.test(k)) return p;
    const d = DE.get(k) ?? DE.get(k[0].toUpperCase() + k.slice(1)) ?? lookup(k);
    return d == null ? p : p.slice(0, p.indexOf(k)) + d + p.slice(p.indexOf(k) + k.length);
  }
  function lookup(text) {
    if (DE.has(text)) return DE.get(text);
    if (cache.has(text)) return cache.get(text);
    let out = null;
    for (const [re, de] of PATTERNS) {
      const m = re.exec(text);
      if (!m) continue;
      const parts = m.slice(1).map(part);
      let i = 0;
      out = de.replace(/\{(\d?)\}/g, (_, n) => (n ? parts[n - 1] : parts[i++]) ?? '');
      break;
    }
    if (cache.size > 5000) cache.clear();
    cache.set(text, out);
    return out;
  }

  /** Text in the page's language, for code that builds text itself. vars fill {name} slots. */
  function t(en, vars) {
    let s = en;
    if (lang === 'de') { const k = norm(en); s = DE.get(k) ?? lookup(k) ?? en; }
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k]))) : s;
  }

  const missing = new Set(); // localStorage autoglow.i18nDebug=1: what had no German, in window.agI18n.missing
  let debug = false;
  try { debug = localStorage.getItem('autoglow.i18nDebug') === '1'; } catch { /* storage blocked */ }

  window.agI18n = { lang, t, add, missing, set(l) { try { localStorage.setItem(KEY, l); } catch { /* private window */ } location.reload(); } };
  window.t = t;
  if (lang !== 'de') return;

  // ---------------------------------------------------------------------------
  // Translating the page as it appears
  // ---------------------------------------------------------------------------
  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'label'];
  const SKIP = 'script,style,textarea,code,kbd,pre,svg,[translate="no"],[contenteditable="true"]';
  const written = new WeakMap(); // text node -> the German we wrote, so our own change is left alone
  const mixedDone = new WeakMap(); // element -> the German template we put in
  const hasLetters = s => /[A-Za-z]/.test(s);

  function translateText(node) {
    const raw = node.data;
    if (written.get(node) === raw || !hasLetters(raw)) return;
    const k = norm(raw);
    const de = lookup(k);
    if (de == null) { if (debug && k.length > 1) missing.add(k); return; }
    const lead = raw.match(/^\s*/)[0], trail = raw.match(/\s*$/)[0];
    const v = lead + de + trail;
    written.set(node, v);
    if (v !== raw) node.data = v;
  }

  function template(el) {
    let text = false, tpl = '';
    const list = [];
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { tpl += n.data; if (n.data.trim()) text = true; } else if (n.nodeType === 1) { tpl += `{${list.length}}`; list.push(n); }
    }
    return text && list.length ? [norm(tpl), list] : [null, list];
  }

  function translateMixed(el) {
    if (el.childNodes.length < 2) return;
    const [k, list] = template(el);
    if (k == null || mixedDone.get(el) === k) return;
    const de = MIXED.get(k);
    if (de == null) { if (debug && hasLetters(k.replace(/\{\d\}/g, ''))) missing.add(k); return; }
    const frag = document.createDocumentFragment();
    for (const part of de.split(/(\{\d\})/)) {
      const m = /^\{(\d)\}$/.exec(part);
      if (m) { if (list[m[1]]) frag.appendChild(list[m[1]]); } else if (part) {
        const tn = document.createTextNode(part);
        written.set(tn, part);
        frag.appendChild(tn);
      }
    }
    el.replaceChildren(frag);
    mixedDone.set(el, template(el)[0]);
  }

  function translateAttrs(el) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (!v || !hasLetters(v) || written.get(el)?.[a] === v) continue;
      const de = lookup(norm(v));
      if (de == null) { if (debug) missing.add(norm(v)); continue; }
      const w = written.get(el) || {};
      w[a] = de;
      written.set(el, w);
      if (de !== v) el.setAttribute(a, de);
    }
  }

  const skipped = el => !!(el && el.closest(SKIP));

  function walk(root) {
    if (root.nodeType === 3) { if (!skipped(root.parentElement)) translateText(root); return; }
    if (root.nodeType !== 1 || skipped(root)) return;
    const elems = [root, ...root.querySelectorAll('*')];
    for (const el of elems) {
      if (el.matches(SKIP)) continue;
      if (el.attributes.length) translateAttrs(el);
    }
    for (const el of elems) if (!skipped(el)) translateMixed(el);
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) if (!skipped(n.parentElement)) translateText(n);
  }

  const obs = new MutationObserver(records => {
    for (const r of records) {
      if (r.type === 'characterData') { if (!skipped(r.target.parentElement)) translateText(r.target); } else if (r.type === 'attributes') {
        if (!skipped(r.target)) translateAttrs(r.target);
      } else {
        if (r.target.nodeType === 1 && !skipped(r.target)) translateMixed(r.target);
        for (const n of r.addedNodes) if (n.isConnected) walk(n);
      }
    }
  });
  obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
})();
