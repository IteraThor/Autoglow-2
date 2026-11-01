// AutoGlow Studio - Straighten drawn by WebGL, with the far side of the board sharpened.
// The CSS warp (framing.js) stretches the far side of the board, which the camera saw with few pixels,
// and the browser fills the gaps by plain bilinear blending: it looks soft. This draws the same warp into
// a canvas over the picture instead, in three GPU passes at the camera's own resolution and then the screen's:
//
// 1. Average: the board does not move, but every frame has sensor noise and JPEG artefacts. Each pixel is
//    blended with its running average, so the noise drops; where the picture changes (a dart, a hand)
//    the pixel follows the new frame at once, so nothing moving leaves a trail. MJPEG pictures give no
//    frame events, so a pixel identical to the last upload counts as the same frame and is skipped.
// 2. Sharpen: an unsharp mask on the averaged picture, as strong as that spot is stretched on screen -
//    none where it is not enlarged, most on the far side. Clamped to the neighbouring pixels: no halos.
// 3. Warp: each screen pixel works out where it lies in the camera picture (the inverse homography) and
//    samples it with AMD FidelityFX Super Resolution 1's edge-adaptive upscaler (EASU), which follows the
//    direction of edges instead of the pixel grid, so slanted and curved wires stay smooth, not stepped.
//
// The canvas sits in the picture's place and takes the same framing transform (zoom, pan, rotation,
// mirror, dart zoom) minus the warp. Without WebGL, or for a camera from another site, the CSS warp stays.

import { MEDIA_SELECTOR } from './livecam.js';

const MAX_SIDE = 2560;      // Canvas size cap (px): enough for 1440p screens, light on TVs
const IMG_FRAME_MS = 30;    // MJPEG pictures give no frame events; uploaded at most this often
const MEASURE_EVERY = 15;   // frames between two measurements of the box on screen (a layout read)

const VERT = `
attribute vec2 aPos;
uniform vec2 uElem;
varying vec2 vPos;
void main() {
  // Element px around its centre, y down (like the CSS warp); only the warp pass uses it
  vPos = vec2(aPos.x, -aPos.y) * 0.5 * uElem;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const HEAD = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
`;

// --- 1. Running average of the camera frames (camera resolution) --------------------------------------
// Pictures are in texture space throughout: row 0 is the top of the camera picture.
const FRAG_AVERAGE = HEAD + `
uniform sampler2D uCur;
uniform sampler2D uPrev;   // the frame uploaded before this one
uniform sampler2D uHist;   // running average so far
uniform vec2 uTexSize;
uniform float uBase;       // blend weight of a new frame on a still picture
uniform float uReset;
void main() {
  vec2 uv = gl_FragCoord.xy / uTexSize;
  vec3 cur = texture2D(uCur, uv).rgb;
  vec3 hist = texture2D(uHist, uv).rgb;
  if (uReset > 0.5) { gl_FragColor = vec4(cur, 1.0); return; }
  // The same picture uploaded again (MJPEG gives no frame events): nothing new to average in
  vec3 same = abs(cur - texture2D(uPrev, uv).rgb);
  if (max(same.r, max(same.g, same.b)) < 0.5 / 255.0) { gl_FragColor = vec4(hist, 1.0); return; }
  // Movement: compare 2x2 averages (noise cancels out there, a dart does not); then take the new frame
  vec2 c = 0.5 / uTexSize;
  float d = abs(luma(texture2D(uCur, uv + c).rgb) - luma(texture2D(uHist, uv + c).rgb));
  d = max(d, abs(luma(texture2D(uCur, uv - c).rgb) - luma(texture2D(uHist, uv - c).rgb)));
  float a = mix(uBase, 1.0, smoothstep(0.035, 0.09, d));
  gl_FragColor = vec4(mix(hist, cur, a), 1.0);
}`;

