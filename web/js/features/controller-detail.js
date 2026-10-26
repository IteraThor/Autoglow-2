// AutoGlow 2 - Setup › Controllers › <controller>
// One page per controller: general settings, LEDs & outputs, idle lighting and game profile.
// Everything is a draft until the save bar's Save; leaving with unsaved changes asks first.

import { api } from '../core/api.js';
import { confirmDialog } from '../core/dialog.js';
import { h } from '../core/dom.js';
import { router } from '../core/router.js';
import { toast } from '../core/toast.js';
import { runControllerSetup } from './controller-setup.js';
import { applySetup, devices, layoutSummary, saveDevices } from './controllers.js';
import { createIdleEditor } from './idle-lighting.js';
import {
  COLOR_ORDERS, OUTPUT_TYPES, addOutput, addSegment, cleanName, draftFrom, duplicatePins, isPwmOutput, pinOf,
  removeLastOutput, removeSegment, setOutputLength, setOutputType, setSegmentRange, toPayload
} from './led-layout.js';
import { confirmLeave } from './lighting-guard.js';

const SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'leds', label: 'LEDs & outputs' },
  { id: 'idle', label: 'Idle lighting' },
  { id: 'profile', label: 'Game profile' }
];

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
  return h('section', { class: 'card detail-section', id: `ctl-sec-${id}`, 'aria-labelledby': `ctl-sec-${id}-title` },
    h('div', { class: 'detail-section-head' },
      h('h2', { class: 'card-title', id: `ctl-sec-${id}-title` }, title),
      lead && h('p', { class: 'detail-lead' }, lead)),
    h('div', { class: 'detail-section-body' }, ...body));
}

function notice(text, action) {
  return h('div', { class: 'detail-notice' }, h('span', {}, text), action);
}

// --- General ----------------------------------------------------------------

function renderGeneral(body) {
  const { general, dev } = page;
  const name = h('input', {
    type: 'text', class: 'ui-input', value: general.name, maxlength: 32, spellcheck: 'false',
    oninput: () => {
      const clean = cleanName(name.value);
      if (clean !== name.value) {
        name.value = clean;
        toast.warning('Controller names can use letters, digits, spaces, _ and - only.');
      }
      general.name = clean;
      sync();
    }
  });
  const enabled = h('input', {
    type: 'checkbox', checked: general.enabled, 'aria-label': 'AutoGlow controls this controller',
    onchange: () => {
      general.enabled = enabled.checked;
      sync();
    }
  });
  body.replaceChildren(
    field('Name', name, page.online ? 'Also shown as the controller\'s name in WLED.' : null),
    h('div', { class: 'form-field form-toggle' },
      h('div', {},
        h('span', { class: 'form-label' }, 'Use this controller'),
        h('span', { class: 'form-hint' }, 'When off, AutoGlow leaves it alone: no game effects, no idle lighting.')),
      h('label', { class: 'switch' }, enabled, h('span', { class: 'switch-slider' }))),
    h('div', { class: 'form-field' },
      h('span', { class: 'form-label' }, 'Address'),
      h('span', { class: 'form-static' },
        h('a', { href: `http://${dev.ip}`, target: '_blank', rel: 'noopener noreferrer' }, `${dev.ip} ↗`),
        h('span', { class: 'form-hint' }, ' opens the WLED web interface')))
  );
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

function renderLeds(body) {
  const { layout } = page;
  if (!layout) {
    body.replaceChildren(offlineNotice('to edit its LEDs'));
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
    const types = OUTPUT_TYPES.some(t => t.value === hw.type) ? OUTPUT_TYPES : [...OUTPUT_TYPES, { value: hw.type, label: `Other (WLED type ${hw.type})` }];
    const isLast = busIdx === layout.outputs.length - 1 && layout.outputs.length > 1;

    const pin = numberInput(pinOf(hw), {
      min: 0, max: 48, 'aria-label': `Output ${busIdx + 1} GPIO`,
      'aria-invalid': dupes.has(pinOf(hw)) ? 'true' : null,
      onchange: () => { hw.pin = Number(pin.value) || 0; redraw(); }
    });

    const head = h('div', { class: 'output-head' },
      h('div', { class: 'output-title' },
        h('span', { class: 'seg-swatch', dataset: { kind: pwm ? 'pwm' : 'rgb' } }),
        h('strong', {}, `Output ${busIdx + 1}`)),
      h('div', { class: 'output-fields' },
        field('Type', select(types, hw.type, { onchange: e => { setOutputType(layout, busIdx, e.target.value); redraw(); } })),
        field('GPIO pin', pin),
        !pwm && field('Color order', select(COLOR_ORDERS, hw.order, { onchange: e => { hw.order = Number(e.target.value); sync(); } })),
        !pwm && field('LEDs', numberInput(hw.len, { min: 1, max: 1500, onchange: e => { setOutputLength(layout, busIdx, e.target.value); redraw(); } }))),
      isLast && h('button', {
        type: 'button', class: 'ui-btn ui-btn-sm ui-btn-quiet output-remove',
        onclick: () => { removeLastOutput(layout); redraw(); }
      }, 'Remove output'));

    const rows = own.map(({ seg, segIdx }) => {
      const nameInput = h('input', {
        type: 'text', class: 'ui-input', value: seg.name, maxlength: 32, 'aria-label': 'Segment name',
        oninput: () => {
          seg.name = cleanName(nameInput.value);
          if (seg.name !== nameInput.value) nameInput.value = seg.name;
          sync();
        }
      });
      // A light strip is one channel with one segment: only its name can change
      if (pwm) return field(`Segment #${seg.id}`, nameInput, 'Covers the whole light strip.');
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
      pwm ? rows : h('table', { class: 'seg-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, ''), h('th', {}, 'Segment'), h('th', {}, 'First LED'), h('th', {}, 'Last LED'), h('th', {}, 'Count'), h('th', {}, 'Offset'),
          h('th', {}, ''))),
        h('tbody', {}, rows)),
      !pwm && h('button', { type: 'button', class: 'ui-btn ui-btn-sm', onclick: () => { addSegment(layout, busIdx); redraw(); } }, '+ Add segment'));
  });

  body.replaceChildren(
    stripBar(layout),
    ...outputCards,
    h('div', { class: 'detail-row-actions' },
      h('button', { type: 'button', class: 'ui-btn ui-btn-sm', onclick: () => { addOutput(layout); redraw(); } }, '+ Add output'))
  );
}

