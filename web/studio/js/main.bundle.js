(() => {
  var __defProp = Object.defineProperty;
  var __defProps = Object.defineProperties;
  var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
  var __getOwnPropSymbols = Object.getOwnPropertySymbols;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __propIsEnum = Object.prototype.propertyIsEnumerable;
  var __defNormalProp = (obj, key2, value) => key2 in obj ? __defProp(obj, key2, { enumerable: true, configurable: true, writable: true, value }) : obj[key2] = value;
  var __spreadValues = (a, b) => {
    for (var prop in b || (b = {}))
      if (__hasOwnProp.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    if (__getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(b)) {
        if (__propIsEnum.call(b, prop))
          __defNormalProp(a, prop, b[prop]);
      }
    return a;
  };
  var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));

  // js/tv-compat.js
  window.__started = 1;
  if (!Array.prototype.flatMap) {
    Object.defineProperty(Array.prototype, "flatMap", {
      configurable: true,
      writable: true,
      value(fn, self) {
        return this.reduce((out, x, i, a) => out.concat(fn.call(self, x, i, a)), []);
      }
    });
  }
  if (!Object.fromEntries) {
    Object.fromEntries = (it) => {
      const o = {};
      for (const [k, v] of it) o[k] = v;
      return o;
    };
  }
  if (!Element.prototype.replaceChildren) {
    Element.prototype.replaceChildren = function() {
      while (this.firstChild) this.removeChild(this.firstChild);
      for (let i = 0; i < arguments.length; i++) {
        const n2 = arguments[i];
        this.appendChild(typeof n2 === "string" ? document.createTextNode(n2) : n2);
      }
    };
  }

  // js/ctx.js
  var ctx = {
    settings: null,
    // /api/studio (players, cameras, overlay options)
    demo: false
  };
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== void 0 && text !== null) node.textContent = String(text);
    return node;
  }
  var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  var hiddenText = (key2) => {
    var _a;
    return (((_a = ctx.settings) == null ? void 0 : _a.hidden_texts) || []).includes(key2);
  };
  var t = (key2) => {
    var _a, _b, _c, _d;
    return hiddenText(key2) ? "" : ((_b = (_a = ctx.settings) == null ? void 0 : _a.texts) == null ? void 0 : _b[key2]) || ((_d = (_c = ctx.settings) == null ? void 0 : _c.text_defaults) == null ? void 0 : _d[key2]) || "";
  };
  var tn = (key2, n2) => t(key2) ? `${t(key2)} ${n2}` : "";
  var eventTitle = (fallback = "AutoGlow Darts Studio") => {
    var _a;
    return hiddenText("event_title") ? "" : ((_a = ctx.settings) == null ? void 0 : _a.title) || fallback;
  };
  var eventSubtitle = () => {
    var _a;
    return hiddenText("event_subtitle") ? "" : ((_a = ctx.settings) == null ? void 0 : _a.subtitle) || "";
  };
  var fmt = (v) => v === null || v === void 0 ? "" : String(Math.round(v));
  var fmtAvg = (v) => typeof v === "number" && v > 0 ? v.toFixed(2) : "\u2013";
  var norm = (s) => String(s || "").trim().toLowerCase();
  function initials(name) {
    return String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
  }
  function studioPlayer(player) {
    var _a;
    const players = ((_a = ctx.settings) == null ? void 0 : _a.players) || [];
    if (player && typeof player === "object") {
      const mapped = player.studio_id && players.find((p) => p.id === player.studio_id);
      if (mapped) return mapped;
      player = player.name;
    }
    const key2 = norm(player);
    return players.find((p) => norm(p.name) === key2 || p.alias && norm(p.alias) === key2) || null;
  }
  var displayName = (player) => {
    var _a;
    return ((_a = studioPlayer(player)) == null ? void 0 : _a.name) || player.name;
  };
  function pictureUrl(player) {
    const sp = studioPlayer(player);
    if (sp == null ? void 0 : sp.image) return `/api/studio/images/${encodeURIComponent(sp.image)}`;
    return player.avatar_url || "";
  }
  function avatar(player, cls = "avatar") {
    const src = pictureUrl(player);
    const fallback = () => el("span", `avatar ${cls}`, initials(displayName(player)));
    if (!src) return fallback();
    const img = el("img", cls);
    img.src = src;
    img.alt = "";
    img.onerror = () => img.replaceWith(fallback());
    return img;
  }
  function profile(player) {
    var _a;
    const sp = studioPlayer(player) || {};
    const cs = ((_a = sp.club_stats) == null ? void 0 : _a.games) ? sp.club_stats : null;
    const accountAvg = typeof player.account_average === "number" ? player.account_average.toFixed(1) : "";
    return {
      name: displayName(player),
      nickname: sp.nickname || "",
      club: sp.club || "",
      hometown: sp.hometown || "",
      country: sp.country || player.country || "",
      hand: sp.hand || "",
      dartWeight: sp.dart_weight || "",
      favouriteDouble: sp.favourite_double || "",
      playingSince: sp.playing_since || "",
      average: (cs == null ? void 0 : cs.average) ? cs.average.toFixed(1) : sp.stat_average || accountAvg,
      oneEighties: cs ? String(cs.t180) : sp.stat_180s || "",
      bestCheckout: (cs == null ? void 0 : cs.best_checkout) ? String(cs.best_checkout) : sp.stat_best_checkout || ""
    };
  }
  function studioPlayersAsPlayers() {
    var _a;
    return (((_a = ctx.settings) == null ? void 0 : _a.players) || []).map((p, index) => ({ index, name: p.name, avatar_url: "", country: p.country }));
  }

  // js/livecam.js
  var MEDIA_SELECTOR = ":scope > img, :scope > video, :scope > canvas.cam-live";
  var workerUrl = "/studio/js/camera-worker.bundle.js";
  var frameW = (f) => {
    var _a;
    return (_a = f.displayWidth) != null ? _a : f.width;
  };
  var frameH = (f) => {
    var _a;
    return (_a = f.displayHeight) != null ? _a : f.height;
  };
  var STALL_MS = 8e3;
  var FIRST_FRAME_MS = 15e3;
  var h264Supported = () => typeof VideoDecoder !== "undefined";
  function createLiveCamera(url, { format = "mjpeg", onError, onEnded } = {}) {
    const canvas = document.createElement("canvas");
    canvas.className = "cam-live";
    canvas.width = 16;
    canvas.height = 9;
    const g = canvas.getContext("2d", { alpha: false, desynchronized: true });
    let bitmap = null;
    let pending = null;
    let raf = 0;
    let closed = false;
    let seq = 0;
    const stats = { received: 0, decodeDropped: 0, decoded: 0, shown: 0 };
    Object.defineProperties(canvas, {
      naturalWidth: { get: () => bitmap ? frameW(bitmap) : 0 },
      naturalHeight: { get: () => bitmap ? frameH(bitmap) : 0 },
      complete: { get: () => !!bitmap },
      frameSeq: { get: () => seq },
      bitmap: { get: () => bitmap },
      stats: { get: () => __spreadProps(__spreadValues({}, stats), { shown: seq }) }
    });
    const present = () => {
      var _a;
      raf = 0;
      if (closed || !pending) return;
      const next = pending;
      pending = null;
      const resized = !bitmap || frameW(bitmap) !== frameW(next) || frameH(bitmap) !== frameH(next);
      if (bitmap) bitmap.close();
      bitmap = next;
      seq++;
      if (resized) {
        canvas.width = frameW(next);
        canvas.height = frameH(next);
      }
      if (!((_a = canvas.parentNode) == null ? void 0 : _a.classList.contains("sharp-on"))) g.drawImage(next, 0, 0);
      if (resized) canvas.dispatchEvent(new Event("load"));
    };
    const worker = new Worker(workerUrl);
    let lastFrameAt = 0;
    const startedAt = performance.now();
    let watchdog = 0;
    const giveUp = () => {
      if (closed) return;
      clearInterval(watchdog);
      onEnded == null ? void 0 : onEnded();
    };
    worker.onerror = (event) => {
      var _a;
      (_a = event.preventDefault) == null ? void 0 : _a.call(event);
      giveUp();
    };
    watchdog = setInterval(() => {
      const since = lastFrameAt ? performance.now() - lastFrameAt : performance.now() - startedAt;
      if (since > (lastFrameAt ? STALL_MS : FIRST_FRAME_MS)) giveUp();
    }, 2e3);
    worker.onmessage = ({ data }) => {
      var _a;
      if (closed) {
        (_a = data.frame) == null ? void 0 : _a.close();
        return;
      }
      if (data.type === "frame") {
        lastFrameAt = performance.now();
        stats.received = data.received;
        stats.decodeDropped = data.dropped;
        stats.decoded++;
        if (pending) pending.close();
        pending = data.frame;
        if (!raf) raf = requestAnimationFrame(present);
      } else if (data.type === "error") {
        clearInterval(watchdog);
        onError == null ? void 0 : onError(data.message || "", data.status);
      } else if (data.type === "ended") {
        giveUp();
      }
    };
    worker.postMessage({ type: "open", url, format });
    canvas.closeStream = () => {
      if (closed) return;
      closed = true;
      clearInterval(watchdog);
      worker.postMessage({ type: "close" });
      worker.terminate();
      if (raf) cancelAnimationFrame(raf);
      pending == null ? void 0 : pending.close();
      bitmap == null ? void 0 : bitmap.close();
      pending = null;
      bitmap = null;
    };
    return canvas;
  }

  // js/look.js
  var TONE_WIDTH = 240;
  var TONE_SIGMA = 6;
  var TONE_RADIUS = 18;
  var LOG_RANGE = 16;
  var n = (v, d) => Number.isFinite(Number(v)) ? Number(v) : d;
  function lookParams(look) {
    const w = Math.exp(0.06 * n(look.warmth, 0));
    const k = [n(look.r, 1) * w, n(look.g, 1), n(look.b, 1) / w];
    const l = 0.2126 * k[0] + 0.7152 * k[1] + 0.0722 * k[2] || 1;
    return {
      gain: k.map((v) => v / l),
      black: n(look.black, 0),
      white: n(look.white, 1),
      contrast: n(look.contrast, 0),
      vibrance: n(look.vibrance, 0),
      shadows: n(look.shadows, 0),
      highlights: n(look.highlights, 0)
    };
  }
  var COMMON = `
const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);
vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
`;
  var FRAG_TONE_BASE = `
uniform sampler2D uTex;
uniform vec2 uTexSize;
uniform vec2 uSmall;
uniform vec3 uGain;
${COMMON}
void main() {
  vec2 block = uTexSize / uSmall;
  vec2 origin = (gl_FragCoord.xy - 0.5) * block;
  float sum = 0.0;
  for (int i = 0; i < 4; i++) {
    for (int j = 0; j < 4; j++) {
      vec2 p = origin + block * (vec2(float(i), float(j)) + 0.5) / 4.0;
      vec3 c = toLinear(texture2D(uTex, p / uTexSize).rgb) * uGain;
      sum += log2(max(dot(c, LUM), 1e-5));
    }
  }
  gl_FragColor = vec4(vec3(clamp(sum / 16.0 / ${LOG_RANGE}.0 + 1.0, 0.0, 1.0)), 1.0);
}`;
  var FRAG_TONE_BLUR = `
uniform sampler2D uTex;
uniform vec2 uSmall;
uniform vec2 uDir;
void main() {
  vec2 uv = gl_FragCoord.xy / uSmall;
  float sum = 0.0;
  float total = 0.0;
  for (int i = -${TONE_RADIUS}; i <= ${TONE_RADIUS}; i++) {
    float w = exp(-float(i * i) / ${(2 * TONE_SIGMA * TONE_SIGMA).toFixed(1)});
    sum += w * texture2D(uTex, uv + uDir * float(i) / uSmall).r;
    total += w;
  }
  gl_FragColor = vec4(vec3(sum / total), 1.0);
}`;
  var FRAG_LOOK = `
uniform sampler2D uTex;
uniform sampler2D uBase;
uniform vec2 uTexSize;
uniform vec3 uGain;
uniform float uBlack;
uniform float uWhite;
uniform float uContrast;
uniform float uVibrance;
uniform float uShadows;
uniform float uHighlights;
${COMMON}
const float KEY = -2.4739311;   // log2(0.18)
const float HALO = 1.5;
const float KNEE = 0.8;
const float SKIN_HUE = 0.77;
const float SKIN_PROTECT = 0.6;
const float SKIN_PULL = 0.25;
vec3 toSrgb(vec3 l) {
  l = clamp(l, 0.0, 1.0);
  return mix(l * 12.92, 1.055 * pow(l, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, l));
}
vec3 oklab(vec3 c) {
  vec3 lms = vec3(dot(c, vec3(0.4122214708, 0.5363325363, 0.0514459929)),
                  dot(c, vec3(0.2119034982, 0.6806995451, 0.1073969566)),
                  dot(c, vec3(0.0883024619, 0.2817188376, 0.6299787005)));
  lms = pow(max(lms, 0.0), vec3(1.0 / 3.0));
  return vec3(dot(lms, vec3(0.2104542553, 0.7936177850, -0.0040720468)),
              dot(lms, vec3(1.9779984951, -2.4285922050, 0.4505937099)),
              dot(lms, vec3(0.0259040371, 0.7827717662, -0.8086757660)));
}
vec3 fromOklab(vec3 k) {
  vec3 lms = vec3(k.x + 0.3963377774 * k.y + 0.2158037573 * k.z,
                  k.x - 0.1055613458 * k.y - 0.0638541728 * k.z,
                  k.x - 0.0894841775 * k.y - 1.2914855480 * k.z);
  lms = lms * lms * lms;
  return vec3(dot(lms, vec3(4.0767416621, -3.3077115913, 0.2309699292)),
              dot(lms, vec3(-1.2684380046, 2.6097574011, -0.3413193965)),
              dot(lms, vec3(-0.0041960863, -0.7034186147, 1.7076147010)));
}
void main() {
  vec2 uv = gl_FragCoord.xy / uTexSize;
  vec3 c = texture2D(uTex, uv).rgb;
  float base = (texture2D(uBase, uv).r - 1.0) * ${LOG_RANGE}.0;
  // White balance; clipped spots stay white
  float clip = smoothstep(0.86, 0.98, max(c.r, max(c.g, c.b)));
  vec3 lin = toLinear(c) * uGain;
  lin = mix(lin, vec3(dot(lin, LUM)), clip);
  float y = max(dot(lin, LUM), 1e-5);
  // Local tone
  float l = log2(y);
  float d = base < KEY ? uShadows * (KEY - base) : -uHighlights * (base - KEY) * (1.0 - clip);
  d *= exp(-(l - base) * (l - base) / (2.0 * HALO * HALO));
  float y2 = exp2(l + clamp(d, -1.0, 1.5));
  // Tone curve: levels, soft knee onto white, S-curve
  float span = max(uWhite - uBlack, 0.05);
  float x = (1.055 * pow(y2, 1.0 / 2.4) - 0.055 - uBlack) / span;
  float top = (1.0 - uBlack) / span - KNEE;
  if (x > KNEE && top > 0.0) {
    float t = x - KNEE;
    float a = max((top - (1.0 - KNEE)) / (top * top), 0.0);
    float tt = min(t, top);
    x = KNEE + t - a * tt * tt;
  }
  x = clamp(x, 0.0, 1.0);
  float outv = x + uContrast * (x * x * (3.0 - 2.0 * x) - x);
  float yo = toLinear(vec3(outv)).r;
  vec3 lo = lin * (yo / y);
  float over = clamp((max(lo.r, max(lo.g, lo.b)) - 0.85) / 0.6, 0.0, 1.0);
  lo = mix(lo, vec3(yo), over);
  // Colour: vibrance, skin kept natural
  vec3 k = oklab(lo);
  float ch = length(k.yz);
  float hue = atan(k.z, k.y);
  float dh = hue - SKIN_HUE;
  dh = atan(sin(dh), cos(dh));
  float skin = exp(-(dh / 0.45) * (dh / 0.45)) * clamp((ch - 0.01) / 0.03, 0.0, 1.0) * clamp((0.2 - ch) / 0.08, 0.0, 1.0);
  float boost = uVibrance * (1.0 - clamp(ch / 0.22, 0.0, 1.0)) * (1.0 - SKIN_PROTECT * skin);
  float ch2 = ch * (1.0 + boost);
  float hue2 = hue - skin * SKIN_PULL * dh;
  k.yz = ch2 * vec2(cos(hue2), sin(hue2));
  gl_FragColor = vec4(toSrgb(fromOklab(k)), 1.0);
}`;

  // js/sharpwarp.js
  var MAX_SIDE = 2560;
  var IMG_FRAME_MS = 30;
  var MEASURE_EVERY = 15;
  var LOOK_SHARPEN = 0.6;
  var IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  var VERT = `
attribute vec2 aPos;
uniform vec2 uElem;
varying vec2 vPos;
void main() {
  // Element px around its centre, y down (like the CSS warp); only the warp pass uses it
  vPos = vec2(aPos.x, -aPos.y) * 0.5 * uElem;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;
  var HEAD = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
`;
  var FRAG_AVERAGE = HEAD + `
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
  var FRAG_SHARPEN = HEAD + `
