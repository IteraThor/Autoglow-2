//! Studio › automatic camera picture. The player stands where they throw and presses Start: AutoGlow
//! finds their face, then sets the USB camera's exposure, gain, white balance, contrast, colour and
//! sharpness from what the camera sends, and locks them (automatic exposure and white balance off), so
//! the picture does not pump or change colour while the player moves during a game.
//!
//! Each step sets a control, waits for the camera to show it, decodes a frame and measures it.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

const BRIGHTNESS: u32 = 0x0098_0900;
const CONTRAST: u32 = 0x0098_0901;
const SATURATION: u32 = 0x0098_0902;
const HUE: u32 = 0x0098_0903;
const AUTO_WB: u32 = 0x0098_090c;
const GAMMA: u32 = 0x0098_0910;
const AUTOGAIN: u32 = 0x0098_0912;
const GAIN: u32 = 0x0098_0913;
const POWER_LINE: u32 = 0x0098_0918;
const WB_TEMP: u32 = 0x0098_091a;
const SHARPNESS: u32 = 0x0098_091b;
pub const EXPOSURE_AUTO: u32 = 0x009a_0901;
const EXPOSURE: u32 = 0x009a_0902;
const EXPOSURE_PRIORITY: u32 = 0x009a_0903;
pub const EXPOSURE_MANUAL: i32 = 1;
pub const EXPOSURE_APERTURE_PRIORITY: i32 = 3;

/// Mean brightness (0-255) of the face, and of the middle of the picture when no face is found
/// (from a recorded session: the camera's own automatic gave a face of ~135, which looked a little dark)
const FACE_TARGET: f64 = 160.0;
const CENTRE_TARGET: f64 = 125.0;
const TOLERANCE: f64 = 6.0;
/// How long the camera's automatics need to find the light
pub const SETTLE_MS: u64 = 2000;

static FACE_MODEL: &[u8] = include_bytes!("../assets/seeta_fd_frontal_v1.0.bin");

// --- Pictures ------------------------------------------------------------------------------------

#[derive(Clone)]
pub struct Pic {
    pub w: usize,
    pub h: usize,
    rgb: Vec<u8>,
}

/// Region of the raw picture, in pixels [x0, x1) × [y0, y1)
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x0: usize,
    pub y0: usize,
    pub x1: usize,
    pub y1: usize,
}

pub fn decode(jpeg: &[u8]) -> Option<Pic> {
    let mut d = jpeg_decoder::Decoder::new(jpeg);
    let px = d.decode().ok()?;
    let info = d.info()?;
    let (w, h) = (info.width as usize, info.height as usize);
    let rgb = match info.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 => px,
        jpeg_decoder::PixelFormat::L8 => px.iter().flat_map(|&v| [v, v, v]).collect(),
        _ => return None,
    };
    (rgb.len() == w * h * 3).then_some(Pic { w, h, rgb })
}

impl Pic {
    fn px(&self, x: usize, y: usize) -> (f64, f64, f64) {
        let i = (y * self.w + x) * 3;
        (self.rgb[i] as f64, self.rgb[i + 1] as f64, self.rgb[i + 2] as f64)
    }

    pub fn whole(&self) -> Rect {
        Rect { x0: 0, y0: 0, x1: self.w, y1: self.h }
    }

    /// The middle half of the picture
    pub fn centre(&self) -> Rect {
        Rect { x0: self.w / 4, y0: self.h / 4, x1: self.w * 3 / 4, y1: self.h * 3 / 4 }
    }

    /// The pixels of a region, about 20 000 of them at most
    fn sample(&self, r: Rect) -> impl Iterator<Item = (f64, f64, f64)> + '_ {
        let n = ((r.x1 - r.x0) * (r.y1 - r.y0)).max(1);
        let step = ((n as f64 / 20000.0).sqrt().floor() as usize).max(1);
        (r.y0..r.y1).step_by(step).flat_map(move |y| (r.x0..r.x1).step_by(step).map(move |x| self.px(x, y)))
    }

    pub fn stats(&self, r: Rect) -> Stats {
        let (mut sum, mut clipped, mut n) = (0.0f64, 0.0f64, 0.0f64);
        for (r_, g, b) in self.sample(r) {
            let y = luma(r_, g, b);
            sum += y;
            if y >= 249.5 {
                clipped += 1.0;
            }
            n += 1.0;
        }
        let n = n.max(1.0);
        Stats { mean: sum / n, clipped: clipped / n }
    }

    /// Colour cast of what is probably grey in the picture: (ln red/green, ln blue/green), (0, 0) when
    /// neutral. A grey-world estimate in which colourful, very dark and blown-out pixels count little.
    pub fn cast(&self) -> (f64, f64) {
        self.cast_without(None)
    }

    /// Mean linear R, G, B of the picture outside a region (the person), clipped and very dark px left out
    pub fn room_linear(&self, out: Option<Rect>) -> [f64; 3] {
        let n = self.w * self.h;
        let step = ((n as f64 / 20000.0).sqrt().floor() as usize).max(1);
        let inside = |x: usize, y: usize| out.map_or(false, |r| x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1);
        let collect = |skip: bool| {
            let (mut s, mut k) = ([0.0f64; 3], 0usize);
            for y in (0..self.h).step_by(step) {
                for x in (0..self.w).step_by(step) {
                    let p = self.px(x, y);
                    if !(skip && inside(x, y)) && (25.0..240.0).contains(&luma(p.0, p.1, p.2)) {
                        s[0] += srgb_to_linear(p.0 / 255.0);
                        s[1] += srgb_to_linear(p.1 / 255.0);
                        s[2] += srgb_to_linear(p.2 / 255.0);
                        k += 1;
                    }
                }
            }
            (s, k)
        };
        let (mut s, mut k) = collect(true);
        // Too little left around the person: the whole picture
        if out.is_some() && k < n / step / step / 5 {
            (s, k) = collect(false);
        }
        let k = k.max(1) as f64;
        s.map(|v| v / k)
    }

    /// The colour cast of the picture outside a region (the person: clothes and skin are no grey)
    pub fn cast_without(&self, out: Option<Rect>) -> (f64, f64) {
        let n = self.w * self.h;
        let step = ((n as f64 / 20000.0).sqrt().floor() as usize).max(1);
        let inside = |x: usize, y: usize| out.map_or(false, |r| x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1);
        let mut all: Vec<(f64, f64, f64)> = Vec::new();
        for y in (0..self.h).step_by(step) {
            for x in (0..self.w).step_by(step) {
                let p = self.px(x, y);
                if !inside(x, y) && (25.0..240.0).contains(&luma(p.0, p.1, p.2)) {
                    all.push(p);
                }
            }
        }
        // Too little left around the person: the whole picture
        if out.is_some() && all.len() < n / step / step / 5 {
            return self.cast_without(None);
        }
        // Two rounds: the first balance decides which pixels look grey
        let (mut kr, mut kb) = (1.0, 1.0);
        for _ in 0..2 {
            let (mut sr, mut sg, mut sb) = (1e-6, 1e-6, 1e-6);
            for &(r, g, b) in &all {
                let (r2, b2) = (r * kr, b * kb);
                let mx = r2.max(g).max(b2);
                let chroma = (mx - r2.min(g).min(b2)) / mx.max(1.0);
                let w = 1.0 / (1.0 + (chroma / 0.12).powi(2));
                sr += r * w;
                sg += g * w;
                sb += b * w;
            }
            kr = sg / sr;
            kb = sg / sb;
        }
        (-kr.ln(), -kb.ln())
    }

    /// How far from neutral grey the picture is (outside the person)
    pub fn tint(&self, person: Option<Rect>) -> f64 {
        let (r, b) = self.cast_without(person);
        r.hypot(b)
    }

    /// The picture in grey, turned clockwise by quarter turns (what the screens show after "Turn 90°")
    fn grey_turned(&self, quarter_turns: u32) -> (Vec<u8>, usize, usize) {
        let (w, h) = (self.w, self.h);
        let g = |x: usize, y: usize| {
            let (r, gg, b) = self.px(x, y);
            luma(r, gg, b).round() as u8
        };
        match quarter_turns % 4 {
            0 => ((0..h).flat_map(|y| (0..w).map(move |x| (x, y))).map(|(x, y)| g(x, y)).collect(), w, h),
            1 => ((0..w).flat_map(|y2| (0..h).map(move |x2| (x2, y2))).map(|(x2, y2)| g(y2, h - 1 - x2)).collect(), h, w),
            2 => ((0..h).flat_map(|y2| (0..w).map(move |x2| (x2, y2))).map(|(x2, y2)| g(w - 1 - x2, h - 1 - y2)).collect(), w, h),
            _ => ((0..w).flat_map(|y2| (0..h).map(move |x2| (x2, y2))).map(|(x2, y2)| g(w - 1 - y2, x2)).collect(), h, w),
        }
    }
}

