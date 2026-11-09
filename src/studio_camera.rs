//! Studio cameras: USB cameras on the AutoGlow computer (Linux V4L2, MJPEG mode) and the cameras the
//! Autodarts Board Manager streams, shared as MJPEG so the Studio output can be shown on any device.
//!
//! The camera already sends JPEG frames, so nothing is decoded or re-encoded. A camera is opened when its
//! first viewer connects and closed shortly after the last one leaves.

use crate::py::*;
use log::{debug, info, warn};
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const SYS_DIR: &str = "/sys/class/video4linux";
const BY_PATH_DIR: &str = "/dev/v4l/by-path";
pub const RESOLUTIONS: [(&str, (u32, u32)); 3] = [("480p", (848, 480)), ("720p", (1280, 720)), ("1080p", (1920, 1080))];
const FPS: u32 = 30;
const BUFFER_COUNT: u32 = 4;
const CLOSE_AFTER_SECONDS: u64 = 10;
pub const FIRST_FRAME_TIMEOUT: f64 = 6.0;
pub const MAX_DELAY: f64 = 5.0;
pub const BOARD_MANAGER_URL: &str = "http://127.0.0.1:3180";
pub const RELAY_FPS: [i64; 3] = [10, 15, 30];
const FRAME_JITTER: f64 = 0.012;
const MAX_CONTROLS: usize = 64;
pub const AUTODARTS_STOPPED: &str = "Autodarts is stopped \u{2013} its cameras stream only while it runs";

fn re(cell: &'static OnceLock<Regex>, p: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(p).unwrap())
}
static ID_RE: OnceLock<Regex> = OnceLock::new();
static VIDEO_RE: OnceLock<Regex> = OnceLock::new();
static DEV_RE: OnceLock<Regex> = OnceLock::new();
static AD_RE: OnceLock<Regex> = OnceLock::new();
static PORT_RE: OnceLock<Regex> = OnceLock::new();

pub fn wall() -> f64 {
    crate::led_thread::wall()
}

// --- V4L2 (linux/videodev2.h) ------------------------------------------------------------------

#[cfg(target_os = "linux")]
mod v4l2 {
    pub const BUF_TYPE_VIDEO_CAPTURE: u32 = 1;
    pub const MEMORY_MMAP: u32 = 1;
    pub const CAP_VIDEO_CAPTURE: u32 = 0x1;
    pub const CAP_DEVICE_CAPS: u32 = 0x8000_0000;
    pub const PIX_FMT_MJPEG: u32 = u32::from_le_bytes(*b"MJPG");

