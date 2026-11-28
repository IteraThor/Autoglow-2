// AutoGlow Local Tournament dashboard: how the page changes without jumping. patch() turns new HTML into
// the smallest change of the elements that are there, so a row that moves slides (data-flip), a new one
// comes in (data-in) and a number counts or flips (class "num"). Animations only move and fade
// (transform, opacity): a TV's browser can do those cheaply.

const EASE = 'cubic-bezier(.2, .8, .2, 1)';
// Calm animations (set on the Dashboard page): things fade in place, no sliding in or popping
const calm = () => document.documentElement.classList.contains('calm');

// --- New HTML into the elements that are there ----------------------------------------------------------
function sameKind(a, b) {
  return a.nodeType === b.nodeType && a.nodeName === b.nodeName;
}

function patchNode(old, fresh, entered) {
  if (old.nodeType !== 1) {
    if (old.nodeValue !== fresh.nodeValue) old.nodeValue = fresh.nodeValue;
    return;
  }
  for (const a of [...old.attributes]) if (!fresh.hasAttribute(a.name)) old.removeAttribute(a.name);
  for (const a of fresh.attributes) if (old.getAttribute(a.name) !== a.value) old.setAttribute(a.name, a.value);
  // A number keeps its digits: syncNums() changes them
  if (!old.classList.contains('num')) patchChildren(old, fresh, entered);
}

function patchChildren(old, fresh, entered) {
  const keyed = new Map();
  for (const c of old.children) if (c.dataset.k) keyed.set(c.dataset.k, c);
  let cur = old.firstChild;
  for (const n of [...fresh.childNodes]) {
    const key = n.nodeType === 1 ? n.dataset.k : '';
    let match = null;
    if (key) match = keyed.get(key);
    else if (cur && sameKind(cur, n) && !(cur.nodeType === 1 && cur.dataset.k)) match = cur;
    if (match && sameKind(match, n)) {
      if (match === cur) cur = cur.nextSibling;
      else old.insertBefore(match, cur);
      if (key) keyed.delete(key);
      patchNode(match, n, entered);
    } else {
      old.insertBefore(n, cur);
      entered.push(n);
    }
  }
  while (cur) {
    const next = cur.nextSibling;
    old.removeChild(cur);
    cur = next;
  }
}

// Returns true when something changed
export function patch(el, html) {
  if (el._html === html) return false;
  el._html = html;
  const before = new Map();
  el.querySelectorAll('[data-flip]').forEach(n => before.set(n.dataset.flip, n.getBoundingClientRect()));
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const entered = [];
  patchChildren(el, tpl.content, entered);
  el.querySelectorAll('[data-flip]').forEach(n => {
    const a = before.get(n.dataset.flip);
    if (!a) return;
    const b = n.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) n.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 650, easing: EASE });
  });
  let i = 0;
  for (const n of entered) {
    if (n.nodeType !== 1) continue;
    for (const e of [...(n.hasAttribute('data-in') ? [n] : []), ...n.querySelectorAll('[data-in]')]) {
      e.animate(calm() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(1.4rem)' }, { opacity: 1, transform: 'none' }], { duration: 480, delay: Math.min(i, 10) * 55, easing: EASE, fill: 'backwards' });
      i += 1;
    }
  }
  return true;
}

// Empty an element so its next patch() builds everything new
export function reset(el) {
  el.replaceChildren();
  el._html = undefined;
  el._slots = undefined;
}

// --- Numbers: counting ---------------------------------------------------------------------------------
function count(el, from, to) {
  cancelAnimationFrame(el._raf);
  const a = Number(from);
  const b = Number(to);
  if (from === undefined || from === '' || to === '' || Number.isNaN(a) || Number.isNaN(b)) {
    el.textContent = to;
    return;
  }
  const places = (String(to).split('.')[1] || '').length;
  const t0 = performance.now();
  const step = t => {
    const k = Math.min(1, (t - t0) / 600);
    el.textContent = (a + (b - a) * (1 - (1 - k) ** 3)).toFixed(places);
    if (k < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
  if (b > a && el.hasAttribute('data-pop') && !calm()) el.animate([{ transform: 'none' }, { transform: 'scale(1.35)' }, { transform: 'none' }], { duration: 520, easing: EASE });
}

export function syncNums(root) {
  for (const el of root.querySelectorAll('.num')) {
    const to = el.dataset.num;
    if (el._v === to) continue;
    const from = el._v;
    el._v = to;
    count(el, from, to);
  }
}

// --- The bracket: a winner moves from his match into the next one -----------------------------------------
export function flyWinners(body) {
  const now = new Map();
  body.querySelectorAll('[data-slot]').forEach(n => now.set(n.dataset.slot, n.dataset.p || ''));
  const was = body._slots;
  body._slots = now;
  if (!was) return;
  for (const [slot, p] of now) {
    if (!p || was.get(slot) !== '') continue;
    const dest = body.querySelector(`[data-slot="${slot}"]`);
    const src = [...body.querySelectorAll(`[data-p="${p}"]`)].find(n => n !== dest && n.dataset.slot.split(':')[0] === dest.dataset.from);
    if (!src) continue;
    const a = src.getBoundingClientRect();
    const b = dest.getBoundingClientRect();
    dest.animate([{ transform: `translate(${a.left - b.left}px, ${a.top - b.top}px)`, opacity: 0.4 }, { transform: 'none', opacity: 1 }], { duration: 1100, easing: EASE });
  }
}

// One scene leaves, the next comes: the old content fades out on top while the new one slides in
export function swap(body, fill) {
  const ghost = body.cloneNode(true);
  ghost.removeAttribute('id');
  ghost.classList.add('is-out');
  body.parentNode.appendChild(ghost);
  const still = calm();
  ghost.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: still ? 'none' : 'translateX(-3rem)' }], { duration: still ? 700 : 320, easing: 'ease-in', fill: 'forwards' }).onfinish = () => ghost.remove();
  reset(body);
  fill();
  body.animate([{ opacity: 0, transform: still ? 'none' : 'translateX(4rem)' }, { opacity: 1, transform: 'none' }], { duration: still ? 900 : 560, delay: still ? 300 : 160, easing: EASE, fill: 'backwards' });
}
