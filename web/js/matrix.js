// AutoGlow 2 - Event Matrix & Effect Bindings Module

// --- Event Matrix Tab ---

// Toggle the Event Matrix submenu open/closed in the sidebar nav
function toggleMatrixSubmenu(e) {
  e.preventDefault();
  const group = document.getElementById('navMatrixGroup');
  if (!group) return;
  
  // Clicking the parent button sets selectedMatrixDeviceIp to null to show device selection landing
  selectedMatrixDeviceIp = null;
  selectedMatrixSegmentId = null;
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('autoglow_selected_matrix_device');
  }

  group.classList.add('open');
  const powerGroup = document.getElementById('navPowerGroup');
  if (powerGroup) powerGroup.classList.remove('open');

  renderMatrixSubmenu();
  switchToTab('tab-effects');
  
  // Ensure the parent nav-item is highlighted
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  const navEffects = document.getElementById('navEffects');
  if (navEffects) navEffects.classList.add('active');

  if (window.location.pathname !== '/matrix') {
    window.history.pushState({ tab: 'tab-effects' }, '', '/matrix');
  }
}

// Populate device sub-items under the Event Matrix nav item
function renderMatrixSubmenu() {
  const submenu = document.getElementById('matrixDeviceSubmenu');
  if (!submenu) return;

  const devicesList = Array.isArray(appState.devices) ? appState.devices : [];

  if (devicesList.length === 0) {
    submenu.innerHTML = `
      <div style="color: var(--text-muted); font-family: var(--font-mono); font-size: 10px; padding: 6px 20px;">
        No devices configured
      </div>
    `;
    return;
  }

  submenu.innerHTML = devicesList.map(dev => {
    const ip = dev.ip || '';
    const name = dev.name || 'WLED Controller';
    const isActive = selectedMatrixDeviceIp === ip;
    const safeIp = (ip || '').replace(/[^a-zA-Z0-9]/g, '_');
    const cached = lastFetchedLiveDeviceData[ip];
    const isOnline = cached ? (cached.status === 'ok' && cached.online) : null;
    const dotClass = isOnline === true ? 'sub-dot online' : (isOnline === false ? 'sub-dot offline' : 'sub-dot');

    return `
      <div class="nav-submenu-item ${isActive ? 'active' : ''}" onclick="selectMatrixDevice('${escapeJsString(ip)}')">
        <span id="matrix-sub-dot-${safeIp}" class="${dotClass}" title="${isOnline === true ? 'Online' : (isOnline === false ? 'Offline' : 'Checking status...')}"></span>
        <span>${escapeHtml(name)}</span>
      </div>
    `;
  }).join('');

  // Refresh live ping status for all devices in submenu
  devicesList.forEach(async (dev) => {
    if (!dev.ip) return;
    const safeIp = (dev.ip || '').replace(/[^a-zA-Z0-9]/g, '_');
    const data = await pingDeviceCached(dev.ip);
    const online = data && data.status === 'ok' && data.online === true;
    const dot = document.getElementById(`matrix-sub-dot-${safeIp}`);
    if (dot) {
      dot.className = `sub-dot ${online ? 'online' : 'offline'}`;
      dot.title = online ? 'Online' : 'Offline';
    }
  });
}