    #[repr(C)]
    pub struct Capability {
        pub driver: [u8; 16],
        pub card: [u8; 32],
        pub bus_info: [u8; 32],
        pub version: u32,
        pub capabilities: u32,
        pub device_caps: u32,
        pub reserved: [u32; 3],
    }
    #[repr(C)]
    pub struct FmtDesc {
        pub index: u32,
        pub type_: u32,
        pub flags: u32,
        pub description: [u8; 32],
        pub pixelformat: u32,
        pub mbus_code: u32,
        pub reserved: [u32; 3],
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct PixFormat {
        pub width: u32,
        pub height: u32,
        pub pixelformat: u32,
        pub field: u32,
        pub bytesperline: u32,
        pub sizeimage: u32,
        pub colorspace: u32,
        pub priv_: u32,
        pub flags: u32,
        pub ycbcr_enc: u32,
        pub quantization: u32,
        pub xfer_func: u32,
    }
    #[repr(C)]
    pub union FormatUnion {
        pub pix: PixFormat,
        pub raw: [u8; 200],
        pub _align: *mut libc::c_void,
    }
    #[repr(C)]
    pub struct Format {
        pub type_: u32,
        pub fmt: FormatUnion,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct CaptureParm {
        pub capability: u32,
        pub capturemode: u32,
        pub numerator: u32,
        pub denominator: u32,
        pub extendedmode: u32,
        pub readbuffers: u32,
        pub reserved: [u32; 4],
    }
    #[repr(C)]
    pub union ParmUnion {
        pub capture: CaptureParm,
        pub raw: [u8; 200],
    }
    #[repr(C)]
    pub struct StreamParm {
        pub type_: u32,
        pub parm: ParmUnion,
    }
    #[repr(C)]
    pub struct RequestBuffers {
        pub count: u32,
        pub type_: u32,
        pub memory: u32,
        pub capabilities: u32,
        pub flags: u8,
        pub reserved: [u8; 3],
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct Timecode {
        pub type_: u32,
        pub flags: u32,
        pub frames: u8,
        pub seconds: u8,
        pub minutes: u8,
        pub hours: u8,
        pub userbits: [u8; 4],
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub union BufferM {
        pub offset: u32,
        pub userptr: libc::c_ulong,
        pub planes: *mut libc::c_void,
        pub fd: i32,
    }
    #[repr(C)]
    pub struct Buffer {
        pub index: u32,
        pub type_: u32,
        pub bytesused: u32,
        pub flags: u32,
        pub field: u32,
        pub timestamp: libc::timeval,
        pub timecode: Timecode,
        pub sequence: u32,
        pub memory: u32,
        pub m: BufferM,
        pub length: u32,
        pub reserved2: u32,
        pub request_fd: i32,
    }
    #[repr(C)]
    pub struct QueryCtrl {
        pub id: u32,
        pub type_: u32,
        pub name: [u8; 32],
        pub minimum: i32,
        pub maximum: i32,
        pub step: i32,
        pub default_value: i32,
        pub flags: u32,
        pub reserved: [u32; 2],
    }
    #[repr(C, packed)]
    pub struct QueryMenu {
        pub id: u32,
        pub index: u32,
        pub u: [u8; 32],
        pub reserved: u32,
    }
    #[repr(C)]
    pub struct Control {
        pub id: u32,
        pub value: i32,
    }

    const fn ioc(dir: u64, nr: u64, size: usize) -> u64 {
        (dir << 30) | ((size as u64) << 16) | ((b'V' as u64) << 8) | nr
    }
    const R: u64 = 2;
    const W: u64 = 1;
    const RW: u64 = 3;
    pub const QUERYCAP: u64 = ioc(R, 0, std::mem::size_of::<Capability>());
    pub const ENUM_FMT: u64 = ioc(RW, 2, std::mem::size_of::<FmtDesc>());
    pub const S_FMT: u64 = ioc(RW, 5, std::mem::size_of::<Format>());
    pub const REQBUFS: u64 = ioc(RW, 8, std::mem::size_of::<RequestBuffers>());
    pub const QUERYBUF: u64 = ioc(RW, 9, std::mem::size_of::<Buffer>());
    pub const QBUF: u64 = ioc(RW, 15, std::mem::size_of::<Buffer>());
    pub const DQBUF: u64 = ioc(RW, 17, std::mem::size_of::<Buffer>());
    pub const STREAMON: u64 = ioc(W, 18, std::mem::size_of::<i32>());
    pub const STREAMOFF: u64 = ioc(W, 19, std::mem::size_of::<i32>());
    pub const S_PARM: u64 = ioc(RW, 22, std::mem::size_of::<StreamParm>());
    pub const G_CTRL: u64 = ioc(RW, 27, std::mem::size_of::<Control>());
    pub const S_CTRL: u64 = ioc(RW, 28, std::mem::size_of::<Control>());
    pub const QUERYCTRL: u64 = ioc(RW, 36, std::mem::size_of::<QueryCtrl>());
    pub const QUERYMENU: u64 = ioc(RW, 37, std::mem::size_of::<QueryMenu>());

    /// ioctl with an errno result
    pub unsafe fn ioctl<T>(fd: i32, req: u64, arg: *mut T) -> std::io::Result<()> {
        if libc::ioctl(fd, req as _, arg) < 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    pub fn cstr(b: &[u8]) -> String {
        let end = b.iter().position(|c| *c == 0).unwrap_or(b.len());
        String::from_utf8_lossy(&b[..end]).into_owned()
    }

    pub fn zeroed<T>() -> T {
        unsafe { std::mem::zeroed() }
    }
}

// --- JPEG: cameras often leave out the Huffman tables; add the standard ones (JPEG Annex K.3) --

const AC_LUMA_HEAD: [u8; 98] = [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xA1, 0x08,
    0x23, 0x42, 0xB1, 0xC1, 0x15, 0x52, 0xD1, 0xF0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0A, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2A, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4A, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
    0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8A, 0x92,
];
const AC_CHROMA_HEAD: [u8; 91] = [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
    0xA1, 0xB1, 0xC1, 0x09, 0x23, 0x33, 0x52, 0xF0, 0x15, 0x62, 0x72, 0xD1, 0x0A, 0x16, 0x24, 0x34, 0xE1, 0x25, 0xF1, 0x17, 0x18, 0x19, 0x1A, 0x26,
    0x27, 0x28, 0x29, 0x2A, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4A, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
    0x59, 0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x82,
];

/// Standard AC symbol order: the listed leading symbols, then every other run/size code in order
fn ac_values(head: &[u8]) -> Vec<u8> {
    let mut v = head.to_vec();
    for r in 0..16u8 {
        for s in 1..11u8 {
            let c = r << 4 | s;
            if !head.contains(&c) {
                v.push(c);
            }
        }
    }
    v
}

fn dht_segment() -> &'static [u8] {
    static S: OnceLock<Vec<u8>> = OnceLock::new();
    S.get_or_init(|| {
        let dc: Vec<u8> = (0..12).collect();
        let tables: [(u8, [u8; 16], Vec<u8>); 4] = [
            (0x00, [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], dc.clone()),
            (0x10, [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7D], ac_values(&AC_LUMA_HEAD)),
            (0x01, [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], dc),
            (0x11, [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77], ac_values(&AC_CHROMA_HEAD)),
        ];
        let mut body = Vec::new();
        for (tc, bits, vals) in tables {
            body.push(tc);
            body.extend(bits);
            body.extend(vals);
        }
        let mut out = vec![0xff, 0xc4];
        out.extend(((body.len() + 2) as u16).to_be_bytes());
        out.extend(body);
        out
    })
}

fn find(h: &[u8], n: &[u8], from: usize, to: usize) -> Option<usize> {
    let to = to.min(h.len());
    if from >= to || n.len() > to - from {
        return None;
    }
    (from..=to - n.len()).find(|i| &h[*i..*i + n.len()] == n)
}

/// Make a camera MJPEG frame a complete JPEG every browser can show
pub fn ensure_huffman_tables(frame: Vec<u8>) -> Vec<u8> {
    if !frame.starts_with(&[0xff, 0xd8]) {
        return frame;
    }
    let Some(sos) = find(&frame, &[0xff, 0xda], 0, frame.len()) else { return frame };
    if find(&frame, &[0xff, 0xc4], 2, sos).is_some() {
        return frame;
    }
    let mut out = Vec::with_capacity(frame.len() + 432);
    out.extend_from_slice(&frame[..2]);
    out.extend_from_slice(dht_segment());
    out.extend_from_slice(&frame[2..]);
    out
}

// --- Camera list -------------------------------------------------------------------------------

/// /dev/videoN -> USB port name, which stays the same across reboots
fn stable_ids() -> HashMap<String, String> {
    let mut ids = HashMap::new();
    let Ok(rd) = std::fs::read_dir(BY_PATH_DIR) else { return ids };
    let mut names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
    names.sort();
    for n in names {
        if n.contains("-usbv2-") {
            continue;
        }
        if let Ok(t) = std::fs::canonicalize(format!("{}/{}", BY_PATH_DIR, n)) {
            ids.entry(t.to_string_lossy().to_string()).or_insert(n);
        }
    }
    ids
}

#[cfg(target_os = "linux")]
fn open_dev(dev: &str) -> std::io::Result<i32> {
    let c = std::ffi::CString::new(dev).map_err(|_| std::io::Error::from_raw_os_error(libc::EINVAL))?;
    let fd = unsafe { libc::open(c.as_ptr(), libc::O_RDWR | libc::O_NONBLOCK | libc::O_CLOEXEC) };
    if fd < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(fd)
    }
}

/// Name and bus of a capture node that can deliver MJPEG
#[cfg(target_os = "linux")]
fn query(dev: &str) -> Option<(String, String)> {
    use v4l2::*;
    let fd = open_dev(dev).ok()?;
    let res = (|| unsafe {
        let mut cap: Capability = zeroed();
        ioctl(fd, QUERYCAP, &mut cap).ok()?;
        let caps = if cap.capabilities & CAP_DEVICE_CAPS != 0 { cap.device_caps } else { cap.capabilities };
        if caps & CAP_VIDEO_CAPTURE == 0 {
            return None;
        }
        for i in 0..32 {
            let mut d: FmtDesc = zeroed();
            d.index = i;
            d.type_ = BUF_TYPE_VIDEO_CAPTURE;
            ioctl(fd, ENUM_FMT, &mut d).ok()?;
            if d.pixelformat == PIX_FMT_MJPEG {
                return Some((cstr(&cap.card), cstr(&cap.bus_info)));
            }
        }
        None
    })();
    unsafe { libc::close(fd) };
    res
}

#[cfg(not(target_os = "linux"))]
fn query(_dev: &str) -> Option<(String, String)> {
    None
}

fn port_label(id: &str) -> String {
    re(&PORT_RE, r"usb-\d+:([\d.]+):").captures(id).map(|c| format!("USB port {}", &c[1])).unwrap_or_else(|| id.into())
}

/// Cameras on this computer that can be streamed: [{id, name, device}]
pub fn list_cameras() -> Vec<Value> {
    let Ok(rd) = std::fs::read_dir(SYS_DIR) else { return Vec::new() };
    let stable = stable_ids();
    let mut nodes: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
    nodes.sort_by_key(|n| n.chars().filter(|c| c.is_ascii_digit()).collect::<String>().parse::<i64>().unwrap_or(0));
    let mut out = Vec::new();
    for n in nodes.into_iter().filter(|n| n.starts_with("video")) {
        let dev = format!("/dev/{}", n);
        let Some((card, _bus)) = query(&dev) else { continue };
        let id = stable.get(&dev).cloned().unwrap_or(n);
        out.push(json!({"id": id, "name": format!("{} ({})", card, port_label(&id)), "device": dev}));
    }
    out
}

/// /dev/videoN for a camera id from list_cameras()
pub fn resolve_device(id: &str) -> Option<String> {
    if !re(&ID_RE, r"^[A-Za-z0-9:._-]{1,120}$").is_match(id) || id.trim_matches('.').is_empty() {
        return None;
    }
    let p = if re(&VIDEO_RE, r"^video\d+$").is_match(id) { format!("/dev/{}", id) } else { format!("{}/{}", BY_PATH_DIR, id) };
    let real = std::fs::canonicalize(&p).ok()?.to_string_lossy().to_string();
    (re(&DEV_RE, r"^/dev/video\d+$").is_match(&real) && std::path::Path::new(&real).exists()).then_some(real)
}

// --- Picture controls (what `v4l2-ctl -L` shows) -----------------------------------------------

/// Saved control values {"<control id>": value} from untrusted settings
pub fn clean_control_values(raw: Option<&Value>) -> Obj {
    let mut out = Obj::new();
    if let Some(r) = raw.and_then(Value::as_object) {
        for (k, v) in r.iter().take(MAX_CONTROLS) {
            if !k.is_empty() && k.chars().all(|c| c.is_ascii_digit()) && v.is_i64() {
                out.insert(k.clone(), json!(v.as_i64().unwrap().clamp(i32::MIN as i64, i32::MAX as i64)));
            }
        }
    }
    out
}

#[cfg(target_os = "linux")]
fn query_controls(fd: i32) -> Vec<Value> {
    use v4l2::*;
    const NEXT: u32 = 0x8000_0000;
    let mut out = Vec::new();
    let mut qc: QueryCtrl = zeroed();
    qc.id = NEXT;
    let mut tries = 0;
    while tries < MAX_CONTROLS * 2 {
        tries += 1;
        if unsafe { ioctl(fd, QUERYCTRL, &mut qc) }.is_err() {
            break;
        }
        let kind = match qc.type_ {
            1 => Some("int"),
            2 => Some("bool"),
            3 | 9 => Some("menu"),
            _ => None,
        };
        if let Some(kind) = kind {
            if qc.flags & (0x01 | 0x04 | 0x40) == 0 {
                let mut c = crate::obj! {
                    "id" => qc.id, "name" => cstr(&qc.name), "type" => kind, "min" => qc.minimum, "max" => qc.maximum,
                    "step" => if qc.step == 0 { 1 } else { qc.step }, "default" => qc.default_value, "inactive" => qc.flags & 0x10 != 0,
                    "value" => qc.default_value,
                };
                if kind == "menu" {
                    let mut menu = Vec::new();
                    for idx in qc.minimum.max(0)..=qc.maximum {
                        let mut qm: QueryMenu = zeroed();
                        qm.id = qc.id;
                        qm.index = idx as u32;
                        if unsafe { ioctl(fd, QUERYMENU, &mut qm) }.is_err() {
                            continue;
                        }
                        let u = qm.u;
                        let label = if qc.type_ == 9 { i64::from_le_bytes(u[..8].try_into().unwrap()).to_string() } else { cstr(&u) };
                        menu.push(json!({"value": idx, "label": label}));
                    }
                    c.insert("menu".into(), json!(menu));
                }
                let mut ctl = Control { id: qc.id, value: 0 };
                if unsafe { ioctl(fd, G_CTRL, &mut ctl) }.is_ok() {
                    c.insert("value".into(), json!(ctl.value));
                }
                out.push(Value::Object(c));
            }
        }
        let id = qc.id;
        qc = zeroed();
        qc.id = id | NEXT;
    }
    out.truncate(MAX_CONTROLS);
    out
}

/// Set controls (switches first, so the manual values they unlock can follow); returns refused names
#[cfg(target_os = "linux")]
fn set_controls_fd(fd: i32, values: &[(u32, i32)]) -> Vec<String> {
    let known: HashMap<u32, Value> = query_controls(fd).into_iter().map(|c| (c["id"].as_u64().unwrap_or(0) as u32, c)).collect();
    let mut order: Vec<(u32, i32)> = values.iter().copied().filter(|(id, _)| known.contains_key(id)).collect();
    order.sort_by_key(|(id, _)| known[id]["type"] == json!("int"));
    let mut failed = Vec::new();
    for (id, v) in order {
        let c = &known[&id];
        let val = (v as i64).clamp(c["min"].as_i64().unwrap_or(i64::MIN), c["max"].as_i64().unwrap_or(i64::MAX)) as i32;
        let mut ctl = v4l2::Control { id, value: val };
        if let Err(e) = unsafe { v4l2::ioctl(fd, v4l2::S_CTRL, &mut ctl) } {
            let name = py_str(&c["name"]);
            debug!("Camera control {}={} refused: {}", name, val, e);
            failed.push(name);
        }
    }
    failed
}

#[cfg(target_os = "linux")]
pub fn get_controls(device: &str) -> std::io::Result<Vec<Value>> {
    let fd = open_dev(device)?;
    let c = query_controls(fd);
    unsafe { libc::close(fd) };
    Ok(c)
}

#[cfg(target_os = "linux")]
pub fn set_controls(device: &str, values: &[(u32, i32)]) -> std::io::Result<Value> {
    let fd = open_dev(device)?;
    let failed = set_controls_fd(fd, values);
    let c = query_controls(fd);
    unsafe { libc::close(fd) };
    Ok(json!({"controls": c, "failed": failed}))
}

#[cfg(not(target_os = "linux"))]
pub fn get_controls(_d: &str) -> std::io::Result<Vec<Value>> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "no V4L2"))
}
#[cfg(not(target_os = "linux"))]
pub fn set_controls(_d: &str, _v: &[(u32, i32)]) -> std::io::Result<Value> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "no V4L2"))
}

