//! Studio cameras as H.264, encoded by the graphics chip (Fedora: VAAPI via ffmpeg).
//!
//! A browser decodes MJPEG on the CPU and copies every frame to the GPU, which made the Studio output
//! stutter. H.264 is decoded by the graphics chip at a tenth of the network traffic. One ffmpeg per camera
//! turns the JPEG frames AutoGlow already has into fragmented MP4: an init segment, then one fragment per
//! frame. Every viewer gets the init segment and then the fragments from the next keyframe on.

use crate::studio_camera::{CameraHub, FrameSource};
use log::{info, warn};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

const RENDER_NODE: &str = "/dev/dri/renderD128";
const BITRATE: &str = "10M";
const MAX_RATE: &str = "14M";
const GOP: u32 = 30;
const VIEWER_QUEUE: usize = 90;
const CLOSE_AFTER_SECONDS: u64 = 10;
const FRAME_TIMEOUT: f64 = 10.0;

/// ffmpeg with the VAAPI H.264 encoder and a render node to run it on (checked once)
pub fn encoder_available() -> bool {
    static A: OnceLock<bool> = OnceLock::new();
    *A.get_or_init(|| {
        let ok = std::path::Path::new(RENDER_NODE).exists()
            && std::process::Command::new("ffmpeg")
                .args(["-hide_banner", "-encoders"])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).contains(" h264_vaapi "))
                .unwrap_or(false);
        info!("Studio H.264 cameras: {}", if ok { "available (VAAPI)" } else { "not available, MJPEG only" });
        ok
    })
}