/// The person around a face: head, shoulders and body down to the bottom of the picture as the screens
/// show it (turned by the slot's rotation), as a region of the raw picture
pub fn body_of(pic: &Pic, face: Rect, rotation: u32) -> Rect {
    let q = (rotation / 90) % 4;
    let (w, h) = (pic.w as f64, pic.h as f64);
    let (w2, h2) = if q % 2 == 1 { (h, w) } else { (w, h) };
    // The face in the turned picture
    let (ax, ay) = turn(q, face.x0 as f64, face.y0 as f64, w, h);
    let (bx, by) = turn(q, face.x1 as f64, face.y1 as f64, w, h);
    let (x0, x1, y0) = (ax.min(bx), ax.max(bx), ay.min(by));
    let (fw, fh) = (x1 - x0, (ay - by).abs());
    let (ux0, uy0, ux1, uy1) = ((x0 - 1.3 * fw).max(0.0), (y0 - 0.5 * fh).max(0.0), (x1 + 1.3 * fw).min(w2), h2);
    let (px, py) = unturn(q, ux0, uy0, w, h);
    let (qx, qy) = unturn(q, ux1, uy1, w, h);
    let cl = |v: f64, m: usize| v.round().clamp(0.0, m as f64) as usize;
    Rect { x0: cl(px.min(qx), pic.w), y0: cl(py.min(qy), pic.h), x1: cl(px.max(qx), pic.w), y1: cl(py.max(qy), pic.h) }
}

/// A point of the raw picture in the turned one (the reverse of unturn)
fn turn(q: u32, x: f64, y: f64, w: f64, h: f64) -> (f64, f64) {
    match q % 4 {
        0 => (x, y),
        1 => (h - y, x),
        2 => (w - x, h - y),
        _ => (y, w - x),
    }
}

/// A point of the turned picture back in the raw picture
fn unturn(q: u32, x2: f64, y2: f64, w: f64, h: f64) -> (f64, f64) {
    match q % 4 {
        0 => (x2, y2),
        1 => (y2, h - x2),
        2 => (w - x2, h - y2),
        _ => (w - y2, x2),
    }
}

fn luma(r: f64, g: f64, b: f64) -> f64 {
    0.299 * r + 0.587 * g + 0.114 * b
}

#[derive(Debug, Clone, Copy)]
pub struct Stats {
    pub mean: f64,
    pub clipped: f64,
}

/// The largest face, as a region of the raw picture. The screens may show the camera turned, so the
/// picture is searched upright first (rotation of the slot), then the other ways round.
pub fn find_face(pic: &Pic, rotation: u32) -> Option<Rect> {
    let model = rustface::read_model(std::io::Cursor::new(FACE_MODEL)).ok()?;
    let mut det = rustface::create_detector_with_model(model);
    det.set_min_face_size(24);
    det.set_score_thresh(2.0);
    det.set_pyramid_scale_factor(0.8);
    det.set_slide_window_step(4, 4);
    let first = (rotation / 90) % 4;
    for q in [first, (first + 1) % 4, (first + 3) % 4, (first + 2) % 4] {
        let (grey, w2, h2) = pic.grey_turned(q);
        let mut img = rustface::ImageData::new(&grey, w2 as u32, h2 as u32);
        let best = det.detect(&mut img).into_iter().max_by_key(|f| f.bbox().width() as i64 * f.bbox().height() as i64);
        if let Some(f) = best {
            let b = f.bbox();
            let (ax, ay) = unturn(q, b.x() as f64, b.y() as f64, pic.w as f64, pic.h as f64);
            let (bx, by) = unturn(q, (b.x() + b.width() as i32) as f64, (b.y() + b.height() as i32) as f64, pic.w as f64, pic.h as f64);
            let cl = |v: f64, m: usize| v.round().clamp(0.0, m as f64) as usize;
            let r = Rect { x0: cl(ax.min(bx), pic.w), y0: cl(ay.min(by), pic.h), x1: cl(ax.max(bx), pic.w), y1: cl(ay.max(by), pic.h) };
            if r.x1 > r.x0 + 4 && r.y1 > r.y0 + 4 {
                return Some(r);
            }
        }
    }
    None
}

// --- The calibration -----------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct Ctl {
    min: i32,
    max: i32,
    default: i32,
    menu: bool,
}

pub struct Outcome {
    /// Every control that was set, to save with the slot
    pub values: Vec<(u32, i32)>,
    /// The face, 0..1 of the raw picture (x, y, w, h)
    pub face: Option<[f64; 4]>,
    pub summary: serde_json::Value,
    pub notes: Vec<String>,
    /// How the picture is shown (colour grade), see Look
    pub look: Look,
}

/// What the calibration needs of a camera: its controls, setting them, and pictures. The real one is a
/// V4L2 device and its running stream (Live); tests replay a recording.
pub trait Device {
    /// The controls, as studio_camera::query_controls describes them
    fn controls(&mut self) -> Vec<serde_json::Value>;
    fn get(&mut self, id: u32) -> Option<i32>;
    fn set(&mut self, id: u32, value: i32) -> bool;
    /// The frame that comes skip frames after the next one
    fn grab(&mut self, skip: usize) -> Result<Pic, String>;
    fn wait(&mut self, ms: u64);
}

/// A USB camera on this computer: its V4L2 controls, and frames from its running stream
#[cfg(target_os = "linux")]
pub struct Live<G: FnMut(usize) -> Result<Pic, String>> {
    fd: i32,
    grab: G,
}

#[cfg(target_os = "linux")]
impl<G: FnMut(usize) -> Result<Pic, String>> Live<G> {
    pub fn open(device: &str, grab: G) -> Result<Self, String> {
        let fd = crate::studio_camera::open_device(device).map_err(|e| format!("Camera not reachable: {}", e))?;
        Ok(Live { fd, grab })
    }
}

#[cfg(target_os = "linux")]
impl<G: FnMut(usize) -> Result<Pic, String>> Drop for Live<G> {
    fn drop(&mut self) {
        unsafe { libc::close(self.fd) };
    }
}

