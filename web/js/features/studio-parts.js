// AutoGlow 2 - Studio: the building blocks of the Studio steps. Each builder returns an element bound to
// the live settings; edits go through change(), which saves them by itself.

import { confirmDialog } from '../core/dialog.js';
import { h } from '../core/dom.js';
import { toast } from '../core/toast.js';
import * as core from './studio-core.js';
import { change, focusText, icon, THEMES, themeSwatch, avatar, PROFILE, savePlayer, deletePlayer, imageUrl } from './studio-core.js';

const S = () => core.settings;

export const section = (label, ...content) => h('section', { class: 'stu-section' }, h('h3', { class: 'stu-h' }, label), ...content);

// --- Segmented control with a sliding pill ---------------------------------------------------------
export function segmented(options, value, onPick, label = '') {
  const pill = h('span', { class: 'stu-seg-pill' });
  const root = h('div', { class: 'stu-seg', role: 'radiogroup', 'aria-label': label }, pill);
  const buttons = options.map(o => h('button', { type: 'button', role: 'radio', 'data-value': o.value, title: o.title || '' },
    o.icon ? icon(o.icon, 16) : null, o.label ?? null));
  root.append(...buttons);
  const set = v => {
    buttons.forEach(b => { const on = b.dataset.value === String(v); b.classList.toggle('is-on', on); b.setAttribute('aria-checked', String(on)); });
    const b = buttons.find(x => x.classList.contains('is-on'));
    if (b) requestAnimationFrame(() => { pill.style.left = `${b.offsetLeft}px`; pill.style.width = `${b.offsetWidth}px`; });
  };
  buttons.forEach(b => b.addEventListener('click', () => { set(b.dataset.value); onPick(b.dataset.value); }));
  set(value);
  new ResizeObserver(() => set(root.querySelector('.is-on')?.dataset.value)).observe(root);
  return root;
}

// A switch with its label, for one on/off setting
export function switchRow(label, key, onToggle = null) {
  const sw = h('input', { type: 'checkbox', class: 'stu-switch', checked: S()[key] !== false });
  sw.addEventListener('change', () => { change({ [key]: sw.checked }); onToggle?.(sw.checked); });
  return h('label', { class: 'stu-switch-row' }, sw, label);
}

// --- Look: theme swatches and accent colours --------------------------------------------------------
const ACCENTS = ['#1fa34a', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899', '#ef4444', '#f97316', '#eab308'];

export function lookPicker() {
  const grid = h('div', { class: 'stu-looks' });
  const render = () => grid.replaceChildren(...THEMES.map(t => {
    const btn = h('button', { type: 'button', class: `stu-look${S().theme === t.id ? ' is-on' : ''}`, title: t.name },
      themeSwatch(t, S().accent), t.name);
    btn.addEventListener('click', () => { change({ theme: t.id }); render(); });
    return btn;
  }));
  const accents = h('div', { class: 'stu-accents' });
  const renderAccents = () => {
    const custom = h('input', { type: 'color', value: S().accent, 'aria-label': 'Own colour' });
    custom.addEventListener('input', () => { change({ accent: custom.value }); render(); });
    custom.addEventListener('change', renderAccents);
    accents.replaceChildren(...ACCENTS.map(c => {
      const b = h('button', { type: 'button', class: `stu-accent${S().accent.toLowerCase() === c ? ' is-on' : ''}`, style: `background:${c}`, 'aria-label': `Accent ${c}` });
      b.addEventListener('click', () => { change({ accent: c }); renderAccents(); render(); });
      return b;
    }), h('label', { class: `stu-accent stu-accent-custom${ACCENTS.includes(S().accent.toLowerCase()) ? '' : ' is-on'}`, title: 'Own colour' }, custom));
  };
  render();
  renderAccents();
  return h('div', { class: 'stu-look-picker' }, section('Look', grid), section('Accent colour', accents));
}

// --- Camera layout as little pictures; Auto = board while throwing, split at takeout -----------------
const LAYOUTS = {
  auto: { label: 'Auto', title: 'Board while throwing, split while the darts are pulled', boxes: [['10%', '20%', '35%', '60%'], ['55%', '20%', '35%', '60%']] },
  split: { label: 'Split', title: 'Board and player side by side', boxes: [['4%', '8%', '44%', '84%'], ['52%', '8%', '44%', '84%']] },
  board: { label: 'Board', title: 'Board full screen, player small', boxes: [['4%', '8%', '92%', '84%'], ['66%', '54%', '28%', '34%']] },
  player: { label: 'Player', title: 'Player full screen, board small', boxes: [['4%', '8%', '92%', '84%'], ['66%', '54%', '28%', '34%']] }
};

export function layoutPicker() {
  const root = h('div', { class: 'stu-layouts', role: 'radiogroup', 'aria-label': 'Cameras on screen' });
  const render = () => {
    const cur = S().auto_direct ? 'auto' : S().layout;
    root.replaceChildren(...Object.entries(LAYOUTS).map(([id, l]) => {
      const pic = h('span', { class: 'stu-layout-pic' }, l.boxes.map(([left, top, w, hh]) => h('span', { style: `left:${left};top:${top};width:${w};height:${hh}` })));
      const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(cur === id), class: `stu-layout${cur === id ? ' is-on' : ''}`, 'data-layout': id, title: l.title }, pic, l.label);
      b.addEventListener('click', () => {
        change(id === 'auto' ? { auto_direct: true } : { auto_direct: false, layout: id });
        render();
      });
      return b;
    }));
  };
  render();
  return root;
}