// --- Autodarts Board Manager cameras -----------------------------------------------------------

pub fn autodarts_stream_url(id: &str) -> Option<String> {
    let c = re(&AD_RE, r"^autodarts:(\d|live)$").captures(id)?;
    let w = &c[1];
    Some(if w == "live" { format!("{}/api/streams/live", BOARD_MANAGER_URL) } else { format!("{}/api/streams/cams/{}", BOARD_MANAGER_URL, w) })
}

/// Detection state of the Board Manager ({running, status}), or None when it is not reachable
pub fn board_manager_state() -> Option<Value> {
    let s = crate::http::get_json(&format!("{}/api/state", BOARD_MANAGER_URL), 2.0).ok()?;
    let o = s.as_object()?;
    Some(json!({"running": get_bool(o, "running", false), "status": o.get("status").map(py_str).unwrap_or_default()}))
}

/// Ask the Board Manager to start detection, like its own Start button (only on request)
pub fn start_board_manager() -> Option<Value> {
    let r = ureq::AgentBuilder::new().timeout(Duration::from_secs(15)).build().put(&format!("{}/api/start", BOARD_MANAGER_URL)).call();
    match r {
        Ok(_) => {}
        Err(ureq::Error::Status(c, _)) => warn!("Board Manager refused to start ({})", c),
        Err(e) => {
            warn!("Board Manager not reachable for start: {}", e);
            return None;
        }
    }
    board_manager_state()
}

