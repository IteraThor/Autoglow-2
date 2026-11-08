// AutoGlow 2 - Studio › Cameras: the board and player camera. Each shows its live picture; drag it to
// move, scroll or pinch to zoom, double-click for the whole picture. Straighten, dart zoom and a USB
// camera's picture controls fold under it. Every change saves by itself (studio-core.js).

import { api } from '../core/api.js';
import { h } from '../core/dom.js';
import { toast } from '../core/toast.js';
import { applyFraming, warpOf, ZOOM_MAX, ZOOM_MIN } from '../../studio/js/framing.js';
import { setMedia } from '../../studio/js/fill.js';
import * as core from './studio-core.js';
import { AUTODARTS_STOPPED, change, icon, imageUrl, streamUrl } from './studio-core.js';
import { segmented } from './studio-parts.js';

const $ = id => document.getElementById(id);
const S = () => core.settings;
const SLOTS = [
  { id: 'board', label: 'Board camera', icon: 'target', hint: 'Left half: the dartboard', straighten: true },
  { id: 'player', label: 'Player camera', icon: 'user', hint: 'Right half: the player at the oche' }
];

let devices = [];            // cameras of this browser (only usable on this device)
let serverCams = null;       // cameras on the AutoGlow computer (streamed to every device)
const previews = {};         // slot -> MediaStream of the preview

const saveCameras = () => change({ cameras: S().cameras });
const previewNote = text => h('span', { class: 'studio-preview-note' }, text);

async function listDevices(askPermission) {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  if (askPermission) {
    // Camera names are only shown after the browser was allowed to use a camera once
    const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    probe.getTracks().forEach(t => t.stop());
  }
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter(d => d.kind === 'videoinput');
}

async function loadServerCams() {
  try {
    serverCams = (await api('/api/studio/cameras', { timeout: 15000 })).cameras || [];
  } catch {
    serverCams = [];
  }
}

function stopPreview(slot) {
  previews[slot]?.getTracks().forEach(t => t.stop());
  delete previews[slot];
  // An MJPEG <img> keeps its connection (and the camera) open until its source is cleared.
  // Clearing the source fires its error handler, which must not replace the next preview.
  $(`studioPreview-${slot}`)?.querySelectorAll('img').forEach(img => { img.onerror = null; img.src = ''; });
}

// Cameras stay busy while previewed; free them when the step is left
export function stopCameras() { SLOTS.forEach(s => stopPreview(s.id)); }

function startButton(after) {
  const btn = h('button', { type: 'button', class: 'stu-btn is-primary' }, 'Start Autodarts');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Starting…';
    if (await core.startAutodarts()) setTimeout(after, 1500);
    else { btn.disabled = false; btn.textContent = 'Start Autodarts'; }
  });
  return btn;
}

// The live picture with what the screens add: framing, the blurred fill behind it, the split-view area
async function showPreview(slot) {
  const box = $(`studioPreview-${slot}`);
  if (!box) return;
  stopPreview(slot);
  box.classList.remove('is-marking'); // A marking in progress ends with the old picture
  const cam = S().cameras[slot];
  setMedia(box);
  const add = el => box.append(el);
  if (cam.kind === 'server' && cam.device_id) {
    const img = h('img', { src: streamUrl(cam.device_id, S().camera_resolution), alt: '' });
    img.onerror = async () => {
      // The stream answers with the reason when the camera cannot be opened
      const reason = await fetch(img.src).then(r => r.json()).then(d => d.message).catch(() => '');
      img.remove();
      box.append(h('div', { class: 'studio-preview-msg' },
        previewNote(reason || 'Camera not available'),
        reason.startsWith(AUTODARTS_STOPPED) ? startButton(() => showPreview(slot)) : null));
    };
    add(img);
  } else if (cam.kind === 'device' && cam.device_id) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: cam.device_id } }, audio: false });
      previews[slot] = stream;
      const video = h('video', { autoplay: true, playsinline: true });
      video.muted = true;
      video.srcObject = stream;
      add(video);
    } catch (err) {
      box.append(previewNote(`Camera not available: ${err.message || err.name}`));
    }
  } else if (cam.kind === 'mockup') {
    const withPhoto = S().players.find(p => p.mockup);
    box.append(withPhoto
      ? h('img', { src: imageUrl(withPhoto.mockup), alt: '', class: 'mockup' })
      : previewNote('Shows the mockup photo of the player at the board. Add one per player under Players.'));
  } else if (cam.kind === 'url' && cam.url) {
    const isVideo = /\.(mp4|webm|ogg|m3u8)(\?|$)/i.test(cam.url);
    const media = isVideo ? h('video', { src: cam.url, autoplay: true, loop: true, playsinline: true }) : h('img', { src: cam.url, alt: '' });
    if (isVideo) media.muted = true;
    media.onerror = () => { media.remove(); box.append(previewNote('Stream not reachable')); };
    add(media);
  } else {
    box.append(previewNote('No camera: choose one below'));
  }
  // Outline of what the split view shows of this camera (its centre half)
  box.append(h('div', { class: 'studio-split-area', title: 'Visible in the split view' }), box.overlay);
  box.reframe();
}

