//! autoglow_core: AutoGlow 2's optional Rust LED engine.
//!
//! core/wled_driver.py imports it when it is installed (and its API_VERSION matches) and otherwise
//! keeps using the Python loop. Effects and scene snapshots cross the boundary as plain dicts built
//! by WLEDDriver._rust_effect / _rust_scene.

use pyo3::prelude::*;
use pyo3::types::PyBytes;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

mod effects;
mod engine;
mod flow;
mod pyrandom;

use effects::{Anim, Effect, FireState, Rgb};
use flow::FlowOpts;

/// Bumped whenever the dict layout or the methods Python relies on change; an older build is then
/// ignored and AutoGlow uses its Python engine until setup rebuilds this module
const API_VERSION: u32 = 2;

type Color = (i64, i64, i64);

fn rgb(c: Color) -> Rgb {
    Rgb { r: c.0, g: c.1, b: c.2 }
}

#[derive(FromPyObject)]
struct PyEffect {
    #[pyo3(item)]
    animation: String,
    #[pyo3(item)]
    color_primary: Color,
    #[pyo3(item)]
    color_secondary: Color,
    #[pyo3(item)]
    dynamic_secondary: bool,
    #[pyo3(item)]
    duration: f64,
    #[pyo3(item)]
    speed: f64,
    #[pyo3(item)]
    reverse: bool,
    #[pyo3(item)]
    brightness: Option<i64>,
    #[pyo3(item)]
    transition: String,
    #[pyo3(item)]
    transition_duration: f64,
    #[pyo3(item)]
    options: Option<PyFlowOpts>,
}

/// EffectConfig.options after normalize_options, every key filled in
#[derive(FromPyObject)]
struct PyFlowOpts {
    #[pyo3(item)]
    pulses: i64,
    #[pyo3(item)]
    comets: i64,
    #[pyo3(item)]
    tail: String,
    #[pyo3(item)]
    sides: String,
    #[pyo3(item)]
    palette: String,
    #[pyo3(item)]
    amount: String,
}

impl From<PyEffect> for Effect {
    fn from(p: PyEffect) -> Effect {
        Effect {
            anim: Anim::parse(&p.animation),
            flow: p.options.map(|o| FlowOpts {
                pulses: o.pulses,
                comets: o.comets,
                tail: o.tail,
                sides: o.sides,
                palette: o.palette,
                amount: o.amount,
            }),
            name: p.animation,
            c1: rgb(p.color_primary),
            c2: rgb(p.color_secondary),
            dynamic_secondary: p.dynamic_secondary,
            duration: p.duration,
            speed: p.speed,
            reverse: p.reverse,
            brightness: p.brightness,
            transition: p.transition,
            transition_duration: p.transition_duration,
        }
    }
}

#[derive(FromPyObject)]
struct PyChannel {
    #[pyo3(item)]
    id: i64,
    #[pyo3(item)]
    start: i64,
    #[pyo3(item)]
    stop: i64,
    #[pyo3(item)]
    offset: i64,
    #[pyo3(item)]
    baseline: Option<PyEffect>,
    #[pyo3(item)]
    baseline_start: f64,
    #[pyo3(item)]
    transient: Option<PyEffect>,
    #[pyo3(item)]
    transient_start: f64,
    #[pyo3(item)]
    transient_duration: f64,
    #[pyo3(item)]
    last_color: Option<Color>,
    #[pyo3(item)]
    flow: bool,
    #[pyo3(item)]
    flow_session: i64,
    #[pyo3(item)]
    fade: Option<PyFade>,
    #[pyo3(item)]
    overlay: Option<PyOverlay>,
    #[pyo3(item)]
    locator: Option<PyLocator>,
}

#[derive(FromPyObject)]
struct PyFade {
    #[pyo3(item)]
    start: f64,
    #[pyo3(item)]
    duration: f64,
    #[pyo3(item)]
    style: String,
    #[pyo3(item)]
    accent: Option<(u8, u8, u8)>,
    #[pyo3(item)]
    frame: Option<Vec<u8>>,
    #[pyo3(item)]
    effect: Option<PyEffect>,
    #[pyo3(item)]
    effect_start: f64,
}

#[derive(FromPyObject)]
struct PyOverlay {
    #[pyo3(item)]
    start: f64,
    #[pyo3(item)]
    duration: f64,
    #[pyo3(item)]
    strength: f64,
    #[pyo3(item)]
    layer: PyEffect,
    #[pyo3(item)]
    mask: PyEffect,
    #[pyo3(item)]
    brightness: Option<i64>,
}

#[derive(FromPyObject)]
struct PyLocator {
    #[pyo3(item)]
    start: f64,
    #[pyo3(item)]
    duration: f64,
    #[pyo3(item)]
    position: f64,
    #[pyo3(item)]
    color: Color,
}

