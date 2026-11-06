// AutoGlow 2 - Setup › Controllers › guided setup
// A full-page, picture-first flow: tap the pins the strips are plugged into; then per RGB strip drag a
// marker to its last LED, pick the color picture the strip shows, split it into zones and name it. Light tests write a temporary layout to the controller; Cancel puts the
// controller's own layout back.

import { api } from '../core/api.js';
import { h } from '../core/dom.js';
import { appStore } from '../core/store.js';
import { toast } from '../core/toast.js';
import { isPwmOutput as isPwmBus } from './led-layout.js';

const PWM_WHITE = 41;
const WS281X = 22;
// WLED's color order codes 0-5
const COLOR_ORDERS = ['GRB', 'RGB', 'BRG', 'RBG', 'BGR', 'GBR'];
// Same order as the controller page's zone colors, so the strip and the screen show the same colors
const ZONE_COLORS = ['#22d3ee', '#f59e0b', '#a855f7', '#22c55e', '#ef4444', '#3b82f6', '#ec4899', '#eab308', '#14b8a6', '#f97316', '#8b5cf6', '#84cc16'];
const MAX_ZONES = 12;
const MAX_LEDS = 1500;
const NAME_MAX = 24;
// WLED's Aurora effect (38) with its own Aurora palette (50)
const AURORA = { fx: 38, pal: 50, sx: 128, ix: 128 };
const SVG_NS = 'http://www.w3.org/2000/svg';
// The pins a strip can use, per chip (WLED's info.arch). Pins already in use are always shown as well.
const PINS_BY_ARCH = {
  esp32: [2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33],
  esp8266: [1, 2, 3, 4, 5, 12, 13, 14, 15, 16],
  'esp32-s2': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 33, 34, 35, 36, 37, 38, 39, 40],
  'esp32-s3': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 38, 39, 40, 41, 42, 47, 48],
  'esp32-c3': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 21]
};
const NAME_IDEAS = { rgb: ['Left side', 'Right side', 'Top', 'Bottom'], light: ['Back light', 'Ceiling', 'Shelf'] };
// "What colour is your strip?": the whole strip shows one colour, so it works whichever way the strip is mounted.
// Red first, then green; blue follows from the two answers.
const COLOR_CHOICES = ['R', 'G', 'B'];
const TEST_HEX = { R: 'FF0000', G: '00FF00' };
const HEX = { R: '#ff3b3b', G: '#2bff6a', B: '#3b82ff' };
const COLOR_WORDS = { R: 'red', G: 'green', B: 'blue' };

const firstPin = bus => (Array.isArray(bus?.pin) ? bus.pin[0] : bus?.pin);
const rgb = color => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
const validPin = pin => Number.isInteger(pin) && pin >= 0;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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

// Where the equal split into n zones puts its zone borders
const evenCuts = (count, n) => zoneRanges(count, n).slice(1).map(r => r.start);

// A strip's zones from its split points (each split starts a new zone)
export function rangesFromCuts(count, cuts = []) {
  const bounds = [0, ...cuts.filter(c => c > 0 && c < count).sort((a, b) => a - b), count];
  const ranges = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i + 1] > bounds[i]) ranges.push({ start: bounds[i], stop: bounds[i + 1] });
  }
  return ranges;
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

// --- The plan: one entry per output, in the same shape for RGB strips and light strips ---

const byPin = (a, b) => a.pin - b.pin;
const rgbOutputs = plan => plan.outputs.filter(o => o.kind === 'rgb' && validPin(o.pin) && o.count >= 1).sort(byPin);
const lightOutputs = plan => plan.outputs.filter(o => o.kind === 'light' && validPin(o.pin)).sort(byPin);
// The order the steps and the board show: by pin
const sortedOutputs = plan => plan.outputs.slice().sort(byPin);

// "RGB strip 2" / "Light strip": the plain label of an output until it is named
export function plainLabel(plan, o) {
  const same = sortedOutputs(plan).filter(x => x.kind === o.kind);
  const base = o.kind === 'rgb' ? 'RGB strip' : 'Light strip';
  return same.length === 1 ? base : `${base} ${same.indexOf(o) + 1}`;
}
export const outputLabel = (plan, o) => (o.name || '').trim() || plainLabel(plan, o);

// Segment names AutoGlow or WLED gave without asking the user; they don't count as a strip name
const DEFAULT_NAME = /^(rgb( \d+)?( strips?)?|rgb strip( \d+)?|light strips?( \d+)?|segment( \d+)?|(rgb|light) strip \(gpio \d+\))$/i;
export function customName(segName) {
  const base = String(segName || '').replace(/( [·-] \d+| zone \d+)$/i, '').trim();
  return DEFAULT_NAME.test(base) ? '' : base.slice(0, NAME_MAX);
}

// WLED outputs (/json/cfg hw.led.ins): the RGB strips, then the light strips, each by pin.
// Fields the guide does not ask about are kept when the output keeps its kind.
export function buildOutputs(plan) {
  let start = 0;
  const outputs = rgbOutputs(plan).map(o => {
    const keep = o.bus && !isPwmBus(o.bus) ? o.bus : {};
    const out = { ...keep, start, len: o.count, pin: [o.pin], type: o.type, order: o.order, rev: Boolean(keep.rev), skip: Number(keep.skip) || 0 };
    start += o.count;
    return out;
  });
  lightOutputs(plan).forEach(o => {
    const keep = o.bus && isPwmBus(o.bus) ? o.bus : {};
    // A white light strip has no color order; keep what WLED reports so an unchanged layout stays unchanged
    outputs.push({ ...keep, start, len: 1, pin: [o.pin], type: PWM_WHITE, order: Number(keep.order) || 0, rev: false, skip: 0 });
    start += 1;
  });
  return outputs;
}

// The zone the output had before the guide with exactly this range, if any
const originalZone = (o, r) => o.orig.find(z => z.start === r.start && z.stop === r.stop) || null;

