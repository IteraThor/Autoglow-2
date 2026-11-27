// AutoGlow Studio - the look of the automatic camera picture, drawn by WebGL (sharpwarp.js runs the passes).
// What a phone or TV does after the sensor; the reference, with the reasons, is Look in
// src/studio_autotune.rs, and these shaders must stay in step with Look::pixel and Look::tone_base:
//
// 1. Small copy: the picture's log brightness (after the white balance) averaged down to TONE_WIDTH px
//    wide, then blurred in two passes. It says how bright each part of the picture is around a pixel.
// 2. Look, per camera pixel: white balance in linear light, clipped spots kept white, local tone (dark
//    surroundings lifted, bright ones held back, sharp edges left alone), tone curve with a soft knee,
//    then colour in Oklab: vibrance, skin hues boosted less and drawn towards a natural skin hue.

export const TONE_WIDTH = 240;
const TONE_SIGMA = 6;
const TONE_RADIUS = 18;      // 3 sigma
// The small copy holds log2 brightness -16..0 as 0..1, so 8-bit render targets work too
const LOG_RANGE = 16;

const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

// Uniform values for a saved look (see clean_look in src/studio.rs for the ranges)
export function lookParams(look) {
  const w = Math.exp(0.06 * n(look.warmth, 0));
  const k = [n(look.r, 1) * w, n(look.g, 1), n(look.b, 1) / w];
  const l = 0.2126 * k[0] + 0.7152 * k[1] + 0.0722 * k[2] || 1;
  return {
    gain: k.map(v => v / l),
    black: n(look.black, 0),
    white: n(look.white, 1),
    contrast: n(look.contrast, 0),
    vibrance: n(look.vibrance, 0),
    shadows: n(look.shadows, 0),
    highlights: n(look.highlights, 0)
  };
}

const COMMON = `
const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);
vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
`;

// 1a. Average the log brightness of a block of camera px into one px of the small copy: 4 x 4 bilinear
// taps on the corners between px, each the mean of 2 x 2 px
export const FRAG_TONE_BASE = `
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

// 1b. Gaussian blur of the small copy, one direction per pass (edges repeat: clamp-to-edge)
export const FRAG_TONE_BLUR = `
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

// 2. The look for one camera px
export const FRAG_LOOK = `
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