// --- 2. Sharpen as much as each spot is stretched on screen (camera resolution) -------------------------
const FRAG_SHARPEN = HEAD + `
uniform sampler2D uTex;
uniform mat3 uH;           // the warp: element px around the centre, before -> after
uniform vec2 uContent;     // the picture's size in the element (px)
uniform vec2 uTexSize;
uniform float uOutScale;   // canvas px per element px
uniform float uAmount;
vec2 project(vec2 p, out float w) { vec3 q = uH * vec3(p, 1.0); w = q.z; return q.xy / q.z; }
vec3 px(vec2 uv, float dx, float dy) { return texture2D(uTex, uv + vec2(dx, dy) / uTexSize).rgb; }
void main() {
  vec2 uv = gl_FragCoord.xy / uTexSize;
  // How far one camera pixel here is enlarged on screen
  vec2 e = (uv - 0.5) * uContent;
  vec2 one = uContent / uTexSize;
  float w0; float w1; float w2;
  vec2 p0 = project(e, w0);
  vec2 jx = (project(e + vec2(one.x, 0.0), w1) - p0) * uOutScale;
  vec2 jy = (project(e + vec2(0.0, one.y), w2) - p0) * uOutScale;
  float mag = sqrt(abs(jx.x * jy.y - jx.y * jy.x));
  float stretch = (w0 > 0.0 && w1 > 0.0 && w2 > 0.0) ? clamp(log2(max(mag, 1e-4)), 0.0, 2.0) : 0.0;
  vec3 c = px(uv, 0.0, 0.0);
  vec3 n = px(uv, 0.0, -1.0), s = px(uv, 0.0, 1.0), w = px(uv, -1.0, 0.0), ea = px(uv, 1.0, 0.0);
  vec3 nw = px(uv, -1.0, -1.0), ne = px(uv, 1.0, -1.0), sw = px(uv, -1.0, 1.0), se = px(uv, 1.0, 1.0);
  vec3 blur = (2.0 * (n + s + w + ea) + (nw + ne + sw + se)) / 12.0;
  vec3 sharp = c + uAmount * stretch * (c - blur);
  // No halos: stay within the 3x3 neighbourhood (a little leeway keeps edges crisp)
  vec3 lo = min(min(min(n, s), min(w, ea)), min(min(nw, ne), min(sw, se)));
  vec3 hi = max(max(max(n, s), max(w, ea)), max(max(nw, ne), max(sw, se)));
  sharp = clamp(sharp, min(lo, c) - 0.015, max(hi, c) + 0.015);
  gl_FragColor = vec4(clamp(sharp, 0.0, 1.0), 1.0);
}`;

