// AutoGlow 2 - Controller Editor (WLED outputs & segments)

function updateInlineDeviceName(ip, inputElem) {
  const clean = sanitizeWledName(inputElem.value);
  if (inputElem.value !== clean) {
    inputElem.value = clean;
    showToast("Special characters (quotes, apostrophes, etc.) are blocked for WLED compatibility.", "warning");
  }
  if (inlineEditingDevices[ip]) {
    inlineEditingDevices[ip].name = clean;
  }
}

// --- Inline Editing State ---
let activeEditingDeviceIp = null;
let inlineEditingDevices = {};

const WLED_OUTPUT_TYPES = [
  { value: 22, label: "RGB strip (WS281x)" },
  { value: 41, label: "Light strip (PWM)" }
];

const WLED_COLOR_ORDERS = [
  { value: 0, label: "GRB" },
  { value: 1, label: "RGB" },
  { value: 2, label: "BRG" },
  { value: 3, label: "RBG" },
  { value: 4, label: "BGR" },
  { value: 5, label: "GBR" }
];

// --- Devices Tab (Multi-Device Management with Seamless In-Place Editing) ---
function getEditingControllerIp() {
  return activeEditingDeviceIp;
}

// --- Controller drawer of Setup › Controllers ---
// Two tabs: outputs & segments (rendered here) and idle lighting (web/js/power.js).
// The controller list itself is web/js/features/controllers.js; renderDevicesTab() re-renders both.
let activeDrawerTab = 'layout';

function setControllerDrawerTab(tab) {
  activeDrawerTab = tab === 'idle' ? 'idle' : 'layout';
  syncDrawerTabs();
}

function syncDrawerTabs() {
  const ip = activeEditingDeviceIp;
  document.querySelectorAll('#controllerDrawer [data-drawer-tab]').forEach(btn => {
    btn.setAttribute('aria-selected', String(btn.dataset.drawerTab === activeDrawerTab));
  });
  const layoutPanel = document.getElementById('controllerDrawerBody');
  const idlePanel = document.getElementById('controllerIdlePanel');
  if (layoutPanel) layoutPanel.hidden = activeDrawerTab !== 'layout';
  if (idlePanel) idlePanel.hidden = activeDrawerTab !== 'idle';
  // Load the idle lighting the first time its tab is shown for this controller
  if (ip && activeDrawerTab === 'idle' && idlePresetState.ip !== ip) {
    resetIdleLighting();
    loadIdlePresetForSelectedDevice(ip);
  }
}

