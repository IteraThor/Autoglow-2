// AutoGlow 2 - Setup › Controllers
// The controller list and adding by IP or network scan. Each controller opens its own page
// (/setup/controllers/<ip>, web/js/features/controller-detail.js).

import { api } from '../core/api.js';
import { confirmDialog, promptDialog } from '../core/dialog.js';
import { h } from '../core/dom.js';
import { router } from '../core/router.js';
import { appStore } from '../core/store.js';
import { toast } from '../core/toast.js';
import { closeDetail, initControllerDetail, openDetail } from './controller-detail.js';
import { runControllerSetup } from './controller-setup.js';

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export const devices = () => (Array.isArray(window.appState?.devices) ? window.appState.devices : []);
const isPwmBus = bus => Number(bus.type) >= 40;
const detailPath = ip => `/setup/controllers/${encodeURIComponent(ip)}`;

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
  dev.segments = segments.map(s => ({ id: s.id, name: s.name, start: s.start, length: s.len, offset: s.of || 0, type: s.type }));
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

export async function saveDevices(next, successMessage) {
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

// Write the guide's answers to the controller and to AutoGlow's config
export async function applySetup(ip, setup, successMessage) {
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

// Ping, run the setup guide when the controller answers, save, then open its page
async function addController(ip, button) {
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
      body: `${ip} did not answer. Add it anyway? You can set it up once it is online.`,
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
      removeScanResult(ip);
      if (applying) await applySetup(ip, setup, `${dev.name} added and set up`);
      router.navigate(detailPath(ip));
    }
  } finally {
    button?.removeAttribute('aria-busy');
    if (button) button.disabled = false;
  }
}

async function promptAdd(button) {
  const ip = await promptDialog({
    title: 'Add controller',
    body: 'Enter the IP address of a WLED controller on your network. Not sure? Use Scan network instead.',
    placeholder: 'e.g. 192.168.1.40',
    confirmLabel: 'Add',
    validate: validateAddress
  });
  if (ip) await addController(ip, button);
}

function removeScanResult(ip) {
  const host = document.getElementById('scanResults');
  if (!host) return;
  host.querySelector(`.ctl-scan-row[data-ip="${CSS.escape(ip)}"]`)?.remove();
  if (!host.querySelector('.ctl-scan-row')) host.hidden = true;
}

function scanCard(title, ...rows) {
  const host = document.getElementById('scanResults');
  host.hidden = false;
  host.replaceChildren(
    h('div', { class: 'card-head' },
      h('h2', { class: 'card-title' }, title),
      h('button', { type: 'button', class: 'ui-btn ui-btn-sm', onclick: () => { host.hidden = true; } }, 'Close')),
    ...rows);
}

async function scanNetwork(button) {
  if (!document.getElementById('scanResults')) return;
  scanCard('Scanning your network…', h('p', { class: 'ctl-scan-status' }, 'Looking for WLED controllers. This takes a few seconds.'));
  button.disabled = true;
  try {
    const data = await api.get('/api/scan/network', { timeout: 30000 });
    const known = new Set(devices().map(d => d.ip));
    const found = (Array.isArray(data.devices) ? data.devices : []).filter(d => !known.has(d.ip));
    if (!found.length) {
      scanCard('No new controllers found', h('p', { class: 'ctl-scan-status' }, 'Check that the controller is powered and on the same network, or add it by IP address.'));
      return;
    }
    scanCard(`Found ${found.length} controller${found.length === 1 ? '' : 's'}`, ...found.map(d => h('div', { class: 'ctl-scan-row', dataset: { ip: d.ip } },
      h('div', { class: 'ctl-main' },
        h('div', { class: 'ctl-name' }, d.name || 'WLED Controller'),
        h('div', { class: 'ctl-meta' }, h('span', { class: 'ctl-ip' }, d.ip))),
      h('button', { class: 'ui-btn ui-btn-sm ui-btn-primary', type: 'button', onclick: event => addController(d.ip, event.currentTarget) }, 'Add')
    )));
  } catch (err) {
    document.getElementById('scanResults').hidden = true;
    toast.error(err, { onRetry: () => scanNetwork(button) });
  } finally {
    button.disabled = false;
  }
}

function controllerRow(dev) {
  const enabled = dev.enabled !== false;
  const summary = h('span', { class: 'ctl-summary' }, enabled ? 'Checking…' : 'AutoGlow does not use it');
  const dot = h('span', { class: 'status-dot', dataset: { tone: enabled ? 'pending' : 'off' } });
  const pill = h('span', { class: 'status-pill', dataset: { tone: enabled ? 'pending' : 'off' } }, enabled ? 'Checking' : 'Disabled');

  const row = h('a', { class: 'ctl-row', href: detailPath(dev.ip), 'data-link': true, dataset: { ip: dev.ip } },
    dot,
    h('div', { class: 'ctl-main' },
      h('div', { class: 'ctl-name' }, dev.name || 'WLED Controller'),
      h('div', { class: 'ctl-meta' }, h('span', { class: 'ctl-ip' }, dev.ip), summary)),
    pill,
    h('span', { class: 'ctl-chevron', 'aria-hidden': 'true' }, '›'));

  if (enabled) {
    window.pingDeviceCached(dev.ip).then(live => {
      const online = live?.status === 'ok' && live.online === true;
      window.lastFetchedLiveDeviceData[dev.ip] = live;
      const tone = online ? 'ok' : 'error';
      dot.dataset.tone = tone;
      pill.dataset.tone = tone;
      pill.textContent = online ? 'Online' : 'Offline';
      summary.textContent = online ? layoutSummary(live) : 'Not reachable';
    }).catch(() => {
      dot.dataset.tone = 'error';
      pill.dataset.tone = 'error';
      pill.textContent = 'Offline';
      summary.textContent = 'Not reachable';
    });
  }
  return row;
}

function renderList() {
  const host = document.getElementById('controllerList');
  if (!host) return;
  const list = devices();
  host.classList.toggle('is-empty', !list.length);
  host.replaceChildren(...(list.length
    ? list.map(controllerRow)
    : [h('div', { class: 'ctl-empty' },
      h('strong', {}, 'No controllers yet'),
      h('p', {}, 'AutoGlow drives WLED controllers on your network. Scan the network to find them, or add one by its IP address.'))]));
}

// Called by the classic scripts (loadConfig, activatePane) after any controller change
export function renderDevicesTab() {
  const ip = appStore.get().route?.param;
  const listView = document.getElementById('controllerListView');
  if (listView) listView.hidden = Boolean(ip);
  if (ip) {
    openDetail(ip);
  } else {
    closeDetail();
    renderList();
  }
}

export function initControllers() {
  window.renderDevicesTab = renderDevicesTab;
  initControllerDetail();

  const addBtn = document.getElementById('btnAddController');
  addBtn?.addEventListener('click', () => promptAdd(addBtn));
  const scanBtn = document.getElementById('btnScanNetwork');
  scanBtn?.addEventListener('click', () => scanNetwork(scanBtn));
}
