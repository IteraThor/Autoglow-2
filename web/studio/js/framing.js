// AutoGlow Studio - camera framing, shared by the output (live page) and the preview on the Studio page.
// The picture is shown whole at zoom 1 (nothing cut off, also when turned 90 degrees); zooming in crops it,
// and pan moves the crop. Pan is -1..1 of half the frame, so 1 shows the right (or bottom) edge.
//
// Straighten (cam.warp): a camera looking at the board from the side sees it as an oval. Four points
// marked on the double ring (at 20, 6, 3 and 11, in the raw picture) say how it is tilted; the picture is
// then turned towards a front view by a perspective transform (CSS matrix3d, done by the graphics chip).
// Strength 0 leaves it as it is, 1 shows the board as seen straight from the front. The warped picture
// is zoomed in just enough that the part on screen (after zoom, pan and rotation) has no empty corners;
// zoomed in far, little or nothing needs cropping. It zooms around the middle of what is on screen.

import { setSharpWarp } from './sharpwarp.js';
import { MEDIA_SELECTOR } from './livecam.js';

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;
const WARP_ZOOM_MAX = 4;

// Turned 90/270 degrees the picture element is laid out portrait (frame height x frame width, see the CSS)
// and a 16:9 picture covers only 9/16 of it, while translate() percentages refer to the element's size.
// So a pan of one picture half is 9/16 of the usual percentage on both axes.
const SIDEWAYS_RATIO = 1080 / 1920;

export function applyFraming(box, cam) {
  if (!box) return;
  const rot = Number(cam.rotation || 0);
  const sideways = rot === 90 || rot === 270;
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(cam.zoom) || 1));
  const panX = Math.max(-1, Math.min(1, Number(cam.pan_x) || 0));
  const panY = Math.max(-1, Math.min(1, Number(cam.pan_y) || 0));
  // Panning moves the picture the other way: pan right shows more of the right side
  // At pan 1 the zoomed picture's edge lines up with where the unzoomed picture's edge was
  const ratio = sideways ? SIDEWAYS_RATIO : 1;
  const tx = -panX * 50 * (zoom - 1) * ratio;
  const ty = -panY * 50 * (zoom - 1) * ratio;
  box.dataset.rot = String(rot);
  box.classList.toggle('mirror', !!cam.mirror);
  box.style.setProperty('--zoom', String(zoom));
  box.style.setProperty('--tx', `${tx.toFixed(3)}%`);
  box.style.setProperty('--ty', `${ty.toFixed(3)}%`);
  box._framing = { rot, flip: cam.mirror ? -1 : 1, zoom, tx, ty };
  box._framingCam = cam;
  watchBox(box);
  applyWarp(box, cam);
}

// --- Straighten -------------------------------------------------------------------------------------
// The warp depends on the picture's size on screen and its proportions, both only known once a frame
// arrived; so it is worked out again when the picture loads or the box changes size.
function watchBox(box) {
  if (box._framingWatched) return;
  box._framingWatched = true;
  const again = () => { if (box._framingCam) applyWarp(box, box._framingCam); };
  // Load events do not bubble, but they can be caught on the way down
  box.addEventListener('load', again, true);
  box.addEventListener('loadedmetadata', again, true);
  if ('ResizeObserver' in window) new ResizeObserver(again).observe(box);
}

// Valid warp settings: four [x, y] points (0..1 of the raw picture), a strength 0..1 and how much to
// sharpen the stretched far side 0..1 (sharpwarp.js), else null
export function warpOf(cam) {
  const w = cam?.warp;
  const pts = w?.points;
  if (!Array.isArray(pts) || pts.length !== 4) return null;
  if (!pts.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) return null;
  const strength = Math.max(0, Math.min(1, Number(w.strength) || 0));
  const sharpen = Math.max(0, Math.min(1, Number(w.sharpen ?? 0.5) || 0));
  return strength > 0 ? { points: pts, strength, sharpen } : null;
}

