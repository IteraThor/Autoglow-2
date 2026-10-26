// AutoGlow 2 - LED layout draft of one controller (outputs and segments), without any DOM code
// Outputs are WLED's hardware buses (hw.led.ins), segments its state segments. Positions are 0-based,
// stop is exclusive, like WLED. The page shows LEDs counted from 1 with both ends included.

export const OUTPUT_TYPES = [
  { value: 22, label: 'RGB strip (WS281x)' },
  { value: 41, label: 'Light strip (PWM)' }
];

export const COLOR_ORDERS = [
  { value: 0, label: 'GRB' },
  { value: 1, label: 'RGB' },
  { value: 2, label: 'BRG' },
  { value: 3, label: 'RBG' },
  { value: 4, label: 'BGR' },
  { value: 5, label: 'GBR' }
];

// Pins tried first when an output is added (common free ESP32 pins)
const CANDIDATE_PINS = [16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 4, 5, 12, 13, 14, 15];

const int = (value, fallback = 0) => {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
};

export const isPwmOutput = output => int(output?.type, 22) >= 40;
export const pinOf = output => int(Array.isArray(output.pin) ? output.pin[0] : output.pin);

// WLED names allow letters, digits, spaces, _ and - only
export const cleanName = name => String(name || '').replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 32);

function normaliseOutput(hw) {
  return {
    pin: Array.isArray(hw.pin) ? int(hw.pin[0], 33) : int(hw.pin, 33),
    type: int(hw.type, 22),
    start: int(hw.start),
    len: int(hw.len, 45),
    order: int(hw.order),
    rev: Boolean(hw.rev),
    skip: int(hw.skip)
  };
}

// Outputs guessed from segments, for controllers that do not report hw_ins
function outputsFromSegments(segments) {
  const groups = new Map();
  segments.forEach(s => {
    const pwm = /pwm/i.test(String(s.type || ''));
    const pin = int(String(s.gpio || '').replace(/\D/g, ''), pwm ? 16 : 33);
    const start = int(s.start);
    const stop = int(s.stop) || start + (int(s.length ?? s.len, 1));
    const key = `${pin}_${pwm ? 41 : 22}`;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { pin, type: pwm ? 41 : 22, start, len: Math.max(1, stop - start), order: 0, rev: false, skip: 0 });
    } else {
      if (start < group.start) {
        group.len += group.start - start;
        group.start = start;
      }
      if (stop > group.start + group.len) group.len = stop - group.start;
    }
  });
  return [...groups.values()].sort((a, b) => a.start - b.start);
}

// Build the draft from what the controller reports (live), falling back to AutoGlow's saved copy (dev)
export function draftFrom(live, dev) {
  const liveSegs = Array.isArray(live?.segments) && live.segments.length ? live.segments : null;
  const devSegs = Array.isArray(dev?.segments) && dev.segments.length ? dev.segments : null;

  let outputs = [];
  if (Array.isArray(live?.hw_ins) && live.hw_ins.length) outputs = live.hw_ins.map(normaliseOutput);
  else if (Array.isArray(dev?.hw_ins) && dev.hw_ins.length) outputs = dev.hw_ins.map(normaliseOutput);
  else if (liveSegs) outputs = outputsFromSegments(liveSegs);
  else if (devSegs) outputs = outputsFromSegments(devSegs);
  if (!outputs.length) outputs = [{ pin: 33, type: 22, start: 0, len: dev?.rgb_count || 45, order: 0, rev: false, skip: 0 }];

  let segments;
  if (liveSegs) {
    segments = liveSegs.map((s, i) => ({
      id: s.id ?? i,
      name: s.name || `Segment ${s.id ?? i}`,
      start: int(s.start),
      stop: s.stop !== undefined ? int(s.stop) : int(s.start) + int(s.length ?? s.len, 1),
      of: int(s.of),
      on: s.on !== false,
      bri: s.bri ?? 255
    }));
  } else if (devSegs) {
    segments = devSegs.map((s, i) => ({
      id: s.id ?? i,
      name: s.name || `Segment ${i}`,
      start: int(s.start),
      stop: int(s.start) + int(s.length ?? s.len, 1),
      of: int(s.offset),
      on: true,
      bri: 255
    }));
  } else {
    segments = [{ id: 0, name: 'RGB strip', start: 0, stop: outputs[0].len, of: 0, on: true, bri: 255 }];
  }

  const draft = {
    name: cleanName(dev?.name || live?.name || 'WLED Controller'),
    port: dev?.udp_port || dev?.port || 21324,
    bri: live?.state?.bri ?? 255,
    outputs,
    segments
  };
  return recalc(draft);
}