/// Cameras the Board Manager streams, or [] when it is not running on this computer
pub fn list_autodarts_cameras() -> Vec<Value> {
    let Ok(stats) = crate::http::get_json(&format!("{}/api/cams/stats", BOARD_MANAGER_URL), 1.5) else { return Vec::new() };
    let fps = arr(stats.get("fps"));
    if fps.is_empty() {
        return Vec::new();
    }
    let r = stats.get("resolution").cloned().unwrap_or(json!({}));
    let size = if r.get("width").map_or(false, truthy) { format!("{}x{}", py_str(&r["width"]), r.get("height").map(py_str).unwrap_or_default()) } else { String::new() };
    let mut cams: Vec<Value> = (0..fps.len())
        .map(|i| json!({"id": format!("autodarts:{}", i), "name": format!("Autodarts camera {}{}", i + 1, if size.is_empty() { String::new() } else { format!(" ({})", size) }), "source": "autodarts"}))
        .collect();
    if fps.len() > 1 {
        cams.push(json!({"id": "autodarts:live", "name": "All Autodarts cameras side by side", "source": "autodarts"}));
    }
    cams
}

/// Which cameras the Board Manager uses for dart detection (their USB locations)
pub fn board_manager_camera_locations() -> Vec<String> {
    let Ok(d) = crate::http::get_json(&format!("{}/api/config", BOARD_MANAGER_URL), 1.5) else { return Vec::new() };
    arr(d.get("cam").and_then(|c| c.get("cams"))).iter().filter_map(Value::as_str).filter_map(|c| c.split_once("location=").map(|(_, l)| l.to_string())).collect()
}