// --- Straighten: mark the board in the raw picture ------------------------------------------------
// Where the outer wire of the double ring crosses the middle of these segments, clockwise from the 20.
// Marked in the raw picture (not rotated), so a sideways camera shows the 20 at the side.
const MARKS = ['20', '6', '3', '11'];

function markBoard(slotId, cam, done) {
  const box = $(`studioPreview-${slotId}`);
  if (!box || box.querySelector('.studio-mark')) return;
  const media = () => box.querySelector(':scope > img, :scope > video');
  if (!media()) { toast.warning('No camera picture to mark.'); return; }
  // The raw picture: no rotation, mirror, zoom or warp while marking
  box.classList.add('is-marking');
  applyFraming(box, { rotation: 0, mirror: false, zoom: 1 });
  const points = [];
  const label = h('div', { class: 'studio-mark-label' });
  const dots = h('div', { class: 'studio-mark-dots' });
  const cancel = h('button', { type: 'button', class: 'stu-btn studio-mark-cancel' }, 'Cancel');
  const layer = h('div', { class: 'studio-mark' }, dots, label, cancel);
  const say = () => { label.textContent = `Click ${points.length + 1}/4: outer edge of the double ring at the ${MARKS[points.length]}${points.length ? '' : ' (then 6, 3, 11 clockwise)'}`; };
  const finish = ok => {
    layer.remove();
    box.classList.remove('is-marking');
    applyFraming(box, cam);
    done(ok ? points : null);
  };
  layer.addEventListener('pointerdown', e => e.stopPropagation()); // no dragging while marking
  layer.addEventListener('click', e => {
    if (e.target === cancel) { finish(false); return; }
    const m = media();
    if (!m) { finish(false); return; }
    // Where the click lies in the picture (object-fit: contain), 0..1 of its width and height
    const r = m.getBoundingClientRect();
    const nw = m.videoWidth || m.naturalWidth || 16;
    const nh = m.videoHeight || m.naturalHeight || 9;
    const scale = Math.min(r.width / nw, r.height / nh);
    const cw = nw * scale;
    const ch = nh * scale;
    const u = (e.clientX - r.left - (r.width - cw) / 2) / cw;
    const v = (e.clientY - r.top - (r.height - ch) / 2) / ch;
    if (u < 0 || u > 1 || v < 0 || v > 1) return;
    points.push([Math.round(u * 10000) / 10000, Math.round(v * 10000) / 10000]);
    const b = box.getBoundingClientRect();
    dots.append(h('span', { class: 'studio-mark-dot', style: `left:${e.clientX - b.left}px;top:${e.clientY - b.top}px` }, String(points.length)));
    if (points.length === 4) finish(true);
    else say();
  });
  say();
  box.append(layer);
}

function rangeRow(label, input, valueEl, title = '') {
  return h('label', { class: 'studio-range', title }, h('span', {}, label, ' ', valueEl), input);
}

