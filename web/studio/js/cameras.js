// AutoGlow Studio output - the two camera views, their layouts and the blurred idle background.
// Layouts (split / board / player) move the views with transform + clip-path only, which TVs animate smoothly.

import { ctx, el } from './ctx.js';
import { applyFraming } from './framing.js';
import { drawSoft, isReady, setMedia } from './fill.js';
import { outputDelay, resetDartZoom } from './darts.js';
import { createLiveCamera, h264Supported, MEDIA_SELECTOR } from './livecam.js';

const BLUR_MS = 150;
const LAYOUTS = ['split', 'board', 'player'];

let camsBox = null;
let boxes = {};
let cameraKey = '';
const streams = [];
let blurCanvas = null;
let blurTimer = null;

export function initCameras(cams, canvas) {
  camsBox = cams;
  boxes = { board: cams.querySelector('#camBoard'), player: cams.querySelector('#camPlayer') };
  blurCanvas = canvas;
}

// A slot is in use when it has a source; "No camera" (or none chosen yet) leaves it out of every layout
export const hasCamera = cam => !!cam && (((cam.kind === 'server' || cam.kind === 'device') && !!cam.device_id) || (cam.kind === 'url' && !!cam.url));

// Which cameras are in use: 'both', 'board', 'player' or 'none'
export function camerasInUse() {
  const cams = ctx.settings?.cameras || {};
  const board = hasCamera(cams.board), player = hasCamera(cams.player);
  return board && player ? 'both' : board ? 'board' : player ? 'player' : 'none';
}

// The layout that can be shown with the cameras in use: one camera always fills the screen, and with
// none the overlays keep their split places over the background
export function fitLayout(layout) {
  const want = LAYOUTS.includes(layout) ? layout : 'split';
  const use = camerasInUse();
  return use === 'both' ? want : use === 'none' ? 'split' : use;
}

// Shows a layout and returns the one actually shown
export function setLayout(layout) {
  const name = fitLayout(layout);
  const use = camerasInUse();
  if (camsBox.dataset.layout !== name) camsBox.dataset.layout = name;
  if (camsBox.dataset.cams !== use) camsBox.dataset.cams = use;
  return name;
}

function emptyCam(box, title, note, action) {
  const empty = el('div', 'cam-empty');
  empty.append(el('span', null, title));
  if (note) empty.append(el('small', null, note));
  if (action) {
    const btn = el('button', 'cam-action', action.label);
    btn.type = 'button';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = action.busy;
      const ok = await action.run();
      btn.textContent = ok ? action.done : action.label;
      btn.disabled = ok;
    });
    empty.append(btn);
  }
  box.replaceChildren(empty);
}

// The Board Manager streams its cameras only while Autodarts runs; this is its Start button
const STOPPED = 'Autodarts is stopped';
async function startAutodarts() {
  try {
    const res = await fetch('/api/studio/autodarts/start', { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}

function stopStreams() {
  while (streams.length) streams.pop().getTracks().forEach(t => t.stop());
  // Close the MJPEG connections so AutoGlow can release cameras that are no longer shown
  Object.values(boxes).forEach(box => {
    box.querySelectorAll('img').forEach(img => { img.onerror = null; img.src = ''; });
    box.querySelectorAll('canvas.cam-live').forEach(c => c.closeStream());
  });
}

// Cameras that could not be played as H.264 here: they stay on MJPEG until the page is reloaded
const mjpegOnly = new Set();

// Camera on the AutoGlow computer, decoded off the main thread (livecam.js): as H.264 from its graphics
// chip when it can encode and this browser can decode it, else as MJPEG
function serverCamera(box, cam, title, key) {
  // With the dart zoom on, every camera runs `delay` seconds late (the same for all, so they stay in sync)
  const delay = outputDelay();
  const query = `cam=${encodeURIComponent(cam.device_id)}&res=${encodeURIComponent(ctx.settings?.camera_resolution || '720p')}${delay ? `&delay=${delay}` : ''}&t=${Date.now()}`;
  const retry = () => { if (cameraKey === key) serverCamera(box, cam, title, key); };
  if (ctx.settings?.h264_cameras && h264Supported() && !mjpegOnly.has(cam.device_id)) {
    const video = createLiveCamera(`/api/studio/video?${query}`, {
      format: 'h264',
      onError: (reason, status) => {
        video.closeStream();
        // The camera itself is fine but not as H.264 here (no encoder, or this browser cannot play
        // it): MJPEG instead
        if (status === 415 || status === 0 || reason.startsWith('No H.264')) {
          mjpegOnly.add(cam.device_id);
          retry();
        } else {
          showCameraError(box, title, reason, retry, status);
        }
      },
      onEnded: () => { video.closeStream(); reportCameraProblem(title, 'Stream ended or stalled', 'ended'); setTimeout(retry, 1000); }
    });
    setMedia(box, video);
    return;
  }
  const url = `/api/studio/stream?${query}`;
  const canvas = createLiveCamera(url, {
    onError: (reason, status) => showError(reason, status),
    // AutoGlow restarted or the camera went away: connect again while it is still the chosen one
    onEnded: () => { canvas.closeStream(); reportCameraProblem(title, 'Stream ended or stalled', 'ended'); setTimeout(retry, 1000); }
  });
  const showError = (reason, status) => {
    canvas.closeStream();
    showCameraError(box, title, reason, retry, status);
  };
  setMedia(box, canvas);
}

// Camera problems also go to the AutoGlow log: a TV has no developer tools to see them
const reported = new Map();
function reportCameraProblem(title, reason, status) {
  const key = `${title}|${reason}|${status}`;
  if (Date.now() - (reported.get(key) || 0) < 60000) return;
  reported.set(key, Date.now());
  fetch('/api/studio/output-log', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ camera: title, message: reason || '', status: status ?? null, secure: window.isSecureContext, webcodecs: typeof VideoDecoder !== 'undefined' })
  }).catch(() => {});
}

