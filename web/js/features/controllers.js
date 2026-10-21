// AutoGlow 2 - Setup › Controllers
// The controller list, adding by IP or network scan, enable/disable and removal.
// Editing outputs and segments stays in web/js/devices.js, which renders into the side drawer.

import { api } from '../core/api.js';
import { confirmDialog } from '../core/dialog.js';
import { h, showFieldError, clearFieldError } from '../core/dom.js';
import { toast } from '../core/toast.js';

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

const devices = () => (Array.isArray(window.appState?.devices) ? window.appState.devices : []);
const isPwmBus = bus => Number(bus.type) >= 40;

export function validateAddress(value, existing = devices()) {
  if (!value) return 'Enter the controller\'s IP address';
  // Digits and dots only must be a real IPv4 address (so 300.1.1.1 is not taken as a hostname)
  const valid = /^[\d.]+$/.test(value) ? IPV4.test(value) : HOSTNAME.test(value);
  if (!valid) return 'Not a valid IP address or hostname';
  if (existing.some(d => d.ip === value)) return 'This controller is already added';
  return null;
}

// Build the device entry from what the controller reports. Offline controllers get no guessed LED
// layout; the server reads it from the controller once it is reachable.
export function deviceFromLive(ip, live) {
  const dev = { id: `device_${Date.now()}`, ip, name: 'WLED Controller', udp_port: 21324, default_pwm_brightness: 200, enabled: true };
  if (!live?.online) return dev;

  const buses = Array.isArray(live.hw_ins) ? live.hw_ins : [];
  const segments = Array.isArray(live.segments) ? live.segments : [];
  const rgbBus = buses.find(b => !isPwmBus(b));
  const pwmBus = buses.find(isPwmBus);

  dev.name = live.name || dev.name;
  dev.hw_ins = buses;
  if (rgbBus) dev.rgb_count = Number(rgbBus.len) || undefined;
  dev.pwm_index = pwmBus ? Number(pwmBus.start) : null;
  dev.pwm_seg_id = pwmBus ? (segments.find(s => Number(s.start) === Number(pwmBus.start))?.id ?? null) : null;
  dev.segments = segments.map(s => ({ id: s.id, name: s.name, start: s.start, length: s.len, type: s.type }));
  return dev;
}

// One line describing the controller's LED layout, e.g. "45 LEDs · PWM white · 3 segments"
export function layoutSummary(live) {
  const buses = Array.isArray(live?.hw_ins) ? live.hw_ins : [];
  const segments = Array.isArray(live?.segments) ? live.segments : [];
  const leds = buses.filter(b => !isPwmBus(b)).reduce((sum, b) => sum + (Number(b.len) || 0), 0);
  const parts = [];
  if (leds) parts.push(`${leds} LEDs`);
  if (buses.some(isPwmBus)) parts.push('PWM white');
  if (segments.length) parts.push(`${segments.length} segment${segments.length === 1 ? '' : 's'}`);
  return parts.join(' · ') || 'No LED outputs configured';
}

async function saveDevices(next, successMessage) {
  const previous = { devices: window.appState.devices, wifi_ip: window.appState.wifi_ip };
  window.appState.devices = next;
  // The server rebuilds a device from the legacy wifi_ip when the list is empty, so keep them in step
  window.appState.wifi_ip = next[0]?.ip || '';
  try {
    await api.post('/api/config', window.appState);
    if (successMessage) toast.success(successMessage);
    await window.loadConfig();
    return true;
  } catch (err) {
    Object.assign(window.appState, previous);
    renderDevicesTab();
    toast.error(err, { onRetry: () => saveDevices(next, successMessage) });
    return false;
  }
}

// input is the IP field when adding from the form (errors show under it); scan results pass none
async function addController(ip, button, input = null) {
  if (input) clearFieldError(input);
  const problem = validateAddress(ip);
  if (problem) {
    if (input) showFieldError(input, problem);
    else toast.warning(problem);
    return;
  }

  button?.setAttribute('aria-busy', 'true');
  if (button) button.disabled = true;
  try {
    let live = null;
    try {
      live = await api.get(`/api/ping?ip=${encodeURIComponent(ip)}`, { timeout: 6000 });
    } catch (err) {
      live = null;
    }
    if (!live?.online && !await confirmDialog({
      title: 'Controller not reachable',
      body: `${ip} did not answer. Add it anyway?`,
      confirmLabel: 'Add anyway'
    })) return;

    const dev = deviceFromLive(ip, live);
    if (live) window.lastFetchedLiveDeviceData[ip] = live;
    if (await saveDevices([...devices(), dev], `${dev.name} added`) && input) input.value = '';
  } finally {
    button?.removeAttribute('aria-busy');
    if (button) button.disabled = false;
  }
}

async function removeController(dev) {
  const confirmed = await confirmDialog({
    title: `Remove ${dev.name || dev.ip}?`,
    body: 'Its effect settings stay saved and come back if you add it again.',
    confirmLabel: 'Remove',
    danger: true
  });
  if (!confirmed) return;
  await saveDevices(devices().filter(d => d.ip !== dev.ip), `${dev.name || dev.ip} removed`);
}