fn ffmpeg_args() -> Vec<String> {
    [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-hwaccel", "vaapi", "-hwaccel_device", RENDER_NODE, "-hwaccel_output_format", "vaapi",
        "-use_wallclock_as_timestamps", "1", "-fflags", "nobuffer", "-f", "mjpeg", "-i", "pipe:0", "-vf", "scale_vaapi=format=nv12", "-fps_mode",
        "passthrough", "-c:v", "h264_vaapi", "-profile:v", "high", "-b:v", BITRATE, "-maxrate", MAX_RATE, "-bf", "0", "-g", &GOP.to_string(), "-f", "mp4",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof+frag_every_frame", "pipe:1",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// 'avc1.PPCCLL' for Media Source from the avcC box of the init segment
fn codec_string(init: &[u8]) -> String {
    match init.windows(4).position(|w| w == b"avcC") {
        Some(i) if i + 8 <= init.len() => format!("avc1.{:02x}{:02x}{:02x}", init[i + 5], init[i + 6], init[i + 7]),
        _ => "avc1.640028".into(),
    }
}

/// An IDR picture among the length-prefixed NAL units of a fragment
fn is_keyframe(mdat: &[u8]) -> bool {
    let mut pos = 0usize;
    while pos + 5 <= mdat.len() {
        let size = u32::from_be_bytes(mdat[pos..pos + 4].try_into().unwrap()) as usize;
        if mdat[pos + 4] & 0x1f == 5 {
            return true;
        }
        pos += 4 + size;
    }
    false
}

struct Viewer {
    tx: mpsc::Sender<Option<Arc<Vec<u8>>>>,
    waiting_for_key: bool,
    id: usize,
}

struct CamState {
    init: Option<Arc<Vec<u8>>>,
    codec: String,
    error: String,
    viewers: Vec<Viewer>,
    task: Option<tokio::task::JoinHandle<()>>,
    ready: Arc<tokio::sync::Notify>,
}

/// One camera as fragmented-MP4 H.264, shared by all its viewers; closes when nobody watches
pub struct H264Camera {
    key: String,
    hub: Arc<CameraHub>,
    args: (String, String, i64, Vec<(u32, i32)>),
    delay: f64,
    st: Mutex<CamState>,
    next_id: AtomicUsize,
    close_gen: AtomicUsize,
}

pub struct ViewerHandle {
    pub rx: mpsc::Receiver<Option<Arc<Vec<u8>>>>,
    id: usize,
}

impl H264Camera {
    pub fn add_viewer(self: &Arc<Self>) -> ViewerHandle {
        self.close_gen.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel(VIEWER_QUEUE);
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let mut s = self.st.lock().unwrap();
        s.viewers.push(Viewer { tx, waiting_for_key: true, id });
        if s.task.as_ref().map_or(true, |t| t.is_finished()) {
            s.error.clear();
            let me = Arc::clone(self);
            s.task = Some(tokio::spawn(async move { me.run().await }));
        }
        ViewerHandle { rx, id }
    }

    pub async fn wait_ready(&self, timeout: f64) -> bool {
        let n = {
            let s = self.st.lock().unwrap();
            if s.init.is_some() {
                return true;
            }
            Arc::clone(&s.ready)
        };
        let _ = tokio::time::timeout(Duration::from_secs_f64(timeout), n.notified()).await;
        self.st.lock().unwrap().init.is_some()
    }

    pub fn init_codec(&self) -> (Option<Arc<Vec<u8>>>, String, String) {
        let s = self.st.lock().unwrap();
        (s.init.clone(), s.codec.clone(), s.error.clone())
    }

    fn publish(&self, frag: Vec<u8>, key: bool) {
        let f = Arc::new(frag);
        let mut s = self.st.lock().unwrap();
        for v in s.viewers.iter_mut() {
            if v.waiting_for_key && !key {
                continue;
            }
            match v.tx.try_send(Some(Arc::clone(&f))) {
                Ok(()) => v.waiting_for_key = false,
                // Too slow (network): go on from the next keyframe
                Err(_) => v.waiting_for_key = true,
            }
        }
    }

    async fn run(self: Arc<Self>) {
        let (cam_id, res, fps, controls) = self.args.clone();
        let mut src: Option<Arc<FrameSource>> = None;
        let err = async {
            let s = self.hub.acquire(&cam_id, &res, fps, controls).map_err(|_| format!("Video encoder not started: Camera {} not found", cam_id))?;
            src = Some(Arc::clone(&s));
            if self.delay > 0.0 {
                s.keep_history(self.delay);
            }
            let mut child = tokio::process::Command::new("ffmpeg")
                .args(ffmpeg_args())
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .map_err(|e| format!("Video encoder not started: {}", e))?;
            let mut stdin = child.stdin.take().unwrap();
            let stdout = child.stdout.take().unwrap();
            let stderr = child.stderr.take().unwrap();
            let delay = self.delay;
            let s2 = Arc::clone(&s);
            let feeder = tokio::spawn(async move {
                let mut seq = if s2.has_frame() { s2.seq().saturating_sub(1) } else { 0 };
                loop {
                    let got = if delay > 0.0 { s2.delayed_frame(seq, delay, FRAME_TIMEOUT).await } else { s2.next_frame(seq, FRAME_TIMEOUT).await };
                    let Some((q, f)) = got else { break };
                    seq = q;
                    if stdin.write_all(&f).await.is_err() || stdin.flush().await.is_err() {
                        break;
                    }
                }
            });
            let err_task = tokio::spawn(async move {
                let mut last = String::new();
                let mut lines = tokio::io::BufReader::new(stderr).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    if !l.trim().is_empty() {
                        last = l.trim().to_string();
                    }
                }
                last
            });
            self.read(stdout).await;
            feeder.abort();
            let _ = child.kill().await;
            let e = err_task.await.unwrap_or_default();
            let se = s.error();
            Err::<(), String>(if !se.is_empty() { se } else if !e.is_empty() { e } else { "The video encoder stopped".into() })
        }
        .await;
        if let Err(e) = err {
            warn!("Studio H.264 camera {}: {}", self.key, e);
            self.st.lock().unwrap().error = e;
        }
        if let Some(s) = src {
            self.hub.release(&s);
        }
        let mut st = self.st.lock().unwrap();
        st.init = None;
        st.ready.notify_waiters();
        st.ready = Arc::new(tokio::sync::Notify::new());
        for v in &st.viewers {
            let _ = v.tx.try_send(None);
        }
    }

    /// Split ffmpeg's MP4 into the init segment and one fragment (moof + mdat) per frame
    async fn read(&self, mut out: tokio::process::ChildStdout) {
        let mut init = Vec::new();
        let mut moof: Vec<u8> = Vec::new();
        loop {
            let mut head = [0u8; 8];
            if out.read_exact(&mut head).await.is_err() {
                return;
            }
            let mut size = u32::from_be_bytes(head[..4].try_into().unwrap()) as u64;
            let kind: [u8; 4] = head[4..8].try_into().unwrap();
            let mut box_ = head.to_vec();
            if size == 1 {
                let mut large = [0u8; 8];
                if out.read_exact(&mut large).await.is_err() {
                    return;
                }
                size = u64::from_be_bytes(large);
                box_.extend(large);
            }
            let mut body = vec![0u8; (size as usize).saturating_sub(box_.len())];
            if out.read_exact(&mut body).await.is_err() {
                return;
            }
            match &kind {
                b"ftyp" | b"moov" => {
                    init.extend(&box_);
                    init.extend(&body);
                    if &kind == b"moov" {
                        let mut s = self.st.lock().unwrap();
                        s.codec = codec_string(&init);
                        s.init = Some(Arc::new(init.clone()));
                        s.ready.notify_waiters();
                    }
                }
                b"moof" => {
                    moof = box_;
                    moof.extend(body);
                }
                b"mdat" if !moof.is_empty() => {
                    let key = is_keyframe(&body);
                    let mut frag = std::mem::take(&mut moof);
                    frag.extend(box_);
                    frag.extend(body);
                    self.publish(frag, key);
                }
                _ => {}
            }
        }
    }
}

/// The H.264 cameras by camera, resolution and delay
pub struct VideoHub {
    hub: Arc<CameraHub>,
    cams: Mutex<HashMap<String, Arc<H264Camera>>>,
}

impl VideoHub {
    pub fn new(hub: Arc<CameraHub>) -> VideoHub {
        VideoHub { hub, cams: Mutex::new(HashMap::new()) }
    }

    pub fn get(&self, cam_id: &str, res: &str, fps: i64, controls: Vec<(u32, i32)>, delay: f64) -> Arc<H264Camera> {
        let key = format!("{}|{}|{}|{:.2}", cam_id, res, fps, delay);
        let mut m = self.cams.lock().unwrap();
        Arc::clone(m.entry(key.clone()).or_insert_with(|| {
            Arc::new(H264Camera {
                key,
                hub: Arc::clone(&self.hub),
                args: (cam_id.into(), res.into(), fps, controls),
                delay,
                st: Mutex::new(CamState { init: None, codec: String::new(), error: String::new(), viewers: Vec::new(), task: None, ready: Arc::new(tokio::sync::Notify::new()) }),
                next_id: AtomicUsize::new(0),
                close_gen: AtomicUsize::new(0),
            })
        }))
    }

    pub fn release(self: &Arc<Self>, cam: &Arc<H264Camera>, viewer: &ViewerHandle) {
        let empty = {
            let mut s = cam.st.lock().unwrap();
            s.viewers.retain(|v| v.id != viewer.id);
            s.viewers.is_empty()
        };
        if empty {
            let gen = cam.close_gen.load(Ordering::SeqCst);
            let me = Arc::clone(self);
            let c = Arc::clone(cam);
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(CLOSE_AFTER_SECONDS)).await;
                if c.close_gen.load(Ordering::SeqCst) != gen || !c.st.lock().unwrap().viewers.is_empty() {
                    return;
                }
                if let Some(t) = c.st.lock().unwrap().task.take() {
                    t.abort();
                }
                me.cams.lock().unwrap().remove(&c.key);
            });
        }
    }

    pub fn stop_all(&self) {
        for (_, c) in self.cams.lock().unwrap().drain() {
            if let Some(t) = c.st.lock().unwrap().task.take() {
                t.abort();
            }
        }
    }
}