// --- Frame sources -----------------------------------------------------------------------------

struct FsState {
    frame: Option<Arc<Vec<u8>>>,
    seq: u64,
    error: String,
    history: VecDeque<(f64, u64, Arc<Vec<u8>>)>,
    keep_seconds: f64,
}

/// Newest JPEG frame of one camera; viewers wait for the next one
pub struct FrameSource {
    pub cam_id: String,
    /// What the source was opened with (size or relay fps); a change reopens it
    variant: String,
    st: Mutex<FsState>,
    tick: tokio::sync::watch::Sender<u64>,
    pub viewers: AtomicUsize,
    close_gen: AtomicUsize,
    stop: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    retry: Mutex<Option<std::sync::mpsc::Sender<()>>>,
    /// Errors that clear up on their own (a reconnecting relay) keep the source; others reopen it
    retry_on_acquire: bool,
}

impl FrameSource {
    fn new(cam_id: &str, variant: String, retry_on_acquire: bool) -> Arc<FrameSource> {
        let (tx, _) = tokio::sync::watch::channel(0);
        Arc::new(FrameSource {
            cam_id: cam_id.into(),
            variant,
            st: Mutex::new(FsState { frame: None, seq: 0, error: String::new(), history: VecDeque::new(), keep_seconds: 0.0 }),
            tick: tx,
            viewers: AtomicUsize::new(0),
            close_gen: AtomicUsize::new(0),
            stop: Arc::new(AtomicBool::new(false)),
            alive: Arc::new(AtomicBool::new(true)),
            retry: Mutex::new(None),
            retry_on_acquire,
        })
    }

    fn publish(&self, frame: Vec<u8>) {
        let mut s = self.st.lock().unwrap();
        let f = Arc::new(frame);
        s.frame = Some(Arc::clone(&f));
        s.seq += 1;
        s.error.clear();
        if s.keep_seconds > 0.0 {
            let now = wall();
            let seq = s.seq;
            s.history.push_back((now, seq, f));
            let keep = s.keep_seconds;
            while s.history.front().map_or(false, |h| now - h.0 > keep) {
                s.history.pop_front();
            }
        } else {
            s.history.clear();
        }
        let seq = s.seq;
        drop(s);
        self.tick.send_replace(seq);
    }

    fn set_error(&self, e: String) {
        self.st.lock().unwrap().error = e;
        self.tick.send_modify(|v| *v = v.wrapping_add(0));
        let seq = self.st.lock().unwrap().seq;
        self.tick.send_replace(seq);
    }

    pub fn seq(&self) -> u64 {
        self.st.lock().unwrap().seq
    }
    pub fn has_frame(&self) -> bool {
        self.st.lock().unwrap().frame.is_some()
    }
    pub fn error(&self) -> String {
        self.st.lock().unwrap().error.clone()
    }
    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// The next frame after after_seq (None on timeout or error)
    pub async fn next_frame(&self, after_seq: u64, timeout: f64) -> Option<(u64, Arc<Vec<u8>>)> {
        let deadline = Instant::now() + Duration::from_secs_f64(timeout);
        let mut rx = self.tick.subscribe();
        loop {
            {
                let s = self.st.lock().unwrap();
                if !s.error.is_empty() {
                    return None;
                }
                if s.seq > after_seq {
                    return s.frame.clone().map(|f| (s.seq, f));
                }
            }
            let left = deadline.checked_duration_since(Instant::now())?;
            if tokio::time::timeout(left, rx.changed()).await.ok()?.is_err() {
                return None;
            }
        }
    }

    /// Keep the frames of the last `seconds` (plus a margin) for a delayed viewer
    pub fn keep_history(&self, seconds: f64) {
        let mut s = self.st.lock().unwrap();
        s.keep_seconds = s.keep_seconds.max(seconds.min(MAX_DELAY) + 1.0);
    }

