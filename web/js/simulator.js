/**
 * AutoGlow 2 - Digital LED Hardware Simulator & Effect Studio
 * Real-time 50 FPS Canvas visualizer for WS281x addressable LED strips.
 */

(function () {
  'use strict';

  // Simulator State
  var simWs = null;
  var simReconnectTimer = null;
  var isSimWsConnected = false;
  var simDest = 'both';     // 'simulator', 'hardware', 'both'
  var simPixels = [];       // Array of [r, g, b]
  var simLedCount = 45;
  var simHoverLed = -1;
  var simCanvasAnimId = null;
  var simZoomLevel = 0.86;

  // Dummy Board State (configurable LED count, proportional remap from live pixels)
  var DUMMY_LED_COUNT = 130;
  try {
    var storedDummyCount = parseInt(localStorage.getItem('autoglow_sim_dummy_led_count'), 10);
    if (!isNaN(storedDummyCount) && storedDummyCount > 0 && storedDummyCount <= 2000) {
      DUMMY_LED_COUNT = storedDummyCount;
    }
  } catch (e) {}
  var dummyCanvasAnimId = null;

  // Camera mount orientation configurations (Equilateral 120° Autodarts setups)
  var CAM_CONFIGS = {
    'default': [
      Math.PI,
      Math.PI + (2 * Math.PI / 3),
      Math.PI - (2 * Math.PI / 3)
    ],
    'mirrored': [
      0,
      2 * Math.PI / 3,
      -2 * Math.PI / 3
    ],
    'bottom': [
      Math.PI / 2,
      Math.PI / 2 + (2 * Math.PI / 3),
      Math.PI / 2 - (2 * Math.PI / 3)
    ],
    'top': [
      -Math.PI / 2,
      -Math.PI / 2 + (2 * Math.PI / 3),
      -Math.PI / 2 - (2 * Math.PI / 3)
    ]
  };
  var simCameraOrientation = 'default';
  try {
    var savedCam = localStorage.getItem('autoglow_sim_cam_orientation');
    if (savedCam && CAM_CONFIGS[savedCam]) {
      simCameraOrientation = savedCam;
    }
  } catch (e) {}

  // LED 0 starting position: always starts on one of the 3 cameras, rotating by 120°
  var simLedCamIndex = 0;   // 0 (Cam 1), 1 (Cam 2), 2 (Cam 3)
  try {
    var storedCamIdx = parseInt(localStorage.getItem('autoglow_sim_led0_cam_idx'), 10);
    if (!isNaN(storedCamIdx) && storedCamIdx >= 0 && storedCamIdx <= 2) {
      simLedCamIndex = storedCamIdx;
    }
  } catch (e) {}

  function getLedRotationForCurrentCam() {
    var camAngles = CAM_CONFIGS[simCameraOrientation] || CAM_CONFIGS['default'];
    var targetAngle = camAngles[simLedCamIndex % 3];
    var rotRad = targetAngle + Math.PI / 2;
    var deg = Math.round((rotRad * 180.0) / Math.PI) % 360;
    while (deg < 0) deg += 360;
    return { rotRad: rotRad, deg: deg };
  }

  var simLedRotation = getLedRotationForCurrentCam().deg;

  // Active Studio Effect State
  var studioState = {
    animation: 'chase',
    color_primary: '#00f0ff',
    color_secondary: '#000000',
    speed: 1.0,
    duration: 2.0,
    reverse: false,
    transition: 'crossfade',
    transition_duration: 0.5,
    segment_id: 0
  };

  function initSimulatorWebSocket() {
    if (simWs && (simWs.readyState === WebSocket.OPEN || simWs.readyState === WebSocket.CONNECTING)) {
      return;
    }

    var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var url = protocol + '//' + window.location.host + '/ws/simulator';

    try {
      simWs = new WebSocket(url);

      simWs.onopen = function () {
        isSimWsConnected = true;
        updateConnectionBadge(true);
        if (simReconnectTimer) {
          clearTimeout(simReconnectTimer);
          simReconnectTimer = null;
        }
      };

      simWs.onmessage = function (event) {
        try {
          var data = JSON.parse(event.data);
          if (data.type === 'frame' || data.type === 'init') {
            if (Array.isArray(data.pixels)) {
              // The dartboard simulator is strictly for the WS281x ring (45 LEDs, indices 0..44).
              // Never render any PWM spotlight channels (index 45+) on the ring.
              var targetCount = (typeof data.led_count === 'number' && data.led_count > 0) ? data.led_count : 45;
              simPixels = data.pixels.slice(0, targetCount);
              simLedCount = simPixels.length;
            }
            if (data.dest) simDest = data.dest;
            if (data.type === 'init' && data.simulator) {
              if (typeof data.simulator.led_rotation === 'number' && localStorage.getItem('autoglow_sim_led_rotation') === null) {
                simLedRotation = data.simulator.led_rotation % 360;
              }
              if (typeof updateRotationUI === 'function') {
                updateRotationUI();
              }
            }
            updateInspectorUI();
          }
        } catch (e) {
          console.error('[Simulator] Error parsing WebSocket message:', e);
        }
      };

      simWs.onclose = function () {
        isSimWsConnected = false;
        updateConnectionBadge(false);
        scheduleReconnect();
      };

      simWs.onerror = function () {
        isSimWsConnected = false;
        updateConnectionBadge(false);
      };
    } catch (err) {
      console.error('[Simulator] WebSocket initialization error:', err);
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (!simReconnectTimer) {
      simReconnectTimer = setTimeout(function () {
        simReconnectTimer = null;
        initSimulatorWebSocket();
      }, 2000);
    }
  }

  function updateConnectionBadge(connected) {
    var badge = document.getElementById('simWsStatusBadge');
    if (!badge) return;
    if (connected) {
      badge.innerHTML = '<span class="dot dot-green"></span><span>Connected</span>';
      badge.style.color = 'var(--status-success)';
    } else {
      badge.innerHTML = '<span class="dot dot-gray"></span><span>Connecting...</span>';
      badge.style.color = 'var(--text-muted)';
    }
  }

  function updateInspectorUI() {
    var liveCount = simPixels.length || simLedCount || 45;
    var ledCountEl = document.getElementById('simLedCountVal');
    if (ledCountEl) ledCountEl.textContent = liveCount + ' WS281x LEDs';

    // Update live board label badge
    var liveBadge = document.getElementById('simLiveLedBadge');
    if (liveBadge) liveBadge.textContent = liveCount + ' LEDs';

    var liveStreamBtn = document.getElementById('btnToggleLiveStream');
    var isLiveEnabled = (simDest === 'both' || simDest === 'hardware');
    if (liveStreamBtn) {
      if (isLiveEnabled) {
        liveStreamBtn.classList.add('active');
        liveStreamBtn.title = 'Live Stream: Active (sending to physical WLED hardware)';
      } else {
        liveStreamBtn.classList.remove('active');
        liveStreamBtn.title = 'Live Stream: Paused (simulator only)';
      }
    }
    var liveStreamDot = document.getElementById('liveStreamDot');
    if (liveStreamDot) {
      liveStreamDot.className = 'dot ' + (isLiveEnabled ? 'dot-green' : 'dot-gray');
    }
  }

  // Layout Cache for pixel-perfect hover hit-testing
  var lastCanvasLayout = {
    centerX: 500,
    centerY: 500,
    ringRadius: 404,
    rRingInner: 390,
    rRingOuter: 420,
    segAngle: (Math.PI * 2) / 45,
    numWsLeds: 45
  };

  // Base logical vector canvas dimensions (0..1000 square space)
  var LOGICAL_CANVAS_SIZE = 1000;

  // --- Ultra High-Definition Retina Canvas Rendering Engine ---
  function updateCanvasDimensions() {
    var canvas = document.getElementById('simulatorCanvas');
    if (!canvas) return null;

    var rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    // Actual physical screen resolution occupied by canvas
    var dpr = window.devicePixelRatio || 1;
    // Supersample at minimum 2x for laser-sharp vector edge antialiasing
    var renderScale = Math.max(2.0, dpr * 1.5);

    var pixelW = Math.round(rect.width * renderScale);
    var pixelH = Math.round(rect.height * renderScale);

    if (canvas.width !== pixelW || canvas.height !== pixelH) {
      canvas.width = pixelW;
      canvas.height = pixelH;
    }

    return { pixelW: pixelW, pixelH: pixelH, rect: rect };
  }

  function startCanvasRenderLoop() {
    if (simCanvasAnimId) return;

    function renderLoop() {
      drawSimulatorCanvas();
      drawDummyCanvas();
      simCanvasAnimId = requestAnimationFrame(renderLoop);
    }
    simCanvasAnimId = requestAnimationFrame(renderLoop);
  }

  function stopCanvasRenderLoop() {
    if (simCanvasAnimId) {
      cancelAnimationFrame(simCanvasAnimId);
      simCanvasAnimId = null;
    }
  }

  function drawAnnularSector(ctx, cx, cy, rInner, rOuter, aStart, aEnd, fillStyle) {
    ctx.beginPath();
    ctx.arc(cx, cy, rOuter, aStart, aEnd, false);
    ctx.arc(cx, cy, rInner, aEnd, aStart, true);
    ctx.closePath();
    ctx.fillStyle = fillStyle;
    ctx.fill();
  }

  function drawCameraPlaceholder(ctx, cx, cy, rRingOuter, scale, angle) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);

    // In local space:
    // (0,0) is dartboard center.
    // +X is radially outward from center.
    // -X is radially inward toward dartboard bullseye.
    // Y is tangential to the ring perimeter.

    var camSize = 35.0 * scale;   // Square dimensions (radial depth and tangential width)
    var cornerR = 5.0 * scale;    // Rounded corners
    var xStart = rRingOuter - 1.0 * scale; // Seated flush against the outer rim of the WLED ring

    // Camera Body: Just a clean, sleek square with rounded corners matching the setup style
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(xStart, -camSize / 2, camSize, camSize, cornerR);
    } else {
      var x = xStart, y = -camSize / 2, w = camSize, h = camSize, r = cornerR;
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    }

    var bodyGrad = ctx.createLinearGradient(xStart, 0, xStart + camSize, 0);
    bodyGrad.addColorStop(0, '#151a24');
    bodyGrad.addColorStop(0.5, '#11151f');
    bodyGrad.addColorStop(1, '#090c13');
    ctx.fillStyle = bodyGrad;
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Subtle interior bezel contour
    if (typeof ctx.roundRect === 'function') {
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.roundRect(xStart + 2.5 * scale, -camSize / 2 + 2.5 * scale, camSize - 5.0 * scale, camSize - 5.0 * scale, Math.max(2, cornerR - 2));
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }


  function updateDummyCanvasDimensions() {
    var canvas = document.getElementById('dummySimulatorCanvas');
    if (!canvas) return null;

    var rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    var dpr = window.devicePixelRatio || 1;
    var renderScale = Math.max(2.0, dpr * 1.5);

    var pixelW = Math.round(rect.width * renderScale);
    var pixelH = Math.round(rect.height * renderScale);

    if (canvas.width !== pixelW || canvas.height !== pixelH) {
      canvas.width = pixelW;
      canvas.height = pixelH;
    }

    return { pixelW: pixelW, pixelH: pixelH, rect: rect };
  }

  /**
   * Remap live pixels (e.g. 45 LEDs) smoothly to target dummy LED count (e.g. 135 LEDs).
   * Uses circular linear interpolation (LERP) across adjacent physical LEDs,
   * producing a silky-smooth, high-density light sweep instead of chunky blocks.
   */
  function buildDummyPixels(targetCount) {
    var src = simPixels;
    var srcCount = src.length;
    if (srcCount === 0) return [];
    var out = new Array(targetCount);
    for (var i = 0; i < targetCount; i++) {
      var pos = (i * srcCount) / targetCount;
      var i0 = Math.floor(pos) % srcCount;
      var i1 = (i0 + 1) % srcCount;
      var t = pos - Math.floor(pos);

      var c0 = src[i0] || [0, 0, 0];
      var c1 = src[i1] || [0, 0, 0];

      out[i] = [
        Math.round(c0[0] + (c1[0] - c0[0]) * t),
        Math.round(c0[1] + (c1[1] - c0[1]) * t),
        Math.round(c0[2] + (c1[2] - c0[2]) * t)
      ];
    }
    return out;
  }

  function drawDummyCanvas() {
    var canvas = document.getElementById('dummySimulatorCanvas');
    if (!canvas) return;

    var dims = updateDummyCanvasDimensions();
    if (!dims) return;

    var dummyPixels = buildDummyPixels(DUMMY_LED_COUNT);

    var ctx = canvas.getContext('2d');
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    var scaleFactor = dims.pixelW / 1000.0;
    ctx.setTransform(scaleFactor, 0, 0, scaleFactor, 0, 0);
    ctx.fillStyle = '#080c14';
    ctx.fillRect(0, 0, 1000, 1000);

    drawRingViewWithPixels(ctx, 1000, 1000, dummyPixels, DUMMY_LED_COUNT);

    ctx.restore();
  }

  function drawSimulatorCanvas() {
    var canvas = document.getElementById('simulatorCanvas');
    if (!canvas) return;

    var dims = updateCanvasDimensions();
    if (!dims) return;

    var ctx = canvas.getContext('2d');
    ctx.save();

    // Enable high-quality subpixel bicubic filtering
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Map 1000x1000 logical vector space directly to the high-res canvas buffer
    var scaleFactor = dims.pixelW / 1000.0;
    ctx.setTransform(scaleFactor, 0, 0, scaleFactor, 0, 0);

    // Background in 1000x1000 logical space
    ctx.fillStyle = '#080c14';
    ctx.fillRect(0, 0, 1000, 1000);

    drawRingView(ctx, 1000, 1000);

    ctx.restore();
  }

  // Generic ring renderer for both live (45) and dummy (130) boards.
  // pixelsArr: array of [r,g,b], ledCount: number of LEDs.
  function drawRingViewWithPixels(ctx, w, h, pixelsArr, ledCount) {
    drawRingView(ctx, w, h, pixelsArr, ledCount);
  }

  function drawRingView(ctx, w, h, pixelsArr, ledCount) {
    // Use override pixel data if provided (for dummy board), else live state
    var pixels = pixelsArr !== undefined ? pixelsArr : simPixels;
    var numWsLedsOverride = ledCount !== undefined ? ledCount : null;
    var centerX = w / 2;
    var centerY = h / 2;

    // Physical Calibration:
    // WLED lighting ring diameter: ~730mm (radius = 365mm)
    // Standard dartboard diameter: ~450mm (radius = 225mm)
    // Double bed outer wire diameter: 340mm (radius = 170mm)
    var baseRadius = Math.min(w, h) * 0.43;
    var ringRadius = baseRadius * (simZoomLevel / 0.85); // 730mm WLED ring radius in pixels
    var scale = ringRadius / 365.0; // exact screen pixels per physical millimeter

    var rInnerBull = 6.35 * scale;
    var rOuterBull = 15.9 * scale;
    var rTripleInner = 99.0 * scale;
    var rTripleOuter = 107.0 * scale;
    var rDoubleInner = 162.0 * scale;
    var rDoubleOuter = 170.0 * scale;
    var rNumberCenter = 197.5 * scale;
    var rBoardEdge = 225.0 * scale;        // 450mm diameter dartboard outer boundary
    var rSurroundOuter = 352.0 * scale;    // EVA foam surround protection catch ring (between 450mm and 730mm)
    var surroundRadius = 380.0 * scale;    // Outer chassis / Corona lighting ring mount

    var SECTOR_NUMS = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
    var halfSectorAngle = (9 * Math.PI) / 180;

    // 1. Outer Chassis / Wall Mount Frame
    ctx.beginPath();
    ctx.arc(centerX, centerY, surroundRadius, 0, Math.PI * 2);
    ctx.fillStyle = '#080c14';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 2. Authentic EVA Foam Protection Surround Ring (140mm spacing between 450mm board and 730mm ring)
    ctx.save();
    ctx.beginPath();
    ctx.arc(centerX, centerY, rSurroundOuter, 0, Math.PI * 2, false);
    ctx.arc(centerX, centerY, rBoardEdge, 0, Math.PI * 2, true);
    ctx.fillStyle = '#10141d';
    ctx.fill();

    // Clean outer stroke of surround ring (without radial bridge seam)
    ctx.beginPath();
    ctx.arc(centerX, centerY, rSurroundOuter, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    // 3. Dartboard Number Ring Band (Between 170mm double wire and 225mm board edge)
    ctx.beginPath();
    ctx.arc(centerX, centerY, rBoardEdge, 0, Math.PI * 2);
    ctx.arc(centerX, centerY, rDoubleOuter, 0, Math.PI * 2, true);
    ctx.fillStyle = '#141720';
    ctx.fill();

    // Outer rim wire of 450mm dartboard
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(centerX, centerY, rBoardEdge, 0, Math.PI * 2);
    ctx.stroke();

    // 4. Authentic 20 Sisal Segments (Double, Treble, Singles)
    for (var s = 0; s < 20; s++) {
      var centerAngle = (s * 18 - 90) * Math.PI / 180;
      var aStart = centerAngle - halfSectorAngle;
      var aEnd = centerAngle + halfSectorAngle;

      var isRedGreen = (s % 2 === 0);
      var ringCol = isRedGreen ? '#dc2626' : '#15803d';
      var singleCol = isRedGreen ? '#181b22' : '#e6dcba';

      // Outer Single Bed (107mm to 162mm)
      drawAnnularSector(ctx, centerX, centerY, rTripleOuter, rDoubleInner, aStart, aEnd, singleCol);
      // Double Bed (162mm to 170mm)
      drawAnnularSector(ctx, centerX, centerY, rDoubleInner, rDoubleOuter, aStart, aEnd, ringCol);
      // Inner Single Bed (15.9mm to 99mm)
      drawAnnularSector(ctx, centerX, centerY, rOuterBull, rTripleInner, aStart, aEnd, singleCol);
      // Triple Bed (99mm to 107mm)
      drawAnnularSector(ctx, centerX, centerY, rTripleInner, rTripleOuter, aStart, aEnd, ringCol);
    }

    // 5. Bullseye
    // Outer Bull (25 pts, 15.9mm radius)
    ctx.beginPath();
    ctx.arc(centerX, centerY, rOuterBull, 0, Math.PI * 2);
    ctx.fillStyle = '#15803d';
    ctx.fill();

    // Inner Bullseye (50 pts, 6.35mm radius)
    ctx.beginPath();
    ctx.arc(centerX, centerY, rInnerBull, 0, Math.PI * 2);
    ctx.fillStyle = '#dc2626';
    ctx.fill();

    // 6. Silver Spider Blade Wireframe
    ctx.save();
    ctx.strokeStyle = 'rgba(235, 245, 255, 0.88)';
    ctx.lineWidth = 1.2;

    // Radial Wires (extending from Outer Bull to Double Outer Wire)
    for (var wIdx = 0; wIdx < 20; wIdx++) {
      var wireAngle = (wIdx * 18 - 90 - 9) * Math.PI / 180;
      ctx.beginPath();
      ctx.moveTo(centerX + Math.cos(wireAngle) * rOuterBull, centerY + Math.sin(wireAngle) * rOuterBull);
      ctx.lineTo(centerX + Math.cos(wireAngle) * rDoubleOuter, centerY + Math.sin(wireAngle) * rDoubleOuter);
      ctx.stroke();
    }

    // Concentric Wire Rings
    [rInnerBull, rOuterBull, rTripleInner, rTripleOuter, rDoubleInner, rDoubleOuter].forEach(function (rad) {
      ctx.beginPath();
      ctx.arc(centerX, centerY, rad, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.restore();

    // 7. Number Ring Font Labels (Centered at 197.5mm, Upright)
    ctx.save();
    var numFontSize = Math.round(21.0 * scale);
    ctx.font = '700 ' + numFontSize + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f8fafc';
    for (var n = 0; n < 20; n++) {
      var nAngle = (n * 18 - 90) * Math.PI / 180;
      var nx = centerX + Math.cos(nAngle) * rNumberCenter;
      var ny = centerY + Math.sin(nAngle) * rNumberCenter;
      ctx.fillText(SECTOR_NUMS[n].toString(), nx, ny);
    }
    ctx.restore();

    // 7b. Barely Visible Bottom Center & Camera Alignment Guide Lines
    var ringTrackWidth = 26.0 * scale; // Segment thickness
    var rRingInner = ringRadius - ringTrackWidth / 2;
    var rRingOuter = ringRadius + ringTrackWidth / 2;
    var guideStartR = rBoardEdge + 3.0 * scale;
    var guideEndR = rRingInner - 2.0 * scale;

    var camAngles = CAM_CONFIGS[simCameraOrientation] || CAM_CONFIGS['default'];

    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 1.0;
    ctx.setLineDash([4.0 * scale, 4.0 * scale]);

    // Bottom Center Line (Under Sector 3, 6 o'clock) - ensure always present
    if (simCameraOrientation !== 'bottom') {
      ctx.beginPath();
      ctx.moveTo(centerX, centerY + guideStartR);
      ctx.lineTo(centerX, centerY + guideEndR);
      ctx.stroke();
    }

    // Camera Center Lines (Pointing inward from each camera)
    for (var c = 0; c < camAngles.length; c++) {
      var camA = camAngles[c];
      ctx.beginPath();
      ctx.moveTo(centerX + Math.cos(camA) * guideStartR, centerY + Math.sin(camA) * guideStartR);
      ctx.lineTo(centerX + Math.cos(camA) * guideEndR, centerY + Math.sin(camA) * guideEndR);
      ctx.stroke();
    }
    ctx.restore();

    // 8. WS281x Continuous Segmented LED Ring (Matching authentic physical diffuser channel)
    var numWsLeds = numWsLedsOverride !== null ? numWsLedsOverride :
      (pixels.length > 0 ? pixels.length : (simLedCount || 45));
    var segAngle = (Math.PI * 2) / numWsLeds;
    var rotInfo = getLedRotationForCurrentCam();
    var rotRad = rotInfo.rotRad;
    // Only mutate simLedRotation for the live board (when no override)
    if (numWsLedsOverride === null) simLedRotation = rotInfo.deg;

    // A. Outer Bloom / Glow for Active LEDs (Subtle, refined ambient halo)
    var densityFactor = Math.min(1.0, 45.0 / numWsLeds);
    for (var i = 0; i < numWsLeds; i++) {
      var r = 0, g = 0, b = 0;
      if (pixels[i]) {
        r = pixels[i][0];
        g = pixels[i][1];
        b = pixels[i][2];
      }
      // hover highlight only for the live board
      var isHovered = (numWsLedsOverride === null) && (simHoverLed === i);
      var brightness = (r + g + b) / (255 * 3);

      if (brightness > 0.04 || isHovered) {
        var centerAngle = -Math.PI / 2 + rotRad + (i * Math.PI * 2) / numWsLeds;
        var midX = centerX + Math.cos(centerAngle) * ringRadius;
        var midY = centerY + Math.sin(centerAngle) * ringRadius;
        var glowRadius = ringTrackWidth * (isHovered ? 1.5 : 1.2);
        var innerAlpha = Math.min(0.28, (isHovered ? 0.35 : 0.18) * Math.max(0.35, densityFactor) * (0.4 + 0.6 * brightness));
        var midAlpha = innerAlpha * 0.35;
        var glowGrad = ctx.createRadialGradient(midX, midY, ringTrackWidth * 0.15, midX, midY, glowRadius);
        glowGrad.addColorStop(0, 'rgba(' + r + ', ' + g + ', ' + b + ', ' + innerAlpha.toFixed(3) + ')');
        glowGrad.addColorStop(0.5, 'rgba(' + r + ', ' + g + ', ' + b + ', ' + midAlpha.toFixed(3) + ')');
        glowGrad.addColorStop(1, 'rgba(' + r + ', ' + g + ', ' + b + ', 0)');
        ctx.fillStyle = glowGrad;
        ctx.beginPath();
        ctx.arc(midX, midY, glowRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // B. Segment Blocks Fill
    for (var i = 0; i < numWsLeds; i++) {
      var centerAngle = -Math.PI / 2 + rotRad + (i * Math.PI * 2) / numWsLeds;
      var aStart = centerAngle - segAngle / 2;
      var aEnd = centerAngle + segAngle / 2;

      var r = 0, g = 0, b = 0;
      if (pixels[i]) {
        r = pixels[i][0];
        g = pixels[i][1];
        b = pixels[i][2];
      }
      var isHovered = (numWsLedsOverride === null) && (simHoverLed === i);
      var brightness = (r + g + b) / (255 * 3);

      ctx.beginPath();
      ctx.arc(centerX, centerY, rRingOuter, aStart, aEnd, false);
      ctx.arc(centerX, centerY, rRingInner, aEnd, aStart, true);
      ctx.closePath();

      if (brightness > 0.03) {
        ctx.fillStyle = 'rgb(' + r + ', ' + g + ', ' + b + ')';
      } else {
        ctx.fillStyle = isHovered ? '#1e2636' : '#121722';
      }
      ctx.fill();

      // Specular core reflection line for active segments (subtle highlight)
      if (brightness > 0.12) {
        ctx.beginPath();
        ctx.arc(centerX, centerY, ringRadius, aStart + 0.012, aEnd - 0.012, false);
        ctx.strokeStyle = 'rgba(255, 255, 255, ' + Math.min(0.35, brightness * 0.35) + ')';
        ctx.lineWidth = Math.max(1.0, ringTrackWidth * 0.12);
        ctx.stroke();
      }

      // Hover Outline
      if (isHovered) {
        ctx.beginPath();
        ctx.arc(centerX, centerY, rRingOuter + 0.5, aStart, aEnd, false);
        ctx.arc(centerX, centerY, rRingInner - 0.5, aEnd, aStart, true);
        ctx.closePath();
        ctx.strokeStyle = 'var(--accent-primary)';
        ctx.lineWidth = 2.0;
        ctx.stroke();
      }
    }

    // C. Black Borders & Segment Dividers (Rotated along with the LEDs)
    ctx.save();
    ctx.strokeStyle = '#080c14';
    ctx.lineWidth = 2.0;

    // Radial dividers between every segment
    for (var d = 0; d < numWsLeds; d++) {
      var dividerAngle = -Math.PI / 2 + rotRad + (d * Math.PI * 2) / numWsLeds - segAngle / 2;
      ctx.beginPath();
      ctx.moveTo(centerX + Math.cos(dividerAngle) * (rRingInner - 0.5), centerY + Math.sin(dividerAngle) * (rRingInner - 0.5));
      ctx.lineTo(centerX + Math.cos(dividerAngle) * (rRingOuter + 0.5), centerY + Math.sin(dividerAngle) * (rRingOuter + 0.5));
      ctx.stroke();
    }

    // Outer and inner continuous circular rim borders
    ctx.beginPath();
    ctx.arc(centerX, centerY, rRingOuter, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(centerX, centerY, rRingInner, 0, Math.PI * 2);
    ctx.stroke();

    // Subtle metallic outer bezel edge
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.arc(centerX, centerY, rRingOuter + 1, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(centerX, centerY, rRingInner - 1, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // D. Autodarts 3-Camera Hardware Mount Placeholders (120-degree equilateral spacing)
    for (var c = 0; c < camAngles.length; c++) {
      drawCameraPlaceholder(ctx, centerX, centerY, rRingOuter, scale, camAngles[c]);
    }


    // E. Diode Index Label (Positioned directly inside LED segment 0)
    var led0CenterAngle = -Math.PI / 2 + rotRad;
    var lblX = centerX + Math.cos(led0CenterAngle) * ringRadius;
    var lblY = centerY + Math.sin(led0CenterAngle) * ringRadius;

    ctx.save();
    var fontSize = Math.round(11.5 * scale);
    ctx.font = '800 ' + fontSize + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Dark stroke halo for high contrast on any LED background/color
    ctx.strokeStyle = 'rgba(8, 12, 20, 0.95)';
    ctx.lineWidth = 2.8 * scale;
    ctx.lineJoin = 'round';
    ctx.strokeText('0', lblX, lblY);

    // Pure white fill
    ctx.fillStyle = '#ffffff';
    ctx.fillText('0', lblX, lblY);
    ctx.restore();

    // Cache layout for hover and click detection (live board only)
    if (numWsLedsOverride === null) {
      lastCanvasLayout.centerX = centerX;
      lastCanvasLayout.centerY = centerY;
      lastCanvasLayout.ringRadius = ringRadius;
      lastCanvasLayout.rRingInner = rRingInner;
      lastCanvasLayout.rRingOuter = rRingOuter;
      lastCanvasLayout.segAngle = segAngle;
      lastCanvasLayout.numWsLeds = numWsLeds;
      lastCanvasLayout.rotRad = rotRad;
    }
  }

  // --- Interaction & Tooltip ---
  var canvasInteractionsSetup = false;

  function setupCanvasInteractions() {
    var canvas = document.getElementById('simulatorCanvas');
    if (!canvas) return;
    if (canvasInteractionsSetup) return;
    canvasInteractionsSetup = true;

    canvas.addEventListener('mousemove', function (e) {
      var rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      // Map mouse directly to 1000x1000 logical vector space
      var mouseX = ((e.clientX - rect.left) / rect.width) * 1000.0;
      var mouseY = ((e.clientY - rect.top) / rect.height) * 1000.0;
      var prevHover = simHoverLed;
      simHoverLed = -1;

      var num = lastCanvasLayout.numWsLeds || 45;
      var cx = lastCanvasLayout.centerX;
      var cy = lastCanvasLayout.centerY;
      var rInner = (lastCanvasLayout.rRingInner || 390) - 5;
      var rOuter = (lastCanvasLayout.rRingOuter || 420) + 20;
      var segAngle = lastCanvasLayout.segAngle || ((Math.PI * 2) / num);

      var dist = Math.hypot(mouseX - cx, mouseY - cy);
      if (dist >= rInner && dist <= rOuter) {
        var angle = Math.atan2(mouseY - cy, mouseX - cx);
        var rotRad = lastCanvasLayout.rotRad || 0;
        var startAngle = -Math.PI / 2 + rotRad - segAngle / 2;
        var relAngle = angle - startAngle;
        while (relAngle < 0) relAngle += Math.PI * 2;
        while (relAngle >= Math.PI * 2) relAngle -= Math.PI * 2;
        var hoveredIdx = Math.floor(relAngle / segAngle);
        if (hoveredIdx >= 0 && hoveredIdx < num) {
          simHoverLed = hoveredIdx;
        }
      }

    });

    canvas.addEventListener('click', function (e) {
      var rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      var mouseX = ((e.clientX - rect.left) / rect.width) * 1000.0;
      var mouseY = ((e.clientY - rect.top) / rect.height) * 1000.0;
      var cx = lastCanvasLayout.centerX;
      var cy = lastCanvasLayout.centerY;
      var rInner = (lastCanvasLayout.rRingInner || 390) - 8;
      var rOuter = (lastCanvasLayout.rRingOuter || 420) + 25;

      var dist = Math.hypot(mouseX - cx, mouseY - cy);
      if (dist >= rInner && dist <= rOuter) {
        var clickAngle = Math.atan2(mouseY - cy, mouseX - cx);
        var camAngles = CAM_CONFIGS[simCameraOrientation] || CAM_CONFIGS['default'];
        var bestIdx = 0;
        var bestDiff = Infinity;
        for (var c = 0; c < camAngles.length; c++) {
          var diff = Math.abs(clickAngle - camAngles[c]);
          while (diff > Math.PI) diff = Math.abs(diff - 2 * Math.PI);
          if (diff < bestDiff) {
            bestDiff = diff;
            bestIdx = c;
          }
        }
        window.setSimulatorLedCamIndex(bestIdx);
      }
    });

    canvas.addEventListener('mouseleave', function () {
      simHoverLed = -1;
    });
  }

  window.adjustSimulatorZoom = function () {};

  // --- Studio Actions & Controls ---
  window.setSimulatorViewMode = function () {};

  window.toggleSimulatorLiveStream = function () {
    var isLiveEnabled = (simDest === 'both' || simDest === 'hardware');
    var nextDest = isLiveEnabled ? 'simulator' : 'both';
    window.setSimulatorStreamDest(nextDest);
  };

  window.setSimulatorStreamDest = function (dest) {
    simDest = dest;
    fetch('/api/simulator/dest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dest: dest })
    }).then(function (res) { return res.json(); })
      .then(function (d) {
        if (d.status === 'ok') {
          var isLive = (dest === 'both' || dest === 'hardware');
          if (typeof showToast === 'function') {
            showToast(isLive ? 'Live Stream: Active (sending to hardware)' : 'Live Stream: Paused (simulator only)', 'info');
          }
          updateInspectorUI();
        }
      }).catch(function (err) {
        console.error('Error setting destination:', err);
      });
  };

  window.testStudioEffect = function () {
    var animSelectEl = document.getElementById('studioAnimSelect');
    var animVal = animSelectEl ? animSelectEl.value : 'solid';
    var wledId = null;
    var wledName = null;
    var anim = animVal;

    if (!isNaN(parseInt(animVal, 10)) && isFinite(animVal)) {
      wledId = parseInt(animVal, 10);
      var selOpt = animSelectEl.options[animSelectEl.selectedIndex];
      wledName = selOpt ? selOpt.text.replace(/ \(fx #\d+\)$/, '') : 'Breathe';
      if (typeof window.mapWledEffectToSimAnimation === 'function') {
        anim = window.mapWledEffectToSimAnimation(wledName);
      } else {
        anim = 'breathe';
      }
    }

    var col1 = document.getElementById('studioColPrimary').value;
    var col2 = document.getElementById('studioColSecondary').value;
    var speed = parseFloat(document.getElementById('studioSpeedInput').value) || 1.0;
    var dur = parseFloat(document.getElementById('studioDurInput').value) || 2.0;
    var reverse = document.getElementById('studioReverseToggle').checked;
    var transEl = document.getElementById('studioTransitionSelect');
    var transition = transEl ? transEl.value : 'instant';
    var transDurEl = document.getElementById('studioTransDurInput');
    var transitionDur = transDurEl ? (parseFloat(transDurEl.value) || 0.0) : 0.0;
    var segId = parseInt(document.getElementById('studioSegSelect').value, 10) || 0;

    var effPayload = {
      animation: anim,
      color_primary: hexToRgb(col1),
      color_secondary: hexToRgb(col2),
      speed: speed,
      duration: dur,
      reverse: reverse,
      transition: transition,
      transition_duration: transitionDur
    };
    if (wledId !== null) {
      effPayload.wled_effect_id = wledId;
      effPayload.wled_effect_name = wledName;
    }

    var payload = {
      effect: effPayload,
      segment_id: segId
    };

    fetch('/api/simulator/test_effect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.status === 'ok') {
          showToast('Playing ' + anim.toUpperCase() + ' effect', 'info');
        } else {
          showToast(d.message || 'Error executing effect', 'error');
        }
      }).catch(function (e) {
        showToast('Failed to trigger effect: ' + e, 'error');
      });
  };

  window.stopStudioEffect = function () {
    fetch('/api/test/effect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        effect: { animation: 'off', duration: 0.1 }
      })
    }).then(function () {
      showToast('Simulator channels cleared', 'info');
    }).catch(function (e) {
      console.error(e);
    });
  };

  window.triggerGameplayEvent = function (eventKey) {
    fetch('/api/test/effect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: eventKey })
    }).then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.status === 'ok') {
          showToast('Triggered ' + eventKey.toUpperCase() + ' event', 'info');
        } else {
          showToast(d.message || 'Error triggering event', 'error');
        }
      }).catch(function (err) {
        showToast('Error: ' + err, 'error');
      });
  };


  function hexToRgb(hex) {
    var clean = hex.replace('#', '');
    if (clean.length === 3) {
      clean = clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2];
    }
    var num = parseInt(clean, 16);
    return [ (num >> 16) & 255, (num >> 8) & 255, num & 255 ];
  }

  function updateLedCamUI() {
    var btn = document.getElementById('btnRotateLed120');
    if (btn) {
      btn.title = 'Rotate LED 0 by 120° to next camera (Currently aligned to Cam ' + (simLedCamIndex + 1) + ')';
    }
  }

  window.setSimulatorLedCamIndex = function (idx) {
    simLedCamIndex = ((idx % 3) + 3) % 3;
    try {
      localStorage.setItem('autoglow_sim_led0_cam_idx', simLedCamIndex.toString());
    } catch (e) {}

    var rotInfo = getLedRotationForCurrentCam();
    simLedRotation = rotInfo.deg;
    try {
      localStorage.setItem('autoglow_sim_led_rotation', simLedRotation.toString());
    } catch (e) {}

    updateLedCamUI();

    fetch('/api/simulator/cable_offset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rotation: simLedRotation })
    }).catch(function (err) {
      console.debug('[Simulator] Failed to persist rotation to server:', err);
    });
  };

  window.rotateSimulatorLed120 = function () {
    window.setSimulatorLedCamIndex(simLedCamIndex + 1);
  };

  var CAM_ORIENTATION_ORDER = ['default', 'mirrored', 'bottom', 'top'];
  var CAM_ORIENTATION_LABELS = {
    'default': 'Default',
    'mirrored': 'Mirrored',
    'bottom': '6 o\'clock',
    'top': '12 o\'clock'
  };

  window.cycleSimulatorCameraOrientation = function () {
    var curIdx = CAM_ORIENTATION_ORDER.indexOf(simCameraOrientation);
    if (curIdx < 0) curIdx = 0;
    var nextIdx = (curIdx + 1) % CAM_ORIENTATION_ORDER.length;
    window.setSimulatorCameraOrientation(CAM_ORIENTATION_ORDER[nextIdx]);
  };

  function updateCameraUI() {
    var label = document.getElementById('simCamOrientationLabel');
    if (label) {
      label.textContent = CAM_ORIENTATION_LABELS[simCameraOrientation] || 'Default';
    }
    var btn = document.getElementById('btnCycleCameraOrientation');
    if (btn) {
      btn.title = 'Camera mount orientation: ' + (CAM_ORIENTATION_LABELS[simCameraOrientation] || 'Default') + ' (Click to cycle)';
    }
    var pills = document.querySelectorAll('#simCamPills .sim-dest-pill[data-cam]');
    for (var i = 0; i < pills.length; i++) {
      if (pills[i].getAttribute('data-cam') === simCameraOrientation) {
        pills[i].classList.add('active');
      } else {
        pills[i].classList.remove('active');
      }
    }
  }

  window.setSimulatorCameraOrientation = function (orientation) {
    if (!CAM_CONFIGS[orientation]) orientation = 'default';
    simCameraOrientation = orientation;
    try {
      localStorage.setItem('autoglow_sim_cam_orientation', simCameraOrientation);
    } catch (e) {}
    updateCameraUI();
    window.setSimulatorLedCamIndex(simLedCamIndex);
  };

  window.setSimulatorRotation = function (deg) {
    var parsed = parseInt(deg, 10);
    if (isNaN(parsed) || parsed < 0) parsed = 0;
    var targetRad = ((parsed - 90) * Math.PI) / 180.0;
    var camAngles = CAM_CONFIGS[simCameraOrientation] || CAM_CONFIGS['default'];
    var bestIdx = 0;
    var bestDiff = Infinity;
    for (var c = 0; c < camAngles.length; c++) {
      var diff = Math.abs(targetRad - camAngles[c]);
      while (diff > Math.PI) diff = Math.abs(diff - 2 * Math.PI);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = c;
      }
    }
    window.setSimulatorLedCamIndex(bestIdx);
  };

  window.handleSimulatorRotationInput = function (val) {
    window.setSimulatorRotation(val);
  };

  window.setSimulatorDummyLedCount = function (val) {
    var parsed = parseInt(val, 10);
    if (isNaN(parsed) || parsed <= 0) parsed = 130;
    DUMMY_LED_COUNT = Math.max(1, Math.min(2000, parsed));
    try {
      localStorage.setItem('autoglow_sim_dummy_led_count', DUMMY_LED_COUNT.toString());
    } catch (e) {}
    var input = document.getElementById('dummyLedInput');
    if (input) input.value = DUMMY_LED_COUNT;
    drawDummyCanvas();
  };

  window.handleSimulatorDummyLedInput = function (val) {
    var parsed = parseInt(val, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 2000) {
      DUMMY_LED_COUNT = parsed;
      try {
        localStorage.setItem('autoglow_sim_dummy_led_count', DUMMY_LED_COUNT.toString());
      } catch (e) {}
      drawDummyCanvas();
    }
  };

  window.setSimulatorSegmentLedCount = function (val) {
    var parsed = parseInt(val, 10);
    if (!isNaN(parsed) && parsed > 0) {
      simLedCount = parsed;
      DUMMY_LED_COUNT = parsed;
      updateInspectorUI();
      if (typeof drawDummyCanvas === 'function') drawDummyCanvas();
    }
  };

  // --- Tab Lifecycle ---
  window.renderSimulatorTab = function () {
    initSimulatorWebSocket();
    startCanvasRenderLoop();
    setupCanvasInteractions();
    updateLedCamUI();
    updateCameraUI();
    updateInspectorUI();
    var dummyInput = document.getElementById('dummyLedInput');
    if (dummyInput) dummyInput.value = DUMMY_LED_COUNT;
    if (window.alignFlowWires) {
      window.alignFlowWires();
      setTimeout(window.alignFlowWires, 60);
    }
  };

})();