// Helper to retrieve segments for a device (live segments -> config segments -> hw_ins -> fallback)
function getDeviceSegments(ip) {
  const dev = (Array.isArray(appState.devices) ? appState.devices : []).find(d => d.ip === ip);
  if (!dev) return [];

  const live = lastFetchedLiveDeviceData[ip];
  const hwIns = (live && Array.isArray(live.hw_ins) && live.hw_ins.length > 0)
    ? live.hw_ins
    : (dev && Array.isArray(dev.hw_ins) && dev.hw_ins.length > 0 ? dev.hw_ins : []);

  let rawList = [];

  // 1. Check live fetched segments from /api/ping (only use if live has at least as many segments as configured on device)
  const devSegCount = (dev && Array.isArray(dev.segments)) ? dev.segments.length : 0;
  if (live && Array.isArray(live.segments) && live.segments.length > 0 && live.segments.length >= devSegCount) {
    rawList = live.segments.map(s => {
      const segId = parseInt(s.id, 10) || 0;
      const start = parseInt(s.start, 10) || 0;
      const stop = parseInt(s.stop, 10) || (start + (parseInt(s.len, 10) || 1));
      const len = parseInt(s.len, 10) || Math.max(1, stop - start);
      const isPwm = s.type ? String(s.type).toLowerCase().includes('pwm') : String(s.name || '').toLowerCase().includes('pwm');
      return {
        id: segId,
        name: s.name || (isPwm ? `PWM White (Seg ${segId})` : `WS281x (Seg ${segId})`),
        type: s.type || (isPwm ? 'PWM White' : 'WS281x'),
        start: start,
        stop: stop,
        len: len,
        gpio: s.gpio || ''
      };
    });
  } else if (Array.isArray(dev.segments) && dev.segments.length > 0) {
    // 2. Fallback to configured segments on device
    rawList = dev.segments.map(s => {
      const segId = parseInt(s.id, 10) || 0;
      const start = parseInt(s.start, 10) || 0;
      const length = parseInt(s.length || s.len, 10) || 1;
      const isPwm = s.type ? String(s.type).toLowerCase().includes('pwm') : (String(s.role || '').toLowerCase().includes('white') || String(s.name || '').toLowerCase().includes('pwm'));
      return {
        id: segId,
        name: s.name || (isPwm ? `PWM White (Seg ${segId})` : `WS281x (Seg ${segId})`),
        type: s.type || (isPwm ? 'PWM White' : 'WS281x'),
        start: start,
        stop: start + length,
        len: length,
        gpio: s.gpio || ''
      };
    });
  } else if (hwIns.length > 0) {
    // 3. Fallback to hw_ins if available
    rawList = hwIns.map((h, idx) => {
      const typeCode = h.type !== undefined ? h.type : 22;
      const isPwm = (typeCode === 41 || String(typeCode).includes('41'));
      const start = parseInt(h.start, 10) || (idx === 0 ? 0 : (dev.rgb_count || 45));
      const len = parseInt(h.len, 10) || (isPwm ? 1 : (dev.rgb_count || 45));
      const pinNum = Array.isArray(h.pin) ? h.pin[0] : (typeof h.pin === 'number' ? h.pin : (isPwm ? 16 : 33));
      return {
        id: idx,
        name: isPwm ? `PWM White (Seg ${idx})` : `WS281x Strip (Seg ${idx})`,
        type: isPwm ? 'PWM White' : 'WS281x',
        start: start,
        stop: start + len,
        len: len,
        gpio: `GPIO ${pinNum}`
      };
    });
  } else {
    // 4. Default single-segment fallback (RGB)
    const rgbLen = dev.rgb_count || 45;
    rawList = [
      { id: 0, name: 'WS281x Strip', type: 'WS281x', start: 0, stop: rgbLen, len: rgbLen, gpio: 'GPIO 16' }
    ];
    if (dev.pwm_index !== null && dev.pwm_index !== undefined) {
      rawList.push({
        id: 1, name: 'PWM White', type: 'PWM White', start: dev.pwm_index, stop: dev.pwm_index + 1, len: 1, gpio: 'GPIO 17'
      });
    }
  }

  // Calculate GPIO cluster group for each segment
  const rgbCount = dev ? (dev.rgb_count || 45) : 45;
  return rawList.map(seg => {
    let groupKey = "group_0";
    if (hwIns && hwIns.length > 0) {
      let matchedIdx = -1;
      let cumStart = 0;
      for (let hIdx = 0; hIdx < hwIns.length; hIdx++) {
        const h = hwIns[hIdx];
        const hStart = (h.start !== undefined && !isNaN(parseInt(h.start, 10))) ? parseInt(h.start, 10) : cumStart;
        const hLen = parseInt(h.len, 10) || 1;
        const hStop = hStart + hLen;
        cumStart = hStop;
        if (seg.start >= hStart && seg.start < hStop) {
          matchedIdx = hIdx;
          break;
        }
      }
      if (matchedIdx === -1) {
        const isPwm = seg.type ? String(seg.type).toLowerCase().includes('pwm') : String(seg.name || '').toLowerCase().includes('pwm');
        matchedIdx = isPwm ? Math.max(0, hwIns.length - 1) : 0;
      }
      groupKey = `hw_out_${matchedIdx}`;
    } else {
      const isPwm = seg.type ? String(seg.type).toLowerCase().includes('pwm') : (String(seg.name || '').toLowerCase().includes('pwm') || (dev.pwm_index !== null && dev.pwm_index !== undefined && seg.start === dev.pwm_index));
      if (seg.gpio && seg.gpio.trim()) {
        groupKey = `gpio_${seg.gpio.trim().toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
      } else {
        groupKey = isPwm ? "group_pwm" : "group_rgb";
      }
    }

    const isPwm = seg.type ? String(seg.type).toLowerCase().includes('pwm') : String(seg.name || '').toLowerCase().includes('pwm');
    let pinClean = (seg.gpio || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
    if (!pinClean) {
      pinClean = isPwm ? "gpio_16" : "gpio_33";
    }
    let typeClean = isPwm ? "pwm" : "ws281x";
    let hwKey = `${pinClean}_${typeClean}_${seg.start}`;

    return {
      ...seg,
      hwKey: hwKey,
      gpioGroup: groupKey
    };
  });
}

// Select a device from the nav submenu and show its event table
function selectMatrixDevice(ip) {
  if (selectedMatrixDeviceIp && selectedMatrixSegmentId !== null && selectedMatrixSegmentId !== undefined) {
    EVENT_DEFS.forEach(def => updateEventConfig(def.key));
    for (let i = 1; i <= 10; i++) updatePlayerSlotConfig(i);
  }
  selectedMatrixDeviceIp = ip;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('autoglow_selected_matrix_device', ip);
    const savedSeg = localStorage.getItem(`autoglow_selected_matrix_seg_${ip}`);
    if (savedSeg !== null && savedSeg !== undefined && savedSeg !== '') {
      selectedMatrixSegmentId = parseInt(savedSeg, 10);
    } else {
      selectedMatrixSegmentId = null; // Will auto-select first segment of this device
    }
  } else {
    selectedMatrixSegmentId = null;
  }
  
  // Switch to the effects tab
  switchToTab('tab-effects');
  
  // Update submenu active states
  renderMatrixSubmenu();

  // Render the effects table for the selected device
  renderEffectsTable();
  
  // Update URL
  window.history.pushState({ tab: 'tab-effects' }, '', '/matrix');
}

// Select a segment for the active device
function selectMatrixSegment(segId) {
  const newSegId = parseInt(segId, 10);
  if (selectedMatrixSegmentId === newSegId) return;

  // Flush any in-progress edits for the currently active segment before switching
  if (selectedMatrixDeviceIp && selectedMatrixSegmentId !== null && selectedMatrixSegmentId !== undefined) {
    EVENT_DEFS.forEach(def => updateEventConfig(def.key));
    for (let i = 1; i <= 10; i++) updatePlayerSlotConfig(i);
  }

  selectedMatrixSegmentId = newSegId;
  if (selectedMatrixDeviceIp && typeof localStorage !== 'undefined') {
    localStorage.setItem(`autoglow_selected_matrix_seg_${selectedMatrixDeviceIp}`, String(selectedMatrixSegmentId));
  }
  renderEffectsTable();
}

// Device selection landing page when no specific device is selected in Event Matrix
function renderMatrixDeviceLanding() {
  const contentArea = document.getElementById('matrixContentArea');
  const segTabsList = document.getElementById('matrixSegmentTabsList');
  const segStrip = document.getElementById('matrixSegmentStrip');
  const landingTitle = document.getElementById('matrixLandingHeaderTitle');
  const saveBtn = document.getElementById('matrixSaveBtn');
  const livePreviewContainer = document.getElementById('matrixLivePreviewContainer');
  const activeOnlyContainer = document.getElementById('matrixActiveOnlyContainer');
  const presetToolbar = document.getElementById('matrixPresetToolbar');

  if (segStrip) segStrip.style.display = 'none';
  if (segTabsList) segTabsList.innerHTML = '';
  if (landingTitle) landingTitle.style.display = 'block';
  if (saveBtn) saveBtn.style.display = 'none';
  if (livePreviewContainer) livePreviewContainer.style.display = 'none';
  if (activeOnlyContainer) activeOnlyContainer.style.display = 'none';
  if (presetToolbar) presetToolbar.style.display = 'none';

  const devicesList = Array.isArray(appState.devices) ? appState.devices : [];

  if (devicesList.length === 0) {
    contentArea.innerHTML = `
      <div style="padding: 40px 20px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 12px;">
        <div style="width: 44px; height: 44px; border-radius: 50%; background: var(--bg-surface); border: 1px solid var(--border-subtle); display: flex; align-items: center; justify-content: center;">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        </div>
        <strong style="color: var(--text-primary); font-size: 14px;">No WLED Controllers Configured</strong>
        <p style="color: var(--text-secondary); font-size: 12px; max-width: 360px; margin: 0; line-height: 1.5;">
          Add a WLED device in the WLED Devices tab to begin configuring dartboard event lighting animations.
        </p>
        <button class="btn-ide btn-ide-primary" onclick="switchToTab('tab-devices')" style="margin-top: 4px;">Go to WLED Devices</button>
      </div>
    `;
    return;
  }

  contentArea.innerHTML = `
    <div style="padding: 12px 16px; display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 240px)); gap: 10px;">
      ${devicesList.map(dev => {
        const ip = dev.ip || '';
        const name = dev.name || 'WLED Controller';
        const cached = lastFetchedLiveDeviceData[ip];
        const isOnline = cached ? (cached.status === 'ok' && cached.online) : null;
        const dotClass = isOnline === true ? 'dot dot-green' : (isOnline === false ? 'dot dot-gray' : 'dot');

        return `
          <div class="card-device-select" onclick="selectMatrixDevice('${escapeJsString(ip)}')">
            <div style="display: flex; align-items: center; gap: 10px; min-width: 0;">
              <span class="${dotClass}" style="width: 8px; height: 8px; flex-shrink: 0;"></span>
              <div style="display: flex; flex-direction: column; gap: 1px; min-width: 0;">
                <strong style="color: var(--text-primary); font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(name)}</strong>
                <span style="font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary);">${escapeHtml(ip)}</span>
              </div>
            </div>
            <button class="btn-ide" style="font-size: 11px; padding: 4px 10px; pointer-events: none; flex-shrink: 0;">
              Configure &rarr;
            </button>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// Called when the effects tab is activated — renders the event table for the selected device & segment
function renderEffectsTable() {
  // Also refresh the submenu (in case devices changed)
  renderMatrixSubmenu();
  
  // Auto-open the submenu if we're on this tab
  const group = document.getElementById('navMatrixGroup');
  if (group && !group.classList.contains('open')) {
    group.classList.add('open');
  }
  
  const contentArea = document.getElementById('matrixContentArea');
  if (!contentArea) return;

  const devicesList = Array.isArray(appState.devices) ? appState.devices : [];

  // If no device is selected, render the device selection landing
  if (!selectedMatrixDeviceIp || !devicesList.find(d => d.ip === selectedMatrixDeviceIp)) {
    renderMatrixDeviceLanding();
    return;
  }

  renderMatrixForDevice(selectedMatrixDeviceIp);
}

function getSegmentEventConfig(ip, segId, eventKey) {
  if (!appState.profile) appState.profile = { events: {}, device_events: {} };
  if (!appState.profile.device_events) appState.profile.device_events = {};
  
  const devMap = appState.profile.device_events[ip] || {};
  const segKey = String(segId !== null && segId !== undefined ? segId : 0);
  
  // Find current segment hwKey
  const segments = getDeviceSegments(ip);
  const segObj = segments.find(s => s.id === segId);
  const hwKey = segObj ? segObj.hwKey : null;

  // 1. Check Hardware Key Anchor (e.g. gpio_16_pwm_45)
  if (hwKey && devMap[hwKey] && devMap[hwKey][eventKey]) {
    return devMap[hwKey][eventKey];
  }

  // 2. Check Numeric Index Fallback
  if (devMap[segKey] && devMap[segKey][eventKey]) {
    return devMap[segKey][eventKey];
  }

  // Segment has no configuration for this event: return null so clean defaults apply without leaking
  return null;
}

function renderMatrixForDevice(ip) {
  const contentArea = document.getElementById('matrixContentArea');
  const segTabsList = document.getElementById('matrixSegmentTabsList');
  const saveBtn = document.getElementById('matrixSaveBtn');
  if (!contentArea) return;

  const dev = (Array.isArray(appState.devices) ? appState.devices : []).find(d => d.ip === ip);
  const devName = dev ? (dev.name || 'WLED Controller') : ip;

  const segments = getDeviceSegments(ip);

  // Restore saved segment if available or auto-select first segment if none selected or invalid
  if (selectedMatrixSegmentId === null && typeof localStorage !== 'undefined') {
    const savedSeg = localStorage.getItem(`autoglow_selected_matrix_seg_${ip}`);
    if (savedSeg !== null && savedSeg !== undefined && segments.find(s => s.id === parseInt(savedSeg, 10))) {
      selectedMatrixSegmentId = parseInt(savedSeg, 10);
    }
  }

  if (selectedMatrixSegmentId === null || !segments.find(s => s.id === selectedMatrixSegmentId)) {
    selectedMatrixSegmentId = segments.length > 0 ? segments[0].id : 0;
  }

  if (saveBtn) saveBtn.style.display = '';

  const segStrip = document.getElementById('matrixSegmentStrip');
  const landingTitle = document.getElementById('matrixLandingHeaderTitle');
  if (landingTitle) landingTitle.style.display = 'none';

  const presetToolbar = document.getElementById('matrixPresetToolbar');
  if (presetToolbar) presetToolbar.style.display = 'flex';
  renderPresetDropdown();

  // Render Segment Tabs grouped by GPIO in the separated top bar above the panel
  if (segTabsList) {
    if (segments.length > 0) {
      if (segStrip) segStrip.style.display = 'flex';
      const groups = {};
      segments.forEach(seg => {
        const gKey = seg.gpioGroup || 'default';
        if (!groups[gKey]) {
          const isPwm = String(seg.type || '').toLowerCase().includes('pwm') || String(seg.name || '').toLowerCase().includes('pwm');
          groups[gKey] = {
            isPwm: isPwm,
            segments: []
          };
        }
        groups[gKey].segments.push(seg);
      });

      let tabsHTML = '';
      Object.values(groups).forEach(grp => {
        const barClass = grp.isPwm ? 'pwm' : 'rgb';
        tabsHTML += `
          <div class="matrix-gpio-group">
            <div class="matrix-gpio-bar ${barClass}"></div>
            <div class="matrix-gpio-buttons">
        `;
        grp.segments.forEach(seg => {
          const isSelected = seg.id === selectedMatrixSegmentId;
          tabsHTML += `
            <div class="matrix-seg-tab ${isSelected ? 'active' : ''}" onclick="selectMatrixSegment(${seg.id})">
              <span class="seg-tab-name">#${seg.id} ${escapeHtml(seg.name)}</span>
            </div>
          `;
        });
        tabsHTML += `
            </div>
          </div>
        `;
      });

      segTabsList.innerHTML = tabsHTML;
    } else {
      if (segStrip) segStrip.style.display = 'none';
      segTabsList.innerHTML = '';
    }
  }

  const livePreviewContainer = document.getElementById('matrixLivePreviewContainer');
  const livePreviewSwitch = document.getElementById('matrixLivePreviewSwitch');
  if (livePreviewContainer) livePreviewContainer.style.display = 'flex';

  const livePreview = localStorage.getItem('autoglow_live_preview_matrix') === 'true';
  matrixLivePreviewActive = livePreview;
  if (livePreviewSwitch) livePreviewSwitch.checked = livePreview;

  const activeOnlyContainer = document.getElementById('matrixActiveOnlyContainer');
  const activeOnlySwitch = document.getElementById('matrixActiveOnlySwitch');
  if (activeOnlyContainer) activeOnlyContainer.style.display = 'flex';

  const hideDisabled = localStorage.getItem('autoglow_hide_disabled_matrix') === 'true';
  if (activeOnlySwitch) activeOnlySwitch.checked = hideDisabled;

  const currentSeg = segments.find(s => s.id === selectedMatrixSegmentId);
  const isPwm = currentSeg ? (String(currentSeg.type || '').toLowerCase().includes('pwm') || String(currentSeg.name || '').toLowerCase().includes('pwm')) : false;

  if (saveBtn) saveBtn.style.display = '';

  const PWM_ANIM_OPTIONS = [
    { value: 'solid', label: 'Solid' }
  ];

  let tableHTML = `
    <table class="ide-table">
      <thead>
        <tr>
          <th style="width: 70px; text-align: center;">ENABLED</th>
          <th>EVENT TRIGGER</th>
          <th>ANIMATION EFFECT</th>
          <th>${isPwm ? 'BRIGHTNESS (%)' : 'PRIMARY COLOR'}</th>
          <th style="width: 125px; white-space: nowrap;">DURATION (SEC)</th>
          <th style="width: 85px;">ACTION</th>
        </tr>
      </thead>
      <tbody>
  `;

  function renderEventRow(def, catId) {
    const evConfig = getSegmentEventConfig(ip, selectedMatrixSegmentId, def.key);
    const anim = (evConfig && evConfig.animation) ? evConfig.animation : (isPwm ? "solid" : (def.defaultAnim || "solid"));
    const col = (evConfig && (evConfig.color || evConfig.color_primary)) ? rgbToHex(evConfig.color || evConfig.color_primary) : (def.defaultCol || "#000000");
    const colSec = (evConfig && evConfig.color_secondary) ? rgbToHex(evConfig.color_secondary) : "#000000";
    const dynSec = (evConfig && evConfig.dynamic_secondary !== undefined) ? evConfig.dynamic_secondary : false;
    const speed = (evConfig && evConfig.speed !== undefined) ? evConfig.speed : (def.defaultSpeed ?? 1.0);
    const reverse = (evConfig && evConfig.reverse !== undefined) ? evConfig.reverse : false;
    const dur = (evConfig && evConfig.duration !== undefined) ? evConfig.duration : (def.defaultDur ?? 0.0);
    const enabled = (evConfig && evConfig.enabled !== undefined) ? evConfig.enabled : (def.defaultEnabled !== undefined ? def.defaultEnabled : false);
    const briPercent = (evConfig && evConfig.brightness !== undefined) ? evConfig.brightness : ((evConfig && (evConfig.color_primary || evConfig.color)) ? Math.round(((evConfig.color_primary || evConfig.color)[0] / 255) * 100) : 0);
    const isNonSolid = (anim !== "solid" && !isPwm);
    const isRainbow = (anim === "rainbow" && !isPwm);
    const isPastelRainbow = (anim === "pastel_rainbow" && !isPwm);
    const hasDirection = (anim === "chase" || anim === "rainbow" || anim === "pastel_rainbow" || anim === "curtain" || anim === "dual_comet" || anim === "radar") && !isPwm;
    const hasSecondary = (anim === "chase" || anim === "flash" || anim === "curtain" || anim === "heartbeat" || anim === "dual_comet" || anim === "sparkle" || anim === "fire" || anim === "radar" || anim === "breathe") && !isPwm;
    const secLabel = (anim === "chase" ? "TRAIL:" : (anim === "heartbeat" ? "REST:" : (anim === "breathe" ? "REST:" : (anim === "dual_comet" ? "COMET B:" : (anim === "fire" ? "BASE:" : "BG:")))));
    const dirLabel = anim === "curtain" ? (reverse ? 'B->T' : 'T->B') : (reverse ? 'CCW' : 'CW');
    const dirTitle = anim === "curtain" ? (reverse ? 'Direction: Bottom-to-Top' : 'Direction: Top-to-Bottom') : (reverse ? 'Direction: Counter-Clockwise' : 'Direction: Clockwise');

    const animSelectOptions = isPwm ? PWM_ANIM_OPTIONS : ANIMATION_OPTIONS;
    const rowStyle = (hideDisabled && !enabled) ? 'style="display: none;"' : '';

    let colorCellHtml = '';
    if (isPwm) {
      colorCellHtml = `
        <div style="display: flex; align-items: center; gap: 6px;">
          <input type="number" class="input-text" id="bri_${def.key}" value="${briPercent}" min="0" max="100" step="5" style="width: 70px;" onchange="updateEventConfig('${def.key}')" oninput="updateEventConfig('${def.key}')">
          <span style="font-family: var(--font-mono); font-size: 11.5px; color: var(--text-secondary);">%</span>
        </div>
      `;
    } else if (isRainbow) {
      colorCellHtml = `
        <div class="badge-rainbow-spectrum">
          <span class="spectrum-gradient-bar"></span>
          <span>Full Spectrum</span>
        </div>
      `;
    } else if (isPastelRainbow) {
      colorCellHtml = `
        <div class="badge-rainbow-spectrum" style="border-color: rgba(244, 114, 182, 0.4); background: rgba(244, 114, 182, 0.08);">
          <span class="spectrum-gradient-bar" style="background: linear-gradient(90deg, #ff2314, #ff640a, #ffaf05, #0ff046, #05b9ff, #1e5aff, #a019ff, #ff1478);"></span>
          <span style="color: #f472b6;">Pastel Spectrum</span>
        </div>
      `;
    } else {
      colorCellHtml = `
        <div style="display: flex; flex-direction: column; gap: 6px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <input type="color" class="color-picker-input" id="col_${def.key}" value="${col}" oninput="const txt = document.getElementById('col_txt_${def.key}'); if(txt) txt.textContent = this.value.toUpperCase(); updateEventConfig('${def.key}')" onchange="const txt = document.getElementById('col_txt_${def.key}'); if(txt) txt.textContent = this.value.toUpperCase(); updateEventConfig('${def.key}')">
            <span id="col_txt_${def.key}" style="font-family: var(--font-mono); font-size: 11.5px; color: var(--text-code);">${col.toUpperCase()}</span>
          </div>
          ${hasSecondary ? `
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <span style="font-size: 10px; font-family: var(--font-mono); color: var(--text-muted); width: 34px;">${secLabel}</span>
              <div id="col_sec_wrap_${def.key}" style="display: ${dynSec ? 'none' : 'inline-flex'}; align-items: center; gap: 8px;">
                <input type="color" class="color-picker-input" id="col_sec_${def.key}" value="${colSec}" oninput="const txt = document.getElementById('col_sec_txt_${def.key}'); if(txt) txt.textContent = this.value.toUpperCase(); updateEventConfig('${def.key}')" onchange="const txt = document.getElementById('col_sec_txt_${def.key}'); if(txt) txt.textContent = this.value.toUpperCase(); updateEventConfig('${def.key}')">
                <span id="col_sec_txt_${def.key}" style="font-family: var(--font-mono); font-size: 10.5px; color: var(--text-muted);">${colSec.toUpperCase()}</span>
              </div>
              <span id="dyn_badge_${def.key}" class="badge-dyn-color" style="display: ${dynSec ? 'inline-flex' : 'none'};">Match Previous</span>
              <label class="matrix-dyn-toggle" title="Dynamically inherit active baseline or throw color for background">
                <input type="checkbox" id="dyn_sec_${def.key}" ${dynSec ? 'checked' : ''} onchange="onDynamicSecondaryToggled('${def.key}')">
                <span>Match Prev</span>
              </label>
            </div>
          ` : ''}
        </div>
      `;
    }

    return `
      <tr class="matrix-event-row ${enabled ? 'is-enabled' : 'is-disabled'}" data-event-key="${def.key}" data-cat-id="${catId}" ${rowStyle}>
        <td style="text-align: center;">
          <label class="switch">
            <input type="checkbox" id="en_${def.key}" ${enabled ? 'checked' : ''} onchange="updateEventConfig('${def.key}')">
            <span class="switch-slider"></span>
          </label>
        </td>
        <td><strong style="color: var(--text-primary); font-family: var(--font-mono);">${def.label}</strong></td>
        <td>
          <div style="display: flex; flex-direction: column; gap: 6px;">
            <select class="select-ide" id="anim_${def.key}" onchange="onAnimationTypeChanged('${def.key}')">
              ${animSelectOptions.map(opt => `<option value="${opt.value}" ${opt.value === anim ? 'selected' : ''}>${opt.label}</option>`).join('')}
            </select>
            ${isNonSolid ? (anim === 'flash' ? `
              <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; font-family: var(--font-mono); color: var(--text-secondary);">
                <span>Flashes:</span>
                <input type="number" class="input-text" id="speed_${def.key}" value="${Math.max(1, Math.round(speed))}" step="1" min="1" max="20" style="width: 48px; padding: 2px 4px; font-size: 11px;" onchange="updateEventConfig('${def.key}')" oninput="updateEventConfig('${def.key}')">
              </div>
            ` : `
              <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; font-family: var(--font-mono); color: var(--text-secondary);">
                <span>Speed:</span>
                <input type="number" class="input-text" id="speed_${def.key}" value="${speed}" step="0.1" min="0.1" max="10" style="width: 50px; padding: 2px 4px; font-size: 11px;" onchange="updateEventConfig('${def.key}')" oninput="updateEventConfig('${def.key}')">
                ${hasDirection ? `
                  <button type="button" class="btn-dir-toggle ${reverse ? 'is-reversed' : ''}" id="rev_btn_${def.key}" onclick="toggleEventReverse('${def.key}')" title="${dirTitle}">
                    <span>${dirLabel}</span>
                  </button>
                ` : ''}
              </div>
            `) : ''}
          </div>
        </td>
        <td>
          ${colorCellHtml}
        </td>
        <td>
          <div style="display: flex; align-items: center; gap: 6px; position: relative;">
            <input type="number" class="input-text" id="dur_${def.key}" value="${dur}" step="0.1" min="0" title="Set to 0 for continuous illumination (baseline hold)" style="width: 65px;" onchange="updateEventConfig('${def.key}')" oninput="updateEventConfig('${def.key}')">
            <span id="dur_hint_${def.key}" class="duration-infinity-badge" title="Continuous illumination / baseline hold (no timeout)" style="display: ${dur === 0 ? 'inline-flex' : 'none'};">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4Zm0 0c2 2.67 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.33-6 4Z"/></svg>
            </span>
            ${def.key === 'game_start' ? `
              <div id="game_start_warn" class="matrix-tooltip-wrapper" style="display: ${enabled && dur <= 0 && isAnyThrowTriggerEnabled(ip, selectedMatrixSegmentId) ? 'inline-flex' : 'none'}; align-items: center; cursor: help; color: #f59e0b;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                  <line x1="12" y1="9" x2="12" y2="13"/>
                  <line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
                <div class="matrix-tooltip-popover">
                  Cannot be 0 if any throw trigger is enabled (Game Started will be immediately overwritten by player color).
                </div>
              </div>
            ` : ''}
          </div>
        </td>
        <td>
          <button class="btn-ide" onclick="triggerEffectTest('${def.key}')">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            <span>Test</span>
          </button>
        </td>
      </tr>
    `;
  }

  function renderPlayerSlotRow(slotDef) {
    const slot = getSegmentPlayerSlotConfig(selectedMatrixDeviceIp, selectedMatrixSegmentId, slotDef.id);
    const globalSlot = getPlayerSlotConfig(slotDef.id);
    const enabled = slot.enabled === true && slot.effect?.enabled === true;
    const anim = slot.effect?.animation || "solid";
    const speed = slot.effect?.speed !== undefined ? slot.effect.speed : 1.0;
    const reverse = slot.effect?.reverse !== undefined ? slot.effect.reverse : false;
    const dur = slot.effect?.duration !== undefined ? slot.effect.duration : 0.0;
    const dynSec = slot.effect?.dynamic_secondary === true;
    let nameFilter = globalSlot.name_filter || "";
    const matchType = globalSlot.match_type || "contains";

    // Auto-prefill Player 1 with connected Autodarts account username if name_filter is empty
    if (slotDef.id === 1 && !nameFilter) {
      const adAccount = window.lastFetchedAutodartsAccount || (appState && appState.autodarts);
      const rawName = (adAccount && (adAccount.username || adAccount.preferred_username || adAccount.nickname || adAccount.name || adAccount.email)) ||
                      (appState && (appState.autodarts_username || appState.autodarts_name || appState.autodarts_user)) ||
                      (appState && appState.extra && (appState.extra.autodarts_username || appState.extra.autodarts_name || appState.extra.autodarts_email));
      if (rawName && typeof rawName === 'string' && rawName !== 'Not Connected' && rawName.trim() !== '') {
        const cleanName = rawName.includes('@') ? rawName.split('@')[0] : rawName;
        nameFilter = cleanName;
        globalSlot.name_filter = cleanName;
      }
    }

    const currentSeg = getDeviceSegments(selectedMatrixDeviceIp).find(s => s.id === selectedMatrixSegmentId);
    const isPwm = currentSeg ? (String(currentSeg.type || '').toLowerCase().includes('pwm') || String(currentSeg.name || '').toLowerCase().includes('pwm')) : false;
    const isNonSolid = (anim !== "solid" && !isPwm);
    const isRainbow = (anim === "rainbow" && !isPwm);
    const isPastelRainbow = (anim === "pastel_rainbow" && !isPwm);
    const hasDirection = (anim === "chase" || anim === "rainbow" || anim === "pastel_rainbow" || anim === "curtain" || anim === "dual_comet" || anim === "radar") && !isPwm;
    const hasSecondary = (anim === "chase" || anim === "flash" || anim === "curtain" || anim === "heartbeat" || anim === "dual_comet" || anim === "sparkle" || anim === "fire" || anim === "radar" || anim === "breathe") && !isPwm;
    const secLabel = (anim === "chase" ? "TRAIL:" : (anim === "heartbeat" ? "REST:" : (anim === "breathe" ? "REST:" : (anim === "dual_comet" ? "COMET B:" : (anim === "fire" ? "BASE:" : "BG:")))));
    const dirLabel = anim === "curtain" ? (reverse ? 'B->T' : 'T->B') : (reverse ? 'CCW' : 'CW');
    const dirTitle = anim === "curtain" ? (reverse ? 'Direction: Bottom-to-Top' : 'Direction: Top-to-Bottom') : (reverse ? 'Direction: Counter-Clockwise' : 'Direction: Clockwise');

    let briPercent = 0;
    let col = "#000000";
    let colSec = "#000000";
    if (isPwm) {
      if (slot.effect?.brightness !== undefined) {
        briPercent = slot.effect.brightness;
      } else if (slot.effect?.color_primary) {
        briPercent = Math.round((slot.effect.color_primary[0] / 255) * 100);
      }
    } else {
      col = rgbToHex(slot.effect?.color_primary || slotDef.effect?.color_primary) || "#000000";
      colSec = rgbToHex(slot.effect?.color_secondary || [0, 0, 0]) || "#000000";
    }

    const animSelectOptions = isPwm ? PWM_ANIM_OPTIONS : ANIMATION_OPTIONS;
    const rowStyle = (hideDisabled && !enabled) ? 'style="display: none;"' : '';

    let playerColorCellHtml = '';
    if (isPwm) {
      playerColorCellHtml = `
        <div style="display: flex; align-items: center; gap: 6px;">
          <input type="number" class="input-text" id="bri_p_${slotDef.id}" value="${briPercent}" min="0" max="100" step="5" style="width: 70px;" onchange="updatePlayerSlotConfig(${slotDef.id})" oninput="updatePlayerSlotConfig(${slotDef.id})">
          <span style="font-family: var(--font-mono); font-size: 11.5px; color: var(--text-secondary);">%</span>
        </div>
      `;
    } else if (isRainbow) {
      playerColorCellHtml = `
        <div class="badge-rainbow-spectrum">
          <span class="spectrum-gradient-bar"></span>
          <span>Full Spectrum</span>
        </div>
      `;
    } else if (isPastelRainbow) {
      playerColorCellHtml = `
        <div class="badge-rainbow-spectrum" style="border-color: rgba(244, 114, 182, 0.4); background: rgba(244, 114, 182, 0.08);">
          <span class="spectrum-gradient-bar" style="background: linear-gradient(90deg, #ff2314, #ff640a, #ffaf05, #0ff046, #05b9ff, #1e5aff, #a019ff, #ff1478);"></span>
          <span style="color: #f472b6;">Pastel Spectrum</span>
        </div>
      `;
    } else {
      playerColorCellHtml = `
        <div style="display: flex; flex-direction: column; gap: 6px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <input type="color" class="color-picker-input" id="col_p_${slotDef.id}" value="${col}" oninput="const txt = document.getElementById('col_p_txt_${slotDef.id}'); if(txt) txt.textContent = this.value.toUpperCase(); updatePlayerSlotConfig(${slotDef.id})" onchange="const txt = document.getElementById('col_p_txt_${slotDef.id}'); if(txt) txt.textContent = this.value.toUpperCase(); updatePlayerSlotConfig(${slotDef.id})">
            <span id="col_p_txt_${slotDef.id}" style="font-family: var(--font-mono); font-size: 11.5px; color: var(--text-code);">${col.toUpperCase()}</span>
          </div>
          ${hasSecondary ? `
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <span style="font-size: 10px; font-family: var(--font-mono); color: var(--text-muted); width: 34px;">${secLabel}</span>
              <div id="col_sec_p_wrap_${slotDef.id}" style="display: ${dynSec ? 'none' : 'inline-flex'}; align-items: center; gap: 8px;">
                <input type="color" class="color-picker-input" id="col_sec_p_${slotDef.id}" value="${colSec}" oninput="const txt = document.getElementById('col_sec_p_txt_${slotDef.id}'); if(txt) txt.textContent = this.value.toUpperCase(); updatePlayerSlotConfig(${slotDef.id})" onchange="const txt = document.getElementById('col_sec_p_txt_${slotDef.id}'); if(txt) txt.textContent = this.value.toUpperCase(); updatePlayerSlotConfig(${slotDef.id})">
                <span id="col_sec_p_txt_${slotDef.id}" style="font-family: var(--font-mono); font-size: 10.5px; color: var(--text-muted);">${colSec.toUpperCase()}</span>
              </div>
              <span id="dyn_badge_p_${slotDef.id}" class="badge-dyn-color" style="display: ${dynSec ? 'inline-flex' : 'none'};">Match Previous</span>
              <label class="matrix-dyn-toggle" title="Dynamically inherit active baseline or throw color for background">
                <input type="checkbox" id="dyn_sec_p_${slotDef.id}" ${dynSec ? 'checked' : ''} onchange="onPlayerDynamicSecondaryToggled(${slotDef.id})">
                <span>Match Prev</span>
              </label>
            </div>
          ` : ''}
        </div>
      `;
    }

    return `
      <tr class="matrix-player-row ${enabled ? 'is-enabled' : 'is-disabled'}" data-slot-id="${slotDef.id}" data-cat-id="players" ${rowStyle}>
        <td style="text-align: center;">
          <label class="switch">
            <input type="checkbox" id="en_p_${slotDef.id}" ${enabled ? 'checked' : ''} onchange="updatePlayerSlotConfig(${slotDef.id})">
            <span class="switch-slider"></span>
          </label>
        </td>
        <td>
          <div style="display: flex; flex-direction: column; gap: 4px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <strong style="color: var(--text-primary); font-family: var(--font-mono);">Player ${slotDef.id}</strong>
              <select class="select-ide" id="match_p_${slotDef.id}" style="width: 90px; padding: 2px 6px; font-size: 11px;" onchange="updatePlayerSlotConfig(${slotDef.id})">
                <option value="contains" ${matchType === 'contains' ? 'selected' : ''}>Contains</option>
                <option value="exact" ${matchType === 'exact' ? 'selected' : ''}>Exact</option>
              </select>
            </div>
            <input type="text" class="input-text" id="name_p_${slotDef.id}" value="${escapeHtml(nameFilter)}" placeholder="${slotDef.id === 1 ? 'Player 1 (Autodarts Account)' : 'Name Filter (e.g. Alex)'}" style="width: 100%; max-width: 220px; font-size: 12px; padding: 4px 8px;" onchange="updatePlayerSlotConfig(${slotDef.id})" oninput="updatePlayerSlotConfig(${slotDef.id})">
          </div>
        </td>
        <td>
          <div style="display: flex; flex-direction: column; gap: 6px;">
            <select class="select-ide" id="anim_p_${slotDef.id}" onchange="onPlayerAnimationTypeChanged(${slotDef.id})">
              ${animSelectOptions.map(opt => `<option value="${opt.value}" ${opt.value === anim ? 'selected' : ''}>${opt.label}</option>`).join('')}
            </select>
            ${isNonSolid ? (anim === 'flash' ? `
              <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; font-family: var(--font-mono); color: var(--text-secondary);">
                <span>Flashes:</span>
                <input type="number" class="input-text" id="speed_p_${slotDef.id}" value="${Math.max(1, Math.round(speed))}" step="1" min="1" max="20" style="width: 48px; padding: 2px 4px; font-size: 11px;" onchange="updatePlayerSlotConfig(${slotDef.id})" oninput="updatePlayerSlotConfig(${slotDef.id})">
              </div>
            ` : `
              <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; font-family: var(--font-mono); color: var(--text-secondary);">
                <span>Speed:</span>
                <input type="number" class="input-text" id="speed_p_${slotDef.id}" value="${speed}" step="0.1" min="0.1" max="10" style="width: 50px; padding: 2px 4px; font-size: 11px;" onchange="updatePlayerSlotConfig(${slotDef.id})" oninput="updatePlayerSlotConfig(${slotDef.id})">
                ${hasDirection ? `
                  <button type="button" class="btn-dir-toggle ${reverse ? 'is-reversed' : ''}" id="rev_btn_p_${slotDef.id}" onclick="togglePlayerSlotReverse(${slotDef.id})" title="${dirTitle}">
                    <span>${dirLabel}</span>
                  </button>
                ` : ''}
              </div>
            `) : ''}
          </div>
        </td>
        <td>
          ${playerColorCellHtml}
        </td>
        <td>
          <div style="display: flex; align-items: center; gap: 6px; position: relative;">
            <input type="number" class="input-text" id="dur_p_${slotDef.id}" value="${dur}" step="0.1" min="0" title="Set to 0 for continuous throw hold (baseline hold)" style="width: 65px;" onchange="updatePlayerSlotConfig(${slotDef.id})" oninput="updatePlayerSlotConfig(${slotDef.id})">
            <span id="dur_p_hint_${slotDef.id}" class="duration-infinity-badge" title="Continuous throw hold (baseline hold)" style="display: ${dur === 0 ? 'inline-flex' : 'none'};">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4Zm0 0c2 2.67 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.33-6 4Z"/></svg>
            </span>
          </div>
        </td>
        <td>
          <button class="btn-ide" onclick="triggerPlayerSlotTest(${slotDef.id})">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            <span>Test</span>
          </button>
        </td>
      </tr>
    `;
  }

  // Categorized layout with category section headers
  let totalRenderedCategories = 0;

  EVENT_CATEGORIES.forEach(cat => {
    if (cat.id === "players") {
      let playersHTML = '';
      let activePlayerCount = 0;
      DEFAULT_PLAYER_SLOTS.forEach(slotDef => {
        const slot = getSegmentPlayerSlotConfig(ip, selectedMatrixSegmentId, slotDef.id);
        const isSlotActive = (slot.enabled === true) && (slot.effect?.enabled !== false);
        if (isSlotActive) activePlayerCount++;
        playersHTML += renderPlayerSlotRow(slotDef);
      });

      // If Active Only filter is on, disable/hide category header when no active triggers inside
      if (hideDisabled && activePlayerCount === 0) {
        return;
      }
      totalRenderedCategories++;

      tableHTML += `
        <tr class="table-section-row" data-section-cat="players">
          <td colspan="6">
            <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
              <span class="table-section-tag">
                ${cat.icon}
                <span>${escapeHtml(cat.label)}</span>
              </span>
              <span data-cat-count="players" style="font-size: 10.5px; font-family: var(--font-mono); color: var(--text-muted);">${activePlayerCount} of ${DEFAULT_PLAYER_SLOTS.length} active</span>
            </div>
          </td>
        </tr>
        ${playersHTML}
      `;
      return;
    }

    const catEvents = EVENT_DEFS.filter(d => d.category === cat.id);
    if (catEvents.length === 0) return;

    let activeEventCount = 0;
    let eventsHTML = '';

    catEvents.forEach(def => {
      const evConfig = getSegmentEventConfig(ip, selectedMatrixSegmentId, def.key);
      const isEvActive = evConfig ? (evConfig.enabled === true) : (def.defaultEnabled === true);
      if (isEvActive) activeEventCount++;
      eventsHTML += renderEventRow(def, cat.id);
    });

    // If Active Only filter is on, disable/hide category header when no active triggers inside
    if (hideDisabled && activeEventCount === 0) {
      return;
    }
    totalRenderedCategories++;

    tableHTML += `
      <tr class="table-section-row" data-section-cat="${cat.id}">
        <td colspan="6">
          <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
            <span class="table-section-tag">
              ${cat.icon}
              <span>${escapeHtml(cat.label)}</span>
            </span>
            <span data-cat-count="${cat.id}" style="font-size: 10.5px; font-family: var(--font-mono); color: var(--text-muted);">${activeEventCount} of ${catEvents.length} active</span>
          </div>
        </td>
      </tr>
      ${eventsHTML}
    `;
  });

  if (hideDisabled && totalRenderedCategories === 0) {
    tableHTML += `
      <tr class="empty-matrix-filter-row">
        <td colspan="6" style="text-align: center; color: var(--text-muted); font-size: 12px; padding: 36px 16px; font-family: var(--font-mono); background: rgba(0,0,0,0.12);">
          No active triggers in this segment. Toggle triggers on or disable "Active Only" filter.
        </td>
      </tr>
    `;
  }

  tableHTML += `</tbody></table>`;
  contentArea.innerHTML = tableHTML;
}

let matrixLivePreviewActive = false;
let _matrixLivePreviewDebounce = null;
let _isMatrixPreviewSending = false;
let _pendingMatrixPreviewPayload = null;

async function toggleMatrixLivePreview() {
  const switchElem = document.getElementById('matrixLivePreviewSwitch');
  const isLive = switchElem ? switchElem.checked : false;
  matrixLivePreviewActive = isLive;
  localStorage.setItem('autoglow_live_preview_matrix', String(isLive));

  if (isLive) {
    if (currentProtocolMode !== 'udp') {
      await toggleProtocolMode();
    }
    showToast("Live Preview Active: Tweak any color or effect to stream live to LEDs.", "info");
  } else {
    showToast("Live Preview paused.", "info");
  }
}

function dispatchMatrixLivePreview(payload) {
  if (!matrixLivePreviewActive || !selectedMatrixDeviceIp) return;
  _pendingMatrixPreviewPayload = payload;

  if (_matrixLivePreviewDebounce) clearTimeout(_matrixLivePreviewDebounce);
  _matrixLivePreviewDebounce = setTimeout(async () => {
    if (_isMatrixPreviewSending || !_pendingMatrixPreviewPayload) return;
    const toSend = _pendingMatrixPreviewPayload;
    _pendingMatrixPreviewPayload = null;
    _isMatrixPreviewSending = true;

    try {
      if (currentProtocolMode !== 'udp') {
        await toggleProtocolMode();
      }
      await fetch('/api/test/effect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toSend)
      });
    } catch (e) {
      console.warn('[AutoGlow] Matrix effect live preview failed:', e);
    } finally {
      _isMatrixPreviewSending = false;
      if (_pendingMatrixPreviewPayload) {
        dispatchMatrixLivePreview(_pendingMatrixPreviewPayload);
      }
    }
  }, 35);
}


function toggleHideDisabledTriggers(forceVal = null) {
  const currentVal = localStorage.getItem('autoglow_hide_disabled_matrix') === 'true';
  const isHide = (forceVal !== null && typeof forceVal === 'boolean')
    ? forceVal 
    : !currentVal;
  localStorage.setItem('autoglow_hide_disabled_matrix', String(isHide));
  renderEffectsTable();
}

function updateCategoryCountBadge(catId) {
  const badge = document.querySelector(`[data-cat-count="${catId}"]`);
  if (!badge) return;
  if (catId === 'players') {
    const rows = document.querySelectorAll('.matrix-player-row');
    const active = document.querySelectorAll('.matrix-player-row.is-enabled').length;
    badge.textContent = `${active} of ${rows.length} active`;
  } else {
    const rows = document.querySelectorAll(`.matrix-event-row[data-cat-id="${catId}"]`);
    const active = document.querySelectorAll(`.matrix-event-row[data-cat-id="${catId}"].is-enabled`).length;
    badge.textContent = `${active} of ${rows.length} active`;
  }
}

function getPlayerSlotConfig(slotId) {
  if (!appState.profile) appState.profile = { events: {}, device_events: {}, player_slots: [] };
  if (!Array.isArray(appState.profile.player_slots)) {
    appState.profile.player_slots = JSON.parse(JSON.stringify(DEFAULT_PLAYER_SLOTS));
  }
  let slot = appState.profile.player_slots.find(s => s.id === slotId);
  if (!slot) {
    const def = (DEFAULT_PLAYER_SLOTS || []).find(s => s.id === slotId) || {
      id: slotId,
      name_filter: "",
      match_type: "contains",
      effect: { animation: "solid", color_primary: [0, 0, 0], duration: 0.0, fps: 50, speed: 1.0, reverse: false, enabled: false },
      enabled: false
    };
    slot = JSON.parse(JSON.stringify(def));
    appState.profile.player_slots.push(slot);
  }
  return slot;
}

function getSegmentPlayerSlotConfig(ip, segId, slotId) {
  const globalSlot = getPlayerSlotConfig(slotId);
  if (!ip) return globalSlot;

  const devMap = appState.profile?.device_events?.[ip] || {};
  const segKey = String(segId !== null && segId !== undefined ? segId : 0);
  const segKeyName = `player_${slotId}`;

  // Find current segment hwKey
  const segments = getDeviceSegments(ip);
  const segObj = segments.find(s => s.id === segId);
  const hwKey = segObj ? segObj.hwKey : null;

  let override = null;
  if (hwKey && devMap[hwKey] && devMap[hwKey][segKeyName]) {
    override = devMap[hwKey][segKeyName];
  } else if (devMap[segKey] && devMap[segKey][segKeyName]) {
    override = devMap[segKey][segKeyName];
  }

  if (override) {
    return {
      id: slotId,
      name_filter: globalSlot.name_filter || "",
      match_type: globalSlot.match_type || "contains",
      effect: {
        animation: override.animation || globalSlot.effect?.animation || "solid",
        color_primary: override.color_primary || globalSlot.effect?.color_primary || [0, 0, 0],
        color_secondary: override.color_secondary || [0, 0, 0],
        dynamic_secondary: override.dynamic_secondary ?? globalSlot.effect?.dynamic_secondary ?? false,
        brightness: override.brightness !== undefined ? override.brightness : 0,
        duration: override.duration !== undefined ? override.duration : (globalSlot.effect?.duration ?? 0.0),
        speed: override.speed ?? 1.0,
        fps: override.fps ?? 50,
        reverse: override.reverse ?? false,
        enabled: override.enabled === true
      },
      enabled: override.enabled === true
    };
  }

  // Unconfigured segment: return isolated slot defaults without leaking enabled state from other segments
  return {
    id: slotId,
    name_filter: globalSlot.name_filter || "",
    match_type: globalSlot.match_type || "contains",
    effect: {
      animation: "solid",
      color_primary: [0, 0, 0],
      color_secondary: [0, 0, 0],
      dynamic_secondary: false,
      brightness: 0,
      duration: 0.0,
      speed: 1.0,
      fps: 50,
      reverse: false,
      enabled: false
    },
    enabled: false
  };
}

function isAnyThrowTriggerEnabled(ip, segId) {
  if (!ip) return false;
  // 1. Check "Throw - Any Player" (throw event)
  const throwConf = getSegmentEventConfig(ip, segId, 'throw');
  if (throwConf && throwConf.enabled) return true;

  // 2. Check any "Throw - Players" slot (1..10)
  for (let i = 1; i <= 10; i++) {
    const pSlot = getSegmentPlayerSlotConfig(ip, segId, i);
    if (pSlot && pSlot.enabled) return true;
  }

  return false;
}

function refreshGameStartDurationWarning() {
  const warnElem = document.getElementById('game_start_warn');
  if (!warnElem) return;
  const enElem = document.getElementById('en_game_start');
  const durElem = document.getElementById('dur_game_start');
  const en = enElem ? enElem.checked : false;
  const dur = durElem && durElem.value !== '' && !isNaN(parseFloat(durElem.value)) ? parseFloat(durElem.value) : 0.0;
  const hasThrowEnabled = isAnyThrowTriggerEnabled(selectedMatrixDeviceIp, selectedMatrixSegmentId);
  warnElem.style.display = (en && dur <= 0 && hasThrowEnabled) ? 'inline-flex' : 'none';
}

function onAnimationTypeChanged(key) {
  updateEventConfig(key);
  renderEffectsTable();
}

function onPlayerAnimationTypeChanged(slotId) {
  updatePlayerSlotConfig(slotId);
  renderEffectsTable();
}

function onDynamicSecondaryToggled(key) {
  const dynCheckbox = document.getElementById(`dyn_sec_${key}`);
  const dynSec = dynCheckbox ? dynCheckbox.checked : false;
  const wrap = document.getElementById(`col_sec_wrap_${key}`);
  const badge = document.getElementById(`dyn_badge_${key}`);
  if (wrap) wrap.style.display = dynSec ? 'none' : 'inline-flex';
  if (badge) badge.style.display = dynSec ? 'inline-flex' : 'none';
  updateEventConfig(key);
}

function onPlayerDynamicSecondaryToggled(slotId) {
  const dynCheckbox = document.getElementById(`dyn_sec_p_${slotId}`);
  const dynSec = dynCheckbox ? dynCheckbox.checked : false;
  const wrap = document.getElementById(`col_sec_p_wrap_${slotId}`);
  const badge = document.getElementById(`dyn_badge_p_${slotId}`);
  if (wrap) wrap.style.display = dynSec ? 'none' : 'inline-flex';
  if (badge) badge.style.display = dynSec ? 'inline-flex' : 'none';
  updatePlayerSlotConfig(slotId);
}

function toggleEventReverse(key) {
  const current = getSegmentEventConfig(selectedMatrixDeviceIp, selectedMatrixSegmentId, key);
  const curRev = current ? current.reverse === true : false;
  const newRev = !curRev;
  const animElem = document.getElementById(`anim_${key}`);
  const anim = animElem ? animElem.value : 'solid';
  const revBtn = document.getElementById(`rev_btn_${key}`);
  if (revBtn) {
    revBtn.classList.toggle('is-reversed', newRev);
    const span = revBtn.querySelector('span');
    if (span) span.textContent = anim === 'curtain' ? (newRev ? 'B->T' : 'T->B') : (newRev ? 'CCW' : 'CW');
    revBtn.title = anim === 'curtain' ? (newRev ? 'Direction: Bottom-to-Top' : 'Direction: Top-to-Bottom') : (newRev ? 'Direction: Counter-Clockwise' : 'Direction: Clockwise');
  }
  updateEventConfig(key);
}

function togglePlayerSlotReverse(slotId) {
  const current = getSegmentPlayerSlotConfig(selectedMatrixDeviceIp, selectedMatrixSegmentId, slotId);
  const curRev = current && current.effect ? current.effect.reverse === true : false;
  const newRev = !curRev;
  const animElem = document.getElementById(`anim_p_${slotId}`);
  const anim = animElem ? animElem.value : 'solid';
  const revBtn = document.getElementById(`rev_btn_p_${slotId}`);
  if (revBtn) {
    revBtn.classList.toggle('is-reversed', newRev);
    const span = revBtn.querySelector('span');
    if (span) span.textContent = anim === 'curtain' ? (newRev ? 'B->T' : 'T->B') : (newRev ? 'CCW' : 'CW');
    revBtn.title = anim === 'curtain' ? (newRev ? 'Direction: Bottom-to-Top' : 'Direction: Top-to-Bottom') : (newRev ? 'Direction: Counter-Clockwise' : 'Direction: Clockwise');
  }
  updatePlayerSlotConfig(slotId);
}

function updatePlayerSlotConfig(slotId) {
  if (!selectedMatrixDeviceIp) return;
  const segKey = String(selectedMatrixSegmentId !== null && selectedMatrixSegmentId !== undefined ? selectedMatrixSegmentId : 0);

  if (!appState.profile) appState.profile = { events: {}, device_events: {}, player_slots: [] };
  if (!appState.profile.device_events) appState.profile.device_events = {};
  if (!appState.profile.device_events[selectedMatrixDeviceIp]) appState.profile.device_events[selectedMatrixDeviceIp] = {};
  if (!appState.profile.device_events[selectedMatrixDeviceIp][segKey]) {
    appState.profile.device_events[selectedMatrixDeviceIp][segKey] = {};
  }

  const globalSlot = getPlayerSlotConfig(slotId);
  const nameElem = document.getElementById(`name_p_${slotId}`);
  const matchElem = document.getElementById(`match_p_${slotId}`);
  const animElem = document.getElementById(`anim_p_${slotId}`);
  const durElem = document.getElementById(`dur_p_${slotId}`);
  const enElem = document.getElementById(`en_p_${slotId}`);
  const speedElem = document.getElementById(`speed_p_${slotId}`);
  const revBtn = document.getElementById(`rev_btn_p_${slotId}`);
  const colSecElem = document.getElementById(`col_sec_p_${slotId}`);
  const dynSecElem = document.getElementById(`dyn_sec_p_${slotId}`);

  if (nameElem) globalSlot.name_filter = nameElem.value.trim();
  if (matchElem) globalSlot.match_type = matchElem.value;

  const currentSeg = getDeviceSegments(selectedMatrixDeviceIp).find(s => s.id === selectedMatrixSegmentId);
  const isPwm = currentSeg ? (String(currentSeg.type || '').toLowerCase().includes('pwm') || String(currentSeg.name || '').toLowerCase().includes('pwm')) : false;

  const en = enElem ? enElem.checked : false;
  const anim = animElem ? animElem.value : "solid";
  const dur = durElem && durElem.value !== '' && !isNaN(parseFloat(durElem.value)) ? Math.max(0, parseFloat(durElem.value)) : 0.0;
  const speed = speedElem && speedElem.value !== '' && !isNaN(parseFloat(speedElem.value)) ? Math.max(0.01, parseFloat(speedElem.value)) : 1.0;
  const reverse = revBtn ? revBtn.classList.contains('is-reversed') : false;
  const dynSec = dynSecElem ? dynSecElem.checked : false;

  let rgb = [0, 0, 0];
  let rgbSec = [0, 0, 0];
  let briPercent = 0;

  if (isPwm) {
    const briElem = document.getElementById(`bri_p_${slotId}`);
    briPercent = briElem && briElem.value !== '' && !isNaN(parseInt(briElem.value, 10)) ? Math.max(0, Math.min(100, parseInt(briElem.value, 10))) : 0;
    const rawBri = Math.round(briPercent * 2.55);
    rgb = [rawBri, rawBri, rawBri];
  } else {
    const colElem = document.getElementById(`col_p_${slotId}`);
    const colHex = colElem ? colElem.value : "#000000";
    rgb = hexToRgb(colHex);
    const colSecHex = colSecElem ? colSecElem.value : "#000000";
    rgbSec = hexToRgb(colSecHex);
  }

  const slotEntry = {
    animation: anim,
    color_primary: rgb,
    color_secondary: rgbSec,
    dynamic_secondary: dynSec,
    brightness: isPwm ? briPercent : undefined,
    duration: dur,
    fps: 50,
    speed: speed,
    reverse: reverse,
    enabled: en
  };

  // Store per-segment player override (under both hwKey anchor and segKey)
  const segHwKey = currentSeg ? currentSeg.hwKey : null;
  if (segHwKey) {
    if (!appState.profile.device_events[selectedMatrixDeviceIp][segHwKey]) {
      appState.profile.device_events[selectedMatrixDeviceIp][segHwKey] = {};
    }
    appState.profile.device_events[selectedMatrixDeviceIp][segHwKey][`player_${slotId}`] = slotEntry;
  }
  appState.profile.device_events[selectedMatrixDeviceIp][segKey][`player_${slotId}`] = slotEntry;

  const row = document.querySelector(`.matrix-player-row[data-slot-id="${slotId}"]`);
  const wasEnabled = row ? row.classList.contains('is-enabled') : false;
  if (row && enElem) {
    row.classList.toggle('is-disabled', !en);
    row.classList.toggle('is-enabled', en);
  }

  // Refresh Game Started warning if throw triggers changed
  refreshGameStartDurationWarning();

  // Dynamically update duration baseline hint
  const durHint = document.getElementById(`dur_p_hint_${slotId}`);
  if (durHint) {
    durHint.style.display = dur === 0 ? 'inline-flex' : 'none';
  }

  // Mark matrix as having unsaved modifications
  setMatrixDirty(true);

  if (localStorage.getItem('autoglow_hide_disabled_matrix') === 'true' && wasEnabled !== en) {
    renderEffectsTable();
  } else {
    updateCategoryCountBadge('players');
  }

  if (matrixLivePreviewActive && en) {
    dispatchMatrixLivePreview({
      event: 'throw',
      ip: selectedMatrixDeviceIp,
      segment_id: selectedMatrixSegmentId,
      effect: {
        animation: anim,
        color_primary: rgb,
        color_secondary: rgbSec,
        dynamic_secondary: dynSec,
        brightness: isPwm ? briPercent : undefined,
        duration: 0.0,
        speed: speed,
        fps: 50,
        reverse: reverse,
        enabled: true
      }
    });
  }
}

async function triggerPlayerSlotTest(slotId) {
  const currentSeg = getDeviceSegments(selectedMatrixDeviceIp).find(s => s.id === selectedMatrixSegmentId);
  const isPwm = currentSeg ? (String(currentSeg.type || '').toLowerCase().includes('pwm') || String(currentSeg.name || '').toLowerCase().includes('pwm')) : false;

  const animElem = document.getElementById(`anim_p_${slotId}`);
  const durElem = document.getElementById(`dur_p_${slotId}`);
  const speedElem = document.getElementById(`speed_p_${slotId}`);
  const revBtn = document.getElementById(`rev_btn_p_${slotId}`);
  const colElem = document.getElementById(`col_p_${slotId}`);
  const colSecElem = document.getElementById(`col_sec_p_${slotId}`);
  const dynSecElem = document.getElementById(`dyn_sec_p_${slotId}`);
  const nameElem = document.getElementById(`name_p_${slotId}`);

  const anim = animElem ? animElem.value : "solid";
  const dur = durElem && durElem.value !== '' && !isNaN(parseFloat(durElem.value)) ? Math.max(0, parseFloat(durElem.value)) : 0.0;
  const speed = speedElem && speedElem.value !== '' && !isNaN(parseFloat(speedElem.value)) ? Math.max(0.01, parseFloat(speedElem.value)) : 1.0;
  const reverse = revBtn ? revBtn.classList.contains('is-reversed') : false;
  const dynSec = dynSecElem ? dynSecElem.checked : false;
  const nameFilter = nameElem ? nameElem.value.trim() : "";

  let rgb = [0, 0, 0];
  let rgbSec = [0, 0, 0];
  let displayLabel = '';

  if (isPwm) {
    const briElem = document.getElementById(`bri_p_${slotId}`);
    const briPercent = briElem && briElem.value !== '' && !isNaN(parseInt(briElem.value, 10)) ? Math.max(0, Math.min(100, parseInt(briElem.value, 10))) : 0;
    const rawBri = Math.round(briPercent * 2.55);
    rgb = [rawBri, rawBri, rawBri];
    displayLabel = `${briPercent}% Brightness`;
  } else {
    const colHex = colElem ? colElem.value : "#000000";
    rgb = hexToRgb(colHex);
    const colSecHex = colSecElem ? colSecElem.value : "#000000";
    rgbSec = hexToRgb(colSecHex);
    displayLabel = colHex.toUpperCase();
  }

  // Update in-memory state before dispatch
  updatePlayerSlotConfig(slotId);

  // Auto-connect UDP if currently in HTTP idle mode
  if (currentProtocolMode !== 'udp') {
    await toggleProtocolMode();
  }

  if (rgb && (rgb[0] || rgb[1] || rgb[2])) {
    window.lastTestedMatrixColor = rgb;
  }

  let prevColor = null;
  if (dynSec && window.lastTestedMatrixColor && (window.lastTestedMatrixColor[0] || window.lastTestedMatrixColor[1] || window.lastTestedMatrixColor[2])) {
    prevColor = window.lastTestedMatrixColor;
  }

  showToast(`Testing Player ${slotId} (${nameFilter ? `"${nameFilter}"` : displayLabel}) on Seg #${selectedMatrixSegmentId ?? 0}...`, 'info');
  try {
    const res = await fetch('/api/test/effect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'throw',
        ip: selectedMatrixDeviceIp,
        segment_id: selectedMatrixSegmentId,
        previous_color: prevColor,
        effect: {
          animation: anim,
          color_primary: rgb,
          color_secondary: rgbSec,
          dynamic_secondary: dynSec,
          brightness: isPwm ? (Math.round((rgb[0] / 255) * 100)) : undefined,
          duration: dur,
          speed: speed,
          fps: 50,
          reverse: reverse,
          enabled: true
        }
      })
    });
    const data = await res.json();
    if (data.status !== 'ok') {
      showToast(`Test error: ${data.message}`, 'error');
    }
  } catch (err) {
    showToast(`Test failed: ${err.message}`, 'error');
  }
}

function updateEventConfig(key) {
  if (!selectedMatrixDeviceIp) return;
  if (!appState.profile) appState.profile = { events: {}, device_events: {} };
  if (!appState.profile.device_events) appState.profile.device_events = {};
  if (!appState.profile.device_events[selectedMatrixDeviceIp]) appState.profile.device_events[selectedMatrixDeviceIp] = {};
  
  const segKey = String(selectedMatrixSegmentId !== null && selectedMatrixSegmentId !== undefined ? selectedMatrixSegmentId : 0);
  if (!appState.profile.device_events[selectedMatrixDeviceIp][segKey]) {
    appState.profile.device_events[selectedMatrixDeviceIp][segKey] = {};
  }

  const def = EVENT_DEFS.find(d => d.key === key) || {};
  const currentSeg = getDeviceSegments(selectedMatrixDeviceIp).find(s => s.id === selectedMatrixSegmentId);
  const isPwm = currentSeg ? (String(currentSeg.type || '').toLowerCase().includes('pwm') || String(currentSeg.name || '').toLowerCase().includes('pwm')) : false;

  const animElem = document.getElementById(`anim_${key}`);
  const durElem = document.getElementById(`dur_${key}`);
  const enElem = document.getElementById(`en_${key}`);
  const speedElem = document.getElementById(`speed_${key}`);
  const revBtn = document.getElementById(`rev_btn_${key}`);
  const colSecElem = document.getElementById(`col_sec_${key}`);
  const dynSecElem = document.getElementById(`dyn_sec_${key}`);

  const anim = animElem ? animElem.value : (def.defaultAnim || "solid");
  const dur = durElem && durElem.value !== '' && !isNaN(parseFloat(durElem.value)) ? Math.max(0, parseFloat(durElem.value)) : (def.defaultDur ?? 0.0);
  const en = enElem ? enElem.checked : false;
  const speed = speedElem && speedElem.value !== '' && !isNaN(parseFloat(speedElem.value)) ? Math.max(0.01, parseFloat(speedElem.value)) : 1.0;
  const reverse = revBtn ? revBtn.classList.contains('is-reversed') : false;
  const dynSec = dynSecElem ? dynSecElem.checked : false;

  let rgb = [0, 0, 0];
  let rgbSec = [0, 0, 0];
  let briPercent = 0;

  if (isPwm) {
    const briElem = document.getElementById(`bri_${key}`);
    briPercent = briElem && briElem.value !== '' && !isNaN(parseInt(briElem.value, 10)) ? Math.max(0, Math.min(100, parseInt(briElem.value, 10))) : 0;
    const rawBri = Math.round(briPercent * 2.55);
    rgb = [rawBri, rawBri, rawBri];
  } else {
    const colElem = document.getElementById(`col_${key}`);
    const colHex = colElem ? colElem.value : (def.defaultCol || "#000000");
    rgb = hexToRgb(colHex);
    const colSecHex = colSecElem ? colSecElem.value : "#000000";
    rgbSec = hexToRgb(colSecHex);
  }

  const eventEntry = {
    animation: anim,
    color_primary: rgb,
    color_secondary: rgbSec,
    dynamic_secondary: dynSec,
    brightness: isPwm ? briPercent : undefined,
    duration: dur,
    speed: speed,
    fps: 50,
    reverse: reverse,
    enabled: en
  };

  const segHwKey = currentSeg ? currentSeg.hwKey : null;
  if (segHwKey) {
    if (!appState.profile.device_events[selectedMatrixDeviceIp][segHwKey]) {
      appState.profile.device_events[selectedMatrixDeviceIp][segHwKey] = {};
    }
    appState.profile.device_events[selectedMatrixDeviceIp][segHwKey][key] = eventEntry;
  }
  appState.profile.device_events[selectedMatrixDeviceIp][segKey][key] = eventEntry;

  // Update row disabled/enabled visual state
  const row = document.querySelector(`.matrix-event-row[data-event-key="${key}"]`);
  const wasEnabled = row ? row.classList.contains('is-enabled') : false;
  if (row) {
    row.classList.toggle('is-disabled', !en);
    row.classList.toggle('is-enabled', en);
  }

  // Dynamically update game_start duration warning
  refreshGameStartDurationWarning();

  // Dynamically update duration baseline hint
  const durHint = document.getElementById(`dur_hint_${key}`);
  if (durHint) {
    durHint.style.display = dur === 0 ? 'inline-flex' : 'none';
  }

  // Mark matrix as having unsaved modifications
  setMatrixDirty(true);

  // If hide disabled triggers is active and enable state changed, refresh table
  if (localStorage.getItem('autoglow_hide_disabled_matrix') === 'true' && wasEnabled !== en) {
    renderEffectsTable();
  } else if (def.category) {
    updateCategoryCountBadge(def.category);
  }

  if (matrixLivePreviewActive && en) {
    dispatchMatrixLivePreview({
      event: key,
      ip: selectedMatrixDeviceIp,
      segment_id: selectedMatrixSegmentId,
      effect: {
        animation: anim,
        color_primary: rgb,
        color_secondary: rgbSec,
        dynamic_secondary: dynSec,
        brightness: isPwm ? briPercent : undefined,
        duration: 0.0,
        speed: speed,
        fps: 50,
        reverse: reverse,
        enabled: true
      }
    });
  }
}

function setMatrixDirty(isDirty) {
  matrixDirty = !!isDirty;
  if (typeof window !== 'undefined') window.matrixDirty = matrixDirty;
  const btn = document.getElementById('matrixSaveBtn');
  if (btn) {
    btn.textContent = matrixDirty ? 'Save Matrix *' : 'Save Matrix';
    btn.style.boxShadow = matrixDirty ? '0 0 8px rgba(20, 184, 166, 0.4)' : '';
  }
}

let pendingPresetSwitch = null;

async function renderPresetDropdown() {
  const select = document.getElementById('matrixPresetSelect');
  const btnDelete = document.getElementById('btnDeletePreset');
  const btnRename = document.getElementById('btnRenamePreset');
  if (!select) return;

  let presets = [];
  let active = appState.active_profile || 'Default';

  try {
    const res = await fetch('/api/matrix/presets');
    const data = await res.json();
    if (data.status === 'ok') {
      presets = data.presets || [];
      active = data.active_profile || 'Default';
      appState.active_profile = active;
    }
  } catch (e) {
    console.warn('[AutoGlow] Could not fetch matrix presets:', e);
    presets = Array.isArray(appState.profiles) && appState.profiles.length > 0
      ? appState.profiles.map(p => p.name)
      : ['Default'];
  }

  if (presets.length === 0) presets = ['Default'];
  if (!presets.includes(active)) presets.unshift(active);

  select.innerHTML = presets.map(name => {
    return `<option value="${escapeHtml(name)}" ${name === active ? 'selected' : ''}>${escapeHtml(name)}</option>`;
  }).join('');

  const isDefault = (active.toLowerCase() === 'default');
  const isOnlyOne = (presets.length <= 1);

  if (btnDelete) {
    btnDelete.disabled = isDefault || isOnlyOne;
    btnDelete.style.opacity = (isDefault || isOnlyOne) ? '0.35' : '1';
    btnDelete.style.cursor = (isDefault || isOnlyOne) ? 'not-allowed' : 'pointer';
    btnDelete.title = isDefault ? "The 'Default' preset cannot be deleted" : (isOnlyOne ? 'Cannot delete the only preset' : `Delete preset '${active}'`);
  }

  if (btnRename) {
    btnRename.disabled = isDefault;
    btnRename.style.opacity = isDefault ? '0.35' : '1';
    btnRename.style.cursor = isDefault ? 'not-allowed' : 'pointer';
    btnRename.title = isDefault ? "The 'Default' preset cannot be renamed" : `Rename preset '${active}'`;
  }
}

async function onPresetSelected(targetName) {
  if (!targetName || targetName === appState.active_profile) return;

  if (matrixDirty) {
    pendingPresetSwitch = targetName;
    promptUnsavedSwitch(appState.active_profile, targetName);
    return;
  }

  await executePresetSwitch(targetName);
}

async function executePresetSwitch(targetName) {
  try {
    const res = await fetch('/api/matrix/presets/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: targetName })
    });
    const data = await res.json();
    if (data.status === 'ok') {
      appState.active_profile = data.active_profile;
      appState.profile = data.profile;
      setMatrixDirty(false);
      renderEffectsTable();
      await renderPresetDropdown();
      showToast(`Loaded preset '${data.active_profile}'`, 'info');
    } else {
      showToast(`Failed to switch preset: ${data.message}`, 'error');
      await renderPresetDropdown();
    }
  } catch (err) {
    showToast(`Error switching preset: ${err.message || err}`, 'error');
    await renderPresetDropdown();
  }
}

function openPresetModalView(viewId) {
  const backdrop = document.getElementById('matrixPresetModalBackdrop');
  const views = ['presetModalNew', 'presetModalRename', 'presetModalDelete', 'presetModalUnsaved'];
  views.forEach(v => {
    const el = document.getElementById(v);
    if (el) el.style.display = (v === viewId) ? 'block' : 'none';
  });
  if (backdrop) backdrop.style.display = 'flex';
}

function closePresetModal() {
  const backdrop = document.getElementById('matrixPresetModalBackdrop');
  if (backdrop) backdrop.style.display = 'none';
  pendingPresetSwitch = null;
  const select = document.getElementById('matrixPresetSelect');
  if (select && appState.active_profile) {
    select.value = appState.active_profile;
  }
}

function promptNewPreset() {
  const input = document.getElementById('newPresetNameInput');
  if (input) {
    input.value = '';
  }
  const tplClone = document.getElementById('tplCloneCurrent');
  if (tplClone) tplClone.checked = true;
  openPresetModalView('presetModalNew');
  setTimeout(() => { if (input) input.focus(); }, 50);
}

async function submitNewPreset() {
  const input = document.getElementById('newPresetNameInput');
  const name = input ? input.value.trim() : '';
  if (!name) {
    showToast('Please enter a preset name.', 'error');
    if (input) input.focus();
    return;
  }

  const tplBlank = document.getElementById('tplBlankDefaults');
  const isBlank = tplBlank && tplBlank.checked;

  let profileData = null;
  if (isBlank) {
    profileData = {
      name: name,
      events: {},
      device_events: {},
      player_slots: JSON.parse(JSON.stringify(DEFAULT_PLAYER_SLOTS))
    };
  } else {
    EVENT_DEFS.forEach(def => updateEventConfig(def.key));
    for (let i = 1; i <= 10; i++) updatePlayerSlotConfig(i);
    profileData = JSON.parse(JSON.stringify(appState.profile || {}));
    profileData.name = name;
  }

  try {
    const res = await fetch('/api/matrix/presets/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name,
        profile: profileData,
        set_active: true
      })
    });
    const data = await res.json();
    if (data.status === 'ok') {
      appState.active_profile = data.active_profile;
      appState.profile = data.profile;
      setMatrixDirty(false);
      closePresetModal();
      renderEffectsTable();
      await renderPresetDropdown();
      showToast(`Preset '${name}' created and activated.`, 'success');
    } else {
      showToast(`Failed to create preset: ${data.message}`, 'error');
    }
  } catch (err) {
    showToast(`Error creating preset: ${err.message || err}`, 'error');
  }
}