function renderControllerEditor() {
  const drawer = document.getElementById('controllerDrawer');
  const body = document.getElementById('controllerDrawerBody');
  if (!drawer || !body) return;
  const dev = (Array.isArray(appState.devices) ? appState.devices : []).find(d => d.ip === activeEditingDeviceIp);
  if (!dev) {
    activeEditingDeviceIp = null;
    activeDrawerTab = 'layout';
    drawer.hidden = true;
    body.replaceChildren();
    if (idlePresetState.ip) resetIdleLighting();
    return;
  }
  drawer.hidden = false;
  syncDrawerTabs();

  const safeIp = (dev.ip || '').replace(/[^a-zA-Z0-9]/g, '_');
  const ipEscaped = escapeJsString(dev.ip);
  const port = dev.udp_port || dev.port || 21324;

  const editData = inlineEditingDevices[dev.ip] || {
    name: dev.name || 'WLED Controller',
    port: port,
    bri: 255,
    hw_ins: [
      { pin: 33, type: 22, start: 0, len: 45, order: 1, rev: false, skip: 0 },
      { pin: 16, type: 41, start: 45, len: 1, order: 1, rev: false, skip: 0 }
    ],
    segments: [
      { id: 0, name: 'Segment 0', start: 0, stop: 15, on: true, bri: 255 },
      { id: 1, name: 'Segment 1', start: 15, stop: 45, on: true, bri: 200 },
      { id: 2, name: 'Segment 2', start: 45, stop: 46, on: true, bri: 255 }
    ]
  };

  const renderedGroups = editData.hw_ins.map((h, busIdx) => {
    const busStart = parseInt(h.start, 10) || 0;
    const busLen = parseInt(h.len, 10) || 1;
    const busEnd = busStart + busLen;
    const pinVal = Array.isArray(h.pin) ? (h.pin[0] !== undefined ? h.pin[0] : (busIdx === 0 ? 33 : 16)) : (h.pin !== undefined ? h.pin : (busIdx === 0 ? 33 : 16));

    // Check if this GPIO pin is duplicate across outputs
    const isDuplicatePin = editData.hw_ins.some((otherH, oIdx) => {
      if (oIdx === busIdx) return false;
      const otherPin = Array.isArray(otherH.pin) ? otherH.pin[0] : (parseInt(otherH.pin, 10) || 0);
      return otherPin === pinVal;
    });

    const isPwm = (parseInt(h.type, 10) === 41 || String(h.type).toLowerCase().includes('pwm'));
    let busSegments = editData.segments.filter(s => s.busIdx === busIdx || (s.busIdx === undefined && s.start >= busStart && s.start < busEnd));
    if (isPwm && busSegments.length > 1) {
      busSegments = [busSegments[0]];
    }
    const channelClass = isPwm ? 'hw-channel hw-channel-pwm' : 'hw-channel hw-channel-rgb';
    const gpioBadgeClass = isPwm ? 'badge-gpio-pwm' : 'badge-gpio-rgb';
    const badgeBg = isPwm ? 'rgba(245,158,11,0.08)' : 'rgba(var(--accent-rgb), 0.08)';
    const badgeColor = isPwm ? '#f59e0b' : 'var(--accent-primary)';
    const badgeBorder = isPwm ? 'rgba(245,158,11,0.25)' : 'rgba(var(--accent-rgb), 0.25)';

    const segRows = busSegments.map(s => {
      const globalIdx = editData.segments.indexOf(s);
      const segNameEscaped = escapeHtml(s.name || `Segment ${s.id}`);

      if (isPwm) {
        // Locked 1-LED Range for PWM White
        return `
          <div class="seg-row" style="background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.03); padding: 3px 6px; border-radius: 3px; display: flex; justify-content: space-between; align-items: center; font-size: 11px;">
            <div style="display: flex; align-items: center; gap: 4px; flex: 1; overflow: hidden;">
              <span style="color: var(--text-muted); font-size: 10px; font-weight: 600;">#${s.id !== undefined ? s.id : globalIdx}</span>
              <input type="text" style="font-family: var(--font-mono); font-size: 11px; font-weight: 500; color: var(--text-primary); background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08); border-radius: 2px; padding: 1px 5px; height: 20px; width: 100px; flex: 1; max-width: 140px;" value="${segNameEscaped}" oninput="updateInlineSegmentField('${ipEscaped}', ${globalIdx}, 'name', this.value, this)" placeholder="Segment Name">
            </div>
            <div style="display: flex; align-items: center; gap: 6px; font-size: 10.5px; flex-shrink: 0;">
              <div style="display: inline-flex; align-items: center; gap: 3px; background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.22); border-radius: 3px; padding: 1px 6px; font-family: var(--font-mono); font-size: 10px; color: #f59e0b; font-weight: 600;" title="A regular light strip on one channel. WLED counts it as LED ${s.start} after the RGB strip.">
                <span>Light strip (auto)</span>
              </div>
              <button class="btn-ide" onclick="removeInlineSegment('${ipEscaped}', ${globalIdx}, this)" style="color: var(--status-danger); border: 1px solid rgba(239,68,68,0.3); background: rgba(239,68,68,0.06); font-size: 11px; font-weight: 700; width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border-radius: 3px; cursor: pointer;" title="Remove segment">✕</button>
            </div>
          </div>
        `;
      }

      // Editable Range for WS281x Addressable Strip
      const len = Math.max(0, (parseInt(s.stop, 10) || 0) - (parseInt(s.start, 10) || 0));
      return `
        <div class="seg-row" style="background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.03); padding: 3px 6px; border-radius: 3px; display: flex; justify-content: space-between; align-items: center; font-size: 11px;">
          <div style="display: flex; align-items: center; gap: 4px; flex: 1; overflow: hidden;">
            <span style="color: var(--text-muted); font-size: 10px; font-weight: 600;">#${s.id !== undefined ? s.id : globalIdx}</span>
            <input type="text" style="font-family: var(--font-mono); font-size: 11px; font-weight: 500; color: var(--text-primary); background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08); border-radius: 2px; padding: 1px 5px; height: 20px; width: 100px; flex: 1; max-width: 140px;" value="${segNameEscaped}" oninput="updateInlineSegmentField('${ipEscaped}', ${globalIdx}, 'name', this.value, this)" placeholder="Segment Name">
          </div>
          <div style="display: flex; align-items: center; gap: 6px; font-size: 10.5px; flex-shrink: 0;">
            <div style="display: flex; align-items: center; gap: 2px;" title="LEDs are counted from 1 and both ends are included">
              <span style="color: var(--text-muted); font-size: 10px;">LEDs</span>
              <input type="text" inputmode="numeric" pattern="[0-9]*" style="width: 32px; height: 18px; font-size: 10.5px; font-family: var(--font-mono); background: rgba(0,0,0,0.3); border: 1px solid var(--border-subtle); border-radius: 2px; color: var(--text-primary); padding: 0 2px; text-align: center;" value="${(s.start || 0) + 1}" oninput="updateInlineSegmentField('${ipEscaped}', ${globalIdx}, 'start', Math.max(0, (parseInt(this.value, 10) || 1) - 1))">
              <span style="color: var(--text-muted); font-size: 10px;">–</span>
              <input type="text" inputmode="numeric" pattern="[0-9]*" style="width: 32px; height: 18px; font-size: 10.5px; font-family: var(--font-mono); background: rgba(0,0,0,0.3); border: 1px solid var(--border-subtle); border-radius: 2px; color: var(--text-primary); padding: 0 2px; text-align: center;" value="${s.stop || 0}" oninput="updateInlineSegmentField('${ipEscaped}', ${globalIdx}, 'stop', parseInt(this.value, 10) || 0)">
              <span id="inline-seg-len-${safeIp}-${globalIdx}" style="color: var(--text-muted); font-size: 10px; margin-left: 2px;">(${len})</span>
            </div>
            <button class="btn-ide" onclick="removeInlineSegment('${ipEscaped}', ${globalIdx}, this)" style="color: var(--status-danger); border: 1px solid rgba(239,68,68,0.3); background: rgba(239,68,68,0.06); font-size: 11px; font-weight: 700; width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border-radius: 3px; cursor: pointer;" title="Remove segment">✕</button>
          </div>
        </div>
      `;
    }).join('');

    const isLastOutput = (busIdx === editData.hw_ins.length - 1) && (editData.hw_ins.length > 1);
    const removeOutputBtn = isLastOutput 
      ? `<button class="btn-ide" onclick="removeInlineHwOutput('${ipEscaped}', ${busIdx}, this)" style="height: 22px; font-size: 10.5px; font-weight: 600; padding: 0 8px; color: var(--status-danger); border: 1px solid rgba(239,68,68,0.35); background: rgba(239,68,68,0.08); border-radius: 3px; display: inline-flex; align-items: center; gap: 4px; cursor: pointer;" title="Delete this hardware GPIO output (outputs must be removed in reverse order: last to first)">✕ Delete GPIO</button>` 
      : '';

    const lengthControl = isPwm
      ? `<div style="display: inline-flex; align-items: center; background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.25); border-radius: 3px; padding: 1px 6px; gap: 3px;" title="A light strip output is one channel: on/off and dimming">
          <span style="color: #f59e0b; font-size: 10px; font-weight: 600; font-family: var(--font-mono);">1 channel</span>
        </div>`
      : `<div style="display: inline-flex; align-items: center; background: rgba(0,0,0,0.25); border: 1px solid var(--border-subtle); border-radius: 3px; padding: 1px 5px; gap: 4px;" title="Hardware output total strip length (LEDs)">
          <span style="color: var(--text-muted); font-size: 10px; font-family: var(--font-mono);">Length:</span>
          <input type="text" id="inline-hw-len-${safeIp}-${busIdx}" inputmode="numeric" pattern="[0-9]*" style="width: 34px; height: 16px; font-size: 10.5px; font-weight: 600; color: var(--text-primary); background: transparent; border: none; outline: none; font-family: var(--font-mono); text-align: center; padding: 0;" value="${h.len || 1}" oninput="updateInlineHwField('${ipEscaped}', ${busIdx}, 'len', parseInt(this.value, 10) || 1)" placeholder="1">
          <span style="color: var(--text-muted); font-size: 10px; font-family: var(--font-mono);">LEDs</span>
        </div>`;

    const addSegBtn = isPwm
      ? ''
      : `<button class="btn-ide" onclick="addInlineSegmentToBus('${ipEscaped}', ${busIdx})" style="height: 22px; font-size: 11px; font-weight: 600; padding: 0 8px; color: var(--accent-primary); border: 1px solid rgba(var(--accent-rgb), 0.35); background: rgba(var(--accent-rgb), 0.06); border-radius: 3px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer;" title="Add segment to this GPIO">+ Seg</button>`;

    return `
      <div class="${channelClass}" style="background: rgba(0, 0, 0, 0.22); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); overflow: hidden; display: flex; flex-direction: column; position: relative; margin-bottom: 4px;">
        <div class="hw-header" style="background: rgba(255, 255, 255, 0.02); padding: 5px 8px; border-bottom: 1px solid rgba(255, 255, 255, 0.05); display: flex; justify-content: space-between; align-items: center; font-family: var(--font-mono); font-size: 11px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <div class="${gpioBadgeClass}" style="background: ${badgeBg}; color: ${badgeColor}; border: 1px solid ${badgeBorder}; font-weight: 600; font-size: 10px; padding: 1px 5px; border-radius: 3px; font-family: var(--font-mono); display: inline-flex; align-items: center; gap: 3px;" title="${isDuplicatePin ? 'Duplicate GPIO Pin! Each output requires a unique GPIO.' : 'GPIO Pin'}">
              <span>GPIO</span>
              <input type="text" inputmode="numeric" pattern="[0-9]*" style="width: 24px; height: 16px; font-size: 10.5px; font-weight: 700; color: inherit; background: rgba(0,0,0,0.25); border: none; border-radius: 2px; outline: none; font-family: var(--font-mono); text-align: center; padding: 0;" value="${pinVal}" oninput="updateInlineHwField('${ipEscaped}', ${busIdx}, 'pin', parseInt(this.value, 10) || 0)">
            </div>
            <select class="form-control" style="width: auto; height: 22px; padding: 0 6px; font-size: 10.5px; font-weight: 500; color: var(--text-primary); background: var(--bg-input); border: 1px solid var(--border-subtle); color-scheme: dark;" onchange="updateInlineHwField('${ipEscaped}', ${busIdx}, 'type', parseInt(this.value, 10))">
              <option value="22" ${h.type === 22 ? 'selected' : ''} style="background-color: #1a1b20; color: #f4f4f5;">RGB strip (WS281x)</option>
              <option value="41" ${h.type === 41 ? 'selected' : ''} style="background-color: #1a1b20; color: #f4f4f5;">Light strip (PWM)</option>
            </select>
            ${!isPwm ? `
              <select class="form-control" style="width: auto; height: 22px; padding: 0 6px; font-size: 10.5px; font-weight: 600; color: var(--text-primary); background: var(--bg-input); border: 1px solid var(--border-subtle); color-scheme: dark;" onchange="updateInlineHwField('${ipEscaped}', ${busIdx}, 'order', parseInt(this.value, 10))" title="Color Order">
                ${WLED_COLOR_ORDERS.map(co => `<option value="${co.value}" ${(h.order !== undefined ? h.order : 0) === co.value ? 'selected' : ''} style="background-color: #1a1b20; color: #f4f4f5;">${co.label}</option>`).join('')}
              </select>
            ` : ''}
            ${lengthControl}
            ${isDuplicatePin ? '<span style="color: var(--status-danger); font-size: 9.5px; font-weight: 600;">Duplicate GPIO</span>' : ''}
          </div>

          <div style="display: flex; align-items: center; gap: 6px;">
            ${addSegBtn}
            ${removeOutputBtn}
          </div>
        </div>

        <div class="hw-body" style="padding: 5px 6px; display: flex; flex-direction: column; gap: 3px;">
          ${busSegments.length > 0 ? segRows : '<div style="color: var(--text-muted); font-size: 10px; font-family: var(--font-mono); padding: 2px;">No segments on this output. Click <strong>+ Seg</strong>.</div>'}
        </div>
      </div>
    `;
  }).join('');

  const devNameEscaped = escapeHtml(editData.name || '');
  body.innerHTML = `
    <div class="configured-wled-card" id="wled-card-${safeIp}" style="padding: 12px 14px; background: var(--bg-card); border-radius: var(--radius-sm); border: 1px solid rgba(var(--accent-rgb), 0.4); box-shadow: 0 0 14px rgba(var(--accent-rgb), 0.08); display: flex; flex-direction: column; gap: 8px;">
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <input type="text" class="form-control" style="font-family: var(--font-mono); font-size: 13px; font-weight: 700; color: var(--text-primary); background: rgba(0,0,0,0.3); border: 1px solid var(--border-subtle); padding: 2px 6px; height: 24px; width: 170px;" value="${devNameEscaped}" oninput="updateInlineDeviceName('${ipEscaped}', this)" placeholder="Controller Name">
        </div>
        <div style="display: flex; align-items: center; gap: 6px;">
          <button class="btn-ide" onclick="cancelInlineEdit('${ipEscaped}')" style="font-size: 10.5px; padding: 2px 8px;">Cancel</button>
          <button class="btn-ide btn-ide-primary" id="btnSaveInline-${safeIp}" onclick="saveInlineEdit('${ipEscaped}')" style="font-size: 10.5px; padding: 2px 10px; font-weight: 600;">✓ Save</button>
        </div>
      </div>

      <div class="ctl-editor-outputs">
        <div style="display: flex; flex-direction: column; gap: 5px; font-family: var(--font-mono); font-size: 11px;">
          <div id="segments-container-${safeIp}" style="display: flex; flex-direction: column; gap: 4px;">
            ${renderedGroups}
          </div>
          <div style="display: flex; justify-content: flex-end; margin-top: 3px;">
            <button class="btn-ide" onclick="addInlineHwOutput('${ipEscaped}')" style="font-size: 10px; padding: 2px 8px; color: var(--accent-primary); border-color: rgba(var(--accent-rgb), 0.3); font-weight: 500;" title="Add new physical GPIO output">+ Add Output</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

// Helper to reconstruct hw_ins from a list of segments
function deriveHwOutputsFromSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return [];
  const groupMap = new Map();
  segments.forEach(s => {
    const gpioStr = s.gpio || (String(s.type).toLowerCase().includes('pwm') ? 'GPIO 16' : 'GPIO 33');
    const pinNum = parseInt(String(gpioStr).replace(/\D/g, ''), 10) || (String(s.type).toLowerCase().includes('pwm') ? 16 : 33);
    const isPwm = String(s.type || '').toLowerCase().includes('pwm');
    const key = `${pinNum}_${isPwm ? 41 : 22}`;
    const sStart = parseInt(s.start, 10) || 0;
    const sStop = parseInt(s.stop, 10) || (sStart + (parseInt(s.length || s.len, 10) || 1));
    const sLen = Math.max(1, sStop - sStart);

    if (!groupMap.has(key)) {
      groupMap.set(key, {
        pin: pinNum,
        type: isPwm ? 41 : 22,
        start: sStart,
        len: sLen,
        order: 0,
        rev: false,
        skip: 0
      });
    } else {
      const g = groupMap.get(key);
      if (sStart < g.start) {
        g.len += (g.start - sStart);
        g.start = sStart;
      }
      if (sStop > (g.start + g.len)) {
        g.len = sStop - g.start;
      }
    }
  });
  return Array.from(groupMap.values()).sort((a, b) => a.start - b.start);
}

// --- Inline Device Edit Action Functions ---
async function startInlineDeviceEdit(ip) {
  const liveCachedCheck = lastFetchedLiveDeviceData[ip];
  if (liveCachedCheck && liveCachedCheck.status === 'ok' && liveCachedCheck.online === false) {
    showToast(`Cannot edit ${ip}: Controller is offline.`, 'warning');
    return;
  }
  activeEditingDeviceIp = ip;
  const localDev = Array.isArray(appState.devices) ? appState.devices.find(d => d.ip === ip) : null;
  const liveCached = lastFetchedLiveDeviceData[ip];
  
  // 1. Determine Initial Hardware Outputs
  let initialHw = [];
  if (liveCached?.hw_ins && Array.isArray(liveCached.hw_ins) && liveCached.hw_ins.length > 0) {
    initialHw = liveCached.hw_ins.map(h => ({
      pin: Array.isArray(h.pin) && h.pin.length > 0 ? h.pin[0] : (typeof h.pin === 'number' ? h.pin : 33),
      type: h.type !== undefined ? h.type : 22,
      start: h.start !== undefined ? h.start : 0,
      len: h.len !== undefined ? h.len : 45,
      order: h.order !== undefined ? h.order : 0,
      rev: h.rev || false,
      skip: h.skip || 0
    }));
  } else if (localDev?.hw_ins && Array.isArray(localDev.hw_ins) && localDev.hw_ins.length > 0) {
    initialHw = JSON.parse(JSON.stringify(localDev.hw_ins));
  } else if (liveCached?.segments && Array.isArray(liveCached.segments) && liveCached.segments.length > 0) {
    initialHw = deriveHwOutputsFromSegments(liveCached.segments);
  } else if (localDev?.segments && Array.isArray(localDev.segments) && localDev.segments.length > 0) {
    initialHw = deriveHwOutputsFromSegments(localDev.segments);
  }
  
  if (!initialHw || initialHw.length === 0) {
    const rgbLen = localDev?.rgb_count || 45;
    initialHw = [
      { pin: 33, type: 22, start: 0, len: rgbLen, order: 0, rev: false, skip: 0 }
    ];
    if (localDev?.pwm_index && localDev.pwm_index > 0 && localDev.pwm_index > rgbLen) {
      initialHw.push({ pin: 16, type: 41, start: localDev.pwm_index, len: 1, order: 0, rev: false, skip: 0 });
    }
  }

  // 2. Determine Initial Segments
  let initialSegs = [];
  if (liveCached?.segments && Array.isArray(liveCached.segments) && liveCached.segments.length > 0) {
    initialSegs = liveCached.segments.map((s, idx) => ({
      id: s.id !== undefined ? s.id : idx,
      name: s.name || `Segment ${s.id !== undefined ? s.id : idx}`,
      start: s.start || 0,
      stop: s.stop !== undefined ? s.stop : (s.start || 0) + (s.length || s.len || 1),
      on: s.on !== undefined ? s.on : true,
      bri: s.bri !== undefined ? s.bri : 255
    }));
  } else if (localDev?.segments && Array.isArray(localDev.segments) && localDev.segments.length > 0) {
    initialSegs = localDev.segments.map((s, idx) => ({
      id: s.id !== undefined ? s.id : idx,
      name: s.name || `Segment ${idx}`,
      start: s.start || 0,
      stop: (s.start || 0) + (s.length || s.len || 1),
      on: s.on !== undefined ? s.on : true,
      bri: s.bri !== undefined ? s.bri : 255
    }));
  } else {
    initialSegs = [
      { id: 0, name: 'Dartboard Ring', start: 0, stop: localDev?.rgb_count || 45, on: true, bri: 255 }
    ];
  }

  inlineEditingDevices[ip] = {
    name: liveCached?.name || localDev?.name || 'WLED Controller',
    port: localDev?.udp_port || localDev?.port || 21324,
    bri: liveCached?.state?.bri !== undefined ? liveCached.state.bri : 255,
    hw_ins: initialHw,
    segments: initialSegs
  };

  recalculateHwAndSegmentOffsets(ip);
  renderDevicesTab();

  try {
    const data = await pingDeviceCached(ip, true);
    lastFetchedLiveDeviceData[ip] = data;
    if (data.status === 'ok' && data.online && activeEditingDeviceIp === ip) {
      if (data.name) inlineEditingDevices[ip].name = data.name;
      if (data.state && data.state.bri !== undefined) inlineEditingDevices[ip].bri = data.state.bri;

      if (Array.isArray(data.hw_ins) && data.hw_ins.length > 0) {
        inlineEditingDevices[ip].hw_ins = data.hw_ins.map(h => ({
          pin: Array.isArray(h.pin) && h.pin.length > 0 ? h.pin[0] : (typeof h.pin === 'number' ? h.pin : 33),
          type: h.type !== undefined ? h.type : 22,
          start: h.start !== undefined ? h.start : 0,
          len: h.len !== undefined ? h.len : 45,
          order: h.order !== undefined ? h.order : 0,
          rev: h.rev || false,
          skip: h.skip || 0
        }));
      } else if (Array.isArray(data.segments) && data.segments.length > 0) {
        // Fallback: derive full hardware output list from live segments so no GPIOs are missed
        inlineEditingDevices[ip].hw_ins = deriveHwOutputsFromSegments(data.segments);
      }

      if (Array.isArray(data.segments) && data.segments.length > 0) {
        inlineEditingDevices[ip].segments = data.segments.map(s => ({
          id: s.id,
          name: s.name || `Segment ${s.id}`,
          start: s.start || 0,
          stop: s.stop || 0,
          on: s.on !== undefined ? s.on : true,
          bri: s.bri !== undefined ? s.bri : 255
        }));
      }
      recalculateHwAndSegmentOffsets(ip);
      renderDevicesTab();
    } else if (activeEditingDeviceIp === ip) {
      renderDevicesTab();
    }
  } catch (e) {
    console.warn(`[AutoGlow] Inline edit live sync failed for ${ip}:`, e);
    if (activeEditingDeviceIp === ip) {
      lastFetchedLiveDeviceData[ip] = { status: 'error', online: false };
      renderDevicesTab();
    }
  }
}

function cancelInlineEdit(ip) {
  delete inlineEditingDevices[ip];
  delete activeInlineEdits[ip];
  activeEditingDeviceIp = null;
  renderDevicesTab();
}

function recalculateHwAndSegmentOffsets(ip) {
  if (!inlineEditingDevices[ip]) return;
  const dev = inlineEditingDevices[ip];
  const hwList = dev.hw_ins || [];
  const segList = dev.segments || [];

  // 1. Assign busIdx to any segments missing it based on original start offset
  segList.forEach(s => {
    if (s.busIdx === undefined) {
      const sStart = parseInt(s.start, 10) || 0;
      let matchedBus = 0;
      hwList.forEach((hw, bIdx) => {
        const bStart = parseInt(hw.start, 10) || 0;
        const bLen = Math.max(1, parseInt(hw.len, 10) || 1);
        if (sStart >= bStart && sStart < (bStart + bLen)) {
          matchedBus = bIdx;
        }
      });
      s.busIdx = matchedBus;
    }
  });

  // AUTO-SYNC RULE: Hardware strip length always dynamically syncs (expands AND shrinks)
  // to match the exact maximum stop position across all its segments!
  hwList.forEach((hw, bIdx) => {
    const isPwm = (parseInt(hw.type, 10) === 41 || String(hw.type).toLowerCase().includes('pwm'));
    if (isPwm) {
      hw.len = 1;
    } else {
      const busSegs = segList.filter(s => s.busIdx === bIdx);
      if (busSegs.length > 0) {
        const bStart = parseInt(hw.start, 10) || 0;
        const maxRelStop = Math.max(...busSegs.map(s => {
          const sStop = parseInt(s.stop, 10) || 0;
          const sStart = parseInt(s.start, 10) || 0;
          if (sStop > bStart) {
            return sStop - bStart;
          }
          return Math.max(1, sStop - sStart);
        }));
        hw.len = Math.max(1, maxRelStop);
      } else if (!hw.len || hw.len < 1) {
        hw.len = 45;
      }
    }
  });

  // 2. Sequential offset ripple across all hardware channels
  let cumStart = 0;
  const newSegList = [];

  hwList.forEach((hw, bIdx) => {
    const isPwm = (parseInt(hw.type, 10) === 41 || String(hw.type).toLowerCase().includes('pwm'));
    if (isPwm) {
      hw.len = 1;
    }
    const newBusLen = Math.max(1, parseInt(hw.len, 10) || 1);
    const newBusStart = cumStart;
    const newBusEnd = newBusStart + newBusLen;
    const oldBusStart = parseInt(hw.start, 10) || 0;
    const delta = newBusStart - oldBusStart;

    hw.start = newBusStart;
    cumStart += newBusLen;

    const busSegs = segList.filter(s => s.busIdx === bIdx);

    if (isPwm) {
      // PWM White: exactly 1 segment locked to [newBusStart, newBusEnd]
      const existing = busSegs[0];
      const pinVal = Array.isArray(hw.pin) ? hw.pin[0] : hw.pin;
      newSegList.push({
        busIdx: bIdx,
        id: 0,
        name: existing?.name || `Light strip (GPIO ${pinVal})`,
        start: newBusStart,
        stop: newBusEnd,
        on: existing?.on !== undefined ? existing.on : true,
        bri: existing?.bri !== undefined ? existing.bri : 255
      });
    } else {
      // WS281x Addressable Strip
      if (busSegs.length === 0) {
        const pinVal = Array.isArray(hw.pin) ? hw.pin[0] : hw.pin;
        newSegList.push({
          busIdx: bIdx,
          id: 0,
          name: `RGB strip (GPIO ${pinVal})`,
          start: newBusStart,
          stop: newBusEnd,
          on: true,
          bri: 255
        });
      } else {
        busSegs.forEach(s => {
          let sStart = (parseInt(s.start, 10) || 0) + delta;
          let sStop = (parseInt(s.stop, 10) || 0) + delta;

          if (isNaN(sStart) || sStart < newBusStart) sStart = newBusStart;
          if (isNaN(sStop) || sStop <= sStart || sStop > newBusEnd) sStop = newBusEnd;

          sStart = Math.max(newBusStart, Math.min(sStart, newBusEnd - 1));
          sStop = Math.max(sStart + 1, Math.min(sStop, newBusEnd));

          newSegList.push({
            busIdx: bIdx,
            id: 0,
            name: s.name || `Segment`,
            start: sStart,
            stop: sStop,
            on: s.on !== undefined ? s.on : true,
            bri: s.bri !== undefined ? s.bri : 255
          });
        });
      }
    }
  });

  // Re-index all segment IDs sequentially
  newSegList.forEach((s, idx) => {
    s.id = idx;
  });

  dev.segments = newSegList;
}

function updateInlineHwField(ip, busIdx, field, val) {
  if (inlineEditingDevices[ip] && inlineEditingDevices[ip].hw_ins[busIdx]) {
    if (field === 'pin') {
      const pinNum = parseInt(val, 10) || 0;
      const hwList = inlineEditingDevices[ip].hw_ins;
      const duplicateExists = hwList.some((h, idx) => {
        if (idx === busIdx) return false;
        const otherPin = Array.isArray(h.pin) ? h.pin[0] : (parseInt(h.pin, 10) || 0);
        return otherPin === pinNum;
      });
      if (duplicateExists) {
        showToast(`GPIO ${pinNum} is already assigned to another output!`, 'warning');
      }
      inlineEditingDevices[ip].hw_ins[busIdx].pin = pinNum;
    } else if (field === 'type') {
      const typeNum = parseInt(val, 10) || 22;
      inlineEditingDevices[ip].hw_ins[busIdx].type = typeNum;
      const busSegs = (inlineEditingDevices[ip].segments || []).filter(s => (s.busIdx !== undefined ? s.busIdx : 0) === busIdx);
      const pinVal = Array.isArray(inlineEditingDevices[ip].hw_ins[busIdx].pin) 
        ? inlineEditingDevices[ip].hw_ins[busIdx].pin[0] 
        : inlineEditingDevices[ip].hw_ins[busIdx].pin;
      if (typeNum === 41) {
        inlineEditingDevices[ip].hw_ins[busIdx].len = 1;
        if (busSegs.length > 0) {
          busSegs[0].name = `Light strip (GPIO ${pinVal})`;
        }
      } else {
        if (!inlineEditingDevices[ip].hw_ins[busIdx].len || inlineEditingDevices[ip].hw_ins[busIdx].len <= 1) {
          inlineEditingDevices[ip].hw_ins[busIdx].len = 45;
        }
        if (busSegs.length > 0) {
          busSegs.forEach(s => {
            if (/pwm|light strip/.test(String(s.name || '').toLowerCase())) {
              s.name = `RGB strip (GPIO ${pinVal})`;
            }
          });
        }
      }
      recalculateHwAndSegmentOffsets(ip);
    } else if (field === 'order') {
      const orderNum = parseInt(val, 10);
      inlineEditingDevices[ip].hw_ins[busIdx].order = !isNaN(orderNum) ? orderNum : 1;
    } else if (field === 'len') {
      const newLen = Math.max(1, parseInt(val, 10) || 1);
      inlineEditingDevices[ip].hw_ins[busIdx].len = newLen;
      recalculateHwAndSegmentOffsets(ip);
    } else {
      inlineEditingDevices[ip].hw_ins[busIdx][field] = val;
    }
    renderDevicesTab();
  }
}

function addInlineHwOutput(ip) {
  if (!inlineEditingDevices[ip]) return;
  const hwList = inlineEditingDevices[ip].hw_ins;
  let nextStart = 0;
  if (hwList.length > 0) {
    const last = hwList[hwList.length - 1];
    nextStart = (parseInt(last.start, 10) || 0) + (parseInt(last.len, 10) || 1);
  }

  // Find set of all GPIO pins currently used on this controller
  const usedPins = new Set(
    hwList.map(h => Array.isArray(h.pin) ? h.pin[0] : (parseInt(h.pin, 10) || 0))
  );

  // Common ESP32 GPIO candidate pins for WLED
  const candidatePins = [16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 4, 5, 12, 13, 14, 15];
  let newPin = candidatePins.find(p => !usedPins.has(p));
  if (newPin === undefined) {
    for (let p = 1; p <= 39; p++) {
      if (!usedPins.has(p)) {
        newPin = p;
        break;
      }
    }
  }
  if (newPin === undefined) newPin = 17;

  hwList.push({
    pin: newPin,
    type: 41, // Default to PWM White
    start: nextStart,
    len: 1,
    order: 0,
    rev: false,
    skip: 0
  });

  recalculateHwAndSegmentOffsets(ip);
  renderDevicesTab();
}

function removeInlineHwOutput(ip, busIdx) {
  if (inlineEditingDevices[ip] && inlineEditingDevices[ip].hw_ins) {
    inlineEditingDevices[ip].hw_ins.splice(busIdx, 1);
    recalculateHwAndSegmentOffsets(ip);
    renderDevicesTab();
  }
}

function addInlineSegmentToBus(ip, busIdx) {
  if (!inlineEditingDevices[ip]) return;
  const hw = inlineEditingDevices[ip].hw_ins[busIdx];
  if (!hw) return;
  const isPwm = (parseInt(hw.type, 10) === 41 || String(hw.type).toLowerCase().includes('pwm'));
  if (isPwm) {
    showToast('A light strip is a single channel, so it has one segment.', 'warning');
    return;
  }
  const busStart = parseInt(hw.start, 10) || 0;
  const busLen = Math.max(1, parseInt(hw.len, 10) || 1);
  const busEnd = busStart + busLen;
  const segs = inlineEditingDevices[ip].segments || [];

  // Find all existing segment indices on this specific GPIO bus
  const busSegIndices = [];
  segs.forEach((s, idx) => {
    const sStart = parseInt(s.start, 10) || 0;
    if (sStart >= busStart && sStart < busEnd) {
      busSegIndices.push(idx);
    }
  });

  let newStart = busStart;
  let newStop = busEnd;

  if (busLen === 1) {
    // 1-LED channel (e.g. PWM White)
    newStart = busStart;
    newStop = busEnd;
  } else {
    // Multi-LED channel (e.g. WS281x 45 LEDs)
    if (busSegIndices.length > 0) {
      const lastBusSeg = segs[busSegIndices[busSegIndices.length - 1]];
      const lastStop = parseInt(lastBusSeg.stop, 10) || busStart;
      if (lastStop < busEnd) {
        newStart = lastStop;
        newStop = busEnd;
      } else {
        newStart = busStart;
        newStop = busEnd;
      }
    } else {
      newStart = busStart;
      newStop = busEnd;
    }
  }

  // Ensure newStart is strictly within [busStart, busEnd - 1] and newStop <= busEnd
  newStart = Math.max(busStart, Math.min(newStart, busEnd - 1));
  newStop = Math.max(newStart + 1, Math.min(newStop, busEnd));

  const insertIndex = busSegIndices.length > 0 
    ? (busSegIndices[busSegIndices.length - 1] + 1) 
    : segs.length;

  const newSeg = {
    busIdx: busIdx,
    id: 0,
    name: `Segment ${segs.length}`,
    start: newStart,
    stop: newStop,
    on: true,
    bri: 255
  };

  segs.splice(insertIndex, 0, newSeg);
  // Re-index all segment IDs sequentially
  segs.forEach((s, idx) => s.id = idx);

  renderDevicesTab();
}

function updateInlineSegmentField(ip, segIdx, field, val, inputElem = null) {
  if (inlineEditingDevices[ip] && inlineEditingDevices[ip].segments[segIdx]) {
    if (field === 'name') {
      const clean = sanitizeWledName(val);
      if (inputElem && inputElem.value !== clean) {
        inputElem.value = clean;
        showToast("Special characters (quotes, apostrophes, etc.) are blocked for WLED compatibility.", "warning");
      }
      val = clean;
    }
    inlineEditingDevices[ip].segments[segIdx][field] = val;
    if (field === 'start' || field === 'stop') {
      const safeIp = ip.replace(/[^a-zA-Z0-9]/g, '_');
      const seg = inlineEditingDevices[ip].segments[segIdx];
      const sStart = parseInt(seg.start, 10) || 0;
      const sStop = parseInt(seg.stop, 10) || 0;
      const busIdx = seg.busIdx !== undefined ? seg.busIdx : 0;
      const hw = inlineEditingDevices[ip].hw_ins?.[busIdx];

      // Auto-sync rule: Dynamically sync (expand OR shrink) hardware length to highest segment stop
      if (hw) {
        const isPwm = (parseInt(hw.type, 10) === 41 || String(hw.type).toLowerCase().includes('pwm'));
        if (!isPwm) {
          const busSegs = inlineEditingDevices[ip].segments.filter(s => (s.busIdx !== undefined ? s.busIdx : 0) === busIdx);
          const bStart = parseInt(hw.start, 10) || 0;
          const maxStopRel = Math.max(...busSegs.map(s => {
            const segStop = parseInt(s.stop, 10) || 0;
            const segStart = parseInt(s.start, 10) || 0;
            if (segStop > bStart) {
              return segStop - bStart;
            }
            return Math.max(1, segStop - segStart);
          }));
          hw.len = Math.max(1, maxStopRel);
          const hwLenInput = document.getElementById(`inline-hw-len-${safeIp}-${busIdx}`);
          if (hwLenInput) {
            hwLenInput.value = hw.len;
          }
        }
      }

      const lenElem = document.getElementById(`inline-seg-len-${safeIp}-${segIdx}`);
      const len = Math.max(0, sStop - sStart);
      if (lenElem) lenElem.textContent = `(${len})`;
    } else if (field === 'bri') {
      const safeIp = ip.replace(/[^a-zA-Z0-9]/g, '_');
      const briElem = document.getElementById(`inline-seg-bri-val-${safeIp}-${segIdx}`);
      if (briElem) briElem.textContent = val;
    }
  }
}

function removeInlineSegment(ip, segIdx) {
  if (inlineEditingDevices[ip] && inlineEditingDevices[ip].segments) {
    inlineEditingDevices[ip].segments.splice(segIdx, 1);
    recalculateHwAndSegmentOffsets(ip);
    renderDevicesTab();
  }
}

async function saveInlineEdit(ip) {
  if (!inlineEditingDevices[ip]) return;

  // 0. Recalculate hardware channels and segment offsets to ensure 100% mathematical integrity
  recalculateHwAndSegmentOffsets(ip);

  const editData = inlineEditingDevices[ip];
  const safeIp = ip.replace(/[^a-zA-Z0-9]/g, '_');
  const btn = document.getElementById(`btnSaveInline-${safeIp}`);

  // Validation: Check for duplicate GPIO pins across hardware outputs
  const pinList = editData.hw_ins.map(h => Array.isArray(h.pin) ? h.pin[0] : (parseInt(h.pin, 10) || 0));
  const duplicatePin = pinList.find((p, idx) => pinList.indexOf(p) !== idx);
  if (duplicatePin !== undefined) {
    showToast(`Cannot save: GPIO ${duplicatePin} is assigned to multiple outputs. Each output requires a unique GPIO.`, 'error');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Saving...';
  }

  // 1. Format Hardware Outputs Payload (/json/cfg hw.led.ins)
  const hwInsPayload = editData.hw_ins.map(h => ({
    start: parseInt(h.start, 10) || 0,
    len: parseInt(h.len, 10) || 1,
    pin: [Array.isArray(h.pin) ? (parseInt(h.pin[0], 10) || 0) : (parseInt(h.pin, 10) || 0)],
    type: parseInt(h.type, 10) || 22,
    order: (h.order !== undefined && !isNaN(parseInt(h.order, 10))) ? parseInt(h.order, 10) : 0,
    rev: !!h.rev,
    skip: parseInt(h.skip, 10) || 0
  }));

  // 2. Format Segments Payload (/json/state seg)
  const segPayload = editData.segments.map((s, idx) => ({
    id: idx,
    n: sanitizeWledName(s.name) || `Segment ${idx}`,
    start: parseInt(s.start, 10) || 0,
    stop: parseInt(s.stop, 10) || 0,
    on: s.on !== undefined ? s.on : true,
    bri: s.bri !== undefined ? parseInt(s.bri, 10) : 255
  }));

  try {
    const payload = {
      ip: ip,
      name: editData.name,
      udp_port: editData.port,
      hw_ins: hwInsPayload,
      state: {
        on: true,
        bri: editData.bri,
        seg: segPayload
      }
    };
    const data = await ((await fetch('/api/wled/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })).json());

    if (data.status === 'ok') {
      const dev = appState.devices.find(d => d.ip === ip);
      if (dev) {
        if (editData.name) dev.name = editData.name;
        dev.udp_port = editData.port;
        dev.hw_ins = editData.hw_ins;
        if (hwInsPayload.length > 0) {
          dev.rgb_count = hwInsPayload[0].len;
          const pwmHw = hwInsPayload.find(h => parseInt(h.type, 10) >= 40);
          if (pwmHw) {
            dev.pwm_index = pwmHw.start;
          } else {
            dev.pwm_index = null;
          }
        }
        dev.segments = editData.segments.map((s, idx) => {
          const sStart = parseInt(s.start, 10) || 0;
          const sStop = parseInt(s.stop, 10) || (sStart + 1);
          const isPwm = hwInsPayload.some(h => parseInt(h.type, 10) >= 40 && sStart >= h.start && sStart < (h.start + h.len));
          return {
            id: idx,
            name: s.name,
            type: isPwm ? 'PWM White' : 'WS281x',
            start: sStart,
            length: Math.max(1, sStop - sStart)
          };
        });
      }

      // 1. Clear inline edit state
      delete inlineEditingDevices[ip];
      delete activeInlineEdits[ip];
      activeEditingDeviceIp = null;

      // 2. Invalidate stale cached telemetry so view mode pulls fresh hardware state immediately
      delete lastFetchedLiveDeviceData[ip];
      if (typeof pingDeviceCached === 'function') {
        try {
          await pingDeviceCached(ip, true);
        } catch (e) {
          console.warn(`[AutoGlow] Post-save ping check failed for ${ip}:`, e);
        }
      }

      // 3. Save active configuration
      await saveAllConfig();

      // 4. Reload configuration and re-render all dependent components
      if (typeof loadConfig === 'function') {
        await loadConfig();
      } else {
        renderDevicesTab();
      }

      if (typeof renderEffectsTable === 'function') renderEffectsTable();
      if (typeof renderPowerTab === 'function') renderPowerTab();

      showToast(data.hardware_applied ? `✓ Applied changes to WLED (${ip})` : `✓ Saved settings (device offline)`, 'success');
    } else {
      showToast(`Failed to update: ${data.message || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    showToast(`Error saving changes: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '✓ Save to WLED';
    }
  }
}


if (typeof window !== "undefined") {
  window.renderControllerEditor = renderControllerEditor;
  window.getEditingControllerIp = getEditingControllerIp;
  window.setControllerDrawerTab = setControllerDrawerTab;
  window.updateInlineDeviceName = updateInlineDeviceName;
  window.startInlineDeviceEdit = startInlineDeviceEdit;
  window.cancelInlineEdit = cancelInlineEdit;
  window.saveInlineEdit = saveInlineEdit;
  window.addInlineHwOutput = addInlineHwOutput;
  window.removeInlineHwOutput = removeInlineHwOutput;
  window.addInlineSegmentToBus = addInlineSegmentToBus;
  window.updateInlineSegmentField = updateInlineSegmentField;
  window.removeInlineSegment = removeInlineSegment;
}