// --- 3. Warp onto the screen with FSR 1 EASU (canvas resolution) ---------------------------------------
// Port of FsrEasuF from AMD FidelityFX Super Resolution 1 (MIT licence, (c) 2021 Advanced Micro Devices),
// with the input position taken from the homography per pixel instead of a fixed scale.
const FRAG_WARP = HEAD + `
uniform sampler2D uTex;
uniform mat3 uHinv;
uniform vec2 uContent;
uniform vec2 uTexSize;
varying vec2 vPos;

vec3 T(vec2 fp, float x, float y) { return texture2D(uTex, (fp + vec2(x, y) + 0.5) / uTexSize).rgb; }
float L(vec3 c) { return c.b * 0.5 + (c.r * 0.5 + c.g); }

void easuSet(inout vec2 dir, inout float len, float w, float lA, float lB, float lC, float lD, float lE) {
  float dc = lD - lC;
  float cb = lC - lB;
  float lenX = max(abs(dc), abs(cb));
  lenX = lenX > 0.0 ? 1.0 / lenX : 0.0;
  float dirX = lD - lB;
  dir.x += dirX * w;
  lenX = clamp(abs(dirX) * lenX, 0.0, 1.0);
  len += lenX * lenX * w;
  float ec = lE - lC;
  float ca = lC - lA;
  float lenY = max(abs(ec), abs(ca));
  lenY = lenY > 0.0 ? 1.0 / lenY : 0.0;
  float dirY = lE - lA;
  dir.y += dirY * w;
  lenY = clamp(abs(dirY) * lenY, 0.0, 1.0);
  len += lenY * lenY * w;
}

void easuTap(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len2, float lob, float clp, vec3 c) {
  vec2 v = vec2(off.x * dir.x + off.y * dir.y, off.x * -dir.y + off.y * dir.x) * len2;
  float d2 = min(v.x * v.x + v.y * v.y, clp);
  float wB = 0.4 * d2 - 1.0;
  float wA = lob * d2 - 1.0;
  wB *= wB;
  wA *= wA;
  wB = 1.5625 * wB - 0.5625;
  float w = wB * wA;
  aC += c * w;
  aW += w;
}

void main() {
  vec3 q = uHinv * vec3(vPos, 1.0);
  vec2 uv = q.xy / q.z / uContent + 0.5;
  if (q.z <= 0.0 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { gl_FragColor = vec4(0.0); return; }
  vec2 pp = uv * uTexSize - 0.5;
  vec2 fp = floor(pp);
  pp -= fp;
  //    b c
  //  e f g h
  //  i j k l
  //    n o
  vec3 bC = T(fp, 0.0, -1.0), cC = T(fp, 1.0, -1.0);
  vec3 eC = T(fp, -1.0, 0.0), fC = T(fp, 0.0, 0.0), gC = T(fp, 1.0, 0.0), hC = T(fp, 2.0, 0.0);
  vec3 iC = T(fp, -1.0, 1.0), jC = T(fp, 0.0, 1.0), kC = T(fp, 1.0, 1.0), lC = T(fp, 2.0, 1.0);
  vec3 nC = T(fp, 0.0, 2.0), oC = T(fp, 1.0, 2.0);
  float bL = L(bC), cL = L(cC), eL = L(eC), fL = L(fC), gL = L(gC), hL = L(hC);
  float iL = L(iC), jL = L(jC), kL = L(kC), lL = L(lC), nL = L(nC), oL = L(oC);
  // Edge direction and how clear the edge is, from the four pixels around the sample point
  vec2 dir = vec2(0.0);
  float len = 0.0;
  easuSet(dir, len, (1.0 - pp.x) * (1.0 - pp.y), bL, eL, fL, gL, jL);
  easuSet(dir, len, pp.x * (1.0 - pp.y), cL, fL, gL, hL, kL);
  easuSet(dir, len, (1.0 - pp.x) * pp.y, fL, iL, jL, kL, nL);
  easuSet(dir, len, pp.x * pp.y, gL, jL, kL, lL, oL);
  float dirR = dot(dir, dir);
  if (dirR < 1.0 / 32768.0) dir = vec2(1.0, 0.0);
  else dir *= inversesqrt(dirR);
  len = len * 0.5;
  len *= len;
  float stretch = dot(dir, dir) / max(abs(dir.x), abs(dir.y));
  vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  float lob = 0.5 + (0.21 - 0.5) * len;
  float clp = 1.0 / lob;
  // Filter along the edge (an anisotropic Lanczos-like kernel over 12 pixels)
  vec3 aC = vec3(0.0);
  float aW = 0.0;
  easuTap(aC, aW, vec2(0.0, -1.0) - pp, dir, len2, lob, clp, bC);
  easuTap(aC, aW, vec2(1.0, -1.0) - pp, dir, len2, lob, clp, cC);
  easuTap(aC, aW, vec2(-1.0, 1.0) - pp, dir, len2, lob, clp, iC);
  easuTap(aC, aW, vec2(0.0, 1.0) - pp, dir, len2, lob, clp, jC);
  easuTap(aC, aW, vec2(0.0, 0.0) - pp, dir, len2, lob, clp, fC);
  easuTap(aC, aW, vec2(-1.0, 0.0) - pp, dir, len2, lob, clp, eC);
  easuTap(aC, aW, vec2(1.0, 1.0) - pp, dir, len2, lob, clp, kC);
  easuTap(aC, aW, vec2(2.0, 1.0) - pp, dir, len2, lob, clp, lC);
  easuTap(aC, aW, vec2(2.0, 0.0) - pp, dir, len2, lob, clp, hC);
  easuTap(aC, aW, vec2(1.0, 0.0) - pp, dir, len2, lob, clp, gC);
  easuTap(aC, aW, vec2(1.0, 2.0) - pp, dir, len2, lob, clp, oC);
  easuTap(aC, aW, vec2(0.0, 2.0) - pp, dir, len2, lob, clp, nC);
  // No ringing: within the four pixels around the sample point
  vec3 mn = min(min(fC, gC), min(jC, kC));
  vec3 mx = max(max(fC, gC), max(jC, kC));
  gl_FragColor = vec4(clamp(aC / aW, mn, mx), 1.0);
}`;

// --- WebGL setup, one per box ----------------------------------------------------------------------------
function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'shader');
  return sh;
}

function program(gl, vs, frag, uniforms) {
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.bindAttribLocation(prog, 0, 'aPos');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
  const u = {};
  for (const name of uniforms) u[name] = gl.getUniformLocation(prog, name);
  return { prog, u };
}

