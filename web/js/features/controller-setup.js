// AutoGlow 2 - Setup › Controllers › guided setup
// Asks in plain words what is wired to a WLED controller and turns the answers into WLED's
// outputs and segments. Light tests write a temporary layout to the controller; Cancel puts
// the controller's own layout back.

import { api } from '../core/api.js';
import { h, showFieldError, clearFieldError } from '../core/dom.js';
import { toast } from '../core/toast.js';
import { isPwmOutput as isPwmBus } from './led-layout.js';

const PWM_WHITE = 41;
const COLOR_ORDERS = ['GRB', 'RGB', 'BRG', 'RBG', 'BGR', 'GBR'];
// Only WS281x for now; more strip types can be added here later
const STRIP_TYPES = [
  { value: 22, label: 'WS281x' }
];
// Same order as the zone preview, so the strip and the screen show the same colors
const ZONE_COLORS = ['#22d3ee', '#f59e0b', '#a855f7', '#22c55e', '#ef4444', '#3b82f6', '#ec4899', '#eab308', '#14b8a6', '#f97316', '#8b5cf6', '#84cc16'];
const MAX_ZONES = 12;
// Outputs per controller the guide offers; WLED on an ESP32 drives up to 10
const MAX_STRIPS = 4;
const MAX_LIGHTS = 4;
// WLED's Aurora effect (38) with its own Aurora palette (50): the RGB strip's look once it is set up
const AURORA = { fx: 38, pal: 50, sx: 128, ix: 128 };
const SVG_NS = 'http://www.w3.org/2000/svg';

const firstPin = bus => (Array.isArray(bus?.pin) ? bus.pin[0] : bus?.pin);
const rgb = color => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));

// Split count LEDs into zones equal parts; earlier zones take the remainder. Ranges are WLED style (stop excluded).
export function zoneRanges(count, zones) {
  const n = Math.max(1, Math.min(zones, count));
  const base = Math.floor(count / n);
  const extra = count % n;
  const ranges = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    const len = base + (i < extra ? 1 : 0);
    ranges.push({ start, stop: start + len });
    start += len;
  }
  return ranges;
}

// "LEDs 1–12": how people count, from 1 with both ends included
export function humanRange({ start, stop }) {
  return stop - start === 1 ? `LED ${start + 1}` : `LEDs ${start + 1}–${stop}`;
}

// The strip's real color order from what the user saw while WLED sent pure red, then pure green.
// Returns the new WLED order code (keeping its upper flag bits), or null if the answers contradict.
export function deriveColorOrder(code, seenForRed, seenForGreen) {
  if (!seenForRed || !seenForGreen || seenForRed === seenForGreen) return null;
  const sent = COLOR_ORDERS[code & 0x0f] || 'GRB';
  const strip = [];
  strip[sent.indexOf('R')] = seenForRed;
  strip[sent.indexOf('G')] = seenForGreen;
  strip[sent.indexOf('B')] = ['R', 'G', 'B'].find(c => c !== seenForRed && c !== seenForGreen);
  const index = COLOR_ORDERS.indexOf(strip.join(''));
  return index < 0 ? null : (code & ~0x0f) | index;
}

// Each output needs its own data pin; strips without one yet (set up in a later step) are left out of the layout
const validPin = pin => Number.isInteger(pin) && pin >= 0;
const readyStrips = plan => plan.strips.filter(s => validPin(s.pin) && s.count >= 1);
const readyLights = plan => plan.lights.filter(l => validPin(l.pin));

export const stripLabel = (plan, k) => (plan.strips.length === 1 ? 'RGB strip' : `RGB strip ${k + 1}`);
export const lightLabel = (plan, j) => (plan.lights.length === 1 ? 'Light strip' : `Light strip ${j + 1}`);

// WLED outputs (/json/cfg hw.led.ins) for the answers: the RGB strips, then the light strips. Fields the guide does not ask about are kept.
export function buildOutputs(plan) {
  let start = 0;
  const outputs = readyStrips(plan).map(s => {
    const out = { ...s.bus, start, len: s.count, pin: [s.pin], type: s.type, order: s.order, rev: Boolean(s.bus?.rev), skip: Number(s.bus?.skip) || 0 };
    start += s.count;
    return out;
  });
  readyLights(plan).forEach(l => {
    // A white light strip has no color order; keep what WLED reports so an unchanged layout stays unchanged
    outputs.push({ ...l.bus, start, len: 1, pin: [l.pin], type: PWM_WHITE, order: Number(l.bus?.order) || 0, rev: false, skip: 0 });
    start += 1;
  });
  return outputs;
}

// How many LEDs after a zone's first LED its effects start (WLED's segment offset "of")
export function zoneOffset(strip, zone, range) {
  return (strip.offsets[zone] || 0) % (range.stop - range.start);
}

// WLED segments with what each belongs to: { k, strip, zone, seg } per RGB strip zone, then { j, light, seg } per light strip.
// whole: one segment per RGB strip, as the light tests use. Only the saved layout and the idle preview carry the zone
// offsets; the tests use none, so their LED numbers are the strip's own.
export function layout(plan, { whole = false, offsets = false } = {}) {
  const entries = [];
  let base = 0;
  readyStrips(plan).forEach(strip => {
    const k = plan.strips.indexOf(strip);
    const ranges = zoneRanges(strip.count, whole ? 1 : strip.zones);
    const prefix = plan.strips.length === 1 ? 'RGB' : `RGB ${k + 1}`;
    ranges.forEach((r, zone) => entries.push({ k, strip, zone, seg: {
      n: ranges.length === 1 ? `${prefix} Strip` : `${prefix} zone ${zone + 1}`,
      start: base + r.start, stop: base + r.stop, of: offsets ? zoneOffset(strip, zone, r) : 0, on: true, frz: false
    } }));
    base += strip.count;
  });
  readyLights(plan).forEach(light => {
    const j = plan.lights.indexOf(light);
    entries.push({ j, light, seg: { n: lightLabel(plan, j), start: base, stop: base + 1, on: true, frz: false } });
    base += 1;
  });
  entries.forEach((e, id) => { e.seg = { id, ...e.seg }; });
  return entries;
}

