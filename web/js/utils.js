// AutoGlow 2 - Shared Frontend Utilities

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeJsString(str) {
  if (!str) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"');
}

function sanitizeWledName(name) {
  if (!name) return '';
  return String(name).replace(/[^a-zA-Z0-9 _-]/g, '').substring(0, 32);
}

function hexToRgb(hex) {
  if (!hex || typeof hex !== 'string') return [255, 255, 255];
  hex = hex.replace('#', '');
  if (hex.length === 3) {
    hex = hex.split('').map(c => c + c).join('');
  }
  const num = parseInt(hex, 16);
  if (isNaN(num)) return [255, 255, 255];
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function rgbToHex(r, g, b) {
  if (Array.isArray(r)) {
    b = r[2];
    g = r[1];
    r = r[0];
  } else if (r && typeof r === 'object') {
    b = r.b !== undefined ? r.b : (r.blue !== undefined ? r.blue : 0);
    g = r.g !== undefined ? r.g : (r.green !== undefined ? r.green : 0);
    r = r.r !== undefined ? r.r : (r.red !== undefined ? r.red : 0);
  } else if (typeof r === 'string') {
    if (r.startsWith('#')) return r;
    const match = r.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/i);
    if (match) {
      r = match[1];
      g = match[2];
      b = match[3];
    }
  }

  const toHex = (n) => {
    const clamped = Math.max(0, Math.min(255, parseInt(n, 10) || 0));
    const h = clamped.toString(16);
    return h.length === 1 ? '0' + h : h;
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 300);
  }, 3500);
}

function logTerminal(message, type = 'info') {
  const terminal = document.getElementById('telemetryLog');
  if (!terminal) return;

  const timeStr = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;
  entry.innerHTML = `<span class="log-time">[${timeStr}]</span> <span class="log-msg">${escapeHtml(message)}</span>`;

  terminal.appendChild(entry);
  terminal.scrollTop = terminal.scrollHeight;
}

var _activePingPromises = {};

async function pingDeviceCached(ip, force = false) {
  if (!ip || !ip.trim()) return { status: 'ok', online: false, ip: '' };
  const cleanIp = ip.trim();
  
  if (!force && lastFetchedLiveDeviceData[cleanIp] && (Date.now() - (lastFetchedLiveDeviceData[cleanIp]._ts || 0) < 5000)) {
    return lastFetchedLiveDeviceData[cleanIp];
  }
  
  if (_activePingPromises[cleanIp]) {
    return _activePingPromises[cleanIp];
  }
  
  _activePingPromises[cleanIp] = (async () => {
    try {
      const res = await fetch(`/api/ping?ip=${encodeURIComponent(cleanIp)}`);
      const data = await res.json();
      data._ts = Date.now();
      lastFetchedLiveDeviceData[cleanIp] = data;
      return data;
    } catch (e) {
      const offlineData = {
        status: 'ok',
        online: false,
        ip: cleanIp,
        message: String(e),
        _ts: Date.now()
      };
      lastFetchedLiveDeviceData[cleanIp] = offlineData;
      return offlineData;
    } finally {
      delete _activePingPromises[cleanIp];
    }
  })();
  
  return _activePingPromises[cleanIp];
}

if (typeof window !== "undefined") {
  window.escapeHtml = escapeHtml;
  window.escapeJsString = escapeJsString;
  window.sanitizeWledName = sanitizeWledName;
  window.hexToRgb = hexToRgb;
  window.rgbToHex = rgbToHex;
  window.showToast = showToast;
  window.logTerminal = logTerminal;
  window.pingDeviceCached = pingDeviceCached;
}


// Reload the page once a restarting backend is reachable again (after updates / backup restores)
async function waitForServerAndReload(initialDelayMs = 1500, timeoutMs = 60000) {
  await new Promise(r => setTimeout(r, initialDelayMs));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('/api/auth/status', { cache: 'no-store' });
      if (res.ok) break;
    } catch (e) {
      // Server still restarting
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  window.location.reload();
}