function applyWarp(box, cam) {
  const media = box.querySelector(MEDIA_SELECTOR);
  const warp = warpOf(cam);
  let css = '';
  box._warpM = null;
  if (warp && media) {
    const w = media.offsetWidth;
    const h = media.offsetHeight;
    const nw = media.videoWidth || media.naturalWidth || 16;
    const nh = media.videoHeight || media.naturalHeight || 9;
    const m = w > 0 && h > 0 ? warpMatrix(warp, w, h, nw / nh, visibleRect(box, w, h)) : null;
    if (m) css = toMatrix3d(m);
    box._warpM = m;
  }
  // Drawn by WebGL with the far side sharpened when possible; the CSS warp below stays as the fallback
  setSharpWarp(box, media, box._warpM, warp?.sharpen ?? 0);
  const key = css || 'none';
  if (box._warpKey === key) return;
  box._warpKey = key;
  if (css) box.style.setProperty('--warp', css);
  else box.style.removeProperty('--warp');
}

// The part of the picture element shown in the box, in the element's own px around its centre (where
// the warp works): the box undone by the framing transform (translate, zoom, mirror, rotate; see the CSS).
// Null when it cannot be measured; the whole picture then counts as on screen.
function visibleRect(box, w, h) {
  const f = box._framing;
  const bw = box.clientWidth;
  const bh = box.clientHeight;
  if (!f || !bw || !bh) return null;
  const T = [f.tx / 100 * w, f.ty / 100 * h];
  const a = -f.rot * Math.PI / 180;
  const xs = [];
  const ys = [];
  for (const [vx, vy] of [[-bw / 2, -bh / 2], [bw / 2, -bh / 2], [bw / 2, bh / 2], [-bw / 2, bh / 2]]) {
    const x = f.flip * (vx - T[0]) / f.zoom;
    const y = (vy - T[1]) / f.zoom;
    xs.push(x * Math.cos(a) - y * Math.sin(a));
    ys.push(x * Math.sin(a) + y * Math.cos(a));
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// --- Dart zoom: where a point of the board is in the box ------------------------------------------
// Board coordinates as Autodarts reports darts: 1.0 is the outer edge of the double ring, +y points to
// the 20, +x to the 6. The four points marked for Straighten are exactly (0,1), (1,0), (0,-1), (-1,0).
const BOARD_MARKS = [[0, 1], [1, 0], [0, -1], [-1, 0]];

// Element px (around its centre, before the warp) -> box px from the box centre: through the warp and
// the framing (rotate, mirror, zoom, then the pan translate: the CSS order, applied right to left)
function elementToBox(box, w, h, p) {
  const f = box._framing;
  let q = p;
  if (q && box._warpM) q = project(box._warpM, q);
  if (!q) return null;
  const a = f.rot * Math.PI / 180;
  const rx = q[0] * Math.cos(a) - q[1] * Math.sin(a);
  const ry = q[0] * Math.sin(a) + q[1] * Math.cos(a);
  return [f.tx / 100 * w + f.zoom * f.flip * rx, f.ty / 100 * h + f.zoom * ry];
}

// Where board point (x, y) and the picture are in the box (px from the box centre), or null when the
// board was not marked or the picture is not laid out yet. picture: [x0, y0, x1, y1], the part of the
// box the (warped) picture surely covers.
export function boardPointInBox(box, cam, x, y) {
  const pts = cam?.warp?.points;
  const media = box?.querySelector(MEDIA_SELECTOR);
  if (!Array.isArray(pts) || pts.length !== 4 || !media || !box._framing) return null;
  const w = media.offsetWidth;
  const h = media.offsetHeight;
  if (!w || !h) return null;
  const nw = media.videoWidth || media.naturalWidth || 16;
  const nh = media.videoHeight || media.naturalHeight || 9;
  const [cw, ch] = contentSize(w, h, nw / nh);
  const H = homography(BOARD_MARKS, pts.map(([u, v]) => [(u - 0.5) * cw, (v - 0.5) * ch]));
  if (!H) return null;
  const raw = project(H, [x, y]);
  const point = raw && elementToBox(box, w, h, raw);
  const corners = [[-cw / 2, -ch / 2], [cw / 2, -ch / 2], [cw / 2, ch / 2], [-cw / 2, ch / 2]].map(c => elementToBox(box, w, h, c));
  if (!point || corners.some(c => !c)) return null;
  // Inner bounds of the picture's outline (it can be a slanted quad after the warp)
  const xs = corners.map(c => c[0]).sort((a, b) => a - b);
  const ys = corners.map(c => c[1]).sort((a, b) => a - b);
  return { point, picture: [xs[1], ys[1], xs[2], ys[2]] };
}

// Zoom the box towards board point (x, y) by `zoom` over `ms` milliseconds; null zooms back out.
// The point moves to the middle as far as the picture allows: no edge of the picture comes into view
// (where the picture is narrower than the box anyway, it stays centred on that axis).
export function setDartFocus(box, cam, focus, ms = 700) {
  let dz = 1;
  let dx = 0;
  let dy = 0;
  const at = focus ? boardPointInBox(box, cam, focus.x, focus.y) : null;
  if (at) {
    dz = focus.zoom;
    const [x0, y0, x1, y1] = at.picture;
    const fit = (want, half, lo, hi) => {
      const min = half - dz * hi;    // the picture's far edge still reaches the box edge
      const max = -half - dz * lo;
      return min <= max ? Math.max(min, Math.min(max, want)) : -dz * (lo + hi) / 2;
    };
    dx = fit(-dz * at.point[0], box.clientWidth / 2, x0, x1);
    dy = fit(-dz * at.point[1], box.clientHeight / 2, y0, y1);
  }
  box.style.setProperty('--dart-ms', `${Math.round(ms)}ms`);
  box.style.setProperty('--dart-zoom', String(dz));
  box.style.setProperty('--dart-x', `${dx.toFixed(1)}px`);
  box.style.setProperty('--dart-y', `${dy.toFixed(1)}px`);
  return !!at;
}

// Where the picture sits in its element (object-fit: contain): its size in px
function contentSize(w, h, aspect) {
  return w / h > aspect ? [h * aspect, h] : [w, w / aspect];
}

// 3x3 homography (row-major, h33 = 1) for the element, in px around its centre (the transform origin).
// view: [x0, y0, x1, y1] of the element on screen (visibleRect), or null for all of it.
// Null when the points do not describe a usable board.
export function warpMatrix(warp, w, h, aspect, view = null) {
  const [cw, ch] = contentSize(w, h, aspect);
  const src = warp.points.map(([u, v]) => [(u - 0.5) * cw, (v - 0.5) * ch]);
  const target = frontView(src);
  if (!target) return null;
  const s = warp.strength;
  const dst = src.map((p, i) => [p[0] + s * (target[i][0] - p[0]), p[1] + s * (target[i][1] - p[1])]);
  const H = homography(src, dst);
  if (!H) return null;
  // The picture's corners after the warp; they must stay in front (w > 0) for a sane picture
  const corners = [[-cw / 2, -ch / 2], [cw / 2, -ch / 2], [cw / 2, ch / 2], [-cw / 2, ch / 2]];
  const quad = [];
  for (const c of corners) {
    const p = project(H, c);
    if (!p) return null;
    quad.push(p);
  }
  // What has to stay covered: the picture's area that is on screen (bars outside the picture stay bars)
  let [x0, y0, x1, y1] = [-cw / 2, -ch / 2, cw / 2, ch / 2];
  if (view) {
    const [vx0, vy0, vx1, vy1] = [Math.max(x0, view[0]), Math.max(y0, view[1]), Math.min(x1, view[2]), Math.min(y1, view[3])];
    if (vx1 - vx0 > 1 && vy1 - vy0 > 1) [x0, y0, x1, y1] = [vx0, vy0, vx1, vy1];
  }
  // Zoom around the middle of that area, so what is on screen stays in place
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const shift = ([x, y]) => [x - cx, y - cy];
  const k = coverScale(quad.map(shift), [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(shift));
  if (!k) return null;
  // Rows of H: x' = k(x'-cx)+cx, y' = k(y'-cy)+cy, in homogeneous form (the w row stays)
  const [g, hh, one] = [H[6], H[7], H[8]];
  return [
    k * H[0] + (1 - k) * cx * g, k * H[1] + (1 - k) * cx * hh, k * H[2] + (1 - k) * cx * one,
    k * H[3] + (1 - k) * cy * g, k * H[4] + (1 - k) * cy * hh, k * H[5] + (1 - k) * cy * one,
    g, hh, one
  ];
}

// The four marked points as they would look from the front: a square (the double ring's 20/6/3/11
// points) around the board centre, turned like the camera and about as big as marked
function frontView(src) {
  const center = intersect(src[0], src[2], src[1], src[3]);
  if (!center) return null;
  // Clockwise on screen (20, 6, 3, 11) or the other way round in a mirrored picture
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const [a, b] = [src[i], src[(i + 1) % 4]];
    area += a[0] * b[1] - b[0] * a[1];
  }
  if (Math.abs(area) < 1) return null;
  const dir = area > 0 ? 1 : -1;
  let radius = 0;
  let sx = 0;
  let sy = 0;
  src.forEach((p, i) => {
    const dx = p[0] - center[0];
    const dy = p[1] - center[1];
    radius += Math.log(Math.hypot(dx, dy)) / 4; // Geometric mean: the board keeps about its size
    const angle = Math.atan2(dy, dx) - dir * i * Math.PI / 2;
    sx += Math.cos(angle);
    sy += Math.sin(angle);
  });
  const base = Math.atan2(sy, sx);
  radius = Math.exp(radius);
  return src.map((_, i) => {
    const angle = base + dir * i * Math.PI / 2;
    return [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
  });
}

// Crossing point of the lines a1-a2 and b1-b2 (the two board diameters), or null
function intersect(a1, a2, b1, b2) {
  const d1 = [a2[0] - a1[0], a2[1] - a1[1]];
  const d2 = [b2[0] - b1[0], b2[1] - b1[1]];
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((b1[0] - a1[0]) * d2[1] - (b1[1] - a1[1]) * d2[0]) / den;
  if (t <= 0 || t >= 1) return null; // The diameters must cross between the points
  return [a1[0] + t * d1[0], a1[1] + t * d1[1]];
}

function project(H, [x, y]) {
  const w = H[6] * x + H[7] * y + H[8];
  if (w <= 1e-6) return null;
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

// Smallest zoom (around the centre) at which the convex quad covers the rectangle, or null
function coverScale(quad, rect) {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const [a, b] = [quad[i], quad[(i + 1) % 4]];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const sign = area > 0 ? 1 : -1;
  let k = 1;
  for (let i = 0; i < 4; i++) {
    const [a, b] = [quad[i], quad[(i + 1) % 4]];
    // Outward normal of this edge, and its distance from the centre
    const n = [sign * (b[1] - a[1]), -sign * (b[0] - a[0])];
    const d = n[0] * a[0] + n[1] * a[1];
    if (d <= 0) return null; // Centre outside the warped picture
    for (const r of rect) k = Math.max(k, (n[0] * r[0] + n[1] * r[1]) / d);
  }
  return k <= WARP_ZOOM_MAX ? k : null;
}

// Homography mapping the four src points onto the four dst points (8x8 linear system), or null
export function homography(src, dst) {
  const A = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    if (Math.abs(A[pivot][col]) < 1e-12) return null;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let c = col; c < 9; c++) A[r][c] -= f * A[col][c];
    }
  }
  const hv = A.map((row, i) => row[8] / row[i]);
  return [...hv, 1];
}

// CSS matrix3d (column-major) of a 2D homography
function toMatrix3d(H) {
  const v = [H[0], H[3], 0, H[6], H[1], H[4], 0, H[7], 0, 0, 1, 0, H[2], H[5], 0, H[8]];
  return `matrix3d(${v.map(n => +n.toPrecision(8)).join(',')})`;
}