uniform sampler2D uTex;
uniform mat3 uH;           // the warp: element px around the centre, before -> after
uniform vec2 uContent;     // the picture's size in the element (px)
uniform vec2 uTexSize;
uniform float uOutScale;   // canvas px per element px
uniform float uAmount;
uniform float uBaseAmount;  // everywhere, enlarged or not
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
  vec3 sharp = c + (uAmount * stretch + uBaseAmount) * (c - blur);
  // No halos: stay within the 3x3 neighbourhood (a little leeway keeps edges crisp)
  vec3 lo = min(min(min(n, s), min(w, ea)), min(min(nw, ne), min(sw, se)));
  vec3 hi = max(max(max(n, s), max(w, ea)), max(max(nw, ne), max(sw, se)));
  sharp = clamp(sharp, min(lo, c) - 0.015, max(hi, c) + 0.015);
  gl_FragColor = vec4(clamp(sharp, 0.0, 1.0), 1.0);
}`;
  var FRAG_WARP = HEAD + `
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
  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || "shader");
    return sh;
  }
  function program(gl, vs, frag, uniforms) {
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, frag));
    gl.bindAttribLocation(prog, 0, "aPos");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "link");
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
    const gl = canvas.getContext("webgl", { premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: false });
    if (!gl) return null;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const passes = {
      average: program(gl, vs, FRAG_AVERAGE, ["uElem", "uCur", "uPrev", "uHist", "uTexSize", "uBase", "uReset"]),
      sharpen: program(gl, vs, FRAG_SHARPEN, ["uElem", "uTex", "uH", "uContent", "uTexSize", "uOutScale", "uAmount", "uBaseAmount"]),
      toneBase: program(gl, vs, HEAD + FRAG_TONE_BASE, ["uElem", "uTex", "uTexSize", "uSmall", "uGain"]),
      toneBlur: program(gl, vs, HEAD + FRAG_TONE_BLUR, ["uElem", "uTex", "uSmall", "uDir"]),
      look: program(gl, vs, HEAD + FRAG_LOOK, ["uElem", "uTex", "uBase", "uTexSize", "uGain", "uBlack", "uWhite", "uContrast", "uVibrance", "uShadows", "uHighlights"]),
      warp: program(gl, vs, FRAG_WARP, ["uElem", "uTex", "uHinv", "uContent", "uTexSize"])
    };
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const half = gl.getExtension("OES_texture_half_float");
    const halfLinear = gl.getExtension("OES_texture_half_float_linear");
    gl.getExtension("EXT_color_buffer_half_float");
    return {
      gl,
      passes,
      raw: [texture(gl), texture(gl)],
      // this upload and the one before
      hist: [texture(gl), texture(gl)],
      // running average, ping-pong
      sharp: texture(gl),
      small: [texture(gl), texture(gl)],
      // the small blurred copy for the look, ping-pong
      looked: texture(gl),
      // the averaged picture with the look
      smallSize: [0, 0],
      fbo: gl.createFramebuffer(),
      halfType: half && halfLinear ? half.HALF_FLOAT_OES : null,
      histType: null,
      size: [0, 0],
      turn: 0,
      reset: true
    };
  }
  function allocate(g, w, h) {
    const { gl } = g;
    const tryType = (type) => {
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
    g.histType = g.halfType && tryType(g.halfType) ? g.halfType : tryType(gl.UNSIGNED_BYTE) ? gl.UNSIGNED_BYTE : null;
    const sw = Math.min(TONE_WIDTH, w);
    const sh = Math.max(1, Math.round(h * sw / w));
    for (const tex of g.small) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, sw, sh, 0, gl.RGBA, g.histType || gl.UNSIGNED_BYTE, null);
    }
    gl.bindTexture(gl.TEXTURE_2D, g.looked);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    g.smallSize = [sw, sh];
    g.size = [w, h];
    g.reset = true;
    return g.histType !== null;
  }
  function invert(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h;
    const B = -(d * i - f * g);
    const C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-12) return null;
    const k = 1 / det;
    return [
      A * k,
      -(b * i - c * h) * k,
      (b * f - c * e) * k,
      B * k,
      (a * i - c * g) * k,
      -(a * f - c * d) * k,
      C * k,
      -(a * h - b * g) * k,
      (a * e - b * d) * k
    ];
  }
  var colMajor = (H) => new Float32Array([H[0], H[3], H[6], H[1], H[4], H[7], H[2], H[5], H[8]]);
  var active = /* @__PURE__ */ new Set();
  var loopOn = false;
  function setSharpWarp(box, media, m, sharpen, look) {
    const st = box._sharp || (box._sharp = {});
    const want = !!(media && !st.failed && (m && sharpen > 0 || look));
    if (want && !m) m = IDENTITY;
    const hinv = want ? invert(m) : null;
    if (!hinv) {
      stop(box);
      return false;
    }
    if (st.media !== media && st.g) st.g.reset = true;
    st.media = media;
    st.h = m;
    st.hinv = hinv;
    st.amount = sharpen * 4;
    st.look = look ? lookParams(look) : null;
    if (!st.canvas) {
      const canvas = document.createElement("canvas");
      canvas.className = "cam-sharp";
      try {
        st.g = createGl(canvas);
      } catch (e) {
        console.warn("Studio camera: no WebGL picture", e);
        st.g = null;
      }
      if (!st.g) {
        st.failed = true;
        return false;
      }
      st.canvas = canvas;
      canvas.addEventListener("webglcontextlost", (e) => e.preventDefault());
      canvas.addEventListener("webglcontextrestored", () => {
        try {
          st.g = createGl(canvas);
        } catch (e) {
          st.g = null;
        }
        if (!st.g) return;
        st.failed = false;
        st.dirty = true;
        active.add(box);
        if (!loopOn) {
          loopOn = true;
          requestAnimationFrame(frame);
        }
      });
    }
    active.add(box);
    st.dirty = true;
    if (!loopOn) {
      loopOn = true;
      requestAnimationFrame(frame);
    }
    return true;
  }
  function stop(box) {
    var _a, _b;
    active.delete(box);
    box.classList.remove("sharp-on", "gl-look");
    (_b = (_a = box._sharp) == null ? void 0 : _a.canvas) == null ? void 0 : _b.remove();
  }
  function frame(now) {
    for (const box of active) {
      if (!box.isConnected) {
        stop(box);
        continue;
      }
      try {
        draw(box, now);
      } catch (e) {
        console.warn("Studio camera: WebGL drawing stopped", e);
        box._sharp.failed = true;
        stop(box);
      }
    }
    if (active.size) requestAnimationFrame(frame);
    else loopOn = false;
  }
  function pass(g, p, target2, w, h) {
    const { gl } = g;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target2 ? g.fbo : null);
    if (target2) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target2, 0);
    gl.viewport(0, 0, w, h);
    gl.useProgram(p.prog);
  }
  function bindTex(gl, unit, tex, loc) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }
  function draw(box, now) {
    var _a;
    const st = box._sharp;
    const g = st.g;
    const media = st.media;
    if (!media.isConnected || media.parentNode !== box) {
      const next = box.querySelector(MEDIA_SELECTOR);
      if (next) {
        st.media = next;
        g.reset = true;
      }
      return;
    }
    const isVideo = media.tagName === "VIDEO";
    const live = media.classList.contains("cam-live");
    const nw = isVideo ? media.videoWidth : media.naturalWidth;
    const nh = isVideo ? media.videoHeight : media.naturalHeight;
    if (!nw || !nh || (isVideo ? media.readyState < 2 : !media.complete)) return;
    if (!st.dirty && isVideo && media.currentTime === st.lastTime) return;
    if (!st.dirty && live && media.frameSeq === st.lastSeq) return;
    if (!st.dirty && !isVideo && !live && now - (st.lastDraw || 0) < IMG_FRAME_MS) return;
    const remeasure = st.dirty || !st.stage || (st.frames = (st.frames || 0) + 1) % MEASURE_EVERY === 0;
    st.dirty = false;
    st.lastTime = media.currentTime;
    st.lastSeq = media.frameSeq;
    st.lastDraw = now;
    if (remeasure) {
      st.w = media.offsetWidth;
      st.h = media.offsetHeight;
      st.stage = box.offsetWidth ? box.getBoundingClientRect().width / box.offsetWidth : 1;
    }
    const w = st.w;
    const h = st.h;
    if (!w || !h) return;
    const stage2 = st.stage;
    const zoom = (((_a = box._framing) == null ? void 0 : _a.zoom) || 1) * (Number(box.style.getPropertyValue("--dart-zoom")) || 1);
    const scale = Math.min(stage2 * zoom * (window.devicePixelRatio || 1), MAX_SIDE / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const canvas = st.canvas;
    if (Math.abs(canvas.width - cw) > cw * 0.1 || Math.abs(canvas.height - ch) > ch * 0.1) {
      canvas.width = cw;
      canvas.height = ch;
    }
    if (canvas.parentNode !== box || canvas.previousElementSibling !== media) media.after(canvas);
    const { gl, passes } = g;
    if ((g.size[0] !== nw || g.size[1] !== nh) && !allocate(g, nw, nh)) throw new Error("no render target");
    const aspect = nw / nh;
    const content = w / h > aspect ? [h * aspect, h] : [w, w / aspect];
    const cur = g.raw[g.turn];
    const prev2 = g.raw[1 - g.turn];
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, cur);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, live ? media.bitmap : media);
    const histIn = g.hist[g.turn];
    const histOut = g.hist[1 - g.turn];
    let p = passes.average;
    pass(g, p, histOut, nw, nh);
    bindTex(gl, 0, cur, p.u.uCur);
    bindTex(gl, 1, g.reset ? cur : prev2, p.u.uPrev);
    bindTex(gl, 2, histIn, p.u.uHist);
    gl.uniform2f(p.u.uTexSize, nw, nh);
    gl.uniform1f(p.u.uBase, g.histType === gl.UNSIGNED_BYTE ? 0.2 : 0.125);
    gl.uniform1f(p.u.uReset, g.reset ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    g.reset = false;
    g.turn = 1 - g.turn;
    const lk = st.look;
    if (lk) {
      const [sw, sh] = g.smallSize;
      p = passes.toneBase;
      pass(g, p, g.small[0], sw, sh);
      bindTex(gl, 0, histOut, p.u.uTex);
      gl.uniform2f(p.u.uTexSize, nw, nh);
      gl.uniform2f(p.u.uSmall, sw, sh);
      gl.uniform3fv(p.u.uGain, lk.gain);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      p = passes.toneBlur;
      for (const [from, to, dir] of [[0, 1, [1, 0]], [1, 0, [0, 1]]]) {
        pass(g, p, g.small[to], sw, sh);
        bindTex(gl, 0, g.small[from], p.u.uTex);
        gl.uniform2f(p.u.uSmall, sw, sh);
        gl.uniform2f(p.u.uDir, dir[0], dir[1]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      p = passes.look;
      pass(g, p, g.looked, nw, nh);
      bindTex(gl, 0, histOut, p.u.uTex);
      bindTex(gl, 1, g.small[0], p.u.uBase);
      gl.uniform2f(p.u.uTexSize, nw, nh);
      gl.uniform3fv(p.u.uGain, lk.gain);
      gl.uniform1f(p.u.uBlack, lk.black);
      gl.uniform1f(p.u.uWhite, lk.white);
      gl.uniform1f(p.u.uContrast, lk.contrast);
      gl.uniform1f(p.u.uVibrance, lk.vibrance);
      gl.uniform1f(p.u.uShadows, lk.shadows);
      gl.uniform1f(p.u.uHighlights, lk.highlights);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    p = passes.sharpen;
    pass(g, p, g.sharp, nw, nh);
    bindTex(gl, 0, lk ? g.looked : histOut, p.u.uTex);
    gl.uniformMatrix3fv(p.u.uH, false, colMajor(st.h));
    gl.uniform2f(p.u.uContent, content[0], content[1]);
    gl.uniform2f(p.u.uTexSize, nw, nh);
    gl.uniform1f(p.u.uOutScale, canvas.width / w);
    gl.uniform1f(p.u.uAmount, st.amount);
    gl.uniform1f(p.u.uBaseAmount, lk ? LOOK_SHARPEN : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    p = passes.warp;
    pass(g, p, null, canvas.width, canvas.height);
    bindTex(gl, 0, g.sharp, p.u.uTex);
    gl.uniform2f(p.u.uElem, w, h);
    gl.uniformMatrix3fv(p.u.uHinv, false, colMajor(st.hinv));
    gl.uniform2f(p.u.uContent, content[0], content[1]);
    gl.uniform2f(p.u.uTexSize, nw, nh);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    box.classList.add("sharp-on");
    box.classList.toggle("gl-look", !!lk);
  }

  // js/framing.js
  var ZOOM_MIN = 1;
  var ZOOM_MAX = 4;
  var WARP_ZOOM_MAX = 4;
  var SIDEWAYS_RATIO = 1080 / 1920;
  function applyFraming(box, cam) {
    if (!box) return;
    const rot = Number(cam.rotation || 0);
    const sideways = rot === 90 || rot === 270;
    const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(cam.zoom) || 1));
    const panX = Math.max(-1, Math.min(1, Number(cam.pan_x) || 0));
    const panY = Math.max(-1, Math.min(1, Number(cam.pan_y) || 0));
    const ratio = sideways ? SIDEWAYS_RATIO : 1;
    const tx = -panX * 50 * (zoom - 1) * ratio;
    const ty = -panY * 50 * (zoom - 1) * ratio;
    box.dataset.rot = String(rot);
    box.classList.toggle("mirror", !!cam.mirror);
    box.style.setProperty("--zoom", String(zoom));
    box.style.setProperty("--tx", `${tx.toFixed(3)}%`);
    box.style.setProperty("--ty", `${ty.toFixed(3)}%`);
    box._framing = { rot, flip: cam.mirror ? -1 : 1, zoom, tx, ty };
    applyLook(box, cam.look);
    box._framingCam = cam;
    watchBox(box);
    applyWarp(box, cam);
  }
  var LUMA = [0.299, 0.587, 0.114];
  var SVG_NS = "http://www.w3.org/2000/svg";
  var lookDefs = null;
  function lookFilter(look) {
    if (!look) return "";
    const n2 = (v, d) => Number.isFinite(Number(v)) ? Number(v) : d;
    const w = Math.exp(0.06 * n2(look.warmth, 0));
    const k = [n2(look.r, 1) * w, n2(look.g, 1), n2(look.b, 1) / w].map((v) => v ** (1 / 2.2));
    const s = 1 + 0.6 * n2(look.vibrance, 0);
    const black = n2(look.black, 0);
    const white = n2(look.white, 1);
    const contrast = n2(look.contrast, 0);
    const rows = [0, 1, 2].map((i) => [0, 1, 2].map((j) => ((i === j ? s : 0) + (1 - s) * LUMA[j]) * k[j]));
    const matrix = rows.map((r) => [...r.map((v) => v.toFixed(4)), 0, 0].join(" ")).join(" ") + " 0 0 0 1 0";
    const table = Array.from({ length: 33 }, (_, i) => {
      const y = Math.min(1, Math.max(0, (i / 32 - black) / Math.max(0.05, white - black)));
      return (y + contrast * (y * y * (3 - 2 * y) - y)).toFixed(4);
    }).join(" ");
    let hash = 0;
    for (const ch of matrix + table) hash = hash * 31 + ch.charCodeAt(0) | 0;
    const id = `ag-look-${(hash >>> 0).toString(36)}`;
    if (!document.getElementById(id)) {
      if (!lookDefs) {
        const svg2 = document.createElementNS(SVG_NS, "svg");
        svg2.setAttribute("width", "0");
        svg2.setAttribute("height", "0");
        svg2.setAttribute("aria-hidden", "true");
        svg2.style.position = "absolute";
        lookDefs = document.createElementNS(SVG_NS, "defs");
        svg2.append(lookDefs);
        document.body.append(svg2);
      }
      const filter = document.createElementNS(SVG_NS, "filter");
      filter.id = id;
      filter.setAttribute("color-interpolation-filters", "sRGB");
      const cm = document.createElementNS(SVG_NS, "feColorMatrix");
      cm.setAttribute("type", "matrix");
      cm.setAttribute("values", matrix);
      const ct = document.createElementNS(SVG_NS, "feComponentTransfer");
      for (const c of ["R", "G", "B"]) {
        const f = document.createElementNS(SVG_NS, `feFunc${c}`);
        f.setAttribute("type", "table");
        f.setAttribute("tableValues", table);
        ct.append(f);
      }
      filter.append(cm, ct);
      lookDefs.append(filter);
    }
    return `url(#${id})`;
  }
  function applyLook(box, look) {
    const filter = lookFilter(look);
    box.classList.toggle("cam-look", !!filter);
    if (filter) box.style.setProperty("--look", filter);
    else box.style.removeProperty("--look");
  }
  function watchBox(box) {
    if (box._framingWatched) return;
    box._framingWatched = true;
    const again = () => {
      if (box._framingCam) applyWarp(box, box._framingCam);
    };
    box.addEventListener("load", again, true);
    box.addEventListener("loadedmetadata", again, true);
    if ("ResizeObserver" in window) new ResizeObserver(again).observe(box);
  }
  function warpOf(cam) {
    var _a;
    const w = cam == null ? void 0 : cam.warp;
    const pts = w == null ? void 0 : w.points;
    if (!Array.isArray(pts) || pts.length !== 4) return null;
    if (!pts.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) return null;
    const strength = Math.max(0, Math.min(1, Number(w.strength) || 0));
    const sharpen = Math.max(0, Math.min(1, Number((_a = w.sharpen) != null ? _a : 0.5) || 0));
    return strength > 0 ? { points: pts, strength, sharpen } : null;
  }
  function applyWarp(box, cam) {
    var _a;
    const media = box.querySelector(MEDIA_SELECTOR);
    const warp = warpOf(cam);
    let css = "";
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
    setSharpWarp(box, media, box._warpM, (_a = warp == null ? void 0 : warp.sharpen) != null ? _a : 0, cam.look || null);
    const key2 = css || "none";
    if (box._warpKey === key2) return;
    box._warpKey = key2;
    if (css) box.style.setProperty("--warp", css);
    else box.style.removeProperty("--warp");
  }
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
  var BOARD_MARKS = [[0, 1], [1, 0], [0, -1], [-1, 0]];
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
  function boardPointInBox(box, cam, x, y) {
    var _a;
    const pts = (_a = cam == null ? void 0 : cam.warp) == null ? void 0 : _a.points;
    const media = box == null ? void 0 : box.querySelector(MEDIA_SELECTOR);
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
    const corners = [[-cw / 2, -ch / 2], [cw / 2, -ch / 2], [cw / 2, ch / 2], [-cw / 2, ch / 2]].map((c) => elementToBox(box, w, h, c));
    if (!point || corners.some((c) => !c)) return null;
    const xs = corners.map((c) => c[0]).sort((a, b) => a - b);
    const ys = corners.map((c) => c[1]).sort((a, b) => a - b);
    return { point, picture: [xs[1], ys[1], xs[2], ys[2]] };
  }
  function setDartFocus(box, cam, focus2, ms = 700) {
    let dz = 1;
    let dx = 0;
    let dy = 0;
    const at = focus2 ? boardPointInBox(box, cam, focus2.x, focus2.y) : null;
    if (at) {
      dz = focus2.zoom;
      const [x0, y0, x1, y1] = at.picture;
      const fit2 = (want, half, lo, hi) => {
        const min = half - dz * hi;
        const max = -half - dz * lo;
        return min <= max ? Math.max(min, Math.min(max, want)) : -dz * (lo + hi) / 2;
      };
      dx = fit2(-dz * at.point[0], box.clientWidth / 2, x0, x1);
      dy = fit2(-dz * at.point[1], box.clientHeight / 2, y0, y1);
    }
    box.style.setProperty("--dart-ms", `${Math.round(ms)}ms`);
    box.style.setProperty("--dart-zoom", String(dz));
    box.style.setProperty("--dart-x", `${dx.toFixed(1)}px`);
    box.style.setProperty("--dart-y", `${dy.toFixed(1)}px`);
    return !!at;
  }
  function contentSize(w, h, aspect) {
    return w / h > aspect ? [h * aspect, h] : [w, w / aspect];
  }
  function warpMatrix(warp, w, h, aspect, view = null) {
    const [cw, ch] = contentSize(w, h, aspect);
    const src = warp.points.map(([u, v]) => [(u - 0.5) * cw, (v - 0.5) * ch]);
    const target2 = frontView(src);
    if (!target2) return null;
    const s = warp.strength;
    const dst = src.map((p, i) => [p[0] + s * (target2[i][0] - p[0]), p[1] + s * (target2[i][1] - p[1])]);
    const H = homography(src, dst);
    if (!H) return null;
    const corners = [[-cw / 2, -ch / 2], [cw / 2, -ch / 2], [cw / 2, ch / 2], [-cw / 2, ch / 2]];
    const quad = [];
    for (const c of corners) {
      const p = project(H, c);
      if (!p) return null;
      quad.push(p);
    }
    let [x0, y0, x1, y1] = [-cw / 2, -ch / 2, cw / 2, ch / 2];
    if (view) {
      const [vx0, vy0, vx1, vy1] = [Math.max(x0, view[0]), Math.max(y0, view[1]), Math.min(x1, view[2]), Math.min(y1, view[3])];
      if (vx1 - vx0 > 1 && vy1 - vy0 > 1) [x0, y0, x1, y1] = [vx0, vy0, vx1, vy1];
    }
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const shift = ([x, y]) => [x - cx, y - cy];
    const k = coverScale(quad.map(shift), [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(shift));
    if (!k) return null;
    const [g, hh, one] = [H[6], H[7], H[8]];
    return [
      k * H[0] + (1 - k) * cx * g,
      k * H[1] + (1 - k) * cx * hh,
      k * H[2] + (1 - k) * cx * one,
      k * H[3] + (1 - k) * cy * g,
      k * H[4] + (1 - k) * cy * hh,
      k * H[5] + (1 - k) * cy * one,
      g,
      hh,
      one
    ];
  }
  function frontView(src) {
    const center = intersect(src[0], src[2], src[1], src[3]);
    if (!center) return null;
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
      radius += Math.log(Math.hypot(dx, dy)) / 4;
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
  function intersect(a1, a2, b1, b2) {
    const d1 = [a2[0] - a1[0], a2[1] - a1[1]];
    const d2 = [b2[0] - b1[0], b2[1] - b1[1]];
    const den = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(den) < 1e-9) return null;
    const t2 = ((b1[0] - a1[0]) * d2[1] - (b1[1] - a1[1]) * d2[0]) / den;
    if (t2 <= 0 || t2 >= 1) return null;
    return [a1[0] + t2 * d1[0], a1[1] + t2 * d1[1]];
  }
  function project(H, [x, y]) {
    const w = H[6] * x + H[7] * y + H[8];
    if (w <= 1e-6) return null;
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }
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
      const n2 = [sign * (b[1] - a[1]), -sign * (b[0] - a[0])];
      const d = n2[0] * a[0] + n2[1] * a[1];
      if (d <= 0) return null;
      for (const r of rect) k = Math.max(k, (n2[0] * r[0] + n2[1] * r[1]) / d);
    }
    return k <= WARP_ZOOM_MAX ? k : null;
  }
  function homography(src, dst) {
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
  function toMatrix3d(H) {
    const v = [H[0], H[3], 0, H[6], H[1], H[4], 0, H[7], 0, 0, 1, 0, H[2], H[5], 0, H[8]];
    return `matrix3d(${v.map((n2) => +n2.toPrecision(8)).join(",")})`;
  }

  // js/fill.js
  var FILL_MS = 400;
  var tiny = document.createElement("canvas");
  tiny.width = 32;
  tiny.height = 18;
  function drawCover(g, media, w, h, rot, flip) {
    const source = media.bitmap || media;
    const sw = source.videoWidth || source.naturalWidth || source.displayWidth || source.width;
    const sh = source.videoHeight || source.naturalHeight || source.displayHeight || source.height;
    const sideways = rot === 90 || rot === 270;
    const scale = Math.max(w / (sideways ? sh : sw), h / (sideways ? sw : sh));
    g.save();
    g.translate(w / 2, h / 2);
    g.scale(flip, 1);
    g.rotate(rot * Math.PI / 180);
    g.drawImage(source, -sw * scale / 2, -sh * scale / 2, sw * scale, sh * scale);
    g.restore();
  }
  function isReady(source) {
    if (!source) return false;
    return source.tagName === "VIDEO" ? source.readyState >= 2 : source.complete && source.naturalWidth > 0;
  }
  function drawSoft(source, target2, rot = 0, flip = 1) {
    try {
      const t2 = tiny.getContext("2d");
      t2.imageSmoothingEnabled = true;
      t2.imageSmoothingQuality = "high";
      drawCover(t2, source, tiny.width, tiny.height, rot, flip);
      const g = target2.getContext("2d");
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = "high";
      if ("filter" in g) g.filter = "blur(3px)";
      const m = 8;
      g.drawImage(tiny, -m, -m, target2.width + 2 * m, target2.height + 2 * m);
      if ("filter" in g) g.filter = "none";
      return true;
    } catch (e) {
      return false;
    }
  }
  var watched = /* @__PURE__ */ new Set();
  var timer = null;
  function fillCanvas(box) {
    if (!box._fill) {
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 90;
      canvas.className = "cam-fill";
      box._fill = canvas;
    }
    return box._fill;
  }
  function tick() {
    for (const box of watched) {
      if (!box.isConnected) continue;
      const canvas = box._fill;
      const source = box.querySelector(MEDIA_SELECTOR);
      if (!(canvas == null ? void 0 : canvas.isConnected) || !isReady(source)) continue;
      drawSoft(source, canvas, Number(box.dataset.rot || 0), box.classList.contains("mirror") ? -1 : 1);
    }
  }
  function setMedia(box, ...nodes) {
    const canvas = fillCanvas(box);
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    box.replaceChildren(canvas, ...nodes);
    watched.add(box);
    if (!timer) timer = setInterval(tick, FILL_MS);
  }

  // js/darts.js
  var MOVE_MAX = 0.8;
  var MOVE_MIN = 0.3;
  var OUT_MS = 900;
  var seen = /* @__PURE__ */ new Set();
  var clockSamples = [];
  var clockOffset = null;
  var generation = 0;
  var timers = [];
  function dartZoom() {
    var _a;
    const dz = (_a = ctx.settings) == null ? void 0 : _a.dart_zoom;
    return (dz == null ? void 0 : dz.enabled) && !ctx.demo ? dz : null;
  }
  var outputDelay = () => {
    var _a;
    return ((_a = dartZoom()) == null ? void 0 : _a.delay) || 0;
  };
  var board = () => document.getElementById("camBoard");
  var boardCam = () => {
    var _a, _b;
    return ((_b = (_a = ctx.settings) == null ? void 0 : _a.cameras) == null ? void 0 : _b.board) || {};
  };
  function later(atSeconds, fn) {
    const ms = Math.max(0, atSeconds * 1e3 - Date.now());
    const id = setTimeout(() => {
      timers = timers.filter((t2) => t2 !== id);
      fn();
    }, ms);
    timers.push(id);
  }
  function focus(dart, dz, moveSeconds, outAt) {
    const gen = ++generation;
    setDartFocus(board(), boardCam(), { x: dart.x, y: dart.y, zoom: dz.zoom }, moveSeconds * 1e3);
    later(outAt, () => {
      if (gen === generation) setDartFocus(board(), boardCam(), null, OUT_MS);
    });
  }
  function resetDartZoom() {
    timers.forEach(clearTimeout);
    timers = [];
    generation++;
    const box = board();
    if (box) setDartFocus(box, boardCam(), null, 0);
  }
  function onDarts(darts, serverTime) {
    const now = Date.now() / 1e3;
    if (typeof serverTime === "number") {
      clockSamples.push(serverTime - now);
      if (clockSamples.length > 40) clockSamples.shift();
      clockOffset = Math.max(...clockSamples);
    }
    const dz = dartZoom();
    if (!dz || clockOffset === null || !Array.isArray(darts)) return;
    for (const dart of darts) {
      const key2 = `${dart.t}:${dart.id}`;
      if (seen.has(key2)) continue;
      seen.add(key2);
      if (typeof dart.x !== "number" || typeof dart.y !== "number") continue;
      const shownAt = dart.t - clockOffset + dz.delay;
      if (shownAt + dz.hold < now) continue;
      const startAt = shownAt - dz.lead;
      const move = Math.max(MOVE_MIN, Math.min(MOVE_MAX, dz.lead));
      later(startAt, () => focus(dart, dz, move, shownAt + dz.hold));
    }
    if (seen.size > 200) [...seen].slice(0, 100).forEach((k) => seen.delete(k));
  }

  // js/cameras.js
  var BLUR_MS = 150;
  var LAYOUTS = ["split", "board", "player"];
  var camsBox = null;
  var boxes = {};
  var cameraKey = "";
  var streams = [];
  var blurCanvas = null;
  var blurTimer = null;
  function initCameras(cams, canvas) {
    camsBox = cams;
    boxes = { board: cams.querySelector("#camBoard"), player: cams.querySelector("#camPlayer") };
    blurCanvas = canvas;
  }
  var hasCamera = (cam) => !!cam && ((cam.kind === "server" || cam.kind === "device") && !!cam.device_id || cam.kind === "url" && !!cam.url);
  function camerasInUse() {
    var _a;
    const cams = ((_a = ctx.settings) == null ? void 0 : _a.cameras) || {};
    const board3 = hasCamera(cams.board), player = hasCamera(cams.player);
    return board3 && player ? "both" : board3 ? "board" : player ? "player" : "none";
  }
  function fitLayout(layout) {
    const want = LAYOUTS.includes(layout) ? layout : "split";
    const use = camerasInUse();
    return use === "both" ? want : use === "none" ? "split" : use;
  }
  function setLayout(layout) {
    const name = fitLayout(layout);
    const use = camerasInUse();
    if (camsBox.dataset.layout !== name) camsBox.dataset.layout = name;
    if (camsBox.dataset.cams !== use) camsBox.dataset.cams = use;
    return name;
  }
  function emptyCam(box, title, note, action) {
    const empty = el("div", "cam-empty");
    empty.append(el("span", null, title));
    if (note) empty.append(el("small", null, note));
    if (action) {
      const btn = el("button", "cam-action", action.label);
      btn.type = "button";
      btn.addEventListener("click", async () => {
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
  var STOPPED = "Autodarts is stopped";
  async function startAutodarts() {
    try {
      const res = await fetch("/api/studio/autodarts/start", { method: "POST" });
      return res.ok;
    } catch (e) {
      return false;
    }
  }
  function stopStreams() {
    while (streams.length) streams.pop().getTracks().forEach((t2) => t2.stop());
    Object.values(boxes).forEach((box) => {
      box.querySelectorAll("img").forEach((img) => {
        img.onerror = null;
        img.src = "";
      });
      box.querySelectorAll("canvas.cam-live").forEach((c) => c.closeStream());
    });
  }
  var mjpegOnly = /* @__PURE__ */ new Set();
  function serverCamera(box, cam, title, key2) {
    var _a, _b;
    const delay = outputDelay();
    const query = `cam=${encodeURIComponent(cam.device_id)}&res=${encodeURIComponent(((_a = ctx.settings) == null ? void 0 : _a.camera_resolution) || "720p")}${delay ? `&delay=${delay}` : ""}&t=${Date.now()}`;
    const retry = () => {
      if (cameraKey === key2) serverCamera(box, cam, title, key2);
    };
    if (((_b = ctx.settings) == null ? void 0 : _b.h264_cameras) && h264Supported() && !mjpegOnly.has(cam.device_id)) {
      const video = createLiveCamera(`/api/studio/video?${query}`, {
        format: "h264",
        onError: (reason, status) => {
          video.closeStream();
          if (status === 415 || status === 0 || reason.startsWith("No H.264")) {
            mjpegOnly.add(cam.device_id);
            retry();
          } else {
            showCameraError(box, title, reason, retry, status);
          }
        },
        onEnded: () => {
          video.closeStream();
          reportCameraProblem(title, "Stream ended or stalled", "ended");
          setTimeout(retry, 1e3);
        }
      });
      setMedia(box, video);
      return;
    }
    const url = `/api/studio/stream?${query}`;
    const canvas = createLiveCamera(url, {
      onError: (reason, status) => showError(reason, status),
      // AutoGlow restarted or the camera went away: connect again while it is still the chosen one
      onEnded: () => {
        canvas.closeStream();
        reportCameraProblem(title, "Stream ended or stalled", "ended");
        setTimeout(retry, 1e3);
      }
    });
    const showError = (reason, status) => {
      canvas.closeStream();
      showCameraError(box, title, reason, retry, status);
    };
    setMedia(box, canvas);
  }
  var reported = /* @__PURE__ */ new Map();
  function reportCameraProblem(title, reason, status) {
    const key2 = `${title}|${reason}|${status}`;
    if (Date.now() - (reported.get(key2) || 0) < 6e4) return;
    reported.set(key2, Date.now());
    fetch("/api/studio/output-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ camera: title, message: reason || "", status: status != null ? status : null, secure: window.isSecureContext, webcodecs: typeof VideoDecoder !== "undefined" })
    }).catch(() => {
    });
  }
  function showCameraError(box, title, reason, retry, status) {
    reportCameraProblem(title, reason, status);
    const action = (reason || "").startsWith(STOPPED) ? { label: "Start Autodarts", busy: "Starting\u2026", done: "Started", run: async () => {
      const ok = await startAutodarts();
      if (ok) setTimeout(retry, 1500);
      return ok;
    } } : null;
    emptyCam(box, title, reason || "Camera not reachable", action);
    setTimeout(retry, 5e3);
  }
  async function browserCamera(box, cam, title) {
    var _a;
    if (!((_a = navigator.mediaDevices) == null ? void 0 : _a.getUserMedia)) {
      emptyCam(box, title, "This is a camera of another browser. In AutoGlow \u203A Studio choose a camera of the AutoGlow computer to show it on every device.");
      return;
    }
    const want = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: __spreadProps(__spreadValues({}, want), { deviceId: { exact: cam.device_id } }), audio: false });
      } catch (err) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const match = devices.find((d) => d.kind === "videoinput" && cam.label && d.label === cam.label);
        if (!match) throw err;
        stream = await navigator.mediaDevices.getUserMedia({ video: __spreadProps(__spreadValues({}, want), { deviceId: { exact: match.deviceId } }), audio: false });
      }
      streams.push(stream);
      const video = el("video");
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.srcObject = stream;
      setMedia(box, video);
    } catch (err) {
      emptyCam(box, title, `${cam.label || "Camera"} not available: ${err.message || err.name}`);
    }
  }
  function startCamera(box, cam, title, chroma) {
    applyFraming(box, cam);
    box.dataset.kind = cam.kind || "none";
    if (chroma) {
      box.replaceChildren();
      return;
    }
    if (cam.kind === "server" && cam.device_id) {
      serverCamera(box, cam, title, cameraKey);
    } else if (cam.kind === "device" && cam.device_id) {
      browserCamera(box, cam, title);
    } else if (cam.kind === "url" && cam.url) {
      const isVideo = /\.(mp4|webm|ogg|m3u8)(\?|$)/i.test(cam.url);
      const media = el(isVideo ? "video" : "img");
      if (isVideo) {
        media.muted = true;
        media.autoplay = true;
        media.loop = true;
        media.playsInline = true;
      }
      media.src = cam.url;
      media.onerror = () => emptyCam(box, title, `Stream not reachable: ${cam.url}`);
      setMedia(box, media);
    } else {
      emptyCam(box, title, "Choose a camera in AutoGlow \u203A Studio");
    }
  }
  var streamKey = (cam) => cam && [cam.kind, cam.device_id, cam.label, cam.url];
  function applyCameras(chroma) {
    var _a, _b;
    const cams = ((_a = ctx.settings) == null ? void 0 : _a.cameras) || {};
    applyFraming(boxes.board, cams.board || {});
    applyFraming(boxes.player, cams.player || {});
    const key2 = JSON.stringify([streamKey(cams.board), streamKey(cams.player), (_b = ctx.settings) == null ? void 0 : _b.camera_resolution, chroma, outputDelay()]);
    if (key2 === cameraKey) return;
    cameraKey = key2;
    resetDartZoom();
    stopStreams();
    for (const [slot, title] of [["board", "Board camera"], ["player", "Player camera"]]) {
      if (hasCamera(cams[slot])) startCamera(boxes[slot], cams[slot], title, chroma);
      else boxes[slot].replaceChildren();
    }
  }
  function drawBlur() {
    const source = boxes.board.querySelector(MEDIA_SELECTOR) || boxes.player.querySelector(MEDIA_SELECTOR);
    if (!blurCanvas || !isReady(source)) return;
    const box = source.closest(".cam");
    if (drawSoft(source, blurCanvas, Number((box == null ? void 0 : box.dataset.rot) || 0), (box == null ? void 0 : box.classList.contains("mirror")) ? -1 : 1)) {
      blurCanvas.classList.add("has-frame");
    }
  }
  function setBlur(on) {
    clearInterval(blurTimer);
    blurTimer = null;
    if (on) {
      drawBlur();
      blurTimer = setInterval(drawBlur, BLUR_MS);
    }
  }

  // js/checkout.js
  var BOGEY = /* @__PURE__ */ new Set([169, 168, 166, 165, 163, 162, 159]);
  var GOOD_DOUBLES = [20, 16, 8, 10, 12, 18];
  var NUMBERS = Array.from({ length: 20 }, (_, i) => 20 - i);
  var SETUP = [
    ...NUMBERS.map((n2) => ({ label: `T${n2}`, value: 3 * n2, cost: (20 - n2) * 2 })),
    ...NUMBERS.map((n2) => ({ label: `S${n2}`, value: n2, cost: 15 + (20 - n2) })),
    { label: "25", value: 25, cost: 12 },
    { label: "Bull", value: 50, cost: 30 },
    ...NUMBERS.map((n2) => ({ label: `D${n2}`, value: 2 * n2, cost: 40 }))
  ];
  function doubleCost(n2) {
    const good = GOOD_DOUBLES.indexOf(n2);
    return good >= 0 ? good * 3 : 25 + (20 - n2);
  }
  function finishers(outMode) {
    const doubles = [...NUMBERS.map((n2) => ({ label: `D${n2}`, value: 2 * n2, cost: doubleCost(n2) })), { label: "Bull", value: 50, cost: 20 }];
    if (outMode === "Straight") return [...doubles, ...SETUP];
    if (outMode === "Master") return [...doubles, ...SETUP.filter((d) => d.label.startsWith("T"))];
    return doubles;
  }
  var cache = /* @__PURE__ */ new Map();
  function checkoutRoute(remaining, darts = 3, outMode = "Double") {
    if (!Number.isFinite(remaining) || remaining < 2 || remaining > 170 || darts < 1) return null;
    if (outMode !== "Straight" && BOGEY.has(remaining)) return null;
    const key2 = `${remaining}|${darts}|${outMode}`;
    if (cache.has(key2)) return cache.get(key2);
    const finish = finishers(outMode);
    let route = null;
    for (let n2 = 1; n2 <= Math.min(3, darts) && !route; n2++) route = best(remaining, n2, finish);
    cache.set(key2, route);
    return route;
  }
  function best(remaining, n2, finish) {
    let found = null;
    let foundCost = Infinity;
    const consider = (setup, last) => {
      const cost = setup.reduce((sum, d) => sum + d.cost, 0) + last.cost;
      if (cost < foundCost) {
        found = [...setup, last].map((d) => d.label);
        foundCost = cost;
      }
    };
    for (const last of finish) {
      const rest = remaining - last.value;
      if (n2 === 1 && rest === 0) consider([], last);
      if (n2 === 2) {
        for (const a of SETUP) if (a.value === rest) consider([a], last);
      }
      if (n2 === 3) {
        for (const a of SETUP) for (const b of SETUP) if (a.value + b.value === rest) consider(a.cost <= b.cost ? [a, b] : [b, a], last);
      }
    }
    return found;
  }

  // js/scoreboard.js
  var $ = (id) => document.getElementById(id);
  function renderBoard(state, prev2) {
    const showSets = state.uses_sets;
    $("scoreboard").classList.toggle("no-sets", !showSets);
    $("boardTarget").textContent = state.target || state.variant || "";
    $("boardSetsLabel").textContent = t("board_sets");
    $("boardLegsLabel").textContent = t("board_legs");
    const rows = state.players.map((p, i) => {
      var _a, _b;
      const row = el("div", "board-row");
      if (i === state.active && !state.finished) row.classList.add("active");
      if (state.finished && state.winner === i) row.classList.add("winner");
      const name = el("div", "board-name");
      name.append(avatar(p));
      name.append(el("span", "name", displayName(p)));
      const country = ((_a = studioPlayer(p)) == null ? void 0 : _a.country) || p.country;
      if (country) name.append(el("span", "country", country));
      const sets = el("div", "board-cell sets", showSets ? p.sets : "");
      const legs = el("div", "board-cell", p.legs);
      const score = el("div", "board-cell score", fmt(p.remaining));
      const old = (_b = prev2 == null ? void 0 : prev2.players) == null ? void 0 : _b[i];
      if (old && old.remaining !== p.remaining) score.classList.add("flash");
      if (old && (old.legs !== p.legs || old.sets !== p.sets)) {
        legs.classList.add("flash");
        sets.classList.add("flash");
      }
      row.append(name, sets, legs, score, el("span", "marker"));
      return row;
    });
    $("boardRows").replaceChildren(...rows);
    const parts = [eventTitle(""), eventSubtitle()].filter(Boolean);
    const progress = [state.uses_sets && state.set ? tn("board_set", state.set) : "", state.leg ? tn("board_leg", state.leg) : ""].filter(Boolean).join(" \xB7 ");
    $("boardTitle").textContent = [parts.join(" \u2013 "), progress].filter(Boolean).join("   |   ");
  }
  function dartsLeft(state) {
    const turn = state.turn || {};
    if (turn.player !== state.active || turn.busted) return 3;
    return Math.max(0, 3 - (turn.darts || []).length);
  }
  function nineDarterOn(state, player) {
    var _a;
    if (state.base_score !== 501 || !player) return false;
    const darts = (_a = player.leg_stats) == null ? void 0 : _a.dartsThrown;
    const rem = player.remaining;
    if (darts === 3) return rem <= 350 && rem >= 2;
    if (darts === 6) return !!checkoutRoute(rem, 3, state.out_mode || "Double");
    return false;
  }
  function renderVisit(state) {
    var _a, _b;
    const visit = $("visit");
    const turn = state.turn || {};
    const darts = turn.darts || [];
    const active2 = state.players[state.active];
    const showCheckout = ((_a = ctx.settings) == null ? void 0 : _a.show_checkout) !== false;
    let route = [];
    if (showCheckout && active2 && !state.finished) {
      route = ((_b = state.checkout) == null ? void 0 : _b.length) ? state.checkout : checkoutRoute(active2.remaining, dartsLeft(state), state.out_mode || "Double") || [];
    }
    const nine = active2 && !state.finished && nineDarterOn(state, active2);
    if (state.finished || !darts.length && !route.length && !nine) {
      visit.hidden = true;
      return;
    }
    const items = [];
    for (let i = 0; i < 3; i++) items.push(el("div", darts[i] ? "dart" : "dart empty", darts[i] || "\u2022"));
    if (darts.length) items.push(el("div", turn.busted ? "total bust" : "total", turn.busted ? t("visit_bust") || fmt(turn.points) : fmt(turn.points)));
    if (route.length) {
      const co = el("div", "checkout");
      if (t("visit_checkout")) co.append(el("small", null, tn("visit_checkout", fmt(active2.remaining))));
      co.append(document.createTextNode(route.join(" ")));
      items.push(co);
    }
    if (nine && t("visit_nine")) items.push(el("div", "nine", t("visit_nine")));
    visit.replaceChildren(...items);
    visit.hidden = false;
  }
  function renderPlayerCard(state) {
    var _a;
    const card = $("playerCard");
    if (((_a = ctx.settings) == null ? void 0 : _a.show_player_card) === false || state.players.length !== 2) {
      card.hidden = true;
      return;
    }
    const head = el("div", "pc-head", state.variant ? `${state.variant}${state.base_score ? " " + state.base_score : ""}` : "Match");
    const faces = el("div", "pc-faces");
    const values = el("div", "pc-values");
    state.players.forEach((p, i) => {
      const face = el("div", "pc-face");
      if (i === state.active && !state.finished) face.classList.add("active");
      face.append(avatar(p, "pc-img"), el("span", "pc-name", displayName(p)));
      faces.append(face);
      const v = el("div", null, fmtAvg(p.average));
      v.append(el("small", null, t("card_avg")));
      values.append(v);
    });
    const foot = el("div", "pc-foot", state.round && tn("card_round", state.round) || eventTitle(""));
    card.replaceChildren(head, faces, values, foot);
    card.hidden = false;
  }

  // js/dartboard.js
  var SVG_NS2 = "http://www.w3.org/2000/svg";
  var ORDER = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
  var R = { bull: 6.35 / 170, outerBull: 15.9 / 170, trebleIn: 99 / 170, trebleOut: 107 / 170, doubleIn: 162 / 170, doubleOut: 1 };
  var BED_RADIUS = { SingleInner: 0.36, Triple: 0.605, SingleOuter: 0.79, Double: 0.976 };
  function segmentPosition(number, bed, multiplier) {
    var _a;
    const jitter = () => Math.random() - 0.5;
    if (number === 25) {
      const r = multiplier === 2 ? R.bull * 0.6 : (R.bull + R.outerBull) / 2;
      const a = Math.random() * Math.PI * 2;
      return { x: Math.sin(a) * r, y: Math.cos(a) * r };
    }
    const index = ORDER.indexOf(number);
    if (index < 0) {
      const a = Math.random() * Math.PI * 2;
      return { x: Math.sin(a) * 1.08, y: Math.cos(a) * 1.08 };
    }
    const bedName = bed || (multiplier === 3 ? "Triple" : multiplier === 2 ? "Double" : "SingleInner");
    const radius = ((_a = BED_RADIUS[bedName]) != null ? _a : BED_RADIUS.SingleInner) + jitter() * 0.03;
    const angle = (index * 18 + jitter() * 12) * Math.PI / 180;
    return { x: Math.sin(angle) * radius, y: Math.cos(angle) * radius };
  }
  function dartPosition(t2) {
    if (typeof t2.x === "number" && typeof t2.y === "number") return { x: t2.x, y: t2.y };
    if (!t2._pos) t2._pos = segmentPosition(t2.number, t2.bed, t2.multiplier);
    return t2._pos;
  }
  function svg(tag, attrs) {
    const node = document.createElementNS(SVG_NS2, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }
  function sector(r1, r2, a1, a2, fill) {
    const p = (r, a) => `${(Math.sin(a * Math.PI / 180) * r).toFixed(4)} ${(-Math.cos(a * Math.PI / 180) * r).toFixed(4)}`;
    const d = `M${p(r1, a1)} L${p(r2, a1)} A${r2} ${r2} 0 0 1 ${p(r2, a2)} L${p(r1, a2)} A${r1} ${r1} 0 0 0 ${p(r1, a1)}Z`;
    return svg("path", { d, fill });
  }
  function buildBoard() {
    const root = svg("svg", { viewBox: "-1.32 -1.32 2.64 2.64", class: "db-svg" });
    root.append(svg("circle", { cx: 0, cy: 0, r: 1.32, fill: "#0b0b0d" }));
    ORDER.forEach((number, i) => {
      const a1 = i * 18 - 9;
      const a2 = a1 + 18;
      const dark = i % 2 === 0;
      const single = dark ? "#16181c" : "#e9dfc4";
      const ring = dark ? "#d3302f" : "#1d8a4e";
      root.append(
        sector(R.outerBull, R.trebleIn, a1, a2, single),
        sector(R.trebleIn, R.trebleOut, a1, a2, ring),
        sector(R.trebleOut, R.doubleIn, a1, a2, single),
        sector(R.doubleIn, R.doubleOut, a1, a2, ring)
      );
      const a = i * 18 * Math.PI / 180;
      const label = svg("text", { x: (Math.sin(a) * 1.16).toFixed(3), y: (-Math.cos(a) * 1.16 + 0.055).toFixed(3), class: "db-num" });
      label.textContent = number;
      root.append(label);
    });
    root.append(svg("circle", { cx: 0, cy: 0, r: R.outerBull, fill: "#1d8a4e" }));
    root.append(svg("circle", { cx: 0, cy: 0, r: R.bull, fill: "#d3302f" }));
    const heat = svg("g", { class: "db-heat" });
    const darts = svg("g", { class: "db-darts" });
    root.append(heat, darts);
    return { root, heat, darts };
  }
  var MiniBoard = class {
    constructor(host) {
      this.host = host;
      const { root, heat, darts } = buildBoard();
      this.heat = heat;
      this.darts = darts;
      this.title = el("div", "db-title");
      host.replaceChildren(this.title, root);
      this.key = "";
    }
    // throws: darts of the current visit; history: earlier darts of the same player this match
    update(playerName, throws, history) {
      const key2 = `${playerName}|${throws.map((t2) => t2.id || t2.label).join(",")}|${history.length}`;
      if (key2 === this.key) return;
      this.key = key2;
      this.title.textContent = playerName || "";
      this.heat.replaceChildren(...history.slice(-120).map((t2) => {
        const { x, y } = dartPosition(t2);
        return svg("circle", { cx: x.toFixed(4), cy: (-y).toFixed(4), r: 0.035, class: "db-heat-dot" });
      }));
      this.darts.replaceChildren(...throws.map((t2, i) => {
        const { x, y } = dartPosition(t2);
        const g = svg("g", { transform: `translate(${x.toFixed(4)} ${(-y).toFixed(4)})` });
        const pop = svg("g", { class: "db-dart" });
        pop.append(svg("circle", { r: 0.075, class: "db-dart-dot" }));
        const n2 = svg("text", { y: 0.032, class: "db-dart-num" });
        n2.textContent = i + 1;
        pop.append(n2);
        g.append(pop);
        return g;
      }));
    }
  };

  // js/scenes.js
  var $2 = (id) => document.getElementById(id);
  var INTRO_MS = 7500;
  var LEG_CARD_MS = 6500;
  var SLIDE_MS = 8e3;
  var STINGER_COVER_MS = 520;
  var STINGER_MS = 1250;
  var stingerRun = 0;
  async function stinger(onCover) {
    const mine = ++stingerRun;
    const box = $2("stinger");
    box.classList.remove("run");
    void box.offsetWidth;
    box.classList.add("run");
    await sleep(STINGER_COVER_MS);
    if (mine !== stingerRun) return;
    if (onCover) onCover();
    await sleep(STINGER_MS - STINGER_COVER_MS);
    if (mine === stingerRun) box.classList.remove("run");
  }
  function stopStinger() {
    stingerRun++;
    $2("stinger").classList.remove("run");
  }
  var slideTimer = null;
  var slideIndex = 0;
  var clockTimer = null;
  var lobby = null;
  var lobbyKey = "";
  function brandSlide() {
    const s = el("div", "slide slide-brand");
    s.append(
      el("div", "sb-kicker", t("idle_kicker")),
      el("div", "sb-title", eventTitle()),
      el("div", "sb-sub", eventSubtitle() || t("idle_tagline"))
    );
    return s;
  }
  function factRow(label, value) {
    if (!value || !label) return null;
    const row = el("div", "fact");
    row.append(el("span", null, label), el("strong", null, value));
    return row;
  }
  function playerSlide(player) {
    const p = profile(player);
    const s = el("div", "slide slide-player");
    const pic = el("div", "sp-pic");
    pic.append(avatar(player, "sp-img"));
    const info = el("div", "sp-info");
    info.append(
      el("div", "sp-kicker", p.club || t("idle_player_kicker")),
      el("div", "sp-name", p.name),
      p.nickname ? el("div", "sp-nick", `\u201C${p.nickname}\u201D`) : "",
      el("div", "sp-facts", null)
    );
    info.lastChild.append(...[
      factRow(t("fact_from"), [p.hometown, p.country].filter(Boolean).join(", ")),
      factRow(t("fact_throws"), p.hand),
      factRow(t("fact_darts"), p.dartWeight && `${p.dartWeight} g`),
      factRow(t("stat_fav_double"), p.favouriteDouble),
      factRow(t("fact_since"), p.playingSince)
    ].filter(Boolean));
    const stats = el("div", "sp-stats");
    for (const [label, value] of [[t("stat_average"), p.average], [t("stat_180s"), p.oneEighties], [t("stat_best_checkout"), p.bestCheckout]]) {
      if (!value || !label) continue;
      const b = el("div", "sp-stat");
      b.append(el("strong", null, value), el("span", null, label));
      stats.append(b);
    }
    info.append(stats);
    s.append(pic, info);
    return s;
  }
  function versusSlide(a, b, info) {
    const s = el("div", "slide slide-result slide-versus");
    s.append(el("div", "sb-kicker", t("lobby_kicker")));
    const row = el("div", "sr-row");
    for (const [i, p] of [a, b].entries()) {
      const side = el("div", "sr-side won");
      side.append(avatar(p, "sr-img"), el("div", "sr-name", displayName(p)));
      const avg = profile(p).average;
      if (avg) side.append(el("div", "sr-avg", `${avg} avg`));
      row.append(side);
      if (i === 0) row.append(el("div", "sr-score", t("intro_vs") || "VS"));
    }
    s.append(row);
    const format = [info == null ? void 0 : info.variant, info == null ? void 0 : info.base_score, info == null ? void 0 : info.target].filter(Boolean).join(" \xB7 ");
    if (format) s.append(el("div", "sb-sub", format));
    return s;
  }
  var BOARD_MS = 6e4;
  var board2 = null;
  var boardAt = 0;
  async function loadBoard() {
    if (Date.now() - boardAt < BOARD_MS) return;
    boardAt = Date.now();
    try {
      const res = await fetch("/api/club/leaderboards?period=season", { cache: "no-store" });
      if (res.ok) board2 = await res.json();
    } catch (e) {
    }
  }
  var hasBoard = () => ["average", "t180", "best_checkout"].some((k) => {
    var _a;
    return (_a = board2 == null ? void 0 : board2[k]) == null ? void 0 : _a.length;
  });
  function leaderboardSlide() {
    const s = el("div", "slide slide-brand slide-board");
    s.append(el("div", "sb-kicker", [t("idle_board_kicker"), (/* @__PURE__ */ new Date()).getFullYear()].filter(Boolean).join(" \xB7 ")), el("div", "sb-title", eventTitle()));
    const cols = el("div", "lb-cols");
    for (const [key2, label, show] of [["average", t("stat_average"), (v) => fmtAvg(v)], ["t180", t("stat_180s"), (v) => String(v)], ["best_checkout", t("stat_best_checkout"), (v) => String(v)]]) {
      const rows = ((board2 == null ? void 0 : board2[key2]) || []).slice(0, 5);
      if (!rows.length || !label) continue;
      const col = el("div", "sp-stat lb-col");
      col.append(el("span", null, label));
      for (const [i, r] of rows.entries()) {
        const row = el("div", `lb-row${i === 0 ? " top" : ""}`);
        row.append(el("em", null, String(i + 1)), avatar({ name: r.name, studio_id: r.member }, "lb-img"), el("b", null, r.name || ""), el("strong", null, show(r.value)));
        col.append(row);
      }
      cols.append(col);
    }
    s.append(cols);
    return s;
  }
  function idleSlides() {
    const players = (lobby == null ? void 0 : lobby.players) || [];
    loadBoard();
    if (players.length !== 2) return hasBoard() ? [brandSlide, leaderboardSlide] : [brandSlide];
    const [a, b] = players;
    return [() => versusSlide(a, b, lobby), () => playerSlide(a), () => playerSlide(b)];
  }
  function showNextSlide() {
    const host = $2("idleSlides");
    const slides = idleSlides();
    if (slides.length === 1 && slideIndex > 0 && host.querySelector(".slide:not(.out)")) return;
    const slide = slides[slideIndex % slides.length]();
    slideIndex++;
    host.querySelectorAll(".slide").forEach((old) => {
      old.classList.add("out");
      setTimeout(() => old.remove(), 700);
    });
    host.append(slide);
  }
  function setLobby(next) {
    const key2 = JSON.stringify(((next == null ? void 0 : next.players) || []).map((p) => [p.name, p.studio_id || ""]).concat([(next == null ? void 0 : next.target) || "", (next == null ? void 0 : next.base_score) || ""]));
    lobby = next;
    if (key2 === lobbyKey) return;
    lobbyKey = key2;
    if (slideTimer) startIdle();
  }
  var lobbyReady = () => ((lobby == null ? void 0 : lobby.players) || []).length === 2;
  function tickClock() {
    const now = /* @__PURE__ */ new Date();
    $2("idleClock").textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  function startIdle() {
    stopIdle();
    slideIndex = 0;
    showNextSlide();
    slideTimer = setInterval(showNextSlide, SLIDE_MS);
    tickClock();
    clockTimer = setInterval(tickClock, 1e4);
  }
  function showIdleSlide(kind, sample) {
    var _a;
    stopIdle();
    const players = ((_a = sample == null ? void 0 : sample.players) == null ? void 0 : _a.length) >= 2 ? sample.players : studioPlayersAsPlayers();
    const make = kind === "board" ? leaderboardSlide : kind === "player" && players.length ? () => playerSlide(players[0]) : kind === "versus" && players.length >= 2 ? () => versusSlide(players[0], players[1], sample) : brandSlide;
    $2("idleSlides").replaceChildren(make());
    if (kind === "board") {
      loadBoard().then(() => {
        const host = $2("idleSlides");
        if (host.querySelector(".slide-board")) host.replaceChildren(leaderboardSlide());
      });
    }
    tickClock();
  }
  function stopIdle() {
    clearInterval(slideTimer);
    clearInterval(clockTimer);
    slideTimer = null;
  }
  function introSide(player, side) {
    const p = profile(player);
    const box = el("div", `intro-side ${side}`);
    const pic = el("div", "intro-pic");
    pic.append(avatar(player, "intro-img"));
    const info = el("div", "intro-info");
    info.append(
      p.club ? el("div", "intro-club", p.club) : "",
      el("div", "intro-name", p.name),
      p.nickname ? el("div", "intro-nick", `\u201C${p.nickname}\u201D`) : "",
      el("div", "intro-meta", [p.hometown, p.country, p.hand && `${p.hand}-handed`, p.dartWeight && `${p.dartWeight} g`].filter(Boolean).join("  \xB7  "))
    );
    box.append(pic, info);
    return box;
  }
  function introStats(a, b) {
    const pa = profile(a);
    const pb = profile(b);
    const rows = [
      [t("stat_average"), pa.average, pb.average],
      [t("stat_180s"), pa.oneEighties, pb.oneEighties],
      [t("stat_best_checkout"), pa.bestCheckout, pb.bestCheckout],
      [t("stat_fav_double"), pa.favouriteDouble, pb.favouriteDouble]
    ].filter(([label, x, y]) => label && (x || y));
    const box = el("div", "intro-stats");
    for (const [label, x, y] of rows) {
      const row = el("div", "is-row");
      const nx = parseFloat(x);
      const ny = parseFloat(y);
      const both = Number.isFinite(nx) && Number.isFinite(ny) && nx + ny > 0;
      const left = el("div", "is-val left", x || "\u2013");
      const right = el("div", "is-val right", y || "\u2013");
      const mid = el("div", "is-label", label);
      if (both) {
        const bar = el("div", "is-bar");
        const l = el("i", "l");
        const r = el("i", "r");
        l.style.setProperty("--w", `${nx / (nx + ny) * 100}%`);
        r.style.setProperty("--w", `${ny / (nx + ny) * 100}%`);
        bar.append(l, r);
        mid.append(bar);
      }
      row.append(left, mid, right);
      box.append(row);
    }
    return box;
  }
  async function playIntro(state) {
    const box = $2("intro");
    const [a, b] = state.players;
    const top = el("div", "intro-top");
    top.append(
      el("span", null, eventTitle()),
      el("strong", null, [state.variant, state.base_score, state.target].filter(Boolean).join(" \xB7 ") || "Match")
    );
    const parts = [top, introSide(a, "left")];
    if (b) parts.push(el("div", "intro-vs", t("intro_vs")), introSide(b, "right"), introStats(a, b));
    box.replaceChildren(...parts);
    box.classList.toggle("solo", !b);
    box.hidden = false;
    box.classList.remove("out");
    void box.offsetWidth;
    box.classList.add("in");
    await sleep(INTRO_MS);
  }
  function hideIntro() {
    const box = $2("intro");
    box.classList.remove("in");
    box.hidden = true;
  }
  var legRun = 0;
  async function showLegCard(info, { hold = false } = {}) {
    const mine = ++legRun;
    const box = $2("legCard");
    const head = el("div", "lc-head");
    head.append(el("span", null, info.label), el("strong", null, info.title));
    const who = el("div", "lc-who");
    who.append(avatar(info.player, "lc-img"), el("div", "lc-name", displayName(info.player)));
    const grid = el("div", "lc-grid");
    for (const [label, value] of [[t("stat_darts"), info.darts], [t("stat_leg_average"), info.average], [t("stat_checkout"), info.checkout], [t("stat_180s"), info.oneEighties]]) {
      if (value === null || value === void 0 || value === "" || !label) continue;
      const cell = el("div", "lc-cell");
      cell.append(el("strong", null, value), el("span", null, label));
      grid.append(cell);
    }
    box.replaceChildren(head, who, grid);
    box.hidden = false;
    box.classList.remove("out");
    void box.offsetWidth;
    box.classList.add("in");
    if (hold) return;
    await sleep(LEG_CARD_MS);
    if (mine === legRun) hideLegCard();
  }
  async function hideLegCard() {
    const mine = legRun;
    const box = $2("legCard");
    if (box.hidden) return;
    box.classList.add("out");
    await sleep(450);
    if (mine !== legRun) return;
    box.hidden = true;
    box.classList.remove("in", "out");
  }
  function showMatchCard(state, extra) {
    var _a;
    const box = $2("matchCard");
    const winner = state.players[(_a = state.winner) != null ? _a : 0];
    const pic = el("div", "mc-pic");
    pic.append(avatar(winner, "mc-img"));
    const side = el("div", "mc-side");
    const score = state.players.map((p) => state.uses_sets ? p.sets : p.legs).join(" \u2013 ");
    side.append(el("div", "mc-kicker", t("match_winner")), el("div", "mc-name", displayName(winner)), el("div", "mc-score", score));
    const table = el("div", "mc-table");
    const head = el("div", "mc-row mc-headrow");
    head.append(el("span", null, ""), ...state.players.map((p) => el("strong", null, displayName(p))));
    table.append(head);
    const stat = (p, key2) => {
      var _a2;
      return (_a2 = p.match_stats) == null ? void 0 : _a2[key2];
    };
    const rows = [
      [t("stat_average"), (p) => fmtAvg(p.average)],
      [t("stat_first9"), (p) => fmtAvg(stat(p, "first9Average"))],
      [t("stat_180s"), (p) => {
        var _a2;
        return fmt((_a2 = stat(p, "total180")) != null ? _a2 : 0);
      }],
      [t("stat_140"), (p) => {
        var _a2;
        return fmt((_a2 = stat(p, "plus140")) != null ? _a2 : 0);
      }],
      [t("stat_100"), (p) => {
        var _a2;
        return fmt((_a2 = stat(p, "plus100")) != null ? _a2 : 0);
      }],
      [t("stat_checkout_pct"), (p) => typeof stat(p, "checkoutPercent") === "number" ? `${Math.round(stat(p, "checkoutPercent") * (stat(p, "checkoutPercent") <= 1 ? 100 : 1))}%` : "\u2013"],
      [t("stat_best_checkout"), (p) => fmt(p.best_checkout || extra.bestCheckout[p.index]) || "\u2013"],
      [t("stat_darts"), (p) => fmt(stat(p, "dartsThrown")) || "\u2013"]
    ];
    for (const [label, value] of rows) {
      if (!label) continue;
      const row = el("div", "mc-row");
      row.append(el("span", null, label), ...state.players.map((p) => el("strong", null, value(p))));
      table.append(row);
    }
    side.append(table);
    box.replaceChildren(pic, side);
    box.hidden = false;
    void box.offsetWidth;
    box.classList.add("in");
  }
  function hideMatchCard() {
    const box = $2("matchCard");
    box.classList.remove("in");
    box.hidden = true;
  }
  var momentTimer = null;
  function hideMoment() {
    clearTimeout(momentTimer);
    $2("moment").hidden = true;
  }
  function showMoment(kind, big, sub, player, { hold: keep = false } = {}) {
    if (!big && !keep) return Promise.resolve();
    const box = $2("moment");
    clearTimeout(momentTimer);
    box.className = `moment ${kind}`;
    const children = [];
    if (player && (kind === "match" || kind === "nine" || kind === "bulloff") && pictureUrl(player)) {
      const img = el("img", "m-pic");
      img.src = pictureUrl(player);
      img.onerror = () => img.remove();
      children.push(img);
    }
    children.push(el("div", "m-big", big));
    if (sub) children.push(el("div", "m-sub", sub));
    box.replaceChildren(...children);
    box.hidden = false;
    if (keep) return Promise.resolve();
    const hold = kind === "match" || kind === "nine" ? 6e3 : kind === "bulloff" ? 4500 : kind === "bust" ? 1800 : 3200;
    momentTimer = setTimeout(() => {
      box.classList.add("out");
      momentTimer = setTimeout(() => {
        box.hidden = true;
      }, 400);
    }, hold);
    return sleep(hold + 400);
  }

  // js/demo.js
  var DART_MS = 1100;
  var TAKEOUT_MS = 2400;
  var IDLE_MS = 9e3;
  var LOBBY_MS = 24e3;
  var LEG_BREAK_MS = 9e3;
  var MATCH_END_MS = 32e3;
  var BULL_OFF_INTRO_MS = 12e3;
  var BULL_OFF_DART_MS = 4e3;
  var BULL_OFF_RESULT_MS = 8e3;
  var LEGS = [
    [
      [0, "T20", "T20", "T20"],
      [1, "T20", "T20", "S20"],
      [0, "T20", "T20", "S20"],
      [1, "S20", "T20", "S20"],
      [0, "T20", "T20", "T20"],
      [1, "T20", "T20", "T20"],
      [0, "T20", "T20", "S1"],
      [1, "T19", "S16", "D4"]
    ],
    [
      [1, "T20", "T20", "T20"],
      [0, "T20", "T20", "T20"],
      [1, "T20", "T20", "S20"],
      [0, "T20", "T20", "T20"],
      [1, "T20", "T20", "T20"],
      [0, "T20", "T19", "D12"]
    ],
    [
      [0, "T20", "T20", "T20"],
      [1, "T20", "S20", "S5"],
      [0, "T20", "T20", "S20"],
      [1, "T20", "T20", "T20"],
      [0, "T20", "T20", "S1"],
      [1, "S20", "S20", "S20"],
      [0, "S20", "D20"]
    ]
  ];
  var LEGS_TO_WIN = 2;
  function parseDart(label) {
    if (label === "Bull") return { number: 25, multiplier: 2, bed: "Double", value: 50 };
    if (label === "25") return { number: 25, multiplier: 1, bed: "Single", value: 25 };
    const multiplier = { S: 1, D: 2, T: 3 }[label[0]];
    const number = Number(label.slice(1));
    const bed = multiplier === 3 ? "Triple" : multiplier === 2 ? "Double" : Math.random() < 0.5 ? "SingleInner" : "SingleOuter";
    return { number, multiplier, bed, value: number * multiplier };
  }
  function emptyStats() {
    return { average: 0, first9Average: 0, dartsThrown: 0, total180: 0, plus140: 0, plus100: 0, checkoutPercent: 0, checkoutsHit: 0, checkouts: 0 };
  }
  var uid = 0;
  var nextId = () => `demo-${++uid}`;
  function demoNames() {
    const studio = studioPlayersAsPlayers().map((p) => p.name);
    return [studio[0] || "Player One", studio[1] || "Player Two"];
  }
  var DemoFeed = class {
    constructor() {
      this.state = { live: false, players: [], source: { connected: true, tab_attached: true } };
      this.run();
    }
    current() {
      return JSON.parse(JSON.stringify(this.state));
    }
    async run() {
      for (; ; ) {
        this.state = { live: false, players: [], source: { connected: true, tab_attached: true } };
        await sleep(IDLE_MS);
        this.state = __spreadProps(__spreadValues({}, this.state), {
          lobby: {
            id: nextId(),
            variant: "X01",
            base_score: 501,
            target: `First to ${LEGS_TO_WIN} legs`,
            players: demoNames().map((name, index) => ({ index, name, avatar_url: "", country: "" }))
          }
        });
        await sleep(LOBBY_MS);
        const matchId = await this.playBullOff();
        await this.playMatch(matchId);
        await sleep(MATCH_END_MS);
      }
    }
    // Bull-off before the first leg (closest to the bull): player one wins and throws first
    async playBullOff() {
      const id = nextId();
      const bo = bullOff(id, "Normal");
      this.state = { live: true, players: [], source: { connected: true, tab_attached: true }, bull_off: bo };
      await sleep(BULL_OFF_INTRO_MS);
      for (const [i, mm, angle] of [[0, 9.4, 200], [1, 21.7, 70]]) {
        bo.active = i;
        await sleep(BULL_OFF_DART_MS);
        Object.assign(bo.players[i], bullDart(mm, angle));
        bo.leader = leaderOf(bo);
      }
      bo.decided = true;
      bo.winner = 0;
      bo.leader = 0;
      bo.active = null;
      await sleep(BULL_OFF_RESULT_MS);
      return id;
    }
    newMatch(matchId) {
      const names = demoNames();
      this.points = [0, 0];
      this.first9 = [[], []];
      this.state = {
        live: true,
        demo: true,
        match_id: matchId || nextId(),
        variant: "X01",
        base_score: 501,
        out_mode: "Double",
        target: `First to ${LEGS_TO_WIN} legs`,
        uses_sets: false,
        set: 1,
        leg: 1,
        round: 1,
        active: 0,
        finished: false,
        winner: null,
        phase: "throw",
        checkout: [],
        source: { connected: true, tab_attached: true },
        players: names.map((name, index) => ({
          index,
          id: `p${index}`,
          name,
          remaining: 501,
          legs: 0,
          sets: 0,
          average: null,
          avatar_url: "",
          country: "",
          account_average: null,
          rounds: [],
          leg_stats: emptyStats(),
          match_stats: emptyStats()
        })),
        turn: { id: nextId(), player: 0, darts: [], throws: [], points: 0, busted: false }
      };
    }
    async playMatch(matchId) {
      this.newMatch(matchId);
      for (let legIndex = 0; legIndex < LEGS.length; legIndex++) {
        const s = this.state;
        s.leg = legIndex + 1;
        s.round = 1;
        s.players.forEach((p) => {
          p.remaining = 501;
          p.rounds = [];
          p.leg_stats = emptyStats();
        });
        this.first9 = [[], []];
        let legWinner = null;
        for (const [player, ...darts] of LEGS[legIndex]) {
          legWinner = await this.playVisit(player, darts);
          if (legWinner !== null) break;
        }
        const winner = s.players[legWinner];
        winner.legs++;
        if (winner.legs >= LEGS_TO_WIN) {
          s.finished = true;
          s.winner = legWinner;
          s.phase = "idle";
          return;
        }
        s.phase = "takeout";
        await sleep(LEG_BREAK_MS);
      }
    }
    // Returns the player index when this visit wins the leg
    async playVisit(index, darts) {
      const s = this.state;
      const p = s.players[index];
      const start = p.remaining;
      s.active = index;
      s.phase = "throw";
      s.turn = { id: nextId(), player: index, darts: [], throws: [], points: 0, busted: false };
      let won = false;
      for (const label of darts) {
        await sleep(DART_MS);
        const dart = parseDart(label);
        const pos = segmentPosition(dart.number, dart.bed, dart.multiplier);
        s.turn.darts.push(label);
        s.turn.throws.push({ id: nextId(), label, number: dart.number, multiplier: dart.multiplier, bed: dart.bed, x: pos.x, y: pos.y });
        const left = p.remaining - dart.value;
        this.countDart(index, dart.value);
        if (left === 0 && dart.multiplier === 2) {
          p.remaining = 0;
          s.turn.points = start;
          won = true;
          break;
        }
        if (left < 2) {
          this.countDart(index, -(start - p.remaining) - dart.value, 0);
          p.remaining = start;
          s.turn.busted = true;
          s.turn.points = 0;
          break;
        }
        p.remaining = left;
        s.turn.points = start - left;
      }
      const scored = s.turn.busted ? 0 : start - p.remaining;
      p.rounds.push(scored);
      for (const stats of [p.leg_stats, p.match_stats]) {
        if (scored === 180) stats.total180++;
        else if (scored >= 140) stats.plus140++;
        else if (scored >= 100) stats.plus100++;
        if (start <= 170) stats.checkouts++;
        if (won) stats.checkoutsHit++;
        stats.checkoutPercent = stats.checkouts ? stats.checkoutsHit / stats.checkouts : 0;
      }
      if (won) return index;
      await sleep(600);
      s.phase = "takeout_in_progress";
      await sleep(TAKEOUT_MS);
      s.phase = "takeout_finished";
      if (index === 1 || s.players.length === 1) s.round++;
      return null;
    }
    countDart(index, value, darts = 1) {
      const p = this.state.players[index];
      this.points[index] += value;
      for (const stats of [p.leg_stats, p.match_stats]) stats.dartsThrown += darts;
      if (darts) this.first9[index].push(value);
      const legPoints = 501 - p.remaining;
      p.match_stats.average = p.match_stats.dartsThrown ? +(this.points[index] / p.match_stats.dartsThrown * 3).toFixed(2) : 0;
      p.leg_stats.average = p.leg_stats.dartsThrown ? +(Math.max(0, legPoints) / p.leg_stats.dartsThrown * 3).toFixed(2) : 0;
      const f9 = this.first9[index].slice(0, 9);
      p.match_stats.first9Average = f9.length ? +(f9.reduce((a, b) => a + b, 0) / f9.length * 3).toFixed(2) : 0;
      p.average = p.match_stats.average;
    }
  };
  function sampleState() {
    const names = demoNames();
    const stats = (avg, d) => __spreadProps(__spreadValues({}, emptyStats()), { average: avg, first9Average: avg + 8, dartsThrown: d, total180: 2, plus140: 3, plus100: 4, checkoutPercent: 0.4 });
    return {
      live: true,
      match_id: "sample",
      variant: "X01",
      base_score: 501,
      out_mode: "Double",
      target: "First to 2 legs",
      uses_sets: false,
      set: 1,
      leg: 3,
      round: 6,
      active: 0,
      finished: true,
      winner: 0,
      phase: "",
      checkout: [],
      players: names.map((name, index) => ({
        index,
        id: `s${index}`,
        name,
        remaining: index ? 176 : 0,
        legs: index ? 1 : 2,
        sets: 0,
        average: index ? 88.4 : 97.1,
        avatar_url: "",
        country: "",
        account_average: null,
        rounds: [],
        leg_stats: stats(index ? 85 : 99, 15),
        match_stats: stats(index ? 88.4 : 97.1, 45)
      })),
      turn: { id: "sample", player: 0, darts: [], throws: [], points: 0, busted: false }
    };
  }
  function bullOff(id, mode) {
    return {
      match_id: id,
      mode,
      round: 1,
      active: 0,
      decided: false,
      winner: null,
      leader: null,
      history: [],
      variant: "X01",
      base_score: 501,
      target: `First to ${LEGS_TO_WIN} legs`,
      players: demoNames().map((name, index) => ({ index, id: `b${index}`, name, avatar_url: "", country: "", account_average: null, thrown: false }))
    };
  }
  function bullDart(mm, angle) {
    const a = angle * Math.PI / 180;
    const segment = mm <= 6.35 ? 50 : mm <= 15.9 ? 25 : 0;
    const label = segment === 50 ? "Bull" : segment === 25 ? "25" : "S20";
    return { thrown: true, distance: mm, segment, label, x: Math.sin(a) * mm / 170, y: Math.cos(a) * mm / 170 };
  }
  function leaderOf(bo) {
    const thrown = bo.players.filter((p) => p.thrown);
    if (!thrown.length) return null;
    return thrown.reduce((best2, p) => p.distance < best2.distance ? p : best2).index;
  }
  function sampleBullOff(kind = "running") {
    const bo = bullOff("sample-bulloff", kind === "official" || kind === "tie" ? "Official" : "Normal");
    Object.assign(bo.players[0], bullDart(kind === "official" ? 4.1 : 23.4, 215));
    bo.active = 1;
    if (kind === "decided") {
      Object.assign(bo.players[1], bullDart(11.8, 60));
      bo.decided = true;
      bo.winner = 1;
      bo.active = null;
    }
    if (kind === "tie") {
      bo.round = 2;
      bo.history = [{ round: 1, darts: [bullDart(84.2, 300), bullDart(61.5, 120)].map((d, i) => __spreadProps(__spreadValues({}, d), { label: i ? "S6" : "S12" })) }];
    }
    bo.leader = bo.decided ? bo.winner : kind === "tie" ? null : leaderOf(bo);
    return bo;
  }

  // js/bulloff.js
  var $3 = (id) => document.getElementById(id);
  var COLORS = ["var(--accent)", "#f5b301", "#22c55e", "#ef4444", "#a855f7", "#06b6d4"];
  var BOARD_MM = 170;
  var MIN_VIEW_MM = 40;
  var official = (bo) => String(bo.mode || "").toLowerCase() === "official";
  var fmtMm = (d) => `${d.toFixed(1)} mm`;
  var target = null;
  var seenDarts = /* @__PURE__ */ new Set();
  var key = "";
  function ensureTarget() {
    if (target) return target;
    const { root, heat, darts } = buildBoard();
    root.classList.add("bo-svg");
    heat.remove();
    darts.remove();
    const zoom = svg("g", { class: "bo-zoom" });
    while (root.firstChild) zoom.append(root.firstChild);
    const rings = svg("g", { class: "bo-rings" });
    const marks = svg("g", { class: "bo-marks" });
    zoom.append(rings, marks);
    root.append(zoom);
    target = { root, zoom, rings, marks };
    return target;
  }
  function dartResult(bo, p) {
    if (!p.thrown) return { big: "\u2013", small: "" };
    const label = p.label ? String(p.label).toUpperCase() : "";
    if (official(bo)) return { big: label || fmtMm(p.distance), small: label ? fmtMm(p.distance) : "" };
    return { big: fmtMm(p.distance), small: label };
  }
  function playerRow(bo, p, i, fresh) {
    const row = el("div", "bo-row");
    row.style.setProperty("--pc", COLORS[i % COLORS.length]);
    const decided = bo.decided && bo.winner !== null;
    row.classList.toggle("active", bo.active === i && !p.thrown);
    row.classList.toggle("leader", !decided && bo.leader === i);
    row.classList.toggle("winner", decided && bo.winner === i);
    row.classList.toggle("loser", decided && bo.winner !== i);
    const pic = el("div", "bo-pic");
    pic.append(avatar(p, "bo-img"));
    const who = el("div", "bo-who");
    who.append(el("div", "bo-name", displayName(p)));
    const badge = decided && bo.winner === i ? t("bulloff_first") : !decided && bo.leader === i ? t("bulloff_leader") : bo.active === i && !p.thrown ? t("bulloff_turn") : "";
    if (badge) who.append(el("div", "bo-badge", badge));
    const res = dartResult(bo, p);
    const result = el("div", "bo-result");
    result.append(el("strong", fresh.has(i) ? "fresh" : null, res.big));
    if (res.small) result.append(el("span", null, res.small));
    row.append(el("i", "bo-dot"), pic, who, result);
    return row;
  }
  function historyLine(bo) {
    var _a;
    if (!((_a = bo.history) == null ? void 0 : _a.length)) return null;
    const box = el("div", "bo-history");
    for (const h of bo.history) {
      const darts = h.darts.map((d) => d.thrown ? official(bo) ? d.label || fmtMm(d.distance) : fmtMm(d.distance) : "\u2013").join("  \xB7  ");
      const line = el("div", null);
      line.append(el("span", null, tn("bulloff_round", h.round) || `#${h.round}`), el("strong", null, darts));
      if (t("bulloff_tie")) line.append(el("em", null, t("bulloff_tie")));
      box.append(line);
    }
    return box;
  }
  function zoomFor(bo) {
    const far = Math.max(MIN_VIEW_MM, ...bo.players.filter((p) => p.thrown).map((p) => p.distance * 1.3));
    return Math.max(1, Math.min(9, 1.25 * BOARD_MM / far));
  }
  function drawTarget(bo, freshSet) {
    const { zoom, rings, marks } = ensureTarget();
    const k = zoomFor(bo);
    zoom.style.transform = `scale(${k.toFixed(3)})`;
    const ringEls = [];
    const markEls = [];
    bo.players.forEach((p, i) => {
      if (!p.thrown) return;
      const fresh = freshSet.has(i);
      const color = COLORS[i % COLORS.length];
      const winner = bo.decided && bo.winner === i;
      const ring = svg("circle", { r: (p.distance / BOARD_MM).toFixed(5), class: `bo-ring${fresh ? " grow" : ""}${winner ? " win" : ""}` });
      ring.style.stroke = color;
      ringEls.push(ring);
      const g = svg("g", { transform: `translate(${(p.x || 0).toFixed(5)} ${(-(p.y || 0)).toFixed(5)})` });
      const pop = svg("g", { class: `bo-mark${fresh ? " pop" : ""}` });
      pop.style.transform = `scale(${(1 / k).toFixed(4)})`;
      const dot = svg("circle", { r: 0.075, class: "bo-mark-dot" });
      dot.style.fill = color;
      const num = svg("text", { y: 0.034, class: "bo-mark-num" });
      num.textContent = i + 1;
      pop.append(dot, num);
      g.append(pop);
      markEls.push(g);
    });
    rings.replaceChildren(...ringEls);
    marks.replaceChildren(...markEls);
  }
  function renderBullOff(bo) {
    var _a;
    const box = $3("bullOff");
    if (!box || !bo) return;
    const next = JSON.stringify([
      bo.match_id,
      bo.mode,
      bo.round,
      bo.active,
      bo.decided,
      bo.winner,
      bo.leader,
      (_a = bo.history) == null ? void 0 : _a.length,
      bo.players.map((p) => [displayName(p), p.thrown, p.distance, p.label, p.avatar_url, p.studio_id])
    ]);
    if (next === key) return;
    key = next;
    const fresh = /* @__PURE__ */ new Set();
    bo.players.forEach((p, i) => {
      const id = `${bo.match_id}:${bo.round}:${i}:${p.distance}`;
      if (p.thrown && !seenDarts.has(id)) fresh.add(i);
      if (p.thrown) seenDarts.add(id);
    });
    const enter = !box.firstChild || box.dataset.match !== String(bo.match_id);
    box.dataset.match = String(bo.match_id);
    const head = el("div", "bo-head");
    head.append(el("div", "bo-kicker", t("bulloff_title")));
    const rule = official(bo) ? t("bulloff_rule_official") : t("bulloff_rule_normal");
    if (rule) head.append(el("div", "bo-rule", rule));
    if (bo.round > 1 && t("bulloff_round")) head.append(el("div", "bo-round", tn("bulloff_round", bo.round)));
    const panel = el("div", `bo-panel${enter ? " enter" : ""}`);
    if (enter) head.classList.add("enter");
    panel.append(...bo.players.map((p, i) => playerRow(bo, p, i, fresh)));
    const hist = historyLine(bo);
    if (hist) panel.append(hist);
    const tgt = el("div", `bo-target${enter ? " enter" : ""}`);
    drawTarget(bo, fresh);
    tgt.append(target.root);
    box.replaceChildren(head, panel, tgt);
  }
  function tieView(bo) {
    var _a;
    const last = (_a = bo.history) == null ? void 0 : _a[bo.history.length - 1];
    if (!last) return bo;
    return __spreadProps(__spreadValues({}, bo), {
      round: last.round,
      active: null,
      leader: null,
      history: bo.history.slice(0, -1),
      players: bo.players.map((p, i) => __spreadValues(__spreadValues({}, p), last.darts[i]))
    });
  }
  function resetBullOff() {
    seenDarts = /* @__PURE__ */ new Set();
    key = "";
    const box = $3("bullOff");
    if (box) box.replaceChildren();
  }

  // js/main.js
  var params = new URLSearchParams(location.search);
  ctx.demo = params.get("demo") === "1";
  var CHROMA = params.get("chroma") === "green";
  var EDIT = ctx.demo ? params.get("edit") || "" : "";
  var POLL_MS = 400;
  var SETTINGS_MS = 5e3;
  var IDLE_AFTER_MS = 4e3;
  var MATCH_CARD_MS = 2e4;
  var LAYOUT_DWELL_MS = 1500;
  var CUE_HOLD_MS = 15e3;
  var TIE_SHOW_MS = 3500;
  var $4 = (id) => document.getElementById(id);
  var stage = $4("stage");
  function fit() {
    const scale = Math.min(innerWidth / 1920, innerHeight / 1080);
    stage.style.transform = `translate(${(innerWidth - 1920 * scale) / 2}px, ${(innerHeight - 1080 * scale) / 2}px) scale(${scale})`;
  }
  addEventListener("resize", fit);
  fit();
  document.addEventListener("dblclick", () => {
    if (EDIT) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {
    });
  });
  if (window.self !== window.top) $4("hint").hidden = true;
  setTimeout(() => $4("hint").classList.add("gone"), 4e3);
  if (CHROMA) document.body.dataset.chroma = "green";
  initCameras($4("cams"), $4("blur"));
  var miniBoard = new MiniBoard($4("miniBoard"));
  var demoFeed = ctx.demo ? new DemoFeed() : null;
  var scene = null;
  var busy = false;
  var holdUntil = 0;
  var prev = null;
  var lastState = null;
  var seenMatch = null;
  var emptySince = 0;
  var matchCardTimer = null;
  var lastCueId = null;
  var layoutOverride = null;
  var currentLayout = "";
  var layoutSince = 0;
  var prevBullOff = null;
  var lastBullOff = null;
  var tieUntil = 0;
  var session = { matchId: null, throws: /* @__PURE__ */ new Map(), throwIds: /* @__PURE__ */ new Set(), legStartDarts: [], visitStart: [], bestCheckout: [] };
  function setScene(name) {
    var _a;
    scene = name;
    stage.dataset.scene = name;
    if (name === "idle") {
      startIdle();
      setBlur(((_a = ctx.settings) == null ? void 0 : _a.idle_blur) !== false);
    } else {
      stopIdle();
      setBlur(false);
    }
    if (name !== "match") {
      hideMatchCard();
      clearTimeout(matchCardTimer);
    }
    if (name !== "intro") hideIntro();
    if (name !== "bulloff") resetBullOff();
    else if (lastBullOff && Date.now() >= holdUntil) renderBullOff(lastBullOff);
  }
  var queue = Promise.resolve();
  var queued = 0;
  var epoch = 0;
  var stale = (mine) => mine !== epoch;
  function run(sequence) {
    const mine = epoch;
    queued++;
    busy = true;
    queue = queue.then(() => stale(mine) ? null : sequence()).catch((err) => console.error("[Studio]", err)).finally(() => {
      if (stale(mine)) return;
      queued--;
      busy = queued > 0;
    });
    return queue;
  }
  function interrupt() {
    epoch++;
    queue = Promise.resolve();
    queued = 0;
    busy = false;
    stopStinger();
    hideMoment();
    hideLegCard();
    clearTimeout(matchCardTimer);
  }
  var transitionTo = (name) => stinger(() => setScene(name));
  async function introSequence(state, next = "live") {
    const mine = epoch;
    let intro = Promise.resolve();
    await stinger(() => {
      setScene("intro");
      intro = playIntro(state);
    });
    await intro;
    if (!stale(mine)) await transitionTo(next);
  }
  var bullOffIntro = (bo) => ({ players: bo.players, variant: bo.variant, base_score: bo.base_score, target: bo.target });
  function showBullOff(bo) {
    lastBullOff = bo;
    if (scene !== "bulloff" || Date.now() < tieUntil) return;
    renderBullOff(bo);
  }
  function detectBullOff(bo) {
    const old = prevBullOff;
    prevBullOff = bo;
    if (!old || old.match_id !== bo.match_id || scene !== "bulloff") return;
    if (bo.round > old.round) {
      renderBullOff(tieView(bo));
      tieUntil = Date.now() + TIE_SHOW_MS;
      showMoment("tie", t("bulloff_tie"), t("bulloff_again"));
      setTimeout(() => {
        if (scene === "bulloff" && prevBullOff) renderBullOff(prevBullOff);
      }, TIE_SHOW_MS + 50);
      return;
    }
    if (bo.decided && !old.decided && bo.winner !== null) {
      const w = bo.players[bo.winner];
      if (w) showMoment("bulloff", displayName(w), t("bulloff_first"), w);
    }
  }
  function directBullOff(bo) {
    var _a;
    if (!bo) return false;
    if (bo.match_id !== seenMatch) {
      seenMatch = bo.match_id;
      prevBullOff = bo;
      const fresh = bo.round === 1 && !bo.players.some((p) => p.thrown);
      if (((_a = ctx.settings) == null ? void 0 : _a.show_intro) !== false && fresh && bo.players.length) run(() => introSequence(bullOffIntro(bo), "bulloff"));
      else if (scene === null) setScene("bulloff");
      else run(() => transitionTo("bulloff"));
      return true;
    }
    if (scene !== "bulloff") run(() => transitionTo("bulloff"));
    return true;
  }
  async function matchSequence(state, winner) {
    const mine = epoch;
    await showMoment("match", t("moment_match"), winner ? displayName(winner) : "", winner);
    if (stale(mine)) return;
    await stinger(() => {
      setScene("match");
      showMatchCard(state, { bestCheckout: session.bestCheckout });
    });
    if (stale(mine) || EDIT) return;
    matchCardTimer = setTimeout(() => {
      if (scene === "match") run(() => transitionTo("idle"));
    }, MATCH_CARD_MS);
  }
  var totalDarts = (state) => state.players.reduce((sum, p) => {
    var _a;
    return sum + (((_a = p.match_stats) == null ? void 0 : _a.dartsThrown) || 0);
  }, 0);
  function resetSession(state) {
    session.matchId = state.match_id;
    session.throws = /* @__PURE__ */ new Map();
    session.throwIds = /* @__PURE__ */ new Set();
    session.legStartDarts = state.players.map((p) => {
      var _a;
      return ((_a = p.match_stats) == null ? void 0 : _a.dartsThrown) || 0;
    });
    session.visitStart = state.players.map((p) => p.remaining);
    session.bestCheckout = state.players.map(() => null);
  }
  function trackSession(state) {
    if (session.matchId !== state.match_id) resetSession(state);
    const turn = state.turn || {};
    const owner = state.players[turn.player];
    if (owner) {
      const list = session.throws.get(owner.name) || [];
      for (const t2 of turn.throws || []) {
        if (t2.id && !session.throwIds.has(t2.id)) {
          session.throwIds.add(t2.id);
          list.push(t2);
        }
      }
      session.throws.set(owner.name, list);
      session.visitStart[turn.player] = owner.remaining + (turn.busted ? 0 : turn.points || 0);
    }
    if (prev && (prev.leg !== state.leg || prev.set !== state.set)) {
      session.legStartDarts = state.players.map((p) => {
        var _a;
        return ((_a = p.match_stats) == null ? void 0 : _a.dartsThrown) || 0;
      });
    }
  }
  function legInfo(state, winner) {
    var _a, _b, _c, _d, _e;
    const old = prev.players[winner.index];
    const darts = (((_a = winner.match_stats) == null ? void 0 : _a.dartsThrown) || 0) - (session.legStartDarts[winner.index] || 0);
    const checkout = (_b = session.visitStart[winner.index]) != null ? _b : old.remaining;
    if (checkout && checkout > (session.bestCheckout[winner.index] || 0)) session.bestCheckout[winner.index] = checkout;
    return {
      label: state.uses_sets && winner.sets > old.sets ? tn("board_set", prev.set) : tn("board_leg", (_c = prev.leg) != null ? _c : ""),
      title: winner.sets > old.sets ? t("set_title") : t("leg_title"),
      setWon: winner.sets > old.sets,
      player: winner,
      darts: darts > 0 ? darts : null,
      average: darts > 0 && state.base_score ? (state.base_score / darts * 3).toFixed(2) : null,
      checkout: checkout || null,
      oneEighties: (_e = (_d = old.leg_stats) == null ? void 0 : _d.total180) != null ? _e : null,
      nine: darts === 9 && state.base_score === 501
    };
  }
  function detectEvents(state) {
    if (EDIT || !prev || prev.match_id !== state.match_id || scene !== "live") return;
    const turn = state.turn || {};
    const oldTurn = prev.turn || {};
    const turnChanged = turn.id !== oldTurn.id || (turn.darts || []).length !== (oldTurn.darts || []).length;
    const legWinner = state.players.find((p, i) => prev.players[i] && (p.legs > prev.players[i].legs || p.sets > prev.players[i].sets));
    const info = legWinner ? legInfo(state, legWinner) : null;
    if (state.finished && !prev.finished && state.winner !== null) {
      run(() => matchSequence(state, state.players[state.winner]));
      return;
    }
    if (info) {
      run(async () => {
        const mine = epoch;
        if (info.nine) await showMoment("nine", t("moment_nine"), displayName(info.player), info.player);
        else await showMoment("leg", info.setWon ? t("moment_set") : t("moment_game_shot"), displayName(info.player));
        if (!stale(mine)) await showLegCard(info);
      });
      return;
    }
    if (turnChanged && turn.busted && !oldTurn.busted) {
      const p = state.players[turn.player];
      showMoment("bust", t("moment_bust"), p ? displayName(p) : "");
      return;
    }
    if (turnChanged && turn.points === 180 && (turn.darts || []).length === 3) {
      const p = state.players[turn.player];
      showMoment("max", t("moment_180"), p ? displayName(p) : "");
    }
  }
  function directLayout(state) {
    var _a, _b, _c;
    let want = ((_a = ctx.settings) == null ? void 0 : _a.layout) || "split";
    if (layoutOverride) {
      want = layoutOverride;
    } else if (((_b = ctx.settings) == null ? void 0 : _b.auto_direct) !== false && scene === "bulloff") {
      want = "board";
    } else if (((_c = ctx.settings) == null ? void 0 : _c.auto_direct) !== false && scene === "live") {
      const phase = (state == null ? void 0 : state.phase) || "";
      if (phase === "throw") want = "board";
      else if (phase.startsWith("takeout")) want = "split";
    }
    want = fitLayout(want);
    if (want === currentLayout || Date.now() - layoutSince < LAYOUT_DWELL_MS) return;
    layoutSince = Date.now();
    showLayout(want);
  }
  function showLayout(want) {
    currentLayout = setLayout(want);
    stage.dataset.layout = currentLayout;
    stage.dataset.cams = camerasInUse();
  }
  function renderLive(state) {
    var _a;
    renderBoard(state, prev);
    renderPlayerCard(state);
    renderVisit(state);
    const turn = state.turn || {};
    const owner = state.players[turn.player] || state.players[state.active];
    const show = (((_a = ctx.settings) == null ? void 0 : _a.show_dartboard) !== false || stage.dataset.cams === "none") && owner;
    $4("miniBoard").hidden = !show;
    if (show) {
      const current = new Set((turn.throws || []).map((t2) => t2.id));
      const history = (session.throws.get(owner.name) || []).filter((t2) => !current.has(t2.id));
      miniBoard.update(displayName(owner), turn.throws || [], history);
    }
  }
  function direct(state) {
    var _a, _b;
    const hasMatch = ((_a = state.players) == null ? void 0 : _a.length) > 0;
    if (Date.now() < holdUntil) return;
    if (directBullOff(state.bull_off)) return;
    if (lobbyReady() && (scene === "match" || scene === "live" && (!hasMatch || state.finished))) {
      run(() => transitionTo("idle"));
      return;
    }
    if (!hasMatch) {
      if (scene === null) setScene("idle");
      else if (scene !== "idle" && scene !== "match" && Date.now() - emptySince > IDLE_AFTER_MS) run(() => transitionTo("idle"));
      return;
    }
    if (state.match_id !== seenMatch) {
      seenMatch = state.match_id;
      if (state.finished) {
        if (scene === null) setScene("idle");
        return;
      }
      const fresh = totalDarts(state) <= 3;
      if (((_b = ctx.settings) == null ? void 0 : _b.show_intro) !== false && fresh) run(() => introSequence(state));
      else if (scene === null) setScene("live");
      else run(() => transitionTo("live"));
      return;
    }
    if (!state.finished && (scene === "idle" || scene === null || scene === "bulloff")) run(() => transitionTo("live"));
  }
  function cueState() {
    var _a;
    return ((_a = lastState == null ? void 0 : lastState.players) == null ? void 0 : _a.length) ? lastState : sampleState();
  }
  function playCue(name) {
    if (name.startsWith("overlay:")) {
      if (ctx.settings) ctx.settings.show_overlay = name === "overlay:show";
      stage.classList.toggle("no-overlay", name === "overlay:hide");
      return;
    }
    if (name.startsWith("layout:")) {
      const layout = name.slice(7);
      layoutOverride = layout === "auto" ? null : layout;
      layoutSince = 0;
      return;
    }
    holdUntil = EDIT ? Infinity : Date.now() + CUE_HOLD_MS;
    const state = cueState();
    const first = state.players[0];
    switch (name) {
      case "idle":
        run(() => transitionTo("idle"));
        break;
      case "live":
        run(() => transitionTo("live"));
        break;
      case "intro":
        run(() => introSequence(state));
        break;
      case "stinger":
        run(() => stinger());
        break;
      case "leg":
        run(() => showLegCard(sampleLeg(state)));
        break;
      case "match":
        run(() => {
          var _a, _b;
          return matchSequence(__spreadProps(__spreadValues({}, state), { finished: true, winner: (_a = state.winner) != null ? _a : 0 }), state.players[(_b = state.winner) != null ? _b : 0]);
        });
        break;
      case "180":
        showMoment("max", t("moment_180"), first ? displayName(first) : "");
        break;
      case "bust":
        showMoment("bust", t("moment_bust"), first ? displayName(first) : "");
        break;
      case "bulloff":
        run(() => bullOffCue());
        break;
    }
  }
  var sampleLeg = (state) => ({
    label: tn("board_leg", state.leg || 1),
    title: t("leg_title"),
    player: state.players[0],
    darts: 15,
    average: "100.20",
    checkout: 121,
    oneEighties: 1
  });
  async function stepScene(name, quiet) {
    const state = cueState();
    const cut = (show) => quiet ? show() : stinger(show);
    switch (name) {
      case "idle":
        return cut(() => setScene("idle"));
      case "live":
        return cut(() => {
          setScene("live");
          renderLive(state);
        });
      case "intro":
        if (quiet && scene === "intro") return;
        return cut(() => {
          setScene("intro");
          playIntro(state);
        });
      case "bulloff":
        if (!quiet) return bullOffCue();
        setScene("bulloff");
        renderBullOff(sampleBullOff("decided"));
        return;
      case "leg":
        return cut(() => {
          setScene("live");
          renderLive(state);
          showLegCard(sampleLeg(state), { hold: true });
        });
      case "match":
        return cut(() => {
          var _a;
          setScene("match");
          showMatchCard(__spreadProps(__spreadValues({}, state), { finished: true, winner: (_a = state.winner) != null ? _a : 0 }), { bestCheckout: session.bestCheckout });
        });
      default:
        playCue(name);
    }
  }
  async function bullOffCue() {
    const mine = epoch;
    await stinger(() => {
      setScene("bulloff");
      renderBullOff(sampleBullOff("running"));
    });
    await sleep(2500);
    if (scene !== "bulloff" || stale(mine)) return;
    const bo = sampleBullOff("decided");
    renderBullOff(bo);
    await showMoment("bulloff", displayName(bo.players[bo.winner]), t("bulloff_first"), bo.players[bo.winner]);
  }
  function handleCue(cue) {
    var _a;
    if (lastCueId === null) {
      lastCueId = (_a = cue == null ? void 0 : cue.id) != null ? _a : 0;
      return;
    }
    if (cue && cue.id !== lastCueId) {
      lastCueId = cue.id;
      if (EDIT && !/^(overlay|layout):/.test(cue.scene)) return;
      playCue(cue.scene);
    }
  }
  function renderIdleStatus(state) {
    const src = state.source || {};
    $4("idleStatus").textContent = !src.connected ? "Waiting for the AutoGlow Bridge extension in Chrome" : src.tab_attached === false ? "Open play.autodarts.com in Chrome to start" : lobbyReady() ? t("lobby_status") : t("idle_ready");
  }
  function onState(state) {
    var _a;
    if (showcaseKey) return;
    handleCue(state.cue);
    const hasMatch = ((_a = state.players) == null ? void 0 : _a.length) > 0;
    setLobby(hasMatch && !state.finished ? null : state.lobby || null);
    const bo = state.bull_off || null;
    if (bo && !EDIT && Date.now() >= holdUntil) {
      detectBullOff(bo);
      showBullOff(bo);
    } else if (!bo) {
      prevBullOff = null;
      lastBullOff = null;
    }
    if (hasMatch) {
      emptySince = 0;
      if (session.matchId === state.match_id) detectEvents(state);
      trackSession(state);
      renderLive(state);
      lastState = state;
    } else {
      if (!emptySince) emptySince = Date.now();
    }
    renderIdleStatus(state);
    if (EDIT) {
      if (scene === null) setScene("idle");
    } else if (!busy) direct(state);
    directLayout(hasMatch ? state : null);
    prev = hasMatch ? state : prev;
  }
  var delayed = [];
  function flushDelayed() {
    const now = Date.now();
    while (delayed.length && (delayed[0].at <= now || !outputDelay())) onState(delayed.shift().state);
  }
  setInterval(flushDelayed, 50);
  async function poll() {
    var _a;
    let state = null;
    try {
      const res = await fetch(`/api/studio/state${ctx.demo ? "?demo=1" : ""}`, { cache: "no-store" });
      if (res.ok) state = await res.json();
    } catch (e) {
    }
    if (demoFeed) state = __spreadProps(__spreadValues({}, demoFeed.current()), { cue: (_a = state == null ? void 0 : state.cue) != null ? _a : null });
    if (state) {
      if (!demoFeed) onDarts(state.darts, state.server_time);
      const delay = outputDelay();
      if (delay > 0) {
        if (!showcaseKey) handleCue(state.cue);
        delayed.push({ at: Date.now() + delay * 1e3, state });
      } else {
        flushDelayed();
        onState(state);
      }
    }
    setTimeout(poll, POLL_MS);
  }
  function shade(hex, amount) {
    const n2 = parseInt(hex.slice(1), 16);
    const ch = (s) => Math.max(0, Math.min(255, Math.round((n2 >> s & 255) * (1 + amount))));
    return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, "0")).join("")}`;
  }
  function applySettings(settings) {
    ctx.settings = settings;
    const accent = settings.accent || "#3b82f6";
    const root = document.documentElement;
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-dark", shade(accent, -0.25));
    const hex = /^#?([0-9a-f]{6})$/i.exec(accent);
    if (hex) root.style.setProperty("--accent-rgb", [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).join(", "));
    root.dataset.theme = settings.theme || "autodarts";
    document.querySelectorAll(".brand").forEach((brand) => {
      brand.querySelector("b").textContent = t("brand_main");
      brand.querySelector("span").textContent = t("brand_accent");
    });
    document.title = `${t("brand_main")} ${t("brand_accent")}`.trim();
    stage.classList.toggle("no-overlay", settings.show_overlay === false);
    applyCameras(CHROMA);
    if (currentLayout && (fitLayout(currentLayout) !== currentLayout || stage.dataset.cams !== camerasInUse())) showLayout(currentLayout);
  }
  var SHOWCASE = {
    event_title: { view: "idle-brand", sel: ".sb-title" },
    event_subtitle: { view: "idle-brand", sel: ".sb-sub" },
    brand_main: { view: "idle-brand", sel: ".idle-top .logo b" },
    brand_accent: { view: "idle-brand", sel: ".idle-top .logo span" },
    idle_kicker: { view: "idle-brand", sel: ".sb-kicker" },
    idle_tagline: { view: "idle-brand", sel: ".sb-sub" },
    idle_ready: { view: "idle-brand", sel: "#idleStatus" },
    idle_player_kicker: { view: "idle-player", sel: ".sp-kicker" },
    idle_board_kicker: { view: "idle-board", sel: ".slide-board .sb-kicker" },
    lobby_kicker: { view: "idle-versus", sel: ".slide-versus .sb-kicker" },
    lobby_status: { view: "idle-versus", sel: "#idleStatus" },
    fact_from: { view: "idle-player", sel: ".fact", text: true },
    fact_throws: { view: "idle-player", sel: ".fact", text: true },
    fact_darts: { view: "idle-player", sel: ".fact", text: true },
    fact_since: { view: "idle-player", sel: ".fact", text: true },
    board_sets: { view: "live", sel: "#boardSetsLabel" },
    board_legs: { view: "live", sel: "#boardLegsLabel" },
    board_set: { view: "live", sel: "#boardTitle" },
    board_leg: { view: "live", sel: "#boardTitle" },
    card_avg: { view: "live", sel: ".pc-values small" },
    card_round: { view: "live", sel: ".pc-foot" },
    visit_checkout: { view: "live", sel: ".visit .checkout" },
    visit_bust: { view: "live", sel: ".visit .total" },
    visit_nine: { view: "live", sel: ".visit .nine" },
    moment_180: { view: "moment", kind: "max", sel: ".moment .m-big" },
    moment_game_shot: { view: "moment", kind: "leg", sel: ".moment .m-big" },
    moment_set: { view: "moment", kind: "leg", sel: ".moment .m-big" },
    moment_bust: { view: "moment", kind: "bust", sel: ".moment .m-big" },
    moment_nine: { view: "moment", kind: "nine", sel: ".moment .m-big" },
    moment_match: { view: "moment", kind: "match", sel: ".moment .m-big" },
    intro_vs: { view: "intro", sel: ".intro-vs" },
    bulloff_title: { view: "bulloff", sample: "running", sel: ".bo-kicker" },
    bulloff_rule_normal: { view: "bulloff", sample: "running", sel: ".bo-rule" },
    bulloff_rule_official: { view: "bulloff", sample: "official", sel: ".bo-rule" },
    bulloff_round: { view: "bulloff", sample: "tie", sel: ".bo-round" },
    bulloff_turn: { view: "bulloff", sample: "running", sel: ".bo-row.active .bo-badge" },
    bulloff_leader: { view: "bulloff", sample: "running", sel: ".bo-row.leader .bo-badge" },
    bulloff_first: { view: "bulloff", sample: "decided", sel: ".bo-row.winner .bo-badge" },
    bulloff_tie: { view: "bulloff", sample: "tie", kind: "tie", sel: ".moment .m-big" },
    bulloff_again: { view: "bulloff", sample: "tie", kind: "tie", sel: ".moment .m-sub" },
    stat_fav_double: { view: "intro", sel: ".is-label", text: true },
    leg_title: { view: "leg", sel: ".lc-head strong" },
    set_title: { view: "leg", set: true, sel: ".lc-head strong" },
    stat_darts: { view: "leg", sel: ".lc-cell", text: true },
    stat_leg_average: { view: "leg", sel: ".lc-cell", text: true },
    stat_checkout: { view: "leg", sel: ".lc-cell", text: true },
    match_winner: { view: "match", sel: ".mc-kicker" },
    stat_average: { view: "match", sel: ".mc-row span", text: true },
    stat_first9: { view: "match", sel: ".mc-row span", text: true },
    stat_180s: { view: "match", sel: ".mc-row span", text: true },
    stat_140: { view: "match", sel: ".mc-row span", text: true },
    stat_100: { view: "match", sel: ".mc-row span", text: true },
    stat_checkout_pct: { view: "match", sel: ".mc-row span", text: true },
    stat_best_checkout: { view: "match", sel: ".mc-row span", text: true }
  };
  var showcaseKey = null;
  var showcaseLabel = "";
  var highlightTimer = null;
  function liveSample(key2) {
    const s = sampleState();
    s.finished = false;
    s.winner = null;
    s.uses_sets = true;
    s.set = 2;
    s.leg = 3;
    s.round = 4;
    s.active = 0;
    s.players[0].remaining = 141;
    s.players[0].leg_stats = __spreadProps(__spreadValues({}, s.players[0].leg_stats), { dartsThrown: 6 });
    s.players[1].remaining = 220;
    s.turn = key2 === "visit_bust" ? { id: "preview", player: 0, darts: ["T20", "T20", "S20"], throws: [], points: 0, busted: true } : { id: "preview", player: 0, darts: [], throws: [], points: 0, busted: false };
    return s;
  }
  function clearHighlight() {
    clearTimeout(highlightTimer);
    document.querySelectorAll(".text-focus").forEach((e) => e.classList.remove("text-focus"));
    document.querySelectorAll(".text-focus-tag").forEach((e) => e.remove());
  }
  function highlight(key2) {
    clearHighlight();
    const spec = SHOWCASE[key2];
    let els = [...document.querySelectorAll(spec.sel)];
    if (spec.text) {
      const want = t(key2).toLowerCase();
      els = els.filter((e) => e.textContent.toLowerCase().includes(want));
    }
    els.forEach((e) => e.classList.add("text-focus"));
    if (!els.length) return;
    const stageRect = stage.getBoundingClientRect();
    const scale = stageRect.width / 1920;
    const r = els[0].getBoundingClientRect();
    const tag = el("div", "text-focus-tag", showcaseLabel || "This text");
    tag.style.left = `${Math.max(8, (r.left - stageRect.left) / scale)}px`;
    tag.style.top = `${Math.max(8, (r.top - stageRect.top) / scale - 52)}px`;
    stage.append(tag);
  }
  function showcase(key2, inPlace = false) {
    const spec = SHOWCASE[key2];
    if (!spec) return;
    showcaseKey = key2;
    stage.classList.toggle("no-anim", inPlace);
    hideMoment();
    if (spec.view !== "leg") hideLegCard();
    const sample = sampleState();
    const live = liveSample(key2);
    showLayout("split");
    if (spec.view.startsWith("idle-")) {
      setScene("idle");
      showIdleSlide(spec.view.slice(5), sample);
      $4("idleStatus").textContent = spec.view === "idle-versus" ? t("lobby_status") : t("idle_ready");
    } else if (spec.view === "intro") {
      setScene("intro");
      playIntro(sample);
    } else if (spec.view === "bulloff") {
      const bo = sampleBullOff(spec.sample);
      showLayout("board");
      setScene("bulloff");
      resetBullOff();
      renderBullOff(spec.kind === "tie" ? tieView(bo) : bo);
      if (spec.kind === "tie") showMoment("tie", t("bulloff_tie"), t("bulloff_again"), null, { hold: true });
    } else if (spec.view === "match") {
      setScene("match");
      showMatchCard(sample, { bestCheckout: [121, 96] });
    } else {
      setScene("live");
      renderLive(live);
      const first = live.players[0];
      if (spec.view === "leg") {
        showLegCard({
          label: tn("board_leg", 3),
          title: spec.set ? t("set_title") : t("leg_title"),
          player: first,
          darts: 15,
          average: "100.20",
          checkout: 121,
          oneEighties: 1
        }, { hold: true });
      } else if (spec.view === "moment") {
        showMoment(spec.kind, t(key2), displayName(first), first, { hold: true });
      }
    }
    clearHighlight();
    highlightTimer = setTimeout(() => highlight(key2), inPlace ? 30 : spec.view === "intro" ? 1700 : 950);
  }
  function endShowcase() {
    var _a, _b;
    if (!showcaseKey) return;
    showcaseKey = null;
    stage.classList.remove("no-anim");
    clearHighlight();
    hideMoment();
    hideLegCard();
    layoutSince = 0;
    if (EDIT) {
      if (scene === "live" && ((_a = lastState == null ? void 0 : lastState.players) == null ? void 0 : _a.length)) renderLive(lastState);
      return;
    }
    if ((_b = lastState == null ? void 0 : lastState.players) == null ? void 0 : _b.length) {
      setScene("live");
      renderLive(lastState);
    } else {
      setScene("idle");
    }
  }
  var draft = null;
  var idleRefresh = null;
  function showDraft(settings) {
    var _a, _b;
    applySettings(settings);
    if (showcaseKey) {
      showcase(showcaseKey, true);
      return;
    }
    if (((_a = lastState == null ? void 0 : lastState.players) == null ? void 0 : _a.length) || EDIT && scene === "live") renderLive(cueState());
    layoutSince = 0;
    directLayout(((_b = lastState == null ? void 0 : lastState.players) == null ? void 0 : _b.length) ? lastState : null);
    if (scene === "idle") {
      clearTimeout(idleRefresh);
      idleRefresh = setTimeout(() => {
        if (scene === "idle") setScene("idle");
      }, 400);
    }
  }
  if (ctx.demo && "BroadcastChannel" in window) {
    new BroadcastChannel("autoglow-studio-draft").onmessage = ({ data }) => {
      if ((data == null ? void 0 : data.type) === "draft" && data.settings) {
        draft = data.settings;
        showDraft(draft);
      } else if ((data == null ? void 0 : data.type) === "clear") {
        draft = null;
        endShowcase();
        loadSettings().then(() => showDraft(ctx.settings));
      } else if ((data == null ? void 0 : data.type) === "play" && data.scene) {
        interrupt();
        endShowcase();
        if (EDIT) run(() => stepScene(data.scene, data.quiet));
        else playCue(data.scene);
      } else if ((data == null ? void 0 : data.type) === "focus-text") {
        if (data.key) {
          if (data.key !== showcaseKey) interrupt();
          showcaseLabel = data.label || "";
          showcase(data.key, data.key === showcaseKey);
        } else {
          endShowcase();
        }
      }
    };
  }
  if (EDIT && "BroadcastChannel" in window) {
    const channel = new BroadcastChannel("autoglow-studio-draft");
    const SETTINGS_TEXTS = ["event_title", "event_subtitle"];
    const visible = (e) => {
      for (let n2 = e; n2 && n2 !== stage; n2 = n2.parentElement) {
        const cs = getComputedStyle(n2);
        if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.05) return false;
      }
      return true;
    };
    const textsAt = (x, y) => {
      const hits = [];
      for (const [key2, spec] of Object.entries(SHOWCASE)) {
        for (const e of stage.querySelectorAll(spec.sel)) {
          const r = e.getBoundingClientRect();
          if (!r.width || x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
          const wording = t(key2).toLowerCase();
          if (spec.text && (!wording || !e.textContent.toLowerCase().includes(wording))) continue;
          if (visible(e)) hits.push({ e, key: key2, area: r.width * r.height });
        }
      }
      if (!hits.length) return null;
      const best2 = hits.reduce((a, b) => b.area < a.area ? b : a).e;
      let keys = hits.filter((x2) => x2.e === best2).map((x2) => x2.key);
      if (keys.length > 1) {
        const text = best2.textContent.toLowerCase();
        const shown = keys.filter((k) => SETTINGS_TEXTS.includes(k) || t(k) && text.includes(t(k).toLowerCase()));
        if (shown.length) keys = shown;
      }
      return { el: best2, keys };
    };
    let hovered = null;
    let moveFrame = 0;
    const setHover = (el2) => {
      if (hovered === el2) return;
      hovered == null ? void 0 : hovered.classList.remove("text-hover");
      hovered = el2;
      hovered == null ? void 0 : hovered.classList.add("text-hover");
      document.body.classList.toggle("edit-hover", !!el2);
    };
    document.addEventListener("mousemove", (e) => {
      cancelAnimationFrame(moveFrame);
      moveFrame = requestAnimationFrame(() => {
        var _a;
        return setHover(((_a = textsAt(e.clientX, e.clientY)) == null ? void 0 : _a.el) || null);
      });
    });
    document.addEventListener("mouseleave", () => setHover(null));
    document.addEventListener("click", (e) => {
      const hit = textsAt(e.clientX, e.clientY);
      if (!hit) return;
      const r = hit.el.getBoundingClientRect();
      channel.postMessage({ type: "pick-text", edit: EDIT, keys: hit.keys, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } });
    });
  }
  async function loadSettings() {
    try {
      const res = await fetch("/api/studio", { cache: "no-store" });
      if (!res.ok) return;
      const saved = await res.json();
      if (!draft) applySettings(saved);
    } catch (e) {
    }
  }
  loadSettings().then(() => {
    var _a;
    showLayout(((_a = ctx.settings) == null ? void 0 : _a.layout) || "split");
    poll();
    setInterval(loadSettings, SETTINGS_MS);
  });
})();