#[cfg(target_os = "linux")]
impl<G: FnMut(usize) -> Result<Pic, String>> Device for Live<G> {
    fn controls(&mut self) -> Vec<serde_json::Value> {
        crate::studio_camera::query_controls(self.fd)
    }
    fn get(&mut self, id: u32) -> Option<i32> {
        crate::studio_camera::get_control(self.fd, id)
    }
    fn set(&mut self, id: u32, value: i32) -> bool {
        crate::studio_camera::set_control(self.fd, id, value).is_ok()
    }
    fn grab(&mut self, skip: usize) -> Result<Pic, String> {
        (self.grab)(skip)
    }
    fn wait(&mut self, ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
}

struct Cam<'a, D: Device> {
    dev: &'a mut D,
    ctls: std::collections::HashMap<u32, Ctl>,
    set: Vec<(u32, i32)>,
}

impl<D: Device> Cam<'_, D> {
    fn has(&self, id: u32) -> bool {
        self.ctls.contains_key(&id)
    }
    fn ctl(&self, id: u32) -> Option<Ctl> {
        self.ctls.get(&id).copied()
    }
    fn get(&mut self, id: u32) -> i32 {
        let d = self.ctl(id).map_or(0, |c| c.default);
        self.dev.get(id).unwrap_or(d)
    }
    /// Set a control the camera has (clamped to its range); returns the value set
    fn set(&mut self, id: u32, v: i32) -> i32 {
        let Some(c) = self.ctl(id) else { return v };
        let v = if c.menu { v } else { v.clamp(c.min, c.max) };
        if self.dev.set(id, v) {
            self.set.retain(|(i, _)| *i != id);
            self.set.push((id, v));
        }
        v
    }
    /// A frame that shows the last changes (the camera needs a few frames for them)
    fn look(&mut self) -> Result<Pic, String> {
        self.dev.wait(150);
        self.dev.grab(4)
    }
    fn tint_at(&mut self, kelvin: i32, person: Option<Rect>) -> Result<f64, String> {
        self.set(WB_TEMP, kelvin);
        Ok(self.look()?.tint(person))
    }
}

/// Saved controls with the white balance left to the camera and the exposure set by hand: the camera's
/// automatic exposure must run for a moment first (many cameras only find the white balance while it
/// does), then the saved values follow. Returns what to set when the camera opens, or None.
pub fn open_settle(controls: &[(u32, i32)]) -> Option<Vec<(u32, i32)>> {
    let manual = controls.contains(&(EXPOSURE_AUTO, EXPOSURE_MANUAL));
    let wb_camera = controls.contains(&(AUTO_WB, 1));
    (manual && wb_camera).then(|| controls.iter().map(|&(id, v)| if id == EXPOSURE_AUTO { (id, EXPOSURE_APERTURE_PRIORITY) } else { (id, v) }).collect())
}

/// The middle of a face box: skin only, not the hair, headphones or a bright window around the head
fn inner(f: Rect) -> Rect {
    let (w, h) = (f.x1 - f.x0, f.y1 - f.y0);
    Rect { x0: f.x0 + w / 5, y0: f.y0 + h / 5, x1: f.x1 - w / 5, y1: f.y1 - h / 5 }
}

/// The region that matters: the skin of the face, else the middle of the picture
fn meter(pic: &Pic, face: Option<Rect>) -> Stats {
    pic.stats(face.map(inner).unwrap_or_else(|| pic.centre()))
}

// --- The look: what a phone or TV does after the sensor ------------------------------------------
// The look: what a phone or TV does after the sensor, worked out from the calibrated picture and done
// where the picture is shown (a WebGL pass on the graphics chip: web/studio/js/look.js), so the camera's
// stream itself stays untouched. Per pixel, in this order:
//  1. white balance: channel gains in linear light (also green, which no camera control reaches), from
//     the room around the person, so skin and clothes never change it; plus a little warmth
//  2. clipped spots (a window, a lamp) stay white instead of turning pink or green
//  3. local tone: dark parts of the picture lifted, bright parts held back (as phones do), measured on a
//     blurred, small copy of the picture; a sharp edge keeps its own brightness, so no halos
//  4. tone curve: black and white points, a soft shoulder instead of hard clipping, a gentle S-curve
//  5. colour in Oklab: vibrance (dull colours get more, strong ones little), skin hues boosted less and
//     drawn a little towards a natural skin hue, so every player's skin looks alike well
// Look::render here is the reference; look.js must stay in step with it.

pub const LOOK_WARMTH: f64 = 1.0;
pub const LOOK_CONTRAST: f64 = 0.3;
pub const LOOK_VIBRANCE: f64 = 0.45;
pub const LOOK_SHADOWS: f64 = 0.35;
pub const LOOK_HIGHLIGHTS: f64 = 0.25;
const LOOK_BLACK: f64 = 0.03;
const LOOK_WHITE: f64 = 0.97;
/// Middle grey the local tone works towards (linear)
const TONE_KEY: f64 = 0.18;
/// Where the tone curve starts rolling off towards white
const KNEE: f64 = 0.8;
/// How far (in stops) a pixel may differ from its surroundings before the local tone leaves it alone
const TONE_HALO: f64 = 1.5;
/// The small copy for the local tone: this many px wide, blurred by this many of its px
pub const TONE_WIDTH: usize = 240;
pub const TONE_SIGMA: f64 = 6.0;
/// Skin in Oklab: hue (rad) of all skin tones, light to dark; how much less boost it gets, how far its hue
/// is drawn towards this one
const SKIN_HUE: f64 = 0.77;
const SKIN_PROTECT: f64 = 0.6;
const SKIN_PULL: f64 = 0.25;
const LUM: [f64; 3] = [0.2126, 0.7152, 0.0722];

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Look {
    /// White balance gains in linear light, brightness kept
    pub r: f64,
    pub g: f64,
    pub b: f64,
    pub warmth: f64,
    pub black: f64,
    pub white: f64,
    pub contrast: f64,
    pub vibrance: f64,
    pub shadows: f64,
    pub highlights: f64,
}

pub fn srgb_to_linear(c: f64) -> f64 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

pub fn linear_to_srgb(l: f64) -> f64 {
    let l = l.clamp(0.0, 1.0);
    if l <= 0.0031308 { l * 12.92 } else { 1.055 * l.powf(1.0 / 2.4) - 0.055 }
}

fn smoothstep(e0: f64, e1: f64, x: f64) -> f64 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn oklab(c: [f64; 3]) -> [f64; 3] {
    let l = (0.4122214708 * c[0] + 0.5363325363 * c[1] + 0.0514459929 * c[2]).max(0.0).cbrt();
    let m = (0.2119034982 * c[0] + 0.6806995451 * c[1] + 0.1073969566 * c[2]).max(0.0).cbrt();
    let s = (0.0883024619 * c[0] + 0.2817188376 * c[1] + 0.6299787005 * c[2]).max(0.0).cbrt();
    [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ]
}

fn from_oklab(k: [f64; 3]) -> [f64; 3] {
    let l = (k[0] + 0.3963377774 * k[1] + 0.2158037573 * k[2]).powi(3);
    let m = (k[0] - 0.1055613458 * k[1] - 0.0638541728 * k[2]).powi(3);
    let s = (k[0] - 0.0894841775 * k[1] - 1.2914855480 * k[2]).powi(3);
    [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ]
}

impl Look {
    pub fn json(&self) -> serde_json::Value {
        let r3 = |v: f64| (v * 1000.0).round() / 1000.0;
        serde_json::json!({"r": r3(self.r), "g": r3(self.g), "b": r3(self.b), "warmth": r3(self.warmth),
            "black": r3(self.black), "white": r3(self.white), "contrast": r3(self.contrast),
            "vibrance": r3(self.vibrance), "shadows": r3(self.shadows), "highlights": r3(self.highlights)})
    }

