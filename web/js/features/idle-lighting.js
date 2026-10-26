// AutoGlow 2 - Idle lighting of one controller: what it shows when no game is running.
// Saved on the controller as WLED preset 1, which is also its boot preset. Every change previews live.

import { api } from '../core/api.js';
import { h } from '../core/dom.js';
import { appStore } from '../core/store.js';

const SOLID = { id: 0, name: 'Solid', colorSlots: [{ slot: 0, label: 'Color' }], speed: false, intensity: false };
const SLOT_FIELDS = ['primary', 'secondary', 'tertiary'];
const PWM_STEPS = [0, 25, 50, 100];

let effectsCache = null;

async function loadEffects(ip) {
  if (effectsCache) return effectsCache;
  try {
    const data = await api.get(`/api/wled/effects?ip=${encodeURIComponent(ip)}`, { timeout: 8000 });
    if (Array.isArray(data.effects) && data.effects.length) effectsCache = data.effects;
  } catch (err) {
    // The picker still offers Solid
  }
  return effectsCache || [SOLID];
}

const toHex = rgb => (Array.isArray(rgb) && rgb.length >= 3
  ? `#${rgb.slice(0, 3).map(v => Math.max(0, Math.min(255, Number(v) || 0)).toString(16).padStart(2, '0')).join('')}`
  : null);
const toRgb = hex => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 0];
};
const percent = bri => Math.round((Math.max(0, Math.min(255, Number(bri))) / 255) * 100);

// Searchable effect picker: a button that opens a filtered list
function effectPicker(effects, current, onPick) {
  const label = h('span', { class: 'fx-picker-value' }, effects.find(e => e.id === current)?.name || `Effect ${current}`);
  const trigger = h('button', { type: 'button', class: 'fx-picker-trigger', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' }, label);
  const search = h('input', { type: 'search', class: 'ui-input fx-picker-search', placeholder: `Search ${effects.length} effects`, 'aria-label': 'Search effects' });
  const list = h('ul', { class: 'fx-picker-list', role: 'listbox', 'aria-label': 'Effects' });
  const pop = h('div', { class: 'fx-picker-pop', hidden: true }, search, list);
  const root = h('div', { class: 'fx-picker' }, trigger, pop);
  let selected = current;

  const close = () => {
    pop.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside);
  };
  const outside = event => { if (!root.contains(event.target)) close(); };
  const pick = effect => {
    selected = effect.id;
    label.textContent = effect.name;
    close();
    trigger.focus();
    onPick(effect);
  };
  const fill = () => {
    const q = search.value.trim().toLowerCase();
    const shown = q ? effects.filter(e => e.name.toLowerCase().includes(q)) : effects;
    list.replaceChildren(...(shown.length
      ? shown.map(e => h('li', {
        role: 'option',
        class: 'fx-picker-option',
        tabindex: '-1',
        'aria-selected': String(e.id === selected),
        onclick: () => pick(e),
        onkeydown: event => { if (event.key === 'Enter') pick(e); }
      }, e.name))
      : [h('li', { class: 'fx-picker-empty' }, 'No matching effect')]));
  };

  trigger.addEventListener('click', () => {
    if (!pop.hidden) return close();
    search.value = '';
    fill();
    pop.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside);
    search.focus();
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  });
  search.addEventListener('input', fill);
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !pop.hidden) {
      event.stopPropagation();
      close();
      trigger.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const options = [...list.querySelectorAll('.fx-picker-option')];
      if (!options.length) return;
      event.preventDefault();
      const at = options.indexOf(document.activeElement);
      const next = event.key === 'ArrowDown' ? Math.min(options.length - 1, at + 1) : Math.max(0, at - 1);
      options[at === -1 ? 0 : next].focus();
    }
  });
  return root;
}

function slider({ label, min, max, value, unit = '', onInput }) {
  const out = h('output', { class: 'idle-slider-value' }, `${value}${unit}`);
  const input = h('input', {
    type: 'range', class: 'ui-range', min, max, value, 'aria-label': label,
    oninput: () => {
      out.textContent = `${input.value}${unit}`;
      onInput(Number(input.value));
    }
  });
  return { row: h('label', { class: 'idle-slider' }, h('span', { class: 'idle-slider-label' }, label), input, out), input, out };
}