function straightenControls(slot, cam, reframe) {
  const strength = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: cam.warp?.strength ?? 0.5, 'aria-label': `${slot.label} straighten` });
  const value = h('span', { class: 'studio-range-value' });
  const sharpen = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: cam.warp?.sharpen ?? 0.5, 'aria-label': `${slot.label} sharpen far side` });
  const sharpValue = h('span', { class: 'studio-range-value' });
  const mark = h('button', { type: 'button', class: 'stu-btn' }, icon('target', 14), h('span'));
  const remove = h('button', { type: 'button', class: 'stu-btn' }, 'Remove');
  const sync = () => {
    const marked = !!cam.warp?.points;
    strength.disabled = !marked;
    sharpen.disabled = !marked;
    sharpValue.textContent = Number(sharpen.value) > 0 ? `${Math.round(Number(sharpen.value) * 100)} %` : 'off';
    remove.hidden = !marked;
    mark.lastChild.textContent = marked ? 'Mark board again' : 'Mark board';
    value.textContent = marked ? `${Math.round(Number(strength.value) * 100)} %` : '';
  };
  strength.addEventListener('input', () => { if (cam.warp) cam.warp.strength = Number(strength.value); sync(); reframe(); saveCameras(); });
  sharpen.addEventListener('input', () => { if (cam.warp) cam.warp.sharpen = Number(sharpen.value); sync(); reframe(); saveCameras(); });
  mark.addEventListener('click', () => markBoard(slot.id, cam, points => {
    if (!points) return;
    cam.warp = { points, strength: Number(strength.value) || 0.5, sharpen: Number(sharpen.value) };
    strength.value = cam.warp.strength;
    reframe();
    if (!warpOf(cam) || !$(`studioPreview-${slot.id}`)?.style.getPropertyValue('--warp')) {
      toast.warning('These points do not look like the board. Mark the four points in order, clockwise from the 20.');
    }
    sync();
    saveCameras();
  }));
  remove.addEventListener('click', () => { cam.warp = null; sync(); reframe(); saveCameras(); });
  sync();
  return h('details', { class: 'stu-fold' },
    h('summary', {}, icon('play', 12), 'Straighten', h('small', {}, 'for a camera at the side of the board')),
    h('div', { class: 'stu-fold-body studio-straighten' },
      h('div', { class: 'stu-row' }, mark, remove),
      rangeRow('Straighten', strength, value),
      rangeRow('Sharpen far side', sharpen, sharpValue, 'Straightening stretches the far side of the board, which the camera saw with few pixels. This sharpens it, the more the further away.'),
      h('small', { class: 'stu-hint' }, 'Click four points on the board once, then choose how far to turn the picture towards a front view. The edges are cropped so no empty corners show.')));
}

// --- Dart zoom: zoom the board camera to each dart before the (delayed) picture shows it -------------
const DART_ZOOM_DEFAULTS = { enabled: false, delay: 2, zoom: 2.5, lead: 1, hold: 2 };

function dartZoomControls() {
  const dz = S().dart_zoom = { ...DART_ZOOM_DEFAULTS, ...(S().dart_zoom || {}) };
  const save = () => change({ dart_zoom: dz });
  const enabled = h('input', { type: 'checkbox', class: 'stu-switch', checked: dz.enabled, 'aria-label': 'Dart zoom' });
  const rows = [];
  const slider = (label, key, min, max, step, unit, hint) => {
    const value = h('span', { class: 'studio-range-value' });
    const input = h('input', { type: 'range', min, max, step, value: dz[key], 'aria-label': `Dart zoom ${label}` });
    const show = () => { value.textContent = `${Number(input.value).toFixed(step < 1 ? 1 : 0)}${unit}`; };
    input.addEventListener('input', () => {
      dz[key] = Number(input.value);
      // The move starts after the dart was reported, so the lead stays below the delay
      if (key === 'delay' && dz.lead > dz.delay - 0.3) { dz.lead = Math.max(0, +(dz.delay - 0.3).toFixed(1)); leadInput.value = dz.lead; leadInput.dispatchEvent(new Event('input')); }
      if (key === 'lead' && dz.lead > dz.delay - 0.3) { dz.lead = Math.max(0, +(dz.delay - 0.3).toFixed(1)); input.value = dz.lead; }
      show();
      save();
    });
    show();
    rows.push(rangeRow(label, input, value, hint));
    return input;
  };
  slider('Delay', 'delay', 0.5, 5, 0.1, ' s', 'How late the screens show the cameras and the scoreboard. It must be longer than Autodarts needs to report a dart.');
  slider('Zoom', 'zoom', 1.2, 4, 0.1, '×', 'How far the board camera zooms in on a dart');
  const leadInput = slider('Lead', 'lead', 0, 4.5, 0.1, ' s', 'The zoom starts this long before the moment Autodarts reported the dart. Autodarts reports a dart a moment after it landed, so a little more than that looks like the camera knew where it would go.');
  slider('Hold', 'hold', 0.5, 8, 0.5, ' s', 'How long it stays on a dart before zooming back out (the next dart takes over earlier)');
  const body = h('div', { class: 'studio-dart-zoom-rows' }, rows);
  const sync = () => body.classList.toggle('is-off', !dz.enabled);
  enabled.addEventListener('change', () => { dz.enabled = enabled.checked; sync(); save(); });
  sync();
  const marked = Array.isArray(S().cameras.board.warp?.points);
  return h('div', { class: 'stu-card stu-dart-zoom' },
    h('label', { class: 'stu-switch-row' }, enabled, h('strong', {}, 'Dart zoom'), h('small', {}, 'the board camera zooms to each dart')),
    body,
    h('small', { class: 'stu-hint' },
      marked ? '' : h('strong', {}, 'Mark the board first (Board camera › Straighten). '),
      'The screens show the cameras and the scoreboard a few seconds late; meanwhile Autodarts on this computer reports each dart, so the board camera zooms to it before the picture shows it landing. Off: no delay.'));
}

