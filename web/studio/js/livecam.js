// AutoGlow Studio - a camera stream shown in a <canvas>, decoded by js/camera-worker.js (H.264 on the
// graphics chip, or MJPEG).
// It stands in for the MJPEG <img> the output used before: it has the same size properties
// (naturalWidth, naturalHeight, complete) and fires 'load' when the picture size is known or changes,
// so framing, fill and the WebGL straighten treat it like a picture. On top it tells them when a new
// frame arrived (frameSeq) and lends them the decoded frame (bitmap), so nothing is decoded twice.
// Frames are shown once per screen refresh; a late frame replaces one not shown yet (no backlog).

export const MEDIA_SELECTOR = ':scope > img, :scope > video, :scope > canvas.cam-live';

const workerUrl = new URL('./camera-worker.js', import.meta.url);

// Frames are VideoFrames (H.264) or ImageBitmaps (MJPEG)
const frameW = f => f.displayWidth ?? f.width;
const frameH = f => f.displayHeight ?? f.height;

// A camera that sends no frame for this long is connected again (a stream can stall without closing)
const STALL_MS = 8000;
// The first frame may take longer: the dart-zoom delay holds frames back, an encoder starts first
const FIRST_FRAME_MS = 15000;

// H.264 needs WebCodecs (the worker checks the stream's exact codec)
export const h264Supported = () => typeof VideoDecoder !== 'undefined';

export function createLiveCamera(url, { format = 'mjpeg', onError, onEnded } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'cam-live';
  canvas.width = 16;
  canvas.height = 9;
  const g = canvas.getContext('2d', { alpha: false, desynchronized: true });
  let bitmap = null;     // frame on screen (kept: the straighten and fill read it)
  let pending = null;    // newest frame not on screen yet
  let raf = 0;
  let closed = false;
  let seq = 0;
  // Frames read, dropped before decoding (worker busy), decoded, shown: to see where frames go
  const stats = { received: 0, decodeDropped: 0, decoded: 0, shown: 0 };

  Object.defineProperties(canvas, {
    naturalWidth: { get: () => (bitmap ? frameW(bitmap) : 0) },
    naturalHeight: { get: () => (bitmap ? frameH(bitmap) : 0) },
    complete: { get: () => !!bitmap },
    frameSeq: { get: () => seq },
    bitmap: { get: () => bitmap },
    stats: { get: () => ({ ...stats, shown: seq }) }
  });

  const present = () => {
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
    // Hidden while the WebGL straighten draws the picture: it reads the bitmap itself
    if (!canvas.parentNode?.classList.contains('sharp-on')) g.drawImage(next, 0, 0);
    if (resized) canvas.dispatchEvent(new Event('load'));
  };

  const worker = new Worker(workerUrl);
  let lastFrameAt = 0;
  const startedAt = performance.now();
  let watchdog = 0;
  const giveUp = () => {
    if (closed) return;
    clearInterval(watchdog);
    onEnded?.();
  };
  // The worker script itself failed (e.g. AutoGlow was updated while this page stayed open)
  worker.onerror = event => {
    event.preventDefault?.();
    giveUp();
  };
  watchdog = setInterval(() => {
    const since = lastFrameAt ? performance.now() - lastFrameAt : performance.now() - startedAt;
    if (since > (lastFrameAt ? STALL_MS : FIRST_FRAME_MS)) giveUp();
  }, 2000);
  worker.onmessage = ({ data }) => {
    if (closed) {
      data.frame?.close();
      return;
    }
    if (data.type === 'frame') {
      lastFrameAt = performance.now();
      stats.received = data.received;
      stats.decodeDropped = data.dropped;
      stats.decoded++;
      if (pending) pending.close();
      pending = data.frame;
      if (!raf) raf = requestAnimationFrame(present);
    } else if (data.type === 'error') {
      clearInterval(watchdog);
      onError?.(data.message || '', data.status);
    } else if (data.type === 'ended') {
      giveUp();
    }
  };
  worker.postMessage({ type: 'open', url, format });

  // Stop reading (AutoGlow lets go of the camera when nobody watches) and free the frames
  canvas.closeStream = () => {
    if (closed) return;
    closed = true;
    clearInterval(watchdog);
    worker.postMessage({ type: 'close' });
    worker.terminate();
    if (raf) cancelAnimationFrame(raf);
    pending?.close();
    bitmap?.close();
    pending = null;
    bitmap = null;
  };
  return canvas;
}
