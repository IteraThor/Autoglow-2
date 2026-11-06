// AutoGlow 2 - Setup › Controllers › <controller>
// One page per controller: name and on/off in the header, then the wiring.
// Then the wiring, where each RGB strip gets its profile (which also sets its idle effect), and the light strips' idle brightness.
// Everything is a draft until the save bar's Save; leaving with unsaved changes asks first.

import { api } from '../core/api.js';
import { confirmDialog } from '../core/dialog.js';
import { h } from '../core/dom.js';
import { router } from '../core/router.js';
import { appStore } from '../core/store.js';
import { toast } from '../core/toast.js';
import { runControllerSetup } from './controller-setup.js';
import { createIdleEditor } from './idle-lighting.js';
import { applySetup, devices, layoutSummary, saveDevices } from './controllers.js';
import {
  COLOR_ORDERS, OUTPUT_TYPES, addOutput, addSegment, cleanName, draftFrom, duplicatePins, isPwmOutput, outputTypeLabel, pinOf,
  removeLastOutput, removeSegment, setOutputLength, setOutputType, setSegmentRange, toPayload
} from './led-layout.js';
import { confirmLeave } from './lighting-guard.js';

// Names of the unsaved parts in the save bar
const PART_LABELS = { general: 'name & status', leds: 'wiring', idle: 'light strip brightness' };

// The open page; null on the controller list
let page = null;

const snapshot = value => JSON.stringify(value);

function dirtyParts() {
  if (!page) return [];
  const parts = [];
  if (snapshot(page.general) !== page.savedGeneral) parts.push('general');
  if (page.layout && snapshot(page.layout) !== page.savedLayout) parts.push('leds');
  if (page.idle?.isDirty()) parts.push('idle');
  return parts;
}

export const isDetailDirty = () => dirtyParts().length > 0;

// --- Small builders ---------------------------------------------------------

function field(label, control, hint) {
  return h('label', { class: 'form-field' },
    h('span', { class: 'form-label' }, label),
    control,
    hint && h('span', { class: 'form-hint' }, hint));
}

function select(options, value, attrs) {
  const el = h('select', { class: 'ui-select', ...attrs }, options.map(o => h('option', { value: o.value }, o.label)));
  el.value = String(value);
  return el;
}

function numberInput(value, attrs) {
  return h('input', { type: 'number', class: 'ui-input ui-input-num', value, inputmode: 'numeric', ...attrs });
}

function section(id, title, lead, ...body) {
  return h('section', { class: 'card detail-section', id: `ctl-sec-${id}`, dataset: { section: id }, 'aria-labelledby': `ctl-sec-${id}-title` },
    h('div', { class: 'detail-section-head' },
      h('h2', { class: 'card-title', id: `ctl-sec-${id}-title` }, title, h('span', { class: 'dirty-dot', title: 'Unsaved changes' })),
      lead && h('p', { class: 'detail-lead' }, lead)),
    h('div', { class: 'detail-section-body' }, ...body));
}

function notice(text, action) {
  return h('div', { class: 'detail-notice' }, h('span', {}, text), action);
}

// --- Header: name (edited in place) and on/off ------------------------------

function buildHeaderControls() {
  const name = h('input', {
    type: 'text', class: 'detail-name', maxlength: 32, spellcheck: 'false', 'aria-label': 'Controller name',
    oninput: () => {
      const clean = cleanName(name.value);
      if (clean !== name.value) {
        name.value = clean;
        toast.warning('Controller names can use letters, digits, spaces, _ and - only.');
      }
      page.general.name = clean;
      sync();
    }
  });
  const enabled = h('input', {
    type: 'checkbox',
    onchange: () => {
      page.general.enabled = enabled.checked;
      sync();
    }
  });
  page.nameInput = name;
  page.enabledInput = enabled;
  page.enabledToggle = h('label', { class: 'detail-toggle', title: 'When off, AutoGlow leaves the controller alone: no game effects, no idle lighting.' },
    h('span', {}, 'Use this controller'),
    h('span', { class: 'switch' }, enabled, h('span', { class: 'switch-slider' })));
}

function renderGeneral() {
  page.nameInput.value = page.general.name;
  page.enabledInput.checked = page.general.enabled;
}