// --- Picture controls of a USB camera (V4L2): brightness, white balance, exposure... ---------------
// Set on the camera at once; saved with the slot, so they come back when the camera opens again.
const isUsbCam = cam => cam.kind === 'server' && cam.device_id && !cam.device_id.startsWith('autodarts:');

function pictureControls(slot, cam) {
  const body = h('div', { class: 'stu-fold-body studio-picture-body' });
  const panel = h('details', { class: 'stu-fold', hidden: !isUsbCam(cam) },
    h('summary', {}, icon('play', 12), 'Picture', h('small', {}, 'brightness, white balance, exposure')), body);
  const rows = new Map();   // control id -> { ctrl, input, value, row }
  let loadedFor = null;
  let pending = null;

  const showValue = (entry, value) => {
    const { ctrl, input } = entry;
    if (ctrl.type === 'bool') input.checked = !!value;
    else input.value = value;
    if (entry.value) entry.value.textContent = String(value);
  };
  const applyState = controls => {
    for (const c of controls) {
      const entry = rows.get(c.id);
      if (!entry) continue;
      entry.ctrl = c;
      // A switched-on automatic (white balance, exposure) makes its manual control inactive
      entry.input.disabled = c.inactive;
      entry.row.classList.toggle('is-inactive', c.inactive);
      if (document.activeElement !== entry.input) showValue(entry, c.value);
    }
  };
  // The server keeps the values with the slot itself
  const send = async values => {
    try {
      const res = await api('/api/studio/camera-controls', { method: 'POST', body: { cam: cam.device_id, slot: slot.id, ...values } });
      applyState(res.controls || []);
      if (res.failed?.length) toast.warning(`The camera refused: ${res.failed.join(', ')}`);
    } catch (err) {
      toast.error(err.message);
    }
  };
  const setValue = (ctrl, value, now) => {
    cam.controls = { ...(cam.controls || {}), [ctrl.id]: value };
    clearTimeout(pending);
    // Sliders send while dragging, a few times a second at most
    if (now) send({ values: { [ctrl.id]: value } });
    else pending = setTimeout(() => send({ values: { [ctrl.id]: value } }), 120);
  };

  const controlRow = ctrl => {
    let input;
    let value = null;
    if (ctrl.type === 'bool') {
      input = h('input', { type: 'checkbox', class: 'stu-switch' });
      input.addEventListener('change', () => setValue(ctrl, input.checked ? 1 : 0, true));
      return { ctrl, input, value, row: h('label', { class: 'stu-switch-row studio-picture-row' }, input, ctrl.name) };
    }
    if (ctrl.type === 'menu') {
      input = h('select', { class: 'stu-select', 'aria-label': ctrl.name }, ctrl.menu.map(m => h('option', { value: m.value }, m.label)));
      input.addEventListener('change', () => setValue(ctrl, Number(input.value), true));
    } else {
      input = h('input', { type: 'range', min: ctrl.min, max: ctrl.max, step: ctrl.step, 'aria-label': ctrl.name });
      value = h('span', { class: 'studio-range-value' });
      input.addEventListener('input', () => { value.textContent = input.value; setValue(ctrl, Number(input.value), false); });
      input.addEventListener('dblclick', () => { showValue(entry, ctrl.default); setValue(ctrl, ctrl.default, true); });
    }
    const row = h('label', { class: 'studio-range studio-picture-row', title: ctrl.type === 'int' ? `Default ${ctrl.default} – double-click to reset` : '' },
      h('span', {}, ctrl.name, ' ', value), input);
    const entry = { ctrl, input, value, row };
    return entry;
  };

  const load = async () => {
    loadedFor = cam.device_id;
    rows.clear();
    body.replaceChildren(previewNote('Reading the camera…'));
    try {
      const { controls } = await api(`/api/studio/camera-controls?cam=${encodeURIComponent(cam.device_id)}`);
      if (loadedFor !== cam.device_id) return;
      if (!controls.length) { body.replaceChildren(previewNote('This camera has no adjustable controls.')); return; }
      for (const c of controls) rows.set(c.id, controlRow(c));
      const reset = h('button', { type: 'button', class: 'stu-btn', onclick: async () => {
        cam.controls = {};
        await send({ reset: true });
      } }, icon('reset', 14), 'Camera defaults');
      // Switches first: they decide which sliders are active
      const entries = [...rows.values()];
      body.replaceChildren(
        h('div', { class: 'studio-picture-switches' }, entries.filter(e => e.ctrl.type !== 'int').map(e => e.row)),
        h('div', { class: 'studio-picture-grid' }, entries.filter(e => e.ctrl.type === 'int').map(e => e.row)),
        h('div', { class: 'studio-picture-foot' },
          h('small', { class: 'stu-hint' }, 'Changes go to the camera at once. Turn off the automatic white balance or exposure to set them by hand.'),
          reset));
      applyState(controls);
    } catch (err) {
      loadedFor = null;
      body.replaceChildren(previewNote(err.message));
    }
  };
  panel.addEventListener('toggle', () => { if (panel.open && loadedFor !== cam.device_id) load(); });

  // Called when the slot's source changes
  panel.refresh = () => {
    panel.hidden = !isUsbCam(cam);
    if (loadedFor !== cam.device_id) {
      loadedFor = null;
      if (panel.open && !panel.hidden) load();
    }
  };
  return panel;
}