// --- Idle lighting ----------------------------------------------------------

function renderIdle(body) {
  if (!page.layout) {
    body.replaceChildren(offlineNotice('to edit its idle lighting'));
    return;
  }
  if (!page.idle) {
    const saved = JSON.parse(page.savedLayout);
    page.idle = createIdleEditor(page.ip, saved.segments.map(seg => ({ ...seg, pwm: isPwmOutput(saved.outputs[seg.busIdx]) })));
    page.idle.onChange = sync;
    page.idle.load().then(sync);
  }
  body.replaceChildren(
    h('div', { class: 'detail-lock-note' }, 'Save or discard the LED changes first: idle lighting follows the saved segments.'),
    page.idle.element);
}

// --- Game profile -----------------------------------------------------------

async function loadProfiles() {
  try {
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

function renderProfile(body) {
  if (!page.profiles) {
    body.replaceChildren(h('p', { class: 'detail-empty' }, page.profilesFailed ? 'Profiles could not be loaded.' : 'Loading profiles…'));
    return;
  }
  const segs = (Array.isArray(page.dev.segments) ? page.dev.segments : []);
  const rows = Object.keys(page.profiles).map(key => {
    const seg = segs.find(s => String(s.id) === key);
    const current = page.profiles[key];
    const options = (page.profileNames.includes(current) ? page.profileNames : [current, ...page.profileNames]).map(n => ({ value: n, label: n }));
    const label = seg ? `#${seg.id} ${seg.name || 'Segment'}` : 'Whole controller';
    const range = seg ? `LEDs ${Number(seg.start) + 1}–${Number(seg.start) + (Number(seg.length ?? seg.len) || 0)}` : null;
    return h('div', { class: 'profile-row' },
      h('div', { class: 'profile-row-label' }, h('strong', {}, label), range && h('span', {}, range)),
      select(options, current, { 'aria-label': `Profile for ${label}`, onchange: e => { page.profiles[key] = e.target.value; sync(); } }));
  });
  body.replaceChildren(
    h('div', { class: 'detail-lock-note' }, 'Save or discard the LED changes first: profiles follow the saved segments.'),
    ...rows,
    segs.some(isPwmSegment) && h('p', { class: 'form-hint' }, 'Light strip segments are not listed: they play no game effects.'),
    h('a', { class: 'card-link', href: '/lighting/matrix', 'data-link': true }, 'Edit profiles on the Lighting page'));
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
  const status = dev.enabled === false ? 'Disabled' : online === null ? 'Checking…' : online ? 'Online' : 'Offline';
  const meta = [h('span', { class: 'ctl-ip' }, dev.ip)];
  if (online) {
    meta.push(h('span', {}, layoutSummary(live)));
    if (live.version) meta.push(h('span', {}, `WLED ${live.version}`));
  }
  page.head.replaceChildren(
    h('div', { class: 'detail-title' },
      h('span', { class: 'status-dot', dataset: { tone } }),
      h('h1', {}, dev.name || 'WLED Controller'),
      h('span', { class: 'status-pill', dataset: { tone } }, status)),
    h('div', { class: 'detail-meta' }, meta),
    h('div', { class: 'detail-actions' },
      h('button', {
        type: 'button', class: 'ui-btn', disabled: !online,
        title: online ? 'Answer a few questions and let AutoGlow configure the LEDs' : 'The controller must be online',
        onclick: runGuidedSetup
      }, 'Run guided setup')));
}

// Mark dirty sections, lock what depends on the saved LED layout, show or hide the save bar
function sync() {
  if (!page) return;
  const parts = dirtyParts();
  const ledsDirty = parts.includes('leds');
  page.nav.querySelectorAll('[data-section]').forEach(btn => {
    btn.toggleAttribute('data-dirty', parts.includes(btn.dataset.section));
  });
  for (const id of ['idle', 'profile']) {
    page.sections[id].classList.toggle('is-locked', ledsDirty);
    page.sections[id].querySelector('.detail-section-body').inert = ledsDirty;
  }
  page.saveBar.hidden = parts.length === 0;
  const labels = SECTIONS.filter(s => parts.includes(s.id)).map(s => s.label);
  page.saveNote.textContent = `Unsaved changes: ${labels.join(', ')}`;
  page.saveBtn.disabled = page.saving;
  page.discardBtn.disabled = page.saving;
}

async function save() {
  if (!page || page.saving) return false;
  const { ip, layout, general, online } = page;
  const parts = dirtyParts();
  if (layout && duplicatePins(layout).size) {
    toast.error('Two outputs use the same GPIO pin. Give each output its own pin.');
    page.sections.leds.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return false;
  }
  page.saving = true;
  sync();
  try {
    const nameChanged = general.name !== JSON.parse(page.savedGeneral).name;
    if (layout && online && (parts.includes('leds') || nameChanged)) {
      const result = await api.post('/api/wled/update', toPayload(ip, { ...layout, name: general.name }), { timeout: 15000 });
      if (!result.hardware_applied) toast.warning('Saved in AutoGlow, but the controller did not take the new LED layout.');
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
        await api.post('/api/matrix/presets/select', { name, ip, ...(key === 'all' ? {} : { segment_id: Number(key) }) });
      }
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
  renderGeneral(page.bodies.general);
  renderLeds(page.bodies.leds);
  renderProfile(page.bodies.profile);
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
    saving: false, sections: {}, bodies: {}
  };

  page.head = h('header', { class: 'detail-head' });
  page.nav = h('nav', { class: 'detail-nav', 'aria-label': 'Controller sections' },
    SECTIONS.map(s => h('button', {
      type: 'button', class: 'detail-nav-item', dataset: { section: s.id },
      onclick: () => page.sections[s.id].scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, s.label)));
  const leads = {
    general: null,
    leds: 'What is wired to the controller. Segments are the parts of a strip that can light up on their own.',
    idle: 'What the controller shows when no game is running. Changes show on the lights right away; Save stores them on the controller, where they also play at start-up.',
    profile: 'The set of effects each segment plays during a game.'
  };
  for (const s of SECTIONS) {
    page.bodies[s.id] = h('div');
    page.sections[s.id] = section(s.id, s.label, leads[s.id], page.bodies[s.id]);
  }
  page.saveNote = h('span', { class: 'savebar-note' });
  page.discardBtn = h('button', { type: 'button', class: 'ui-btn', onclick: discard }, 'Discard');
  page.saveBtn = h('button', { type: 'button', class: 'ui-btn ui-btn-primary', onclick: save }, 'Save changes');
  page.saveBar = h('div', { class: 'savebar', role: 'region', 'aria-label': 'Unsaved changes', hidden: true },
    page.saveNote, page.discardBtn, page.saveBtn);

  host.replaceChildren(
    h('a', { class: 'detail-back', href: '/setup/controllers', 'data-link': true }, '← Controllers'),
    page.head,
    h('div', { class: 'detail-grid' },
      page.nav,
      h('div', { class: 'detail-sections' },
        ...SECTIONS.map(s => page.sections[s.id]),
        h('section', { class: 'card detail-danger' },
          h('div', {},
            h('h2', { class: 'card-title' }, 'Remove controller'),
            h('p', { class: 'detail-lead' }, 'AutoGlow stops using it. The controller keeps its own settings.')),
          h('button', { type: 'button', class: 'ui-btn ui-btn-danger', onclick: removeThis }, 'Remove')))),
    page.saveBar);

  renderHead();
  renderGeneral(page.bodies.general);
  renderLeds(page.bodies.leds);
  renderIdle(page.bodies.idle);
  renderProfile(page.bodies.profile);
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
  renderGeneral(page.bodies.general);
  renderLeds(page.bodies.leds);
  renderIdle(page.bodies.idle);
  renderProfile(page.bodies.profile);
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