// --- LEDs & outputs ---------------------------------------------------------

function stripBar(layout) {
  const total = layout.outputs.reduce((sum, o) => sum + o.len, 0) || 1;
  return h('div', { class: 'led-map', role: 'img', 'aria-label': `${layout.segments.length} segments over ${total} LEDs` },
    layout.segments.map((seg, i) => {
      const pwm = isPwmOutput(layout.outputs[seg.busIdx]);
      const block = h('span', {
        class: 'led-map-seg',
        dataset: { kind: pwm ? 'pwm' : 'rgb', tone: String(i % 4) },
        title: `${seg.name}: ${pwm ? 'light strip' : `LEDs ${seg.start + 1}–${seg.stop}`}`
      }, h('span', { class: 'led-map-label' }, seg.name));
      // Width follows the segment's LED count
      if (!pwm) block.style.flexGrow = String(seg.stop - seg.start);
      return block;
    }));
}

// Segment names are edited in place and saved on their own (Enter or leaving the field): no LED rewrite
function segmentNameInput(seg) {
  const input = h('input', {
    type: 'text', class: 'led-summary-seg-name', value: seg.name, maxlength: 32, 'aria-label': `Name of ${seg.name}`,
    title: 'Click to rename', spellcheck: false,
    onkeydown: e => {
      if (e.key === 'Enter') e.target.blur();
      if (e.key === 'Escape') { e.target.value = seg.name; e.target.blur(); }
    },
    onchange: () => renameSegment(seg, input)
  });
  return input;
}

async function renameSegment(seg, input) {
  const name = cleanName(input.value).trim();
  if (!name) {
    toast.error('Give the segment a name (letters, numbers, spaces, - and _).');
    input.value = seg.name;
    return;
  }
  if (name === seg.name) {
    input.value = name;
    return;
  }
  input.disabled = true;
  try {
    await api.post('/api/wled/segment-name', { ip: page.ip, segment_id: seg.id, name });
    // Rename in the draft and the saved layout alike, so it is not an unsaved wiring change
    const old = seg.name;
    for (const layout of [page.layout, JSON.parse(page.savedLayout)]) {
      const target = layout.segments.find(s => s.id === seg.id);
      if (target) target.name = name;
      if (layout !== page.layout) page.savedLayout = snapshot(layout);
    }
    delete window.lastFetchedLiveDeviceData?.[page.ip];
    await window.loadConfig?.();
    toast.success(`Renamed ${old} to ${name}`);
  } catch (err) {
    input.value = seg.name;
    toast.error(err);
  } finally {
    input.disabled = false;
    if (page) renderLeds(page.bodies.leds);
  }
}

// What a segment plays during a game (Flow Matrix profile; light strips play none).
// RGB strips get a dropdown that switches the profile straight away (not part of the wiring draft).
function segmentProfile(seg, pwm) {
  const text = (label, muted) => h('span', { class: `led-summary-seg-profile${muted ? ' is-none' : ''}` }, label);
  if (pwm) return text('No game effects', true);
  if (appStore.get().lightingMode === 'matrix') return text('Event Matrix (legacy)', true);
  const profiles = page.segProfiles;
  if (!profiles) return text('…', true);
  const entry = profiles.segments[String(seg.id)];
  // A segment that is only in the draft has no saved profile yet
  if (!entry || !profiles.names.length) return text(entry?.profile ?? profiles.default ?? '—', !entry);
  const current = entry.profile ?? profiles.default;
  const el = select(profiles.names.map(name => ({ value: name, label: name })), current, {
    class: 'ui-select ui-select-sm led-summary-seg-profile-select',
    'aria-label': `Profile for ${seg.name}`, title: 'Flow Matrix profile this strip plays during a game',
    onchange: () => assignSegmentProfile(seg, entry, el)
  });
  return el;
}

async function assignSegmentProfile(seg, entry, el) {
  const name = el.value;
  const opened = page;
  el.disabled = true;
  try {
    const data = await api.post('/api/flow/assign', { ip: page.ip, segment_id: entry.id, name });
    entry.profile = name;
    if (data.idle_failed?.length) toast.warning(`${seg.name} plays '${name}', but its idle effect could not be set: the controller did not answer.`);
    else toast.success(`${seg.name} plays '${name}'`);
  } catch (err) {
    el.value = entry.profile ?? opened.segProfiles.default;
    toast.error(err);
  } finally {
    el.disabled = false;
  }
}

