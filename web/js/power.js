// AutoGlow 2 - Power timers, and the idle lighting editor shown in each controller's drawer (Setup › Controllers)

// --- Idle lighting (saved on the controller as WLED preset 1, which is also its boot preset) ---
let wledEffectsCache = [];

async function fetchWledEffects(ip) {
  if (wledEffectsCache.length > 0) return wledEffectsCache;
  try {
    const res = await fetch(`/api/wled/effects?ip=${encodeURIComponent(ip)}`);
    const data = await res.json();
    if (data.effects && Array.isArray(data.effects)) {
      wledEffectsCache = data.effects;
    }
  } catch (err) {
    console.debug('Failed to fetch WLED effects:', err);
  }
  return wledEffectsCache;
}

async function loadIdlePresetForSelectedDevice(targetIp) {
  const ip = targetIp || idlePresetState.ip;
  if (!ip) return;
  idlePresetState.ip = ip;

  const container = document.getElementById('idleSegmentsListContainer');
  const btnPreview = document.getElementById('btnPreviewIdlePreset');
  const btnSave = document.getElementById('btnSaveIdlePreset');
  const dev = (Array.isArray(appState.devices) ? appState.devices : []).find(d => d.ip === ip);
  const devName = dev ? (dev.name || 'WLED Controller') : ip;

  const renderOfflineView = () => {
    idlePresetState.loaded = false;
    idlePresetState.segments = [];
    if (container) {
      container.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 36px 20px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 10px;">
          <strong style="color: var(--text-primary); font-size: 14px;">Controller is Offline</strong>
          <p style="color: var(--text-secondary); font-size: 12px; max-width: 360px; margin: 0; line-height: 1.5;">
            Cannot connect to <strong>${escapeHtml(devName)}</strong> (${escapeHtml(ip)}). Make sure the device is powered on and reachable on your network.
          </p>
        </div>
      `;
    }
    if (btnPreview) btnPreview.style.display = 'none';
    if (btnSave) btnSave.style.display = 'none';
  };

  // Instant Check: If already known offline from previous ping, render immediately in 0ms!
  const cached = lastFetchedLiveDeviceData[ip];
  if (cached && cached.online === false) {
    renderOfflineView();
    return;
  }

  // Placeholder while loading, so another controller's cards never show here
  if (container) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; padding: 36px 20px; text-align: center; color: var(--text-muted); font-family: var(--font-mono); font-size: 12px;">
        Loading idle lighting (${escapeHtml(ip)})...
      </div>
    `;
  }

  // Verify live online status using cached/in-flight singleton
  const pingData = await pingDeviceCached(ip);
  if (idlePresetState.ip !== ip) return;
  const isOnline = pingData && pingData.status === 'ok' && pingData.online === true;

  if (!isOnline) {
    renderOfflineView();
    return;
  }

  if (btnPreview) btnPreview.style.display = '';
  if (btnSave) btnSave.style.display = '';

  // 1. Fetch WLED effects catalog
  await fetchWledEffects(ip);

  // 2. Fetch live hardware segments
  const hwSegments = getDeviceSegments(ip);

  // 3. Fetch Preset 1 from device
  let presetSegments = null;
  try {
    const res = await fetch(`/api/wled/preset?ip=${encodeURIComponent(ip)}&id=1`);
    const data = await res.json();
    if (data && Array.isArray(data.seg) && data.seg.length > 0) {
      idlePresetState.presetId = data.id || 1;
      idlePresetState.name = data.name || 'AutoGlow Default';
      presetSegments = data.seg;
    }
  } catch (err) {
    console.debug('Failed to fetch preset from device, using hardware segments:', err);
  }

  if (idlePresetState.ip !== ip) return;

  // 4. Build idlePresetState.segments matching all configured segments
  idlePresetState.segments = hwSegments.map((hwMatch, idx) => {
    const pSeg = (presetSegments && presetSegments.length > 0)
      ? (presetSegments.find(s => parseInt(s.id, 10) === parseInt(hwMatch.id, 10)) || presetSegments[idx] || {})
      : {};

    const segId = hwMatch.id !== undefined ? parseInt(hwMatch.id, 10) : idx;
    const start = hwMatch.start !== undefined ? parseInt(hwMatch.start, 10) : 0;
    const stop = hwMatch.stop !== undefined ? parseInt(hwMatch.stop, 10) : (start + 1);
    const len = Math.max(1, stop - start);
    const segName = pSeg.n || hwMatch.name || (len === 1 ? `PWM White (Seg ${segId})` : `WS281x (Seg ${segId})`);
    const isPwm = hwMatch.type ? String(hwMatch.type).toLowerCase().includes('pwm') : (String(segName).toLowerCase().includes('pwm') || len === 1);

    const on = pSeg.on !== undefined ? (pSeg.on !== false) : true;
    const bri = pSeg.bri !== undefined ? parseInt(pSeg.bri, 10) : (isPwm ? 71 : 64);
    const briPercent = Math.round((Math.max(0, Math.min(255, bri)) / 255) * 100);

    const col0 = pSeg.col?.[0];
    const colPrimary = (Array.isArray(col0) && col0.length >= 3) ? rgbToHex(col0.slice(0, 3)) : '#00ff9d';
    const col1 = pSeg.col?.[1];
    const colSecondary = (Array.isArray(col1) && col1.length >= 3) ? rgbToHex(col1.slice(0, 3)) : '#000000';
    const col2 = pSeg.col?.[2];
    const colTertiary = (Array.isArray(col2) && col2.length >= 3) ? rgbToHex(col2.slice(0, 3)) : '#000000';

    return {
      id: segId,
      name: segName,
      type: isPwm ? 'PWM White' : 'WS281x',
      start: start,
      stop: stop,
      len: len,
      isPwm: isPwm,
      on: on,
      briPercent: briPercent,
      fx: parseInt(pSeg.fx, 10) || 0,
      speed: pSeg.sx !== undefined ? parseInt(pSeg.sx, 10) : 128,
      intensity: pSeg.ix !== undefined ? parseInt(pSeg.ix, 10) : 128,
      colPrimary: colPrimary,
      colSecondary: colSecondary,
      colTertiary: colTertiary
    };
  });

  idlePresetState.loaded = true;
  renderIdleSegmentsList();
}

function getWledEffects() {
  return wledEffectsCache.length > 0 ? wledEffectsCache : [
    { id: 0, name: 'Solid', colors: 1, colorSlots: [{ slot: 0, label: 'Primary' }], speed: false, intensity: false },
    { id: 2, name: 'Breathe', colors: 2, colorSlots: [{ slot: 0, label: 'Primary' }, { slot: 1, label: 'Secondary' }], speed: true, intensity: false },
    { id: 9, name: 'Rainbow', colors: 0, colorSlots: [], speed: true, intensity: true, intensityLabel: 'Size' },
    { id: 8, name: 'Colorloop', colors: 0, colorSlots: [], speed: true, intensity: true, intensityLabel: 'Saturation' },
    { id: 16, name: 'Aurora', colors: 3, colorSlots: [{ slot: 0, label: 'Primary' }, { slot: 1, label: 'Secondary' }, { slot: 2, label: 'Tertiary' }], speed: true, intensity: true }
  ];
}

const KNOWN_WLED_EFFECTS_META = {
  0: { name: 'Solid', colors: 1, colorSlots: [{ slot: 0, label: 'Primary' }], speed: false, intensity: false, palette: false },
  1: { name: 'Blink', colors: 2, colorSlots: [{ slot: 0, label: 'Primary' }, { slot: 1, label: 'Secondary' }], speed: true, intensity: false },
  2: { name: 'Breathe', colors: 2, colorSlots: [{ slot: 0, label: 'Primary' }, { slot: 1, label: 'Secondary' }], speed: true, intensity: false },
  8: { name: 'Colorloop', colors: 0, colorSlots: [], speed: true, intensity: true, intensityLabel: 'Saturation', palette: true },
  9: { name: 'Rainbow', colors: 0, colorSlots: [], speed: true, intensity: true, intensityLabel: 'Size', palette: true },
  16: { name: 'Aurora', colors: 3, colorSlots: [{ slot: 0, label: 'Primary' }, { slot: 1, label: 'Secondary' }, { slot: 2, label: 'Tertiary' }], speed: true, intensity: true, palette: false },
  42: { name: 'Fire 2012', colors: 0, colorSlots: [], speed: true, intensity: true, palette: true },
  44: { name: 'Fireworks', colors: 0, colorSlots: [], speed: true, intensity: true, palette: true },
  63: { name: 'Pride 2015', colors: 0, colorSlots: [], speed: true, intensity: true, palette: true },
  64: { name: 'Party', colors: 0, colorSlots: [], speed: true, intensity: true, palette: true },
  75: { name: 'Matrix', colors: 0, colorSlots: [], speed: true, intensity: true, palette: true },
  92: { name: 'Plasma', colors: 0, colorSlots: [], speed: true, intensity: true, palette: true }
};

function getWledEffectMetadata(fxId) {
  const effects = getWledEffects();
  const fxObj = effects.find(e => e.id === fxId);
  const known = KNOWN_WLED_EFFECTS_META[fxId];
  if (known) {
    return {
      id: fxId,
      name: fxObj?.name || known.name,
      speedLabel: 'Speed',
      intensityLabel: 'Intensity',
      palette: known.colors === 0,
      ...known
    };
  }
  if (fxObj && fxObj.colorSlots !== undefined) {
    return fxObj;
  }
  if (fxId === 0) {
    return {
      id: 0,
      name: 'Solid',
      colors: 1,
      colorSlots: [{ slot: 0, label: 'Primary' }],
      speed: false,
      speedLabel: 'Speed',
      intensity: false,
      intensityLabel: 'Intensity',
      palette: false
    };
  }
  // Auto-detect palette effects based on name
  const effName = fxObj?.name || `Effect ${fxId}`;
  const lname = effName.toLowerCase();
  if (lname.includes('palette') || lname.includes('rainbow') || lname.includes('colorloop') || lname.includes('pride') || lname.includes('plasma')) {
    return {
      id: fxId,
      name: effName,
      colors: 0,
      colorSlots: [],
      speed: true,
      speedLabel: 'Speed',
      intensity: true,
      intensityLabel: 'Intensity',
      palette: true
    };
  }
  return {
    id: fxId,
    name: effName,
    colors: 2,
    colorSlots: [{ slot: 0, label: 'Primary' }, { slot: 1, label: 'Secondary' }],
    speed: true,
    speedLabel: 'Speed',
    intensity: true,
    intensityLabel: 'Intensity',
    palette: true
  };
}

function renderEffectColorsHtml(segIdx, fxId) {
  const seg = idlePresetState.segments[segIdx];
  if (!seg) return '';
  const meta = getWledEffectMetadata(fxId);
  const slots = meta.colorSlots || [];

  if (slots.length === 0) {
    return `
      <span class="fx-color-badge-palette" title="This effect uses an internal color palette instead of custom colors">
        Palette
      </span>
    `;
  }

  return slots.map(s => {
    let colVal = seg.colPrimary || '#00ff9d';
    let type = 'primary';
    let slotLabel = s.label || 'Primary';

    if (s.slot === 1) {
      colVal = seg.colSecondary || '#000000';
      type = 'secondary';
      slotLabel = s.label || 'Secondary';
    } else if (s.slot === 2) {
      colVal = seg.colTertiary || '#000000';
      type = 'tertiary';
      slotLabel = s.label || 'Tertiary';
    }

    const titleAttr = `${slotLabel} Color`;

    return `
      <input type="color" 
        id="idleSegColor_${segIdx}_${type}" 
        class="color-picker-input" 
        style="width: 22px; height: 22px; border-radius: 4px; padding: 0; cursor: pointer;" 
        value="${colVal}" 
        oninput="onIdleSegColorChange(${segIdx}, '${type}', this.value)" 
        onchange="onIdleSegColorChange(${segIdx}, '${type}', this.value, true)" 
        title="${escapeHtml(titleAttr)}"
        aria-label="${escapeHtml(titleAttr)}">
    `;
  }).join('');
}

// The drawer closed or switched controllers: forget the loaded preset so the next open reloads it
function resetIdleLighting() {
  idlePresetState.ip = null;
  idlePresetState.loaded = false;
  idlePresetState.segments = [];
  closeAllEffectDropdowns();
}

function renderSearchableEffectSelect(segIdx, selectedFxId) {
  const effects = getWledEffects();
  const currentFx = effects.find(e => e.id === selectedFxId) || effects[0] || { id: 0, name: 'Solid' };
  const totalCount = effects.length || 187;

  return `
    <div class="custom-select-searchable" id="fxSelectSearchable_${segIdx}" onclick="toggleEffectSearchDropdown(${segIdx}, event)">
      <div class="custom-select-trigger">
        <span class="custom-select-value" id="fxSelectVal_${segIdx}">${escapeHtml(currentFx.name)}</span>
        <svg class="custom-select-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="custom-select-dropdown" id="fxDropdown_${segIdx}" onclick="event.stopPropagation()">
        <div class="custom-select-search-box">
          <input type="text" class="custom-select-search-input" id="fxSearchInput_${segIdx}" placeholder="Search ${totalCount} effects..." oninput="filterEffectList(${segIdx}, this.value)" onkeydown="if (event.key === 'Escape') closeAllEffectDropdowns()" autocomplete="off">
        </div>
        <div class="custom-select-options-list" id="fxOptionsList_${segIdx}">
          ${renderEffectOptionsHtml(segIdx, selectedFxId, '')}
        </div>
      </div>
    </div>
  `;
}

function renderEffectOptionsHtml(segIdx, selectedFxId, filterText = '') {
  const effects = getWledEffects();
  const q = filterText.toLowerCase().trim();
  const filtered = q ? effects.filter(e => e.name.toLowerCase().includes(q)) : effects;

  if (filtered.length === 0) {
    return `<div class="custom-select-option-empty">No effects matching "${escapeHtml(filterText)}"</div>`;
  }

  return filtered.map(e => {
    const isSelected = e.id === selectedFxId;
    const meta = getWledEffectMetadata(e.id);
    let badgeText = '';
    if (meta.colors === 0) {
      badgeText = 'Palette';
    } else if (meta.colors === 1) {
      badgeText = '1 Col';
    } else if (meta.colors === 2) {
      badgeText = '2 Col';
    } else if (meta.colors === 3) {
      badgeText = '3 Col';
    }

    return `
      <div class="custom-select-option ${isSelected ? 'selected' : ''}" onclick="selectEffectFromSearch(${segIdx}, ${e.id})">
        <div style="display: flex; align-items: center; justify-content: space-between; width: 100%; gap: 6px;">
          <span>${escapeHtml(e.name)}</span>
          <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
            ${badgeText ? `<span style="font-family: var(--font-mono); font-size: 9px; color: var(--text-muted); padding: 1px 4px; background: rgba(255,255,255,0.04); border-radius: 3px; border: 1px solid var(--border-subtle);">${badgeText}</span>` : ''}
            ${isSelected ? '<span style="color: var(--accent-primary); font-size: 10px;">✓</span>' : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function toggleEffectSearchDropdown(segIdx, event) {
  if (event) event.stopPropagation();
  const el = document.getElementById(`fxSelectSearchable_${segIdx}`);
  if (!el) return;

  const wasOpen = el.classList.contains('open');
  closeAllEffectDropdowns();

  if (!wasOpen) {
    // Check if dropdown should flip upwards if near viewport bottom
    const rect = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow < 260 && rect.top > 260) {
      el.classList.add('dropup');
    } else {
      el.classList.remove('dropup');
    }

    el.classList.add('open');
    const card = el.closest('.idle-seg-card');
    if (card) card.classList.add('dropdown-open');

    const input = document.getElementById(`fxSearchInput_${segIdx}`);
    if (input) {
      input.value = '';
      const list = document.getElementById(`fxOptionsList_${segIdx}`);
      if (list) {
        list.innerHTML = renderEffectOptionsHtml(segIdx, idlePresetState.segments[segIdx]?.fx ?? 0, '');
      }
      setTimeout(() => input.focus(), 50);
    }
  }
}

function filterEffectList(segIdx, query) {
  const list = document.getElementById(`fxOptionsList_${segIdx}`);
  if (!list) return;
  const currentFx = idlePresetState.segments[segIdx]?.fx ?? 0;
  list.innerHTML = renderEffectOptionsHtml(segIdx, currentFx, query);
}

function selectEffectFromSearch(segIdx, fxId) {
  closeAllEffectDropdowns();
  onIdleSegEffectChange(segIdx, fxId);
}

function closeAllEffectDropdowns() {
  document.querySelectorAll('.custom-select-searchable.open').forEach(el => {
    el.classList.remove('open');
    el.classList.remove('dropup');
  });
  document.querySelectorAll('.idle-seg-card.dropdown-open').forEach(card => {
    card.classList.remove('dropdown-open');
  });
}

// Global click-to-close listener for custom dropdowns
document.addEventListener('click', (e) => {
  if (!e.target.closest('.custom-select-searchable')) {
    closeAllEffectDropdowns();
  }
});

// Global Escape listener
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeAllEffectDropdowns();
  }
});

function renderIdleSegmentsList() {
  const container = document.getElementById('idleSegmentsListContainer');
  if (!container) return;

  if (!idlePresetState.segments || idlePresetState.segments.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; padding: 20px; text-align: center; color: var(--text-muted); font-size: 12px; font-family: var(--font-mono);">
        No segments detected on this controller.
      </div>
    `;
    return;
  }

  container.innerHTML = idlePresetState.segments.map((seg, idx) => {
    const isPwm = seg.isPwm;
    const dotColor = isPwm ? '#f59e0b' : 'var(--accent-primary)';
    const meta = isPwm ? null : getWledEffectMetadata(seg.fx);

    return `
      <div class="idle-seg-card ${seg.on ? 'is-enabled' : 'is-disabled'}" id="idleSegCard_${idx}" style="background: var(--bg-card); padding: 10px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 8px;">
        
        <!-- Minimal Segment Header -->
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
          <div style="display: flex; align-items: center; gap: 6px; min-width: 0;">
            <span style="width: 6px; height: 6px; border-radius: 50%; background: ${dotColor}; flex-shrink: 0;"></span>
            <strong style="font-size: 12px; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
              #${seg.id} ${escapeHtml(seg.name)}
            </strong>
            <span style="font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); flex-shrink: 0;">${seg.start}-${seg.stop}</span>
          </div>
          <label class="switch" style="transform: scale(0.7); margin: 0;">
            <input type="checkbox" id="idleSegOnSwitch_${idx}" ${seg.on ? 'checked' : ''} onchange="onIdleSegToggle(${idx}, this.checked)">
            <span class="switch-slider"></span>
          </label>
        </div>

        ${isPwm ? `
          <!-- Minimal PWM Spotlight Controls -->
          <div style="display: flex; align-items: center; gap: 10px;">
            <input type="range" id="idleSegBriSlider_${idx}" min="0" max="100" value="${seg.briPercent}" class="range-ide" style="flex: 1;" oninput="onIdleSegSliderInput(${idx}, 'bri', this.value)">
            <span id="idleSegBriVal_${idx}" style="font-family: var(--font-mono); font-size: 11px; color: #fbbf24; font-weight: 600; min-width: 32px; text-align: right;">${seg.briPercent}%</span>
          </div>
          <div style="display: flex; gap: 4px; justify-content: space-between;">
            <button class="btn-ide" style="font-size: 9.5px; padding: 1px 6px; flex: 1; justify-content: center;" onclick="setIdleSegBri(${idx}, 0)">Off</button>
            <button class="btn-ide" style="font-size: 9.5px; padding: 1px 6px; flex: 1; justify-content: center;" onclick="setIdleSegBri(${idx}, 25)">25%</button>
            <button class="btn-ide" style="font-size: 9.5px; padding: 1px 6px; flex: 1; justify-content: center;" onclick="setIdleSegBri(${idx}, 50)">50%</button>
            <button class="btn-ide" style="font-size: 9.5px; padding: 1px 6px; flex: 1; justify-content: center;" onclick="setIdleSegBri(${idx}, 100)">100%</button>
          </div>
        ` : `
          <!-- Minimal Addressable Controls: Searchable Dropdown + Dynamic Colors -->
          <div style="display: flex; align-items: center; gap: 6px;">
            <div style="flex: 1; min-width: 0;">
              ${renderSearchableEffectSelect(idx, seg.fx)}
            </div>
            <div id="idleSegColors_${idx}" style="display: flex; align-items: center; gap: 4px; flex-shrink: 0;">
              ${renderEffectColorsHtml(idx, seg.fx)}
            </div>
          </div>

          <!-- Inline Brightness Slider -->
          <div style="display: flex; align-items: center; gap: 10px;">
            <input type="range" id="idleSegBriSlider_${idx}" min="0" max="100" value="${seg.briPercent}" class="range-ide" style="flex: 1;" oninput="onIdleSegSliderInput(${idx}, 'bri', this.value)">
            <span id="idleSegBriVal_${idx}" style="font-family: var(--font-mono); font-size: 11px; color: var(--accent-primary); font-weight: 600; min-width: 32px; text-align: right;">${seg.briPercent}%</span>
          </div>

          <!-- Dynamic Speed & Intensity Sliders -->
          <div id="idleSegAnimRow_${idx}" style="display: ${!meta.speed && !meta.intensity ? 'none' : 'grid'}; grid-template-columns: ${meta.speed && meta.intensity ? '1fr 1fr' : '1fr'}; gap: 8px; padding-top: 2px;">
            <div id="idleSegSpeedBox_${idx}" style="display: ${meta.speed ? 'flex' : 'none'}; align-items: center; gap: 6px;">
              <span id="idleSegSpeedLbl_${idx}" style="font-size: 9px; font-family: var(--font-mono); color: var(--text-muted); text-transform: uppercase;" title="${escapeHtml(meta.speedLabel || 'Speed')}">${meta.speedLabel ? (meta.speedLabel.length > 5 ? escapeHtml(meta.speedLabel.slice(0, 4)) : escapeHtml(meta.speedLabel)) : 'Spd'}</span>
              <input type="range" id="idleSegSpeedSlider_${idx}" min="0" max="255" value="${seg.speed}" class="range-ide" style="flex: 1;" oninput="onIdleSegSliderInput(${idx}, 'speed', this.value)">
              <span id="idleSegSpeedVal_${idx}" style="font-family: var(--font-mono); font-size: 10px; color: var(--text-secondary); min-width: 22px; text-align: right;">${seg.speed}</span>
            </div>
            <div id="idleSegIntensityBox_${idx}" style="display: ${meta.intensity ? 'flex' : 'none'}; align-items: center; gap: 6px;">
              <span id="idleSegIntensityLbl_${idx}" style="font-size: 9px; font-family: var(--font-mono); color: var(--text-muted); text-transform: uppercase;" title="${escapeHtml(meta.intensityLabel || 'Intensity')}">${meta.intensityLabel ? (meta.intensityLabel.length > 5 ? escapeHtml(meta.intensityLabel.slice(0, 4)) : escapeHtml(meta.intensityLabel)) : 'Int'}</span>
              <input type="range" id="idleSegIntensitySlider_${idx}" min="0" max="255" value="${seg.intensity}" class="range-ide" style="flex: 1;" oninput="onIdleSegSliderInput(${idx}, 'intensity', this.value)">
              <span id="idleSegIntensityVal_${idx}" style="font-family: var(--font-mono); font-size: 10px; color: var(--text-secondary); min-width: 22px; text-align: right;">${seg.intensity}</span>
            </div>
          </div>
        `}
      </div>
    `;
  }).join('');
}

function onIdleSegToggle(idx, checked) {
  if (idlePresetState.segments[idx]) {
    idlePresetState.segments[idx].on = checked;
    const card = document.getElementById(`idleSegCard_${idx}`);
    if (card) {
      card.classList.toggle('is-disabled', !checked);
      card.classList.toggle('is-enabled', checked);
    }
    updateIdlePreviewLive();
  }
}

function onIdleSegEffectChange(idx, fxVal) {
  const fxId = parseInt(fxVal, 10);
  if (idlePresetState.segments[idx]) {
    idlePresetState.segments[idx].fx = fxId;
    
    // Update label on searchable dropdown trigger
    const valSpan = document.getElementById(`fxSelectVal_${idx}`);
    if (valSpan) {
      const fxObj = getWledEffects().find(e => e.id === fxId);
      valSpan.textContent = fxObj ? fxObj.name : `Effect ${fxId}`;
    }

    // Dynamically update colors container
    const colorsContainer = document.getElementById(`idleSegColors_${idx}`);
    if (colorsContainer) {
      colorsContainer.innerHTML = renderEffectColorsHtml(idx, fxId);
    }

    // Dynamically update speed & intensity sliders visibility and labels
    const meta = getWledEffectMetadata(fxId);
    const animRow = document.getElementById(`idleSegAnimRow_${idx}`);
    const speedBox = document.getElementById(`idleSegSpeedBox_${idx}`);
    const intensityBox = document.getElementById(`idleSegIntensityBox_${idx}`);
    const speedLbl = document.getElementById(`idleSegSpeedLbl_${idx}`);
    const intensityLbl = document.getElementById(`idleSegIntensityLbl_${idx}`);

    if (animRow) {
      if (!meta.speed && !meta.intensity) {
        animRow.style.display = 'none';
      } else {
        animRow.style.display = 'grid';
        animRow.style.gridTemplateColumns = (meta.speed && meta.intensity) ? '1fr 1fr' : '1fr';
      }
    }

    if (speedBox) {
      speedBox.style.display = meta.speed ? 'flex' : 'none';
    }
    if (speedLbl) {
      const spdLblText = meta.speedLabel ? (meta.speedLabel.length > 5 ? meta.speedLabel.slice(0, 4) : meta.speedLabel) : 'Spd';
      speedLbl.textContent = spdLblText;
      speedLbl.title = meta.speedLabel || 'Speed';
    }

    if (intensityBox) {
      intensityBox.style.display = meta.intensity ? 'flex' : 'none';
    }
    if (intensityLbl) {
      const intLblText = meta.intensityLabel ? (meta.intensityLabel.length > 5 ? meta.intensityLabel.slice(0, 4) : meta.intensityLabel) : 'Int';
      intensityLbl.textContent = intLblText;
      intensityLbl.title = meta.intensityLabel || 'Intensity';
    }

    updateIdlePreviewLive();
  }
}

function onIdleSegColorChange(idx, type, colVal, isImmediate = false) {
  if (idlePresetState.segments[idx]) {
    if (type === 'primary') {
      idlePresetState.segments[idx].colPrimary = colVal;
    } else if (type === 'secondary') {
      idlePresetState.segments[idx].colSecondary = colVal;
    } else if (type === 'tertiary') {
      idlePresetState.segments[idx].colTertiary = colVal;
    }
    if (isImmediate) {
      updateIdlePreviewLive();
    } else {
      updateIdlePreviewLiveDebounced();
    }
  }
}

function onIdleSegSliderInput(idx, field, val) {
  const num = parseInt(val, 10);
  if (!idlePresetState.segments[idx]) return;

  if (field === 'bri') {
    idlePresetState.segments[idx].briPercent = num;
    const txt = document.getElementById(`idleSegBriVal_${idx}`);
    if (txt) txt.textContent = `${num}%`;
  } else if (field === 'speed') {
    idlePresetState.segments[idx].speed = num;
    const txt = document.getElementById(`idleSegSpeedVal_${idx}`);
    if (txt) txt.textContent = String(num);
  } else if (field === 'intensity') {
    idlePresetState.segments[idx].intensity = num;
    const txt = document.getElementById(`idleSegIntensityVal_${idx}`);
    if (txt) txt.textContent = String(num);
  }
  updateIdlePreviewLiveDebounced();
}

function setIdleSegBri(idx, val) {
  if (!idlePresetState.segments[idx]) return;
  idlePresetState.segments[idx].briPercent = val;
  const slider = document.getElementById(`idleSegBriSlider_${idx}`);
  const txt = document.getElementById(`idleSegBriVal_${idx}`);
  if (slider) slider.value = val;
  if (txt) txt.textContent = `${val}%`;
  updateIdlePreviewLive();
}

let _idlePreviewDebounce = null;
function updateIdlePreviewLiveDebounced() {
  if (_idlePreviewDebounce) clearTimeout(_idlePreviewDebounce);
  _idlePreviewDebounce = setTimeout(() => {
    updateIdlePreviewLive();
  }, 40);
}

function buildIdleSegmentsPayload() {
  return idlePresetState.segments.map(seg => {
    const rawBri = Math.round((Math.max(0, Math.min(100, seg.briPercent)) / 100) * 255);
    const cPrimary = hexToRgb(seg.colPrimary || '#00ff9d');
    const cSecondary = hexToRgb(seg.colSecondary || '#000000');
    const cTertiary = hexToRgb(seg.colTertiary || '#000000');

    return {
      id: seg.id,
      start: seg.start,
      stop: seg.stop,
      on: seg.on !== false,
      bri: rawBri,
      col: [
        [cPrimary[0], cPrimary[1], cPrimary[2], 0],
        [cSecondary[0], cSecondary[1], cSecondary[2], 0],
        [cTertiary[0], cTertiary[1], cTertiary[2], 0]
      ],
      fx: seg.isPwm ? 0 : (seg.fx || 0),
      sx: seg.speed ?? 128,
      ix: seg.intensity ?? 128,
      n: seg.name || `Segment ${seg.id}`,
      sel: true
    };
  });
}

async function previewIdlePreset() {
  if (!idlePresetState.ip) return;
  // Auto-release UDP if currently streaming so HTTP state preview can be applied
  if (currentProtocolMode === 'udp') {
    await toggleProtocolMode();
  }
  const segments = buildIdleSegmentsPayload();
  try {
    const res = await fetch('/api/wled/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ip: idlePresetState.ip,
        on: true,
        bri: 255,
        transition: 0,
        seg: segments
      })
    });
    const data = await res.json();
    if (data.status === 'ok') {
      showToast('Live Idle Mode preview sent to WLED.', 'info');
    } else {
      showToast(`Preview error: ${data.message}`, 'error');
    }
  } catch (err) {
    showToast(`Failed to send preview: ${err.message}`, 'error');
  }
}