    /// The white balance gains with the warmth, brightness kept
    pub fn gains(&self) -> [f64; 3] {
        let w = (0.06 * self.warmth).exp();
        let k = [self.r * w, self.g, self.b / w];
        let l = dot(k, LUM).max(1e-6);
        k.map(|v| v / l)
    }

    /// Log2 brightness of one camera pixel after the white balance (what the small copy is made of)
    fn log_luma(k: [f64; 3], c: [f64; 3]) -> f64 {
        dot([srgb_to_linear(c[0]) * k[0], srgb_to_linear(c[1]) * k[1], srgb_to_linear(c[2]) * k[2]], LUM).max(1e-5).log2()
    }

    /// One camera pixel (sRGB 0..1) through the look; base: the blurred log2 brightness around it
    pub fn pixel(&self, c: [f64; 3], base: f64) -> [f64; 3] {
        let k = self.gains();
        // 1, 2: white balance; clipped spots stay white
        let clip = smoothstep(0.86, 0.98, c[0].max(c[1]).max(c[2]));
        let mut lin = [srgb_to_linear(c[0]) * k[0], srgb_to_linear(c[1]) * k[1], srgb_to_linear(c[2]) * k[2]];
        let yc = dot(lin, LUM);
        lin = lin.map(|v| v + (yc - v) * clip);
        let y = dot(lin, LUM).max(1e-5);
        // 3: local tone
        let l = y.log2();
        let key = TONE_KEY.log2();
        // Clipped spots are not held back: a window stays white, not grey
        let mut d = if base < key { self.shadows * (key - base) } else { -self.highlights * (base - key) * (1.0 - clip) };
        d *= (-(l - base).powi(2) / (2.0 * TONE_HALO * TONE_HALO)).exp();
        let y2 = (l + d.clamp(-1.0, 1.5)).exp2();
        // 4: tone curve on the display value: levels, a soft knee from 0.8 so that what the camera clipped
        // lands exactly on white, S-curve
        let span = (self.white - self.black).max(0.05);
        let mut x = (1.055 * y2.powf(1.0 / 2.4) - 0.055 - self.black) / span;
        let top = (1.0 - self.black) / span - KNEE;
        if x > KNEE && top > 0.0 {
            let t = x - KNEE;
            let a = ((top - (1.0 - KNEE)) / (top * top)).max(0.0);
            x = KNEE + t - a * t.min(top) * t.min(top);
        }
        let x = x.clamp(0.0, 1.0);
        let out = x + self.contrast * (x * x * (3.0 - 2.0 * x) - x);
        let yo = srgb_to_linear(out);
        let mut lo = lin.map(|v| v * yo / y);
        let over = ((lo[0].max(lo[1]).max(lo[2]) - 0.85) / 0.6).clamp(0.0, 1.0);
        lo = lo.map(|v| v + (yo - v) * over);
        // 5: colour
        let mut ok = oklab(lo);
        let ch = ok[1].hypot(ok[2]);
        let hue = ok[2].atan2(ok[1]);
        let mut dh = hue - SKIN_HUE;
        dh = dh.sin().atan2(dh.cos());
        let skin = (-(dh / 0.45).powi(2)).exp() * ((ch - 0.01) / 0.03).clamp(0.0, 1.0) * ((0.2 - ch) / 0.08).clamp(0.0, 1.0);
        let boost = self.vibrance * (1.0 - (ch / 0.22).clamp(0.0, 1.0)) * (1.0 - SKIN_PROTECT * skin);
        let (ch2, hue2) = (ch * (1.0 + boost), hue - skin * SKIN_PULL * dh);
        ok[1] = ch2 * hue2.cos();
        ok[2] = ch2 * hue2.sin();
        from_oklab(ok).map(linear_to_srgb)
    }

    /// The small blurred copy of a picture's log brightness (TONE_WIDTH wide), as the graphics chip makes it
    pub fn tone_base(&self, p: &Pic) -> (usize, usize, Vec<f64>) {
        let k = self.gains();
        let sw = TONE_WIDTH.min(p.w).max(1);
        let sh = ((p.h * sw) as f64 / p.w as f64).round().max(1.0) as usize;
        let mut small = vec![0.0; sw * sh];
        for sy in 0..sh {
            for sx in 0..sw {
                let (x0, x1) = (sx * p.w / sw, ((sx + 1) * p.w / sw).max(sx * p.w / sw + 1));
                let (y0, y1) = (sy * p.h / sh, ((sy + 1) * p.h / sh).max(sy * p.h / sh + 1));
                let mut sum = 0.0;
                for y in y0..y1 {
                    for x in x0..x1 {
                        let (r, g, b) = p.px(x, y);
                        sum += Self::log_luma(k, [r / 255.0, g / 255.0, b / 255.0]);
                    }
                }
                small[sy * sw + sx] = sum / ((x1 - x0) * (y1 - y0)) as f64;
            }
        }
        // Gaussian blur, edges repeated
        let r = (3.0 * TONE_SIGMA).ceil() as i64;
        let wts: Vec<f64> = (-r..=r).map(|i| (-(i * i) as f64 / (2.0 * TONE_SIGMA * TONE_SIGMA)).exp()).collect();
        let total: f64 = wts.iter().sum();
        let blur = |src: &Vec<f64>, horizontal: bool| -> Vec<f64> {
            let mut out = vec![0.0; sw * sh];
            for y in 0..sh as i64 {
                for x in 0..sw as i64 {
                    let mut s = 0.0;
                    for (j, w) in wts.iter().enumerate() {
                        let o = j as i64 - r;
                        let (xx, yy) = if horizontal { ((x + o).clamp(0, sw as i64 - 1), y) } else { (x, (y + o).clamp(0, sh as i64 - 1)) };
                        s += w * src[(yy as usize) * sw + xx as usize];
                    }
                    out[(y as usize) * sw + x as usize] = s / total;
                }
            }
            out
        };
        let small = blur(&blur(&small, true), false);
        (sw, sh, small)
    }

    /// A whole picture through the look (bilinear between the small copy's px, as a texture is read)
    pub fn render(&self, p: &Pic) -> Pic {
        let (sw, sh, small) = self.tone_base(p);
        let at = |x: usize, y: usize| -> f64 {
            let fx = ((x as f64 + 0.5) * sw as f64 / p.w as f64 - 0.5).clamp(0.0, (sw - 1) as f64);
            let fy = ((y as f64 + 0.5) * sh as f64 / p.h as f64 - 0.5).clamp(0.0, (sh - 1) as f64);
            let (x0, y0) = (fx.floor() as usize, fy.floor() as usize);
            let (x1, y1) = ((x0 + 1).min(sw - 1), (y0 + 1).min(sh - 1));
            let (tx, ty) = (fx - x0 as f64, fy - y0 as f64);
            let top = small[y0 * sw + x0] * (1.0 - tx) + small[y0 * sw + x1] * tx;
            let bot = small[y1 * sw + x0] * (1.0 - tx) + small[y1 * sw + x1] * tx;
            top * (1.0 - ty) + bot * ty
        };
        let mut rgb = Vec::with_capacity(p.rgb.len());
        for y in 0..p.h {
            for x in 0..p.w {
                let (r, g, b) = p.px(x, y);
                let o = self.pixel([r / 255.0, g / 255.0, b / 255.0], at(x, y));
                rgb.extend(o.map(|v| (v * 255.0).round().clamp(0.0, 255.0) as u8));
            }
        }
        Pic { w: p.w, h: p.h, rgb }
    }
}

