// AutoGlow Studio - blurred fill behind a camera picture, shared by the output and the Studio previews.
// A zoomed-out, turned or portrait picture does not cover its frame; instead of empty bars the frame
// shows a blurred, darkened copy of the same picture (like TV broadcasts do). The copy is drawn from the
// picture already on screen into a small canvas, so there is no second stream and little work for TVs.

import { MEDIA_SELECTOR } from './livecam.js';

// The fill is blurred and dark: a few updates a second are enough (each one copies the whole picture)
const FILL_MS = 400;

// The picture is first drawn tiny (averaging it: a strong blur for free), then softened into the
// target canvas; stretched to the frame it stays smooth, without a visible pixel grid
const tiny = document.createElement('canvas');
tiny.width = 32;
tiny.height = 18;

function drawCover(g, media, w, h, rot, flip) {
  // A live camera lends its decoded frame (no second decode); pictures and videos are drawn as they are
  const source = media.bitmap || media;
  const sw = source.videoWidth || source.naturalWidth || source.displayWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.displayHeight || source.height;
  const sideways = rot === 90 || rot === 270;
  // Cover the canvas with the picture as it appears on screen (turned and mirrored, proportions kept)
  const scale = Math.max(w / (sideways ? sh : sw), h / (sideways ? sw : sh));
  g.save();
  g.translate(w / 2, h / 2);
  g.scale(flip, 1);
  g.rotate(rot * Math.PI / 180);
  g.drawImage(source, -sw * scale / 2, -sh * scale / 2, sw * scale, sh * scale);
  g.restore();
}

export function isReady(source) {
  if (!source) return false;
  return source.tagName === 'VIDEO' ? source.readyState >= 2 : source.complete && source.naturalWidth > 0;
}

// Draw a soft blurred version of `source` into `target`. False when the picture cannot be drawn.
export function drawSoft(source, target, rot = 0, flip = 1) {
  try {
    const t = tiny.getContext('2d');
    t.imageSmoothingEnabled = true;
    t.imageSmoothingQuality = 'high';
    drawCover(t, source, tiny.width, tiny.height, rot, flip);
    const g = target.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    // Browsers without canvas filters still get the smooth upscale of the tiny picture
    if ('filter' in g) g.filter = 'blur(3px)';
    // Drawn a little larger than the canvas, so the blurred edges stay outside
    const m = 8;
    g.drawImage(tiny, -m, -m, target.width + 2 * m, target.height + 2 * m);
    if ('filter' in g) g.filter = 'none';
    return true;
  } catch {
    return false; // A camera from another site cannot be drawn
  }
}

// --- Fill behind the pictures of camera boxes ------------------------------------------------------
const watched = new Set();
let timer = null;

function fillCanvas(box) {
  if (!box._fill) {
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 90;
    canvas.className = 'cam-fill';
    box._fill = canvas;
  }
  return box._fill;
}

function tick() {
  for (const box of watched) {
    if (!box.isConnected) continue;
    const canvas = box._fill;
    const source = box.querySelector(MEDIA_SELECTOR);
    if (!canvas?.isConnected || !isReady(source)) continue;
    drawSoft(source, canvas, Number(box.dataset.rot || 0), box.classList.contains('mirror') ? -1 : 1);
  }
}

// Show these nodes (the picture) in the box, with the blurred fill behind them
export function setMedia(box, ...nodes) {
  const canvas = fillCanvas(box);
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  box.replaceChildren(canvas, ...nodes);
  watched.add(box);
  if (!timer) timer = setInterval(tick, FILL_MS);
}