    /// (seq, frame) of the newest frame that arrived at least `delay` seconds ago and is newer than after_seq
    pub async fn delayed_frame(&self, after_seq: u64, delay: f64, timeout: f64) -> Option<(u64, Arc<Vec<u8>>)> {
        let deadline = Instant::now() + Duration::from_secs_f64(timeout);
        let mut rx = self.tick.subscribe();
        loop {
            let (ready, waiting) = {
                let s = self.st.lock().unwrap();
                if !s.error.is_empty() {
                    return None;
                }
                let now = wall();
                let mut ready = None;
                let mut waiting = None;
                for (t, seq, f) in &s.history {
                    if *seq <= after_seq {
                        continue;
                    }
                    if t + delay <= now {
                        ready = Some((*seq, Arc::clone(f)));
                    } else {
                        waiting = Some(t + delay - now);
                        break;
                    }
                }
                (ready, waiting)
            };
            if let Some(r) = ready {
                return Some(r);
            }
            let left = deadline.checked_duration_since(Instant::now())?;
            match waiting {
                Some(w) => tokio::time::sleep(left.min(Duration::from_secs_f64(w.max(0.0)))).await,
                None => {
                    if tokio::time::timeout(left, rx.changed()).await.ok()?.is_err() {
                        return None;
                    }
                }
            }
        }
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(tx) = self.retry.lock().unwrap().as_ref() {
            let _ = tx.send(());
        }
    }

    /// Reconnect a relay at once instead of after the back-off
    pub fn retry_now(&self) {
        if let Some(tx) = self.retry.lock().unwrap().as_ref() {
            let _ = tx.send(());
        }
    }
}

/// A USB camera on this computer: a capture thread reads its MJPEG frames
#[cfg(target_os = "linux")]
fn start_camera(src: Arc<FrameSource>, device: String, size: (u32, u32), controls: Vec<(u32, i32)>, previous: Option<Arc<FrameSource>>) {
    use v4l2::*;
    std::thread::Builder::new()
        .name(format!("studio-cam-{}", src.cam_id))
        .spawn(move || {
            // The capture this one replaces (other size) lets go of the device within a second
            if let Some(p) = previous {
                let until = Instant::now() + Duration::from_secs(3);
                while p.alive() && Instant::now() < until {
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
            let run = || -> std::io::Result<()> {
                let fd = open_dev(&device)?;
                struct Guard(i32, Vec<(*mut libc::c_void, usize)>);
                impl Drop for Guard {
                    fn drop(&mut self) {
                        unsafe {
                            let mut t = BUF_TYPE_VIDEO_CAPTURE as i32;
                            let _ = ioctl(self.0, STREAMOFF, &mut t);
                            for (p, l) in &self.1 {
                                libc::munmap(*p, *l);
                            }
                            libc::close(self.0);
                        }
                    }
                }
                let mut g = Guard(fd, Vec::new());
                if !controls.is_empty() {
                    let failed = set_controls_fd(fd, &controls);
                    if !failed.is_empty() {
                        info!("Studio camera {}: controls not applied: {}", src.cam_id, failed.join(", "));
                    }
                }
                unsafe {
                    let mut fmt: Format = zeroed();
                    fmt.type_ = BUF_TYPE_VIDEO_CAPTURE;
                    fmt.fmt.pix.width = size.0;
                    fmt.fmt.pix.height = size.1;
                    fmt.fmt.pix.pixelformat = PIX_FMT_MJPEG;
                    fmt.fmt.pix.field = 0;
                    ioctl(fd, S_FMT, &mut fmt)?;
                    let mut parm: StreamParm = zeroed();
                    parm.type_ = BUF_TYPE_VIDEO_CAPTURE;
                    parm.parm.capture.numerator = 1;
                    parm.parm.capture.denominator = FPS;
                    let _ = ioctl(fd, S_PARM, &mut parm);
                    let mut req: RequestBuffers = zeroed();
                    req.count = BUFFER_COUNT;
                    req.type_ = BUF_TYPE_VIDEO_CAPTURE;
                    req.memory = MEMORY_MMAP;
                    ioctl(fd, REQBUFS, &mut req)?;
                    for i in 0..req.count {
                        let mut b: Buffer = zeroed();
                        b.index = i;
                        b.type_ = BUF_TYPE_VIDEO_CAPTURE;
                        b.memory = MEMORY_MMAP;
                        ioctl(fd, QUERYBUF, &mut b)?;
                        let p = libc::mmap(std::ptr::null_mut(), b.length as usize, libc::PROT_READ | libc::PROT_WRITE, libc::MAP_SHARED, fd, b.m.offset as libc::off_t);
                        if p == libc::MAP_FAILED {
                            return Err(std::io::Error::last_os_error());
                        }
                        g.1.push((p, b.length as usize));
                        ioctl(fd, QBUF, &mut b)?;
                    }
                    let mut t = BUF_TYPE_VIDEO_CAPTURE as i32;
                    ioctl(fd, STREAMON, &mut t)?;
                    info!("Studio camera {} streaming {}x{} MJPEG from {}", src.cam_id, fmt.fmt.pix.width, fmt.fmt.pix.height, device);
                    while !src.stop.load(Ordering::SeqCst) {
                        let mut pfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
                        if libc::poll(&mut pfd, 1, 1000) <= 0 {
                            continue;
                        }
                        let mut b: Buffer = zeroed();
                        b.type_ = BUF_TYPE_VIDEO_CAPTURE;
                        b.memory = MEMORY_MMAP;
                        match ioctl(fd, DQBUF, &mut b) {
                            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
                            Err(e) => return Err(e),
                            Ok(()) => {}
                        }
                        let (p, _) = g.1[b.index as usize];
                        let data = std::slice::from_raw_parts(p as *const u8, b.bytesused as usize).to_vec();
                        ioctl(fd, QBUF, &mut b)?;
                        if data.len() > 4 {
                            src.publish(ensure_huffman_tables(data));
                        }
                    }
                }
                Ok(())
            };
            // Right after another capture of this camera closed, the driver reports busy for a moment
            let mut res = run();
            let until = Instant::now() + Duration::from_secs(3);
            while matches!(&res, Err(e) if e.raw_os_error() == Some(libc::EBUSY)) && Instant::now() < until && !src.stop.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(200));
                res = run();
            }
            if let Err(e) = res {
                let msg = match e.raw_os_error() {
                    Some(libc::EBUSY) => "Camera is in use by another program (Autodarts or a browser tab)".to_string(),
                    Some(libc::EACCES) | Some(libc::EPERM) => "No permission to open the camera (user must be in the 'video' group)".to_string(),
                    _ => format!("Camera error: {}", e),
                };
                warn!("Studio camera {} ({}): {}", src.cam_id, device, msg);
                src.set_error(msg);
            }
            src.alive.store(false, Ordering::SeqCst);
        })
        .ok();
}