async function loadSegmentProfiles() {
  try {
    const data = await api.get('/api/flow/overview');
    const dev = data.lights.find(d => d.ip === page.ip);
    return {
      default: data.default,
      names: data.profiles.map(p => p.name),
      // Keyed like the layout's segment ids; id stays null for a controller without segments
      segments: Object.fromEntries((dev?.segments || []).map(seg => [String(seg.id ?? 0), { id: seg.id, profile: seg.profile }]))
    };
  } catch (err) {
    return { default: null, names: [], segments: {} };
  }
}

// Read-only view of the layout, drawn as wiring: the controller, a wire per GPIO pin, and each strip with its zones
// as blocks sized by their LED count. The guided setup is the normal way to change it; the editor is for experts.
const LED_CELLS_MAX = 60; // LED cells drawn per strip; longer strips are drawn scaled down

// h() makes HTML elements; the chip icon needs SVG ones
function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  el.append(...children);
  return el;
}

// "Bar · 2" -> "Bar": zones made by the guided setup are named "<strip name> · N"
function stripName(segs, busIdx) {
  if (segs.length === 1) return segs[0].name;
  const bases = new Set(segs.map(seg => seg.name.replace(/\s*·\s*\d+$/, '')));
  return bases.size === 1 ? [...bases][0] : `RGB strip ${busIdx + 1}`;
}

function ledCells(count, scale) {
  const n = Math.max(1, Math.round(count * scale));
  return Array.from({ length: n }, () => h('span', { class: 'wz-led' }));
}

function zoneBlock(seg, index, whole, scale) {
  const count = seg.stop - seg.start;
  const block = h('div', { class: 'wz-zone', dataset: { tone: whole ? 'whole' : String(index % 4) } },
    h('div', { class: 'wz-zone-head' },
      h('span', { class: 'wz-zone-tag', title: whole ? 'Whole strip' : `Zone ${index + 1}` }, whole ? 'All' : String(index + 1)),
      // A whole strip is renamed in the strip's header, so its name shows once
      whole ? h('span', { class: 'wz-zone-label' }, `LEDs ${seg.start + 1}–${seg.stop}`) : segmentNameInput(seg),
      segmentProfile(seg, false)),
    h('div', { class: 'wz-leds', role: 'img', 'aria-label': `LEDs ${seg.start + 1} to ${seg.stop}` }, ledCells(count, scale)),
    h('div', { class: 'wz-range' }, h('span', {}, String(seg.start + 1)), h('span', {}, `${count} LEDs`), h('span', {}, String(seg.stop))));
  // Width follows the zone's LED count
  block.style.flexGrow = String(count);
  return block;
}

function stripCard(hw, busIdx, segs) {
  const pwm = isPwmOutput(hw);
  const order = COLOR_ORDERS.find(o => o.value === hw.order)?.label;
  const wire = h('div', { class: 'wz-wire' }, h('span', { class: 'wz-pin' }, `GPIO ${pinOf(hw)}`));
  if (pwm) {
    const seg = segs[0];
    return h('li', { class: 'wz-row', dataset: { kind: 'pwm' } }, wire,
      h('div', { class: 'wz-strip' },
        h('div', { class: 'wz-strip-head' },
          seg ? segmentNameInput(seg) : h('strong', {}, `Output ${busIdx + 1}`),
          h('span', { class: 'wz-meta' }, `Output ${busIdx + 1} · ${outputTypeLabel(hw.type)} · brightness only`),
          h('span', { class: 'wz-badge' }, segmentProfile(seg || {}, true))),
        h('div', { class: 'wz-white' })));
  }
  const whole = segs.length <= 1;
  const scale = Math.min(1, LED_CELLS_MAX / Math.max(1, hw.len));
  return h('li', { class: 'wz-row', dataset: { kind: 'rgb' } }, wire,
    h('div', { class: 'wz-strip' },
      h('div', { class: 'wz-strip-head' },
        whole && segs[0] ? segmentNameInput(segs[0]) : h('strong', { class: 'wz-strip-name' }, stripName(segs, busIdx)),
        h('span', { class: 'wz-meta' }, [`Output ${busIdx + 1}`, outputTypeLabel(hw.type), `${hw.len} LEDs`, order].filter(Boolean).join(' · ')),
        h('span', { class: `wz-badge${whole ? '' : ' is-zones'}` }, whole ? 'Whole strip' : `${segs.length} zones`)),
      segs.length
        ? h('div', { class: 'wz-zones' }, segs.map((seg, i) => zoneBlock(seg, i, whole, scale)))
        : h('p', { class: 'wz-none' }, 'No segment')));
}