/// The look for a calibrated picture. Only the room decides it, never the person (skin, clothes): the white
/// balance is the grey of the picture around the person, in linear light; the rest is the same for everyone.
pub fn look_of(pic: &Pic, person: Option<Rect>) -> Look {
    let [r, g, b] = pic.room_linear(person);
    let k = [g / r.max(1e-6), 1.0, g / b.max(1e-6)];
    let l = dot(k, LUM);
    Look {
        r: k[0] / l,
        g: k[1] / l,
        b: k[2] / l,
        warmth: LOOK_WARMTH,
        black: LOOK_BLACK,
        white: LOOK_WHITE,
        contrast: LOOK_CONTRAST,
        vibrance: LOOK_VIBRANCE,
        shadows: LOOK_SHADOWS,
        highlights: LOOK_HIGHLIGHTS,
    }
}

pub fn calibrate(dev: &mut impl Device, rotation: u32) -> Result<Outcome, String> {
    let ctls = dev
        .controls()
        .iter()
        .filter_map(|c| {
            let g = |k: &str| c[k].as_i64().map(|v| v as i32);
            Some((c["id"].as_u64()? as u32, Ctl { min: g("min")?, max: g("max")?, default: g("default")?, menu: c["type"] == "menu" }))
        })
        .collect();
    let mut c = Cam { dev, ctls, set: Vec::new() };
    let mut notes = Vec::new();

    // 1. A clean start: the camera's own picture settings and automatics, a fair picture to find the face in
    for id in [BRIGHTNESS, CONTRAST, SATURATION, HUE, GAMMA, SHARPNESS] {
        if let Some(x) = c.ctl(id) {
            c.set(id, x.default);
        }
    }
    c.set(AUTO_WB, 1);
    c.set(AUTOGAIN, 1);
    c.set(EXPOSURE_AUTO, EXPOSURE_APERTURE_PRIORITY);
    c.dev.wait(SETTLE_MS);
    let first = c.look()?;
    let mut face = find_face(&first, rotation);
    // The person (face and body) is left out wherever colour is judged: only the room decides it
    let person = |face: Option<Rect>| face.map(|f| body_of(&first, f, rotation));

    // 2. White balance by hand: the temperature at which grey looks most neutral. Some cameras reach
    //    neutral only with their automatic (it also sets green, which no manual control reaches); then
    //    the automatic stays on, and manual exposure freezes it on most cameras (see open_settle).
    let mut kelvin = None;
    let mut wb_camera = false;
    match c.ctl(WB_TEMP) {
        Some(t) if c.has(AUTO_WB) => {
            let around = person(face);
            let auto_tint = c.look()?.tint(around);
            c.set(AUTO_WB, 0);
            // Coarse sweep, then closer around the best (the response is not always smooth)
            let mut step = ((t.max - t.min) / 8).max(1);
            let mut best = (f64::MAX, t.default);
            for k in (0..=8).map(|i| t.min + i * step) {
                let tint = c.tint_at(k, around)?;
                if tint < best.0 {
                    best = (tint, k);
                }
            }
            while step > 60 {
                step /= 2;
                let centre = best.1;
                for k in [centre - step, centre + step] {
                    if (t.min..=t.max).contains(&k) {
                        let tint = c.tint_at(k, around)?;
                        if tint < best.0 {
                            best = (tint, k);
                        }
                    }
                }
            }
            // By hand only when clearly more neutral: a close call would flip from one run to the next
            if best.0 <= auto_tint - 0.02 {
                kelvin = Some(c.set(WB_TEMP, best.1));
            } else {
                wb_camera = true;
                c.set(WB_TEMP, t.default);
                c.set(AUTO_WB, 1);
                c.dev.wait(SETTLE_MS);
            }
        }
        _ if c.has(AUTO_WB) => wb_camera = true,
        _ => notes.push("This camera has no white balance to set".to_string()),
    }

    // 3. Exposure by hand, metered on the face
    let can_expose = c.has(EXPOSURE_AUTO) && c.has(EXPOSURE);
    c.set(AUTOGAIN, 0);
    let gain_ctl = c.ctl(GAIN);
    let flicker_step = match c.has(POWER_LINE).then(|| c.get(POWER_LINE)) {
        Some(1) => 100, // 50 Hz light pulses 100 times a second; exposure is in 100 µs
        Some(2) => 83,
        _ => 0,
    };
    let mut exposure = 0;
    let mut gain = gain_ctl.map_or(0, |g| g.min);
    if can_expose {
        // Start from what the automatic chose, where the camera reports it
        let start = c.get(EXPOSURE);
        c.set(EXPOSURE_AUTO, EXPOSURE_MANUAL);
        c.set(EXPOSURE_PRIORITY, 0);
        exposure = c.set(EXPOSURE, start.min(max_exposure(c.ctl(EXPOSURE).unwrap())));
        gain = c.set(GAIN, gain);
        expose(&mut c, &mut exposure, &mut gain, face, flicker_step)?;
        // A face against a bright window is a dark shape at first: look again now that it is exposed
        if face.is_none() {
            face = find_face(&c.look()?, rotation);
            if face.is_some() {
                expose(&mut c, &mut exposure, &mut gain, face, flicker_step)?;
            }
        }
    } else {
        notes.push("This camera cannot set its exposure by hand".to_string());
    }

    // 4. Exposure again, now in whole pulses of the room light
    if can_expose {
        expose(&mut c, &mut exposure, &mut gain, face, flicker_step)?;
    }

    // 5. Sharpness: the camera's own, never more (more draws dark lines along faces against a bright
    // background); the look sharpens after its noise filter, without halos. Less when the gain makes it noisy.
    if let Some(sh) = c.ctl(SHARPNESS) {
        let noisy = gain_ctl.map_or(0.0, |g| (gain - g.min) as f64 / (g.max - g.min).max(1) as f64);
        let step = ((sh.max - sh.min) as f64 * 0.15).round().max(1.0) as i32;
        c.set(SHARPNESS, if noisy > 0.5 { sh.default - step } else { sh.default });
    }

    let last = c.look()?;
    let m = meter(&last, face);
    if face.is_none() {
        notes.push("No face found, so the middle of the picture was measured. Stand where you throw, face the camera and start again.".to_string());
    }
    let target = if face.is_some() { FACE_TARGET } else { CENTRE_TARGET };
    if m.mean < target - 25.0 {
        notes.push("Still dark at the longest exposure and full gain: more light on the player helps.".to_string());
    } else if m.mean > target + 25.0 {
        notes.push("Still bright at the shortest exposure.".to_string());
    }
    let (w, h) = (last.w as f64, last.h as f64);
    let look = look_of(&last, person(face));
    Ok(Outcome {
        look,
        values: c.set.clone(),
        face: face.map(|f| [f.x0 as f64 / w, f.y0 as f64 / h, (f.x1 - f.x0) as f64 / w, (f.y1 - f.y0) as f64 / h]),
        summary: serde_json::json!({
            "exposure_ms": can_expose.then(|| exposure as f64 / 10.0),
            "gain": gain_ctl.map(|_| gain),
            "white_balance_k": kelvin,
            "white_balance_camera": wb_camera,
            "brightness": m.mean.round(),
        }),
        notes,
    })
}

/// Exposure is in 100 µs; at most one frame long so the frame rate stays
fn max_exposure(e: Ctl) -> i32 {
    e.max.min((10_000 / crate::studio_camera::FPS) as i32).max(e.min)
}