#[cfg(not(target_os = "linux"))]
fn start_camera(src: Arc<FrameSource>, _device: String, _size: (u32, u32), _controls: Vec<(u32, i32)>, _previous: Option<Arc<FrameSource>>) {
    src.set_error("USB cameras are only supported on Linux".into());
    src.alive.store(false, Ordering::SeqCst);
}

/// Why no frames come: the Board Manager only streams its cameras while Autodarts runs
fn explain_outage() -> String {
    match crate::http::get_json(&format!("{}/api/state", BOARD_MANAGER_URL), 2.0) {
        Err(_) => "Autodarts Board Manager not reachable \u{2013} is Autodarts running on this computer?".into(),
        Ok(s) if s.get("running") == Some(&json!(false)) => AUTODARTS_STOPPED.into(),
        Ok(_) => "Autodarts camera sends no picture".into(),
    }
}

/// The parts of a multipart/x-mixed-replace stream (one JPEG each)
struct Multipart {
    inner: Box<dyn Read + Send + Sync>,
    buf: Vec<u8>,
    boundary: Vec<u8>,
}

impl Multipart {
    fn fill(&mut self) -> std::io::Result<bool> {
        let mut chunk = [0u8; 65536];
        let n = self.inner.read(&mut chunk)?;
        self.buf.extend_from_slice(&chunk[..n]);
        Ok(n > 0)
    }

    fn line(&mut self) -> std::io::Result<Option<Vec<u8>>> {
        loop {
            if let Some(i) = self.buf.iter().position(|b| *b == b'\n') {
                let l: Vec<u8> = self.buf.drain(..=i).collect();
                return Ok(Some(trim_crlf(&l).to_vec()));
            }
            if !self.fill()? {
                return Ok(None);
            }
        }
    }

    fn exact(&mut self, n: usize) -> std::io::Result<Option<Vec<u8>>> {
        while self.buf.len() < n {
            if !self.fill()? {
                return Ok(None);
            }
        }
        Ok(Some(self.buf.drain(..n).collect()))
    }

    /// The next part's body; None at the end of the stream
    fn next(&mut self) -> std::io::Result<Option<Vec<u8>>> {
        let b = self.boundary.clone();
        loop {
            let Some(l) = self.line()? else { return Ok(None) };
            if l.len() >= 2 + b.len() && &l[..2] == b"--" && l[2..2 + b.len()] == b[..] {
                if l.len() == 4 + b.len() && l.ends_with(b"--") {
                    return Ok(None);
                }
                break;
            }
        }
        let mut length: Option<usize> = None;
        loop {
            let Some(l) = self.line()? else { return Ok(None) };
            if l.is_empty() {
                break;
            }
            let s = String::from_utf8_lossy(&l).to_lowercase();
            if let Some(v) = s.strip_prefix("content-length:") {
                length = v.trim().parse().ok();
            }
        }
        if let Some(n) = length {
            return self.exact(n);
        }
        // No length: everything up to the next boundary line, which stays for the next call
        let marker: Vec<u8> = [b"\r\n--".as_ref(), &b].concat();
        let mut from = 0;
        loop {
            if let Some(pos) = find(&self.buf, &marker, from, self.buf.len()) {
                let body: Vec<u8> = self.buf.drain(..pos).collect();
                self.buf.drain(..2);
                return Ok(Some(body));
            }
            from = self.buf.len().saturating_sub(marker.len());
            if !self.fill()? {
                return Ok(Some(std::mem::take(&mut self.buf)));
            }
        }
    }
}

fn trim_crlf(l: &[u8]) -> &[u8] {
    let mut e = l.len();
    while e > 0 && (l[e - 1] == b'\n' || l[e - 1] == b'\r') {
        e -= 1;
    }
    &l[..e]
}