function renderLedSummary(body) {
  const { layout } = page;
  body.replaceChildren(
    h('div', { class: 'wz' },
      h('div', { class: 'wz-board' },
        svg('svg', { width: 28, height: 28, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'aria-hidden': 'true' },
          svg('rect', { x: 5, y: 5, width: 14, height: 14, rx: 2 }), svg('rect', { x: 9, y: 9, width: 6, height: 6 }),
          svg('path', { d: 'M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3' })),
        h('strong', {}, 'Controller'),
        page.live?.info?.arch && h('span', { class: 'wz-arch' }, page.live.info.arch.toUpperCase()),
        page.live?.version && h('span', {}, `WLED ${page.live.version}`)),
      h('ul', { class: 'wz-rows' }, layout.outputs.map((hw, busIdx) => stripCard(hw, busIdx, layout.segments.filter(seg => seg.busIdx === busIdx))))),
    h('div', { class: 'led-summary-actions' },
      h('button', {
        type: 'button', class: 'ui-btn ui-btn-sm ui-btn-primary', onclick: runGuidedSetup,
        title: 'Answer a few questions and let AutoGlow configure the LEDs'
      }, 'Run guided setup'),
      h('button', { type: 'button', class: 'ui-btn-link', onclick: openLedEditor }, 'Edit manually…')));
}

async function openLedEditor() {
  const ok = await confirmDialog({
    title: 'Edit the LED layout manually?',
    body: 'This is for people who know their wiring. A wrong GPIO pin, LED count or type can stop the LEDs from working until it is fixed. The guided setup is the safe way to change the layout.',
    confirmLabel: 'Edit manually'
  });
  if (!ok || !page) return;
  page.ledsAdvanced = true;
  renderLeds(page.bodies.leds);
}

function segName(seg) {
  const input = h('input', {
    type: 'text', class: 'ui-input', value: seg.name, maxlength: 32, 'aria-label': 'Segment name',
    oninput: () => {
      seg.name = cleanName(input.value);
      if (seg.name !== input.value) input.value = seg.name;
      sync();
    }
  });
  return input;
}