/// Exposure, then gain, until the face is at the target. Exposure first (gain adds noise), and with
/// flicker_step > 0 in whole pulses of the room light (no banding): of the pulses around the light needed,
/// the one that lands closest; gain makes up the rest.
fn expose<D: Device>(c: &mut Cam<'_, D>, exposure: &mut i32, gain: &mut i32, face: Option<Rect>, flicker_step: i32) -> Result<(), String> {
    let target = if face.is_some() { FACE_TARGET } else { CENTRE_TARGET };
    let e = c.ctl(EXPOSURE).unwrap();
    let e_max = max_exposure(e);
    let g = c.ctl(GAIN);
    // Exposures worth trying for a wanted one: itself, or the whole pulses either side of it
    let options = |want: i32| -> Vec<i32> {
        let want = want.clamp(e.min, e_max);
        if flicker_step > 0 && want >= flicker_step {
            let down = want / flicker_step * flicker_step;
            [down, down + flicker_step].into_iter().filter(|v| *v <= e_max).collect()
        } else {
            vec![want]
        }
    };
    for _ in 0..12 {
        let s = meter(&c.look()?, face);
        // Blown-out skin reads darker than it is; treat it as too bright
        let lum = if s.clipped > 0.03 { s.mean.max(target + TOLERANCE + 1.0) } else { s.mean };
        let err = (lum - target).abs();
        if err <= TOLERANCE {
            break;
        }
        // The picture is gamma-encoded: light needed ≈ (target / now)^2.2
        let ratio = (target / lum.max(1.0)).powf(2.2).clamp(0.25, 4.0);
        let predicted = |light: f64| (lum * light.powf(1.0 / 2.2) - target).abs();
        let want = (*exposure as f64 * ratio).round() as i32;
        let best = options(want).into_iter().min_by(|a, b| predicted(*a as f64 / *exposure as f64).total_cmp(&predicted(*b as f64 / *exposure as f64))).unwrap_or(*exposure);
        let better = best != *exposure && predicted(best as f64 / *exposure as f64) < err - 1.0;
        let gain_room = g.map_or(false, |gc| if ratio > 1.0 { *gain < gc.max } else { *gain > gc.min });
        if ratio > 1.0 {
            // Brighter: longer exposure while it gets closer, then gain
            if better && best > *exposure {
                *exposure = c.set(EXPOSURE, best);
            } else if gain_room {
                *gain = c.set(GAIN, step_gain(*gain, g.unwrap(), ratio));
            } else {
                break;
            }
        } else if gain_room {
            // Darker: less gain first, then a shorter exposure
            *gain = c.set(GAIN, step_gain(*gain, g.unwrap(), ratio));
        } else if better && best < *exposure {
            *exposure = c.set(EXPOSURE, best);
        } else {
            break;
        }
    }
    Ok(())
}

