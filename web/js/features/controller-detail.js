// AutoGlow 2 - Setup › Controllers › <controller>
// One page per controller: name and on/off in the header, then one card per light (its idle look and game profile)
// and the wiring at the bottom.
// Everything is a draft until the save bar's Save; leaving with unsaved changes asks first.

import { api } from '../core/api.js';
import { confirmDialog } from '../core/dialog.js';
import { h } from '../core/dom.js';
import { router } from '../core/router.js';
import { appStore } from '../core/store.js';
import { toast } from '../core/toast.js';
import { runControllerSetup } from './controller-setup.js';
import { applySetup, devices, layoutSummary, saveDevices } from './controllers.js';
import { createIdleEditor } from './idle-lighting.js';
import {
  COLOR_ORDERS, OUTPUT_TYPES, addOutput, addSegment, cleanName, draftFrom, duplicatePins, isPwmOutput, outputTypeLabel, pinOf,
  removeLastOutput, removeSegment, setOutputLength, setOutputType, setSegmentRange, toPayload
} from './led-layout.js';
import { confirmLeave } from './lighting-guard.js';

// Names of the unsaved parts in the save bar
const PART_LABELS = { general: 'name & status', leds: 'wiring', idle: 'idle lighting', profile: 'game profile' };

// PWM / white segments are driven by brightness and play no matrix effects, so they get no profile
const isPwmSegment = seg => /pwm|white/i.test(`${seg.type || ''} ${seg.name || ''}`);

// The open page; null on the controller list
let page = null;

const snapshot = value => JSON.stringify(value);