// --- Texts ----------------------------------------------------------------------------------------
// The event title and subtitle are settings of their own; the other texts are overrides (empty = default)
const EVENT_GROUP = { name: 'Event', toggle: null, items: [{ key: 'event_title', label: 'Event title', setting: 'title' }, { key: 'event_subtitle', label: 'Subtitle (e.g. Final, Round 3)', setting: 'subtitle' }] };

const textGroups = names => {
  const all = [EVENT_GROUP, ...(S().text_groups || [])];
  return names.map(n => all.find(g => g.name === n)).filter(Boolean);
};

// One folding group per overlay part: its switch on top, a field per text with an eye that hides it.
// onLeave: called when no text field has focus any more.
export function textsEditor(names, { onLeave = () => focusText(null) } = {}) {
  const root = h('div', { class: 'stu-texts' });
  const defaults = S().text_defaults || {};
  const hidden = () => new Set(S().hidden_texts || []);
  const groups = textGroups(names);
  const inputs = [];
  root.append(...groups.map((g, i) => {
    const t = g.toggle;
    const sw = t ? h('input', { type: 'checkbox', class: 'stu-switch', checked: S()[t.key] !== false, title: t.label, 'aria-label': `${g.name}: ${t.label}` }) : null;
    const node = h('details', { class: 'stu-tgroup', open: groups.length <= 2 || i === 0 },
      h('summary', {}, icon('play', 12), h('span', { class: 'stu-tgroup-name' }, g.name),
        g.items.length ? h('span', { class: 'stu-tgroup-n' }, String(g.items.length)) : null, sw));
    node.querySelector('summary .stu-icon').classList.add('stu-chev');
    if (g.where) node.title = `Shown: ${g.where}`;
    if (sw) {
      sw.addEventListener('click', e => e.stopPropagation());
      const sync = () => node.classList.toggle('is-off', t.show && !sw.checked);
      sw.addEventListener('change', () => { change({ [t.key]: sw.checked }); sync(); });
      sync();
    }
    if (g.items.length) {
      node.append(h('div', { class: 'stu-trows' }, g.items.map(item => {
        const value = item.setting ? S()[item.setting] : (S().texts?.[item.key] || '');
        const input = h('input', { type: 'text', maxlength: 80, value: value || '', placeholder: defaults[item.key] || item.label, 'aria-label': item.label, title: item.label });
        input.dataset.key = item.key;
        inputs.push(input);
        const isHidden = hidden().has(item.key);
        const eye = h('button', { type: 'button', class: 'stu-eye', title: 'Show or hide on the screens', 'aria-label': `Show ${item.label}`, 'aria-pressed': String(!isHidden) }, icon(isHidden ? 'eyeOff' : 'eye', 16));
        const row = h('div', { class: `stu-trow${isHidden ? ' is-hidden' : ''}` }, eye, input);
        input.addEventListener('focus', () => focusText(item.key, item.label));
        input.addEventListener('blur', () => setTimeout(() => { if (!document.activeElement?.closest?.('.stu-trow')) onLeave(); }, 200));
        input.addEventListener('input', () => {
          if (item.setting) change({ [item.setting]: input.value.trim() });
          else {
            const texts = { ...(S().texts || {}) };
            if (input.value.trim()) texts[item.key] = input.value.trim(); else delete texts[item.key];
            change({ texts });
          }
        });
        eye.addEventListener('click', () => {
          const set = hidden();
          const nowHidden = !set.has(item.key);
          if (nowHidden) set.add(item.key); else set.delete(item.key);
          change({ hidden_texts: [...set] });
          row.classList.toggle('is-hidden', nowHidden);
          eye.replaceChildren(icon(nowHidden ? 'eyeOff' : 'eye', 16));
          eye.setAttribute('aria-pressed', String(!nowHidden));
        });
        return row;
      })));
    }
    return node;
  }));
  // Back to the default wording of these groups' texts (the event title and subtitle stay)
  const overrides = inputs.filter(i => !EVENT_GROUP.items.some(e => e.key === i.dataset.key));
  if (overrides.length) {
    const reset = h('button', { type: 'button', class: 'stu-link' }, icon('reset', 14), 'Default wording');
    reset.addEventListener('click', () => {
      const texts = { ...(S().texts || {}) };
      overrides.forEach(i => { delete texts[i.dataset.key]; i.value = ''; });
      change({ texts });
    });
    root.append(h('div', { class: 'stu-texts-foot' }, reset));
  }
  return root;
}