/// Gain scales differ between cameras: move by a share of its range that grows with how far off it is
fn step_gain(gain: i32, gc: Ctl, ratio: f64) -> i32 {
    let range = (gc.max - gc.min).max(1) as f64;
    let mut delta = (ratio.log2() * range * 0.25).round() as i32;
    if delta == 0 {
        delta = if ratio > 1.0 { 1 } else { -1 };
    }
    (gain + delta).clamp(gc.min, gc.max)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pic(w: usize, h: usize, f: impl Fn(usize, usize) -> [u8; 3]) -> Pic {
        let f = &f;
        Pic { w, h, rgb: (0..h).flat_map(|y| (0..w).flat_map(move |x| f(x, y))).collect() }
    }

    #[test]
    fn colour_cast() {
        let (r, b) = pic(40, 30, |_, _| [150, 120, 90]).cast();
        assert!(r > 0.1 && b < -0.1);
        let (r, b) = pic(40, 30, |_, _| [100, 130, 100]).cast();
        assert!(r < -0.1 && b < -0.1, "green");
        assert!(pic(40, 30, |_, _| [120, 120, 120]).tint(None) < 0.01);
    }

    #[test]
    fn turning_maps_back() {
        let p = pic(8, 4, |x, y| [(x * 10 + y) as u8, 0, 0]);
        for q in 0..4 {
            let (g, w2, h2) = p.grey_turned(q);
            // Pixel (1, 2) of the turned picture, by its centre, back in the raw picture
            let (x, y) = unturn(q, 1.5, 2.5, 8.0, 4.0);
            let raw = p.px(x.floor() as usize, y.floor() as usize);
            assert_eq!(g[2 * w2 + 1], luma(raw.0, raw.1, raw.2).round() as u8, "quarter turns {}", q);
            assert_eq!(w2 * h2, 32);
        }
    }

    #[test]
    fn settle_only_with_camera_white_balance() {
        let saved = [(AUTO_WB, 1), (EXPOSURE_AUTO, EXPOSURE_MANUAL), (EXPOSURE, 300)];
        assert_eq!(open_settle(&saved).unwrap(), vec![(AUTO_WB, 1), (EXPOSURE_AUTO, EXPOSURE_APERTURE_PRIORITY), (EXPOSURE, 300)]);
        assert!(open_settle(&[(AUTO_WB, 0), (WB_TEMP, 5000), (EXPOSURE_AUTO, EXPOSURE_MANUAL)]).is_none());
        assert!(open_settle(&[]).is_none());
    }

    #[test]
    fn gain_steps_both_ways() {
        let gc = Ctl { min: 0, max: 100, default: 0, menu: false };
        assert!(step_gain(10, gc, 2.0) > 10);
        assert!(step_gain(10, gc, 0.5) < 10);
        assert_eq!(step_gain(0, gc, 0.5), 0);
    }

    /// AUTOGLOW_FACE_JPG=photo.jpg cargo test finds_a_face (a photo with a face, also turned)
    #[test]
    fn finds_a_face() {
        let Ok(path) = std::env::var("AUTOGLOW_FACE_JPG") else { return };
        let p = decode(&std::fs::read(path).unwrap()).unwrap();
        let f0 = find_face(&p, 0).expect("face upright");
        // Just that face (the photo may show several), with room around it
        let (fw, fh) = (f0.x1 - f0.x0, f0.y1 - f0.y0);
        let (x0, y0) = (f0.x0.saturating_sub(fw), f0.y0.saturating_sub(fh));
        let (x1, y1) = ((f0.x1 + fw).min(p.w), (f0.y1 + fh).min(p.h));
        let p = pic(x1 - x0, y1 - y0, |x, y| {
            let (r, g, b) = p.px(x0 + x, y0 + y);
            [r as u8, g as u8, b as u8]
        });
        let f = find_face(&p, 0).expect("face in the crop");
        // The same photo lying on its side is found too, at the same place
        let turned = Pic { w: p.h, h: p.w, rgb: { let (g, _, _) = p.grey_turned(3); g.iter().flat_map(|&v| [v, v, v]).collect() } };
        let f2 = find_face(&turned, 0).expect("face on its side");
        let (cx, cy) = unturn(3, (f2.x0 + f2.x1) as f64 / 2.0, (f2.y0 + f2.y1) as f64 / 2.0, turned.w as f64, turned.h as f64);
        let (fx, fy) = ((f.x0 + f.x1) as f64 / 2.0, (f.y0 + f.y1) as f64 / 2.0);
        assert!((cx - fx).abs() < 20.0 && (cy - fy).abs() < 20.0, "turned face at {:?}, upright at {:?}", (cx, cy), (fx, fy));
    }

    // --- Replay: a recorded session (scratch/camera-recording-*) as a camera ---------------------
    // The recording sweeps one control at a time while the player stands still. A frame for any
    // exposure × gain is the recorded one nearest in light, scaled for the rest (gamma 2.2); with the
    // white balance by hand, the nearest recorded temperature. Other picture controls are not replayed.

    struct Rec {
        file: String,
        group: String,
        c: std::collections::HashMap<String, i32>,
        pic: Pic,
    }

    struct Replay {
        recs: Vec<Rec>,
        controls: Vec<serde_json::Value>,
        state: std::collections::HashMap<u32, i32>,
        gain: Vec<(i32, f64)>,
        ms: u64,
        grabs: usize,
    }

    fn gamma_scale(p: &Pic, k: f64) -> Pic {
        let lut: Vec<u8> = (0..256).map(|v| (255.0 * ((v as f64 / 255.0).powf(2.2) * k).min(1.0).powf(1.0 / 2.2)).round() as u8).collect();
        Pic { w: p.w, h: p.h, rgb: p.rgb.iter().map(|&v| lut[v as usize]).collect() }
    }

    impl Replay {
        fn load(dir: &str) -> Replay {
            let man: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(format!("{}/manifest.json", dir)).unwrap()).unwrap();
            let recs = man["frames"]
                .as_array()
                .unwrap()
                .iter()
                .map(|f| Rec {
                    file: f["file"].as_str().unwrap().into(),
                    group: f["group"].as_str().unwrap().into(),
                    c: f["controls"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_i64().unwrap_or(0) as i32)).collect(),
                    pic: decode(&std::fs::read(format!("{}/{}", dir, f["file"].as_str().unwrap())).unwrap()).unwrap(),
                })
                .collect();
            let cj: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(format!("{}/controls.json", dir)).unwrap()).unwrap();
            let controls = cj["controls"].as_array().unwrap().clone();
            let state = controls.iter().map(|c| (c["id"].as_u64().unwrap() as u32, c["default"].as_i64().unwrap() as i32)).collect();
            let mut r = Replay { recs, controls, state, gain: Vec::new(), ms: 0, grabs: 0 };
            // What gain does to the light, from the gain sweep at 30 ms (face brightness, gamma 2.2)
            let face = r.face_of("gain30ms", 0).expect("face in the recording");
            let m0 = r.recs.iter().find(|x| x.group == "gain30ms" && x.c["gain"] == 0).unwrap().pic.stats(face).mean;
            r.gain = r.recs.iter().filter(|x| x.group == "gain30ms").map(|x| (x.c["gain"], (x.pic.stats(face).mean / m0).powf(2.2))).collect();
            r
        }
        fn face_of(&self, group: &str, gain: i32) -> Option<Rect> {
            find_face(&self.recs.iter().find(|x| x.group == group && x.c["gain"] == gain)?.pic, 90)
        }
        fn gain_factor(&self, g: i32) -> f64 {
            let gs = &self.gain;
            if g <= gs[0].0 {
                return gs[0].1;
            }
            for w in gs.windows(2) {
                if g <= w[1].0 {
                    let t = (g - w[0].0) as f64 / (w[1].0 - w[0].0) as f64;
                    return w[0].1 + t * (w[1].1 - w[0].1);
                }
            }
            gs.last().unwrap().1
        }
        fn light(&self, e: i32, g: i32) -> f64 {
            e.max(1) as f64 * self.gain_factor(g)
        }
        fn frame(&self) -> Pic {
            let st = |id: u32| self.state[&id];
            if st(EXPOSURE_AUTO) != EXPOSURE_MANUAL && st(AUTO_WB) == 1 {
                return self.recs.iter().find(|x| x.group == "auto").unwrap().pic.clone();
            }
            let by_hand_wb = st(AUTO_WB) == 0;
            // Under the automatic exposure, the light of the base frames (30 ms, gain 20)
            let want = if st(EXPOSURE_AUTO) == EXPOSURE_MANUAL { self.light(st(EXPOSURE), st(GAIN)) } else { self.light(300, 20) };
            let best = self
                .recs
                .iter()
                .filter(|x| if by_hand_wb { x.group == "wb" } else { ["exposure", "gain10ms", "gain30ms", "base"].contains(&x.group.as_str()) })
                .min_by(|a, b| {
                    let d = |x: &Rec| {
                        if by_hand_wb {
                            (x.c["white_balance_temperature"] - st(WB_TEMP)).abs() as f64
                        } else {
                            (self.light(x.c["exposure_time_absolute"], x.c["gain"]) / want).ln().abs()
                        }
                    };
                    d(a).partial_cmp(&d(b)).unwrap()
                })
                .unwrap();
            gamma_scale(&best.pic, want / self.light(best.c["exposure_time_absolute"], best.c["gain"]))
        }
    }

    impl Device for Replay {
        fn controls(&mut self) -> Vec<serde_json::Value> {
            self.controls.clone()
        }
        fn get(&mut self, id: u32) -> Option<i32> {
            self.state.get(&id).copied()
        }
        fn set(&mut self, id: u32, value: i32) -> bool {
            self.state.insert(id, value);
            true
        }
        fn grab(&mut self, skip: usize) -> Result<Pic, String> {
            self.grabs += 1;
            self.ms += 33 * (skip as u64 + 1) + 40;
            Ok(self.frame())
        }
        fn wait(&mut self, ms: u64) {
            self.ms += ms;
        }
    }

    fn write_ppm(p: &Pic, path: &str) {
        let mut out = format!("P6\n{} {}\n255\n", p.w, p.h).into_bytes();
        out.extend_from_slice(&p.rgb);
        std::fs::write(path, out).unwrap();
    }

    /// AUTOGLOW_LOOK_JPG=picture.jpg cargo test look_preview -- --nocapture: the look for a camera picture
    /// (turned 90°), written next to it as -look.ppm
    #[test]
    fn look_preview() {
        let Ok(path) = std::env::var("AUTOGLOW_LOOK_JPG") else { return };
        let p = decode(&std::fs::read(&path).unwrap()).unwrap();
        let face = find_face(&p, 90);
        let look = look_of(&p, face.map(|f| body_of(&p, f, 90)));
        println!("face {:?} LOOK {}", face, look.json());
        write_ppm(&look.render(&p), &format!("{}-look.ppm", path));
    }

    #[test]
    fn body_hangs_below_the_face_on_screen() {
        // A camera turned 90° clockwise on screen: the raw picture's left edge is at the top of the screen,
        // so "down" on screen is towards the raw picture's right edge
        let p = pic(160, 90, |_, _| [0, 0, 0]);
        let b = body_of(&p, Rect { x0: 100, y0: 40, x1: 110, y1: 50 }, 90);
        assert_eq!(b.x1, 160, "reaches the bottom of the screen: {:?}", b);
        assert!(b.x0 >= 94 && b.x0 <= 100, "a little above the face: {:?}", b);
        assert!(b.y0 < 40 && b.y1 > 50, "wider than the face: {:?}", b);
        let up = body_of(&p, Rect { x0: 100, y0: 40, x1: 110, y1: 50 }, 0);
        assert_eq!((up.y1, up.x0 < 100, up.x1 > 110), (90, true, true), "{:?}", up);
    }

    #[test]
    fn clothes_do_not_change_the_colour() {
        // A grey room with a person in a strongly coloured top: the cast stays that of the room
        let room = |x: usize, y: usize| x < 60 || y < 20;
        let red = pic(160, 90, |x, y| if room(x, y) { [118, 120, 124] } else { [200, 40, 40] });
        let green = pic(160, 90, |x, y| if room(x, y) { [118, 120, 124] } else { [40, 200, 60] });
        let person = Some(Rect { x0: 60, y0: 20, x1: 160, y1: 90 });
        let (a, b) = (look_of(&red, person), look_of(&green, person));
        assert!((a.r - b.r).abs() < 0.01 && (a.b - b.b).abs() < 0.01, "{:?} vs {:?}", a, b);
        assert_eq!((a.vibrance, a.contrast, a.black, a.white), (b.vibrance, b.contrast, b.black, b.white));
    }

    #[test]
    fn look_keeps_grey_and_brightness() {
        let plain = Look { r: 1.0, g: 1.0, b: 1.0, warmth: 0.0, black: 0.0, white: 1.0, contrast: 0.0, vibrance: 0.6, shadows: 0.0, highlights: 0.0 };
        // Mid grey stays grey (vibrance has nothing to boost) and keeps its brightness
        let grey = |look: &Look, v: f64| look.pixel([v, v, v], Look::log_luma(look.gains(), [v, v, v]));
        let out = grey(&plain, 0.5);
        assert!(out.iter().all(|v| (v - 0.5).abs() < 0.003), "{:?}", out);
        // With the default look grey stays neutral, only warmed
        let look = Look { warmth: 0.0, ..look_of(&pic(8, 8, |_, _| [128, 128, 128]), None) };
        for v in [0.1, 0.3, 0.5, 0.7, 0.9] {
            let o = grey(&look, v);
            assert!((o[0] - o[1]).abs() < 0.004 && (o[2] - o[1]).abs() < 0.004, "{} -> {:?}", v, o);
        }
        let warm = grey(&Look { warmth: 1.0, ..plain }, 0.5);
        assert!(warm[0] > warm[1] && warm[1] > warm[2], "warmth: more red, less blue");
    }

    #[test]
    fn look_curve_is_smooth_and_rising() {
        let look = look_of(&pic(8, 8, |_, _| [128, 128, 128]), None);
        let mut last = -1.0;
        for i in 0..=255 {
            let v = i as f64 / 255.0;
            let o = look.pixel([v, v, v], Look::log_luma(look.gains(), [v, v, v]))[1];
            assert!(o >= last - 1e-9 && o - last.max(0.0) < 0.03, "{} -> {} after {}", v, o, last);
            last = o;
        }
        assert!(last > 0.995, "white stays white: {}", last);
    }

    #[test]
    fn local_tone_lifts_dark_surroundings_only() {
        let look = look_of(&pic(8, 8, |_, _| [128, 128, 128]), None);
        let v = 0.25;
        let own = Look::log_luma(look.gains(), [v, v, v]);
        let alone = look.pixel([v, v, v], own)[1];
        let dark_room = look.pixel([v, v, v], own - 1.0)[1];
        let bright_room = look.pixel([v, v, v], own + 1.0)[1];
        assert!(dark_room > alone && alone > bright_room, "{} {} {}", dark_room, alone, bright_room);
        // A sharp edge (far from its surroundings) is left nearly as it is: no halo
        let untouched = look.pixel([v, v, v], TONE_KEY.log2())[1];
        let edge = look.pixel([v, v, v], own + 4.0)[1];
        assert!((edge - untouched).abs() < 0.01, "{} {}", edge, untouched);
    }

    #[test]
    fn skin_tones_kept_natural() {
        // Skin from light to dark: boosted less than other colours of the same strength, hue drawn together
        let look = Look { warmth: 0.0, ..look_of(&pic(8, 8, |_, _| [128, 128, 128]), None) };
        let hue = |c: [f64; 3]| { let k = oklab(c.map(srgb_to_linear)); k[2].atan2(k[1]) };
        let chroma = |c: [f64; 3]| { let k = oklab(c.map(srgb_to_linear)); k[1].hypot(k[2]) };
        let run = |c: [u8; 3]| { let c = c.map(|v| v as f64 / 255.0); look.pixel(c, Look::log_luma(look.gains(), c)) };
        let skins = [[224u8, 172, 150], [198, 134, 110], [141, 85, 60], [90, 56, 40]];
        for s in skins {
            let c = s.map(|v| v as f64 / 255.0);
            let o = run(s);
            assert!((hue(o) - SKIN_HUE).abs() <= (hue(c) - SKIN_HUE).abs() + 0.02, "{:?}: {} -> {}", s, hue(c), hue(o));
            let gain = chroma(o) / chroma(c);
            assert!(gain < 1.0 + look.vibrance * 0.6, "skin {:?} boosted {}", s, gain);
        }
        // Skin a little too pink or too yellow is drawn towards the natural hue
        for s in [[214u8, 150, 150], [200, 165, 110]] {
            let c = s.map(|v| v as f64 / 255.0);
            assert!((hue(run(s)) - SKIN_HUE).abs() < (hue(c) - SKIN_HUE).abs() - 0.01, "{:?}: {} -> {}", s, hue(c), hue(run(s)));
        }
        // A dull blue of about the same strength gets more
        let blue = [110u8, 125, 160];
        let c = blue.map(|v| v as f64 / 255.0);
        assert!(chroma(run(blue)) / chroma(c) > 1.0 + look.vibrance * 0.6);
    }

    /// AUTOGLOW_REPLAY=scratch/camera-recording-2026-11-27 cargo test replay -- --nocapture
    #[test]
    fn replay_recording() {
        let Ok(dir) = std::env::var("AUTOGLOW_REPLAY") else { return };
        let mut r = Replay::load(&dir);
        println!("gain factors: {:?}", r.gain.iter().map(|(g, f)| format!("{}:{:.2}", g, f)).collect::<Vec<_>>());
        for x in &r.recs {
            let f = find_face(&x.pic, 90);
            let m = f.map(|f| x.pic.stats(f).mean);
            println!("{:<34} e={:<4} g={:<3} face={:<5} whole={:.0} tint={:.3}", x.file, x.c["exposure_time_absolute"], x.c["gain"],
                m.map_or("-".into(), |m| format!("{:.0}", m)), x.pic.stats(x.pic.whole()).mean, x.pic.tint(None));
        }
        let out = calibrate(&mut r, 90).unwrap();
        let named: Vec<String> = out.values.iter().map(|(id, v)| {
            let n = r.controls.iter().find(|c| c["id"] == serde_json::json!(id)).map_or("?".into(), |c| c["name"].as_str().unwrap().to_string());
            format!("{}={}", n, v)
        }).collect();
        println!("RESULT {} face={:?} notes={:?}\n  {}\n  {} frames, about {:.1} s", out.summary, out.face, out.notes, named.join(", "), r.grabs, r.ms as f64 / 1000.0);
        write_ppm(&r.frame(), &format!("{}/replay-result.ppm", dir));
        println!("LOOK {}", out.look.json());
        // The same room with the hoodie in another colour: the look stays (within a small margin)
        let base = r.recs.iter().find(|x| x.file.contains("042-")).unwrap().pic.clone();
        let f = find_face(&base, 90).unwrap();
        let body = body_of(&base, f, 90);
        let mut green = base.clone();
        for px in green.rgb.chunks_mut(3) {
            if px[0] as f64 > px[1] as f64 * 1.4 && px[0] > 40 {
                px.swap(0, 1); // reddish (the hoodie, skin) turned greenish
            }
        }
        let (a, b) = (look_of(&base, Some(body)), look_of(&green, Some(body)));
        let (a0, b0) = (look_of(&base, None), look_of(&green, None));
        println!("hoodie red/green: with the person left out r {:.3}/{:.3} b {:.3}/{:.3}; whole picture r {:.3}/{:.3} b {:.3}/{:.3}; body {:?}",
            a.r, b.r, a.b, b.b, a0.r, b0.r, a0.b, b0.b, body);
        assert!((a.r - b.r).abs() < 0.03 && (a.b - b.b).abs() < 0.03);
        write_ppm(&out.look.render(&r.frame()), &format!("{}/replay-result-look.ppm", dir));
        assert!(out.face.is_some(), "the face is in every recorded frame");
        let b = out.summary["brightness"].as_f64().unwrap();
        assert!((b - FACE_TARGET).abs() <= 2.0 * TOLERANCE, "face brightness {} for a target of {}", b, FACE_TARGET);
    }
}