// Why a camera shows no picture, with Autodarts' Start button when its cameras are stopped; tried again
function showCameraError(box, title, reason, retry, status) {
  reportCameraProblem(title, reason, status);
  const action = (reason || '').startsWith(STOPPED)
    ? { label: 'Start Autodarts', busy: 'Starting…', done: 'Started', run: async () => { const ok = await startAutodarts(); if (ok) setTimeout(retry, 1500); return ok; } }
    : null;
  emptyCam(box, title, reason || 'Camera not reachable', action);
  // Try again while this camera is still the chosen one (e.g. Autodarts let go of it)
  setTimeout(retry, 5000);
}

async function browserCamera(box, cam, title) {
  if (!navigator.mediaDevices?.getUserMedia) {
    emptyCam(box, title, 'This is a camera of another browser. In AutoGlow › Studio choose a camera of the AutoGlow computer to show it on every device.');
    return;
  }
  const want = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  try {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { ...want, deviceId: { exact: cam.device_id } }, audio: false });
    } catch (err) {
      // Device ids can change; fall back to the camera with the same name
      const devices = await navigator.mediaDevices.enumerateDevices();
      const match = devices.find(d => d.kind === 'videoinput' && cam.label && d.label === cam.label);
      if (!match) throw err;
      stream = await navigator.mediaDevices.getUserMedia({ video: { ...want, deviceId: { exact: match.deviceId } }, audio: false });
    }
    streams.push(stream);
    const video = el('video');
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = stream;
    setMedia(box, video);
  } catch (err) {
    emptyCam(box, title, `${cam.label || 'Camera'} not available: ${err.message || err.name}`);
  }
}

function startCamera(box, cam, title, chroma) {
  applyFraming(box, cam);
  box.dataset.kind = cam.kind || 'none';
  if (chroma) { box.replaceChildren(); return; }
  if (cam.kind === 'server' && cam.device_id) {
    serverCamera(box, cam, title, cameraKey);
  } else if (cam.kind === 'device' && cam.device_id) {
    browserCamera(box, cam, title);
  } else if (cam.kind === 'url' && cam.url) {
    // Video files/streams play in <video>; anything else (MJPEG, snapshots) as an image
    const isVideo = /\.(mp4|webm|ogg|m3u8)(\?|$)/i.test(cam.url);
    const media = el(isVideo ? 'video' : 'img');
    if (isVideo) { media.muted = true; media.autoplay = true; media.loop = true; media.playsInline = true; }
    media.src = cam.url;
    media.onerror = () => emptyCam(box, title, `Stream not reachable: ${cam.url}`);
    setMedia(box, media);
  } else {
    emptyCam(box, title, 'Choose a camera in AutoGlow › Studio');
  }
}

// What decides the stream itself; framing (rotation, zoom, pan, mirror) changes without reconnecting
const streamKey = cam => cam && [cam.kind, cam.device_id, cam.label, cam.url];

export function applyCameras(chroma) {
  const cams = ctx.settings?.cameras || {};
  applyFraming(boxes.board, cams.board || {});
  applyFraming(boxes.player, cams.player || {});
  const key = JSON.stringify([streamKey(cams.board), streamKey(cams.player), ctx.settings?.camera_resolution, chroma, outputDelay()]);
  if (key === cameraKey) return;
  cameraKey = key;
  resetDartZoom();
  stopStreams();
  for (const [slot, title] of [['board', 'Board camera'], ['player', 'Player camera']]) {
    if (hasCamera(cams[slot])) startCamera(boxes[slot], cams[slot], title, chroma);
    else boxes[slot].replaceChildren();
  }
}

// --- Idle background: the board camera, softly blurred (fill.js), behind the idle screen ---------------
function drawBlur() {
  const source = boxes.board.querySelector(MEDIA_SELECTOR) || boxes.player.querySelector(MEDIA_SELECTOR);
  if (!blurCanvas || !isReady(source)) return;
  const box = source.closest('.cam');
  if (drawSoft(source, blurCanvas, Number(box?.dataset.rot || 0), box?.classList.contains('mirror') ? -1 : 1)) {
    blurCanvas.classList.add('has-frame');
  }
}

export function setBlur(on) {
  clearInterval(blurTimer);
  blurTimer = null;
  if (on) {
    drawBlur();
    blurTimer = setInterval(drawBlur, BLUR_MS);
  }
}