// --- Players: avatars, a card to edit, drop a picture on an avatar ---------------------------------
function dropPicture(el, onFile) {
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('is-drop'); });
  el.addEventListener('dragleave', () => el.classList.remove('is-drop'));
  el.addEventListener('drop', e => {
    e.preventDefault();
    el.classList.remove('is-drop');
    const f = e.dataTransfer.files?.[0];
    if (f && /^image\//.test(f.type)) onFile(f);
  });
}

// A picture to pick by click or drop; returns { el, file() }
function picturePicker(cls, current, empty, label, title) {
  let file = null;
  const shown = h('span', { class: `stu-pic ${cls}` }, current ? h('img', { src: imageUrl(current), alt: '' }) : empty);
  const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
  const show = f => {
    file = f;
    shown.replaceChildren(h('img', { src: URL.createObjectURL(f), alt: '' }));
    shown.animate([{ transform: 'scale(.85)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'cubic-bezier(.2,.9,.3,1.2)' });
  };
  input.addEventListener('change', () => input.files[0] && show(input.files[0]));
  const el = h('button', { type: 'button', class: 'stu-pic-pick', title }, shown, input, h('small', {}, label));
  el.addEventListener('click', () => input.click());
  dropPicture(el, show);
  return { el, file: () => file };
}

export function playersPanel() {
  const grid = h('div', { class: 'stu-players' });
  const editor = h('div', {});
  const root = h('div', { class: 'stu-players-panel' }, grid, editor);
  const fieldsOf = p => Object.fromEntries([['name', p.name], ...PROFILE.map(([k]) => [k, p[k] || ''])]);

  const renderGrid = () => {
    grid.replaceChildren(...S().players.map((p, i) => {
      const b = h('button', { type: 'button', class: 'stu-player', style: `animation-delay:${i * 30}ms`, title: 'Edit, or drop a picture here' },
        avatar(p), h('span', { class: 'stu-player-name' }, p.name), p.nickname ? h('span', { class: 'stu-player-nick' }, `“${p.nickname}”`) : null,
        p.country ? h('span', { class: 'stu-flag' }, p.country) : null);
      b.addEventListener('click', () => openEditor(p));
      dropPicture(b, async f => {
        try { await savePlayer(p.id, fieldsOf(p), { image: f }); renderGrid(); toast.success('Picture saved.'); } catch (err) { toast.error(err.message); }
      });
      return b;
    }), (() => {
      const add = h('button', { type: 'button', class: 'stu-player stu-player-add', title: 'Add player' }, h('span', { class: 'stu-avatar' }, icon('plus', 22)), h('span', { class: 'stu-player-name' }, 'Add'));
      add.addEventListener('click', () => openEditor(null));
      return add;
    })());
  };

  const openEditor = p => {
    const picture = picturePicker('stu-avatar', p?.image, icon('camera', 28), 'Picture', 'Click or drop a picture');
    // Shown by the "Mockup" player camera while this player is at the board
    const mockup = picturePicker('is-wide', p?.mockup, icon('video', 22), 'Mockup camera', 'Photo the mockup player camera shows while this player is at the board');
    const name = h('input', { class: 'stu-pcard-name', value: p?.name || '', placeholder: 'Player name', maxlength: 40, 'aria-label': 'Player name' });
    const inputs = PROFILE.map(([k, label, placeholder, max]) => k === 'hand'
      ? h('label', {}, label, h('select', { 'data-k': k }, [['', '–'], ['Right', 'Right-handed'], ['Left', 'Left-handed']].map(([v, t]) => h('option', { value: v, selected: (p?.hand || '') === v }, t))))
      : h('label', {}, label, h('input', { 'data-k': k, value: p?.[k] || '', placeholder, maxlength: max })));
    const save = h('button', { type: 'button', class: 'stu-btn is-primary' }, icon('check', 16), p ? 'Save' : 'Add');
    const close = h('button', { type: 'button', class: 'stu-btn' }, 'Close');
    const del = p ? h('button', { type: 'button', class: 'stu-btn stu-iconbtn stu-del', title: `Delete ${p.name}`, 'aria-label': `Delete ${p.name}` }, icon('trash', 16)) : null;
    save.addEventListener('click', async () => {
      if (!name.value.trim()) { name.focus(); name.animate([{ transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'none' }], { duration: 220 }); return; }
      const fields = { name: name.value };
      editor.querySelectorAll('[data-k]').forEach(i => { fields[i.dataset.k] = i.value; });
      save.disabled = true;
      try {
        await savePlayer(p?.id, fields, { image: picture.file(), mockup: mockup.file() });
        editor.replaceChildren();
        renderGrid();
        toast.success(p ? 'Player saved.' : 'Player added.');
      } catch (err) {
        toast.error(err.message);
      } finally {
        save.disabled = false;
      }
    });
    close.addEventListener('click', () => editor.replaceChildren());
    del?.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: `Delete ${p.name}?`, body: 'The player and their pictures are removed from the Studio.', confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try { await deletePlayer(p.id); editor.replaceChildren(); renderGrid(); } catch (err) { toast.error(err.message); }
    });
    editor.replaceChildren(h('div', { class: 'stu-pcard' },
      h('div', { class: 'stu-pcard-pics' }, picture.el, mockup.el),
      h('div', { class: 'stu-pcard-main' }, name, h('div', { class: 'stu-pfields' }, inputs), h('div', { class: 'stu-pcard-actions' }, save, close, del))));
    name.focus({ preventScroll: true });
    editor.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  renderGrid();
  return root;
}

// --- Readiness dots; a missing one pulses and opens its fix ----------------------------------------
let pop = null;
const closePop = () => { pop?.remove(); pop = null; };
document.addEventListener('click', e => { if (pop && !pop.contains(e.target) && !e.target.closest('[data-pop]')) closePop(); });
addEventListener('keydown', e => { if (e.key === 'Escape') closePop(); });
// It sits where its button was: scrolling the page closes it
addEventListener('scroll', e => { if (pop && !pop.contains(e.target)) closePop(); }, true);

// A small popover under an element (the readiness fixes, the TV address)
export function popover(anchor, ...content) {
  const wasOpen = pop?.anchor === anchor;
  closePop();
  if (wasOpen) return;
  const r = anchor.getBoundingClientRect();
  pop = h('div', { class: 'stu-pop', role: 'dialog' }, ...content);
  pop.anchor = anchor;
  pop.style.top = `${r.bottom + 6}px`;
  document.body.append(pop);
  // Keep it inside the window
  pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
}

// refresh() reads the status; onState gets the game state too (the Up next step lists its players)
export function statusDots(onState = null) {
  const root = h('div', { class: 'stu-dots', 'aria-live': 'polite' });
  root.refresh = async () => {
    try {
      const { state, checks } = await core.readStatus();
      onState?.(state);
      // Rebuilt only when something changed, so a dot keeps hover and focus
      const key = JSON.stringify(checks);
      if (root.dataset.key === key) return;
      root.dataset.key = key;
      root.replaceChildren(...checks.map(c => {
        const todo = !c.ok && !c.wait;
        const dot = h(todo ? 'button' : 'span', { class: 'stu-dot', 'data-state': c.ok ? 'done' : c.wait ? 'wait' : 'todo', title: c.detail, 'data-pop': '' },
          h('i'), h('span', {}, c.label));
        if (todo) dot.addEventListener('click', () => {
          const fix = c.action === 'start'
            ? h('button', { type: 'button', class: 'stu-btn is-primary', onclick: async () => { closePop(); await core.startAutodarts(); root.refresh(); } }, 'Start Autodarts')
            : c.id === 'tab' ? h('a', { class: 'stu-btn', href: 'https://play.autodarts.com/', target: '_blank', rel: 'noopener' }, icon('external', 14), 'Open') : null;
          popover(dot, h('span', {}, c.detail), fix);
        });
        return dot;
      }));
    } catch {
      // Shown again on the next refresh
    }
  };
  return root;
}