/// A camera the Board Manager already streams (MJPEG over HTTP): one connection serves every viewer.
/// Frames are passed on at most `fps` times a second.
fn start_relay(src: Arc<FrameSource>, url: String, fps: i64) {
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    *src.retry.lock().unwrap() = Some(tx);
    std::thread::Builder::new()
        .name(format!("studio-relay-{}", src.cam_id))
        .spawn(move || {
            let min_interval = 1.0 / fps.max(1) as f64;
            let mut delay = 1.0f64;
            let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(3)).timeout_read(Duration::from_secs(5)).build();
            while !src.stop.load(Ordering::SeqCst) {
                let res = (|| -> Result<(), String> {
                    let resp = agent.get(&url).call().map_err(|e| e.to_string())?;
                    if resp.status() != 200 {
                        return Err(format!("Board Manager answered {}", resp.status()));
                    }
                    let ct = resp.header("content-type").unwrap_or("").to_string();
                    let boundary = ct.split(';').filter_map(|p| p.trim().strip_prefix("boundary=")).next().unwrap_or("").trim_matches('"').to_string();
                    let boundary = boundary.strip_prefix("--").unwrap_or(&boundary).to_string();
                    info!("Studio camera {} relaying {}", src.cam_id, url);
                    let mut reader = Multipart { inner: Box::new(resp.into_reader()), buf: Vec::new(), boundary: boundary.into_bytes() };
                    let mut last: Option<Instant> = None;
                    while !src.stop.load(Ordering::SeqCst) {
                        let Some(data) = reader.next().map_err(|e| e.to_string())? else { break };
                        let now = Instant::now();
                        if data.len() > 4 && last.map_or(true, |l| (now - l).as_secs_f64() >= min_interval - FRAME_JITTER) {
                            last = Some(now);
                            delay = 1.0;
                            src.publish(ensure_huffman_tables(data));
                        }
                    }
                    Ok(())
                })();
                if src.stop.load(Ordering::SeqCst) {
                    break;
                }
                if let Err(e) = res {
                    let why = explain_outage();
                    warn!("Studio camera {}: {} ({})", src.cam_id, why, e);
                    src.set_error(why);
                }
                let _ = rx.recv_timeout(Duration::from_secs_f64(delay));
                while rx.try_recv().is_ok() {}
                delay = (delay * 2.0).min(10.0);
            }
            src.alive.store(false, Ordering::SeqCst);
        })
        .ok();
}

/// Shares each camera between all viewers and closes it when nobody watches any more
pub struct CameraHub {
    streams: Mutex<HashMap<String, Arc<FrameSource>>>,
}

pub enum AcquireError {
    NotFound,
}

impl CameraHub {
    pub fn new() -> CameraHub {
        CameraHub { streams: Mutex::new(HashMap::new()) }
    }

    pub fn acquire(&self, cam_id: &str, resolution: &str, relay_fps: i64, controls: Vec<(u32, i32)>) -> Result<Arc<FrameSource>, AcquireError> {
        let relay = autodarts_stream_url(cam_id);
        let device = if relay.is_some() { None } else { resolve_device(cam_id) };
        if relay.is_none() && device.is_none() {
            return Err(AcquireError::NotFound);
        }
        let size = RESOLUTIONS.iter().find(|(n, _)| *n == resolution).map(|(_, s)| *s).unwrap_or((1280, 720));
        let variant = if relay.is_some() { format!("fps{}", relay_fps) } else { format!("{}x{}", size.0, size.1) };
        let mut m = self.streams.lock().unwrap();
        let mut s = m.get(cam_id).cloned();
        let mut replaced = None;
        if let Some(x) = &s {
            if !x.alive() || x.variant != variant || (!x.error().is_empty() && x.retry_on_acquire) {
                x.stop();
                replaced = s.take();
            }
        }
        let s = match s {
            Some(s) => s,
            None => {
                let src = FrameSource::new(cam_id, variant, relay.is_none());
                match relay {
                    Some(url) => start_relay(Arc::clone(&src), url, relay_fps),
                    None => start_camera(Arc::clone(&src), device.unwrap_or_default(), size, controls, replaced),
                }
                m.insert(cam_id.into(), Arc::clone(&src));
                src
            }
        };
        s.close_gen.fetch_add(1, Ordering::SeqCst);
        s.viewers.fetch_add(1, Ordering::SeqCst);
        Ok(s)
    }

    pub fn release(self: &Arc<Self>, s: &Arc<FrameSource>) {
        let left = s.viewers.fetch_sub(1, Ordering::SeqCst).saturating_sub(1);
        if left == 0 {
            let gen = s.close_gen.load(Ordering::SeqCst);
            let me = Arc::clone(self);
            let src = Arc::clone(s);
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(CLOSE_AFTER_SECONDS)).await;
                if src.viewers.load(Ordering::SeqCst) == 0 && src.close_gen.load(Ordering::SeqCst) == gen {
                    src.stop();
                    let mut m = me.streams.lock().unwrap();
                    if m.get(&src.cam_id).map_or(false, |x| Arc::ptr_eq(x, &src)) {
                        m.remove(&src.cam_id);
                    }
                }
            });
        }
    }

    pub fn retry_relays(&self) {
        for s in self.streams.lock().unwrap().values() {
            s.retry_now();
        }
    }

    pub fn stop_all(&self) {
        for (_, s) in self.streams.lock().unwrap().drain() {
            s.stop();
        }
    }
}