let _isIdlePreviewSending = false;
let _hasPendingIdlePreview = false;

async function updateIdlePreviewLive() {
  if (!idlePresetState.ip) return;
  if (currentProtocolMode === 'udp') {
    await toggleProtocolMode();
  }

  if (_isIdlePreviewSending) {
    _hasPendingIdlePreview = true;
    return;
  }

  _isIdlePreviewSending = true;
  _hasPendingIdlePreview = false;

  const segments = buildIdleSegmentsPayload();
  try {
    await fetch('/api/wled/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ip: idlePresetState.ip,
        on: true,
        bri: 255,
        transition: 0,
        seg: segments
      })
    });
  } catch (e) {
    console.warn('[AutoGlow] Failed to send idle preview state to WLED:', e);
  } finally {
    _isIdlePreviewSending = false;
    if (_hasPendingIdlePreview) {
      _hasPendingIdlePreview = false;
      updateIdlePreviewLive();
    }
  }
}

async function saveIdlePreset() {
  if (!idlePresetState.ip) {
    showToast('No controller selected.', 'error');
    return;
  }

  const btn = document.getElementById('btnSaveIdlePreset');
  if (btn) btn.disabled = true;

  const segments = buildIdleSegmentsPayload();
  if (!Array.isArray(segments) || segments.length === 0) {
    showToast('No segments available to save.', 'error');
    if (btn) btn.disabled = false;
    return;
  }

  // Pre-flight validation: check bounds
  for (const seg of segments) {
    if (typeof seg.start !== 'number' || typeof seg.stop !== 'number' || seg.stop <= seg.start) {
      showToast(`Invalid bounds for ${seg.n || 'Segment'}: start=${seg.start}, stop=${seg.stop}`, 'error');
      if (btn) btn.disabled = false;
      return;
    }
  }

  // Pre-flight validation: ensure multi-segment controllers don't accidentally save single segment
  const dev = (Array.isArray(appState.devices) ? appState.devices : []).find(d => d.ip === idlePresetState.ip);
  if (dev && Array.isArray(dev.segments) && dev.segments.length > segments.length) {
    showToast(`Configured hardware has ${dev.segments.length} segments, but only ${segments.length} loaded. Aborting save to prevent loss.`, 'error');
    if (btn) btn.disabled = false;
    return;
  }

  try {
    const res = await fetch('/api/wled/preset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ip: idlePresetState.ip,
        preset_id: 1,
        name: 'AutoGlow Default',
        segments: segments,
        bri: 255,
        boot_default: true
      })
    });
    const data = await res.json();
    if (data.status === 'ok') {
      showToast('Idle lighting saved on the controller.', 'success');
    } else {
      showToast(`Save failed: ${data.message}`, 'error');
    }
  } catch (err) {
    showToast(`Error saving preset: ${err.message}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// --- Power & Timers Tab ---
function handleInactivityToggleChange() {
  const toggle = document.getElementById('inactivityTimeoutEnabledToggle');
  const row = document.getElementById('inactivityTimeoutRow');
  const isEnabled = toggle ? toggle.checked : true;
  if (row) {
    row.classList.toggle('disabled', !isEnabled);
  }
}

function handleStandbyToggleChange() {
  const toggle = document.getElementById('idlePowerOffEnabledToggle');
  const row = document.getElementById('standbyTimeoutRow');
  const isEnabled = toggle ? toggle.checked : true;
  if (row) {
    row.classList.toggle('disabled', !isEnabled);
  }
}

function handleMatchEndDisconnectToggleChange() {
  const toggle = document.getElementById('disconnectUdpOnMatchEndToggle');
  const row = document.getElementById('matchEndDisconnectRow');
  const isEnabled = toggle ? toggle.checked : false;
  if (row) {
    row.classList.toggle('disabled', !isEnabled);
  }
}

function handleInactivityTimeoutChange() {
  const inactInp = document.getElementById('inactivityTimeoutMinInput');
  const standbyInp = document.getElementById('idlePowerOffMinInput');
  if (!inactInp || !standbyInp) return;

  let inactVal = parseInt(inactInp.value, 10);
  let standbyVal = parseInt(standbyInp.value, 10);

  if (isNaN(inactVal) || inactVal < 1) inactVal = 1;
  if (isNaN(standbyVal) || standbyVal < 1) standbyVal = 1;

  // Rule: Inactivity Timeout cannot be greater than Standby Timeout
  if (inactVal > standbyVal) {
    standbyInp.value = inactVal;
  }
  standbyInp.min = inactVal;
}

function handleStandbyTimeoutChange() {
  const inactInp = document.getElementById('inactivityTimeoutMinInput');
  const standbyInp = document.getElementById('idlePowerOffMinInput');
  if (!inactInp || !standbyInp) return;

  let inactVal = parseInt(inactInp.value, 10);
  let standbyVal = parseInt(standbyInp.value, 10);

  if (isNaN(inactVal) || inactVal < 1) inactVal = 1;
  if (isNaN(standbyVal) || standbyVal < 1) standbyVal = 1;

  // Rule: Standby Timeout cannot be lower than Inactivity Timeout
  if (standbyVal < inactVal) {
    inactInp.value = standbyVal;
  }
  standbyInp.min = inactInp.value;
}

function renderPowerTab() {
  const inactivityEnabled = appState.inactivity_timeout_enabled ?? true;
  const inactivityMin = appState.inactivity_timeout_minutes ?? 5;
  const idlePowerOffEnabled = appState.idle_power_off_enabled ?? true;
  const idlePowerOffMin = appState.idle_power_off_minutes ?? 30;
  const disconnectUdpOnMatchEnd = appState.disconnect_udp_on_match_end ?? false;

  const inactToggle = document.getElementById('inactivityTimeoutEnabledToggle');
  const inactMinInp = document.getElementById('inactivityTimeoutMinInput');
  const standbyToggle = document.getElementById('idlePowerOffEnabledToggle');
  const standbyMinInp = document.getElementById('idlePowerOffMinInput');
  const matchEndToggle = document.getElementById('disconnectUdpOnMatchEndToggle');

  if (inactToggle) inactToggle.checked = inactivityEnabled;
  if (inactMinInp) inactMinInp.value = inactivityMin;
  if (standbyToggle) standbyToggle.checked = idlePowerOffEnabled;
  if (standbyMinInp) standbyMinInp.value = idlePowerOffMin;
  if (matchEndToggle) matchEndToggle.checked = disconnectUdpOnMatchEnd;

  handleInactivityToggleChange();
  handleStandbyToggleChange();
  handleMatchEndDisconnectToggleChange();
  handleInactivityTimeoutChange();
}

// The timer values as currently entered on the Settings page (validated, not yet saved)
function readPowerDraft() {
  const val = id => document.getElementById(id);
  let inactivityMin = Math.max(1, parseInt(val('inactivityTimeoutMinInput')?.value, 10) || 5);
  let idlePowerOffMin = Math.max(1, parseInt(val('idlePowerOffMinInput')?.value, 10) || 30);
  // Rule: Inactivity cannot exceed Standby
  if (inactivityMin > idlePowerOffMin) idlePowerOffMin = inactivityMin;
  return {
    inactivity_timeout_enabled: val('inactivityTimeoutEnabledToggle') ? val('inactivityTimeoutEnabledToggle').checked : true,
    inactivity_timeout_minutes: inactivityMin,
    idle_power_off_enabled: val('idlePowerOffEnabledToggle') ? val('idlePowerOffEnabledToggle').checked : true,
    idle_power_off_minutes: idlePowerOffMin,
    disconnect_udp_on_match_end: val('disconnectUdpOnMatchEndToggle') ? val('disconnectUdpOnMatchEndToggle').checked : false
  };
}
window.readPowerDraft = readPowerDraft;

async function testInactivityDim() {
  try {
    const res = await fetch('/api/power/test_dim', { method: 'POST' });
    const data = await res.json();
    if (data.status === 'ok') {
      showToast('▶ Inactivity Dim executed: Released UDP & restored Idle Preset 1.', 'warning');
    } else if (data.status === 'warning') {
      showToast(`Dim sent: ${data.message}`, 'warning');
    } else {
      showToast(`Error: ${data.message}`, 'error');
    }
  } catch (err) {
    showToast(`Network error: ${err.message || err}`, 'error');
  }
}

async function testPowerOff() {
  try {
    const res = await fetch('/api/power/test_off', { method: 'POST' });
    const data = await res.json();
    if (data.status === 'ok') {
      showToast('✓ Auto-Off verified on physical hardware (Lights off). Click "↺ Turn On" to restore.', 'info');
    } else if (data.status === 'warning') {
      showToast(`Auto-Off sent: ${data.message}`, 'warning');
    } else {
      showToast(`Error: ${data.message}`, 'error');
    }
  } catch (err) {
    showToast(`Network error: ${err.message || err}`, 'error');
  }
}

async function testWakeBoard() {
  try {
    const res = await fetch('/api/power/test_wake', { method: 'POST' });
    const data = await res.json();
    if (data.status === 'ok') {
      showToast('✓ Power restored & verified on hardware (Lights active).', 'success');
    } else if (data.status === 'warning') {
      showToast(`Turn On sent: ${data.message}`, 'warning');
    } else {
      showToast(`Error: ${data.message}`, 'error');
    }
  } catch (err) {
    showToast(`Network error: ${err.message || err}`, 'error');
  }
}

if (typeof window !== "undefined") {
  window.loadIdlePresetForSelectedDevice = loadIdlePresetForSelectedDevice;
  window.renderIdleSegmentsList = renderIdleSegmentsList;
  window.saveIdlePreset = saveIdlePreset;
  window.previewIdlePreset = previewIdlePreset;
  window.renderPowerTab = renderPowerTab;
  window.savePowerConfig = savePowerConfig;
  window.handleInactivityToggleChange = handleInactivityToggleChange;
  window.handleStandbyToggleChange = handleStandbyToggleChange;
  window.handleMatchEndDisconnectToggleChange = handleMatchEndDisconnectToggleChange;
  window.handleInactivityTimeoutChange = handleInactivityTimeoutChange;
  window.handleStandbyTimeoutChange = handleStandbyTimeoutChange;
  window.testInactivityDim = testInactivityDim;
  window.testPowerOff = testPowerOff;
  window.testWakeBoard = testWakeBoard;
  window.resetIdleLighting = resetIdleLighting;
  window.toggleEffectSearchDropdown = toggleEffectSearchDropdown;
  window.filterEffectList = filterEffectList;
  window.selectEffectFromSearch = selectEffectFromSearch;
  window.getWledEffectMetadata = getWledEffectMetadata;
  window.renderEffectColorsHtml = renderEffectColorsHtml;
  window.onIdleSegColorChange = onIdleSegColorChange;
  window.onIdleSegEffectChange = onIdleSegEffectChange;
  window.onIdleSegSliderInput = onIdleSegSliderInput;
  window.onIdleSegToggle = onIdleSegToggle;
  window.setIdleSegBri = setIdleSegBri;
}


