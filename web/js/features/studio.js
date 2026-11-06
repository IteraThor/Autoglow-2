// AutoGlow 2 - Studio page: players (name + picture), the two cameras and the overlay text.
// The broadcast itself is web/studio/live.html; it reads the same settings from /api/studio.

import { api } from '../core/api.js';
import { confirmDialog } from '../core/dialog.js';
import { h } from '../core/dom.js';
import { toast } from '../core/toast.js';
import { applyFraming, warpOf, ZOOM_MAX, ZOOM_MIN } from '../../studio/js/framing.js';
import { setMedia } from '../../studio/js/fill.js';
import { renderLiveMatch, renderMatch } from './studio-match.js';

const $ = id => document.getElementById(id);
const SLOTS = [
  { id: 'board', label: 'Board camera', hint: 'Left half: the dartboard', straighten: true },
  { id: 'player', label: 'Player camera', hint: 'Right half: the player at the oche' }
];

let settings = null;
let devices = [];            // cameras of this browser (only usable on this device)
let serverCams = [];         // cameras on the AutoGlow computer (streamed to every device)
let editing = null;          // player id being edited, or null for a new player
let pickedFile = null;
let pickedMockup = null;     // photo for the mockup player camera
const previews = {};         // slot -> MediaStream of the preview

const imageUrl = name => `/api/studio/images/${encodeURIComponent(name)}`;
const streamUrl = (camId, res) => `/api/studio/stream?cam=${encodeURIComponent(camId)}&res=${encodeURIComponent(res)}`;

// --- Cameras -----------------------------------------------------------------
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

const previewNote = text => h('span', { class: 'studio-preview-note' }, text);

// The Autodarts Board Manager streams its cameras only while detection runs; this is its Start button
const AUTODARTS_STOPPED = 'Autodarts is stopped';

async function startAutodarts(button) {
  if (button) { button.disabled = true; button.textContent = 'Starting…'; }
  try {
    await api('/api/studio/autodarts/start', { method: 'POST', timeout: 20000 });
    toast.success('Autodarts started. The cameras come back in a moment.');
    return true;
  } catch (err) {
    toast.error(err.message);
    return false;
  } finally {
    if (button) { button.disabled = false; button.textContent = 'Start Autodarts'; }
  }
}

function startButton(after) {
  const btn = h('button', { type: 'button', class: 'btn-ide btn-ide-primary' }, 'Start Autodarts');
  btn.addEventListener('click', async () => { if (await startAutodarts(btn) && after) setTimeout(after, 1500); });
  return btn;
}

async function showPreview(slot) {
  const box = $(`studioPreview-${slot}`);
  if (!box) return;
  stopPreview(slot);
  box.classList.remove('is-marking'); // A marking in progress ends with the old picture
  const cam = settings.cameras[slot];
  // Blurred copy of the picture behind it, as on the screens (no empty bars when zoomed out or turned)
  setMedia(box);
  if (cam.kind === 'server' && cam.device_id) {
    const img = h('img', { src: streamUrl(cam.device_id, settings.camera_resolution), alt: '' });
    img.onerror = async () => {
      // The stream answers with the reason when the camera cannot be opened
      const reason = await fetch(img.src).then(r => r.json()).then(d => d.message).catch(() => '');
      box.replaceChildren(h('div', { class: 'studio-preview-msg' },
        previewNote(reason || 'Camera not available'),
        reason.startsWith(AUTODARTS_STOPPED) ? startButton(() => showPreview(slot)) : null));
    };
    box.append(img);
  } else if (cam.kind === 'device' && cam.device_id) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: cam.device_id } }, audio: false });
      previews[slot] = stream;
      const video = h('video', { autoplay: true, playsinline: true });
      video.muted = true;
      video.srcObject = stream;
      box.append(video);
    } catch (err) {
      box.append(previewNote(`Camera not available: ${err.message || err.name}`));
    }
  } else if (cam.kind === 'mockup') {
    const withPhoto = settings.players.find(p => p.mockup);
    box.append(withPhoto
      ? h('img', { src: imageUrl(withPhoto.mockup), alt: '', class: 'mockup' })
      : previewNote('Shows the mockup photo of the player at the board. Upload one per player under Players.'));
  } else if (cam.kind === 'url' && cam.url) {
    const isVideo = /\.(mp4|webm|ogg|m3u8)(\?|$)/i.test(cam.url);
    const media = isVideo ? h('video', { src: cam.url, autoplay: true, loop: true, playsinline: true }) : h('img', { src: cam.url, alt: '' });
    if (isVideo) media.muted = true;
    media.onerror = () => box.replaceChildren(previewNote('Stream not reachable'));
    box.append(media);
  } else {
    box.append(previewNote('No camera'));
  }
  applyFraming(box, cam);
  // Outline of what the split view shows of this camera (its centre half)
  box.append(h('div', { class: 'studio-split-area', title: 'Visible in the split view' }));
}