#[derive(FromPyObject)]
struct PyScene {
    #[pyo3(item)]
    targets: Vec<String>,
    #[pyo3(item)]
    port: u16,
    #[pyo3(item)]
    total: usize,
    #[pyo3(item)]
    pwm_indices: Vec<i64>,
    #[pyo3(item)]
    pwm_value: u8,
    #[pyo3(item)]
    channels: Vec<PyChannel>,
}

impl From<PyScene> for engine::Scene {
    fn from(p: PyScene) -> engine::Scene {
        engine::Scene {
            targets: p.targets,
            port: p.port,
            total: p.total,
            pwm_indices: p.pwm_indices,
            pwm_value: p.pwm_value,
            channels: p
                .channels
                .into_iter()
                .map(|c| engine::Channel {
                    id: c.id,
                    start: c.start,
                    stop: c.stop,
                    offset: c.offset,
                    baseline: c.baseline.map(Effect::from),
                    baseline_start: c.baseline_start,
                    transient: c.transient.map(Effect::from),
                    transient_start: c.transient_start,
                    transient_duration: c.transient_duration,
                    last_color: c.last_color.map(rgb),
                    flow: c.flow,
                    flow_session: c.flow_session,
                    fade: c.fade.map(|f| engine::Fade {
                        start: f.start,
                        duration: f.duration,
                        style: f.style,
                        accent: f.accent,
                        frame: f.frame,
                        effect: f.effect.map(Effect::from),
                        effect_start: f.effect_start,
                    }),
                    overlay: c.overlay.map(|o| engine::Overlay {
                        start: o.start,
                        duration: o.duration,
                        strength: o.strength,
                        layer: Effect::from(o.layer),
                        mask: Effect::from(o.mask),
                        brightness: o.brightness,
                    }),
                    locator: c.locator.map(|l| engine::Locator {
                        start: l.start,
                        duration: l.duration,
                        position: l.position,
                        color: rgb(l.color),
                    }),
                })
                .collect(),
        }
    }
}

/// Fire's heat buffer for render(), shared by all calls like fire.py's module-level buffer
static FIRE: Mutex<FireState> = Mutex::new(FireState::new());

fn color_out(c: Rgb) -> Color {
    (c.r, c.g, c.b)
}

/// render_animation_frame(effect, frame, elapsed, count) -> bytes
#[pyfunction]
fn render(py: Python<'_>, effect: PyEffect, frame: i64, elapsed: f64, count: usize) -> Py<PyBytes> {
    let e = Effect::from(effect);
    let out = py.allow_threads(|| {
        let mut fire = FIRE.lock().unwrap_or_else(|p| p.into_inner());
        effects::render(&e, frame, elapsed, count, &mut fire)
    });
    PyBytes::new(py, &out).unbind()
}

/// Clear render()'s Fire buffer (tests reset fire.py's buffer the same way)
#[pyfunction]
fn reset_fire() {
    *FIRE.lock().unwrap_or_else(|p| p.into_inner()) = FireState::new();
}

/// blend_frames(a, b, factor, transition, accent) -> bytes
#[pyfunction]
#[pyo3(signature = (a, b, factor, transition = "crossfade", accent = None))]
fn blend(py: Python<'_>, a: &[u8], b: &[u8], factor: f64, transition: &str, accent: Option<(u8, u8, u8)>) -> Py<PyBytes> {
    let out = effects::blend(a, b, factor, transition, accent);
    PyBytes::new(py, &out).unbind()
}

type ComposeOut = (Py<PyBytes>, bool, HashMap<i64, Color>, HashMap<i64, Py<PyBytes>>);

/// One frame of the broadcast loop for a scene, without sending it: (rgb bytes, any segment active,
/// {segment: last active colour recorded by SOLID}, {segment: Flow look picture (last_base)})
#[pyfunction]
#[pyo3(signature = (scene, frame, now, last_colors = None))]
fn compose(py: Python<'_>, scene: PyScene, frame: i64, now: f64, last_colors: Option<HashMap<i64, Color>>) -> ComposeOut {
    let scene = engine::Scene::from(scene);
    let lc: HashMap<i64, Rgb> = last_colors.unwrap_or_default().into_iter().map(|(k, v)| (k, rgb(v))).collect();
    let mut fire = FIRE.lock().unwrap_or_else(|p| p.into_inner());
    let out = engine::compose(&scene, frame, now, &mut fire, &lc);
    let updates = out.solid_updates.into_iter().map(|(k, c)| (k, color_out(c))).collect();
    let bases = out.last_bases.into_iter().map(|(k, _, b)| (k, PyBytes::new(py, &b).unbind())).collect();
    (PyBytes::new(py, &out.buf).unbind(), out.any_active, updates, bases)
}

