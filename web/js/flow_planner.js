/**
 * AutoGlow 2 - Game Flow Planner & Visual State Machine
 * Simple, clean game flow simulator:
 * IDLE -> Game Start -> [Turn Player 1 <-> Turn Player 2 (Loop)] -> Leg Won
 */

(function () {
  'use strict';

  var currentFlow = null;
  var savedFlowJson = null;
  var selectedPhaseId = null;
  var activeTransitionKey = null;
  var isPlayingFlow = false;
  var flowPlayIndex = 0;
  var flowPlayTimer = null;
  var flowSpeedMultiplier = 1.0;
  var lastTurnPlayerId = 'turn_p1';
  var selectedFlowDeviceIp = (typeof localStorage !== 'undefined' ? localStorage.getItem('autoglow_selected_flow_device') : null) || 'all';
  var selectedFlowSegmentId = (typeof localStorage !== 'undefined' ? localStorage.getItem('autoglow_selected_flow_seg') : null);
  if (selectedFlowSegmentId !== null && selectedFlowSegmentId !== undefined && selectedFlowSegmentId !== '') {
    selectedFlowSegmentId = parseInt(selectedFlowSegmentId, 10);
  } else {
    selectedFlowSegmentId = 0;
  }

  var wledEffectsCatalog = [
    { id: 0, name: 'Solid' },
    { id: 1, name: 'Blink' },
    { id: 2, name: 'Breathe' },
    { id: 3, name: 'Wipe' },
    { id: 4, name: 'Wipe Random' },
    { id: 5, name: 'Random Colors' },
    { id: 6, name: 'Sweep' },
    { id: 7, name: 'Dynamic' },
    { id: 8, name: 'Colorloop' },
    { id: 9, name: 'Rainbow' },
    { id: 10, name: 'Scan' },
    { id: 11, name: 'Dual Scan' },
    { id: 12, name: 'Fade' },
    { id: 13, name: 'Chase' },
    { id: 14, name: 'Running' },
    { id: 15, name: 'Fire Flicker' },
    { id: 16, name: 'Aurora' },
    { id: 17, name: 'Sinelon' },
    { id: 18, name: 'Palette' },
    { id: 19, name: 'Popcorn' }
  ];

  var standardUdpAnimations = [
    { id: 'solid', name: 'Solid Color' },
    { id: 'chase', name: 'Chase' },
    { id: 'rainbow', name: 'Rainbow' },
    { id: 'pulse', name: 'Pulse' },
    { id: 'flash', name: 'Flash' },
    { id: 'wipe', name: 'Wipe' },
    { id: 'breathe', name: 'Breathe' },
    { id: 'scan', name: 'Scan (Cylon)' },
    { id: 'comet', name: 'Comet' }
  ];

  var DEFAULT_IN_TURN_EVENTS = {
    'single': {
      id: 'single',
      name: 'Single Hit (1x)',
      trigger_key: 'single',
      effect: { animation: 'solid', color_primary: [0, 200, 255], color_secondary: [0, 0, 0], duration: 0.8, speed: 1.0, reverse: false }
    },
    'double': {
      id: 'double',
      name: 'Double Hit (2x)',
      trigger_key: 'double',
      effect: { animation: 'pulse', color_primary: [0, 255, 180], color_secondary: [0, 40, 20], duration: 1.2, speed: 1.4, reverse: false }
    },
    'triple': {
      id: 'triple',
      name: 'Triple Hit (3x)',
      trigger_key: 'triple',
      effect: { animation: 'flash', color_primary: [255, 120, 0], color_secondary: [50, 20, 0], duration: 1.8, speed: 1.6, reverse: false }
    },
    '180': {
      id: '180',
      name: '180 (Maximum!)',
      trigger_key: '180',
      effect: { animation: 'rainbow', color_primary: [255, 200, 0], color_secondary: [0, 0, 0], duration: 3.2, speed: 2.0, reverse: false }
    },
    'bullseye': {
      id: 'bullseye',
      name: 'Bullseye (Bull)',
      trigger_key: 'bullseye',
      effect: { animation: 'comet', color_primary: [255, 20, 40], color_secondary: [0, 0, 0], duration: 2.2, speed: 1.8, reverse: false }
    },
    'bust': {
      id: 'bust',
      name: 'Bust / Miss (Bust)',
      trigger_key: 'bust',
      effect: { animation: 'solid', color_primary: [110, 118, 129], color_secondary: [0, 0, 0], duration: 1.0, speed: 1.0, reverse: false }
    },
    'calibrating': {
      id: 'calibrating',
      name: 'Board Calibration (Calib)',
      trigger_key: 'calibrating',
      effect: { animation: 'scan', color_primary: [168, 85, 247], color_secondary: [80, 20, 140], duration: 2.5, speed: 1.2, reverse: false }
    }
  };

  function isEventChip(key) {
    return !!(DEFAULT_IN_TURN_EVENTS[key] || key === 'calibration');
  }

  function mapWledEffectToSimAnimation(wledFxName) {
    var name = (wledFxName || '').toLowerCase();
    if (name.indexOf('breathe') !== -1 || name.indexOf('fade') !== -1) return 'breathe';
    if (name.indexOf('rainbow') !== -1 || name.indexOf('colorloop') !== -1) return 'rainbow';
    if (name.indexOf('chase') !== -1 || name.indexOf('running') !== -1) return 'chase';
    if (name.indexOf('scan') !== -1 || name.indexOf('cylon') !== -1 || name.indexOf('sinelon') !== -1) return 'scan';
    if (name.indexOf('wipe') !== -1 || name.indexOf('sweep') !== -1) return 'wipe';
    if (name.indexOf('pulse') !== -1 || name.indexOf('blink') !== -1) return 'pulse';
    if (name.indexOf('sparkle') !== -1 || name.indexOf('popcorn') !== -1 || name.indexOf('fire') !== -1 || name.indexOf('flash') !== -1) return 'flash';
    if (name.indexOf('comet') !== -1 || name.indexOf('aurora') !== -1) return 'comet';
    return 'solid';
  }
  window.mapWledEffectToSimAnimation = mapWledEffectToSimAnimation;

  function fetchWledEffectsCatalog() {
    fetch('/api/wled/effects')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && Array.isArray(data.effects) && data.effects.length > 0) {
          wledEffectsCatalog = data.effects;
          if (selectedPhaseId === 'idle') {
            var p = getPhaseById('idle');
            if (p) syncPhaseToStudio(p);
          }
        }
      })
      .catch(function (err) {
        console.debug('Using fallback WLED effects catalog:', err);
      });
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(function (x) {
      var hex = Math.max(0, Math.min(255, Math.round(x || 0))).toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    }).join('');
  }

  function hexToRgb(hex) {
    var clean = (hex || '').replace('#', '');
    if (clean.length === 3) {
      clean = clean.split('').map(function (c) { return c + c; }).join('');
    }
    var num = parseInt(clean, 16) || 0;
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  window.initFlowPlanner = function () {
    fetchWledEffectsCatalog();
    renderFlowHardwareToolbar();
    loadCurrentFlow();
    hookStudioSync();
  };

  function renderFlowHardwareToolbar() {
    var devSelect = document.getElementById('flowDeviceSelect');
    var segStrip = document.getElementById('flowSegmentStrip');
    var segTabsList = document.getElementById('flowSegmentTabsList');
    var infoBadge = document.getElementById('flowSegmentInfoBadge');
    var badgeText = document.getElementById('flowSegmentBadgeText');
    if (!devSelect) return;

    var devicesList = (typeof appState !== 'undefined' && Array.isArray(appState.devices)) ? appState.devices : [];

    // Build device options
    var optionsHtml = '<option value="all">All Devices (Broadcast)</option>';
    devicesList.forEach(function (dev) {
      if (!dev || !dev.ip) return;
      var isSelected = (selectedFlowDeviceIp === dev.ip);
      optionsHtml += '<option value="' + escapeHtml(dev.ip) + '"' + (isSelected ? ' selected' : '') + '>' +
        escapeHtml(dev.name || 'WLED Device') + ' (' + escapeHtml(dev.ip) + ')' +
      '</option>';
    });
    devSelect.innerHTML = optionsHtml;
    devSelect.value = selectedFlowDeviceIp;

    if (selectedFlowDeviceIp && selectedFlowDeviceIp !== 'all') {
      var segments = (typeof getDeviceSegments === 'function' ? getDeviceSegments(selectedFlowDeviceIp) : []);
      // STRICT PWM EXCLUSION: Filter out PWM/White segments
      var wsSegments = segments.filter(function (s) {
        var type = String(s.type || '').toLowerCase();
        var name = String(s.name || '').toLowerCase();
        return !type.includes('pwm') && !type.includes('white') && !name.includes('pwm');
      });

      if (wsSegments.length > 0) {
        // Ensure selected segment is valid
        var activeSeg = wsSegments.find(function (s) { return s.id === selectedFlowSegmentId; });
        if (!activeSeg) {
          selectedFlowSegmentId = wsSegments[0].id;
          activeSeg = wsSegments[0];
        }

        if (segStrip) segStrip.style.display = 'flex';
        if (segTabsList) {
          segTabsList.innerHTML = wsSegments.map(function (seg) {
            var isPillActive = (seg.id === selectedFlowSegmentId);
            return '<button type="button" class="flow-seg-pill' + (isPillActive ? ' active' : '') + '" onclick="selectFlowSegment(' + seg.id + ')" title="' + escapeHtml(seg.gpio || '') + '">' +
              '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>' +
              '<span>' + escapeHtml(seg.name || ('Seg #' + seg.id)) + '</span>' +
              '<span style="font-family: var(--font-mono); font-size: 10px; opacity: 0.75;">(' + seg.len + ' LEDs)</span>' +
            '</button>';
          }).join('');
        }

        if (infoBadge && badgeText) {
          infoBadge.style.display = 'inline-flex';
          badgeText.textContent = activeSeg.len + ' LEDs (WS281x)';
        }

        // Dynamically scale simulator LED ring
        if (typeof window.setSimulatorSegmentLedCount === 'function' && activeSeg) {
          window.setSimulatorSegmentLedCount(activeSeg.len);
        }
      } else {
        if (segStrip) segStrip.style.display = 'none';
        if (segTabsList) segTabsList.innerHTML = '';
        if (infoBadge && badgeText) {
          infoBadge.style.display = 'inline-flex';
          badgeText.textContent = 'WS281x Strip';
        }
      }
    } else {
      if (segStrip) segStrip.style.display = 'none';
      if (segTabsList) segTabsList.innerHTML = '';
      if (infoBadge && badgeText) {
        infoBadge.style.display = 'inline-flex';
        badgeText.textContent = 'Broadcast (All WS281x)';
      }
    }
  }
  window.renderFlowHardwareToolbar = renderFlowHardwareToolbar;

  window.onFlowDeviceSelected = function (ip) {
    if (isFlowDirty()) {
      confirmFlowLeave().then(function (ok) {
        if (ok) window.onFlowDeviceSelected(ip);
        else renderFlowHardwareToolbar();
      });
      return;
    }
    selectedFlowDeviceIp = ip;
    try {
      localStorage.setItem('autoglow_selected_flow_device', ip);
    } catch (e) {}

    // Auto-select first WS281x segment of this device
    if (ip && ip !== 'all') {
      var segments = (typeof getDeviceSegments === 'function' ? getDeviceSegments(ip) : []);
      var wsSegments = segments.filter(function (s) {
        var type = String(s.type || '').toLowerCase();
        var name = String(s.name || '').toLowerCase();
        return !type.includes('pwm') && !type.includes('white') && !name.includes('pwm');
      });
      if (wsSegments.length > 0) {
        selectedFlowSegmentId = wsSegments[0].id;
        try {
          localStorage.setItem('autoglow_selected_flow_seg', String(selectedFlowSegmentId));
        } catch (e) {}
      }
    }
    renderFlowHardwareToolbar();
    loadCurrentFlow();
  };

  window.selectFlowSegment = function (segId) {
    if (isFlowDirty()) {
      confirmFlowLeave().then(function (ok) {
        if (ok) window.selectFlowSegment(segId);
        else renderFlowHardwareToolbar();
      });
      return;
    }
    selectedFlowSegmentId = parseInt(segId, 10);
    try {
      localStorage.setItem('autoglow_selected_flow_seg', String(selectedFlowSegmentId));
    } catch (e) {}
    renderFlowHardwareToolbar();
    loadCurrentFlow();
  };

  // Unsaved changes = the flow differs from what was last loaded or saved
  function isFlowDirty() {
    return !!currentFlow && savedFlowJson !== null && JSON.stringify(currentFlow) !== savedFlowJson;
  }

  function updateFlowSaveState() {
    var dirty = isFlowDirty();
    document.querySelectorAll('.btn-save-flow, #btnSaveFlow').forEach(function (btn) {
      if (btn.textContent === 'Saving...' || btn.textContent === 'Saved!') return;
      btn.textContent = dirty ? 'Save Flow *' : 'Save Flow';
      btn.disabled = !dirty;
    });
  }

  function markFlowSaved() {
    savedFlowJson = JSON.stringify(currentFlow);
    updateFlowSaveState();
  }

  function confirmFlowLeave() {
    return window.lightingGuard.confirmLeave({
      what: 'flow',
      save: window.saveGameFlow,
      discard: loadCurrentFlow
    });
  }

  window.flowPage = { isDirty: isFlowDirty, save: function () { return window.saveGameFlow(); }, discard: function () { loadCurrentFlow(); } };

  function loadCurrentFlow() {
    var url = '/api/flow/current';
    if (selectedFlowDeviceIp && selectedFlowDeviceIp !== 'all') {
      url += '?ip=' + encodeURIComponent(selectedFlowDeviceIp) + '&seg=' + encodeURIComponent(selectedFlowSegmentId !== null ? selectedFlowSegmentId : 0);
    }
    fetch(url)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.flow) {
          currentFlow = data.flow;
          if (!currentFlow.idle_sleep) {
            currentFlow.idle_sleep = {
              inactivity_minutes: 5,
              inactivity_enabled: true,
              dim_percent: 20,
              dim_brightness_raw: 50,
              standby_minutes: 30,
              standby_enabled: true
            };
          }
          renderFlowPipeline();
          if (currentFlow.phases && currentFlow.phases.length > 0) {
            selectPhase(currentFlow.phases[0].id, false);
          }
          markFlowSaved();
        }
      })
      .catch(function (err) {
        console.error('Error loading flow:', err);
      });
  }

  function createPhaseCardElement(phase) {
    var isSelected = (phase.id === selectedPhaseId);
    var isIdle = (phase.id === 'idle');
    var isTakeout = (phase.id === 'takeout');
    var isLeg = (phase.id === 'leg_won');
    var isMatch = (phase.id === 'match_won');

    var card = document.createElement('div');
    card.className = 'flow-phase-card' +
      (isIdle ? ' phase-card-http' : '') +
      (isTakeout ? ' phase-card-takeout' : '') +
      (isLeg ? ' phase-card-leg' : '') +
      (isMatch ? ' phase-card-match' : '') +
      (isSelected ? ' selected' : '');
    card.id = 'flowCard_' + phase.id;
    card.setAttribute('data-phase-id', phase.id);

    var eff = phase.effect || {};
    var col1 = eff.color_primary || [0, 240, 255];
    var hex1 = rgbToHex(col1[0], col1[1], col1[2]);
    var animName = (eff.animation || 'solid').toUpperCase();
    if (isIdle) {
      var fxName = eff.wled_effect_name || 'Breathe';
      animName = fxName.toUpperCase();
    }
    var durStr = isIdle ? 'Native' : ((eff.duration === 0) ? 'Cont' : (eff.duration || 2.0).toFixed(1) + 's');

    var headerHtml = '<div class="phase-card-header">' +
        '<span class="phase-card-name">' + escapeHtml(phase.name) + '</span>' +
      '</div>';

    card.innerHTML =
      headerHtml +
      '<div class="phase-effect-summary">' +
        '<div class="phase-color-chip" style="background: ' + hex1 + ';"></div>' +
        '<span>' + escapeHtml(animName) + '</span>' +
        '<span style="color: var(--text-muted); font-size: 8.5px; margin-left: 2px;">• ' + durStr + '</span>' +
      '</div>';

    card.addEventListener('click', (function (pId) {
      return function () { selectPhase(pId, true); };
    })(phase.id));

    return card;
  }

  function createSleepBranchElement() {
    var branch = document.createElement('div');
    branch.className = 'flow-sleep-branch';
    branch.id = 'flowSleepBranch';

    var idleSleep = (currentFlow && currentFlow.idle_sleep) || {
      inactivity_minutes: 5,
      inactivity_enabled: true,
      dim_percent: 20,
      dim_brightness_raw: 50,
      standby_minutes: 30,
      standby_enabled: true
    };

    var inactMin = idleSleep.inactivity_minutes || 5;
    var standbyMin = idleSleep.standby_minutes || 30;
    var dimPct = (idleSleep.dim_percent !== undefined) ? idleSleep.dim_percent : (Math.round((idleSleep.dim_brightness_raw || 50) / 255 * 100) || 20);

    // 1. Inactivity Connector: Inactivity Timeout (Static informational wire label)
    var conn1 = document.createElement('div');
    conn1.className = 'flow-v-conn';
    conn1.innerHTML =
      '<div class="flow-v-line"></div>' +
      '<span class="flow-v-tag" title="Inactivity Timeout (' + inactMin + 'm) configured in Power & Idle Mode">' + inactMin + 'm Inactivity Timeout &darr;</span>';
    branch.appendChild(conn1);

    // 2. Slim Card: Timeout (Direct dimming preview command)
    var cardTimeout = document.createElement('div');
    cardTimeout.className = 'flow-slim-card is-timeout';
    cardTimeout.id = 'flowCard_idle_timeout';
    cardTimeout.setAttribute('data-phase-id', 'idle_timeout');
    cardTimeout.title = 'Timeout: Dims illumination & restores Idle Preset 1 after ' + inactMin + 'm of inactivity (Click to test dimming)';
    cardTimeout.innerHTML =
      '<span class="flow-slim-title">Timeout</span>';
    cardTimeout.addEventListener('click', function (e) {
      e.stopPropagation();
      playSleepEffect('idle_timeout');
    });
    branch.appendChild(cardTimeout);

    // 3. Standby Connector: Auto-Off Timeout (Static informational wire label)
    var conn2 = document.createElement('div');
    conn2.className = 'flow-v-conn';
    conn2.innerHTML =
      '<div class="flow-v-line"></div>' +
      '<span class="flow-v-tag" title="Auto-Off Timeout (' + standbyMin + 'm) configured in Power & Idle Mode">' + standbyMin + 'm Auto-Off Timeout &darr;</span>';
    branch.appendChild(conn2);

    // 4. Slim Card: Auto Off (Direct power-off command, not a configurable menu)
    var cardOff = document.createElement('div');
    cardOff.className = 'flow-slim-card is-off';
    cardOff.id = 'flowCard_idle_off';
    cardOff.setAttribute('data-phase-id', 'idle_off');
    cardOff.title = 'Auto Off: Direct command to power off all ESP32 LEDs after ' + standbyMin + 'm (Click to send power-off command)';
    cardOff.innerHTML =
      '<span class="flow-slim-title">Auto Off</span>';
    cardOff.addEventListener('click', function (e) {
      e.stopPropagation();
      playSleepEffect('idle_off');
    });
    branch.appendChild(cardOff);

    return branch;
  }

  function createConnectorElement(fromPhase, toPhase) {
    var connKey = fromPhase.id + '->' + toPhase.id;
    var trans = (currentFlow.transitions && currentFlow.transitions[connKey]) || { style: 'crossfade', duration: 0.6 };

    var connDiv = document.createElement('div');
    connDiv.className = 'flow-connector';

    var label = trans.style.charAt(0).toUpperCase() + trans.style.slice(1);
    var isConnSelected = (connKey === activeTransitionKey);
    var isBridge = (fromPhase.id === 'idle');

    connDiv.innerHTML =
      '<div class="flow-connector-line' + (isBridge ? ' is-bridge-line' : '') + '"></div>' +
      '<button class="flow-connector-btn' + (isConnSelected ? ' selected' : '') + (isBridge ? ' is-bridge-btn' : '') + '" data-trans-key="' + connKey + '" onclick="selectTransition(event, \'' + fromPhase.id + '\', \'' + toPhase.id + '\')" title="Edit transition from ' + escapeHtml(fromPhase.name) + (isBridge ? ' (HTTP)' : '') + ' to ' + escapeHtml(toPhase.name) + ' (UDP)">' +
        '<span>' + label + '</span>' +
      '</button>';

    return connDiv;
  }

  // Dual-Lane Bi-Directional Connector between cards:
  // Upper Lane: phaseA -> phaseB (Forward Eastbound)
  // Lower Lane: phaseB -> phaseA (Return Westbound)
  function createDualLaneConnectorElement(phaseA, phaseB) {
    var fwdKey = phaseA.id + '->' + phaseB.id;
    var fwdTrans = (currentFlow.transitions && currentFlow.transitions[fwdKey]) || { style: 'wipe', duration: 0.6 };
    var fwdLabel = (fwdTrans.style || 'wipe').charAt(0).toUpperCase() + (fwdTrans.style || 'wipe').slice(1);
    var isFwdSelected = (fwdKey === activeTransitionKey);

    var retKey = phaseB.id + '->' + phaseA.id;
    var retTrans = (currentFlow.transitions && currentFlow.transitions[retKey]) || { style: 'wipe', duration: 0.6 };
    var retLabel = (retTrans.style || 'wipe').charAt(0).toUpperCase() + (retTrans.style || 'wipe').slice(1);
    var isRetSelected = (retKey === activeTransitionKey);

    var dualDiv = document.createElement('div');
    dualDiv.className = 'flow-dual-connector';

    var fwdMarkerId = 'arrowR_' + phaseA.id + '_' + phaseB.id;
    var retMarkerId = 'arrowL_' + phaseB.id + '_' + phaseA.id;

    dualDiv.innerHTML =
      '<div class="flow-dual-lane">' +
        '<svg class="flow-dual-lane-svg" viewBox="0 0 70 22">' +
          '<defs>' +
            '<marker id="' + fwdMarkerId + '" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="6" markerHeight="6" orient="auto">' +
              '<polygon points="0,0 6,3 0,6" fill="' + (isFwdSelected ? '#58a6ff' : '#8b949e') + '"/>' +
            '</marker>' +
          '</defs>' +
          '<line class="flow-dual-lane-line' + (isFwdSelected ? ' selected' : '') + '" id="line_' + fwdKey + '" x1="0" y1="11" x2="66" y2="11" marker-end="url(#' + fwdMarkerId + ')"/>' +
        '</svg>' +
        '<button class="flow-dual-lane-btn' + (isFwdSelected ? ' selected' : '') + '" data-trans-key="' + fwdKey + '" onclick="selectTransition(event, \'' + phaseA.id + '\', \'' + phaseB.id + '\')" title="Edit transition: ' + escapeHtml(phaseA.name) + ' ➔ ' + escapeHtml(phaseB.name) + '">' +
          fwdLabel +
        '</button>' +
      '</div>' +
      '<div class="flow-dual-lane">' +
        '<svg class="flow-dual-lane-svg" viewBox="0 0 70 22">' +
          '<defs>' +
            '<marker id="' + retMarkerId + '" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="6" markerHeight="6" orient="auto">' +
              '<polygon points="0,0 6,3 0,6" fill="' + (isRetSelected ? '#58a6ff' : '#8b949e') + '"/>' +
            '</marker>' +
          '</defs>' +
          '<line class="flow-dual-lane-line' + (isRetSelected ? ' selected' : '') + '" id="line_' + retKey + '" x1="70" y1="11" x2="4" y2="11" marker-end="url(#' + retMarkerId + ')"/>' +
        '</svg>' +
        '<button class="flow-dual-lane-btn' + (isRetSelected ? ' selected' : '') + '" data-trans-key="' + retKey + '" onclick="selectTransition(event, \'' + phaseB.id + '\', \'' + phaseA.id + '\')" title="Edit return transition: ' + escapeHtml(phaseB.name) + ' ➔ ' + escapeHtml(phaseA.name) + '">' +
          retLabel +
        '</button>' +
      '</div>';

    return dualDiv;
  }



  // --- Render 7-Phase Pipeline with Player Turn Loop & Victory Fork ---
  function renderFlowPipeline() {
    var track = document.getElementById('flowPipelineTrack');
    if (!track || !currentFlow) return;

    track.innerHTML = '';
    var phases = currentFlow.phases || [];

    // Check if flow has standard turn loop (turn_p1 -> takeout -> turn_p2 or turn_p1 -> turn_p2)
    var p1 = null;
    var p2 = null;
    var pTakeout = null;
    var p1Idx = -1;
    var p2Idx = -1;
    var takeoutIdx = -1;
    for (var i = 0; i < phases.length; i++) {
      if (phases[i].id === 'turn_p1') { p1 = phases[i]; p1Idx = i; }
      if (phases[i].id === 'takeout') { pTakeout = phases[i]; takeoutIdx = i; }
      if (phases[i].id === 'turn_p2') { p2 = phases[i]; p2Idx = i; }
    }
    var hasLoop = (p1 && p2);

    // Check for Victory Fork (leg_won & match_won)
    var pLeg = null;
    var pMatch = null;
    for (var v = 0; v < phases.length; v++) {
      if (phases[v].id === 'leg_won') pLeg = phases[v];
      if (phases[v].id === 'match_won') pMatch = phases[v];
    }
    var hasFork = hasLoop && (pLeg !== null);

    for (var idx = 0; idx < phases.length; idx++) {
      var phase = phases[idx];

      if (hasLoop && idx === p1Idx) {
        // Render Turn Loop Container
        var loopGroup = document.createElement('div');
        loopGroup.className = 'flow-loop-group';
        loopGroup.id = 'flowLoopGroup';

        // Loop Header with In-Turn Throw Simulation Chips
        var loopHeader = document.createElement('div');
        loopHeader.className = 'flow-loop-header';
        loopHeader.innerHTML =
          '<div class="flow-loop-events">' +
            '<button class="flow-event-chip' + (selectedPhaseId === 'single' ? ' selected' : '') + '" data-event-key="single" onclick="selectEventChip(event, \'single\')" title="Single Hit (1x) - Click to configure in Studio">1x</button>' +
            '<button class="flow-event-chip' + (selectedPhaseId === 'double' ? ' selected' : '') + '" data-event-key="double" onclick="selectEventChip(event, \'double\')" title="Double Hit (2x) - Click to configure in Studio">2x</button>' +
            '<button class="flow-event-chip' + (selectedPhaseId === 'triple' ? ' selected' : '') + '" data-event-key="triple" onclick="selectEventChip(event, \'triple\')" title="Triple Hit (3x) - Click to configure in Studio">3x</button>' +
            '<button class="flow-event-chip chip-gold' + (selectedPhaseId === '180' ? ' selected' : '') + '" data-event-key="180" onclick="selectEventChip(event, \'180\')" title="180 (Maximum!) - Click to configure in Studio">180</button>' +
            '<button class="flow-event-chip chip-red' + (selectedPhaseId === 'bullseye' ? ' selected' : '') + '" data-event-key="bullseye" onclick="selectEventChip(event, \'bullseye\')" title="Bullseye (Bull) - Click to configure in Studio">Bull</button>' +
            '<button class="flow-event-chip chip-muted' + (selectedPhaseId === 'bust' ? ' selected' : '') + '" data-event-key="bust" onclick="selectEventChip(event, \'bust\')" title="Bust / Miss (Bust) - Click to configure in Studio">Bust</button>' +
            '<button class="flow-event-chip chip-calib' + (selectedPhaseId === 'calibrating' || selectedPhaseId === 'calibration' ? ' selected' : '') + '" data-event-key="calibrating" onclick="selectEventChip(event, \'calibrating\')" title="Board Calibration (Calib) - Click to configure in Studio">Calib</button>' +
          '</div>';
        loopGroup.appendChild(loopHeader);

        // Loop Cards Row: Turn P1 <=> Takeout <=> Turn P2 (Dual-Lane Highways)
        var loopCards = document.createElement('div');
        loopCards.className = 'flow-loop-cards';

        var cardP1 = createPhaseCardElement(p1);
        loopCards.appendChild(cardP1);

        if (pTakeout) {
          // Dual-lane 1: P1 <=> Takeout (Top: P1->Takeout, Bottom: Takeout->P1)
          var dualConn1 = createDualLaneConnectorElement(p1, pTakeout);
          loopCards.appendChild(dualConn1);

          // Central Takeout Card
          var cardTakeout = createPhaseCardElement(pTakeout);
          cardTakeout.classList.add('phase-card-takeout');
          loopCards.appendChild(cardTakeout);

          // Dual-lane 2: Takeout <=> Turn P2 (Top: Takeout->P2, Bottom: P2->Takeout)
          var dualConn2 = createDualLaneConnectorElement(pTakeout, p2);
          loopCards.appendChild(dualConn2);
        } else {
          var fwdConn = createConnectorElement(p1, p2);
          loopCards.appendChild(fwdConn);
        }

        var cardP2 = createPhaseCardElement(p2);
        loopCards.appendChild(cardP2);

        loopGroup.appendChild(loopCards);

        // Only render fallback under-card return loop if Takeout is NOT present
        if (!pTakeout) {
          var returnDiv = document.createElement('div');
          returnDiv.className = 'flow-loop-return';

          var returnKey = 'turn_p2->turn_p1';
          var returnTrans = (currentFlow.transitions && currentFlow.transitions[returnKey]) || { style: 'crossfade', duration: 0.6 };
          var returnLabel = returnTrans.style.charAt(0).toUpperCase() + returnTrans.style.slice(1);
          var isReturnSelected = (returnKey === activeTransitionKey);

          var returnDurStr = (returnTrans.duration || 0.6).toFixed(1) + 's';
          returnDiv.innerHTML =
            '<svg class="flow-loop-return-svg" viewBox="0 0 340 30" preserveAspectRatio="none">' +
              '<defs>' +
                '<marker id="squareLoopArrow" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="6" markerHeight="6" orient="auto">' +
                  '<polygon points="0,0 6,3 0,6" fill="#8b949e"/>' +
                '</marker>' +
              '</defs>' +
              '<path d="M 268 0 V 16 Q 268 22 260 22 H 80 Q 72 22 72 16 V 2" fill="none" stroke="#484f58" stroke-width="1.3" marker-end="url(#squareLoopArrow)"/>' +
            '</svg>' +
            '<button class="flow-loop-return-btn' + (isReturnSelected ? ' selected' : '') + '" id="flowLoopReturnBtn" data-trans-key="' + returnKey + '" onclick="selectTransition(event, \'turn_p2\', \'turn_p1\')" title="Edit return transition from Turn Player 2 to Turn Player 1">' +
              returnLabel + ' • ' + returnDurStr +
            '</button>';

          loopGroup.appendChild(returnDiv);
        }

        track.appendChild(loopGroup);

        // Advance idx to end of loop group
        idx = Math.max(p2Idx, (takeoutIdx !== -1 ? takeoutIdx : p2Idx));

        if (hasFork) {
          // Fork Container (Y-Split into Match Won [Row 1] & Leg Won [Row 2])
          var forkContainer = document.createElement('div');
          forkContainer.className = 'flow-fork-container';
          forkContainer.id = 'flowForkContainer';

          // Fork Junction SVG (wire enters at Y=68, splits smoothly to exact row centers Y=30 and Y=106)
          var forkJunc = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          forkJunc.setAttribute('class', 'flow-fork-junction');
          forkJunc.setAttribute('viewBox', '0 0 40 136');
          forkJunc.innerHTML =
            '<path id="flowWireMatch" class="flow-fork-wire' + ('turn_p2->match_won' === activeTransitionKey ? ' selected' : '') + '" d="M 0 68 H 10 Q 22 68 22 52 V 42 Q 22 30 32 30 H 40" fill="none" stroke="#484f58" stroke-width="1.3"/>' +
            '<path id="flowWireLeg" class="flow-fork-wire' + ('turn_p2->leg_won' === activeTransitionKey ? ' selected' : '') + '" d="M 0 68 H 10 Q 22 68 22 84 V 94 Q 22 106 32 106 H 40" fill="none" stroke="#484f58" stroke-width="1.3"/>';
          forkContainer.appendChild(forkJunc);

          var branchesCol = document.createElement('div');
          branchesCol.className = 'flow-fork-branches-col';

          // --- Branch A: Match Won (Upper Row) ---
          if (pMatch) {
            var branchMatch = document.createElement('div');
            branchMatch.className = 'flow-branch-row';

            var matchConnKey = 'turn_p2->match_won';
            var matchTrans = (currentFlow.transitions && currentFlow.transitions[matchConnKey]) || { style: 'flash', duration: 0.6 };
            var matchLabel = matchTrans.style.charAt(0).toUpperCase() + matchTrans.style.slice(1);
            var isMatchConnSelected = (matchConnKey === activeTransitionKey);

            var connMatch = document.createElement('div');
            connMatch.className = 'flow-connector';
            connMatch.style.width = '56px';
            connMatch.innerHTML =
              '<div class="flow-connector-line"></div>' +
              '<button class="flow-connector-btn' + (isMatchConnSelected ? ' selected' : '') + '" data-trans-key="' + matchConnKey + '" onclick="selectTransition(event, \'turn_p2\', \'match_won\')" title="Edit transition from Turn Player 2 to Match Won">' +
                '<span>' + matchLabel + '</span>' +
              '</button>';
            branchMatch.appendChild(connMatch);

            var cardMatch = createPhaseCardElement(pMatch);
            cardMatch.classList.add('phase-card-match');
            branchMatch.appendChild(cardMatch);

            branchesCol.appendChild(branchMatch);
          }

          // --- Branch B: Leg Won (Lower Row) ---
          var branchLeg = document.createElement('div');
          branchLeg.className = 'flow-branch-row';

          var legConnKey = 'turn_p2->leg_won';
          var legTrans = (currentFlow.transitions && currentFlow.transitions[legConnKey]) || { style: 'flash', duration: 0.5 };
          var legLabel = legTrans.style.charAt(0).toUpperCase() + legTrans.style.slice(1);
          var isLegConnSelected = (legConnKey === activeTransitionKey);

          var connLeg = document.createElement('div');
          connLeg.className = 'flow-connector';
          connLeg.style.width = '56px';
          connLeg.innerHTML =
            '<div class="flow-connector-line"></div>' +
            '<button class="flow-connector-btn' + (isLegConnSelected ? ' selected' : '') + '" data-trans-key="' + legConnKey + '" onclick="selectTransition(event, \'turn_p2\', \'leg_won\')" title="Edit transition from Turn Player 2 to Leg Won">' +
              '<span>' + legLabel + '</span>' +
            '</button>';
            branchLeg.appendChild(connLeg);

          var cardLeg = createPhaseCardElement(pLeg);
          cardLeg.classList.add('phase-card-leg');
          branchLeg.appendChild(cardLeg);

          branchesCol.appendChild(branchLeg);

          forkContainer.appendChild(branchesCol);
          track.appendChild(forkContainer);

          var matchX = pTakeout ? 1015 : 793;
          var p1Center = 411;
          var p1EntryY = pTakeout ? 158 : 204;
          var forkW = pTakeout ? 1150 : 920;
          var legBadgeLeft = pTakeout ? '713px' : '602px';
          var matchBadgeLeft = '233px';

          if (pMatch) {
            // Render Match Won -> IDLE Overhead Loop Wire & Transition Badge
            var matchOverheadSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            matchOverheadSvg.setAttribute('class', 'flow-match-overhead-svg');
            matchOverheadSvg.setAttribute('id', 'flowMatchOverheadSvg');
            matchOverheadSvg.innerHTML =
              '<defs>' +
                '<marker id="matchReturnArrow" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="6" markerHeight="6" orient="auto">' +
                  '<polygon points="0,0 6,3 0,6" fill="#d29922"/>' +
                '</marker>' +
              '</defs>' +
              '<path id="flowMatchOverheadPath" class="flow-match-wire' + ('match_won->idle' === activeTransitionKey ? ' selected' : '') + '" ' +
              'd="M 1019 59 V 30 Q 1019 14 1003 14 H 81 Q 65 14 65 30 V 97" ' +
              'fill="none" stroke="#6e5616" stroke-width="1.3" marker-end="url(#matchReturnArrow)"/>';
            track.appendChild(matchOverheadSvg);

            // Match Won -> IDLE Transition Badge (placed above Game Start at X=235px)
            var matchReturnKey = 'match_won->idle';
            var matchReturnTrans = (currentFlow.transitions && currentFlow.transitions[matchReturnKey]) || { style: 'cut', duration: 0.0 };
            var matchReturnLabel = (matchReturnTrans.style || 'cut').charAt(0).toUpperCase() + (matchReturnTrans.style || 'cut').slice(1);
            var isMatchReturnSelected = (matchReturnKey === activeTransitionKey);
            var matchReturnDur = (matchReturnTrans.duration !== undefined) ? matchReturnTrans.duration.toFixed(1) + 's' : '0.0s';

            var matchReturnBadge = document.createElement('button');
            matchReturnBadge.className = 'flow-match-overhead-badge' + (isMatchReturnSelected ? ' selected' : '');
            matchReturnBadge.id = 'flowMatchOverheadBadge';
            matchReturnBadge.setAttribute('data-trans-key', matchReturnKey);
            matchReturnBadge.textContent = matchReturnLabel + ' • ' + matchReturnDur;
            matchReturnBadge.title = 'Edit Match Won return transition back to IDLE';
            matchReturnBadge.style.left = '235px';
            matchReturnBadge.addEventListener('click', function (e) {
              selectTransition(e, 'match_won', 'idle');
            });
            track.appendChild(matchReturnBadge);
          }

          // Render Leg Won -> Turn Player 1 Bottom Return Wire & Transition Badge
          var legReturnSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          legReturnSvg.setAttribute('class', 'flow-leg-bottom-svg');
          legReturnSvg.setAttribute('id', 'flowLegBottomSvg');
          legReturnSvg.innerHTML =
            '<defs>' +
              '<marker id="legReturnArrowUp" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="6" markerHeight="6" orient="auto">' +
                '<polygon points="0,0 6,3 0,6" fill="#3fb950"/>' +
              '</marker>' +
            '</defs>' +
            '<path id="flowLegBottomPath" class="flow-leg-wire' + ('leg_won->turn_p1' === activeTransitionKey ? ' selected' : '') + '" ' +
            'd="M 1019 195 V 212 Q 1019 228 1003 228 H 429 Q 413 228 413 212 V 167" ' +
            'fill="none" stroke="#238636" stroke-width="1.3" marker-end="url(#legReturnArrowUp)"/>';
          track.appendChild(legReturnSvg);

          // Leg Won -> Turn Player 1 Transition Badge
          var legReturnKey = 'leg_won->turn_p1';
          var legReturnTrans = (currentFlow.transitions && currentFlow.transitions[legReturnKey]) || { style: 'curtain', duration: 0.6 };
          var legReturnLabel = (legReturnTrans.style || 'curtain').charAt(0).toUpperCase() + (legReturnTrans.style || 'curtain').slice(1);
          var isLegReturnSelected = (legReturnKey === activeTransitionKey);
          var legReturnDur = (legReturnTrans.duration !== undefined) ? legReturnTrans.duration.toFixed(1) + 's' : '0.6s';

          var legReturnBadge = document.createElement('button');
          legReturnBadge.className = 'flow-leg-bottom-badge' + (isLegReturnSelected ? ' selected' : '');
          legReturnBadge.id = 'flowLegBottomBadge';
          legReturnBadge.setAttribute('data-trans-key', legReturnKey);
          legReturnBadge.textContent = legReturnLabel + ' • ' + legReturnDur;
          legReturnBadge.title = 'Edit Leg Won bottom return transition back to Turn Player 1';
          legReturnBadge.style.left = legBadgeLeft;
          legReturnBadge.addEventListener('click', function (e) {
            selectTransition(e, 'leg_won', 'turn_p1');
          });
          track.appendChild(legReturnBadge);

          // All post-loop victory phases handled in fork
          idx = phases.length;
        } else if (idx < phases.length - 1) {
          var nextPhase = phases[idx + 1];
          var exitConn = createConnectorElement(p2, nextPhase);
          track.appendChild(exitConn);
        }
      } else {
        // Standard linear phase card or IDLE column
        if (phase.id === 'idle') {
          var idleCol = document.createElement('div');
          idleCol.className = 'flow-idle-col';
          idleCol.id = 'flowIdleCol';

          var idleCard = createPhaseCardElement(phase);
          idleCol.appendChild(idleCard);

          var sleepBranch = createSleepBranchElement();
          idleCol.appendChild(sleepBranch);

          track.appendChild(idleCol);
        } else {
          var standardCard = createPhaseCardElement(phase);
          track.appendChild(standardCard);
        }

        if (idx < phases.length - 1) {
          var nextP = phases[idx + 1];
          var conn = createConnectorElement(phase, nextP);
          track.appendChild(conn);
        }
      }
    }

    if (flowTrackObserver && track) {
      flowTrackObserver.observe(track);
    }
    if (window.alignFlowWires) {
      window.alignFlowWires();
      if (typeof requestAnimationFrame !== 'undefined') {
        requestAnimationFrame(window.alignFlowWires);
      }
      setTimeout(window.alignFlowWires, 60);
    }
  }

  // Computes precise unzoomed CSS pixel offsets relative to track container
  function getOffsetInTrack(el, track) {
    if (!el || !track) return { left: 0, top: 0, width: 0, height: 0, centerX: 0, bottom: 0 };
    var x = 0, y = 0, curr = el;
    while (curr && curr !== track) {
      x += (curr.offsetLeft || 0);
      y += (curr.offsetTop || 0);
      curr = curr.offsetParent;
    }
    var w = el.offsetWidth || el.clientWidth || 0;
    var h = el.offsetHeight || el.clientHeight || 0;
    return {
      left: x,
      top: y,
      width: w,
      height: h,
      centerX: Math.round(x + w / 2),
      bottom: Math.round(y + h)
    };
  }

  // Dynamic wire alignment: aligns return wires with 100% pixel perfection in true CSS pixels
  window.alignFlowWires = function () {
    var track = document.getElementById('flowPipelineTrack');
    if (!track) return;

    var cardIdle = document.getElementById('flowCard_idle');
    var cardGameStart = document.getElementById('flowCard_game_start');
    var cardP1 = document.getElementById('flowCard_turn_p1');
    var cardMatch = document.getElementById('flowCard_match_won');
    var cardLeg = document.getElementById('flowCard_leg_won');

    if (!cardIdle || !cardP1 || !cardLeg) return;

    // Guard against hidden / unmeasured DOM: do not compute with zeroes if cards are hidden or unmeasured
    if (!cardIdle.offsetWidth || !cardP1.offsetWidth || !cardLeg.offsetWidth) return;

    var idleOff = getOffsetInTrack(cardIdle, track);
    var p1Off = getOffsetInTrack(cardP1, track);
    var legOff = getOffsetInTrack(cardLeg, track);

    if (!idleOff.centerX || !p1Off.centerX || !legOff.centerX) return;

    var idleX = idleOff.centerX;
    var idleTopY = idleOff.top;
    var p1X = p1Off.centerX;
    var p1BottomY = p1Off.bottom;
    var legX = legOff.centerX;
    var legBottomY = legOff.bottom;

    // 1. Overhead Wire (Match Won -> IDLE)
    if (cardMatch) {
      var matchOff = getOffsetInTrack(cardMatch, track);
      var matchX = matchOff.centerX;
      var matchTopY = matchOff.top;

      var matchOverheadPath = document.getElementById('flowMatchOverheadPath');
      var matchBadge = document.getElementById('flowMatchOverheadBadge');

      if (matchOverheadPath) {
        var r = 16;
        var topChannelY = 14;
        var dMatch = 'M ' + matchX + ' ' + matchTopY +
          ' V ' + (topChannelY + r) +
          ' Q ' + matchX + ' ' + topChannelY + ' ' + (matchX - r) + ' ' + topChannelY +
          ' H ' + (idleX + r) +
          ' Q ' + idleX + ' ' + topChannelY + ' ' + idleX + ' ' + (topChannelY + r) +
          ' V ' + idleTopY;
        matchOverheadPath.setAttribute('d', dMatch);
      }

      if (matchBadge && cardGameStart) {
        var gsOff = getOffsetInTrack(cardGameStart, track);
        matchBadge.style.left = gsOff.centerX + 'px';
      }
    }

    // 2. Bottom Return Wire (Leg Won -> Turn Player 1)
    var legReturnPath = document.getElementById('flowLegBottomPath');
    var legBadge = document.getElementById('flowLegBottomBadge');

    if (legReturnPath) {
      var bottomChannelY = 228;
      var r2 = 16;
      var dLeg = 'M ' + legX + ' ' + legBottomY +
        ' V ' + (bottomChannelY - r2) +
        ' Q ' + legX + ' ' + bottomChannelY + ' ' + (legX - r2) + ' ' + bottomChannelY +
        ' H ' + (p1X + r2) +
        ' Q ' + p1X + ' ' + bottomChannelY + ' ' + p1X + ' ' + (bottomChannelY - r2) +
        ' V ' + p1BottomY;
      legReturnPath.setAttribute('d', dLeg);
    }

    if (legBadge) {
      legBadge.style.left = Math.round((p1X + legX) / 2) + 'px';
    }
  };

  var flowTrackObserver = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(function () {
    if (window.alignFlowWires) window.alignFlowWires();
  }) : null;

  window.addEventListener('resize', function () {
    if (window.alignFlowWires) window.alignFlowWires();
  });

  // --- Select & Sync with Effect Studio ---
  window.selectPhase = function (phaseId, triggerLive) {
    selectedPhaseId = phaseId;
    if (phaseId === 'turn_p1' || phaseId === 'turn_p2') {
      lastTurnPlayerId = phaseId;
    }

    document.querySelectorAll('.flow-phase-card, .flow-slim-card').forEach(function (c) {
      if (c.getAttribute('data-phase-id') === phaseId) {
        c.classList.add('selected');
      } else {
        c.classList.remove('selected');
      }
    });

    document.querySelectorAll('.flow-event-chip').forEach(function (btn) {
      var k = btn.getAttribute('data-event-key');
      if (k === phaseId || (phaseId === 'calibrating' && k === 'calibration') || (phaseId === 'calibration' && k === 'calibrating')) {
        btn.classList.add('selected');
      } else {
        btn.classList.remove('selected');
      }
    });

    if (phaseId === 'idle_timeout') {
      selectSleepPhase(phaseId, triggerLive);
      return;
    }
    if (phaseId === 'idle_off') {
      if (triggerLive) {
        playSleepEffect('idle_off');
      }
      return;
    }

    var phase = getPhaseById(phaseId);
    if (!phase) return;

    syncPhaseToStudio(phase);
    if (!isEventChip(phaseId)) {
      autoSelectTransitionForPhase(phaseId);
    }
    var transCard = document.getElementById('transitionStudioCard');
    if (transCard) {
      transCard.style.display = isEventChip(phaseId) ? 'none' : '';
    }

    if (triggerLive) {
      playPhaseEffect(phase);
      var normK = (phaseId === 'calibration') ? 'calibrating' : phaseId;
      var chips = document.querySelectorAll('.flow-event-chip[data-event-key="' + normK + '"], .flow-event-chip[data-event-key="' + phaseId + '"]');
      chips.forEach(function (c) {
        c.classList.add('is-firing');
        setTimeout(function () { c.classList.remove('is-firing'); }, 350);
      });
    }
  };

  window.selectEventChip = function (e, eventKey) {
    if (e) e.stopPropagation();
    selectPhase(eventKey, true);
  };

  window.selectSleepPhase = function (phaseId, triggerLive) {
    selectedPhaseId = phaseId;

    document.querySelectorAll('.flow-phase-card, .flow-slim-card').forEach(function (c) {
      if (c.getAttribute('data-phase-id') === phaseId) {
        c.classList.add('selected');
      } else {
        c.classList.remove('selected');
      }
    });

    var idleSleep = (currentFlow && currentFlow.idle_sleep) || {};
    var inactMin = idleSleep.inactivity_minutes || 5;
    var dimPct = (idleSleep.dim_percent !== undefined) ? idleSleep.dim_percent : (Math.round((idleSleep.dim_brightness_raw || 50) / 255 * 100) || 20);

    var studioHeader = document.querySelector('.sim-studio-header .panel-title span');
    var animLabel = document.getElementById('studioAnimLabel');
    var animSelect = document.getElementById('studioAnimSelect');
    var durInput = document.getElementById('studioDurInput');
    var durVal = document.getElementById('studioDurVal');
    var studioTurnRow = document.getElementById('studioTurnEventsRow');
    if (studioTurnRow) studioTurnRow.style.display = 'none';

    var revRow = document.getElementById('studioReverseRow');
    if (revRow) revRow.style.display = 'none';
    var secGroup = document.getElementById('studioColSecondaryGroup');
    if (secGroup) secGroup.style.display = 'none';
    var spdGroup = document.getElementById('studioSpeedGroup');
    if (spdGroup) spdGroup.style.display = 'none';

    if (phaseId === 'idle_timeout') {
      var studioStrong = document.getElementById('studioHeaderPhaseName');
      if (studioStrong) {
        studioStrong.textContent = 'Inactivity Timeout';
      } else if (studioHeader) {
        studioHeader.textContent = 'Inactivity Timeout';
      }
      if (animLabel) animLabel.innerHTML = 'Power State <span style="font-size: 9.5px; color: #f59e0b; font-weight: 500;">(Dimming)</span>';
      if (animSelect) {
        animSelect.innerHTML = '<option value="dim">Inactivity Dim (' + dimPct + '% Brightness)</option>';
        animSelect.value = 'dim';
      }
      if (durInput) {
        durInput.disabled = true;
        durInput.style.opacity = '0.45';
        durInput.style.cursor = 'not-allowed';
      }
      if (durVal) durVal.textContent = inactMin + 'm threshold';

      var col1 = document.getElementById('studioColPrimary');
      var col1Hex = document.getElementById('studioColPrimaryHex');
      if (col1) col1.value = '#f59e0b';
      if (col1Hex) col1Hex.textContent = 'DIM ' + dimPct + '%';

      if (triggerLive) {
        playSleepEffect('idle_timeout');
      }
    }
  };

  function playSleepEffect(phaseId) {
    var card = document.getElementById('flowCard_' + phaseId);
    if (card) {
      card.classList.add('is-playing');
      setTimeout(function () { card.classList.remove('is-playing'); }, 1200);
    }

    if (phaseId === 'idle_timeout') {
      fetch('/api/power/test_dim', { method: 'POST' })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (typeof showToast === 'function') {
            showToast('Inactivity Timeout: Dimming active illumination & restored Idle Preset 1.', 'warning');
          }
        })
        .catch(function (err) {
          console.debug('Dim preview error:', err);
        });
    } else if (phaseId === 'idle_off') {
      fetch('/api/power/test_off', { method: 'POST' })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (typeof showToast === 'function') {
            showToast('Standby Auto-Off: All hardware LEDs powered off.', 'info');
          }
        })
        .catch(function (err) {
          console.debug('Auto-Off preview error:', err);
        });
    }
  }

  function autoSelectTransitionForPhase(phaseId) {
    if (!currentFlow || !currentFlow.phases || currentFlow.phases.length < 2) return;
    var pTakeout = currentFlow.phases && currentFlow.phases.some(function (p) { return p.id === 'takeout'; });
    if (phaseId === 'turn_p1') {
      selectTransition(null, 'turn_p1', pTakeout ? 'takeout' : 'turn_p2');
      return;
    }
    if (phaseId === 'takeout') {
      selectTransition(null, 'takeout', 'turn_p2');
      return;
    }
    if (phaseId === 'turn_p2') {
      selectTransition(null, 'turn_p2', pTakeout ? 'takeout' : 'turn_p1');
      return;
    }
    if (phaseId === 'leg_won') {
      selectTransition(null, 'turn_p2', 'leg_won');
      return;
    }
    if (phaseId === 'match_won') {
      selectTransition(null, 'turn_p2', 'match_won');
      return;
    }
    var phases = currentFlow.phases;
    var idx = -1;
    for (var i = 0; i < phases.length; i++) {
      if (phases[i].id === phaseId) { idx = i; break; }
    }
    if (idx === -1) return;

    if (idx < phases.length - 1) {
      selectTransition(null, phases[idx].id, phases[idx + 1].id);
    } else if (idx > 0) {
      selectTransition(null, phases[idx - 1].id, phases[idx].id);
    }
  }

  function getPhaseById(pId) {
    if (!currentFlow) return null;
    if (currentFlow.phases) {
      for (var i = 0; i < currentFlow.phases.length; i++) {
        if (currentFlow.phases[i].id === pId) return currentFlow.phases[i];
      }
    }
    var normKey = (pId === 'calibration') ? 'calibrating' : pId;
    if (currentFlow.events && currentFlow.events[normKey]) {
      return currentFlow.events[normKey];
    }
    if (DEFAULT_IN_TURN_EVENTS[normKey]) {
      var def = JSON.parse(JSON.stringify(DEFAULT_IN_TURN_EVENTS[normKey]));
      if (!currentFlow.events) currentFlow.events = {};
      currentFlow.events[normKey] = def;
      return currentFlow.events[normKey];
    }
    var idleSleep = (currentFlow && currentFlow.idle_sleep) || {};
    var inactMin = idleSleep.inactivity_minutes || 5;
    var standbyMin = idleSleep.standby_minutes || 30;

    if (pId === 'idle_timeout') {
      return {
        id: 'idle_timeout',
        name: 'Timeout (' + inactMin + 'm)',
        effect: {
          animation: 'solid',
          color_primary: [245, 158, 11],
          color_secondary: [0, 0, 0],
          duration: 0.0,
          speed: 1.0
        }
      };
    }
    if (pId === 'idle_off') {
      return {
        id: 'idle_off',
        name: 'Off (' + standbyMin + 'm)',
        effect: {
          animation: 'solid',
          color_primary: [0, 0, 0],
          color_secondary: [0, 0, 0],
          duration: 0.0,
          speed: 1.0
        }
      };
    }
    return null;
  }

  function updateDynamicStudioControls(animValue, isIdle) {
    // Reverse Direction toggle
    var revRow = document.getElementById('studioReverseRow');
    if (revRow) {
      var supportsReverse = !isIdle && (['chase', 'wipe', 'scan', 'comet'].indexOf(animValue) !== -1);
      revRow.style.display = supportsReverse ? 'flex' : 'none';
    }

    // Secondary Color picker
    var secGroup = document.getElementById('studioColSecondaryGroup');
    var colGrid = document.getElementById('studioColorGrid');
    if (secGroup) {
      var supportsSecondary = isIdle || (['pulse', 'breathe', 'wipe', 'scan', 'comet'].indexOf(animValue) !== -1);
      secGroup.style.display = supportsSecondary ? 'block' : 'none';
      if (colGrid) {
        colGrid.style.gridTemplateColumns = supportsSecondary ? '1fr 1fr' : '1fr';
      }
    }

    // Speed slider
    var spdGroup = document.getElementById('studioSpeedGroup');
    var timingGrid = document.getElementById('studioTimingGrid');
    if (spdGroup) {
      var supportsSpeed = (animValue !== 'solid');
      spdGroup.style.display = supportsSpeed ? 'block' : 'none';
      if (timingGrid) {
        timingGrid.style.gridTemplateColumns = supportsSpeed ? '1fr 1fr' : '1fr';
      }
    }
  }

  function syncPhaseToStudio(phase) {
    if (!phase) return;
    var eff = phase.effect || {};
    var isIdle = (phase.id === 'idle');

    var animLabel = document.getElementById('studioAnimLabel');
    var animSelect = document.getElementById('studioAnimSelect');
    var durInput = document.getElementById('studioDurInput');
    var durVal = document.getElementById('studioDurVal');

    if (isIdle) {
      if (animLabel) {
        animLabel.innerHTML = 'Animation <span style="font-size: 9.5px; color: var(--text-muted);">(Native)</span>';
      }
      if (animSelect) {
        animSelect.innerHTML = '';
        for (var i = 0; i < wledEffectsCatalog.length; i++) {
          var wEff = wledEffectsCatalog[i];
          var opt = document.createElement('option');
          opt.value = wEff.id;
          opt.textContent = wEff.name + ' (fx #' + wEff.id + ')';
          animSelect.appendChild(opt);
        }
        var targetFxId = (eff.wled_effect_id !== undefined && eff.wled_effect_id !== null) ? eff.wled_effect_id : 2;
        animSelect.value = targetFxId;
      }
      if (durInput) {
        durInput.value = 0.0;
        durInput.disabled = true;
        durInput.style.opacity = '0.45';
        durInput.style.cursor = 'not-allowed';
      }
      if (durVal) {
        durVal.textContent = 'Continuous';
      }
      updateDynamicStudioControls(eff.animation || 'breathe', true);
    } else {
      if (animLabel) {
        animLabel.textContent = 'Animation';
      }
      if (animSelect) {
        animSelect.innerHTML = '';
        for (var j = 0; j < standardUdpAnimations.length; j++) {
          var uAnim = standardUdpAnimations[j];
          var opt2 = document.createElement('option');
          opt2.value = uAnim.id;
          opt2.textContent = uAnim.name;
          animSelect.appendChild(opt2);
        }
        animSelect.value = eff.animation || 'solid';
      }
      if (durInput) {
        durInput.disabled = false;
        durInput.style.opacity = '';
        durInput.style.cursor = '';
        var dur = eff.duration !== undefined ? eff.duration : 2.0;
        durInput.value = dur;
        if (durVal) durVal.textContent = dur === 0 ? 'Continuous' : (dur.toFixed(1) + 's');
      }
      updateDynamicStudioControls(eff.animation || 'solid', false);
    }

    var c1 = eff.color_primary || [0, 240, 255];
    var h1 = rgbToHex(c1[0], c1[1], c1[2]);
    var col1 = document.getElementById('studioColPrimary');
    var col1Hex = document.getElementById('studioColPrimaryHex');
    if (col1) col1.value = h1;
    if (col1Hex) col1Hex.textContent = h1.toUpperCase();

    var c2 = eff.color_secondary || [0, 0, 0];
    var h2 = rgbToHex(c2[0], c2[1], c2[2]);
    var col2 = document.getElementById('studioColSecondary');
    var col2Hex = document.getElementById('studioColSecondaryHex');
    if (col2) col2.value = h2;
    if (col2Hex) col2Hex.textContent = h2.toUpperCase();

    var speed = eff.speed || 1.0;
    var speedInput = document.getElementById('studioSpeedInput');
    var speedVal = document.getElementById('studioSpeedVal');
    if (speedInput) speedInput.value = speed;
    if (speedVal) speedVal.textContent = speed.toFixed(1);

    var rev = document.getElementById('studioReverseToggle');
    if (rev) rev.checked = !!eff.reverse;

    // Update Studio header subtitle to show currently selected phase
    var studioStrong = document.getElementById('studioHeaderPhaseName');
    if (studioStrong) {
      studioStrong.textContent = phase.name;
    } else {
      var studioHeader = document.querySelector('.sim-studio-header .panel-title span');
      if (studioHeader) {
        studioHeader.textContent = phase.name;
      }
    }

    // Toggle in-turn celebration buttons in studio if Turn Player 1 or 2 is selected OR if an in-turn event is selected
    var studioTurnRow = document.getElementById('studioTurnEventsRow');
    if (studioTurnRow) {
      var showTurn = (phase.id === 'turn_p1' || phase.id === 'turn_p2' || isEventChip(phase.id));
      studioTurnRow.style.display = showTurn ? 'block' : 'none';
    }
  }

  function updatePhaseCardInPipeline(phase) {
    if (!phase) return;
    var card = document.getElementById('flowCard_' + phase.id);
    if (!card) {
      renderFlowPipeline();
      return;
    }
    var isIdle = (phase.id === 'idle');
    var eff = phase.effect || {};
    var col1 = eff.color_primary || [0, 240, 255];
    var hex1 = rgbToHex(col1[0], col1[1], col1[2]);
    var animName = (eff.animation || 'solid').toUpperCase();
    if (isIdle) {
      var fxName = eff.wled_effect_name || 'Breathe';
      animName = fxName.toUpperCase();
    }
    var durStr = isIdle ? 'Native' : ((eff.duration === 0) ? 'Cont' : (eff.duration || 2.0).toFixed(1) + 's');

    var chip = card.querySelector('.phase-color-chip');
    if (chip) chip.style.background = hex1;

    var summaryDiv = card.querySelector('.phase-effect-summary');
    if (summaryDiv) {
      var spans = summaryDiv.querySelectorAll('span');
      if (spans.length >= 2) {
        spans[0].textContent = animName;
        spans[1].textContent = '• ' + durStr;
      }
    }
  }

  // Hook changes in the right Studio back into the selected phase or event
  function hookStudioSync() {
    var anim = document.getElementById('studioAnimSelect');
    var col1 = document.getElementById('studioColPrimary');
    var col2 = document.getElementById('studioColSecondary');
    var dur = document.getElementById('studioDurInput');
    var spd = document.getElementById('studioSpeedInput');
    var rev = document.getElementById('studioReverseToggle');

    function syncFromStudio() {
      var phase = getPhaseById(selectedPhaseId);
      if (!phase) return;
      if (!phase.effect) phase.effect = {};

      var isIdle = (phase.id === 'idle');

      if (anim) {
        if (isIdle) {
          var fxId = parseInt(anim.value, 10);
          var selOption = anim.options[anim.selectedIndex];
          var fxName = selOption ? selOption.text.replace(/ \(fx #\d+\)$/, '') : 'Breathe';
          phase.effect.wled_effect_id = fxId;
          phase.effect.wled_effect_name = fxName;
          phase.effect.animation = mapWledEffectToSimAnimation(fxName);
          phase.effect.duration = 0.0;
          updateDynamicStudioControls(phase.effect.animation, true);
        } else {
          phase.effect.animation = anim.value;
          delete phase.effect.wled_effect_id;
          delete phase.effect.wled_effect_name;
          updateDynamicStudioControls(anim.value, false);
        }
      }
      if (col1) phase.effect.color_primary = hexToRgb(col1.value);
      if (col2) phase.effect.color_secondary = hexToRgb(col2.value);
      if (dur && !isIdle) phase.effect.duration = parseFloat(dur.value) || 0.0;
      if (spd) phase.effect.speed = parseFloat(spd.value) || 1.0;
      if (rev) phase.effect.reverse = rev.checked;

      var normKey = (selectedPhaseId === 'calibration') ? 'calibrating' : selectedPhaseId;
      if (isEventChip(normKey)) {
        if (!currentFlow.events) currentFlow.events = {};
        currentFlow.events[normKey] = phase;
      } else {
        updatePhaseCardInPipeline(phase);
      }
    }

    if (anim) anim.addEventListener('change', syncFromStudio);
    if (col1) col1.addEventListener('input', syncFromStudio);
    if (col2) col2.addEventListener('input', syncFromStudio);
    if (dur) dur.addEventListener('input', syncFromStudio);
    if (spd) spd.addEventListener('input', syncFromStudio);
    if (rev) rev.addEventListener('change', syncFromStudio);

    // Transition Studio inputs live sync
    var tStyle = document.getElementById('transStyleSelect');
    var tDur = document.getElementById('transDurInput');
    var tAcc = document.getElementById('transAccentCol');

    function syncTransitionSettings() {
      if (!activeTransitionKey || !currentFlow) return;
      if (!currentFlow.transitions) currentFlow.transitions = {};
      var parts = activeTransitionKey.split('->');
      if (!currentFlow.transitions[activeTransitionKey]) {
        currentFlow.transitions[activeTransitionKey] = {
          from_phase_id: parts[0],
          to_phase_id: parts[1]
        };
      }
      var trans = currentFlow.transitions[activeTransitionKey];

      if (tStyle) {
        trans.style = tStyle.value;
        var accGroup = document.getElementById('transAccentGroup');
        if (accGroup) {
          var isAccentStyle = (trans.style === 'pulse' || trans.style === 'flash');
          accGroup.style.display = isAccentStyle ? 'block' : 'none';
        }
        var activeBtn = document.querySelector('.flow-connector-btn[data-trans-key="' + activeTransitionKey + '"] span, .flow-loop-return-btn[data-trans-key="' + activeTransitionKey + '"], .flow-match-overhead-badge[data-trans-key="' + activeTransitionKey + '"], .flow-leg-bottom-badge[data-trans-key="' + activeTransitionKey + '"], .flow-dual-lane-btn[data-trans-key="' + activeTransitionKey + '"]');
        if (activeBtn) {
          if (activeBtn.classList.contains('flow-dual-lane-btn')) {
            var styleName = trans.style.charAt(0).toUpperCase() + trans.style.slice(1);
            activeBtn.textContent = styleName;
          } else if (activeBtn.tagName === 'BUTTON') {
            activeBtn.textContent = trans.style.charAt(0).toUpperCase() + trans.style.slice(1) + ' • ' + (trans.duration || 0.6).toFixed(1) + 's';
          } else {
            activeBtn.textContent = trans.style.charAt(0).toUpperCase() + trans.style.slice(1);
          }
        }
      }

      if (tDur) {
        var dVal = parseFloat(tDur.value) || 0.6;
        trans.duration = dVal;
        var durValEl = document.getElementById('transDurVal');
        if (durValEl) durValEl.textContent = dVal.toFixed(1) + 's';

        var returnOrOverheadBtn = document.querySelector('.flow-loop-return-btn[data-trans-key="' + activeTransitionKey + '"], .flow-match-overhead-badge[data-trans-key="' + activeTransitionKey + '"], .flow-leg-bottom-badge[data-trans-key="' + activeTransitionKey + '"]');
        if (returnOrOverheadBtn) {
          returnOrOverheadBtn.textContent = (trans.style.charAt(0).toUpperCase() + trans.style.slice(1)) + ' • ' + dVal.toFixed(1) + 's';
        }
      }

      if (tAcc) {
        trans.accent_color = hexToRgb(tAcc.value);
        var hexEl = document.getElementById('transAccentHex');
        if (hexEl) hexEl.textContent = tAcc.value.toUpperCase();
      }
    }

    if (tStyle) {
      tStyle.addEventListener('change', function () {
        syncTransitionSettings();
        if (activeTransitionKey) {
          var parts = activeTransitionKey.split('->');
          if (parts.length >= 2) {
            playTransitionVisualization(parts[0], parts[1]);
          }
        }
      });
    }
    if (tDur) tDur.addEventListener('input', syncTransitionSettings);
    if (tAcc) {
      tAcc.addEventListener('input', syncTransitionSettings);
      tAcc.addEventListener('change', function () {
        if (activeTransitionKey) {
          var parts = activeTransitionKey.split('->');
          if (parts.length >= 2) {
            playTransitionVisualization(parts[0], parts[1]);
          }
        }
      });
    }
  }

  function playPhaseEffect(phase) {
    if (!phase || !phase.effect) return;
    fetch('/api/flow/play_phase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phase_id: phase.id,
        effect: phase.effect,
        segment_id: 0
      })
    }).catch(function (err) {
      console.warn('Error playing phase:', err);
    });
  }

  // --- Transition Studio (Inline 2nd Menu) ---
  window.selectTransition = function (e, fromId, toId, triggerLive) {
    if (e) e.stopPropagation();
    activeTransitionKey = fromId + '->' + toId;

    document.querySelectorAll('.flow-connector-btn, .flow-loop-return-btn, .flow-match-overhead-badge, .flow-leg-bottom-badge, .flow-dual-lane-btn').forEach(function (btn) {
      if (btn.getAttribute('data-trans-key') === activeTransitionKey) {
        btn.classList.add('selected');
      } else {
        btn.classList.remove('selected');
      }
    });

    document.querySelectorAll('.flow-dual-lane').forEach(function (lane) {
      var btn = lane.querySelector('.flow-dual-lane-btn');
      var line = lane.querySelector('.flow-dual-lane-line');
      var poly = lane.querySelector('marker polygon');
      if (btn) {
        var k = btn.getAttribute('data-trans-key');
        var isSel = (k === activeTransitionKey);
        if (isSel) {
          btn.classList.add('selected');
          if (line) line.classList.add('selected');
          if (poly) poly.setAttribute('fill', '#58a6ff');
        } else {
          btn.classList.remove('selected');
          if (line) line.classList.remove('selected');
          if (poly) poly.setAttribute('fill', '#8b949e');
        }
      }
    });

    var matchPath = document.getElementById('flowMatchOverheadPath');
    if (matchPath) {
      if (activeTransitionKey === 'match_won->idle') {
        matchPath.classList.add('selected');
      } else {
        matchPath.classList.remove('selected');
      }
    }

    var legPath = document.getElementById('flowLegBottomPath');
    if (legPath) {
      if (activeTransitionKey === 'leg_won->turn_p1') {
        legPath.classList.add('selected');
      } else {
        legPath.classList.remove('selected');
      }
    }

    var wireMatch = document.getElementById('flowWireMatch');
    if (wireMatch) {
      if (activeTransitionKey === 'turn_p2->match_won') {
        wireMatch.classList.add('selected');
      } else {
        wireMatch.classList.remove('selected');
      }
    }

    var wireLeg = document.getElementById('flowWireLeg');
    if (wireLeg) {
      if (activeTransitionKey === 'turn_p2->leg_won') {
        wireLeg.classList.add('selected');
      } else {
        wireLeg.classList.remove('selected');
      }
    }

    // Ensure Transition Studio card is visible
    var transCard = document.getElementById('transitionStudioCard');
    if (transCard) {
      transCard.style.display = '';
    }

    syncTransitionToStudio(fromId, toId);

    // Play visualization when user explicitly clicked a transition
    if (triggerLive !== false && (e !== null || triggerLive === true)) {
      playTransitionVisualization(fromId, toId);
    }
  };

  // Backwards compatibility alias
  window.openTransitionDesigner = function (e, fromId, toId) {
    window.selectTransition(e, fromId, toId);
  };

  function syncTransitionToStudio(fromId, toId) {
    var pA = getPhaseById(fromId);
    var pB = getPhaseById(toId);
    if (!pA || !pB) return;

    var isSleepTrans = (toId === 'idle_timeout' || toId === 'idle_off');

    if (!currentFlow.transitions) currentFlow.transitions = {};
    if (!currentFlow.transitions[activeTransitionKey]) {
      currentFlow.transitions[activeTransitionKey] = {
        from_phase_id: fromId,
        to_phase_id: toId,
        style: isSleepTrans ? (toId === 'idle_timeout' ? 'dim' : 'off') : 'crossfade',
        duration: 0.6,
        accent_color: [0, 240, 255]
      };
    }
    var trans = currentFlow.transitions[activeTransitionKey];

    var fromToEl = document.getElementById('transFromToText');
    if (fromToEl) fromToEl.textContent = pA.name + ' ➔ ' + pB.name;

    var tStyle = document.getElementById('transStyleSelect');
    if (tStyle) {
      if (isSleepTrans) {
        tStyle.innerHTML = (toId === 'idle_timeout')
          ? '<option value="dim">Inactivity Dimming</option>'
          : '<option value="off">Standby Auto-Off</option>';
        tStyle.value = (toId === 'idle_timeout') ? 'dim' : 'off';
      } else {
        tStyle.innerHTML =
          '<option value="crossfade">Smooth Crossfade</option>' +
          '<option value="wipe">Directional Wipe</option>' +
          '<option value="pulse">Pulse Dissolve</option>' +
          '<option value="flash">Flash Burst</option>' +
          '<option value="curtain">Curtain Wipe</option>' +
          '<option value="instant">Instant Cut</option>';
        tStyle.value = (trans.style === 'cut') ? 'instant' : (trans.style || 'crossfade');
      }
    }

    var dur = (trans.duration !== undefined) ? trans.duration : 0.6;
    var tDur = document.getElementById('transDurInput');
    var durVal = document.getElementById('transDurVal');
    if (tDur) {
      tDur.disabled = isSleepTrans;
      tDur.style.opacity = isSleepTrans ? '0.45' : '';
      tDur.value = dur;
    }
    if (durVal) {
      if (isSleepTrans) {
        var idleSleep = (currentFlow && currentFlow.idle_sleep) || {};
        var mins = (toId === 'idle_timeout') ? (idleSleep.inactivity_minutes || 5) : (idleSleep.standby_minutes || 30);
        durVal.textContent = mins + 'm delay';
      } else {
        durVal.textContent = dur.toFixed(1) + 's';
      }
    }

    var acc = trans.accent_color || [0, 240, 255];
    var hexAcc = rgbToHex(acc[0], acc[1], acc[2]);
    var tAcc = document.getElementById('transAccentCol');
    var tHex = document.getElementById('transAccentHex');
    if (tAcc) tAcc.value = hexAcc;
    if (tHex) tHex.textContent = hexAcc.toUpperCase();

    var accGroup = document.getElementById('transAccentGroup');
    if (accGroup) {
      var isAccentStyle = !isSleepTrans && (trans.style === 'pulse' || trans.style === 'flash');
      accGroup.style.display = isAccentStyle ? 'block' : 'none';
    }
  }

  window.playTransitionVisualization = function (fromId, toId) {
    if (!fromId || !toId || !currentFlow) return;

    var pA = getPhaseById(fromId);
    var pB = getPhaseById(toId);
    if (!pA || !pB) return;

    var transKey = fromId + '->' + toId;
    var trans = (currentFlow.transitions && currentFlow.transitions[transKey]) || { style: 'crossfade', duration: 0.6 };
    var style = trans.style || 'crossfade';
    if (style === 'cut') style = 'instant';
    var dur = (trans.duration !== undefined) ? parseFloat(trans.duration) : 0.6;
    var acc = trans.accent_color || [0, 240, 255];

    // 1. Extract previous event's color as static
    var colA = [0, 160, 255];
    if (pA.effect && Array.isArray(pA.effect.color_primary) && pA.effect.color_primary.length >= 3) {
      colA = pA.effect.color_primary.slice(0, 3);
    } else if (fromId === 'idle_timeout') {
      colA = [245, 158, 11];
    } else if (fromId === 'idle_off') {
      colA = [0, 0, 0];
    }

    var effA = {
      animation: 'solid',
      color_primary: colA,
      color_secondary: [0, 0, 0],
      duration: 0.0,
      speed: 1.0,
      enabled: true
    };

    // 2. Extract next event's color as static
    var colB = [255, 255, 255];
    if (pB.effect && Array.isArray(pB.effect.color_primary) && pB.effect.color_primary.length >= 3) {
      colB = pB.effect.color_primary.slice(0, 3);
    } else if (toId === 'idle_timeout') {
      colB = [245, 158, 11];
    } else if (toId === 'idle_off') {
      colB = [0, 0, 0];
    }

    var effB = {
      animation: 'solid',
      color_primary: colB,
      color_secondary: [0, 0, 0],
      duration: 0.0,
      speed: 1.0,
      enabled: true
    };

    // Visual feedback on connector button / badge
    var activeBtns = document.querySelectorAll('[data-trans-key="' + transKey + '"]');
    activeBtns.forEach(function (btn) {
      btn.classList.add('is-firing');
      setTimeout(function () { btn.classList.remove('is-firing'); }, Math.max(800, (dur + 1.2) * 1000));
    });

    fetch('/api/flow/test_transition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from_phase_id: fromId,
        to_phase_id: toId,
        effect_a: effA,
        effect_b: effB,
        style: style,
        duration: dur,
        accent_color: acc,
        segment_id: 0
      })
    }).catch(function (err) {
      console.warn('Error running transition visualization:', err);
    });
  };

  window.testCurrentTransition = function () {
    if (!activeTransitionKey || !currentFlow) return;
    var parts = activeTransitionKey.split('->');
    if (parts.length < 2) return;

    var btn = document.getElementById('btnTestTransition');
    var trans = (currentFlow.transitions && currentFlow.transitions[activeTransitionKey]) || { duration: 0.6 };
    var dur = (trans.duration !== undefined) ? parseFloat(trans.duration) : 0.6;

    if (btn) {
      btn.innerHTML = '<span>Testing...</span>';
      btn.disabled = true;
      setTimeout(function () {
        btn.innerHTML = '<span>▶ Test</span>';
        btn.disabled = false;
      }, Math.max(800, (dur + 1.2) * 1000));
    }

    playTransitionVisualization(parts[0], parts[1]);
  };

  window.testActiveTransition = window.testCurrentTransition;

  // --- Playback Engine ---
  function getFlowPlaySequence() {
    var phases = (currentFlow && currentFlow.phases) ? currentFlow.phases : [];
    var pIds = phases.map(function (p) { return p.id; });
    var hasP1 = pIds.indexOf('turn_p1') !== -1;
    var hasTakeout = pIds.indexOf('takeout') !== -1;
    var hasP2 = pIds.indexOf('turn_p2') !== -1;
    var hasLeg = pIds.indexOf('leg_won') !== -1;
    var hasMatch = pIds.indexOf('match_won') !== -1;

    if (hasP1 && hasP2 && (hasLeg || hasMatch)) {
      var seq = [];
      if (hasTakeout) {
        seq = ['idle', 'game_start', 'turn_p1', 'takeout', 'turn_p2', 'takeout', 'turn_p1', 'takeout', 'turn_p2'];
        if (hasLeg) {
          seq.push('leg_won');
          seq.push('turn_p1');
          seq.push('takeout');
          seq.push('turn_p2');
        }
        if (hasMatch) {
          seq.push('match_won');
        }
        seq.push('idle');
      } else {
        seq = ['idle', 'game_start', 'turn_p1', 'turn_p2', 'turn_p1', 'turn_p2'];
        if (hasLeg) {
          seq.push('leg_won');
          seq.push('turn_p1');
          seq.push('turn_p2');
        }
        if (hasMatch) {
          seq.push('match_won');
        }
        seq.push('idle');
      }
      return seq;
    }
    return pIds;
  }

  window.playGameFlow = function () {
    if (!currentFlow || !currentFlow.phases || currentFlow.phases.length === 0) return;

    if (isPlayingFlow) {
      stopGameFlow();
      return;
    }

    isPlayingFlow = true;
    flowPlayIndex = 0;
    updatePlayButtonState(true);
    stepGameFlow();
  };

  // Auto Play: advance one step staying in player loop (P1 -> P2 -> P1 -> P2...)
  window.autoPlayNextPhase = function () {
    advancePhase(false);
  };

  // Next Step: advance forward through phases, exiting the turn loop (P2 -> Leg Won)
  window.playNextStepPhase = function () {
    advancePhase(true);
  };

  function advancePhase(exitLoop) {
    if (!currentFlow || !currentFlow.phases || currentFlow.phases.length === 0) return;
    if (isPlayingFlow) return; // full flow is running, ignore

    var pTakeout = currentFlow.phases && currentFlow.phases.some(function (p) { return p.id === 'takeout'; });
    var curId = selectedPhaseId || currentFlow.phases[0].id;
    var nextId = null;

    if (curId === 'idle') {
      nextId = 'game_start';
    } else if (curId === 'game_start') {
      nextId = 'turn_p1';
      lastTurnPlayerId = 'turn_p1';
    } else if (curId === 'turn_p1') {
      lastTurnPlayerId = 'turn_p1';
      nextId = pTakeout ? 'takeout' : 'turn_p2';
    } else if (curId === 'takeout') {
      if (lastTurnPlayerId === 'turn_p1') {
        nextId = 'turn_p2';
      } else {
        nextId = exitLoop ? 'leg_won' : 'turn_p1';
      }
    } else if (curId === 'turn_p2') {
      lastTurnPlayerId = 'turn_p2';
      nextId = exitLoop ? 'leg_won' : (pTakeout ? 'takeout' : 'turn_p1');
    } else if (curId === 'leg_won') {
      nextId = exitLoop ? 'match_won' : 'turn_p1';
    } else if (curId === 'match_won') {
      nextId = 'idle';
    } else {
      var phases = currentFlow.phases;
      var curIdx = 0;
      for (var i = 0; i < phases.length; i++) {
        if (phases[i].id === curId) { curIdx = i; break; }
      }
      var nextIdx = (curIdx + 1) % phases.length;
      nextId = phases[nextIdx].id;
    }

    var phase = getPhaseById(curId);
    var nextPhase = getPhaseById(nextId);
    if (!phase || !nextPhase) return;

    var tKey = phase.id + '->' + nextPhase.id;
    var trans = (currentFlow.transitions && currentFlow.transitions[tKey]) || { style: 'crossfade', duration: 0.6 };
    var transDur = (trans.duration || 0.6) / flowSpeedMultiplier;

    // Highlight current card as playing
    document.querySelectorAll('.flow-phase-card').forEach(function (c) { c.classList.remove('is-playing'); });
    var curCard = document.getElementById('flowCard_' + phase.id);
    if (curCard) curCard.classList.add('is-playing');

    var returnBtn = document.getElementById('flowLoopReturnBtn');
    if (returnBtn) returnBtn.classList.remove('is-active-loop');

    document.querySelectorAll('.flow-dual-lane-btn, .flow-dual-lane-line').forEach(function (el) {
      el.classList.remove('is-active-lane');
    });

    updatePlaybackButtonsState(true, exitLoop);

    var phaseDur = (phase.effect && phase.effect.duration > 0) ? phase.effect.duration : 1.6;
    var effectiveDur = Math.max(0.5, (phaseDur / flowSpeedMultiplier));

    // After this phase plays, fire the transition then land on the next phase
    flowPlayTimer = setTimeout(function () {
      if (tKey === 'turn_p2->turn_p1' && returnBtn) {
        returnBtn.classList.add('is-active-loop');
      }
      var activeLaneBtn = document.querySelector('.flow-dual-lane-btn[data-trans-key="' + tKey + '"]');
      var activeLaneLine = document.getElementById('line_' + tKey);
      if (activeLaneBtn) activeLaneBtn.classList.add('is-active-lane');
      if (activeLaneLine) activeLaneLine.classList.add('is-active-lane');

      var matchReturnBadge = document.getElementById('flowMatchOverheadBadge');
      var matchPath = document.getElementById('flowMatchOverheadPath');
      if (tKey === 'match_won->idle') {
        if (matchReturnBadge) matchReturnBadge.classList.add('is-active-loop');
        if (matchPath) matchPath.classList.add('is-active-wire');
      }
      var legReturnBadge = document.getElementById('flowLegBottomBadge');
      var legPath = document.getElementById('flowLegBottomPath');
      if (tKey === 'leg_won->turn_p1') {
        if (legReturnBadge) legReturnBadge.classList.add('is-active-loop');
        if (legPath) legPath.classList.add('is-active-wire');
      }

      // Fire transition
      fetch('/api/flow/test_transition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          effect_a: phase.effect,
          effect_b: nextPhase.effect,
          style: trans.style,
          duration: trans.duration || 0.6,
          accent_color: trans.accent_color,
          segment_id: 0
        })
      }).catch(function () {});

      // After transition, select & highlight next phase then stop
      flowPlayTimer = setTimeout(function () {
        document.querySelectorAll('.flow-phase-card').forEach(function (c) { c.classList.remove('is-playing'); });
        if (returnBtn) returnBtn.classList.remove('is-active-loop');
        document.querySelectorAll('.flow-dual-lane-btn, .flow-dual-lane-line').forEach(function (el) {
          el.classList.remove('is-active-lane');
        });
        if (matchReturnBadge) matchReturnBadge.classList.remove('is-active-loop');
        if (matchPath) matchPath.classList.remove('is-active-wire');
        if (legReturnBadge) legReturnBadge.classList.remove('is-active-loop');
        if (legPath) legPath.classList.remove('is-active-wire');
        selectPhase(nextPhase.id, false);
        updatePlaybackButtonsState(false, exitLoop);
        flowPlayTimer = null;
      }, transDur * 1000);
    }, effectiveDur * 1000);
  }

  function updatePlaybackButtonsState(active, isNextStep) {
    var nextBtn = document.getElementById('btnAutoPlayNext');
    var stepBtn = document.getElementById('btnPlayNextStep');

    if (nextBtn) {
      if (active && !isNextStep) {
        nextBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg><span>Playing...</span>';
        nextBtn.disabled = true;
        nextBtn.style.opacity = '0.65';
      } else {
        nextBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="5 3 19 12 5 21 5 3"/></svg><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-left:-2px"><line x1="13" y1="5" x2="13" y2="19"/><line x1="20" y1="5" x2="20" y2="19"/></svg><span>Play Next</span>';
        nextBtn.disabled = active;
        nextBtn.style.opacity = active ? '0.65' : '';
      }
    }

    if (stepBtn) {
      if (active && isNextStep) {
        stepBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg><span>Stepping...</span>';
        stepBtn.disabled = true;
        stepBtn.style.opacity = '0.65';
      } else {
        stepBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg><span>Next Step</span>';
        stepBtn.disabled = active;
        stepBtn.style.opacity = active ? '0.65' : '';
      }
    }
  }

  // --- In-Turn Dart Throw Simulation (Double, Triple, 180, Bull, Bust, Calibration) ---
  window.simulateTurnEvent = function (e, eventKey) {
    if (e) e.stopPropagation();
    var normKey = (eventKey === 'calibration') ? 'calibrating' : eventKey;
    selectPhase(normKey, true);
  };

  function stepGameFlow() {
    if (!isPlayingFlow || !currentFlow || !currentFlow.phases) return;
    var sequence = getFlowPlaySequence();

    if (flowPlayIndex >= sequence.length) {
      stopGameFlow();
      return;
    }

    var currentPhaseId = sequence[flowPlayIndex];
    var phase = getPhaseById(currentPhaseId);
    if (!phase) {
      flowPlayIndex++;
      stepGameFlow();
      return;
    }

    selectPhase(phase.id, true);

    document.querySelectorAll('.flow-phase-card').forEach(function (c) { c.classList.remove('is-playing'); });
    var activeCard = document.getElementById('flowCard_' + phase.id);
    if (activeCard) activeCard.classList.add('is-playing');

    var returnBtn = document.getElementById('flowLoopReturnBtn');
    if (returnBtn) returnBtn.classList.remove('is-active-loop');

    document.querySelectorAll('.flow-dual-lane-btn, .flow-dual-lane-line').forEach(function (el) {
      el.classList.remove('is-active-lane');
    });

    var phaseDur = (phase.effect && phase.effect.duration > 0) ? phase.effect.duration : 1.6;
    var effectiveDur = Math.max(0.5, (phaseDur / flowSpeedMultiplier));

    if (flowPlayIndex < sequence.length - 1) {
      var nextPhaseId = sequence[flowPlayIndex + 1];
      var nextP = getPhaseById(nextPhaseId);
      if (!nextP) {
        flowPlayIndex++;
        stepGameFlow();
        return;
      }

      var tKey = phase.id + '->' + nextP.id;
      var trans = (currentFlow.transitions && currentFlow.transitions[tKey]) || { style: 'crossfade', duration: 0.6 };
      var transDur = (trans.duration || 0.6) / flowSpeedMultiplier;
      var isReturnLoop = (phase.id === 'turn_p2' && nextP.id === 'turn_p1');
      var isLegBottom = (phase.id === 'leg_won' && nextP.id === 'turn_p1');
      var isMatchOverhead = (phase.id === 'match_won' && nextP.id === 'idle');

      flowPlayTimer = setTimeout(function () {
        if (!isPlayingFlow) return;

        if (isReturnLoop && returnBtn) {
          returnBtn.classList.add('is-active-loop');
        }

        var activeLaneBtn = document.querySelector('.flow-dual-lane-btn[data-trans-key="' + tKey + '"]');
        var activeLaneLine = document.getElementById('line_' + tKey);
        if (activeLaneBtn) activeLaneBtn.classList.add('is-active-lane');
        if (activeLaneLine) activeLaneLine.classList.add('is-active-lane');

        if (isMatchOverhead) {
          var matchBadge = document.getElementById('flowMatchOverheadBadge');
          var matchPath = document.getElementById('flowMatchOverheadPath');
          if (matchBadge) matchBadge.classList.add('is-active-loop');
          if (matchPath) matchPath.classList.add('is-active-wire');
        }
        if (isLegBottom) {
          var legBadge = document.getElementById('flowLegBottomBadge');
          var legPath = document.getElementById('flowLegBottomPath');
          if (legBadge) legBadge.classList.add('is-active-loop');
          if (legPath) legPath.classList.add('is-active-wire');
        }

        fetch('/api/flow/test_transition', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            effect_a: phase.effect,
            effect_b: nextP.effect,
            style: trans.style,
            duration: trans.duration || 0.6,
            accent_color: trans.accent_color,
            segment_id: 0
          })
        }).catch(function () {});

        flowPlayIndex++;
        flowPlayTimer = setTimeout(stepGameFlow, transDur * 1000);
      }, effectiveDur * 1000);
    } else {
      flowPlayTimer = setTimeout(function () {
        stopGameFlow();
      }, effectiveDur * 1000);
    }
  }

  window.stopGameFlow = function () {
    isPlayingFlow = false;
    if (flowPlayTimer) {
      clearTimeout(flowPlayTimer);
      flowPlayTimer = null;
    }
    document.querySelectorAll('.flow-phase-card').forEach(function (c) { c.classList.remove('is-playing'); });
    var returnBtn = document.getElementById('flowLoopReturnBtn');
    if (returnBtn) returnBtn.classList.remove('is-active-loop');
    document.querySelectorAll('.flow-dual-lane-btn, .flow-dual-lane-line').forEach(function (el) {
      el.classList.remove('is-active-lane');
    });
    var matchBadge = document.getElementById('flowMatchOverheadBadge');
    var matchPath = document.getElementById('flowMatchOverheadPath');
    if (matchBadge) matchBadge.classList.remove('is-active-loop');
    if (matchPath) matchPath.classList.remove('is-active-wire');
    var legBadge = document.getElementById('flowLegBottomBadge');
    var legPath = document.getElementById('flowLegBottomPath');
    if (legBadge) legBadge.classList.remove('is-active-loop');
    if (legPath) legPath.classList.remove('is-active-wire');
    updatePlayButtonState(false);
  };

  function updatePlayButtonState(playing) {
    var playBtn = document.getElementById('btnPlayFlow');
    if (playBtn) {
      if (playing) {
        playBtn.innerHTML = '<span>⏹ Stop Flow</span>';
        playBtn.classList.remove('btn-ide-primary');
        playBtn.style.background = 'rgba(239, 68, 68, 0.2)';
        playBtn.style.color = '#ef4444';
        playBtn.style.borderColor = 'rgba(239, 68, 68, 0.4)';
      } else {
        playBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg><span>Auto Play</span>';
        playBtn.classList.add('btn-ide-primary');
        playBtn.style.background = '';
        playBtn.style.color = '';
        playBtn.style.borderColor = '';
      }
    }
    var nextBtn = document.getElementById('btnAutoPlayNext');
    var stepBtn = document.getElementById('btnPlayNextStep');
    if (nextBtn) {
      nextBtn.disabled = playing;
      nextBtn.style.opacity = playing ? '0.5' : '';
    }
    if (stepBtn) {
      stepBtn.disabled = playing;
      stepBtn.style.opacity = playing ? '0.5' : '';
    }
  }

  // --- Persistence ---
  // Resolves true when the flow was saved
  window.saveGameFlow = function () {
    if (!currentFlow) return Promise.resolve(false);
    var saveBtns = document.querySelectorAll('.btn-save-flow, #btnSaveFlow');
    saveBtns.forEach(function (btn) { btn.textContent = 'Saving...'; });

    var payload = {
      flow: currentFlow,
      ip: (selectedFlowDeviceIp && selectedFlowDeviceIp !== 'all') ? selectedFlowDeviceIp : null,
      seg: (selectedFlowDeviceIp && selectedFlowDeviceIp !== 'all') ? selectedFlowSegmentId : null
    };

    return window.api.post('/api/flow/save', payload)
      .then(function () {
        saveBtns.forEach(function (btn) { btn.textContent = 'Saved!'; });
        markFlowSaved();
        setTimeout(updateFlowSaveState, 1800);
        window.toast.success('Flow saved');
        return true;
      })
      .catch(function (err) {
        updateFlowSaveState();
        window.toast.error(err, { onRetry: window.saveGameFlow });
        return false;
      });
  };

  window.resetGameFlow = function () {
    window.confirmDialog({
      title: 'Reset game flow?',
      body: 'All phases go back to the default player loop.',
      confirmLabel: 'Reset',
      danger: true
    }).then(function (confirmed) {
      if (!confirmed) return;
      return window.api.post('/api/flow/reset').then(function (data) {
        if (data && data.flow) {
          currentFlow = data.flow;
          renderFlowPipeline();
          if (currentFlow.phases && currentFlow.phases.length > 0) {
            selectPhase(currentFlow.phases[0].id, false);
          }
          markFlowSaved();
        }
      });
    }).catch(function (err) {
      window.toast.error(err, { onRetry: window.resetGameFlow });
    });
  };

  window.highlightFlowPhase = function (phaseId) {
    document.querySelectorAll('.flow-phase-card, .flow-slim-card').forEach(function (c) {
      c.classList.remove('is-playing');
    });
    if (!phaseId) return;
    var card = document.getElementById('flowCard_' + phaseId);
    if (card) {
      card.classList.add('is-playing');
    }
  };

  ['input', 'change', 'click'].forEach(function (type) {
    document.addEventListener(type, function (event) {
      if (event.target.closest && event.target.closest('#tab-simulator')) setTimeout(updateFlowSaveState, 0);
    });
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', window.initFlowPlanner);
  } else {
    window.initFlowPlanner();
  }

})();
