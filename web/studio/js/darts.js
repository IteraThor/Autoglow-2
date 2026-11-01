// AutoGlow Studio output - dart zoom. With it switched on (Studio › Cameras), the cameras and the
// scoreboard are shown `delay` seconds late, while the darts the Autodarts Board Manager reports arrive
// at once (state.darts). So each dart is known before the picture shows it: the board camera starts
// zooming to it `lead` seconds before the moment it was reported, holds, and zooms back out.

import { ctx } from './ctx.js';
import { setDartFocus } from './framing.js';

const MOVE_MAX = 0.8;     // s: longest zoom move
const MOVE_MIN = 0.3;
const OUT_MS = 900;

const seen = new Set();
const clockSamples = [];
let clockOffset = null;   // server clock minus this browser's clock, in seconds
let generation = 0;       // the newest focus; a zoom-out only applies to the focus that planned it
let timers = [];

// Dart zoom settings while it is on for this output (never in the demo, which has no real darts)
export function dartZoom() {
  const dz = ctx.settings?.dart_zoom;
  return dz?.enabled && !ctx.demo ? dz : null;
}

// How late this output shows the cameras and the scoreboard, in seconds
export const outputDelay = () => dartZoom()?.delay || 0;

const board = () => document.getElementById('camBoard');
const boardCam = () => ctx.settings?.cameras?.board || {};

function later(atSeconds, fn) {
  const ms = Math.max(0, atSeconds * 1000 - Date.now());
  const id = setTimeout(() => { timers = timers.filter(t => t !== id); fn(); }, ms);
  timers.push(id);
}

function focus(dart, dz, moveSeconds, outAt) {
  const gen = ++generation;
  setDartFocus(board(), boardCam(), { x: dart.x, y: dart.y, zoom: dz.zoom }, moveSeconds * 1000);
  later(outAt, () => {
    if (gen === generation) setDartFocus(board(), boardCam(), null, OUT_MS);
  });
}

// Zoom back out at once and forget planned moves (dart zoom switched off, camera changed)
export function resetDartZoom() {
  timers.forEach(clearTimeout);
  timers = [];
  generation++;
  const box = board();
  if (box) setDartFocus(box, boardCam(), null, 0);
}

// New darts from a state poll; serverTime is the server's clock when it answered
export function onDarts(darts, serverTime) {
  const now = Date.now() / 1000;
  if (typeof serverTime === 'number') {
    // The answer travelled a moment, so server minus local is at most the true offset: take the largest
    clockSamples.push(serverTime - now);
    if (clockSamples.length > 40) clockSamples.shift();
    clockOffset = Math.max(...clockSamples);
  }
  const dz = dartZoom();
  if (!dz || clockOffset === null || !Array.isArray(darts)) return;
  for (const dart of darts) {
    const key = `${dart.t}:${dart.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (typeof dart.x !== 'number' || typeof dart.y !== 'number') continue; // A miss: stay wide
    // When this output shows the moment the dart was reported (its clock), and when to start moving
    const shownAt = dart.t - clockOffset + dz.delay;
    if (shownAt + dz.hold < now) continue; // Too old (page just opened)
    const startAt = shownAt - dz.lead;
    const move = Math.max(MOVE_MIN, Math.min(MOVE_MAX, dz.lead));
    later(startAt, () => focus(dart, dz, move, shownAt + dz.hold));
  }
  if (seen.size > 200) [...seen].slice(0, 100).forEach(k => seen.delete(k));
}