function texture(gl) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function createGl(canvas) {
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: false });
  if (!gl) return null;
  // Camera pictures have no alpha: uploads skip the alpha and colour conversions (livecam.js decodes alike)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const passes = {
    average: program(gl, vs, FRAG_AVERAGE, ['uElem', 'uCur', 'uPrev', 'uHist', 'uTexSize', 'uBase', 'uReset']),
    sharpen: program(gl, vs, FRAG_SHARPEN, ['uElem', 'uTex', 'uH', 'uContent', 'uTexSize', 'uOutScale', 'uAmount']),
    warp: program(gl, vs, FRAG_WARP, ['uElem', 'uTex', 'uHinv', 'uContent', 'uTexSize'])
  };
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  // The running average keeps more than 8 bits where it can (else small changes would round away)
  const half = gl.getExtension('OES_texture_half_float');
  const halfLinear = gl.getExtension('OES_texture_half_float_linear');
  gl.getExtension('EXT_color_buffer_half_float');
  return {
    gl, passes,
    raw: [texture(gl), texture(gl)],    // this upload and the one before
    hist: [texture(gl), texture(gl)],   // running average, ping-pong
    sharp: texture(gl),
    fbo: gl.createFramebuffer(),
    halfType: half && halfLinear ? half.HALF_FLOAT_OES : null,
    histType: null,
    size: [0, 0],
    turn: 0,
    reset: true
  };
}

// Size the render targets for a camera picture of w x h; false when the GPU cannot render into them
function allocate(g, w, h) {
  const { gl } = g;
  const tryType = type => {
    for (const tex of [...g.hist, g.sharp]) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, tex === g.sharp ? gl.UNSIGNED_BYTE : type, null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, g.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, g.hist[0], 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return ok;
  };
  g.histType = g.halfType && tryType(g.halfType) ? g.halfType : (tryType(gl.UNSIGNED_BYTE) ? gl.UNSIGNED_BYTE : null);
  g.size = [w, h];
  g.reset = true;
  return g.histType !== null;
}

// Inverse of a row-major 3x3 matrix, or null
function invert(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const k = 1 / det;
  return [
    A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
    B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
    C * k, -(a * h - b * g) * k, (a * e - b * d) * k
  ];
}

// Row-major 3x3 -> the column-major array WebGL expects
const colMajor = H => new Float32Array([H[0], H[3], H[6], H[1], H[4], H[7], H[2], H[5], H[8]]);

// --- Boxes drawing this way, and the frame loop ---------------------------------------------------------
const active = new Set();
let loopOn = false;

// Called by framing.js whenever the warp is worked out. m: the warp homography (element px around the
// centre, row-major) or null; sharpen 0..1. Returns true when the canvas draws the picture.
export function setSharpWarp(box, media, m, sharpen) {
  const st = box._sharp || (box._sharp = {});
  const want = !!(m && media && sharpen > 0 && !st.failed);
  const hinv = want ? invert(m) : null;
  if (!hinv) {
    stop(box);
    return false;
  }
  if (st.media !== media && st.g) st.g.reset = true;
  st.media = media;
  st.h = m;
  st.hinv = hinv;
  // The averaged picture takes more: 1.0 on the slider is 4x the smeared detail back at 2x enlargement
  st.amount = sharpen * 4;
  if (!st.canvas) {
    const canvas = document.createElement('canvas');
    canvas.className = 'cam-sharp';
    try {
      st.g = createGl(canvas);
    } catch {
      st.g = null;
    }
    if (!st.g) { st.failed = true; return false; }
    st.canvas = canvas;
  }
  active.add(box);
  st.dirty = true;
  if (!loopOn) { loopOn = true; requestAnimationFrame(frame); }
  return true;
}

function stop(box) {
  active.delete(box);
  box.classList.remove('sharp-on');
  box._sharp?.canvas?.remove();
}

function frame(now) {
  for (const box of active) {
    if (!box.isConnected) { stop(box); continue; }
    try {
      draw(box, now);
    } catch {
      // A picture from another site cannot be read by WebGL: keep the CSS warp for this box
      box._sharp.failed = true;
      stop(box);
    }
  }
  if (active.size) requestAnimationFrame(frame);
  else loopOn = false;
}

function pass(g, p, target, w, h) {
  const { gl } = g;
  gl.bindFramebuffer(gl.FRAMEBUFFER, target ? g.fbo : null);
  if (target) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
  gl.viewport(0, 0, w, h);
  gl.useProgram(p.prog);
}

function bindTex(gl, unit, tex, loc) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(loc, unit);
}