// --- Straighten: mark the board in the raw picture ---------------------------------------------
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
  const cancel = h('button', { type: 'button', class: 'btn-ide studio-mark-cancel' }, 'Cancel');
  const layer = h('div', { class: 'studio-mark' }, dots, label, cancel);
  const say = () => { label.textContent = `Click ${points.length + 1}/4: outer edge of the double ring at the ${MARKS[points.length]}${points.length ? '' : ' (then 6, 3, 11 clockwise)'}`; };
  const finish = ok => {
    layer.remove();
    box.classList.remove('is-marking');
    applyFraming(box, cam);
    done(ok ? points : null);
  };
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

function straightenControls(slot, cam) {
  const strength = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: cam.warp?.strength ?? 0.5, 'aria-label': `${slot.label} straighten` });
  const value = h('span', { class: 'studio-range-value' });
  const sharpen = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: cam.warp?.sharpen ?? 0.5, 'aria-label': `${slot.label} sharpen far side` });
  const sharpValue = h('span', { class: 'studio-range-value' });
  const mark = h('button', { type: 'button', class: 'btn-ide' });
  const remove = h('button', { type: 'button', class: 'btn-ide' }, 'Remove');
  const sync = () => {
    const marked = !!cam.warp?.points;
    strength.disabled = !marked;
    sharpen.disabled = !marked;
    sharpValue.textContent = Number(sharpen.value) > 0 ? `${Math.round(Number(sharpen.value) * 100)} %` : 'off';
    remove.hidden = !marked;
    mark.textContent = marked ? 'Mark board again' : 'Mark board…';
    value.textContent = marked ? `${Math.round(Number(strength.value) * 100)} %` : 'mark the board first';
  };
  const reframe = () => applyFraming($(`studioPreview-${slot.id}`), cam);
  strength.addEventListener('input', () => {
    if (cam.warp) cam.warp.strength = Number(strength.value);
    sync();
    reframe();
  });
  sharpen.addEventListener('input', () => {
    if (cam.warp) cam.warp.sharpen = Number(sharpen.value);
    sync();
    reframe();
  });
  mark.addEventListener('click', () => markBoard(slot.id, cam, points => {
    if (!points) return;
    cam.warp = { points, strength: Number(strength.value) || 0.5, sharpen: Number(sharpen.value) };
    strength.value = cam.warp.strength;
    reframe();
    if (!warpOf(cam) || !$(`studioPreview-${slot.id}`)?.style.getPropertyValue('--warp')) {
      toast.warning('These points do not look like the board. Mark the four points in order, clockwise from the 20.');
    }
    sync();
    publishDraft();
  }));
  remove.addEventListener('click', () => {
    cam.warp = null;
    sync();
    reframe();
    publishDraft();
  });
  sync();
  return h('div', { class: 'studio-straighten' },
    h('label', { class: 'studio-range' }, h('span', {}, 'Straighten ', value), strength),
    mark, remove,
    h('label', { class: 'studio-range studio-straighten-sharp', title: 'Straightening stretches the far side of the board, which the camera saw with few pixels. This sharpens it, the more the further away.' }, h('span', {}, 'Sharpen far side ', sharpValue), sharpen),
    h('small', { class: 'studio-straighten-hint' }, 'For a camera looking at the board from the side: mark the board once, then choose how far to turn the picture towards a front view. The edges are cropped so no empty corners show.'));
}

// --- Dart zoom: zoom the board camera to each dart before the (delayed) picture shows it ----------
const DART_ZOOM_DEFAULTS = { enabled: false, delay: 2, zoom: 2.5, lead: 1, hold: 2 };