function promptRenamePreset() {
  const active = appState.active_profile || 'Default';
  if (active.toLowerCase() === 'default') {
    showToast("The 'Default' preset cannot be renamed.", 'info');
    return;
  }
  const input = document.getElementById('renamePresetNameInput');
  if (input) {
    input.value = active;
  }
  openPresetModalView('presetModalRename');
  setTimeout(() => { if (input) { input.focus(); input.select(); } }, 50);
}

async function submitRenamePreset() {
  const input = document.getElementById('renamePresetNameInput');
  const newName = input ? input.value.trim() : '';
  const oldName = appState.active_profile;

  if (!newName) {
    showToast('Please enter a new preset name.', 'error');
    if (input) input.focus();
    return;
  }

  if (newName === oldName) {
    closePresetModal();
    return;
  }

  try {
    const res = await fetch('/api/matrix/presets/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_name: oldName, new_name: newName })
    });
    const data = await res.json();
    if (data.status === 'ok') {
      appState.active_profile = data.active_profile;
      if (appState.profile) appState.profile.name = data.active_profile;
      closePresetModal();
      await renderPresetDropdown();
      showToast(`Preset renamed to '${data.active_profile}'.`, 'success');
    } else {
      showToast(`Failed to rename preset: ${data.message}`, 'error');
    }
  } catch (err) {
    showToast(`Error renaming preset: ${err.message || err}`, 'error');
  }
}