function draw(box, now) {
  const st = box._sharp;
  const g = st.g;
  const media = st.media;
  // The picture was replaced (new stream): follow the new element
  if (!media.isConnected || media.parentNode !== box) {
    const next = box.querySelector(MEDIA_SELECTOR);
    if (next) { st.media = next; g.reset = true; }
    return;
  }
  const isVideo = media.tagName === 'VIDEO';
  // A live camera (livecam.js) counts its frames and lends the decoded one: uploaded once per new frame
  const live = media.classList.contains('cam-live');
  const nw = isVideo ? media.videoWidth : media.naturalWidth;
  const nh = isVideo ? media.videoHeight : media.naturalHeight;
  if (!nw || !nh || (isVideo ? media.readyState < 2 : !media.complete)) return;
  // New frames only: videos and live cameras say when, MJPEG pictures are uploaded at a steady rate
  if (!st.dirty && isVideo && media.currentTime === st.lastTime) return;
  if (!st.dirty && live && media.frameSeq === st.lastSeq) return;
  if (!st.dirty && !isVideo && !live && now - (st.lastDraw || 0) < IMG_FRAME_MS) return;
  const remeasure = st.dirty || !st.stage || (st.frames = (st.frames || 0) + 1) % MEASURE_EVERY === 0;
  st.dirty = false;
  st.lastTime = media.currentTime;
  st.lastSeq = media.frameSeq;
  st.lastDraw = now;

  // Element sizes are layout reads: taken now and then, not on every frame
  if (remeasure) {
    st.w = media.offsetWidth;
    st.h = media.offsetHeight;
    st.stage = box.offsetWidth ? box.getBoundingClientRect().width / box.offsetWidth : 1;
  }
  const w = st.w;
  const h = st.h;
  if (!w || !h) return;
  // Canvas pixels per element px: how large the element really is on screen (stage scale, zoom, HiDPI)
  const stage = st.stage;
  const zoom = (box._framing?.zoom || 1) * (Number(box.style.getPropertyValue('--dart-zoom')) || 1);
  const scale = Math.min(stage * zoom * (window.devicePixelRatio || 1), MAX_SIDE / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = st.canvas;
  if (Math.abs(canvas.width - cw) > cw * 0.1 || Math.abs(canvas.height - ch) > ch * 0.1) {
    canvas.width = cw;
    canvas.height = ch;
  }
  if (canvas.parentNode !== box || canvas.previousElementSibling !== media) media.after(canvas);

  const { gl, passes } = g;
  if ((g.size[0] !== nw || g.size[1] !== nh) && !allocate(g, nw, nh)) throw new Error('no render target');
  // Where the picture sits in its element (object-fit: contain)
  const aspect = nw / nh;
  const content = w / h > aspect ? [h * aspect, h] : [w, w / aspect];

  // Upload into the older raw texture; the other one holds the frame before
  const cur = g.raw[g.turn];
  const prev = g.raw[1 - g.turn];
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, cur);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, live ? media.bitmap : media);

  // 1. Average
  const histIn = g.hist[g.turn];
  const histOut = g.hist[1 - g.turn];
  let p = passes.average;
  pass(g, p, histOut, nw, nh);
  bindTex(gl, 0, cur, p.u.uCur);
  bindTex(gl, 1, g.reset ? cur : prev, p.u.uPrev);
  bindTex(gl, 2, histIn, p.u.uHist);
  gl.uniform2f(p.u.uTexSize, nw, nh);
  // About the last 8 frames on a still picture (5 when only 8-bit targets are there)
  gl.uniform1f(p.u.uBase, g.histType === gl.UNSIGNED_BYTE ? 0.2 : 0.125);
  gl.uniform1f(p.u.uReset, g.reset ? 1 : 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  g.reset = false;
  g.turn = 1 - g.turn;

  // 2. Sharpen
  p = passes.sharpen;
  pass(g, p, g.sharp, nw, nh);
  bindTex(gl, 0, histOut, p.u.uTex);
  gl.uniformMatrix3fv(p.u.uH, false, colMajor(st.h));
  gl.uniform2f(p.u.uContent, content[0], content[1]);
  gl.uniform2f(p.u.uTexSize, nw, nh);
  gl.uniform1f(p.u.uOutScale, canvas.width / w);
  gl.uniform1f(p.u.uAmount, st.amount);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  // 3. Warp onto the screen
  p = passes.warp;
  pass(g, p, null, canvas.width, canvas.height);
  bindTex(gl, 0, g.sharp, p.u.uTex);
  gl.uniform2f(p.u.uElem, w, h);
  gl.uniformMatrix3fv(p.u.uHinv, false, colMajor(st.hinv));
  gl.uniform2f(p.u.uContent, content[0], content[1]);
  gl.uniform2f(p.u.uTexSize, nw, nh);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  box.classList.add('sharp-on');
}