function dartZoomControls(cam) {
  const dz = settings.dart_zoom = { ...DART_ZOOM_DEFAULTS, ...(settings.dart_zoom || {}) };
  const enabled = h('input', { type: 'checkbox', checked: dz.enabled });
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
    });
    show();
    rows.push(h('label', { class: 'studio-range', title: hint }, h('span', {}, `${label} `, value), input));
    return input;
  };
  slider('Delay', 'delay', 0.5, 5, 0.1, ' s', 'How late the screens show the cameras and the scoreboard. It must be longer than Autodarts needs to report a dart.');
  slider('Zoom', 'zoom', 1.2, 4, 0.1, '×', 'How far the board camera zooms in on a dart');
  const leadInput = slider('Lead', 'lead', 0, 4.5, 0.1, ' s', 'The zoom starts this long before the moment Autodarts reported the dart. Autodarts reports a dart a moment after it landed, so a little more than that looks like the camera knew where it would go.');
  slider('Hold', 'hold', 0.5, 8, 0.5, ' s', 'How long it stays on a dart before zooming back out (the next dart takes over earlier)');
  const sync = () => {
    dz.enabled = enabled.checked;
    rows.forEach(r => r.classList.toggle('is-off', !dz.enabled));
  };
  enabled.addEventListener('change', sync);
  sync();
  const marked = Array.isArray(cam.warp?.points);
  return h('div', { class: 'studio-dart-zoom' },
    h('label', { class: 'studio-check' }, enabled, h('strong', {}, 'Dart zoom')),
    h('div', { class: 'studio-dart-zoom-rows' }, rows),
    h('small', { class: 'studio-straighten-hint' },
      marked ? '' : h('strong', {}, 'Mark the board first (Straighten › Mark board). '),
      'The screens show the cameras and the scoreboard a few seconds late; meanwhile Autodarts on this computer reports each dart, so the board camera zooms to it before the picture shows it landing. Off: no delay. Changes reach the screens on Save.'));
}

// --- Picture controls of a USB camera (V4L2): brightness, white balance, exposure... ------------
// Set on the camera at once; saved with the slot, so they come back when the camera opens again.
const isUsbCam = cam => cam.kind === 'server' && cam.device_id && !cam.device_id.startsWith('autodarts:');

