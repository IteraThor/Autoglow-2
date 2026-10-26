// AutoGlow 2 - Setup › Controllers › guided setup
// Asks in plain words what is wired to a WLED controller and turns the answers into WLED's
// outputs and segments. Light tests write a temporary layout to the controller; Cancel puts
// the controller's own layout back.

import { api } from '../core/api.js';
import { h, showFieldError, clearFieldError } from '../core/dom.js';
import { toast } from '../core/toast.js';

const PWM_WHITE = 41;
const COLOR_ORDERS = ['GRB', 'RGB', 'BRG', 'RBG', 'BGR', 'GBR'];
// Only WS281x for now; more strip types can be added here later
const STRIP_TYPES = [
  { value: 22, label: 'WS281x' }
];
const LIGHT_SEGMENT = 'Light strip';
// Same order as the zone preview, so the strip and the screen show the same colors
const ZONE_COLORS = ['#22d3ee', '#f59e0b', '#a855f7', '#22c55e', '#ef4444', '#3b82f6', '#ec4899', '#eab308', '#14b8a6', '#f97316', '#8b5cf6', '#84cc16'];
const MAX_ZONES = 12;
// WLED's Aurora effect (38) with its own Aurora palette (50): the RGB strip's look once it is set up
const AURORA = { fx: 38, pal: 50, sx: 128, ix: 128 };
const SVG_NS = 'http://www.w3.org/2000/svg';

const isPwmBus = bus => Number(bus?.type) >= 40;
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

// The light strip counts once its pin is known (the RGB strip is tested before the light strip step)
const hasLightStrip = plan => plan.lightStrip && Number.isInteger(plan.lightPin) && plan.lightPin >= 0;

// WLED outputs (/json/cfg hw.led.ins) for the answers. Fields the guide does not ask about are kept.
export function buildOutputs(plan) {
  const outputs = [{
    ...plan.stripBus,
    start: 0,
    len: plan.count,
    pin: [plan.stripPin],
    type: plan.stripType,
    order: plan.order,
    rev: Boolean(plan.stripBus?.rev),
    skip: Number(plan.stripBus?.skip) || 0
  }];
  if (hasLightStrip(plan)) {
    outputs.push({ ...plan.lightBus, start: plan.count, len: 1, pin: [plan.lightPin], type: PWM_WHITE, order: 0, rev: false, skip: 0 });
  }
  return outputs;
}

// How many LEDs after a zone's first LED its effects start (WLED's segment offset "of")
export function zoneOffset(plan, zone, range) {
  return (plan.offsets[zone] || 0) % (range.stop - range.start);
}

// WLED segments: the RGB strip's zones, then the light strip as its own segment. Only the saved layout
// and the idle preview carry the zone offsets; the light tests use none, so their LED numbers are the strip's own.
export function buildSegments(plan, zones = plan.zones, { offsets = false } = {}) {
  const ranges = zoneRanges(plan.count, zones);
  const segs = ranges.map((r, i) => ({ id: i, n: ranges.length === 1 ? 'RGB Strip' : `RGB zone ${i + 1}`, start: r.start, stop: r.stop, of: offsets ? zoneOffset(plan, i, r) : 0, on: true, frz: false }));
  if (hasLightStrip(plan)) segs.push({ id: segs.length, n: LIGHT_SEGMENT, start: plan.count, stop: plan.count + 1, on: true, frz: false });
  return segs;
}

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
  return buildSegments(plan, plan.zones, { offsets: true }).map(s => {
    if (s.n === LIGHT_SEGMENT) {
      return lightBri > 0 ? { ...s, bri: percentToBri(lightBri), fx: 0, col: [[255, 255, 255], [0, 0, 0]] } : { ...s, on: false };
    }
    if (!look.fx) return { ...s, on: false };
    return { ...s, bri: percentToBri(bri), ...look.fx, ...(look.color ? { col: [rgb(color), [0, 0, 0]] } : {}) };
  });
}