function renderLeds(body) {
  const { layout } = page;
  page.closeEditorBtn = null;
  if (!layout) {
    body.replaceChildren(offlineNotice('to edit its LEDs'));
    return;
  }
  if (!page.ledsAdvanced) {
    renderLedSummary(body);
    return;
  }
  const redraw = () => {
    renderLeds(body);
    sync();
  };
  const dupes = duplicatePins(layout);

  const outputCards = layout.outputs.map((hw, busIdx) => {
    const pwm = isPwmOutput(hw);
    const own = layout.segments.map((seg, segIdx) => ({ seg, segIdx })).filter(x => x.seg.busIdx === busIdx);
    const types = OUTPUT_TYPES.some(t => t.value === hw.type) ? OUTPUT_TYPES : [...OUTPUT_TYPES, { value: hw.type, label: outputTypeLabel(hw.type) }];
    const isLast = busIdx === layout.outputs.length - 1 && layout.outputs.length > 1;

    const pin = numberInput(pinOf(hw), {
      min: 0, max: 48, 'aria-label': `Output ${busIdx + 1} GPIO`,
      'aria-invalid': dupes.has(pinOf(hw)) ? 'true' : null,
      onchange: () => { hw.pin = Number(pin.value) || 0; redraw(); }
    });

    // A light strip is one channel with one segment: only its name can change, next to the output's fields
    const head = h('div', { class: 'output-head' },
      h('div', { class: 'output-title' },
        h('span', { class: 'seg-swatch', dataset: { kind: pwm ? 'pwm' : 'rgb' } }),
        h('strong', {}, `Output ${busIdx + 1}`)),
      field('Type', select(types, hw.type, { onchange: e => { setOutputType(layout, busIdx, e.target.value); redraw(); } })),
      field('GPIO', pin),
      !pwm && field('Order', select(COLOR_ORDERS, hw.order, { 'aria-label': 'Color order', onchange: e => { hw.order = Number(e.target.value); sync(); } })),
      !pwm && field('LEDs', numberInput(hw.len, { min: 1, max: 1500, onchange: e => { setOutputLength(layout, busIdx, e.target.value); redraw(); } })),
      pwm && own[0] && h('div', { class: 'output-pwm-name' }, field(`Segment #${own[0].seg.id} name`, segName(own[0].seg))),
      isLast && h('button', {
        type: 'button', class: 'ui-btn ui-btn-sm ui-btn-quiet output-remove',
        onclick: () => { removeLastOutput(layout); redraw(); }
      }, 'Remove output'));

    const rows = pwm ? [] : own.map(({ seg, segIdx }) => {
      const nameInput = segName(seg);
      const removable = own.length > 1;
      const first = numberInput(seg.start + 1, { min: 1, 'aria-label': 'First LED' });
      const last = numberInput(seg.stop, { min: 1, 'aria-label': 'Last LED' });
      const commitRange = () => { setSegmentRange(layout, segIdx, first.value, last.value); redraw(); };
      first.addEventListener('change', commitRange);
      last.addEventListener('change', commitRange);
      return h('tr', {},
        h('td', { class: 'seg-id' }, `#${seg.id}`),
        h('td', {}, nameInput),
        h('td', {}, first),
        h('td', {}, last),
        h('td', { class: 'seg-count' }, String(seg.stop - seg.start)),
        h('td', {}, numberInput(seg.of || 0, {
          min: 0, 'aria-label': 'Start offset',
          title: 'Effects begin this many LEDs into the segment and wrap around. 0 starts at the first LED.',
          onchange: e => { seg.of = Math.max(0, Number(e.target.value) || 0) % Math.max(1, seg.stop - seg.start); redraw(); }
        })),
        h('td', {}, removable && h('button', {
          type: 'button', class: 'ui-btn ui-btn-sm ui-btn-quiet', 'aria-label': `Remove ${seg.name}`, title: 'Remove segment',
          onclick: () => { removeSegment(layout, segIdx); redraw(); }
        }, '✕')));
    });

    return h('div', { class: 'output-card', dataset: { kind: pwm ? 'pwm' : 'rgb' } },
      head,
      dupes.has(pinOf(hw)) && h('p', { class: 'form-error' }, `GPIO ${pinOf(hw)} is used by another output. Each output needs its own pin.`),
      !pwm && h('table', { class: 'seg-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, ''), h('th', {}, 'Segment'), h('th', {}, 'First LED'), h('th', {}, 'Last LED'), h('th', {}, 'Count'), h('th', {}, 'Offset'),
          h('th', {}, ''))),
        h('tbody', {}, rows)),
      !pwm && h('button', { type: 'button', class: 'ui-btn ui-btn-sm', onclick: () => { addSegment(layout, busIdx); redraw(); } }, '+ Add segment'));
  });

  // Closing is only possible without unsaved layout changes (sync() keeps it up to date)
  page.closeEditorBtn = h('button', {
    type: 'button', class: 'ui-btn ui-btn-sm', title: 'Back to the summary. Save or discard changes first.',
    onclick: () => { page.ledsAdvanced = false; renderLeds(body); }
  }, 'Close editor');
  body.replaceChildren(
    h('div', { class: 'led-editor-note' },
      h('span', {}, 'Manual editing. Nothing changes on the controller until you save.'),
      page.closeEditorBtn),
    stripBar(layout),
    ...outputCards,
    h('div', { class: 'detail-row-actions' },
      h('button', { type: 'button', class: 'ui-btn ui-btn-sm', onclick: () => { addOutput(layout); redraw(); } }, '+ Add output'))
  );
}

// --- Page -------------------------------------------------------------------