async function setControllerEnabled(ip, enabled) {
  const next = devices().map(d => (d.ip === ip ? { ...d, enabled } : d));
  await saveDevices(next, null);
}

async function scanNetwork(button) {
  const host = document.getElementById('scanResults');
  if (!host) return;
  host.hidden = false;
  host.replaceChildren(h('div', { class: 'ctl-scan-status' }, 'Scanning your network…'));
  button.disabled = true;
  try {
    const data = await api.get('/api/scan/network', { timeout: 30000 });
    const found = Array.isArray(data.devices) ? data.devices : [];
    if (!found.length) {
      host.replaceChildren(h('div', { class: 'ctl-scan-status' }, 'No WLED controllers found. Add one by IP instead.'));
      return;
    }
    const known = new Set(devices().map(d => d.ip));
    host.replaceChildren(...found.map(d => h('div', { class: 'ctl-scan-row' },
      h('span', { class: 'ctl-name' }, d.name || 'WLED Controller'),
      h('span', { class: 'ctl-ip' }, d.ip),
      known.has(d.ip)
        ? h('span', { class: 'ctl-scan-added' }, 'Added')
        : h('button', { class: 'ui-btn ui-btn-sm ui-btn-primary', type: 'button', onclick: event => addController(d.ip, event.currentTarget) }, 'Add')
    )));
  } catch (err) {
    host.hidden = true;
    toast.error(err, { onRetry: () => scanNetwork(button) });
  } finally {
    button.disabled = false;
  }
}

function controllerRow(dev) {
  const enabled = dev.enabled !== false;
  const editing = window.getEditingControllerIp?.() === dev.ip;
  const summary = h('span', { class: 'ctl-summary' }, enabled ? 'Checking…' : 'Disabled');
  const dot = h('span', { class: 'status-dot', dataset: { tone: enabled ? 'pending' : 'off' } });
  const editBtn = h('button', {
    class: 'ui-btn ui-btn-sm',
    type: 'button',
    disabled: !enabled,
    title: enabled ? null : 'Enable the controller to edit it',
    onclick: () => window.startInlineDeviceEdit(dev.ip)
  }, editing ? 'Editing' : 'Edit');

  const row = h('div', { class: 'ctl-row', dataset: { ip: dev.ip }, 'aria-current': editing ? 'true' : null },
    dot,
    h('div', { class: 'ctl-main' },
      h('div', { class: 'ctl-name' }, dev.name || 'WLED Controller'),
      h('div', { class: 'ctl-meta' },
        h('a', { class: 'ctl-ip', href: `http://${dev.ip}`, target: '_blank', rel: 'noopener noreferrer', title: 'Open the WLED web interface' }, dev.ip),
        summary
      )
    ),
    h('label', { class: 'switch ctl-switch', title: enabled ? 'Disable controller' : 'Enable controller' },
      h('input', { type: 'checkbox', checked: enabled, 'aria-label': `${dev.name || dev.ip} enabled`, onchange: event => setControllerEnabled(dev.ip, event.target.checked) }),
      h('span', { class: 'switch-slider' })
    ),
    editBtn,
    h('button', { class: 'ui-btn ui-btn-sm ui-btn-quiet', type: 'button', 'aria-label': `Remove ${dev.name || dev.ip}`, title: 'Remove', onclick: () => removeController(dev) }, '✕')
  );

  if (enabled) {
    window.pingDeviceCached(dev.ip).then(live => {
      const online = live?.status === 'ok' && live.online === true;
      window.lastFetchedLiveDeviceData[dev.ip] = live;
      dot.dataset.tone = online ? 'ok' : 'error';
      summary.textContent = online ? layoutSummary(live) : 'Offline';
      editBtn.disabled = !online;
      editBtn.title = online ? '' : 'The controller is offline';
    }).catch(() => {
      dot.dataset.tone = 'error';
      summary.textContent = 'Offline';
    });
  }
  return row;
}

function renderList() {
  const host = document.getElementById('controllerList');
  if (!host) return;
  const list = devices();
  host.replaceChildren(...(list.length
    ? list.map(controllerRow)
    : [h('div', { class: 'ctl-empty' }, 'No controllers yet. Add one by IP or scan your network.')]));
}

// Called by the classic scripts (loadConfig, the editor) after any controller change
export function renderDevicesTab() {
  renderList();
  window.renderControllerEditor?.();
}

export function initControllers() {
  window.renderDevicesTab = renderDevicesTab;
  window.toggleDeviceEnabled = setControllerEnabled;

  document.getElementById('controllerAddForm')?.addEventListener('submit', event => {
    event.preventDefault();
    const input = document.getElementById('deviceIpInput');
    addController((input?.value || '').trim(), event.submitter, input);
  });
  const scanBtn = document.getElementById('btnScanNetwork');
  scanBtn?.addEventListener('click', () => scanNetwork(scanBtn));
}