function pictureControls(slot, cam) {
  const body = h('div', { class: 'studio-picture-body' });
  const panel = h('details', { class: 'studio-picture', hidden: !isUsbCam(cam) },
    h('summary', {}, 'Picture – brightness, white balance, exposure'), body);
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
  const send = async body => {
    try {
      const res = await api('/api/studio/camera-controls', { method: 'POST', body: { cam: cam.device_id, slot: slot.id, ...body } });
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
      input = h('input', { type: 'checkbox' });
      input.addEventListener('change', () => setValue(ctrl, input.checked ? 1 : 0, true));
      const row = h('label', { class: 'studio-check studio-picture-row' }, input, ctrl.name);
      return { ctrl, input, value, row };
    }
    if (ctrl.type === 'menu') {
      input = h('select', { class: 'select-ide', 'aria-label': ctrl.name },
        ctrl.menu.map(m => h('option', { value: m.value }, m.label)));
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
      const reset = h('button', { type: 'button', class: 'btn-ide', onclick: async () => {
        cam.controls = {};
        await send({ reset: true });
      } }, 'Camera defaults');
      // Switches first: they decide which sliders are active
      const entries = [...rows.values()];
      body.replaceChildren(
        h('div', { class: 'studio-picture-switches' }, entries.filter(e => e.ctrl.type !== 'int').map(e => e.row)),
        h('div', { class: 'studio-picture-grid' }, entries.filter(e => e.ctrl.type === 'int').map(e => e.row)),
        h('div', { class: 'studio-picture-foot' },
          h('small', {}, 'Changes go to the camera at once and are kept for this camera. Turn off the automatic white balance or exposure to set them by hand.'),
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

function cameraCard(slot) {
  const cam = settings.cameras[slot.id];
  const isServer = id => cam.kind === 'server' && cam.device_id === id;
  const select = h('select', { class: 'select-ide', 'aria-label': `${slot.label} source` },
    h('option', { value: 'none' }, 'None'),
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
  const url = h('input', { class: 'input-text', type: 'url', placeholder: 'http://camera-ip/stream.mjpg', value: cam.url, hidden: cam.kind !== 'url' });
  const mirror = h('input', { type: 'checkbox', checked: cam.mirror });
  const rotation = h('select', { class: 'select-ide', 'aria-label': `${slot.label} rotation` },
    [0, 90, 180, 270].map(deg => h('option', { value: deg, selected: (cam.rotation || 0) === deg },
      deg === 0 ? 'Not rotated' : `Rotate ${deg}°${deg === 180 ? ' (upside down)' : ''}`)));
  const slider = (label, key, min, max, step) => {
    const input = h('input', { type: 'range', min, max, step, value: cam[key] ?? (key === 'zoom' ? 1 : 0), 'aria-label': `${slot.label} ${label}` });
    // Framing updates the preview live while dragging; no reconnect needed
    input.addEventListener('input', () => {
      cam[key] = Number(input.value);
      applyFraming($(`studioPreview-${slot.id}`), cam);
    });
    return { input, row: h('label', { class: 'studio-range' }, h('span', {}, label), input) };
  };
  const zoom = slider('Zoom', 'zoom', ZOOM_MIN, ZOOM_MAX, 0.05);
  const panX = slider('Left / right', 'pan_x', -1, 1, 0.02);
  const panY = slider('Up / down', 'pan_y', -1, 1, 0.02);
  const reset = h('button', { type: 'button', class: 'btn-ide', onclick: () => {
    Object.assign(cam, { zoom: 1, pan_x: 0, pan_y: 0 });
    zoom.input.value = 1;
    panX.input.value = 0;
    panY.input.value = 0;
    applyFraming($(`studioPreview-${slot.id}`), cam);
  } }, 'Show whole picture');

  // Rotation and mirror only change the framing; the camera stays connected
  const reframe = () => {
    cam.mirror = mirror.checked;
    cam.rotation = Number(rotation.value);
    applyFraming($(`studioPreview-${slot.id}`), cam);
  };

  const picture = pictureControls(slot, cam);

  const update = () => {
    const value = select.value;
    const [kind, ...rest] = value.split(':');
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
      cam.kind = value;
    }
    cam.url = url.value.trim();
    cam.mirror = mirror.checked;
    cam.rotation = Number(rotation.value);
    url.hidden = cam.kind !== 'url';
    picture.refresh();
    showPreview(slot.id);
  };
  select.addEventListener('change', update);
  url.addEventListener('change', update);
  mirror.addEventListener('change', reframe);
  rotation.addEventListener('change', reframe);

  return h('div', { class: 'studio-cam' },
    h('div', { class: 'studio-cam-head' }, h('strong', {}, slot.label), h('span', {}, slot.hint)),
    h('div', { class: 'studio-preview', id: `studioPreview-${slot.id}` }),
    select, url,
    h('div', { class: 'studio-cam-opts' }, rotation, h('label', { class: 'studio-check' }, mirror, 'Mirror image')),
    h('div', { class: 'studio-framing' }, zoom.row, panX.row, panY.row, reset),
    picture,
    slot.straighten ? straightenControls(slot, cam) : null,
    slot.straighten ? dartZoomControls(cam) : null
  );
}

function renderCameras() {
  const host = $('studioCameras');
  if (!host) return;
  SLOTS.forEach(s => stopPreview(s.id));
  host.replaceChildren(...SLOTS.map(cameraCard));
  SLOTS.forEach(s => showPreview(s.id));
}

async function refreshCameras() {
  await loadServerCams();
  // Browser cameras are listed only when this page may use them (localhost / https)
  devices = await listDevices(false).catch(() => []);
  renderCameras();
}

async function allowCameras() {
  try {
    devices = await listDevices(true);
    renderCameras();
    if (!devices.length) toast.warning('This browser has no camera.');
  } catch (err) {
    toast.error(`Camera access was refused: ${err.message || err.name}`);
  }
}

// --- Players -----------------------------------------------------------------
function renderPlayers() {
  const host = $('studioPlayers');
  if (!host) return;
  if (!settings.players.length) {
    host.replaceChildren(h('div', { class: 'studio-empty' }, 'No players yet. Use + Add player to add them with their pictures; the Studio shows them when their Autodarts name matches.'));
    return;
  }
  host.replaceChildren(...settings.players.map(p => h('div', { class: 'studio-player' },
    p.image ? h('img', { src: imageUrl(p.image), alt: '' }) : h('div', { class: 'studio-player-noimg' }, (p.name[0] || '?').toUpperCase()),
    h('div', { class: 'studio-player-info' },
      h('strong', {}, p.name, p.country ? h('span', { class: 'studio-country' }, p.country) : null),
      h('span', {}, [p.nickname && `“${p.nickname}”`, p.club].filter(Boolean).join(' · ') || 'No profile yet'),
      h('span', {}, [p.alias ? `Autodarts: ${p.alias}` : 'Autodarts: same name', p.mockup ? 'mockup photo ✓' : ''].filter(Boolean).join(' · '))
    ),
    h('div', { class: 'studio-player-actions' },
      h('button', { type: 'button', class: 'btn-ide', onclick: () => editPlayer(p) }, 'Edit'),
      h('button', { type: 'button', class: 'btn-ide btn-ide-danger', onclick: () => removePlayer(p) }, 'Delete')
    )
  )));
}

// Profile inputs carry the field name the server stores (core/studio.py PROFILE_FIELDS)
const profileInputs = () => document.querySelectorAll('#tab-studio-players [data-profile]');

function resetForm() {
  editing = null;
  pickedFile = null;
  pickedMockup = null;
  $('studioPlayerMockupFile').value = '';
  $('studioPlayerMockup').replaceChildren(h('span', {}, 'Photo'));
  $('studioPlayerName').value = '';
  profileInputs().forEach(input => { input.value = ''; });
  $('studioPlayerFile').value = '';
  $('studioPlayerPic').replaceChildren(h('span', {}, 'PNG'));
  $('studioPlayerSave').textContent = 'Add player';
  $('studioPlayerForm').hidden = true;
  $('studioPlayerAdd').hidden = false;
}

// The form opens only to add or edit a player, so the list of players comes first
function openForm(title) {
  $('studioPlayerFormTitle').textContent = title;
  $('studioPlayerForm').hidden = false;
  $('studioPlayerAdd').hidden = true;
  $('studioPlayerForm').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  $('studioPlayerName').focus({ preventScroll: true });
}

function addPlayer() {
  resetForm();
  openForm('New player');
}

function editPlayer(p) {
  editing = p.id;
  pickedFile = null;
  $('studioPlayerName').value = p.name;
  profileInputs().forEach(input => { input.value = p[input.dataset.profile] || ''; });
  $('studioPlayerFile').value = '';
  $('studioPlayerPic').replaceChildren(p.image ? h('img', { src: imageUrl(p.image), alt: '' }) : h('span', {}, 'PNG'));
  pickedMockup = null;
  $('studioPlayerMockupFile').value = '';
  $('studioPlayerMockup').replaceChildren(p.mockup ? h('img', { src: imageUrl(p.mockup), alt: '' }) : h('span', {}, 'Photo'));
  $('studioPlayerSave').textContent = 'Save player';
  openForm(`Edit ${p.name}`);
}

async function savePlayer() {
  const name = $('studioPlayerName').value.trim();
  if (!name) { toast.warning('Enter the player name.'); return; }
  const form = new FormData();
  form.append('name', name);
  profileInputs().forEach(input => form.append(input.dataset.profile, input.value.trim()));
  if (pickedFile) form.append('image', pickedFile, pickedFile.name);
  if (pickedMockup) form.append('mockup', pickedMockup, pickedMockup.name);
  try {
    await api(editing ? `/api/studio/players/${editing}` : '/api/studio/players', { body: form, timeout: 30000 });
    toast.success(editing ? 'Player saved.' : 'Player added.');
    resetForm();
    await load();
  } catch (err) {
    toast.error(err.message);
  }
}

async function removePlayer(p) {
  const ok = await confirmDialog({ title: `Delete ${p.name}?`, body: 'The player and their picture are removed from the Studio.', confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  try {
    await api(`/api/studio/players/${p.id}`, { method: 'DELETE' });
    if (editing === p.id) resetForm();
    await load();
  } catch (err) {
    toast.error(err.message);
  }
}

// --- Overlay settings ---------------------------------------------------------
// Automatic direction picks the layout itself during a match (board while throwing, split at takeout),
// so the fixed layout only applies with it switched off
function syncLayoutChoice() {
  const auto = $('studioAutoDirect').checked;
  $('studioLayout').disabled = auto;
  $('studioLayoutHint').hidden = !auto;
}

function renderOverlay() {
  $('studioTitle').value = settings.title;
  $('studioSubtitle').value = settings.subtitle;
  $('studioAccent').value = settings.accent;
  $('studioShowOverlay').checked = settings.show_overlay !== false;
  renderTexts();
  syncTextBoxes();
  $('studioAutoDirect').checked = settings.auto_direct;
  $('studioLayout').value = settings.layout;
  syncLayoutChoice();
  $('studioTheme').value = settings.theme;
  $('studioResolution').value = settings.camera_resolution;
  $('studioRelayFps').value = String(settings.relay_fps);
}

// --- Live draft for the demo outputs ---------------------------------------------------------
// Unsaved overlay and camera changes go to the demo outputs in this browser (the preview above and
// "Open demo") right away; real outputs and TVs only change on Save.
const draftChannel = 'BroadcastChannel' in window ? new BroadcastChannel('autoglow-studio-draft') : null;
let draftTimer = null;

function publishDraft() {
  if (!draftChannel || !settings) return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => draftChannel.postMessage({ type: 'draft', settings: { ...settings, ...formSettings() } }), 120);
}

function endDraft() {
  clearTimeout(draftTimer);
  draftChannel?.postMessage({ type: 'clear' });
}

function formSettings() {
  return {
    title: $('studioTitle').value.trim(),
    subtitle: $('studioSubtitle').value.trim(),
    accent: $('studioAccent').value,
    show_overlay: $('studioShowOverlay').checked,
    texts: readTexts(),
    hidden_texts: readHiddenTexts(),
    ...readToggles(),
    auto_direct: $('studioAutoDirect').checked,
    layout: $('studioLayout').value,
    theme: $('studioTheme').value,
    camera_resolution: $('studioResolution').value,
    relay_fps: Number($('studioRelayFps').value),
    cameras: settings.cameras,
    dart_zoom: settings.dart_zoom,
    players: settings.players
  };
}

async function saveSettings() {
  const body = formSettings();
  try {
    const saved = await api('/api/studio', { body });
    // The camera cards edit these camera objects: keep them and take over the saved values, else
    // later changes would go to objects that are no longer saved (every save after the first lost them)
    const cameras = settings.cameras;
    for (const slot of Object.keys(saved.cameras || {})) {
      if (cameras[slot]) cameras[slot] = Object.assign(cameras[slot], saved.cameras[slot]);
    }
    // The same for the dart zoom controls
    const dartZoom = settings.dart_zoom ? Object.assign(settings.dart_zoom, saved.dart_zoom) : saved.dart_zoom;
    settings = { ...settings, ...saved, cameras: { ...saved.cameras, ...cameras }, dart_zoom: dartZoom };
    renderMatch(settings);
    toast.success('Studio saved. The screens pick it up within a few seconds.');
    endDraft();
  } catch (err) {
    toast.error(err.message);
  }
}

// --- Texts ---------------------------------------------------------------------------------------
// One field per editable wording, grouped as the server lists them; empty means the default.
// A group's checkbox switches the overlay part those texts belong to (or an option of it).
function renderTexts() {
  const host = $('studioTexts');
  const defaults = settings.text_defaults || {};
  host.replaceChildren(...(settings.text_groups || []).map(group => {
    const t = group.toggle;
    const box = t ? h('input', { type: 'checkbox', 'data-setting': t.key, checked: settings[t.key] !== false }) : null;
    const node = h('div', { class: 'studio-text-group' },
      h('div', { class: 'studio-text-head' },
        h('div', { class: 'studio-subhead' }, group.name),
        box ? h('label', { class: `studio-check studio-text-toggle${t.show ? ' is-show' : ''}` }, box, t.label) : null
      ),
      group.where ? h('div', { class: 'studio-text-where' }, `Shown: ${group.where}`) : null,
      group.items.length ? h('div', { class: 'studio-fields' }, group.items.map(item => textRow(item.key, item.label,
        h('input', { class: 'input-text', 'data-text': item.key, maxlength: 80, placeholder: defaults[item.key] || '', value: settings.texts?.[item.key] || '' })
      ))) : null
    );
    // A hidden part keeps its texts editable, only greyed out
    if (box && t.show) {
      const sync = () => node.classList.toggle('is-off', !box.checked);
      box.addEventListener('change', sync);
      sync();
    }
    return node;
  }));
}

// One text field with the box in front of it that shows or hides this text on the screens
function textRow(key, label, input) {
  return h('div', { class: 'studio-text-row' },
    h('input', { type: 'checkbox', 'data-show-text': key, title: 'Show this text on the screens', 'aria-label': `Show ${label}` }),
    h('label', {}, label, input));
}

// Ticks every per-text box from the stored list (the event title boxes are in the page, the rest built above)
function syncTextBoxes() {
  const hidden = new Set(settings.hidden_texts || []);
  document.querySelectorAll('.studio-texts-panel [data-show-text]').forEach(box => {
    box.checked = !hidden.has(box.dataset.showText);
    box.closest('.studio-text-row').classList.toggle('is-hidden-text', !box.checked);
  });
}

function readHiddenTexts() {
  return [...document.querySelectorAll('.studio-texts-panel [data-show-text]')].filter(box => !box.checked).map(box => box.dataset.showText);
}

// The group checkboxes; settings without one on the page keep their stored value
function readToggles() {
  const values = {};
  for (const group of settings.text_groups || []) {
    if (group.toggle) values[group.toggle.key] = settings[group.toggle.key];
  }
  document.querySelectorAll('#studioTexts [data-setting]').forEach(box => { values[box.dataset.setting] = box.checked; });
  return values;
}

// Focusing a field makes the preview show where its text appears; moving to the next field keeps it there
let textBlurTimer = null;

function previewText(input) {
  clearTimeout(textBlurTimer);
  document.querySelectorAll('.studio-texts-panel label.is-previewed').forEach(l => l.classList.remove('is-previewed'));
  const label = input.closest('label');
  label?.classList.add('is-previewed');
  draftChannel?.postMessage({ type: 'focus-text', key: input.dataset.text || input.dataset.preview, label: label?.firstChild?.textContent?.trim() || '' });
}

function leaveText() {
  clearTimeout(textBlurTimer);
  textBlurTimer = setTimeout(() => {
    if (document.activeElement?.matches?.('.studio-texts-panel [data-text], .studio-texts-panel [data-preview]')) return;
    document.querySelectorAll('.studio-texts-panel label.is-previewed').forEach(l => l.classList.remove('is-previewed'));
    draftChannel?.postMessage({ type: 'focus-text', key: null });
  }, 250);
}

function readTexts() {
  const texts = {};
  document.querySelectorAll('#studioTexts [data-text]').forEach(input => {
    if (input.value.trim()) texts[input.dataset.text] = input.value.trim();
  });
  return texts;
}

async function cue(scene) {
  // The overlay switch is also a setting: keep the checkbox (and what Save sends) in step
  if (scene.startsWith('overlay:')) {
    settings.show_overlay = scene === 'overlay:show';
    $('studioShowOverlay').checked = settings.show_overlay;
  }
  try {
    await api('/api/studio/cue', { body: { scene } });
  } catch (err) {
    toast.error(err.message);
  }
}

async function load() {
  settings = await api('/api/studio');
  if (settings.output_url) $('studioOutputUrl').textContent = settings.output_url;
  renderOverlay();
  renderPlayers();
  renderMatch(settings);
}

// --- Game data status -----------------------------------------------------------
const STATUS_MS = 2000;
let statusTimer = null;

// One checklist step, styled like Setup › Autodarts: state is done, todo (needs you) or wait (not yet)
function step(state, title, detail, extra = [], action = null) {
  return h('li', { class: 'ad-step', 'data-state': state },
    h('span', { class: 'ad-step-mark', 'aria-hidden': 'true' }),
    h('div', { class: 'ad-step-body' },
      h('div', { class: 'ad-step-title' }, title),
      h('div', { class: 'ad-step-detail', title: String(detail) }, detail),
      ...extra.map(([label, value, warn]) => h('div', { class: `ad-step-events${warn ? ' is-warn' : ''}` }, `${label}: `, h('strong', {}, value)))),
    action);
}

// Detection on this computer: the Board Manager's cameras (and so the Autodarts cameras) run only while it runs
function autodartsStep(ad) {
  if (!ad?.reachable) return step('todo', 'Autodarts', 'Board Manager not found');
  if (ad.running) return step('done', 'Autodarts', 'Running');
  return step('todo', 'Autodarts', 'Stopped', [], h('span', { class: 'ad-step-action' }, startButton(refreshStatus)));
}

async function refreshStatus() {
  const host = $('studioStatus');
  if (!host) return;
  try {
    const [st, ad] = await Promise.all([api('/api/studio/state'), api('/api/studio/autodarts').catch(() => null)]);
    renderLiveMatch(st);
    // Servers from before the source details only report whether the extension is connected
    const src = st.source || { connected: !!st.source_connected };
    const names = (st.players || []).map(p => p.name).join(' vs ');
    const ago = src.updated_ago;
    const details = st.live || names ? [
      ['Score', (st.players || []).map(p => p.remaining ?? '–').join(' : ')],
      ['Legs / sets', (st.players || []).map(p => `${p.legs}/${p.sets}`).join(' : ')],
      ['Format', [st.variant, st.base_score, st.target].filter(Boolean).join(' · ') || 'Unknown', !st.target]
    ] : [];
    host.replaceChildren(
      step(src.connected ? 'done' : 'todo', 'Bridge extension', src.connected ? `Connected${src.extension_version ? ` (v${src.extension_version})` : ''}` : 'Not connected'),
      step(src.tab_attached ? 'done' : src.connected ? 'todo' : 'wait', 'Autodarts tab', src.tab_attached ? 'Open' : 'Not open'),
      autodartsStep(ad),
      step(st.live ? 'done' : 'wait', 'Match', st.live ? (names || 'Running') : names ? `Over: ${names}` : 'None', details)
    );
    const last = $('studioLastData');
    if (last) {
      last.textContent = typeof ago === 'number' ? `Last data ${Math.round(ago)} s ago` : 'Nothing received yet';
      last.classList.toggle('is-warn', typeof ago !== 'number');
    }
  } catch {
    // Shown again on the next refresh
  }
}

// --- Page -------------------------------------------------------------------
let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  $('studioPlayerMockupFile').addEventListener('change', e => {
    pickedMockup = e.target.files[0] || null;
    if (pickedMockup) $('studioPlayerMockup').replaceChildren(h('img', { src: URL.createObjectURL(pickedMockup), alt: '' }));
  });
  $('studioPlayerFile').addEventListener('change', e => {
    pickedFile = e.target.files[0] || null;
    if (pickedFile) $('studioPlayerPic').replaceChildren(h('img', { src: URL.createObjectURL(pickedFile), alt: '' }));
  });
  $('studioPlayerSave').addEventListener('click', savePlayer);
  $('studioPlayerCancel').addEventListener('click', resetForm);
  $('studioPlayerAdd').addEventListener('click', addPlayer);
  document.querySelectorAll('.studio-save').forEach(btn => btn.addEventListener('click', saveSettings));
  // Text fields and the event title/subtitle: focusing one shows where it appears in the preview
  const textsPanel = document.querySelector('.studio-texts-panel');
  textsPanel.addEventListener('focusin', e => { if (e.target.matches('[data-text], [data-preview]')) previewText(e.target); });
  textsPanel.addEventListener('focusout', e => { if (e.target.matches('[data-text], [data-preview]')) leaveText(); });
  textsPanel.addEventListener('change', e => {
    if (e.target.matches('[data-show-text]')) e.target.closest('.studio-text-row').classList.toggle('is-hidden-text', !e.target.checked);
  });
  $('studioTextsReset').addEventListener('click', () => {
    document.querySelectorAll('#studioTexts [data-text]').forEach(input => { input.value = ''; });
    publishDraft();
  });
  // Overlay and camera controls update the demo outputs live (the Players page has its own saving)
  for (const id of ['tab-studio-broadcast', 'tab-studio-cameras']) {
    for (const type of ['input', 'change']) $(id).addEventListener(type, publishDraft);
  }
  $('studioAutoDirect').addEventListener('change', syncLayoutChoice);
  addEventListener('pagehide', endDraft);
  document.querySelectorAll('#tab-studio-broadcast [data-cue]').forEach(btn => btn.addEventListener('click', () => cue(btn.dataset.cue)));
  $('studioAllowCams').addEventListener('click', allowCameras);
  $('studioAllowCams').hidden = !navigator.mediaDevices?.getUserMedia;
  $('studioRefreshCams').addEventListener('click', refreshCameras);
  $('studioResolution').addEventListener('change', () => {
    settings.camera_resolution = $('studioResolution').value;
    SLOTS.forEach(sl => showPreview(sl.id));
  });
  $('studioOutputUrl').textContent = `${location.origin}/studio/live`;
}

// paneId: the Studio sub-page being opened (broadcast, match, players or cameras)
async function renderStudio(paneId) {
  wire();
  clearInterval(statusTimer);
  // Camera previews keep cameras busy: only on the Cameras page
  if (paneId !== 'tab-studio-cameras') SLOTS.forEach(s => stopPreview(s.id));
  showPreviewFrame(paneId === 'tab-studio-broadcast');
  try {
    // Loaded when entering the Studio; switching between its pages keeps unsaved changes
    if (!settings) await load();
    if (paneId === 'tab-studio-cameras') await refreshCameras();
    if (paneId === 'tab-studio-match') {
      refreshStatus();
      statusTimer = setInterval(refreshStatus, STATUS_MS);
    }
  } catch (err) {
    toast.error(`Could not load the Studio: ${err.message}`);
  }
}

// The output preview runs a demo and streams the cameras: only while the Broadcast page is open
function showPreviewFrame(on) {
  const frame = $('studioFrame');
  const src = on ? frame.dataset.src : 'about:blank';
  if (frame.getAttribute('src') !== src) frame.setAttribute('src', src);
}

// Cameras stay busy while previewed; free them when the page is left
function leaveStudio() {
  showPreviewFrame(false);
  endDraft();
  settings = null; // Unsaved changes are dropped; the next visit starts from what is saved
  clearInterval(statusTimer);
  SLOTS.forEach(s => stopPreview(s.id));
}

export function initStudio() {
  window.renderStudio = renderStudio;
  window.leaveStudio = leaveStudio;
}