export function describeIdle(plan) {
  const { look: lookId, color, bri, lightBri } = plan.idle;
  const look = IDLE_LOOKS.find(l => l.id === lookId) || IDLE_LOOKS[0];
  const parts = [look.fx ? `RGB strip: ${look.label}${look.color ? ` (${color})` : ''}, ${bri}%` : 'RGB strip: off'];
  if (hasLightStrip(plan)) parts.push(`Light strip: ${lightBri > 0 ? `${lightBri}%` : 'off'}`);
  return parts.join('\n');
}

// The parts of an output WLED rebuilds its LEDs for; other fields (current limits etc.) don't matter here
export function layoutKey(outputs) {
  return JSON.stringify((outputs || []).map(o => [Number(o.start) || 0, Number(o.len) || 0, Number(firstPin(o)), Number(o.type), Number(o.order) || 0, Boolean(o.rev), Number(o.skip) || 0]));
}

function planFromLive(ip, live) {
  const buses = Array.isArray(live?.hw_ins) ? live.hw_ins : [];
  const stripBus = buses.find(b => !isPwmBus(b)) || null;
  const lightBus = buses.find(isPwmBus) || null;
  const firstSeg = Array.isArray(live?.state?.seg) ? live.state.seg[0] : null;
  return {
    ip,
    name: live?.name || 'WLED Controller',
    count: Number(stripBus?.len) || 45,
    stripPin: firstPin(stripBus) ?? 16,
    stripType: STRIP_TYPES[0].value,
    order: Number(stripBus?.order) || 0,
    colorsChecked: false,
    lightStrip: Boolean(lightBus),
    lightPin: firstPin(lightBus) ?? '',
    zones: 1,
    // Per zone, the start of its effects as an offset from its first LED; the guide starts with one zone
    offsets: [Math.max(0, Number(firstSeg?.of) || 0)],
    // Defaults match what the guide saved before it asked: Rainbow, everything at 100%
    idle: { look: 'rainbow', color: '#00ff9d', bri: 100, lightBri: 100 },
    stripBus,
    lightBus
  };
}

function svg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