export const buildSegments = (plan, options) => layout(plan, options).map(e => e.seg);

// Looks offered for the idle lighting (WLED effects: 9 Rainbow, 38 Aurora, 2 Breathe, 0 Solid)
export const IDLE_LOOKS = [
  { id: 'rainbow', label: 'Rainbow', fx: { fx: 9, pal: 0, sx: 128, ix: 128 } },
  { id: 'aurora', label: 'Aurora', fx: AURORA },
  { id: 'breathe', label: 'Breathing, in one color', color: true, fx: { fx: 2, pal: 0, sx: 128, ix: 128 } },
  { id: 'solid', label: 'One steady color', color: true, fx: { fx: 0, pal: 0 } },
  { id: 'off', label: 'Off' }
];
const percentToBri = percent => Math.round((percent / 100) * 255);

// The segments saved on Apply. WLED stores them as preset 1, which plays when no game is running and at startup
export function idleSegments(plan) {
  const { look: lookId, color, bri, lightBri } = plan.idle;
  const look = IDLE_LOOKS.find(l => l.id === lookId) || IDLE_LOOKS[0];
  return layout(plan, { offsets: true }).map(({ light, seg: s }) => {
    if (light) {
      return lightBri > 0 ? { ...s, bri: percentToBri(lightBri), fx: 0, col: [[255, 255, 255], [0, 0, 0]] } : { ...s, on: false };
    }
    if (!look.fx) return { ...s, on: false };
    return { ...s, bri: percentToBri(bri), ...look.fx, ...(look.color ? { col: [rgb(color), [0, 0, 0]] } : {}) };
  });
}

export function describeIdle(plan) {
  const { look: lookId, color, bri, lightBri } = plan.idle;
  const look = IDLE_LOOKS.find(l => l.id === lookId) || IDLE_LOOKS[0];
  const strips = plan.strips.length === 1 ? 'RGB strip' : 'RGB strips';
  const parts = [look.fx ? `${strips}: ${look.label}${look.color ? ` (${color})` : ''}, ${bri}%` : `${strips}: off`];
  if (readyLights(plan).length) parts.push(`${plan.lights.length === 1 ? 'Light strip' : 'Light strips'}: ${lightBri > 0 ? `${lightBri}%` : 'off'}`);
  return parts.join('\n');
}

// The parts of an output WLED rebuilds its LEDs for; other fields (current limits etc.) don't matter here
// Two layouts with the same key need no LED rewrite (writing outputs can make WLED reboot).
// A white light strip's color order means nothing, so it is left out.
export function layoutKey(outputs) {
  return JSON.stringify((outputs || []).map(o => [Number(o.start) || 0, Number(o.len) || 0, Number(firstPin(o)), Number(o.type),
    isPwmBus(o) ? 0 : Number(o.order) || 0, Boolean(o.rev), Number(o.skip) || 0]));
}