// --- One camera ---------------------------------------------------------------------------------
function sourceSelect(slot, cam) {
  const isServer = id => cam.kind === 'server' && cam.device_id === id;
  const select = h('select', { class: 'stu-select', 'aria-label': `${slot.label} source` },
    h('option', { value: 'none' }, 'No camera'),
    // Cameras the Autodarts Board Manager streams: shared with dart detection, nothing to free up
    serverCams.some(c => c.source === 'autodarts') ? h('optgroup', { label: 'Autodarts cameras – shared with dart detection' },
      serverCams.filter(c => c.source === 'autodarts').map(c => h('option', { value: `server:${c.id}`, selected: isServer(c.id) }, c.name))
    ) : null,
    h('optgroup', { label: 'USB cameras on the AutoGlow computer' },
      serverCams.filter(c => c.source !== 'autodarts').map(c => h('option', { value: `server:${c.id}`, selected: isServer(c.id) },
        c.autodarts ? `${c.name} – used by Autodarts` : c.name)),
      // A saved camera that is not plugged in right now stays selectable
      cam.kind === 'server' && cam.device_id && !serverCams.some(c => c.id === cam.device_id)
        ? h('option', { value: `server:${cam.device_id}`, selected: true }, `${cam.label || 'Saved camera'} (not found)`) : null
    ),
    devices.length ? h('optgroup', { label: 'This browser – only on this device' },
      devices.map((d, i) => h('option', { value: `device:${d.deviceId}`, selected: cam.kind === 'device' && cam.device_id === d.deviceId }, d.label || `Camera ${i + 1}`))
    ) : null,
    cam.kind === 'device' && cam.device_id && !devices.some(d => d.deviceId === cam.device_id)
      ? h('option', { value: `device:${cam.device_id}`, selected: true }, `${cam.label || 'Browser camera'} (this browser only)`) : null,
    h('option', { value: 'url', selected: cam.kind === 'url' }, 'Network camera (stream URL)…'),
    // No player camera yet: show each player's mockup photo while they are at the board
    slot.id === 'player' || cam.kind === 'mockup'
      ? h('option', { value: 'mockup', selected: cam.kind === 'mockup' }, 'Mockup – photo of the player at the board') : null
  );
  if (cam.kind === 'none') select.value = 'none';
  return select;
}