function promptDeletePreset() {
  const active = appState.active_profile || 'Default';
  if (active.toLowerCase() === 'default') {
    showToast("The 'Default' preset cannot be deleted.", 'info');
    return;
  }
  const targetSpan = document.getElementById('deletePresetTargetName');
  if (targetSpan) targetSpan.textContent = active;
  openPresetModalView('presetModalDelete');
}

async function submitDeletePreset() {
  const target = appState.active_profile;
  try {
    const res = await fetch('/api/matrix/presets', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: target })
    });
    const data = await res.json();
    if (data.status === 'ok') {
      appState.active_profile = data.active_profile;
      appState.profile = data.profile;
      setMatrixDirty(false);
      closePresetModal();
      renderEffectsTable();
      await renderPresetDropdown();
      showToast(`Preset '${target}' deleted. Active preset is now '${data.active_profile}'.`, 'info');
    } else {
      showToast(`Failed to delete preset: ${data.message}`, 'error');
    }
  } catch (err) {
    showToast(`Error deleting preset: ${err.message || err}`, 'error');
  }
}

function promptUnsavedSwitch(currentName, targetName) {
  const curSpan = document.getElementById('unsavedPresetCurrentName');
  const tarSpan = document.getElementById('unsavedPresetTargetName');
  if (curSpan) curSpan.textContent = currentName;
  if (tarSpan) tarSpan.textContent = targetName;
  openPresetModalView('presetModalUnsaved');
}

