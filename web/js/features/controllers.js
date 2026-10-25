// AutoGlow 2 - Setup › Controllers
// The controller list, adding by IP or network scan, enable/disable and removal.
// Editing outputs and segments stays in web/js/devices.js, which renders into the side drawer.

import { api } from '../core/api.js';
import { confirmDialog } from '../core/dialog.js';
import { h, showFieldError, clearFieldError } from '../core/dom.js';
import { toast } from '../core/toast.js';
import { runControllerSetup } from './controller-setup.js';

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

// One line describing the controller's LED layout, e.g. "45 RGB LEDs · light strip · 3 segments"
export function layoutSummary(live) {
  const buses = Array.isArray(live?.hw_ins) ? live.hw_ins : [];
  const segments = Array.isArray(live?.segments) ? live.segments : [];
  const leds = buses.filter(b => !isPwmBus(b)).reduce((sum, b) => sum + (Number(b.len) || 0), 0);
  const parts = [];
  if (leds) parts.push(`${leds} RGB LEDs`);
  if (buses.some(isPwmBus)) parts.push('light strip');
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
      body: `${ip} did not answer. Add it anyway? You can run the setup guide once it is online.`,
      confirmLabel: 'Add anyway'
    })) return;

    // Reachable controllers go through the setup guide; offline ones are added as they are
    const setup = live?.online ? await runControllerSetup(ip, live) : null;
    if (live?.online && !setup) return;

    const dev = deviceFromLive(ip, live);
    if (setup?.name) dev.name = setup.name;
    if (live) window.lastFetchedLiveDeviceData[ip] = live;
    const applying = Boolean(setup?.hw_ins);
    if (await saveDevices([...devices(), dev], applying ? null : `${dev.name} added`)) {
      if (input) input.value = '';
      removeScanResult(ip);
      if (applying) await applySetup(ip, setup, `${dev.name} added and set up`);
    }
  } finally {
    button?.removeAttribute('aria-busy');
    if (button) button.disabled = false;
  }
}

// Write the guide's answers to the controller and to AutoGlow's config
async function applySetup(ip, setup, successMessage) {
  const dev = devices().find(d => d.ip === ip);
  try {
    const result = await api.post('/api/wled/update', {
      ip,
      name: setup.name,
      udp_port: dev?.udp_port || 21324,
      hw_ins: setup.hw_ins,
      // Full master brightness, so the light strip's 100% really is 100%
      state: { on: true, bri: 255, seg: setup.seg }
    }, { timeout: 15000 });
    delete window.lastFetchedLiveDeviceData[ip];
    await window.loadConfig();
    if (result.hardware_applied) toast.success(successMessage);
    else toast.warning('Saved in AutoGlow, but the controller did not take the new layout. Run the setup again once it is reachable.');
  } catch (err) {
    toast.error(err, { onRetry: () => applySetup(ip, setup, successMessage) });
  }
}

async function rerunSetup(dev, button) {
  button.disabled = true;
  try {
    const live = await window.pingDeviceCached(dev.ip, true);
    if (!live?.online) {
      toast.warning(`${dev.name || dev.ip} is offline`);
      return;
    }
    window.lastFetchedLiveDeviceData[dev.ip] = live;
    const setup = await runControllerSetup(dev.ip, { ...live, name: dev.name || live.name });
    if (setup?.hw_ins) await applySetup(dev.ip, setup, `${setup.name} set up`);
  } finally {
    button.disabled = false;
  }
}

function removeScanResult(ip) {
  const host = document.getElementById('scanResults');
  if (!host) return;
  host.querySelector(`.ctl-scan-row[data-ip="${CSS.escape(ip)}"]`)?.remove();
  if (!host.querySelector('.ctl-scan-row')) host.hidden = true;
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
    const known = new Set(devices().map(d => d.ip));
    const found = (Array.isArray(data.devices) ? data.devices : []).filter(d => !known.has(d.ip));
    if (!found.length) {
      host.replaceChildren(h('div', { class: 'ctl-scan-status' }, 'No new WLED controllers found. Add one by IP instead.'));
      return;
    }
    host.replaceChildren(...found.map(d => h('div', { class: 'ctl-scan-row', dataset: { ip: d.ip } },
      h('span', { class: 'ctl-name' }, d.name || 'WLED Controller'),
      h('span', { class: 'ctl-ip' }, d.ip),
      h('button', { class: 'ui-btn ui-btn-sm ui-btn-primary', type: 'button', onclick: event => addController(d.ip, event.currentTarget) }, 'Add')
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
  const setupBtn = h('button', {
    class: 'ui-btn ui-btn-sm',
    type: 'button',
    disabled: !enabled,
    title: 'Answer a few questions and let AutoGlow configure the LEDs',
    onclick: event => rerunSetup(dev, event.currentTarget)
  }, 'Set up');

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
    setupBtn,
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
      setupBtn.disabled = !online;
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

  // Drawer tabs: LEDs & segments / Idle lighting
  document.querySelectorAll('#controllerDrawer [data-drawer-tab]').forEach(tab => {
    tab.addEventListener('click', () => window.setControllerDrawerTab(tab.dataset.drawerTab));
  });
  document.getElementById('drawerClose')?.addEventListener('click', () => {
    const ip = window.getEditingControllerIp?.();
    if (ip) window.cancelInlineEdit(ip);
  });
}