// WLED segments with what each belongs to: { o, zone, range, seg } per RGB strip zone, then { o, light: true, seg } per
// light strip. whole: one segment per RGB strip, as the light tests use. offsets: keep the effect start ("of") of
// zones whose range did not change (the guide doesn't edit it; the advanced editor does).
export function layout(plan, { whole = false, offsets = false } = {}) {
  const entries = [];
  let base = 0;
  rgbOutputs(plan).forEach(o => {
    const ranges = whole ? [{ start: 0, stop: o.count }] : rangesFromCuts(o.count, o.cuts);
    const label = outputLabel(plan, o);
    ranges.forEach((r, zone) => {
      const of = offsets ? (originalZone(o, r)?.of || 0) % (r.stop - r.start) : 0;
      entries.push({ o, zone, range: r, seg: {
        n: ranges.length === 1 ? label : `${label} - ${zone + 1}`,
        start: base + r.start, stop: base + r.stop, of, on: true, frz: false
      } });
    });
    base += o.count;
  });
  lightOutputs(plan).forEach(o => {
    entries.push({ o, light: true, seg: { n: outputLabel(plan, o), start: base, stop: base + 1, on: true, frz: false } });
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

// The segments saved on Apply. WLED stores them as preset 1, which plays when no game is running and at startup.
// In the Flow Matrix the RGB strips' idle look is replaced by their profile's right after Apply.
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

// The parts of an output WLED rebuilds its LEDs for; other fields (current limits etc.) don't matter here.
// Two layouts with the same key need no LED rewrite (writing outputs can make WLED reboot).
// A white light strip's color order means nothing, so it is left out.
export function layoutKey(outputs) {
  return JSON.stringify((outputs || []).map(o => [Number(o.start) || 0, Number(o.len) || 0, Number(firstPin(o)), Number(o.type),
    isPwmBus(o) ? 0 : Number(o.order) || 0, Boolean(o.rev), Number(o.skip) || 0]));
}

// The idle look saved on Apply (the guide does not ask): rainbow, unless the controller's preset 1 already holds a look the guide knows
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
  const strip = segs.find(s => !isLight(s));
  if (strip) {
    const look = strip.on === false ? 'off' : LOOK_BY_FX[Number(strip.fx)];
    if (look) {
      idle.look = look;
      idle.bri = briToPercent(strip.bri) || 100;
      idle.color = toHex(strip.col?.[0]) || idle.color;
    }
  }
  return idle;
}

let nextId = 0;
function newOutput(kind, pin, bus = null) {
  return {
    id: `o${nextId++}`, kind, pin,
    count: kind === 'rgb' ? (Number(bus?.len) || 30) : 1,
    type: kind === 'rgb' ? (bus && !isPwmBus(bus) ? Number(bus.type) || WS281X : WS281X) : PWM_WHITE,
    // A new strip starts as GRB, the order most WS281x strips use
    order: bus && !isPwmBus(bus) ? Number(bus.order) || 0 : 0,
    bus, name: '', cuts: [], orig: [], profiles: {}, colors: 'ask', colorStep: 'R', track: 0
  };
}

function planFromLive(ip, live, preset) {
  const buses = Array.isArray(live?.hw_ins) ? live.hw_ins : [];
  const segs = (Array.isArray(live?.state?.seg) ? live.state.seg : []).filter(s => Number(s?.stop) > Number(s?.start));
  const outputs = buses.filter(b => validPin(Number(firstPin(b)))).map(bus => {
    const o = newOutput(isPwmBus(bus) ? 'light' : 'rgb', Number(firstPin(bus)), bus);
    const base = Number(bus.start) || 0;
    const len = Number(bus.len) || 1;
    const inside = segs.filter(s => Number(s.start) >= base && Number(s.stop) <= base + len).sort((a, b) => Number(a.start) - Number(b.start));
    o.orig = inside.map(s => ({ start: Number(s.start) - base, stop: Number(s.stop) - base, of: Math.max(0, Number(s.of) || 0), id: s.id }));
    // Today's zones when they cover the strip end to end without gaps; else the whole strip
    const tiles = o.orig.length > 1 && o.orig[0].start === 0 && o.orig[o.orig.length - 1].stop === len
      && o.orig.every((z, i) => i === 0 || z.start === o.orig[i - 1].stop);
    if (o.kind === 'rgb' && tiles) o.cuts = o.orig.slice(1).map(z => z.start);
    o.name = customName(inside[0]?.n);
    return o;
  });
  const arch = String(live?.info?.arch || 'esp32').toLowerCase();
  const pins = [...new Set([...(PINS_BY_ARCH[arch] || PINS_BY_ARCH.esp32), ...outputs.map(o => o.pin)])].sort((a, b) => a - b);
  return {
    ip,
    name: live?.name || 'WLED Controller',
    pins,
    outputs: outputs.length ? outputs : [newOutput('rgb', pins.includes(16) ? 16 : pins[0])],
    idle: idleFromPreset(preset, buses)
  };
}

function svg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

const xIcon = () => {
  const root = svg('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4, 'aria-hidden': 'true' });
  root.append(svg('path', { d: 'M5 5l14 14M19 5L5 19' }));
  return root;
};
const checkIcon = () => {
  const root = svg('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 3, 'aria-hidden': 'true' });
  root.append(svg('path', { d: 'M20 6 9 17l-5-5' }));
  return root;
};
const arrowIcon = () => {
  const root = svg('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.6, 'aria-hidden': 'true' });
  root.append(svg('path', { d: 'M5 12h14M13 6l6 6-6 6' }));
  return root;
};

// Fewer than all LEDs drawn when a strip is long: each drawn LED then stands for a few real ones
const MAX_DRAWN = 240;
function buckets(total) {
  const n = Math.max(1, Math.min(total, MAX_DRAWN));
  return Array.from({ length: n }, (_, b) => ({ from: Math.floor((b * total) / n), to: Math.floor(((b + 1) * total) / n) }));
}

// Opens the guide for a controller. Resolves { name, hw_ins, seg, profiles } when the user applies it,
// { skip: true } to keep WLED's own setup, or null.
export async function runControllerSetup(ip, live) {
  const [preset, overview] = await Promise.all([
    api.get(`/api/wled/preset?ip=${encodeURIComponent(ip)}`, { timeout: 4000 }).catch(() => null),
    api.get('/api/flow/overview', { timeout: 4000 }).catch(() => null)
  ]);
  const plan = planFromLive(ip, live, preset);
  const original = { hw_ins: structuredClone(live?.hw_ins || []), state: structuredClone(live?.state || {}) };
  // Flow Matrix profiles a zone can play; none in the legacy Event Matrix
  const flowMode = appStore.get().lightingMode !== 'matrix';
  const profileNames = flowMode ? (overview?.profiles || []).map(p => p.name) : [];
  const savedProfiles = Object.fromEntries(((overview?.lights || []).find(d => d.ip === ip)?.segments || [])
    .map(s => [String(s.id ?? 0), s.profile]));
  const defaultProfile = overview?.default || profileNames[0] || '';

  let stepIndex = 0;
  let touched = false;      // a light test changed the controller's layout
  const originalLayout = layoutKey(original.hw_ins);
  let sentOutputs = originalLayout;
  let testTimer = null;
  let queue = Promise.resolve();
  let selectedCut = null;   // the split line picked in the Zones step
  const lightAnswers = {};  // per light strip: 'no' after "No, it doesn't blink"

  return new Promise(resolve => {
    const progress = h('ol', { class: 'sf-progress', 'aria-label': 'Steps' });
    const body = h('div', { class: 'sf-body' });
    // Toasts render under the modal, so the guide reports its own errors
    const status = h('p', { class: 'sf-status', role: 'alert', hidden: true });
    const backBtn = h('button', { class: 'ui-btn ui-btn-quiet sf-back', type: 'button', onclick: back }, 'Back');
    const nextLabel = h('span', {}, 'Next');
    const nextBtn = h('button', { class: 'ui-btn ui-btn-primary sf-next', type: 'button', onclick: next }, nextLabel, arrowIcon());
    const cancelBtn = h('button', { class: 'ui-btn ui-btn-quiet sf-cancel', type: 'button', 'aria-label': 'Cancel the setup and restore the controller', title: 'Cancel', onclick: () => close(null) }, xIcon());
    const dialog = h('dialog', { class: 'sf-dialog', 'aria-label': `Set up ${plan.name}` },
      h('div', { class: 'sf-frame' },
        h('div', { class: 'sf-top' }, progress, cancelBtn),
        body,
        status,
        h('div', { class: 'sf-foot' }, backBtn, h('span', { class: 'sf-spacer' }), nextBtn)));
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      close(null);
    });

    // Each RGB strip has two screens, its length and colors, then its zones; the name comes after the zones.
    // A light strip has one. The step bar shows one segment per strip (its group).
    const steps = () => [
      { kind: 'plug', group: 'plug', title: 'Plug in' },
      ...sortedOutputs(plan).flatMap(o => (o.kind === 'rgb'
        ? [{ kind: 'rgb', o, group: o.id, title: outputLabel(plan, o) }, { kind: 'zones', o, group: o.id, title: outputLabel(plan, o) }]
        : [{ kind: 'light', o, group: o.id, title: outputLabel(plan, o) }])),
      { kind: 'done', group: 'done', title: 'Done' }
    ];
    const current = () => steps()[Math.min(stepIndex, steps().length - 1)];

    // --- Light tests ---------------------------------------------------------

    function preview(state) {
      // One request at a time, in order: a later test must not land before an earlier one
      queue = queue.then(() => send(state));
      return queue;
    }

    async function send(state) {
      const outputs = buildOutputs(plan);
      const key = layoutKey(outputs);
      status.hidden = true;
      try {
        await api.post('/api/wled/setup-preview', { ip, hw_ins: key === sentOutputs ? null : outputs, state }, { timeout: 8000 });
        sentOutputs = key;
        touched = true;
        return true;
      } catch (err) {
        status.textContent = err?.code === 'DEVICE_UNREACHABLE'
          ? `${err.message}. Check that it is powered and on the network.`
          : (err?.message || 'The light test failed.');
        status.hidden = false;
        return false;
      }
    }

    const later = (fn, ms = 300) => {
      clearTimeout(testTimer);
      testTimer = setTimeout(fn, ms);
    };

    const allOff = (match, lit) => ({ on: true, bri: 110, transition: 0, seg: layout(plan, { whole: true }).map(e => (match(e) ? lit(e) : { ...e.seg, on: false })) });

    // The whole strip in the test colour (red, then green; red again once set) and the last LED white, on this RGB strip only
    function showPattern(o) {
      const last = o.count - 1;
      const color = TEST_HEX[o.colorStep] || TEST_HEX.R;
      const i = last > 0 ? [0, last, color, last, 'FFFFFF'] : [0, color];
      return preview(allOff(e => e.o === o, e => ({ ...e.seg, fx: 0, col: [[0, 0, 0], [0, 0, 0]], i })));
    }

    // This light strip blinking white (WLED effect 1); everything else off
    const blink = o => preview(allOff(e => e.o === o, e => ({ ...e.seg, bri: 255, fx: 1, sx: 128, ix: 128, col: [[255, 255, 255], [0, 0, 0]] })));

    // Every zone of this RGB strip in its own color, as the screen shows it; everything else off
    const showZones = o => preview({ on: true, bri: 110, transition: 0, seg: layout(plan).map(e => (e.o === o
      ? { ...e.seg, fx: 0, col: [rgb(ZONE_COLORS[e.zone % ZONE_COLORS.length]), [0, 0, 0]] }
      : { ...e.seg, on: false })) });

    const showIdle = () => preview({ on: true, bri: 255, transition: 0, seg: idleSegments(plan) });

    function enter(step) {
      clearTimeout(testTimer);
      if (step.kind === 'rgb') showPattern(step.o);
      else if (step.kind === 'light') blink(step.o);
      else if (step.kind === 'zones') showZones(step.o);
      else if (step.kind === 'done') showIdle();
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
      clearTimeout(testTimer);
      await queue.catch(() => {});
      if ((!result || result.skip) && touched) {
        cancelBtn.disabled = true;
        nextBtn.disabled = true;
        nextLabel.textContent = 'Restoring…';
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

    // --- Navigation ------------------------------------------------------------

    function go(index) {
      stepIndex = clamp(index, 0, steps().length - 1);
      render();
      enter(current());
    }

    function back() {
      if (stepIndex === 0) close({ skip: true });
      else go(stepIndex - 1);
    }

    async function next() {
      const step = current();
      if (step.kind === 'plug') {
        if (!plan.outputs.length) {
          showStatus('Tap a pin to add the strip that is plugged into it.');
          return;
        }
        go(stepIndex + 1);
      } else if (step.kind === 'rgb') {
        go(stepIndex + 1);
      } else if (step.kind === 'zones' || step.kind === 'light') {
        // The strip is done: name it, then on to the next one
        if (await askName(step.o)) go(stepIndex + 1);
      } else {
        close({ name: plan.name, hw_ins: buildOutputs(plan), seg: idleSegments(plan), profiles: profileChoices() });
      }
    }

    function showStatus(text) {
      status.textContent = text;
      status.hidden = false;
    }

    function render() {
      const list = steps();
      stepIndex = Math.min(stepIndex, list.length - 1);
      const step = list[stepIndex];
      const state = i => (i < stepIndex ? 'done' : i === stepIndex ? 'current' : 'todo');
      const groups = [...new Set(list.map(s => s.group))].map(group => list.map((s, i) => ({ s, i })).filter(x => x.s.group === group));
      progress.replaceChildren(...groups.map(parts => {
        const first = parts[0].i;
        const here = parts.some(p => p.i === stepIndex);
        return h('li', {},
          h('button', {
            class: 'sf-seg', type: 'button', 'aria-current': here ? 'step' : null,
            dataset: { state: here ? 'current' : first < stepIndex ? 'done' : 'todo' },
            // Strips ahead open once the ones before them are done
            disabled: first > stepIndex,
            onclick: () => go(first)
          },
          // An RGB strip's bar has a part per screen: length and colors, then zones
          h('span', { class: 'sf-seg-bar' }, ...parts.map(p => h('span', { dataset: { state: state(p.i) } }))),
          h('span', { class: 'sf-seg-label' }, parts[0].s.title)));
      }));
      backBtn.textContent = stepIndex === 0 ? 'Keep current setup' : 'Back';
      backBtn.title = stepIndex === 0 ? 'Close the guide and leave the controller as it is' : '';
      nextLabel.textContent = step.kind === 'done' ? `Apply to ${plan.name}` : 'Next';
      status.hidden = true;
      const views = { plug: plugView, rgb: stripView, light: lightView, zones: zonesView, done: doneView };
      body.replaceChildren(...views[step.kind](step.o).filter(Boolean));
      body.scrollTop = 0;
    }

    // --- 1 · Plug in: the board's pins, wires to the strips ---------------------

    const PIN_H = 24;
    const TOP = 20;
    const CARD_GAP = 92;
    const CARD_H = 76;

    function plugView() {
      const outputs = sortedOutputs(plan);
      const used = new Map(outputs.map(o => [o.pin, o]));
      const height = Math.max(TOP + plan.pins.length * PIN_H + 12, TOP + outputs.length * CARD_GAP + 8);
      const board = h('div', { class: 'sf-board', role: 'group', 'aria-label': `${plan.name} and what is plugged into it` });
      board.style.height = `${height}px`;

      board.append(h('div', { class: 'sf-chip' },
        h('span', { class: 'sf-chip-name' }, plan.name),
        h('span', { class: 'sf-chip-arch' }, String(live?.info?.arch || 'ESP32').toUpperCase())));

      const wires = svg('svg', { class: 'sf-wires', width: 400, height, 'aria-hidden': 'true' });
      outputs.forEach((o, j) => {
        const y1 = TOP + plan.pins.indexOf(o.pin) * PIN_H + 9;
        const y2 = TOP + j * CARD_GAP + CARD_H / 2;
        const d = `M157 ${y1} C 290 ${y1}, 270 ${y2}, 400 ${y2}`;
        wires.append(svg('path', { d, class: 'sf-wire-glow', 'data-kind': o.kind }), svg('path', { d, class: 'sf-wire', 'data-kind': o.kind }));
      });
      board.append(wires);

      plan.pins.forEach((pin, i) => {
        const o = used.get(pin);
        const y = TOP + i * PIN_H;
        const label = h('span', { class: 'sf-pin-label', dataset: { used: String(Boolean(o)) } }, String(pin));
        label.style.top = `${y}px`;
        const pad = h('button', {
          class: 'sf-pad', type: 'button', dataset: { kind: o ? o.kind : 'free' },
          'aria-label': o ? `GPIO ${pin}: ${outputLabel(plan, o)}` : `GPIO ${pin} is free. Add a strip here`,
          title: o ? `GPIO ${pin}: ${outputLabel(plan, o)}` : `GPIO ${pin}: add a strip`,
          // A used pin has its strip next to it; tapping a free pin plugs a new RGB strip into it
          disabled: Boolean(o),
          onclick: () => {
            plan.outputs.push(newOutput('rgb', pin));
            render();
          }
        });
        pad.style.top = `${y + 2}px`;
        board.append(label, pad);
      });

      outputs.forEach((o, j) => board.append(plugCard(o, j, used)));

      return [
        h('div', { class: 'sf-head' },
          h('h2', { class: 'sf-title' }, 'What\'s plugged in?'),
          h('span', { class: 'sf-hint' }, h('span', { class: 'sf-hint-pad', 'aria-hidden': 'true' }), 'Tap a free pin to add a strip')),
        h('div', { class: 'sf-board-wrap' }, board)
      ];
    }

    function plugCard(o, j, used) {
      const kindBtn = (kind, label, title) => h('button', {
        class: 'sf-kind', type: 'button', 'aria-pressed': String(o.kind === kind), title, dataset: { kind },
        onclick: () => {
          if (o.kind === kind) return;
          o.kind = kind;
          o.type = kind === 'rgb' ? (o.bus && !isPwmBus(o.bus) ? Number(o.bus.type) || WS281X : WS281X) : PWM_WHITE;
          o.count = kind === 'rgb' ? (o.bus && !isPwmBus(o.bus) ? Number(o.bus.len) || 30 : 30) : 1;
          o.cuts = [];
          render();
        }
      }, h('span', { class: 'sf-kind-glyph', 'aria-hidden': 'true' }), label);
      const pinSelect = h('select', {
        class: 'sf-card-pin', 'aria-label': `Pin of ${outputLabel(plan, o)}`,
        onchange: event => {
          o.pin = Number(event.target.value);
          render();
        }
      }, ...plan.pins.filter(p => p === o.pin || !used.has(p)).map(p => h('option', { value: p, selected: p === o.pin }, `GPIO ${p}`)));
      const card = h('div', { class: 'sf-card' },
        h('span', { class: 'sf-glyph', dataset: { kind: o.kind }, 'aria-hidden': 'true' }),
        h('span', { class: 'sf-card-text' }, h('span', { class: 'sf-card-name' }, outputLabel(plan, o)), pinSelect),
        h('span', { class: 'sf-kinds', role: 'group', 'aria-label': 'Strip type' },
          kindBtn('rgb', 'RGB', 'RGB strip (WS281x): every LED its own color'),
          kindBtn('light', 'White', 'Light strip: one color, dimming only')),
        h('button', {
          class: 'ui-btn ui-btn-quiet sf-icon-btn', type: 'button', 'aria-label': `Remove ${outputLabel(plan, o)}`, title: 'Remove',
          onclick: () => {
            plan.outputs.splice(plan.outputs.indexOf(o), 1);
            render();
          }
        }, xIcon()));
      card.style.top = `${TOP + j * CARD_GAP}px`;
      return card;
    }

    // --- 2 · An RGB strip: drag to the last LED, pick the colors you see -----------

    function stripView(o) {
      if (!o.track) o.track = Math.max(60, Math.ceil((o.count + 15) / 20) * 20);
      const countInput = h('input', {
        class: 'sf-count', type: 'number', inputmode: 'numeric', min: 1, max: MAX_LEDS, value: o.count, 'aria-label': 'Number of LEDs',
        oninput: event => {
          const n = parseInt(event.target.value, 10);
          if (n >= 1 && n <= MAX_LEDS) setCount(n, { grow: true });
        },
        onchange: event => { event.target.value = o.count; }
      });
      const track = h('div', { class: 'sf-track' });
      const handleNum = h('span', {}, String(o.count));
      const handle = h('button', {
        class: 'sf-handle', type: 'button', 'aria-label': `Last LED: ${o.count}. Drag it, or use the arrow keys.`,
        onkeydown: event => {
          const step = { ArrowLeft: -1, ArrowRight: 1, PageDown: -10, PageUp: 10 }[event.key];
          if (!step) return;
          event.preventDefault();
          setCount(o.count + step, { grow: true });
        }
      }, h('span', { class: 'sf-handle-pill' }, handleNum), h('span', { class: 'sf-handle-tip', 'aria-hidden': 'true' }));
      const slots = h('div', { class: 'sf-slots' });
      track.append(handle, slots);

      // The LED under the pointer becomes the last one
      const countFromX = x => {
        const r = slots.getBoundingClientRect();
        return clamp(Math.floor(((x - r.left) / r.width) * o.track) + 1, 1, o.track);
      };
      handle.addEventListener('pointerdown', event => {
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        handle.dataset.dragging = 'true';
      });
      handle.addEventListener('pointermove', event => {
        if (handle.dataset.dragging) setCount(countFromX(event.clientX));
      });
      const drop = () => {
        if (!handle.dataset.dragging) return;
        delete handle.dataset.dragging;
        // Near the end of the drawn strip: draw more LEDs to drag into
        if (o.count > o.track - 5) setCount(o.count, { grow: true });
      };
      handle.addEventListener('pointerup', drop);
      handle.addEventListener('pointercancel', drop);
      // Tapping an LED makes it the last one
      slots.addEventListener('click', event => setCount(countFromX(event.clientX), { grow: true }));

      function drawTrack() {
        const parts = buckets(o.track);
        slots.replaceChildren(...parts.map(({ from, to }) => {
          const has = led => led >= from && led < to;
          let tone = from >= o.count ? 'ghost' : o.colorStep === 'G' ? 'g' : 'r';
          if (from < o.count && has(o.count - 1) && o.count > 1) tone = 'end';
          return h('span', { class: 'sf-led', dataset: { tone } });
        }));
        handle.style.left = `${((o.count - 0.5) / o.track) * 100}%`;
        handleNum.textContent = String(o.count);
        handle.setAttribute('aria-label', `Last LED: ${o.count}. Drag it, or use the arrow keys.`);
        if (document.activeElement !== countInput) countInput.value = o.count;
        // The number is as wide as its digits, so "LEDs" sits right after it
        countInput.style.width = `${String(o.count).length + 0.5}ch`;
      }

      function setCount(n, { grow = false } = {}) {
        n = clamp(n, 1, MAX_LEDS);
        const changed = n !== o.count;
        o.count = n;
        // New length, new zones: the old split points may not fit any more
        if (changed) o.cuts = o.cuts.filter(c => c < n);
        if (grow && n > o.track - 5) o.track = Math.min(MAX_LEDS, Math.ceil((n + 15) / 20) * 20);
        drawTrack();
        if (changed) later(() => showPattern(o), 350);
      }

      drawTrack();
      return [
        h('div', { class: 'sf-head' },
          h('h2', { class: 'sf-title' }, outputLabel(plan, o)),
          h('span', { class: 'sf-tag' }, `GPIO ${o.pin}`)),
        h('section', { class: 'sf-stage', 'aria-label': 'Length' },
          h('div', { class: 'sf-stage-row' },
            countInput,
            h('span', { class: 'sf-unit' }, 'LEDs'),
            h('span', { class: 'sf-nudge' },
              h('button', { class: 'ui-btn sf-icon-btn', type: 'button', 'aria-label': 'One LED less', onclick: () => setCount(o.count - 1, { grow: true }) }, '−'),
              h('button', { class: 'ui-btn sf-icon-btn', type: 'button', 'aria-label': 'One LED more', onclick: () => setCount(o.count + 1, { grow: true }) }, '+')),
            h('span', { class: 'sf-spacer' }),
            h('span', { class: 'sf-hint-plain' }, h('span', { class: 'sf-white-led', 'aria-hidden': 'true' }), 'Drag the marker to your last LED')),
          track),
        colorsView(o, drawTrack)
      ];
    }

    // Two questions while the whole strip is red, then green. Position never matters, so a strip mounted
    // the other way round (counterclockwise) cannot swap red and blue.
    function colorsView(o, redraw) {
      const box = h('section', { class: 'sf-colors', 'aria-label': 'Colors' });
      let note = '';
      let seenRed = null;
      const show = () => { redraw(); showPattern(o); paint(); };
      const pick = seen => {
        if (o.colorStep === 'R') {
          seenRed = seen;
          o.colorStep = 'G';
          note = '';
          show();
          return;
        }
        // What the strip showed for red and green tells its real color order
        const sentBefore = o.order;
        const order = deriveColorOrder(o.order, seenRed, seen);
        if (order === null) {
          note = 'Both looked the same. Once more: what colour is it now?';
          o.colorStep = 'R';
          show();
          return;
        }
        o.order = order;
        o.colors = 'ok';
        o.colorStep = 'done';
        note = order === sentBefore ? '' : 'Colour order corrected.';
        show();
      };
      const paint = () => {
        const done = o.colorStep === 'done';
        box.dataset.state = done ? 'ok' : note ? 'fixed' : 'ask';
        box.replaceChildren(
          h('div', { class: 'sf-colors-text' },
            h('h3', {}, done ? 'Colors set' : 'What colour is your strip?'),
            h('span', { class: 'sf-colors-sub' }, done
              ? `${note ? `${note} ` : ''}It should be red now.`
              : note || (o.colorStep === 'R' ? '1 of 2 · any LED except the white one' : '2 of 2 · it changed colour'))),
          done
            ? h('button', { class: 'ui-btn', type: 'button', onclick: () => { o.colorStep = 'R'; o.colors = 'ask'; note = ''; show(); } }, 'Check again')
            : h('div', { class: 'sf-tiles' }, ...COLOR_CHOICES.map(c => h('button', {
              class: 'sf-tile sf-swatch', type: 'button', 'aria-label': `My strip is ${COLOR_WORDS[c]}`,
              onclick: () => pick(c)
            }, (() => { const dot = h('span', { class: 'sf-dot' }); dot.style.setProperty('--c', HEX[c]); return dot; })(),
            h('span', { class: 'sf-swatch-label' }, COLOR_WORDS[c])))));
      };
      paint();
      return box;
    }

    // --- A light strip: is it blinking? ------------------------------------------

    function lightView(o) {
      const answer = lightAnswers[o.id];
      return [
        h('div', { class: 'sf-head' },
          h('h2', { class: 'sf-title' }, 'Is it blinking?'),
          h('span', { class: 'sf-tag' }, `${outputLabel(plan, o)} · GPIO ${o.pin}`)),
        h('section', { class: 'sf-stage sf-stage-light', 'aria-label': 'Light strip' },
          h('span', { class: 'sf-lightbar', 'aria-hidden': 'true' })),
        h('div', { class: 'sf-answers' },
          h('button', { class: 'ui-btn ui-btn-primary sf-big', type: 'button', onclick: async () => {
            delete lightAnswers[o.id];
            if (await askName(o)) go(stepIndex + 1);
          } }, checkIcon(), 'Yes, it blinks'),
          h('button', { class: 'ui-btn sf-big', type: 'button', onclick: () => {
            lightAnswers[o.id] = 'no';
            render();
          } }, 'No')),
        answer === 'no' && h('div', { class: 'sf-warn' },
          `Check the wire on GPIO ${o.pin}`,
          h('button', { class: 'ui-btn', type: 'button', onclick: () => go(0) }, 'Change pin'))
      ];
    }

    // --- Name it: the pop-up after each strip ------------------------------------------

    function askName(o) {
      return new Promise(done => {
        const input = h('input', {
          class: 'ui-input sf-name-input', type: 'text', maxlength: NAME_MAX, value: o.name, placeholder: plainLabel(plan, o),
          'aria-label': 'Strip name', autocomplete: 'off'
        });
        const ok = () => finish(true);
        const finish = result => {
          if (result) o.name = input.value.trim().slice(0, NAME_MAX);
          pop.close();
          pop.remove();
          done(result);
        };
        input.addEventListener('keydown', event => {
          if (event.key === 'Enter') {
            event.preventDefault();
            ok();
          }
        });
        // The strip as it is now: one bar, or a piece per zone in the zone colors
        const zones = o.kind === 'rgb' ? rangesFromCuts(o.count, o.cuts) : [];
        const bar = h('span', { class: 'sf-name-bar', dataset: { kind: o.kind, zones: String(zones.length > 1) }, 'aria-hidden': 'true' },
          ...(zones.length > 1 ? zones.map((r, i) => {
            const piece = h('span', {});
            piece.style.setProperty('--c', ZONE_COLORS[i % ZONE_COLORS.length]);
            piece.style.flexGrow = String(r.stop - r.start);
            return piece;
          }) : []));
        const pop = h('dialog', { class: 'ui-dialog sf-name', 'aria-labelledby': 'sfNameTitle' },
          h('div', { class: 'sf-name-top' }, bar),
          h('div', { class: 'sf-name-body' },
            h('h2', { class: 'sf-name-title', id: 'sfNameTitle' }, 'Name it'),
            input,
            h('div', { class: 'sf-ideas' }, ...NAME_IDEAS[o.kind].map(idea => h('button', {
              class: 'sf-idea', type: 'button',
              onclick: () => {
                input.value = idea;
                input.focus();
              }
            }, idea))),
            h('div', { class: 'sf-name-actions' },
              h('button', { class: 'ui-btn ui-btn-quiet', type: 'button', onclick: () => finish(false) }, 'Back'),
              h('button', { class: 'ui-btn ui-btn-primary', type: 'button', onclick: ok }, 'OK'))));
        pop.addEventListener('cancel', event => {
          event.preventDefault();
          finish(false);
        });
        dialog.append(pop);
        pop.showModal();
        input.focus();
        input.select();
      });
    }

    // --- Zones: split one RGB strip -------------------------------------------------------

    function zoneProfile(o, r) {
      const key = `${r.start}-${r.stop}`;
      if (o.profiles[key]) return o.profiles[key];
      const was = originalZone(o, r) || (r.start === 0 ? o.orig[0] : null);
      return (was && savedProfiles[String(was.id)]) || defaultProfile;
    }

    // The profile per new segment, for the caller to assign once the layout is on the controller
    function profileChoices() {
      if (!profileNames.length) return [];
      return layout(plan).filter(e => !e.light).map(e => ({ segment_id: e.seg.id, name: zoneProfile(e.o, e.range) }));
    }

    function zonesView(o) {
      const box = h('section', { class: 'sf-stage sf-stage-zones', 'aria-label': 'Zones' });
      const evens = h('div', { class: 'sf-evens', role: 'group', 'aria-label': 'Equal zones' });
      const split = h('div', { class: 'sf-split' });
      const leds = h('div', { class: 'sf-split-leds' });
      const ghost = h('span', { class: 'sf-ghost', 'aria-hidden': 'true', hidden: true });
      const grips = h('div', { class: 'sf-grips' });
      const labels = h('div', { class: 'sf-zone-labels' });
      split.append(leds, ghost, grips);

      const ledAt = x => {
        const r = leds.getBoundingClientRect();
        return clamp(Math.round(((x - r.left) / r.width) * o.count), 1, o.count - 1);
      };
      const zonesNow = () => rangesFromCuts(o.count, o.cuts);
      const changed = () => {
        drawZones();
        later(() => showZones(o), 250);
      };

      split.addEventListener('pointermove', event => {
        if (event.target.closest('.sf-grip, .sf-cut-remove') || o.count < 2) {
          ghost.hidden = true;
          return;
        }
        ghost.hidden = false;
        ghost.style.left = `${(ledAt(event.clientX) / o.count) * 100}%`;
      });
      split.addEventListener('pointerleave', () => { ghost.hidden = true; });
      // Tap between two LEDs: a new split there
      split.addEventListener('click', event => {
        if (event.target.closest('.sf-grip, .sf-cut-remove') || o.count < 2) return;
        const at = ledAt(event.clientX);
        if (o.cuts.includes(at) || zonesNow().length >= MAX_ZONES) return;
        o.cuts = [...o.cuts, at].sort((a, b) => a - b);
        selectedCut = at;
        drawGrips();
        changed();
      });

      function moveCut(from, to) {
        const sorted = o.cuts.slice().sort((a, b) => a - b);
        const j = sorted.indexOf(from);
        const lo = (j > 0 ? sorted[j - 1] : 0) + 1;
        const hi = (j < sorted.length - 1 ? sorted[j + 1] : o.count) - 1;
        const v = clamp(to, lo, hi);
        if (v === from) return from;
        o.cuts = sorted.map(c => (c === from ? v : c));
        if (selectedCut === from) selectedCut = v;
        return v;
      }

      function removeCut(at) {
        o.cuts = o.cuts.filter(c => c !== at);
        selectedCut = null;
        drawGrips();
        changed();
      }

      function drawGrips() {
        grips.replaceChildren(...o.cuts.slice().sort((a, b) => a - b).map(cut => {
          let at = cut;
          const grip = h('button', {
            class: 'sf-grip', type: 'button', 'aria-pressed': String(selectedCut === at),
            'aria-label': `Split between LED ${at} and ${at + 1}. Drag or use the arrow keys to move it, Delete removes it.`,
            onclick: () => {
              selectedCut = at;
              drawGrips();
              grips.querySelector('[aria-pressed="true"]')?.focus();
            },
            onkeydown: event => {
              const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
              if (step) {
                event.preventDefault();
                at = moveCut(at, at + step);
                selectedCut = at;
                drawGrips();
                changed();
                grips.querySelector('[aria-pressed="true"]')?.focus();
              } else if (event.key === 'Delete' || event.key === 'Backspace') {
                event.preventDefault();
                removeCut(at);
              }
            }
          }, h('span', { class: 'sf-grip-dot' }), h('span', { class: 'sf-grip-line' }));
          grip.style.left = `${(at / o.count) * 100}%`;
          grip.addEventListener('pointerdown', event => {
            event.preventDefault();
            grip.setPointerCapture(event.pointerId);
            grip.dataset.dragging = 'true';
            selectedCut = at;
            grip.setAttribute('aria-pressed', 'true');
          });
          grip.addEventListener('pointermove', event => {
            if (!grip.dataset.dragging) return;
            const r = leds.getBoundingClientRect();
            const to = clamp(Math.round(((event.clientX - r.left) / r.width) * o.count), 1, o.count - 1);
            const moved = moveCut(at, to);
            if (moved !== at) {
              at = moved;
              grip.style.left = `${(at / o.count) * 100}%`;
              changed();
            }
          });
          const drop = () => {
            if (!grip.dataset.dragging) return;
            delete grip.dataset.dragging;
            drawGrips();
          };
          grip.addEventListener('pointerup', drop);
          grip.addEventListener('pointercancel', drop);
          const parts = [grip];
          if (selectedCut === at) {
            const remove = h('button', { class: 'sf-cut-remove', type: 'button', 'aria-label': `Remove the split between LED ${at} and ${at + 1}`, title: 'Remove this split', onclick: () => removeCut(at) }, xIcon());
            remove.style.left = grip.style.left;
            parts.push(remove);
          }
          return parts;
        }).flat());
      }

      function drawZones() {
        const ranges = zonesNow();
        const whole = ranges.length === 1;
        const zoneOf = led => ranges.findIndex(r => led >= r.start && led < r.stop);
        leds.replaceChildren(...buckets(o.count).map(({ from }) => {
          const led = h('span', { class: 'sf-led' });
          led.style.setProperty('--c', whole ? '#d4d4d8' : ZONE_COLORS[zoneOf(from) % ZONE_COLORS.length]);
          return led;
        }));
        labels.replaceChildren(...ranges.map((r, i) => {
          const color = whole ? '#d4d4d8' : ZONE_COLORS[i % ZONE_COLORS.length];
          const cell = h('div', { class: 'sf-zone' },
            h('span', { class: 'sf-zone-text' },
              h('span', { class: 'sf-zone-name' }, whole ? 'Whole strip' : `Zone ${i + 1}`),
              h('span', { class: 'sf-zone-range' }, `${r.start + 1}–${r.stop} · ${r.stop - r.start}`)),
            profileNames.length > 0 && h('select', {
              class: 'ui-select ui-select-sm sf-zone-profile', 'aria-label': `Profile for ${whole ? 'the whole strip' : `zone ${i + 1}`}`,
              title: 'Flow Matrix profile this zone plays',
              onchange: event => { o.profiles[`${r.start}-${r.stop}`] = event.target.value; }
            }, ...profileNames.map(name => h('option', { value: name, selected: name === zoneProfile(o, r) }, name))));
          cell.style.setProperty('--c', color);
          cell.style.flexGrow = String(r.stop - r.start);
          return cell;
        }));
        count.textContent = ranges.length === 1 ? 'Whole strip' : `${ranges.length} zones`;
      }

      evens.append(...[1, 2, 3, 4].map(n => {
        const pic = h('span', { class: 'sf-even-pic', 'aria-hidden': 'true' }, ...Array.from({ length: n }, (_, i) => {
          const bar = h('span', {});
          bar.style.setProperty('--c', n === 1 ? '#a1a1aa' : ZONE_COLORS[i]);
          return bar;
        }));
        return h('button', {
          class: 'ui-btn sf-even', type: 'button', 'aria-label': n === 1 ? 'No zones' : `${n} equal zones`, title: n === 1 ? 'Whole strip' : `${n} equal zones`,
          onclick: () => {
            o.cuts = evenCuts(o.count, n);
            selectedCut = null;
            drawGrips();
            changed();
          }
        }, pic);
      }));

      const count = h('span', { class: 'sf-zone-count', 'aria-live': 'polite' });
      drawGrips();
      drawZones();
      box.append(h('div', { class: 'sf-stage-row' }, count, h('span', { class: 'sf-spacer' }), evens), split, labels);
      return [
        h('div', { class: 'sf-head' },
          h('h2', { class: 'sf-title' }, 'Split into zones?'),
          h('span', { class: 'sf-tag' }, `${outputLabel(plan, o)} · GPIO ${o.pin}`),
          h('span', { class: 'sf-spacer' }),
          h('span', { class: 'sf-optional' }, 'Optional')),
        h('span', { class: 'sf-hint sf-hint-row' }, 'Tap between two LEDs to split · drag a line to move it'),
        box
      ];
    }

    // --- Done: everything as it will be ------------------------------------------------

    function doneView() {
      const rows = sortedOutputs(plan).filter(o => validPin(o.pin)).map(o => {
        const chips = [`GPIO ${o.pin}`, ...(o.kind === 'rgb' ? [`${o.count} LEDs`, COLOR_ORDERS[o.order & 0x0f]] : ['white'])];
        let picture;
        if (o.kind === 'light') {
          picture = h('span', { class: 'sf-done-light', 'aria-hidden': 'true' });
        } else {
          const ranges = rangesFromCuts(o.count, o.cuts);
          const whole = ranges.length === 1;
          picture = h('span', { class: 'sf-done-zones' }, ...ranges.map((r, i) => {
            const block = h('span', { class: 'sf-done-zone', dataset: { whole: String(whole) } },
              h('span', { class: 'sf-done-leds' }, ...buckets(Math.min(r.stop - r.start, 60)).map(() => h('span', {}))),
              h('span', { class: 'sf-done-zone-label' }, whole ? 'Whole strip' : `Zone ${i + 1} · ${r.start + 1}–${r.stop}`));
            block.style.setProperty('--c', whole ? '#8e8e98' : ZONE_COLORS[i % ZONE_COLORS.length]);
            block.style.flexGrow = String(r.stop - r.start);
            return block;
          }));
        }
        return h('div', { class: 'sf-done-row' },
          h('span', { class: 'sf-done-name' },
            h('span', {}, outputLabel(plan, o)),
            h('span', { class: 'sf-done-chips' }, ...chips.map(c => h('span', { class: 'sf-chipline' }, c)))),
          picture);
      });
      return [
        h('div', { class: 'sf-head' },
          h('span', { class: 'sf-done-check', 'aria-hidden': 'true' }, checkIcon()),
          h('h2', { class: 'sf-title' }, 'All set')),
        h('section', { class: 'sf-stage sf-done', 'aria-label': 'Result' }, ...rows)
      ];
    }

    document.body.append(dialog);
    render();
    dialog.showModal();
    progress.querySelector('[aria-current="step"]')?.focus();
  });
}