async function confirmSwitchSave() {
  const target = pendingPresetSwitch;
  closePresetModal();
  const ok = await saveEffectsProfile();
  if (ok && target) {
    await executePresetSwitch(target);
  }
}

async function confirmSwitchDiscard() {
  const target = pendingPresetSwitch;
  closePresetModal();
  setMatrixDirty(false);
  if (target) {
    await executePresetSwitch(target);
  }
}

function triggerImportPreset() {
  const fileInput = document.getElementById('importPresetFileInput');
  if (fileInput) {
    fileInput.value = '';
    fileInput.click();
  }
}

async function handlePresetFileImport(event) {
  const file = event.target && event.target.files && event.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      showToast('Import failed: Selected file is not valid JSON.', 'error');
      return;
    }

    if (!data || typeof data !== 'object') {
      showToast('Import failed: JSON file does not contain a valid preset object.', 'error');
      return;
    }

    const res = await fetch('/api/matrix/presets/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    const result = await res.json();
    if (result.status === 'ok') {
      appState.active_profile = result.active_profile;
      appState.profile = result.profile;
      setMatrixDirty(false);
      renderEffectsTable();
      await renderPresetDropdown();
      showToast(`Preset '${result.active_profile}' imported and activated.`, 'success');
    } else {
      showToast(`Import failed: ${result.message}`, 'error');
    }
  } catch (err) {
    showToast(`Error reading file: ${err.message || err}`, 'error');
  }
}