// Drag: the picture follows the pointer (pan is -1..1 of the room the zoom leaves). Wheel or two fingers
// zoom; double-click shows the whole picture.
function frameByHand(box, cam, reframe) {
  const pointers = new Map();
  let start = null;
  const begin = () => {
    start = { px: cam.pan_x || 0, py: cam.pan_y || 0, zoom: cam.zoom || 1, dist: null, at: [...pointers.values()][0] };
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; start.dist = Math.hypot(a[0] - b[0], a[1] - b[1]); }
  };
  box.addEventListener('pointerdown', e => {
    if (e.target.closest('button, .studio-mark') || box.classList.contains('is-marking')) return; // a capture would take the click
    box.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    begin();
  });
  box.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId) || !start) return;
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2 && start.dist) {
      const [a, b] = [...pointers.values()];
      cam.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, start.zoom * Math.hypot(a[0] - b[0], a[1] - b[1]) / start.dist));
    } else {
      const z = cam.zoom || 1;
      if (z <= 1.001) return;
      const r = box.getBoundingClientRect();
      const flip = cam.mirror ? -1 : 1;
      // One box width of drag moves the picture by one box: pan step = 2 / (z - 1) per box
      cam.pan_x = Math.max(-1, Math.min(1, start.px - flip * (e.clientX - start.at[0]) / r.width * 2 / (z - 1)));
      cam.pan_y = Math.max(-1, Math.min(1, start.py - (e.clientY - start.at[1]) / r.height * 2 / (z - 1)));
    }
    reframe();
  });
  const end = e => {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size) begin(); else { start = null; saveCameras(); }
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
  // The browser's own image drag would cancel the pointer after a few pixels
  box.addEventListener('dragstart', e => e.preventDefault());
  let wheelTimer = null;
  box.addEventListener('wheel', e => {
    if (box.classList.contains('is-marking')) return;
    e.preventDefault();
    cam.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, (cam.zoom || 1) * Math.exp(-e.deltaY * 0.0015)));
    reframe();
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(saveCameras, 250);
  }, { passive: false });
}

function cameraCard(slot) {
  const cam = S().cameras[slot.id];
  const zoomTag = h('span', { class: 'stu-cam-zoom' });
  const overlay = h('div', { class: 'stu-cam-overlay' }, zoomTag, h('span', { class: 'stu-cam-hint' }, 'Drag to move · scroll to zoom'));
  const box = h('div', { class: 'studio-preview', id: `studioPreview-${slot.id}` });
  box.overlay = overlay;
  box.reframe = () => {
    if (box.classList.contains('is-marking')) return;
    applyFraming(box, cam);
    zoomTag.textContent = `${(cam.zoom || 1).toFixed(1)}×`;
  };
  frameByHand(box, cam, box.reframe);
  const whole = () => { Object.assign(cam, { zoom: 1, pan_x: 0, pan_y: 0 }); box.reframe(); saveCameras(); };
  box.addEventListener('dblclick', e => { if (!e.target.closest('button, .studio-mark')) whole(); });

  const rot = h('button', { type: 'button', class: 'stu-btn stu-iconbtn', title: 'Turn 90°', 'aria-label': 'Turn 90°' }, icon('rotate', 16));
  const mir = h('button', { type: 'button', class: 'stu-btn stu-iconbtn', title: 'Mirror', 'aria-label': 'Mirror', 'aria-pressed': String(!!cam.mirror) }, icon('mirror', 16));
  const reset = h('button', { type: 'button', class: 'stu-btn stu-iconbtn', title: 'Whole picture (or double-click it)', 'aria-label': 'Whole picture' }, icon('reset', 16));
  const turnIcon = () => { rot.querySelector('.stu-icon').style.transform = `rotate(${cam.rotation || 0}deg)`; };
  rot.addEventListener('click', () => { cam.rotation = ((cam.rotation || 0) + 90) % 360; turnIcon(); box.reframe(); saveCameras(); });
  mir.addEventListener('click', () => { cam.mirror = !cam.mirror; mir.setAttribute('aria-pressed', String(cam.mirror)); box.reframe(); saveCameras(); });
  reset.addEventListener('click', whole);
  turnIcon();

  const select = sourceSelect(slot, cam);
  const url = h('input', { class: 'stu-input', type: 'url', placeholder: 'http://camera-ip/stream.mjpg', value: cam.url || '', hidden: cam.kind !== 'url', 'aria-label': 'Stream URL' });
  const picture = pictureControls(slot, cam);
  const update = () => {
    const [kind, ...rest] = select.value.split(':');
    const id = rest.join(':');
    if (kind === 'server') {
      const sc = serverCams.find(c => c.id === id);
      // Picture controls belong to the camera they were set on
      if (cam.device_id !== id) cam.controls = {};
      Object.assign(cam, { kind, device_id: id, label: sc?.name || cam.label });
      if (sc?.autodarts) toast.warning('Autodarts uses this camera for dart detection. Choose it under "Autodarts cameras" to share it.');
    } else if (kind === 'device') {
      const dev = devices.find(d => d.deviceId === id);
      Object.assign(cam, { kind, device_id: id, label: dev?.label || cam.label });
    } else {
      cam.kind = select.value;
    }
    cam.url = url.value.trim();
    url.hidden = cam.kind !== 'url';
    picture.refresh();
    saveCameras();
    showPreview(slot.id);
  };
  select.addEventListener('change', update);
  url.addEventListener('change', update);

  return h('div', { class: 'stu-card stu-cam' },
    h('div', { class: 'stu-cam-head' }, icon(slot.icon, 16), h('strong', {}, slot.label), h('small', {}, slot.hint), h('span', { class: 'stu-cam-tools' }, rot, mir, reset)),
    box, select, url, picture,
    slot.straighten ? straightenControls(slot, cam, box.reframe) : null);
}