// The RGB strip as a bar from LED 1 to the last LED, colored by zone, with a white mark where each zone's effects start
function stripPreview(plan) {
  const width = 400;
  const gap = 3;
  const root = svg('svg', { class: 'setup-strip', id: 'setupStripPreview', viewBox: `0 0 ${width} 18`, role: 'img', 'aria-label': `RGB strip of ${plan.count} LEDs in ${plan.zones} zone${plan.zones === 1 ? '' : 's'}` });
  zoneRanges(plan.count, plan.zones).forEach((range, zone) => {
    const x = (range.start / plan.count) * width;
    const w = ((range.stop - range.start) / plan.count) * width;
    const first = range.start + zoneOffset(plan, zone, range);
    root.append(
      svg('rect', { x, y: 2, width: Math.max(1, w - gap), height: 14, rx: 3, fill: ZONE_COLORS[zone % ZONE_COLORS.length] }),
      svg('rect', { x: (first / plan.count) * width, y: 0, width: Math.max(3, width / plan.count - 1), height: 18, rx: 1, fill: '#ffffff', stroke: '#000000', 'stroke-width': 0.75 }));
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

function choiceButtons(options, onpick) {
  return h('div', { class: 'setup-choices' }, ...options.map(([value, label, tone]) =>
    h('button', { class: 'ui-btn ui-btn-sm', type: 'button', dataset: tone ? { tone } : {}, onclick: () => onpick(value) }, label)));
}

// Opens the guide for a controller. Resolves { name, hw_ins, seg } when the user applies it, or null.
export function runControllerSetup(ip, live) {
  const plan = planFromLive(ip, live);
  const original = { hw_ins: structuredClone(live?.hw_ins || []), state: structuredClone(live?.state || {}) };
  let stepIndex = 0;
  let touched = false;      // a light test changed the controller's layout
  // The layout the controller has now. Outputs are only sent when they differ: every write makes WLED
  // rebuild its LEDs, which wipes test colors and costs time
  const originalLayout = layoutKey(original.hw_ins);
  let sentOutputs = originalLayout;
  let stripTest = null;      // { kind: 'ends' } or { kind: 'colors', seenForRed, asking }
  let lightTest = null;     // 'on' | 'ok' | 'dark'
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
      { id: 'strip', title: 'RGB strip', render: renderStrip, check: checkStrip },
      plan.lightStrip && { id: 'light', title: 'Light strip', render: renderLight, check: checkLight },
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

    // RGB strip in one color, light strip off
    function stripState(color, extra = {}) {
      const segs = buildSegments(plan, 1);
      segs[0] = { ...segs[0], fx: 0, col: [rgb(color), [0, 0, 0]], ...extra };
      if (segs[1]) segs[1].on = false;
      return { on: true, bri: 110, transition: 0, seg: segs };
    }

    async function close(result) {
      if (dialog.dataset.closing) return;
      dialog.dataset.closing = 'true';
      // A queued idle preview or start LED test must not land after the restore below
      clearTimeout(idleTimer);
      clearTimeout(startTimer);
      if (!result && touched) {
        cancelBtn.textContent = 'Restoring…';
        try {
          const restoreOutputs = sentOutputs !== originalLayout && original.hw_ins.length ? original.hw_ins : null;
          await api.post('/api/wled/setup-preview', { ip, hw_ins: restoreOutputs, state: { on: original.state.on ?? true, bri: original.state.bri ?? 128, seg: (original.state.seg || []).map(s => ({ ...s, frz: false })) } }, { timeout: 8000 });
        } catch (err) {
          toast.warning('Could not restore the controller\'s previous LED layout. Open its WLED page to check it.');
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
      startTest = null;
      if (delta > 0 && step.id === 'review') {
        close({ name: plan.name, hw_ins: buildOutputs(plan), seg: idleSegments(plan) });
        return;
      }
      if (delta > 0 && step.id === 'strip') preview(stripState('#000000', AURORA));
      // Entering the idle step: show the current idle look on the strip
      if (delta > 0 && step.id === 'zones') previewIdle(0);
      stepIndex = Math.max(0, Math.min(list.length - 1, stepIndex + delta));
      render();
    }

    function render() {
      const list = steps();
      stepIndex = Math.min(stepIndex, list.length - 1);
      const step = list[stepIndex];
      progress.replaceChildren(...list.map((s, i) => h('li', { 'aria-current': i === stepIndex ? 'step' : null, dataset: { done: String(i < stepIndex) } }, s.title)));
      backBtn.hidden = stepIndex === 0;
      nextBtn.textContent = step.id === 'review' ? 'Apply to controller' : 'Next';
      status.hidden = true;
      body.replaceChildren(...step.render());
    }

    // --- Step 1: name and what is connected ---
    function renderBasics() {
      const name = h('input', { class: 'ui-input', id: 'setupName', type: 'text', value: plan.name, maxlength: 32, oninput: event => { plan.name = event.target.value; } });
      const light = h('input', { type: 'checkbox', checked: plan.lightStrip, onchange: event => { plan.lightStrip = event.target.checked; render(); } });
      return [
        h('p', { class: 'setup-lead' }, 'A few questions about what is wired to this controller. AutoGlow then sets up WLED for you.'),
        field('What should this controller be called?', name),
        h('fieldset', { class: 'setup-field' },
          h('legend', { class: 'setup-label' }, 'What is connected to it?'),
          h('label', { class: 'setup-check' }, h('input', { type: 'checkbox', checked: true, disabled: true }), h('span', {}, 'A WS281x RGB LED strip (every LED can show its own color)')),
          h('label', { class: 'setup-check' }, light, h('span', {}, 'A regular light strip (one color, only on/off and dimming)')),
          h('small', { class: 'setup-hint' }, 'Ticked from what the controller reports today.')
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

    // --- Step 2: RGB strip ---
    function renderStrip() {
      const count = numberInput(plan.count, { min: 1, max: 1500, onchange: input => {
        plan.count = parseInt(input.value, 10) || 0;
        // Re-light the ends while the user dials the count in
        if (stripTest?.kind === 'ends' && plan.count > 0) debounceEnds();
      } });
      count.id = 'setupCount';
      const stepper = h('div', { class: 'setup-stepper' },
        h('button', { class: 'ui-btn ui-btn-sm', type: 'button', 'aria-label': 'One LED less', onclick: () => bump(-1) }, '−'),
        count,
        h('button', { class: 'ui-btn ui-btn-sm', type: 'button', 'aria-label': 'One LED more', onclick: () => bump(1) }, '+'));
      const pin = numberInput(plan.stripPin, { min: 0, max: 48, onchange: input => { plan.stripPin = parseInt(input.value, 10); } });
      pin.id = 'setupStripPin';
      const type = h('select', { class: 'ui-input', onchange: event => { plan.stripType = Number(event.target.value); } },
        ...STRIP_TYPES.map(t => h('option', { value: t.value, selected: t.value === plan.stripType }, t.label)));
      const order = h('select', { class: 'ui-input', id: 'setupOrder', onchange: event => setOrder(Number(event.target.value)) },
        ...COLOR_ORDERS.map((label, value) => h('option', { value, selected: value === (plan.order & 0x0f) }, label)));

      return [
        field('How many LEDs does the RGB strip have?', stepper),
        h('div', { class: 'setup-row' },
          field('Data pin (GPIO)', pin, 'Filled in from the controller.'),
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
      plan.count = Math.max(1, (parseInt(input.value, 10) || 0) + delta);
      input.value = plan.count;
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
      const last = plan.count - 1;
      // White stays white with any color order, so the two ends can't be mixed up before the color check
      const ok = await preview(stripState('#000000', { i: last === 0 ? [0, 'FFFFFF'] : [0, 'FFFFFF', last, 'FF0000'] }));
      if (ok) {
        stripTest = { kind: 'ends' };
        refreshStripTest();
      }
    }

    // Red, green and blue bands from the start of the strip; the screen shows the same three swatches
    async function testBands() {
      if (busy || !checkStrip()) return;
      const bands = plan.count >= 3 ? zoneRanges(plan.count, 3) : zoneRanges(plan.count, plan.count);
      const i = bands.flatMap((b, n) => [b.start, b.stop, ['FF0000', '00FF00', '0000FF'][n]]);
      if (await preview(stripState('#000000', { i }))) {
        stripTest = { kind: 'bands' };
        refreshStripTest();
      }
    }

    function setOrder(value) {
      plan.order = (plan.order & ~0x0f) | value;
      plan.colorsChecked = false;
      const select = document.getElementById('setupOrder');
      if (select) select.value = String(value);
      // Trying orders one after another: show each one on the strip straight away
      if (stripTest?.kind === 'bands') testBands();
    }

    async function findOrder() {
      if (busy || !checkStrip()) return;
      if (await preview(stripState('#ff0000'))) {
        stripTest = { kind: 'colors', asking: 'red' };
        refreshStripTest();
      }
    }

    async function answerColor(seen) {
      if (stripTest.asking === 'red') {
        if (await preview(stripState('#00ff00'))) {
          stripTest = { kind: 'colors', asking: 'green', seenForRed: seen };
          refreshStripTest();
        }
        return;
      }
      const order = deriveColorOrder(plan.order, stripTest.seenForRed, seen);
      if (order === null) {
        stripTest = { kind: 'colors', result: 'conflict' };
        refreshStripTest();
        return;
      }
      setOrder(order & 0x0f);
      plan.colorsChecked = true;
      // Show red, green, blue on the strip as proof
      await testBands();
    }

    function confirmColors() {
      plan.colorsChecked = true;
      refreshStripTest();
    }

    function refreshStripTest() {
      document.getElementById('setupStripTest')?.replaceWith(stripTestBody());
    }

    function stripTestBody() {
      const box = h('div', { class: 'setup-test-body', id: 'setupStripTest', 'aria-live': 'polite' });
      const verdict = (tone, text) => h('p', { class: 'setup-verdict', dataset: { tone } }, text);
      if (!stripTest) return box;

      if (stripTest.kind === 'ends') {
        if (stripTest.answer === 'ok') {
          box.append(verdict('ok', `✓ ${plan.count} LEDs`));
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
          ...[['#ff0000', 'Red'], ['#00ff00', 'Green'], ['#0000ff', 'Blue']].slice(0, Math.min(3, plan.count))
            .map(([color, label]) => h('span', { class: 'setup-band' }, swatch(color), label))));
        box.append(plan.colorsChecked
          ? verdict('ok', `✓ ${COLOR_ORDERS[plan.order & 0x0f]}`)
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
      const count = document.getElementById('setupCount');
      const pin = document.getElementById('setupStripPin');
      if (!(plan.count >= 1 && plan.count <= 1500)) {
        showFieldError(count, 'Enter a number from 1 to 1500');
        return false;
      }
      if (!Number.isInteger(plan.stripPin) || plan.stripPin < 0) {
        showFieldError(pin, 'Enter the GPIO number');
        return false;
      }
      return true;
    }

    // --- Step 3: light strip ---
    function renderLight() {
      const pin = numberInput(plan.lightPin, { min: 0, max: 48, placeholder: 'e.g. 26', onchange: input => {
        plan.lightPin = input.value === '' ? '' : parseInt(input.value, 10);
        lightTest = null;
      } });
      pin.id = 'setupLightPin';
      const test = h('div', { class: 'setup-test-body', 'aria-live': 'polite' });
      const paint = () => {
        test.replaceChildren(...(!lightTest ? [] : lightTest === 'on' ? [
          h('p', {}, 'Is the light strip blinking?'),
          choiceButtons([['ok', 'Yes', 'ok'], ['dark', 'No']], answer => {
            lightTest = answer;
            paint();
            // Stop blinking once answered; the light stays on
            const segs = buildSegments(plan, 1).map(s => (s.n === LIGHT_SEGMENT ? { ...s, bri: 255, fx: 0, col: [[255, 255, 255], [0, 0, 0]] } : { ...s, ...AURORA }));
            preview({ on: true, bri: 255, transition: 0, seg: segs });
          })
        ] : [h('p', { class: 'setup-verdict', dataset: { tone: lightTest === 'ok' ? 'ok' : 'warn' } },
          lightTest === 'ok' ? '✓ Works' : 'Check the pin and power.')]));
      };
      paint();
      return [
        field('Which pin (GPIO) is the light strip on?', pin),
        h('div', { class: 'setup-test' },
          h('div', { class: 'setup-test-head' },
            h('span', { class: 'setup-label' }, 'Verify live'),
            h('button', { class: 'ui-btn ui-btn-sm', type: 'button', onclick: async () => {
              if (busy || !checkLight()) return;
              // Blink between off and 100%, so it's visible even if the light was already fully on (WLED effect 1 = Blink)
              const segs = buildSegments(plan, 1).map(s => (s.n === LIGHT_SEGMENT ? { ...s, bri: 255, fx: 1, sx: 128, ix: 128, col: [[255, 255, 255], [0, 0, 0]] } : { ...s, ...AURORA }));
              if (await preview({ on: true, bri: 255, transition: 0, seg: segs })) {
                lightTest = 'on';
                paint();
              }
            } }, 'Blink')),
          test)
      ];
    }

    function checkLight() {
      const input = document.getElementById('setupLightPin');
      if (!Number.isInteger(plan.lightPin) || plan.lightPin < 0) {
        showFieldError(input, 'Enter the GPIO number');
        return false;
      }
      if (plan.lightPin === plan.stripPin) {
        showFieldError(input, `GPIO ${plan.stripPin} is the RGB strip's data pin. Each output needs its own pin.`);
        return false;
      }
      return true;
    }

    // --- Step 4: zones ---
    let startTest = null;     // zone whose start LED is lit on the strip
    let startTimer = null;

    function renderZones() {
      const maxZones = Math.min(MAX_ZONES, plan.count);
      const split = plan.zones > 1;
      const zoneCount = numberInput(split ? plan.zones : 4, { min: 2, max: maxZones, onchange: input => {
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
        if (zones !== plan.zones) {
          plan.zones = zones;
          plan.offsets = [];
          startTest = null;
        }
        refreshZones();
      };
      const zonesBox = h('div', { class: 'setup-zones' });
      const refreshZones = () => zonesBox.replaceChildren(stripPreview(plan), zoneList(), startTestBody());
      refreshZones();
      return [
        h('p', { class: 'setup-lead' }, 'Each zone gets its own effects in the Event and Flow matrices, so different parts of the RGB strip can light up differently. Effects start at a zone\'s first LED unless you pick another one; they run to the zone\'s end and continue from its first LED.'),
        h('fieldset', { class: 'setup-field' },
          h('legend', { class: 'setup-label' }, 'How should the RGB strip be used?'),
          h('label', { class: 'setup-check' }, h('input', { type: 'radio', name: 'setupZones', checked: !split, onchange: () => pick(1) }), h('span', {}, 'As one zone (the whole strip)')),
          h('label', { class: 'setup-check' }, h('input', { type: 'radio', name: 'setupZones', checked: split, disabled: maxZones < 2, onchange: () => pick(parseInt(zoneCount.value, 10) || 4) }), h('span', {}, 'Split into equal zones:'), zoneCount),
          h('small', { class: 'setup-hint' }, 'Uneven splits can be made later in the advanced editor.')),
        zonesBox,
        h('div', { class: 'setup-choices' },
          h('button', { class: 'ui-btn ui-btn-sm', type: 'button', onclick: async () => {
            if (busy) return;
            const segs = buildSegments(plan).map((s, i) => (s.n === LIGHT_SEGMENT ? { ...s, on: false } : { ...s, fx: 0, col: [rgb(ZONE_COLORS[i % ZONE_COLORS.length]), [0, 0, 0]] }));
            if (await preview({ on: true, bri: 110, transition: 0, seg: segs })) {
              startTest = null;
              refreshStartTest();
            }
          } }, 'Show the zones on the strip'))
      ];
    }

    function zoneList() {
      const ranges = zoneRanges(plan.count, plan.zones);
      return h('ul', { class: 'setup-zone-list' }, ...ranges.map((r, i) => h('li', {},
        swatch(ZONE_COLORS[i % ZONE_COLORS.length]),
        zoneLabel(ranges, i),
        h('span', { class: 'setup-muted' }, `${humanRange(r)} (${r.stop - r.start})`),
        zoneStart(r, i))));
    }

    const zoneLabel = (ranges, i) => (ranges.length === 1 ? 'Whole strip' : `Zone ${i + 1}`);

    // "Starts at LED" with − and +, counted like the strip (from 1); the buttons wrap around inside the zone
    function zoneStart(range, zone) {
      const len = range.stop - range.start;
      const firstLed = () => range.start + zoneOffset(plan, zone, range) + 1;
      const set = offset => {
        plan.offsets[zone] = ((offset % len) + len) % len;
        input.value = firstLed();
        document.getElementById('setupStripPreview')?.replaceWith(stripPreview(plan));
        clearTimeout(startTimer);
        startTimer = setTimeout(() => testStart(zone), 250);
      };
      const input = numberInput(firstLed(), { min: range.start + 1, max: range.stop, onchange: el => {
        const led = parseInt(el.value, 10);
        if (led >= range.start + 1 && led <= range.stop) set(led - 1 - range.start);
      } });
      input.setAttribute('aria-label', `LED where effects start, ${range.start + 1} to ${range.stop}`);
      // A number outside the zone is not applied; leaving the field shows the start in use again
      input.addEventListener('change', () => { input.value = firstLed(); });
      const step = delta => set(zoneOffset(plan, zone, range) + delta);
      return h('span', { class: 'setup-zone-start' },
        h('span', { class: 'setup-muted' }, 'Starts at LED'),
        h('span', { class: 'setup-stepper' },
          h('button', { class: 'ui-btn ui-btn-sm', type: 'button', 'aria-label': 'Start one LED earlier', disabled: len === 1, onclick: () => step(-1) }, '−'),
          input,
          h('button', { class: 'ui-btn ui-btn-sm', type: 'button', 'aria-label': 'Start one LED later', disabled: len === 1, onclick: () => step(1) }, '+')),
        h('button', { class: 'ui-btn ui-btn-sm', type: 'button', onclick: () => testStart(zone) }, 'Show'));
    }

    // Green on the zone's start LED, red on the LED before and after it (wrapping inside the zone).
    // The other zones stay dark. WLED's "i" counts from the segment's first LED, and the test segments have no offset.
    async function testStart(zone) {
      if (busy) return;
      const range = zoneRanges(plan.count, plan.zones)[zone];
      if (!range) return;
      const len = range.stop - range.start;
      const first = zoneOffset(plan, zone, range);
      const i = [first, '00FF00'];
      if (len > 1) i.push((first + len - 1) % len, 'FF0000', (first + 1) % len, 'FF0000');
      const segs = buildSegments(plan).map((s, n) => (s.n === LIGHT_SEGMENT
        ? { ...s, on: false }
        : { ...s, fx: 0, col: [[0, 0, 0], [0, 0, 0]], ...(n === zone ? { i } : {}) }));
      if (await preview({ on: true, bri: 110, transition: 0, seg: segs })) {
        startTest = zone;
        refreshStartTest();
      }
    }

    function refreshStartTest() {
      document.getElementById('setupStartTest')?.replaceWith(startTestBody());
    }

    function startTestBody() {
      const box = h('div', { class: 'setup-test-body setup-zones-test', id: 'setupStartTest', 'aria-live': 'polite' });
      const ranges = zoneRanges(plan.count, plan.zones);
      if (startTest === null || !ranges[startTest]) return box;
      const r = ranges[startTest];
      box.append(h('p', {}, `${zoneLabel(ranges, startTest)}: green = LED ${r.start + zoneOffset(plan, startTest, r) + 1}, where effects start, with a red LED on each side. Use − and + until the green LED is where you want it.`));
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
      const colorField = field('Color', h('input', { class: 'setup-color', type: 'color', value: idle.color, oninput: event => { idle.color = event.target.value; previewIdle(); } }));
      const briField = field('RGB strip brightness', slider(idle.bri, { min: 5, label: 'RGB strip brightness', onchange: v => { idle.bri = v; previewIdle(); } }));
      const sync = () => {
        colorField.hidden = !look().color;
        briField.hidden = !look().fx;
      };
      sync();
      return [
        h('p', { class: 'setup-lead' }, 'What should the lights show when no game is running? The controller also starts up with this.'),
        h('fieldset', { class: 'setup-field' },
          h('legend', { class: 'setup-label' }, 'RGB strip'),
          ...IDLE_LOOKS.map(l => h('label', { class: 'setup-check' },
            h('input', { type: 'radio', name: 'setupIdleLook', checked: l.id === idle.look, onchange: () => { idle.look = l.id; sync(); previewIdle(0); } }),
            h('span', {}, l.label)))),
        h('div', { class: 'setup-row' }, colorField, briField),
        hasLightStrip(plan) && field('Light strip brightness', slider(idle.lightBri, { min: 0, label: 'Light strip brightness', onchange: v => { idle.lightBri = v; previewIdle(); } })),
        h('small', { class: 'setup-hint' }, 'The strip shows your choice as you pick. Each zone can get its own look later under Edit › Idle lighting.')
      ].filter(Boolean);
    }

    // --- Step 6: review ---
    function renderReview() {
      const ranges = zoneRanges(plan.count, plan.zones);
      const strip = STRIP_TYPES.find(t => t.value === plan.stripType).label;
      const rows = [
        ['Name', plan.name],
        ['RGB strip', `${plan.count} LEDs on GPIO ${plan.stripPin}, ${strip}`],
        ['Colors', `${COLOR_ORDERS[plan.order & 0x0f]} order${plan.colorsChecked ? ', checked' : ' (not checked)'}`],
        ['Zones', ranges.map((r, i) => {
          const offset = zoneOffset(plan, i, r);
          const start = offset ? `, effects start at LED ${r.start + offset + 1}` : '';
          return ranges.length === 1 ? `One zone, the whole strip${start}` : `Zone ${i + 1}: ${humanRange(r)}${start}`;
        }).join('\n')],
        ['Light strip', plan.lightStrip ? `On GPIO ${plan.lightPin}` : 'None'],
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