// The idle step starts from the controller's preset 1 (the idle and startup look), when it is one the guide offers
const LOOK_BY_FX = { 9: 'rainbow', 38: 'aurora', 2: 'breathe', 0: 'solid' };
const briToPercent = bri => Math.max(0, Math.min(100, Math.round((Number(bri ?? 255) / 255) * 100)));
const toHex = col => (Array.isArray(col) ? '#' + col.slice(0, 3).map(v => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('') : null);

function idleFromPreset(preset, buses) {
  const idle = { look: 'rainbow', color: '#00ff9d', bri: 100, lightBri: 100 };
  const segs = Array.isArray(preset?.seg) ? preset.seg.filter(s => Number(s?.stop) > Number(s?.start)) : [];
  if (!segs.length) return idle;
  const isLight = s => buses.some(b => isPwmBus(b) && Number(b.start) === Number(s.start));
  const light = segs.find(isLight);
  if (light) idle.lightBri = light.on === false ? 0 : briToPercent(light.bri);
  const rgb = segs.find(s => !isLight(s));
  if (rgb) {
    const look = rgb.on === false ? 'off' : LOOK_BY_FX[Number(rgb.fx)];
    if (look) {
      idle.look = look;
      idle.bri = briToPercent(rgb.bri) || 100;
      idle.color = toHex(rgb.col?.[0]) || idle.color;
    }
  }
  return idle;
}

function planFromLive(ip, live, preset = null) {
  const buses = Array.isArray(live?.hw_ins) ? live.hw_ins : [];
  const segs = Array.isArray(live?.state?.seg) ? live.state.seg : [];
  const rgbBuses = buses.filter(b => !isPwmBus(b));
  const strips = (rgbBuses.length ? rgbBuses : [null]).map((bus, k) => newStrip(bus, k === 0 ? 16 : ''));
  // Zones: today's split when it is an equal split (what the guide can make), else one zone per strip.
  // Per zone, the start of its effects as an offset from its first LED.
  strips.forEach(strip => {
    const base = Number(strip.bus?.start) || 0;
    const inside = segs
      .filter(s => Number(s?.stop) > Number(s?.start) && Number(s.start) >= base && Number(s.stop) <= base + strip.count)
      .sort((a, b) => Number(a.start) - Number(b.start));
    const ranges = zoneRanges(strip.count, inside.length || 1);
    const equal = inside.length > 1 && ranges.length === inside.length
      && ranges.every((r, i) => r.start + base === Number(inside[i].start) && r.stop + base === Number(inside[i].stop));
    if (equal) {
      strip.zones = inside.length;
      strip.offsets = inside.map(s => Math.max(0, Number(s.of) || 0));
    } else {
      const seg = segs.find(s => Number(s?.start) === base);
      strip.offsets = [Math.max(0, Number(seg?.of) || 0)];
    }
  });
  return {
    ip,
    name: live?.name || 'WLED Controller',
    strips,
    lights: buses.filter(isPwmBus).map(newLight),
    // From preset 1 when it holds a look the guide offers; else what the guide saved before it asked
    idle: idleFromPreset(preset, buses)
  };
}

function newStrip(bus = null, pin = '') {
  return {
    count: Number(bus?.len) || 45,
    pin: firstPin(bus) ?? pin,
    type: STRIP_TYPES[0].value,
    order: Number(bus?.order) || 0,
    colorsChecked: false,
    zones: 1,
    offsets: [],
    bus
  };
}

function newLight(bus = null) {
  return { pin: firstPin(bus) ?? '', bus };
}

function svg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

// The RGB strip as a bar from LED 1 to the last LED, colored by zone, with a white mark where each zone's effects start
function stripPreview(strip, k, label) {
  const width = 400;
  const gap = 3;
  const { count, zones } = strip;
  const root = svg('svg', { class: 'setup-strip', id: `setupStripPreview${k}`, viewBox: `0 0 ${width} 18`, role: 'img', 'aria-label': `${label} of ${count} LEDs in ${zones} zone${zones === 1 ? '' : 's'}` });
  zoneRanges(count, zones).forEach((range, zone) => {
    const x = (range.start / count) * width;
    const w = ((range.stop - range.start) / count) * width;
    const first = range.start + zoneOffset(strip, zone, range);
    root.append(
      svg('rect', { x, y: 2, width: Math.max(1, w - gap), height: 14, rx: 3, fill: ZONE_COLORS[zone % ZONE_COLORS.length] }),
      svg('rect', { x: (first / count) * width, y: 0, width: Math.max(3, width / count - 1), height: 18, rx: 1, fill: '#ffffff', stroke: '#000000', 'stroke-width': 0.75 }));
  });
  return root;
}

function swatch(color) {
  const root = svg('svg', { class: 'setup-swatch', viewBox: '0 0 10 10', 'aria-hidden': 'true' });
  root.append(svg('circle', { cx: 5, cy: 5, r: 5, fill: color }));
  return root;
}

function field(label, control, hint) {
  return h('label', { class: 'setup-field' },
    h('span', { class: 'setup-label' }, label),
    control,
    hint && h('small', { class: 'setup-hint' }, hint)
  );
}

function numberInput(value, { min = 0, max = 9999, placeholder = '', onchange }) {
  return h('input', { class: 'ui-input setup-number', type: 'number', inputmode: 'numeric', min, max, value, placeholder, oninput: event => onchange(event.target) });
}

// A number with − and + buttons; onchange gets each count inside min..max
function countStepper(value, { min, max, label, onchange }) {
  let current = value;
  const set = n => {
    current = Math.max(min, Math.min(max, n));
    input.value = current;
    onchange(current);
  };
  const input = numberInput(value, { min, max, onchange: el => {
    const n = parseInt(el.value, 10);
    if (n >= min && n <= max) {
      current = n;
      onchange(n);
    }
  } });
  input.setAttribute('aria-label', label);
  // A number outside min..max is not applied; leaving the field shows the count in use again
  input.addEventListener('change', () => { input.value = current; });
  return h('span', { class: 'setup-stepper' },
    h('button', { class: 'ui-btn ui-btn-sm', type: 'button', 'aria-label': `${label}: one less`, onclick: () => set(current - 1) }, '−'),
    input,
    h('button', { class: 'ui-btn ui-btn-sm', type: 'button', 'aria-label': `${label}: one more`, onclick: () => set(current + 1) }, '+'));
}

function choiceButtons(options, onpick) {
  return h('div', { class: 'setup-choices' }, ...options.map(([value, label, tone]) =>
    h('button', { class: 'ui-btn ui-btn-sm', type: 'button', dataset: tone ? { tone } : {}, onclick: () => onpick(value) }, label)));
}

// Opens the guide for a controller. Resolves { name, hw_ins, seg } when the user applies it, or null.
export async function runControllerSetup(ip, live) {
  const preset = await api.get(`/api/wled/preset?ip=${encodeURIComponent(ip)}`, { timeout: 4000 }).catch(() => null);
  const plan = planFromLive(ip, live, preset);
  const original = { hw_ins: structuredClone(live?.hw_ins || []), state: structuredClone(live?.state || {}) };
  let stepIndex = 0;
  let touched = false;      // a light test changed the controller's layout
  // The layout the controller has now. Outputs are only sent when they differ: every write makes WLED
  // rebuild its LEDs, which wipes test colors and costs time
  const originalLayout = layoutKey(original.hw_ins);
  let sentOutputs = originalLayout;
  let stripK = 0;            // the RGB strip whose step is open
  let stripTest = null;      // { kind: 'ends' } or { kind: 'colors', seenForRed, asking }
  const lightTests = [];     // per light strip: 'on' | 'ok' | 'dark'
  let busy = false;

  return new Promise(resolve => {
    const body = h('div', { class: 'setup-body' });
    // Toasts render under the modal, so the guide reports its own errors
    const status = h('p', { class: 'setup-status', role: 'alert', hidden: true });
    const progress = h('ol', { class: 'setup-progress' });
    const backBtn = h('button', { class: 'ui-btn', type: 'button', onclick: () => go(-1) }, 'Back');
    const nextBtn = h('button', { class: 'ui-btn ui-btn-primary', type: 'button', onclick: () => go(1) }, 'Next');
    const cancelBtn = h('button', { class: 'ui-btn ui-btn-quiet setup-cancel', type: 'button', onclick: () => close(null) }, 'Cancel');
    const dialog = h('dialog', { class: 'ui-dialog setup-dialog', 'aria-label': `Set up ${plan.name}` },
      h('div', { class: 'setup-head' },
        h('div', { class: 'ui-dialog-title' }, 'Set up controller'),
        h('div', { class: 'setup-sub' }, ip)),
      progress,
      body,
      status,
      h('div', { class: 'ui-dialog-actions' }, cancelBtn, backBtn, nextBtn)
    );
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      close(null);
    });

    const steps = () => [
      { id: 'basics', title: 'Controller', render: renderBasics, check: checkBasics },
      ...plan.strips.map((_, k) => ({ id: 'strip', strip: k, title: stripLabel(plan, k), render: () => renderStrip(k), check: checkStrip })),
      plan.lights.length > 0 && { id: 'light', title: plan.lights.length === 1 ? 'Light strip' : 'Light strips', render: renderLights, check: checkLights },
      { id: 'zones', title: 'Zones', render: renderZones, check: () => true },
      { id: 'idle', title: 'Idle lighting', render: renderIdle, check: () => true },
      { id: 'review', title: 'Review', render: renderReview, check: () => true }
    ].filter(Boolean);

    async function preview(state, outputs = buildOutputs(plan)) {
      const key = layoutKey(outputs);
      busy = true;
      status.hidden = true;
      try {
        await api.post('/api/wled/setup-preview', { ip, hw_ins: key === sentOutputs ? null : outputs, state }, { timeout: 8000 });
        sentOutputs = key;
        touched = true;
        return true;
      } catch (err) {
        // Only a controller that did not answer gets the power/network hint; other errors are AutoGlow's own
        status.textContent = err?.code === 'DEVICE_UNREACHABLE'
          ? `${err.message}. Check that it is powered and on the network, then try again.`
          : err?.status === 404 || err?.status === 405
            ? 'AutoGlow is running an older version without the light tests. Restart AutoGlow and try again.'
            : (err?.message || 'The light test failed.');
        status.hidden = false;
        return false;
      } finally {
        busy = false;
      }
    }

    // One RGB strip in one color; the other RGB strips and the light strips off
    function stripState(k, color, extra = {}) {
      const seg = layout(plan, { whole: true }).map(e => (e.k === k ? { ...e.seg, fx: 0, col: [rgb(color), [0, 0, 0]], ...extra } : { ...e.seg, on: false }));
      return { on: true, bri: 110, transition: 0, seg };
    }

    async function restoreAfterReboot(state) {
      for (let waited = 0; waited < 30000; waited += 1500) {
        await new Promise(done => setTimeout(done, 1500));
        const ping = await api.get(`/api/ping?ip=${encodeURIComponent(ip)}`, { timeout: 3000 }).catch(() => null);
        if (!ping?.online) continue;
        try {
          await api.post('/api/wled/setup-preview', { ip, hw_ins: null, state }, { timeout: 8000 });
          return true;
        } catch (err) {
          return false;
        }
      }
      return false;
    }

    async function close(result) {
      if (dialog.dataset.closing) return;
      dialog.dataset.closing = 'true';
      // A queued idle preview or start LED test must not land after the restore below
      clearTimeout(idleTimer);
      clearTimeout(startTimer);
      if (!result && touched) {
        cancelBtn.textContent = 'Restoring…';
        const restoreOutputs = sentOutputs !== originalLayout && original.hw_ins.length ? original.hw_ins : null;
        const restoreState = { on: original.state.on ?? true, bri: original.state.bri ?? 128, seg: (original.state.seg || []).map(s => ({ ...s, frz: false })) };
        try {
          await api.post('/api/wled/setup-preview', { ip, hw_ins: restoreOutputs, state: restoreState }, { timeout: 8000 });
        } catch (err) {
          // Writing LED outputs can make WLED reboot mid-request; wait for it, then put the old state back
          if (!(restoreOutputs && await restoreAfterReboot(restoreState))) {
            toast.warning('Could not restore the controller\'s previous LED layout. Open its WLED page to check it.');
          }
        }
      }
      dialog.close();
      dialog.remove();
      resolve(result);
    }

    function go(delta) {
      const list = steps();
      const step = list[stepIndex];
      if (delta > 0 && !step.check()) return;
      // The strip shows the next step's test from here on, not the start LED
      clearTimeout(startTimer);
      clearTimeout(endsTimer);
      startTest = null;
      stripTest = null;
      if (delta > 0 && step.id === 'review') {
        close({ name: plan.name, hw_ins: buildOutputs(plan), seg: idleSegments(plan) });
        return;
      }
      // A checked RGB strip shows its own look; the next strip's test lights only that one
      if (delta > 0 && step.id === 'strip') {
        preview({ on: true, bri: 110, transition: 0, seg: layout(plan, { whole: true }).map(e => (e.light ? { ...e.seg, on: false } : { ...e.seg, ...AURORA })) });
      }
      // Entering the idle step: show the current idle look on the strip
      if (delta > 0 && step.id === 'zones') previewIdle(0);
      stepIndex = Math.max(0, Math.min(list.length - 1, stepIndex + delta));
      render();
    }

    function renderProgress() {
      const list = steps();
      progress.replaceChildren(...list.map((s, i) => h('li', { 'aria-current': i === stepIndex ? 'step' : null, dataset: { done: String(i < stepIndex) } }, s.title)));
    }

    function render() {
      const list = steps();
      stepIndex = Math.min(stepIndex, list.length - 1);
      const step = list[stepIndex];
      renderProgress();
      backBtn.hidden = stepIndex === 0;
      nextBtn.textContent = step.id === 'review' ? 'Apply to controller' : 'Next';
      status.hidden = true;
      body.replaceChildren(...step.render());
    }

    // --- Step 1: name and what is connected ---
    function renderBasics() {
      const name = h('input', { class: 'ui-input', id: 'setupName', type: 'text', value: plan.name, maxlength: 32, oninput: event => { plan.name = event.target.value; } });
      // More or fewer strips change the steps; the strips kept keep their answers
      const resize = (list, n, make) => {
        while (list.length < n) list.push(make());
        list.length = n;
        renderProgress();
      };
      return [
        h('p', { class: 'setup-lead' }, 'A few questions about what is wired to this controller. AutoGlow then sets up WLED for you.'),
        field('What should this controller be called?', name),
        h('fieldset', { class: 'setup-field' },
          h('legend', { class: 'setup-label' }, 'What is connected to it?'),
          h('div', { class: 'setup-check' },
            countStepper(plan.strips.length, { min: 1, max: MAX_STRIPS, label: 'WS281x RGB LED strips', onchange: n => resize(plan.strips, n, () => newStrip()) }),
            h('span', {}, 'WS281x RGB LED strips (every LED can show its own color)')),
          h('div', { class: 'setup-check' },
            countStepper(plan.lights.length, { min: 0, max: MAX_LIGHTS, label: 'Regular light strips', onchange: n => resize(plan.lights, n, () => newLight()) }),
            h('span', {}, 'Regular light strips (one color, only on/off and dimming)')),
          h('small', { class: 'setup-hint' }, 'Filled in from what the controller reports today. Each strip is wired to its own data pin (GPIO).')
        ),
        h('button', { class: 'ui-btn ui-btn-sm ui-btn-link', type: 'button', onclick: () => close({ skip: true }) }, 'Skip the guide and keep WLED\'s current setup')
      ];
    }

    function checkBasics() {
      const input = document.getElementById('setupName');
      plan.name = plan.name.trim();
      if (!plan.name) {
        showFieldError(input, 'Give the controller a name');
        return false;
      }
      return true;
    }

    // The strip or light strip other than self already on this pin, or null
    function pinOwner(pin, self) {
      const k = plan.strips.findIndex(s => s !== self && s.pin === pin);
      if (k >= 0) return stripLabel(plan, k);
      const j = plan.lights.findIndex(l => l !== self && l.pin === pin);
      return j >= 0 ? lightLabel(plan, j) : null;
    }

    // --- Step 2: each RGB strip ---
    const strip = () => plan.strips[stripK];

    function renderStrip(k) {
      stripK = k;
      const s = strip();
      const count = numberInput(s.count, { min: 1, max: 1500, onchange: input => {
        s.count = parseInt(input.value, 10) || 0;
        // Re-light the ends while the user dials the count in
        if (stripTest?.kind === 'ends' && s.count > 0) debounceEnds();
      } });
      count.id = 'setupCount';
      const stepper = h('div', { class: 'setup-stepper' },
        h('button', { class: 'ui-btn ui-btn-sm', type: 'button', 'aria-label': 'One LED less', onclick: () => bump(-1) }, '−'),
        count,
        h('button', { class: 'ui-btn ui-btn-sm', type: 'button', 'aria-label': 'One LED more', onclick: () => bump(1) }, '+'));
      const pin = numberInput(s.pin, { min: 0, max: 48, placeholder: 'e.g. 16', onchange: input => { s.pin = input.value === '' ? '' : parseInt(input.value, 10); } });
      pin.id = 'setupStripPin';
      const type = h('select', { class: 'ui-input', onchange: event => { s.type = Number(event.target.value); } },
        ...STRIP_TYPES.map(t => h('option', { value: t.value, selected: t.value === s.type }, t.label)));
      const order = h('select', { class: 'ui-input', id: 'setupOrder', onchange: event => setOrder(Number(event.target.value)) },
        ...COLOR_ORDERS.map((label, value) => h('option', { value, selected: value === (s.order & 0x0f) }, label)));
      const which = plan.strips.length === 1 ? 'the RGB strip' : `RGB strip ${k + 1}`;

      return [
        field(`How many LEDs does ${which} have?`, stepper),
        h('div', { class: 'setup-row' },
          field('Data pin (GPIO)', pin, s.bus ? 'Filled in from the controller.' : null),
          field('LED type', type),
          field('Color order', order)),
        h('div', { class: 'setup-test' },
          h('div', { class: 'setup-test-head' },
            h('span', { class: 'setup-label' }, 'Verify live'),
            h('div', { class: 'setup-choices' },
              h('button', { class: 'ui-btn ui-btn-sm', type: 'button', onclick: testEnds }, 'LED count'),
              h('button', { class: 'ui-btn ui-btn-sm', type: 'button', onclick: findOrder }, 'Colors'))),
          stripTestBody())
      ];
    }

    function bump(delta) {
      const input = document.getElementById('setupCount');
      strip().count = Math.max(1, (parseInt(input.value, 10) || 0) + delta);
      input.value = strip().count;
      clearFieldError(input);
      if (stripTest?.kind === 'ends') debounceEnds();
    }

    let endsTimer = null;
    function debounceEnds() {
      clearTimeout(endsTimer);
      endsTimer = setTimeout(() => { if (checkStrip()) testEnds(); }, 350);
    }

    async function testEnds() {
      if (busy || !checkStrip()) return;
      const last = strip().count - 1;
      // White stays white with any color order, so the two ends can't be mixed up before the color check
      const ok = await preview(stripState(stripK, '#000000', { i: last === 0 ? [0, 'FFFFFF'] : [0, 'FFFFFF', last, 'FF0000'] }));
      if (ok) {
        stripTest = { kind: 'ends' };
        refreshStripTest();
      }
    }

    // Red, green and blue bands from the start of the strip; the screen shows the same three swatches
    async function testBands() {
      if (busy || !checkStrip()) return;
      const { count } = strip();
      const bands = count >= 3 ? zoneRanges(count, 3) : zoneRanges(count, count);
      const i = bands.flatMap((b, n) => [b.start, b.stop, ['FF0000', '00FF00', '0000FF'][n]]);
      if (await preview(stripState(stripK, '#000000', { i }))) {
        stripTest = { kind: 'bands' };
        refreshStripTest();
      }
    }

    function setOrder(value) {
      strip().order = (strip().order & ~0x0f) | value;
      strip().colorsChecked = false;
      const select = document.getElementById('setupOrder');
      if (select) select.value = String(value);
      // Trying orders one after another: show each one on the strip straight away
      if (stripTest?.kind === 'bands') testBands();
    }

    async function findOrder() {
      if (busy || !checkStrip()) return;
      if (await preview(stripState(stripK, '#ff0000'))) {
        stripTest = { kind: 'colors', asking: 'red' };
        refreshStripTest();
      }
    }

    async function answerColor(seen) {
      if (stripTest.asking === 'red') {
        if (await preview(stripState(stripK, '#00ff00'))) {
          stripTest = { kind: 'colors', asking: 'green', seenForRed: seen };
          refreshStripTest();
        }
        return;
      }
      const order = deriveColorOrder(strip().order, stripTest.seenForRed, seen);
      if (order === null) {
        stripTest = { kind: 'colors', result: 'conflict' };
        refreshStripTest();
        return;
      }
      setOrder(order & 0x0f);
      strip().colorsChecked = true;
      // Show red, green, blue on the strip as proof
      await testBands();
    }

    function confirmColors() {
      strip().colorsChecked = true;
      refreshStripTest();
    }

    function refreshStripTest() {
      document.getElementById('setupStripTest')?.replaceWith(stripTestBody());
    }

    function stripTestBody() {
      const box = h('div', { class: 'setup-test-body', id: 'setupStripTest', 'aria-live': 'polite' });
      const verdict = (tone, text) => h('p', { class: 'setup-verdict', dataset: { tone } }, text);
      if (!stripTest) return box;
      const s = strip();

      if (stripTest.kind === 'ends') {
        if (stripTest.answer === 'ok') {
          box.append(verdict('ok', `✓ ${s.count} LEDs`));
          return box;
        }
        box.append(
          h('p', {}, 'White = first LED. Is the colored LED the last one?'),
          choiceButtons([['ok', 'Yes', 'ok'], ['gap', 'LEDs after it'], ['one', 'Not visible'], ['none', 'Nothing lit']], answer => {
            stripTest = { kind: 'ends', answer };
            refreshStripTest();
          })
        );
        if (stripTest.answer) {
          box.append(verdict('warn', {
            gap: 'Press + until it\'s the last one.',
            one: 'Press − until it shows up.',
            none: 'Check the data pin and power.'
          }[stripTest.answer]));
        }
      } else if (stripTest.kind === 'bands') {
        box.append(h('div', { class: 'setup-bands' },
          ...[['#ff0000', 'Red'], ['#00ff00', 'Green'], ['#0000ff', 'Blue']].slice(0, Math.min(3, s.count))
            .map(([color, label]) => h('span', { class: 'setup-band' }, swatch(color), label))));
        box.append(s.colorsChecked
          ? verdict('ok', `✓ ${COLOR_ORDERS[s.order & 0x0f]}`)
          : choiceButtons([['ok', 'Matches', 'ok']], confirmColors));
      } else if (stripTest.asking) {
        box.append(
          h('p', {}, `Which color is the strip? (${stripTest.asking === 'red' ? 1 : 2}/2)`),
          choiceButtons([['R', 'Red'], ['G', 'Green'], ['B', 'Blue']], answerColor)
        );
      } else {
        box.append(verdict('warn', 'Answers don\'t fit together. Press Colors to try again.'));
      }
      return box;
    }

    function checkStrip() {
      const s = strip();
      const count = document.getElementById('setupCount');
      const pin = document.getElementById('setupStripPin');
      if (!(s.count >= 1 && s.count <= 1500)) {
        showFieldError(count, 'Enter a number from 1 to 1500');
        return false;
      }
      if (!validPin(s.pin)) {
        showFieldError(pin, 'Enter the GPIO number');
        return false;
      }
      const owner = pinOwner(s.pin, s);
      if (owner) {
        showFieldError(pin, `GPIO ${s.pin} is already used by ${owner}. Each strip needs its own pin.`);
        return false;
      }
      return true;
    }

    // --- Step 3: light strips ---
    // The light strip lit white with WLED effect fx (1 = Blink, 0 = steady); the other light strips off, the RGB strips in Aurora
    function lightState(light, fx) {
      const seg = layout(plan, { whole: true }).map(e => (e.light === light
        ? { ...e.seg, bri: 255, fx, sx: 128, ix: 128, col: [[255, 255, 255], [0, 0, 0]] }
        : e.light ? { ...e.seg, on: false } : { ...e.seg, ...AURORA }));
      return { on: true, bri: 255, transition: 0, seg };
    }

    function renderLights() {
      return plan.lights.flatMap(lightBlock);
    }

    function lightBlock(light, j) {
      const pin = numberInput(light.pin, { min: 0, max: 48, placeholder: 'e.g. 26', onchange: input => {
        light.pin = input.value === '' ? '' : parseInt(input.value, 10);
        lightTests[j] = null;
      } });
      pin.id = `setupLightPin${j}`;
      const test = h('div', { class: 'setup-test-body', 'aria-live': 'polite' });
      const paint = () => {
        const result = lightTests[j];
        test.replaceChildren(...(!result ? [] : result === 'on' ? [
          h('p', {}, `Is ${plan.lights.length === 1 ? 'the light strip' : `light strip ${j + 1}`} blinking?`),
          choiceButtons([['ok', 'Yes', 'ok'], ['dark', 'No']], answer => {
            lightTests[j] = answer;
            paint();
            // Stop blinking once answered; the light stays on
            preview(lightState(light, 0));
          })
        ] : [h('p', { class: 'setup-verdict', dataset: { tone: result === 'ok' ? 'ok' : 'warn' } },
          result === 'ok' ? '✓ Works' : 'Check the pin and power.')]));
      };
      paint();
      return [
        field(`Which pin (GPIO) is ${plan.lights.length === 1 ? 'the light strip' : `light strip ${j + 1}`} on?`, pin),
        h('div', { class: 'setup-test' },
          h('div', { class: 'setup-test-head' },
            h('span', { class: 'setup-label' }, 'Verify live'),
            h('button', { class: 'ui-btn ui-btn-sm', type: 'button', onclick: async () => {
              if (busy || !checkLight(light, j)) return;
              // Blink between off and 100%, so it's visible even if the light was already fully on
              if (await preview(lightState(light, 1))) {
                lightTests[j] = 'on';
                paint();
              }
            } }, 'Blink')),
          test)
      ];
    }

    function checkLight(light, j) {
      const input = document.getElementById(`setupLightPin${j}`);
      if (!validPin(light.pin)) {
        showFieldError(input, 'Enter the GPIO number');
        return false;
      }
      const owner = pinOwner(light.pin, light);
      if (owner) {
        showFieldError(input, `GPIO ${light.pin} is already used by ${owner}. Each strip needs its own pin.`);
        return false;
      }
      return true;
    }

    const checkLights = () => plan.lights.every(checkLight);

    // --- Step 4: zones, per RGB strip ---
    let startTest = null;     // { k, zone }: the zone whose start LED is lit on the strip
    let startTimer = null;

    function renderZones() {
      return [
        h('p', { class: 'setup-lead' }, `Each zone gets its own effects in the Event and Flow matrices, so different parts of ${plan.strips.length === 1 ? 'the RGB strip' : 'the RGB strips'} can light up differently. Effects start at a zone's first LED unless you pick another one; they run to the zone's end and continue from its first LED.`),
        ...plan.strips.flatMap(zoneBlock),
        h('small', { class: 'setup-hint' }, 'Uneven splits can be made later in the advanced editor.'),
        startTestBody(),
        h('div', { class: 'setup-choices' },
          h('button', { class: 'ui-btn ui-btn-sm', type: 'button', onclick: async () => {
            if (busy) return;
            const seg = layout(plan).map(e => (e.light ? { ...e.seg, on: false } : { ...e.seg, fx: 0, col: [rgb(ZONE_COLORS[e.zone % ZONE_COLORS.length]), [0, 0, 0]] }));
            if (await preview({ on: true, bri: 110, transition: 0, seg })) {
              startTest = null;
              refreshStartTest();
            }
          } }, plan.strips.length === 1 ? 'Show the zones on the strip' : 'Show the zones on the strips'))
      ];
    }

    function zoneBlock(s, k) {
      const maxZones = Math.min(MAX_ZONES, s.count);
      const split = s.zones > 1;
      const zoneCount = numberInput(split ? s.zones : 4, { min: 2, max: maxZones, onchange: input => {
        const n = parseInt(input.value, 10);
        if (n >= 2 && n <= maxZones) setZones(n);
      } });
      zoneCount.disabled = !split;
      const pick = zones => {
        zoneCount.disabled = zones === 1;
        setZones(zones);
      };
      // New zone bounds make the old start LEDs meaningless, so each zone starts at its first LED again
      const setZones = zones => {
        if (zones !== s.zones) {
          s.zones = zones;
          s.offsets = [];
          if (startTest?.k === k) {
            startTest = null;
            refreshStartTest();
          }
        }
        refreshZones();
      };
      const zonesBox = h('div', { class: 'setup-zones' });
      const refreshZones = () => zonesBox.replaceChildren(stripPreview(s, k, stripLabel(plan, k)), zoneList(s, k));
      refreshZones();
      const radio = `setupZones${k}`;
      return [
        h('fieldset', { class: 'setup-field' },
          h('legend', { class: 'setup-label' }, `How should ${plan.strips.length === 1 ? 'the RGB strip' : `RGB strip ${k + 1}`} be used?`),
          h('label', { class: 'setup-check' }, h('input', { type: 'radio', name: radio, checked: !split, onchange: () => pick(1) }), h('span', {}, 'As one zone (the whole strip)')),
          h('label', { class: 'setup-check' }, h('input', { type: 'radio', name: radio, checked: split, disabled: maxZones < 2, onchange: () => pick(parseInt(zoneCount.value, 10) || 4) }), h('span', {}, 'Split into equal zones:'), zoneCount)),
        zonesBox
      ];
    }

    function zoneList(s, k) {
      const ranges = zoneRanges(s.count, s.zones);
      return h('ul', { class: 'setup-zone-list' }, ...ranges.map((r, i) => h('li', {},
        swatch(ZONE_COLORS[i % ZONE_COLORS.length]),
        zoneLabel(ranges, i),
        h('span', { class: 'setup-muted' }, `${humanRange(r)} (${r.stop - r.start})`),
        zoneStart(s, k, r, i))));
    }

    const zoneLabel = (ranges, i) => (ranges.length === 1 ? 'Whole strip' : `Zone ${i + 1}`);

    // "Starts at LED" with − and +, counted like the strip (from 1); the buttons wrap around inside the zone
    function zoneStart(s, k, range, zone) {
      const len = range.stop - range.start;
      const firstLed = () => range.start + zoneOffset(s, zone, range) + 1;
      const set = offset => {
        s.offsets[zone] = ((offset % len) + len) % len;
        input.value = firstLed();
        document.getElementById(`setupStripPreview${k}`)?.replaceWith(stripPreview(s, k, stripLabel(plan, k)));
        clearTimeout(startTimer);
        startTimer = setTimeout(() => testStart(k, zone), 250);
      };
      const input = numberInput(firstLed(), { min: range.start + 1, max: range.stop, onchange: el => {
        const led = parseInt(el.value, 10);
        if (led >= range.start + 1 && led <= range.stop) set(led - 1 - range.start);
      } });
      input.setAttribute('aria-label', `LED where effects start, ${range.start + 1} to ${range.stop}`);
      // A number outside the zone is not applied; leaving the field shows the start in use again
      input.addEventListener('change', () => { input.value = firstLed(); });
      const step = delta => set(zoneOffset(s, zone, range) + delta);
      return h('span', { class: 'setup-zone-start' },
        h('span', { class: 'setup-muted' }, 'Starts at LED'),
        h('span', { class: 'setup-stepper' },
          h('button', { class: 'ui-btn ui-btn-sm', type: 'button', 'aria-label': 'Start one LED earlier', disabled: len === 1, onclick: () => step(-1) }, '−'),
          input,
          h('button', { class: 'ui-btn ui-btn-sm', type: 'button', 'aria-label': 'Start one LED later', disabled: len === 1, onclick: () => step(1) }, '+')),
        h('button', { class: 'ui-btn ui-btn-sm', type: 'button', onclick: () => testStart(k, zone) }, 'Show'));
    }

    // Green on the zone's start LED, red on the LED before and after it (wrapping inside the zone).
    // The other zones stay dark. WLED's "i" counts from the segment's first LED, and the test segments have no offset.
    async function testStart(k, zone) {
      if (busy) return;
      const s = plan.strips[k];
      const range = s && zoneRanges(s.count, s.zones)[zone];
      if (!range) return;
      const len = range.stop - range.start;
      const first = zoneOffset(s, zone, range);
      const i = [first, '00FF00'];
      if (len > 1) i.push((first + len - 1) % len, 'FF0000', (first + 1) % len, 'FF0000');
      const seg = layout(plan).map(e => (e.light
        ? { ...e.seg, on: false }
        : { ...e.seg, fx: 0, col: [[0, 0, 0], [0, 0, 0]], ...(e.k === k && e.zone === zone ? { i } : {}) }));
      if (await preview({ on: true, bri: 110, transition: 0, seg })) {
        startTest = { k, zone };
        refreshStartTest();
      }
    }

    function refreshStartTest() {
      document.getElementById('setupStartTest')?.replaceWith(startTestBody());
    }

    function startTestBody() {
      const box = h('div', { class: 'setup-test-body setup-zones-test', id: 'setupStartTest', 'aria-live': 'polite' });
      const s = startTest && plan.strips[startTest.k];
      const ranges = s ? zoneRanges(s.count, s.zones) : [];
      const r = startTest && ranges[startTest.zone];
      if (!r) return box;
      const zone = zoneLabel(ranges, startTest.zone);
      const label = plan.strips.length === 1 ? zone : `${stripLabel(plan, startTest.k)}, ${zone.toLowerCase()}`;
      box.append(h('p', {}, `${label}: green = LED ${r.start + zoneOffset(s, startTest.zone, r) + 1}, where effects start, with a red LED on each side. Use − and + until the green LED is where you want it.`));
      return box;
    }

    // --- Step 5: idle lighting ---
    let idleTimer = null;
    function previewIdle(delay = 250) {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => preview({ on: true, bri: 255, transition: 0, seg: idleSegments(plan) }), delay);
    }

    function slider(value, { min, label, onchange }) {
      const shown = h('span', { class: 'setup-muted setup-slider-value' });
      const show = v => { shown.textContent = v > 0 ? `${v}%` : 'Off'; };
      show(value);
      const input = h('input', { class: 'setup-range', type: 'range', min, max: 100, step: 5, value, 'aria-label': label, oninput: event => {
        const v = Number(event.target.value);
        show(v);
        onchange(v);
      } });
      return h('div', { class: 'setup-slider' }, input, shown);
    }

    function renderIdle() {
      const idle = plan.idle;
      const look = () => IDLE_LOOKS.find(l => l.id === idle.look) || IDLE_LOOKS[0];
      const strips = plan.strips.length === 1 ? 'RGB strip' : 'RGB strips';
      const lights = plan.lights.length === 1 ? 'Light strip' : 'Light strips';
      const colorField = field('Color', h('input', { class: 'setup-color', type: 'color', value: idle.color, oninput: event => { idle.color = event.target.value; previewIdle(); } }));
      const briField = field(`${strips} brightness`, slider(idle.bri, { min: 5, label: `${strips} brightness`, onchange: v => { idle.bri = v; previewIdle(); } }));
      const sync = () => {
        colorField.hidden = !look().color;
        briField.hidden = !look().fx;
      };
      sync();
      return [
        h('p', { class: 'setup-lead' }, 'What should the lights show when no game is running? The controller also starts up with this.'),
        h('fieldset', { class: 'setup-field' },
          h('legend', { class: 'setup-label' }, strips),
          ...IDLE_LOOKS.map(l => h('label', { class: 'setup-check' },
            h('input', { type: 'radio', name: 'setupIdleLook', checked: l.id === idle.look, onchange: () => { idle.look = l.id; sync(); previewIdle(0); } }),
            h('span', {}, l.label)))),
        h('div', { class: 'setup-row' }, colorField, briField),
        readyLights(plan).length > 0 && field(`${lights} brightness`, slider(idle.lightBri, { min: 0, label: `${lights} brightness`, onchange: v => { idle.lightBri = v; previewIdle(); } })),
        h('small', { class: 'setup-hint' }, 'The strip shows your choice as you pick. Each zone can get its own look later under Edit › Idle lighting.')
      ].filter(Boolean);
    }

    // --- Step 6: review ---
    function renderReview() {
      const many = plan.strips.length > 1;
      const stripRows = plan.strips.flatMap((s, k) => {
        const type = STRIP_TYPES.find(t => t.value === s.type).label;
        const ranges = zoneRanges(s.count, s.zones);
        const zones = ranges.map((r, i) => {
          const offset = zoneOffset(s, i, r);
          const start = offset ? `, effects start at LED ${r.start + offset + 1}` : '';
          return ranges.length === 1 ? `One zone, the whole strip${start}` : `Zone ${i + 1}: ${humanRange(r)}${start}`;
        }).join('\n');
        return [
          [stripLabel(plan, k), `${s.count} LEDs on GPIO ${s.pin}, ${type}`],
          [many ? `Colors ${k + 1}` : 'Colors', `${COLOR_ORDERS[s.order & 0x0f]} order${s.colorsChecked ? ', checked' : ' (not checked)'}`],
          [many ? `Zones ${k + 1}` : 'Zones', zones]
        ];
      });
      const rows = [
        ['Name', plan.name],
        ...stripRows,
        [plan.lights.length > 1 ? 'Light strips' : 'Light strip', plan.lights.length
          ? plan.lights.map((l, j) => (plan.lights.length === 1 ? `On GPIO ${l.pin}` : `${lightLabel(plan, j)}: GPIO ${l.pin}`)).join('\n')
          : 'None'],
        ['Idle lighting', describeIdle(plan)]
      ];
      return [
        h('dl', { class: 'setup-review' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
        h('small', { class: 'setup-hint' }, 'AutoGlow writes this to the controller and saves it as its startup layout. You can fine-tune it later with Edit.')
      ];
    }

    document.body.append(dialog);
    render();
    dialog.showModal();
    document.getElementById('setupName')?.focus();
  });
}