// segments: the controller's segments [{ id, name, start, stop, pwm }]
export function createIdleEditor(ip, segments) {
  const element = h('div', { class: 'idle-editor' });
  let effects = [SOLID];
  let state = [];
  let saved = '[]';
  let onChange = () => {};

  const effectMeta = id => effects.find(e => e.id === id) || (id === 0 ? SOLID : { id, name: `Effect ${id}`, colorSlots: [], speed: true, intensity: true });

  // Live preview: one request at a time, the latest state wins
  let sending = false;
  let pending = false;
  let timer = null;
  async function preview() {
    if (sending) {
      pending = true;
      return;
    }
    sending = true;
    try {
      // A running UDP stream would override the preview
      if (appStore.get().protocolMode === 'udp') await window.toggleProtocolMode?.();
      await api.post('/api/wled/preview', { ip, on: true, bri: 255, transition: 0, seg: payload() });
    } catch (err) {
      // Preview is best effort; Save reports errors
    } finally {
      sending = false;
      if (pending) {
        pending = false;
        preview();
      }
    }
  }
  const changed = (immediate = false) => {
    onChange();
    clearTimeout(timer);
    if (immediate) preview();
    else timer = setTimeout(preview, 60);
  };

  function payload() {
    return state.map(seg => ({
      id: seg.id,
      start: seg.start,
      stop: seg.stop,
      on: seg.on,
      bri: Math.round((seg.bri / 100) * 255),
      col: SLOT_FIELDS.map(f => toRgb(seg[f])),
      fx: seg.pwm ? 0 : seg.fx,
      sx: seg.speed,
      ix: seg.intensity,
      n: seg.name,
      sel: true
    }));
  }

  function card(seg) {
    const body = h('div', { class: 'idle-card-body' });
    const onSwitch = h('input', {
      type: 'checkbox', checked: seg.on, 'aria-label': `${seg.name} on`,
      onchange: () => {
        seg.on = onSwitch.checked;
        cardEl.classList.toggle('is-off', !seg.on);
        changed(true);
      }
    });
    const cardEl = h('div', { class: `idle-card${seg.on ? '' : ' is-off'}` },
      h('div', { class: 'idle-card-head' },
        h('span', { class: 'seg-swatch', dataset: { kind: seg.pwm ? 'pwm' : 'rgb' } }),
        h('strong', { class: 'idle-card-name' }, seg.name),
        h('span', { class: 'idle-card-range' }, seg.pwm ? 'Light strip' : `LEDs ${seg.start + 1}–${seg.stop}`),
        h('label', { class: 'switch idle-card-switch', title: 'On when idle' }, onSwitch, h('span', { class: 'switch-slider' }))
      ),
      body
    );

    if (seg.pwm) {
      const bri = slider({ label: 'Brightness', min: 0, max: 100, value: seg.bri, unit: '%', onInput: v => { seg.bri = v; changed(); } });
      const steps = h('div', { class: 'idle-steps' }, PWM_STEPS.map(step => h('button', {
        type: 'button', class: 'ui-btn ui-btn-sm',
        onclick: () => {
          seg.bri = step;
          bri.input.value = step;
          bri.out.textContent = `${step}%`;
          changed(true);
        }
      }, step ? `${step}%` : 'Off')));
      body.append(bri.row, steps);
      return cardEl;
    }

    const colors = h('div', { class: 'idle-colors' });
    const motion = h('div', { class: 'idle-motion' });
    const drawEffectControls = () => {
      const meta = effectMeta(seg.fx);
      const slots = meta.colorSlots || [];
      colors.replaceChildren(...(slots.length
        ? slots.map(slot => {
          const field = SLOT_FIELDS[slot.slot] || 'primary';
          return h('label', { class: 'idle-color' },
            h('input', {
              type: 'color', value: seg[field], 'aria-label': `${slot.label || 'Color'} color`,
              oninput: event => { seg[field] = event.target.value; changed(); },
              onchange: event => { seg[field] = event.target.value; changed(true); }
            }),
            h('span', {}, slot.label || 'Color'));
        })
        : [h('span', { class: 'idle-palette-note' }, 'Uses the effect\'s own colors')]));
      motion.replaceChildren(...[
        meta.speed && slider({ label: meta.speedLabel || 'Speed', min: 0, max: 255, value: seg.speed, onInput: v => { seg.speed = v; changed(); } }).row,
        meta.intensity && slider({ label: meta.intensityLabel || 'Intensity', min: 0, max: 255, value: seg.intensity, onInput: v => { seg.intensity = v; changed(); } }).row
      ].filter(Boolean));
    };
    drawEffectControls();

    body.append(
      h('div', { class: 'idle-effect-row' },
        h('span', { class: 'idle-slider-label' }, 'Effect'),
        effectPicker(effects, seg.fx, effect => {
          seg.fx = effect.id;
          drawEffectControls();
          changed(true);
        })),
      colors,
      slider({ label: 'Brightness', min: 0, max: 100, value: seg.bri, unit: '%', onInput: v => { seg.bri = v; changed(); } }).row,
      motion
    );
    return cardEl;
  }

  function render() {
    element.replaceChildren(...(state.length
      ? state.map(card)
      : [h('p', { class: 'detail-empty' }, 'This controller has no segments yet. Set up its LEDs first.')]));
  }

  return {
    element,
    set onChange(fn) { onChange = fn; },
    async load() {
      element.replaceChildren(h('p', { class: 'detail-empty' }, 'Loading idle lighting…'));
      effects = await loadEffects(ip);
      let preset = [];
      try {
        const data = await api.get(`/api/wled/preset?ip=${encodeURIComponent(ip)}&id=1`, { timeout: 8000 });
        if (Array.isArray(data?.seg)) preset = data.seg;
      } catch (err) {
        // No preset yet: start from defaults
      }
      state = segments.map((seg, i) => {
        const p = preset.find(s => Number(s.id) === Number(seg.id)) || preset[i] || {};
        return {
          id: seg.id,
          name: p.n || seg.name,
          start: seg.start,
          stop: seg.stop,
          pwm: seg.pwm,
          on: p.on !== false,
          bri: percent(p.bri ?? (seg.pwm ? 71 : 64)),
          fx: Number(p.fx) || 0,
          speed: p.sx ?? 128,
          intensity: p.ix ?? 128,
          primary: toHex(p.col?.[0]) || '#00ff9d',
          secondary: toHex(p.col?.[1]) || '#000000',
          tertiary: toHex(p.col?.[2]) || '#000000'
        };
      });
      saved = JSON.stringify(state);
      render();
    },
    isDirty: () => JSON.stringify(state) !== saved,
    async save() {
      if (!state.length) return true;
      await api.post('/api/wled/preset', { ip, preset_id: 1, name: 'AutoGlow Default', segments: payload(), bri: 255, boot_default: true }, { timeout: 10000 });
      saved = JSON.stringify(state);
      return true;
    },
    // Back to the saved look, on the page and on the lights
    discard() {
      if (JSON.stringify(state) === saved) return;
      state = JSON.parse(saved);
      render();
      preview();
    }
  };
}