// Lay the outputs end to end and keep every segment inside its output.
// An RGB output grows and shrinks with its last segment; a light strip output is always one LED with one segment.
export function recalc(draft) {
  const { outputs, segments } = draft;

  segments.forEach(s => {
    if (s.busIdx !== undefined) return;
    const start = int(s.start);
    s.busIdx = 0;
    outputs.forEach((hw, i) => {
      if (start >= int(hw.start) && start < int(hw.start) + Math.max(1, int(hw.len, 1))) s.busIdx = i;
    });
  });

  outputs.forEach((hw, i) => {
    if (isPwmOutput(hw)) {
      hw.len = 1;
      return;
    }
    const own = segments.filter(s => s.busIdx === i);
    if (own.length) {
      const busStart = int(hw.start);
      hw.len = Math.max(1, ...own.map(s => (int(s.stop) > busStart ? int(s.stop) - busStart : Math.max(1, int(s.stop) - int(s.start)))));
    } else if (!hw.len || hw.len < 1) {
      hw.len = 45;
    }
  });

  let cursor = 0;
  const next = [];
  outputs.forEach((hw, i) => {
    const len = Math.max(1, int(hw.len, 1));
    const start = cursor;
    const end = start + len;
    const shift = start - int(hw.start);
    hw.start = start;
    cursor = end;
    const own = segments.filter(s => s.busIdx === i);

    if (isPwmOutput(hw)) {
      const first = own[0];
      next.push({ busIdx: i, name: first?.name || `Light strip (GPIO ${pinOf(hw)})`, start, stop: end, of: 0, on: first?.on ?? true, bri: first?.bri ?? 255 });
    } else if (!own.length) {
      next.push({ busIdx: i, name: `RGB strip (GPIO ${pinOf(hw)})`, start, stop: end, of: 0, on: true, bri: 255 });
    } else {
      own.forEach(s => {
        let sStart = int(s.start) + shift;
        let sStop = int(s.stop) + shift;
        if (sStart < start) sStart = start;
        if (sStop <= sStart || sStop > end) sStop = end;
        sStart = Math.max(start, Math.min(sStart, end - 1));
        sStop = Math.max(sStart + 1, Math.min(sStop, end));
        next.push({ busIdx: i, name: s.name || 'Segment', start: sStart, stop: sStop, of: int(s.of) % (sStop - sStart), on: s.on ?? true, bri: s.bri ?? 255 });
      });
    }
  });
  next.forEach((s, i) => { s.id = i; });
  draft.segments = next;
  return draft;
}

export function duplicatePins(draft) {
  const pins = draft.outputs.map(pinOf);
  return new Set(pins.filter((p, i) => pins.indexOf(p) !== i));
}

export function setOutputType(draft, busIdx, type) {
  const hw = draft.outputs[busIdx];
  if (!hw) return;
  hw.type = int(type, 22);
  const own = draft.segments.filter(s => s.busIdx === busIdx);
  if (isPwmOutput(hw)) {
    hw.len = 1;
    if (own[0]) own[0].name = `Light strip (GPIO ${pinOf(hw)})`;
  } else {
    if (!hw.len || hw.len <= 1) hw.len = 45;
    // The single light strip segment now covers the whole RGB strip
    own.forEach(s => {
      s.stop = int(hw.start) + hw.len;
      if (/pwm|light strip/i.test(s.name)) s.name = `RGB strip (GPIO ${pinOf(hw)})`;
    });
  }
  recalc(draft);
}