// --- The step ----------------------------------------------------------------------------------------
export function camerasPanel() {
  const cards = h('div', { class: 'stu-cams' }, previewNote('Looking for cameras…'));
  const render = () => {
    stopCameras();
    cards.replaceChildren(...SLOTS.map(cameraCard), dartZoomControls());
    SLOTS.forEach(s => showPreview(s.id));
  };
  const refresh = async () => {
    await loadServerCams();
    // Browser cameras are listed only when this page may use them (localhost / https)
    devices = await listDevices(false).catch(() => []);
    render();
  };

  const quality = segmented(['480p', '720p', '1080p'].map(v => ({ value: v, label: v, title: v === '480p' ? 'Light on Wi-Fi' : '' })), S().camera_resolution,
    v => { change({ camera_resolution: v }); SLOTS.forEach(s => showPreview(s.id)); }, 'USB camera quality');
  const fps = segmented([10, 15, 30].map(v => ({ value: String(v), label: `${v} fps` })), String(S().relay_fps),
    v => change({ relay_fps: Number(v) }), 'Frame rate of the Autodarts cameras');
  const again = h('button', { type: 'button', class: 'stu-btn stu-iconbtn', title: 'Look for cameras again', 'aria-label': 'Look for cameras again' }, icon('refresh', 16));
  again.addEventListener('click', refresh);
  const allow = h('button', { type: 'button', class: 'stu-btn', title: 'Only for an output shown on this device', hidden: !navigator.mediaDevices?.getUserMedia }, icon('camera', 14), 'This browser’s cameras');
  allow.addEventListener('click', async () => {
    try {
      devices = await listDevices(true);
      render();
      if (!devices.length) toast.warning('This browser has no camera.');
    } catch (err) {
      toast.error(`Camera access was refused: ${err.message || err.name}`);
    }
  });

  const streaming = h('div', { class: 'stu-card stu-streaming' },
    h('label', { title: 'Quality of the USB cameras on the screens' }, h('span', { class: 'stu-h' }, 'USB quality'), quality),
    h('label', { title: 'Autodarts cameras send full-size pictures (about 3.5 MB/s per camera at 15 fps); use 10 fps if the Wi-Fi struggles' }, h('span', { class: 'stu-h' }, 'Autodarts cameras'), fps),
    h('span', { class: 'stu-row stu-streaming-end' }, again, allow));

  if (serverCams) render();
  refresh();
  return h('div', { class: 'stu-cameras' }, cards, streaming);
}