function offlineNotice(what) {
  if (!page.general.enabled || page.dev.enabled === false) return notice(`Turn on “Use this controller” and save ${what}.`);
  if (page.online === null) return h('p', { class: 'detail-empty' }, 'Connecting to the controller…');
  return notice(`The controller is not reachable. Check that it is powered and on your network ${what}.`,
    h('button', { type: 'button', class: 'ui-btn ui-btn-sm', onclick: () => openDetail(page.ip, { force: true }) }, 'Try again'));
}

function renderHead() {
  const { dev, live, online } = page;
  const tone = dev.enabled === false ? 'off' : online === null ? 'pending' : online ? 'ok' : 'error';
  page.dot.dataset.tone = tone;
  page.pill.dataset.tone = tone;
  page.title.textContent = `Controller ${dev.name || dev.ip}`;
  page.pill.textContent = dev.enabled === false ? 'Disabled' : online === null ? 'Checking…' : online ? 'Online' : 'Offline';
  // replaceChildren would print false/null as text, so drop them
  page.meta.replaceChildren(...[
    h('a', { class: 'ctl-ip', href: `http://${dev.ip}`, target: '_blank', rel: 'noopener noreferrer', title: 'Open the WLED web interface' }, `${dev.ip} ↗`),
    online && h('span', {}, layoutSummary(live)),
    online && live.version && h('span', {}, `WLED ${live.version}`)].filter(Boolean));
  // save() only renames in WLED when the controller is reachable
  page.nameInput.title = page.layout && online ? 'Rename. Also changes the name shown in WLED.' : 'Rename.';
}

// Mark dirty parts, lock what depends on the saved LED layout, show or hide the save bar
// --- Light strips between games ----------------------------------------------
// RGB strips wait with their profile's idle effect. Light strips (PWM) play no profile, so their idle brightness
// is set here; it is saved in the controller's idle preset (WLED preset 1, also its boot look).

function renderIdle(body) {
  if (page.dev.enabled === false) {
    body.replaceChildren(notice('This controller is switched off in AutoGlow.'));
    return;
  }
  if (!page.layout) {
    // Offline: the Wiring card already says so, so this card waits out of sight
    page.sections.idle.hidden = page.online === false;
    body.replaceChildren(h('p', { class: 'detail-empty' }, page.online === false ? 'Needs the controller online.' : 'Loading…'));
    return;
  }
  // Built from the saved wiring, so a wiring draft never changes which segments the idle preset covers
  if (!page.idle) {
    const saved = JSON.parse(page.savedLayout);
    const segs = saved.segments.map(seg => ({ ...seg, pwm: isPwmOutput(saved.outputs[seg.busIdx]) }));
    page.idleSegments = segs.filter(seg => seg.pwm);
    page.sections.idle.hidden = !page.idleSegments.length;
    if (!page.idleSegments.length) return;
    // The editor saves the whole preset, so it holds the RGB strips too (as the controller has them)
    page.idle = createIdleEditor(page.ip, segs);
    page.idle.onChange = sync;
    page.idle.load().then(sync);
  }
  if (!page.idle) return;
  body.replaceChildren(...page.idleSegments.map(seg => h('div', { class: 'idle-light' },
    h('div', { class: 'idle-light-head' }, h('strong', {}, seg.name), page.idle.switchFor(seg.id)),
    page.idle.elementFor(seg.id))));
}

function sync() {
  if (!page) return;
  const parts = dirtyParts();
  const ledsDirty = parts.includes('leds');
  if (page.closeEditorBtn) page.closeEditorBtn.disabled = ledsDirty;
  page.sections.leds.toggleAttribute('data-dirty', ledsDirty);
  page.sections.idle.toggleAttribute('data-dirty', parts.includes('idle'));
  page.head.toggleAttribute('data-dirty', parts.includes('general'));
  page.saveBar.hidden = parts.length === 0;
  page.saveNote.textContent = `Unsaved changes: ${parts.map(p => PART_LABELS[p]).join(', ')}`;
  page.saveBtn.disabled = page.saving;
  page.discardBtn.disabled = page.saving;
}