async function saveEffectsProfile() {
  if (!selectedMatrixDeviceIp) return false;
  EVENT_DEFS.forEach(def => updateEventConfig(def.key));
  for (let i = 1; i <= 10; i++) {
    updatePlayerSlotConfig(i);
  }

  const currentPresetName = appState.active_profile || 'Default';
  try {
    const res = await fetch('/api/matrix/presets/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: currentPresetName,
        profile: appState.profile,
        set_active: true
      })
    });
    const data = await res.json();
    if (data.status === 'ok') {
      appState.active_profile = data.active_profile;
      appState.profile = data.profile;
      setMatrixDirty(false);
      await renderPresetDropdown();
      showToast(`Event Lighting Matrix saved to preset '${currentPresetName}'.`, 'success');
      return true;
    } else {
      showToast(`Save failed: ${data.message}`, 'error');
      return false;
    }
  } catch (err) {
    showToast(`Network error saving preset: ${err.message || err}`, 'error');
    return false;
  }
}

async function triggerEffectTest(eventKey) {
  const currentSeg = getDeviceSegments(selectedMatrixDeviceIp).find(s => s.id === selectedMatrixSegmentId);
  const isPwm = currentSeg ? (String(currentSeg.type || '').toLowerCase().includes('pwm') || String(currentSeg.name || '').toLowerCase().includes('pwm')) : false;

  const animElem = document.getElementById(`anim_${eventKey}`);
  const durElem = document.getElementById(`dur_${eventKey}`);
  const speedElem = document.getElementById(`speed_${eventKey}`);
  const revBtn = document.getElementById(`rev_btn_${eventKey}`);
  const colSecElem = document.getElementById(`col_sec_${eventKey}`);
  const dynSecElem = document.getElementById(`dyn_sec_${eventKey}`);
  
  const def = EVENT_DEFS.find(d => d.key === eventKey) || {};
  const anim = animElem ? animElem.value : (def.defaultAnim || "solid");
  const dur = durElem && durElem.value !== '' && !isNaN(parseFloat(durElem.value)) ? Math.max(0, parseFloat(durElem.value)) : (def.defaultDur ?? 0.0);
  const speed = speedElem && speedElem.value !== '' && !isNaN(parseFloat(speedElem.value)) ? Math.max(0.01, parseFloat(speedElem.value)) : 1.0;
  const reverse = revBtn ? revBtn.classList.contains('is-reversed') : false;
  const dynSec = dynSecElem ? dynSecElem.checked : false;

  let rgb = [0, 0, 0];
  let rgbSec = [0, 0, 0];
  let displayLabel = '';

  if (isPwm) {
    const briElem = document.getElementById(`bri_${eventKey}`);
    const briPercent = briElem && briElem.value !== '' && !isNaN(parseInt(briElem.value, 10)) ? Math.max(0, Math.min(100, parseInt(briElem.value, 10))) : 0;
    const rawBri = Math.round(briPercent * 2.55);
    rgb = [rawBri, rawBri, rawBri];
    displayLabel = `${briPercent}% Brightness`;
  } else {
    const colElem = document.getElementById(`col_${eventKey}`);
    const colHex = colElem ? colElem.value : (def.defaultCol || "#000000");
    rgb = hexToRgb(colHex);
    const colSecHex = colSecElem ? colSecElem.value : "#000000";
    rgbSec = hexToRgb(colSecHex);
    displayLabel = colHex.toUpperCase();
  }

  // Auto-connect UDP if currently in HTTP idle mode
  if (currentProtocolMode !== 'udp') {
    await toggleProtocolMode();
  }

  if (rgb && (rgb[0] || rgb[1] || rgb[2])) {
    window.lastTestedMatrixColor = rgb;
  }

  let prevColor = null;
  if (dynSec) {
    if (window.lastTestedMatrixColor && (window.lastTestedMatrixColor[0] || window.lastTestedMatrixColor[1] || window.lastTestedMatrixColor[2])) {
      prevColor = window.lastTestedMatrixColor;
    } else {
      const p1Elem = document.getElementById('col_p_1');
      if (p1Elem && p1Elem.value) {
        prevColor = hexToRgb(p1Elem.value);
      } else {
        const gsElem = document.getElementById('col_game_start');
        if (gsElem && gsElem.value) {
          prevColor = hexToRgb(gsElem.value);
        }
      }
    }
  }

  showToast(`Testing ${def.label || eventKey} (${displayLabel}) on Seg #${selectedMatrixSegmentId ?? 0}...`, 'info');
  try {
    const res = await fetch('/api/test/effect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: eventKey,
        ip: selectedMatrixDeviceIp,
        segment_id: selectedMatrixSegmentId,
        previous_color: prevColor,
        effect: {
          animation: anim,
          color_primary: rgb,
          color_secondary: rgbSec,
          dynamic_secondary: dynSec,
          brightness: isPwm ? (Math.round((rgb[0] / 255) * 100)) : undefined,
          duration: dur,
          speed: speed,
          fps: 50,
          reverse: reverse,
          enabled: true
        }
      })
    });
    const data = await res.json();
    if (data.status !== 'ok') {
      showToast(`Test error: ${data.message}`, 'error');
    }
  } catch (err) {
    showToast(`Test failed: ${err.message}`, 'error');
  }
}