// Changing an RGB strip's length moves its last segment's end with it
export function setOutputLength(draft, busIdx, len) {
  const hw = draft.outputs[busIdx];
  if (!hw || isPwmOutput(hw)) return;
  hw.len = Math.max(1, int(len, 1));
  const own = draft.segments.filter(s => s.busIdx === busIdx);
  const last = own[own.length - 1];
  if (last) last.stop = int(hw.start) + hw.len;
  recalc(draft);
}

export function addOutput(draft) {
  const used = new Set(draft.outputs.map(pinOf));
  const pin = CANDIDATE_PINS.find(p => !used.has(p)) ?? Array.from({ length: 39 }, (_, i) => i + 1).find(p => !used.has(p)) ?? 17;
  const last = draft.outputs[draft.outputs.length - 1];
  draft.outputs.push({ pin, type: 41, start: last ? last.start + last.len : 0, len: 1, order: 0, rev: false, skip: 0 });
  recalc(draft);
}

// Outputs are removed last to first, so the LED numbers of the others never move
export function removeLastOutput(draft) {
  if (draft.outputs.length < 2) return;
  const busIdx = draft.outputs.length - 1;
  draft.outputs.pop();
  draft.segments = draft.segments.filter(s => s.busIdx !== busIdx);
  recalc(draft);
}

// A new segment takes the LEDs after the output's last segment (or the whole output when it is full)
export function addSegment(draft, busIdx) {
  const hw = draft.outputs[busIdx];
  if (!hw || isPwmOutput(hw)) return;
  const start = int(hw.start);
  const end = start + Math.max(1, int(hw.len, 1));
  const own = draft.segments.filter(s => s.busIdx === busIdx);
  const lastStop = own.length ? int(own[own.length - 1].stop) : start;
  const segStart = lastStop < end ? lastStop : start;
  const at = own.length ? draft.segments.indexOf(own[own.length - 1]) + 1 : draft.segments.length;
  draft.segments.splice(at, 0, { busIdx, name: `Segment ${draft.segments.length}`, start: segStart, stop: end, of: 0, on: true, bri: 255 });
  draft.segments.forEach((s, i) => { s.id = i; });
}

export function removeSegment(draft, segIdx) {
  draft.segments.splice(segIdx, 1);
  recalc(draft);
}

// first and last are the 1-based, inclusive LED numbers the page shows
export function setSegmentRange(draft, segIdx, first, last) {
  const seg = draft.segments[segIdx];
  if (!seg) return;
  seg.start = Math.max(0, int(first, 1) - 1);
  seg.stop = Math.max(seg.start + 1, int(last, seg.start + 1));
  recalc(draft);
}

// Body of POST /api/wled/update
export function toPayload(ip, draft) {
  recalc(draft);
  return {
    ip,
    name: cleanName(draft.name) || 'WLED Controller',
    udp_port: draft.port,
    hw_ins: draft.outputs.map(hw => ({
      start: int(hw.start),
      len: int(hw.len, 1),
      pin: [pinOf(hw)],
      type: int(hw.type, 22),
      order: int(hw.order),
      rev: Boolean(hw.rev),
      skip: int(hw.skip)
    })),
    state: {
      on: true,
      bri: draft.bri,
      seg: draft.segments.map((s, i) => ({
        id: i,
        n: cleanName(s.name) || `Segment ${i}`,
        start: int(s.start),
        stop: int(s.stop),
        of: int(s.of),
        on: s.on !== false,
        bri: int(s.bri, 255)
      }))
    }
  };
}