async function save() {
  if (!page || page.saving) return false;
  const { ip, layout, general, online } = page;
  const parts = dirtyParts();
  if (!general.name.trim()) {
    toast.error('Give the controller a name.');
    page.nameInput.focus();
    return false;
  }
  if (layout && duplicatePins(layout).size) {
    toast.error('Two outputs use the same GPIO pin. Give each output its own pin.');
    // The summary does not show the pin error, so open the editor where it can be fixed
    if (!page.ledsAdvanced) {
      page.ledsAdvanced = true;
      renderLeds(page.bodies.leds);
    }
    page.sections.leds.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return false;
  }
  page.saving = true;
  sync();
  try {
    const nameChanged = general.name !== JSON.parse(page.savedGeneral).name;
    // LED edits the controller did not take stay as a draft, so they can be saved again
    let ledsPending = false;
    if (layout && online && (parts.includes('leds') || nameChanged)) {
      const result = await api.post('/api/wled/update', toPayload(ip, { ...layout, name: general.name }), { timeout: 15000 });
      if (!result.hardware_applied) {
        ledsPending = parts.includes('leds');
        if (!ledsPending) toast.warning('Saved in AutoGlow, but the controller did not take the new name.');
      }
      delete window.lastFetchedLiveDeviceData[ip];
      await window.loadConfig();
    }
    if (parts.includes('idle')) await page.idle.save();
    if (parts.includes('general')) {
      const next = devices().map(d => (d.ip === ip ? { ...d, name: general.name || d.name, enabled: general.enabled } : d));
      if (!await saveDevices(next, null)) return false;
    }
    if (ledsPending) {
      // Everything else is saved; reloading the page now would throw the LED draft away
      page.savedGeneral = snapshot(page.general);
      toast.warning('The controller did not respond, so the LED layout was not applied. Your LED changes are kept: save again when it is back online.');
      return false;
    }
    toast.success(`${general.name || ip} saved`);
    page.saving = false;
    await openDetail(ip, { force: true });
    return true;
  } catch (err) {
    toast.error(err, { onRetry: save });
    return false;
  } finally {
    if (page) {
      page.saving = false;
      sync();
    }
  }
}

function discard() {
  if (!page) return;
  page.general = JSON.parse(page.savedGeneral);
  if (page.layout) page.layout = JSON.parse(page.savedLayout);
  page.idle?.discard();
  renderGeneral();
  renderLeds(page.bodies.leds);
  renderIdle(page.bodies.idle);
  sync();
}

async function runGuidedSetup(event) {
  const button = event.currentTarget;
  if (isDetailDirty() && !await confirmDialog({
    title: 'Discard unsaved changes?',
    body: 'The guided setup starts from what is saved on the controller.',
    confirmLabel: 'Discard and continue',
    danger: true
  })) return;
  button.disabled = true;
  try {
    const live = await window.pingDeviceCached(page.ip, true);
    if (!live?.online) {
      toast.warning(`${page.dev.name || page.ip} is offline`);
      return;
    }
    window.lastFetchedLiveDeviceData[page.ip] = live;
    const setup = await runControllerSetup(page.ip, { ...live, name: page.dev.name || live.name });
    if (setup?.hw_ins) {
      await applySetup(page.ip, setup, `${setup.name} set up`);
      await openDetail(page.ip, { force: true });
    }
  } finally {
    button.disabled = false;
  }
}

async function removeThis() {
  const { dev } = page;
  const confirmed = await confirmDialog({
    title: `Remove ${dev.name || dev.ip}?`,
    body: 'Its profile choices stay saved and come back if you add it again. Nothing on the controller is changed.',
    confirmLabel: 'Remove',
    danger: true
  });
  if (!confirmed) return;
  page.general = JSON.parse(page.savedGeneral);
  if (await saveDevices(devices().filter(d => d.ip !== dev.ip), `${dev.name || dev.ip} removed`)) {
    page = null;
    router.navigate('/setup/controllers');
  }
}

function notFound(host, ip) {
  page = null;
  host.replaceChildren(
    h('a', { class: 'detail-back', href: '/setup/controllers', 'data-link': true }, '← Controllers'),
    h('div', { class: 'card' },
      h('h1', { class: 'card-title' }, 'Controller not found'),
      h('p', { class: 'detail-lead' }, `No controller with the address ${ip} is added.`)));
}