/// blend_flow(a, b, factor, style, accent, reverse) -> bytes (style already normalized)
#[pyfunction]
#[pyo3(signature = (a, b, factor, style = "crossfade", accent = None, reverse = false))]
fn blend_flow(py: Python<'_>, a: &[u8], b: &[u8], factor: f64, style: &str, accent: Option<(u8, u8, u8)>, reverse: bool) -> Py<PyBytes> {
    PyBytes::new(py, &flow::blend_flow(a, b, factor, style, accent, reverse)).unbind()
}

/// The UDP packets of one frame (DRGB, or DNRGB for more than 490 LEDs)
#[pyfunction]
fn udp_packets(py: Python<'_>, rgb_bytes: &[u8]) -> Vec<Py<PyBytes>> {
    engine::udp_packets(rgb_bytes).into_iter().map(|p| PyBytes::new(py, &p).unbind()).collect()
}

/// The LED stream of one WLED driver, rendered and sent on its own thread
#[pyclass(module = "autoglow_core")]
struct LedEngine {
    shared: Arc<engine::Shared>,
}

#[pymethods]
impl LedEngine {
    #[new]
    fn new() -> Self {
        LedEngine { shared: engine::Shared::new() }
    }

    /// Replace the scene the thread renders from (it does not start the thread)
    fn update(&self, scene: PyScene) {
        self.shared.update(engine::Scene::from(scene));
    }

    /// Start the thread unless it runs; True when it was started
    fn ensure_running(&self) -> bool {
        self.shared.ensure_running()
    }

    /// Stop sending. Returns at once; the thread ends within a frame.
    fn stop(&self) {
        self.shared.stop();
    }

    /// False once stopped, or when the thread ended by itself because no segment was active
    #[getter]
    fn running(&self) -> bool {
        self.shared.running()
    }

    /// The newest frame (rgb bytes without the DRGB header) if one was sent since the last call
    fn take_frame(&self, py: Python<'_>) -> Option<Py<PyBytes>> {
        self.shared.take_frame().map(|f| PyBytes::new(py, &f).unbind())
    }

    /// {segment id: (r, g, b)} recorded since the last call (SOLID segments' last active colour)
    fn take_last_colors(&self) -> HashMap<i64, Color> {
        self.shared.take_last_colors().into_iter().map(|(k, c)| (k, color_out(c))).collect()
    }

    /// The look picture a Flow segment showed last (WLEDDriver ch["last_base"]), None when it has none
    /// in this flow session
    fn last_base(&self, py: Python<'_>, segment_id: i64, session: i64) -> Option<Py<PyBytes>> {
        self.shared.last_base(segment_id, session).map(|b| PyBytes::new(py, &b).unbind())
    }

    /// Warnings for the AutoGlow log since the last call (rate-limited send failures)
    fn take_errors(&self) -> Vec<String> {
        self.shared.take_errors()
    }

    /// Frame timing: frames, late_2ms/5ms/10ms (start of a frame off its 20 ms slot by more
    /// than that), max_dev_ms, compute_avg_us, compute_max_us, dropped_packets
    #[pyo3(signature = (reset = false))]
    fn stats(&self, reset: bool) -> HashMap<&'static str, f64> {
        let s = self.shared.stats(reset);
        let mut m = HashMap::new();
        m.insert("frames", s.frames as f64);
        m.insert("late_2ms", s.late_2ms as f64);
        m.insert("late_5ms", s.late_5ms as f64);
        m.insert("late_10ms", s.late_10ms as f64);
        m.insert("max_dev_ms", s.max_dev_ms);
        m.insert("compute_avg_us", if s.frames > 0 { s.compute_total_us / s.frames as f64 } else { 0.0 });
        m.insert("compute_max_us", s.compute_max_us);
        m.insert("dropped_packets", s.dropped_packets as f64);
        m
    }
}

impl Drop for LedEngine {
    fn drop(&mut self) {
        self.shared.stop();
    }
}

#[pymodule]
fn autoglow_core(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("API_VERSION", API_VERSION)?;
    m.add("__version__", env!("CARGO_PKG_VERSION"))?;
    m.add("FPS", engine::FPS)?;
    m.add_function(wrap_pyfunction!(render, m)?)?;
    m.add_function(wrap_pyfunction!(reset_fire, m)?)?;
    m.add_function(wrap_pyfunction!(blend, m)?)?;
    m.add_function(wrap_pyfunction!(compose, m)?)?;
    m.add_function(wrap_pyfunction!(blend_flow, m)?)?;
    m.add_function(wrap_pyfunction!(udp_packets, m)?)?;
    m.add_class::<LedEngine>()?;
    Ok(())
}