// --- Protocol Exclusivity Controls (UDP vs HTTP) ---
let currentProtocolMode = 'http';

async function fetchProtocolMode() {
  try {
    const res = await fetch('/api/protocol/mode');
    const data = await res.json();
    if (data.status === 'ok') {
      currentProtocolMode = data.mode;
      updateProtocolUI(data.mode);
    }
  } catch (err) {
    console.debug('Failed to fetch protocol mode:', err);
  }
}

async function toggleProtocolMode() {
  const targetMode = currentProtocolMode === 'udp' ? 'http' : 'udp';
  const btn = document.getElementById('btnToggleProtocol');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/protocol/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: targetMode })
    });
    const data = await res.json();
    if (data.status === 'ok') {
      currentProtocolMode = data.mode;
      updateProtocolUI(data.mode);
      showToast(data.mode === 'udp' ? 'UDP Mode Connected (DRGB Stream Active).' : 'UDP Released. HTTP Mode Idle.', 'info');
    }
  } catch (err) {
    showToast(`Protocol switch failed: ${err.message || err}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function updateProtocolUI(mode) {
  currentProtocolMode = mode;
  const badge = document.getElementById('protocolStatusBadge');
  const text = document.getElementById('protocolModeText');
  const btn = document.getElementById('btnToggleProtocol');
  const btnText = document.getElementById('protocolBtnText');

  if (mode === 'udp') {
    if (badge) {
      badge.className = 'protocol-status-badge udp';
    }
    if (text) text.innerText = 'UDP LIVE';
    if (btn) btn.className = 'btn-ide protocol-toggle-btn active';
    if (btnText) btnText.innerText = 'Disconnect UDP';
  } else {
    if (badge) {
      badge.className = 'protocol-status-badge http';
    }
    if (text) text.innerText = 'HTTP IDLE';
    if (btn) btn.className = 'btn-ide protocol-toggle-btn';
    if (btnText) btnText.innerText = 'Connect UDP';
  }
}

if (typeof window !== "undefined") {
  window.toggleMatrixSubmenu = toggleMatrixSubmenu;
  window.renderMatrixSubmenu = renderMatrixSubmenu;
  window.selectMatrixDevice = selectMatrixDevice;
  window.selectMatrixSegment = selectMatrixSegment;
  window.renderMatrixDeviceLanding = renderMatrixDeviceLanding;
  window.renderEffectsTable = renderEffectsTable;
  window.renderMatrixForDevice = renderMatrixForDevice;
  window.toggleMatrixLivePreview = toggleMatrixLivePreview;
  window.toggleHideDisabledTriggers = toggleHideDisabledTriggers;
  window.updateCategoryCountBadge = updateCategoryCountBadge;
  window.getPlayerSlotConfig = getPlayerSlotConfig;
  window.getSegmentPlayerSlotConfig = getSegmentPlayerSlotConfig;
  window.updatePlayerSlotConfig = updatePlayerSlotConfig;
  window.triggerPlayerSlotTest = triggerPlayerSlotTest;
  window.updateEventConfig = updateEventConfig;
  window.saveEffectsProfile = saveEffectsProfile;
  window.triggerEffectTest = triggerEffectTest;
  window.fetchProtocolMode = fetchProtocolMode;
  window.toggleProtocolMode = toggleProtocolMode;
  window.updateProtocolUI = updateProtocolUI;
  window.setMatrixDirty = setMatrixDirty;
  window.renderPresetDropdown = renderPresetDropdown;
  window.onPresetSelected = onPresetSelected;
  window.promptNewPreset = promptNewPreset;
  window.submitNewPreset = submitNewPreset;
  window.promptRenamePreset = promptRenamePreset;
  window.submitRenamePreset = submitRenamePreset;
  window.promptDeletePreset = promptDeletePreset;
  window.submitDeletePreset = submitDeletePreset;
  window.onAnimationTypeChanged = onAnimationTypeChanged;
  window.onPlayerAnimationTypeChanged = onPlayerAnimationTypeChanged;
  window.onDynamicSecondaryToggled = onDynamicSecondaryToggled;
  window.onPlayerDynamicSecondaryToggled = onPlayerDynamicSecondaryToggled;
  window.toggleEventReverse = toggleEventReverse;
  window.togglePlayerSlotReverse = togglePlayerSlotReverse;
  window.closePresetModal = closePresetModal;
  window.confirmSwitchSave = confirmSwitchSave;
  window.confirmSwitchDiscard = confirmSwitchDiscard;
  window.triggerImportPreset = triggerImportPreset;
  window.handlePresetFileImport = handlePresetFileImport;
}