// Build the page for ip. Re-rendering the same controller only refreshes its header, so drafts survive.
export async function openDetail(ip, { force = false } = {}) {
  const host = document.getElementById('controllerDetail');
  if (!host) return;
  // The router lowercases paths; hostnames may be saved with capitals
  const dev = devices().find(d => d.ip.toLowerCase() === ip.toLowerCase());
  if (!dev) return notFound(host, ip);
  ip = dev.ip;
  if (page && page.ip === ip && !force) {
    page.dev = dev;
    renderHead();
    return;
  }

  const general = { name: dev.name || 'WLED Controller', enabled: dev.enabled !== false };
  page = {
    ip, dev, live: null, online: dev.enabled === false ? false : null,
    general, savedGeneral: snapshot(general),
    layout: null, savedLayout: null, idle: null,
    saving: false, sections: {}, bodies: {}
  };

  buildHeaderControls();
  page.dot = h('span', { class: 'status-dot' });
  page.pill = h('span', { class: 'status-pill' });
  page.meta = h('div', { class: 'detail-meta' });
  // The name is an input, so screen readers get the page heading from this
  page.title = h('h1', { class: 'visually-hidden' });
  page.head = h('header', { class: 'detail-head' },
    page.title,
    h('div', { class: 'detail-title' }, page.dot, page.nameInput, page.pill, h('span', { class: 'dirty-dot', title: 'Unsaved changes' })),
    h('div', { class: 'detail-actions' }, page.enabledToggle),
    page.meta);

  page.bodies.leds = h('div');
  page.sections.leds = section('leds', 'Wiring', 'What is connected to the controller. To change it, run the guided setup.', page.bodies.leds);
  page.bodies.idle = h('div', { class: 'idle-lights' });
  page.sections.idle = section('idle', 'Light strips between games', 'How bright the light strips are when no game is running. Changes show right away; Save keeps them on the controller. RGB strips show the idle effect of their profile.', page.bodies.idle);
  page.saveNote = h('span', { class: 'savebar-note' });
  page.discardBtn = h('button', { type: 'button', class: 'ui-btn ui-btn-sm', onclick: discard }, 'Discard');
  page.saveBtn = h('button', { type: 'button', class: 'ui-btn ui-btn-sm ui-btn-primary', onclick: save }, 'Save changes');
  page.saveBar = h('div', { class: 'savebar', role: 'region', 'aria-label': 'Unsaved changes', hidden: true },
    page.saveNote, page.discardBtn, page.saveBtn);

  host.replaceChildren(
    h('a', { class: 'detail-back', href: '/setup/controllers', 'data-link': true }, '← Controllers'),
    page.head,
    page.sections.leds,
    page.sections.idle,
    h('div', { class: 'detail-footer' },
      h('button', { type: 'button', class: 'ui-btn ui-btn-sm ui-btn-quiet', title: 'AutoGlow stops using it. The controller keeps its own settings.', onclick: removeThis }, 'Remove this controller…')),
    page.saveBar);

  renderHead();
  renderGeneral();
  renderLeds(page.bodies.leds);
  renderIdle(page.bodies.idle);
  sync();

  const opened = page;
  const [live, segProfiles] = await Promise.all([
    dev.enabled === false ? null : window.pingDeviceCached(ip, true).catch(() => null),
    loadSegmentProfiles()
  ]);
  if (page !== opened) return;
  page.segProfiles = segProfiles;
  if (dev.enabled !== false) {
    page.live = live;
    page.online = live?.status === 'ok' && live.online === true;
    if (page.online) {
      window.lastFetchedLiveDeviceData[ip] = live;
      page.layout = draftFrom(live, dev);
      page.savedLayout = snapshot(page.layout);
    }
  }
  renderHead();
  renderGeneral();
  renderLeds(page.bodies.leds);
  renderIdle(page.bodies.idle);
  sync();
}

export function closeDetail() {
  page = null;
  document.getElementById('controllerDetail')?.replaceChildren();
}

export function initControllerDetail() {
  router.addLeaveGuard(from => {
    if (from.pane !== 'tab-devices' || !from.param || !isDetailDirty()) return true;
    return confirmLeave({ what: 'controller settings', save, discard });
  });
  window.addEventListener('beforeunload', event => {
    if (isDetailDirty()) event.preventDefault();
  });
}