function dirtyParts() {
  if (!page) return [];
  const parts = [];
  if (snapshot(page.general) !== page.savedGeneral) parts.push('general');
  if (page.layout && snapshot(page.layout) !== page.savedLayout) parts.push('leds');
  if (page.idle?.isDirty()) parts.push('idle');
  if (page.profiles && snapshot(page.profiles) !== page.savedProfiles) parts.push('profile');
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

// Read-only view of the layout. The guided setup is the normal way to change it; the editor is for experts.
function renderLedSummary(body) {
  const { layout } = page;
  const order = hw => COLOR_ORDERS.find(o => o.value === hw.order)?.label;
  body.replaceChildren(
    h('ul', { class: 'led-summary' }, layout.outputs.map((hw, busIdx) => {
      const pwm = isPwmOutput(hw);
      const segs = layout.segments.filter(s => s.busIdx === busIdx);
      return h('li', { class: 'led-summary-output' },
        h('span', { class: 'seg-swatch', dataset: { kind: pwm ? 'pwm' : 'rgb' } }),
        h('strong', {}, `Output ${busIdx + 1}`),
        h('span', {}, [outputTypeLabel(hw.type), `GPIO ${pinOf(hw)}`, !pwm && `${hw.len} LEDs`, !pwm && order(hw)].filter(Boolean).join(' · ')),
        h('span', { class: 'led-summary-segs' }, `→ ${segs.map(seg => seg.name).join(', ') || 'no segment'}`));
    })),
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

// --- Lights: one card per segment with its idle look and game profile -------

// The game profiles of the lighting engine that plays (Flow Matrix profiles, or legacy Event Matrix presets)
const flowMode = () => appStore.get().lightingMode === 'flow';

async function loadFlowProfiles() {
  const data = await api.get('/api/flow/overview');
  const names = data.profiles.map(p => p.name);
  const dev = data.lights.find(d => d.ip === page.ip);
  const segs = (Array.isArray(page.dev.segments) ? page.dev.segments : []).filter(seg => !isPwmSegment(seg));
  const fromServer = Object.fromEntries((dev?.segments || []).map(seg => [String(seg.id), seg.profile]));
  const profiles = segs.length
    ? Object.fromEntries(segs.map(seg => [String(seg.id), fromServer[String(seg.id)] || data.default]))
    : { all: fromServer.null || data.default };
  return { names, profiles };
}

async function loadProfiles() {
  try {
    if (flowMode()) return await loadFlowProfiles();
    const data = await api.get('/api/matrix/presets');
    const names = data.presets?.length ? [...data.presets] : ['Default'];
    const fallback = data.device_profiles?.[page.ip] || data.active_profile || 'Default';
    const segs = (Array.isArray(page.dev.segments) ? page.dev.segments : []).filter(seg => !isPwmSegment(seg));
    const assigned = data.segment_profiles?.[page.ip] || {};
    const profiles = segs.length
      ? Object.fromEntries(segs.map(seg => [String(seg.id), assigned[String(seg.id)] || fallback]))
      : { all: fallback };
    return { names, profiles };
  } catch (err) {
    toast.error(err);
    return null;
  }
}

// The saved LED layout when the controller is reachable, else the segments in AutoGlow's config
function lightList() {
  if (page.savedLayout) {
    const saved = JSON.parse(page.savedLayout);
    return saved.segments.map(seg => ({ id: seg.id, name: seg.name, pwm: isPwmOutput(saved.outputs[seg.busIdx]) }));
  }
  return (Array.isArray(page.dev.segments) ? page.dev.segments : []).map(seg => ({ id: seg.id, name: seg.name || 'Segment', pwm: isPwmSegment(seg) }));
}

function profileControl(key, name) {
  if (!page.profiles) return h('p', { class: 'detail-empty' }, page.profilesFailed ? 'Profiles could not be loaded.' : 'Loading…');
  const current = page.profiles[key];
  if (current === undefined) return h('p', { class: 'detail-empty' }, 'Save the wiring first to pick a profile.');
  const options = (page.profileNames.includes(current) ? page.profileNames : [current, ...page.profileNames]).map(n => ({ value: n, label: n }));
  return select(options, current, { 'aria-label': `Game profile for ${name}`, onchange: e => { page.profiles[key] = e.target.value; sync(); } });
}

function lightRow(label, content) {
  return h('div', { class: 'light-row' }, h('span', { class: 'light-row-label' }, label), h('div', { class: 'light-row-body' }, content));
}

function lightCard(light) {
  const key = String(light.id);
  const titleId = `ctl-light-${key}`;
  const idle = page.idle?.elementFor(light.id)
    || h('p', { class: 'detail-empty' }, page.online === null ? 'Connecting…' : 'Needs the controller online.');
  const game = light.pwm ? h('p', { class: 'detail-empty' }, 'Light strips play no game effects.') : profileControl(key, light.name);
  return h('section', { class: 'card light-card', 'aria-labelledby': titleId },
    h('header', { class: 'light-head' },
      h('span', { class: 'seg-swatch', dataset: { kind: light.pwm ? 'pwm' : 'rgb' } }),
      h('h2', { class: 'light-name', id: titleId }, light.name, h('span', { class: 'dirty-dot', title: 'Unsaved changes' })),
      page.idle?.switchFor(light.id)),
    lightRow('During a game', game),
    lightRow('Idle', idle));
}

function renderLights() {
  if (page.layout && !page.idle) {
    const saved = JSON.parse(page.savedLayout);
    page.idle = createIdleEditor(page.ip, saved.segments.map(seg => ({ ...seg, pwm: isPwmOutput(saved.outputs[seg.busIdx]) })));
    page.idle.onChange = sync;
    page.idle.load().then(sync);
  }
  const lights = lightList();
  page.lightCards = Object.fromEntries(lights.map(light => [String(light.id), lightCard(light)]));
  // No segments yet: one profile for the whole controller
  if (page.profiles?.all !== undefined) {
    page.lightCards.all = lightCard({ id: 'all', name: 'Whole controller', pwm: false });
    page.lightCards.all.querySelector('.light-row:last-child').remove();
  }
  const offline = !page.layout && page.online !== null && offlineNotice('to change the idle lighting');
  page.lightsBody.replaceChildren(...[
    offline,
    ...Object.values(page.lightCards),
    !lights.length && page.layout && notice('No lights are set up on this controller yet. Run the guided setup under Wiring.'),
    flowMode()
      ? h('a', { class: 'card-link', href: '/lighting/flow', 'data-link': true }, 'Edit flow profiles in the Flow Matrix')
      : h('a', { class: 'card-link', href: '/lighting/matrix', 'data-link': true }, 'Edit game profiles on the Lighting page')
  ].filter(Boolean));
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
function sync() {
  if (!page) return;
  const parts = dirtyParts();
  const ledsDirty = parts.includes('leds');
  if (page.closeEditorBtn) page.closeEditorBtn.disabled = ledsDirty;
  page.sections.leds.toggleAttribute('data-dirty', ledsDirty);
  page.head.toggleAttribute('data-dirty', parts.includes('general'));
  const savedProfiles = page.savedProfiles ? JSON.parse(page.savedProfiles) : {};
  for (const [key, card] of Object.entries(page.lightCards)) {
    card.toggleAttribute('data-dirty', Boolean(page.idle?.isDirty(key) || (page.profiles && page.profiles[key] !== savedProfiles[key])));
  }
  page.lights.classList.toggle('is-locked', ledsDirty);
  page.lightsBody.inert = ledsDirty;
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
    if (parts.includes('general')) {
      const next = devices().map(d => (d.ip === ip ? { ...d, name: general.name || d.name, enabled: general.enabled } : d));
      if (!await saveDevices(next, null)) return false;
    }
    if (parts.includes('idle')) await page.idle.save();
    if (parts.includes('profile')) {
      const saved = JSON.parse(page.savedProfiles);
      for (const [key, name] of Object.entries(page.profiles)) {
        if (saved[key] === name) continue;
        const target = { name, ip, ...(key === 'all' ? {} : { segment_id: Number(key) }) };
        await api.post(flowMode() ? '/api/flow/assign' : '/api/matrix/presets/select', target);
      }
    }
    if (ledsPending) {
      // Everything else is saved; reloading the page now would throw the LED draft away
      page.savedGeneral = snapshot(page.general);
      if (page.profiles) page.savedProfiles = snapshot(page.profiles);
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
  if (page.profiles) page.profiles = JSON.parse(page.savedProfiles);
  page.idle?.discard();
  renderGeneral();
  renderLeds(page.bodies.leds);
  renderLights();
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
    profiles: null, savedProfiles: null, profileNames: [],
    saving: false, sections: {}, bodies: {}, lightCards: {}
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

  page.lightsBody = h('div', { class: 'detail-lights-body' });
  page.lights = h('div', { class: 'detail-lights' },
    h('div', { class: 'detail-group-head' },
      h('h2', { class: 'detail-group-title' }, 'Lights'),
      h('p', { class: 'detail-lead' }, 'Idle changes show on the lights right away.')),
    h('div', { class: 'detail-lock-note' }, 'Save or discard the wiring changes first: the lights follow the saved wiring.'),
    page.lightsBody);
  page.bodies.leds = h('div');
  page.sections.leds = section('leds', 'Wiring', 'What is connected to the controller. To change it, run the guided setup.', page.bodies.leds);
  page.saveNote = h('span', { class: 'savebar-note' });
  page.discardBtn = h('button', { type: 'button', class: 'ui-btn ui-btn-sm', onclick: discard }, 'Discard');
  page.saveBtn = h('button', { type: 'button', class: 'ui-btn ui-btn-sm ui-btn-primary', onclick: save }, 'Save changes');
  page.saveBar = h('div', { class: 'savebar', role: 'region', 'aria-label': 'Unsaved changes', hidden: true },
    page.saveNote, page.discardBtn, page.saveBtn);

  host.replaceChildren(
    h('a', { class: 'detail-back', href: '/setup/controllers', 'data-link': true }, '← Controllers'),
    page.head,
    page.lights,
    page.sections.leds,
    h('div', { class: 'detail-footer' },
      h('button', { type: 'button', class: 'ui-btn ui-btn-sm ui-btn-quiet', title: 'AutoGlow stops using it. The controller keeps its own settings.', onclick: removeThis }, 'Remove this controller…')),
    page.saveBar);

  renderHead();
  renderGeneral();
  renderLeds(page.bodies.leds);
  renderLights();
  sync();

  const opened = page;
  const [live, profiles] = await Promise.all([
    dev.enabled === false ? null : window.pingDeviceCached(ip, true).catch(() => null),
    loadProfiles()
  ]);
  if (page !== opened) return;
  if (profiles) {
    page.profileNames = profiles.names;
    page.profiles = profiles.profiles;
    page.savedProfiles = snapshot(profiles.profiles);
  } else {
    page.profilesFailed = true;
  }
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
  renderLights();
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
