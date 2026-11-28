// AutoGlow 2 - Event presets on the Studio, Dashboard and Overlay pages: one saved setup per event (names,
// logo, looks, texts, TV screens, the boards' overlay) for all three together. The active preset is the live settings: edits go
// into it by themselves, and switching keeps them there before putting another one live
// (src/event_presets.rs, /api/presets). Cameras and players stay with the PC.

import { api } from '../core/api.js';
import { h } from '../core/dom.js';
import { toast } from '../core/toast.js';
import { icon, THEMES } from './studio-core.js';
import { closePopover, popover } from './studio-parts.js';

const logoUrl = name => `/api/dashboard/logo/${encodeURIComponent(name)}`;
const initials = name => name.split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';

// The preset as a little TV in its TVs' look (the shared one, or the Dashboard's own), with its logo or initials
export function presetTv(p, cls = '') {
  const d = p.dashboard || {};
  const st = p.studio || {};
  const own = st.look_sync === false;
  const t = THEMES.find(x => x.id === (own ? d.theme : st.theme)) || THEMES[0];
  const [bg, accent, row] = [t.bg, (own ? d.accent : st.accent) || st.accent || '#1fa34a', t.row === 'transparent' ? t.text : t.row];
  return h('span', { class: `evp-tv ${cls}`, style: `--bg:${bg};--a:${accent};--row:${row}`, 'aria-hidden': 'true' },
    d.logo ? h('img', { src: logoUrl(d.logo), alt: '' }) : h('b', {}, initials(p.name)),
    h('i'), h('i'));
}

let data = null;   // { active, presets } as the server last sent it

export function presetBar({ beforeSwitch = async () => {}, afterSwitch = async () => {}, suggestName = () => '' } = {}) {
  let tv = h('span');
  const name = h('span', { class: 'evp-name' });
  const btn = h('button', { type: 'button', class: 'stu-btn evp-btn', 'data-pop': '', title: 'Event presets: Studio, Dashboard and Overlay together' },
    tv, name, icon('chevron', 14));
  const active = () => data?.presets.find(p => p.id === data.active);

  const show = () => {
    const p = active();
    if (!p) return;
    tv.replaceWith(tv = presetTv(p, 'is-small'));
    name.textContent = p.name;
  };

  const load = async () => {
    try {
      data = await api('/api/presets');
      show();
    } catch (err) {
      name.textContent = 'Presets';
    }
  };

  // One preset card: a click switches to it; pencil and bin on hover
  let list = null;
  let editing = null;   // id being renamed, 'new' while naming a new one, 'del:<id>' while confirming
  const run = async (fn, okText) => {
    try {
      data = await fn();
      show();
      if (okText) toast.success(okText);
    } catch (err) {
      toast.error(err.message);
    }
    editing = null;
    render();
  };

  const nameField = (value, onDone) => {
    const input = h('input', { type: 'text', class: 'stu-input evp-input', maxlength: 40, value, placeholder: 'e.g. Friday League', 'aria-label': 'Preset name' });
    let done = false;
    const finish = save => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (save && v) onDone(v); else { editing = null; render(); }
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    requestAnimationFrame(() => { input.focus(); input.select(); });
    return input;
  };

  const card = p => {
    const on = p.id === data.active;
    if (editing === p.id) {
      return h('div', { class: `evp-card is-editing${on ? ' is-on' : ''}` }, presetTv(p),
        nameField(p.name, v => run(() => api(`/api/presets/${p.id}`, { body: { name: v } }), null)));
    }
    if (editing === `del:${p.id}`) {
      const yes = h('button', { type: 'button', class: 'stu-btn stu-iconbtn evp-yes', title: 'Delete', 'aria-label': `Delete ${p.name}` }, icon('check', 16));
      const no = h('button', { type: 'button', class: 'stu-btn stu-iconbtn', title: 'Keep', 'aria-label': 'Keep it' }, icon('x', 16));
      yes.addEventListener('click', () => switching(() => api(`/api/presets/${p.id}`, { method: 'DELETE' }), on, `${p.name} deleted.`));
      no.addEventListener('click', () => { editing = null; render(); });
      return h('div', { class: 'evp-card is-confirm' }, presetTv(p), h('span', { class: 'evp-card-name' }, icon('trash', 14), p.name), h('span', { class: 'evp-card-tools is-shown' }, no, yes));
    }
    const pick = h('button', { type: 'button', class: 'evp-pick', 'aria-pressed': String(on), title: on ? 'On now' : `Switch to ${p.name}` },
      presetTv(p), h('span', { class: 'evp-card-name' }, on ? icon('check', 14) : null, p.name));
    pick.addEventListener('click', () => { if (!on) switching(() => api(`/api/presets/${p.id}/activate`, { method: 'POST' }), true, `${p.name} is on.`); });
    const ren = h('button', { type: 'button', class: 'stu-btn stu-iconbtn', title: 'Rename', 'aria-label': `Rename ${p.name}` }, icon('edit', 14));
    ren.addEventListener('click', () => { editing = p.id; render(); });
    const del = h('button', { type: 'button', class: 'stu-btn stu-iconbtn', title: 'Delete', 'aria-label': `Delete ${p.name}`, disabled: data.presets.length < 2 }, icon('trash', 14));
    del.addEventListener('click', () => { editing = `del:${p.id}`; render(); });
    return h('div', { class: `evp-card${on ? ' is-on' : ''}` }, pick, h('span', { class: 'evp-card-tools' }, ren, del));
  };

  // A switch (or deleting the active one) changes the live settings: the page saves first, reloads after
  const switching = async (fn, live, okText) => {
    list?.classList.add('is-busy');
    try {
      if (live) await beforeSwitch();
      data = await fn();
      show();
      if (live) await afterSwitch();
      toast.success(okText);
    } catch (err) {
      toast.error(err.message);
    }
    editing = null;
    if (live) closePopover(); else render();
  };

  const newCard = () => {
    if (editing === 'new') {
      const taken = new Set(data.presets.map(p => p.name.toLowerCase()));
      const s = suggestName();
      return h('div', { class: 'evp-card is-editing is-new' }, h('span', { class: 'evp-tv evp-tv-new' }, icon('plus', 22)),
        nameField(s && !taken.has(s.toLowerCase()) ? s : '', v => run(() => api('/api/presets', { body: { name: v } }), `${v} saved. Changes now go into it.`)));
    }
    const b = h('button', { type: 'button', class: 'evp-pick evp-add', title: 'A copy of what is on now, under a new name' },
      h('span', { class: 'evp-tv evp-tv-new' }, icon('plus', 22)), h('span', { class: 'evp-card-name' }, 'New'));
    b.addEventListener('click', () => { editing = 'new'; render(); });
    return h('div', { class: 'evp-card' }, b);
  };

  const render = () => {
    if (!list || !list.isConnected) return;
    list.classList.remove('is-busy');
    list.replaceChildren(...data.presets.map(card), newCard());
  };

  btn.addEventListener('click', async () => {
    await load();
    if (!data) return;
    editing = null;
    list = h('div', { class: 'evp-list' });
    popover(btn, h('div', { class: 'evp' }, h('span', { class: 'stu-h' }, 'Event presets'), list));
    render();
  });

  btn.refresh = load;
  load();
  return btn;
}
