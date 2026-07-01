document.addEventListener('DOMContentLoaded', () => {
    // Screen transition elements
    const screenMainMenu = document.getElementById('screen-main-menu');
    const screenDevices = document.getElementById('screen-devices');
    const btnSaveAll = document.getElementById('btn-save-all');
    const btnHome = document.getElementById('btn-home');
    
    // Main Menu elements
    const brightnessSlider = document.getElementById('global-brightness-slider');
    const brightnessVal = document.getElementById('brightness-val');
    const statesListContainer = document.getElementById('states-list-container');
    
    // WLED Hardware elements
    const wledHwContainer = document.getElementById('wled-hw-settings-container');
    const wledSegmentsList = document.getElementById('wled-segments-list');
    const btnWledAddSegment = document.getElementById('btn-wled-add-segment');
    
    // Settings Modal elements
    const settingsModal = document.getElementById('settings-modal');
    const btnSettingsSave = document.getElementById('btn-settings-save');
    const btnSettingsCancel = document.getElementById('btn-settings-cancel');
    const crossfadeToggle = document.getElementById('crossfade-toggle');
    const localBoardApiToggle = document.getElementById('local-board-api-toggle');
    const onlineBoardApiToggle = document.getElementById('online-board-api-toggle');
    const wsLed = document.getElementById('autodarts-ws-led');
    const onlineWsLed = document.getElementById('autodarts-online-ws-led');
    const wsLabel = document.getElementById('autodarts-ws-label');
    
    // Autodarts authentication elements
    const autodartsEmailInput = document.getElementById('autodarts-email-input');
    const autodartsPasswordInput = document.getElementById('autodarts-password-input');
    const btnAutodartsLink = document.getElementById('btn-autodarts-link');
    const autodartsAuthForm = document.getElementById('autodarts-auth-form');
    const autodartsAuthStatus = document.getElementById('autodarts-auth-status');
    const autodartsAuthBadge = document.getElementById('autodarts-auth-badge');
    const autodartsProfileName = document.getElementById('autodarts-profile-name');
    const autodartsProfileEmail = document.getElementById('autodarts-profile-email');
    const btnAutodartsDisconnect = document.getElementById('btn-autodarts-disconnect');
    const autodartsAvatar = document.getElementById('autodarts-avatar');
    
    let loadedConfig = {};
    let activeSectionIdx = -1;
    let hasWifi = true;
    let isScanForDevicesPage = false;
    
    const WLED_EFFECTS = {
        "Solid": 0, "Blink": 1, "Breathe": 2, "Wipe": 3, "Scan": 45,
        "Rainbow": 9, "Chase": 28, "Fire": 66, "Strobe": 8,
        "Color Loop": 11, "Heartbeat": 101, "Pacifica": 104
    };
    
    const DARTBOARD_STATES = [
        "Throw", "Takeout in progress", "Takeout", 
        "Starting", "Stopped", "Calibrating", "Error"
    ];

    // Online-exclusive states (only available via Online Board API)
    const ONLINE_STATES = [
        "Bust",
        "180",
        "Throw Player 1",
        "Throw Player 2",
        "Leg Won",
        "Match Won",
        "Triple"
    ];

    const ALL_STATES = [...DARTBOARD_STATES, ...ONLINE_STATES];

    let availablePorts = [];
    let syncStatusInterval = null;

    async function updateSyncStatuses() {
        try {
            const resp = await fetch('/api/sync_status');
            if (resp.ok) {
                const status = await resp.json();
                
                const localBadge = document.getElementById('status-local-api');
                const onlineBadge = document.getElementById('status-online-api');
                
                if (localBadge) {
                    if (status.local) {
                        localBadge.textContent = 'Connected';
                        localBadge.className = 'auth-badge auth-badge--connected';
                    } else {
                        localBadge.textContent = 'Offline';
                        localBadge.className = 'auth-badge auth-badge--disconnected';
                    }
                }
                if (onlineBadge) {
                    if (status.online) {
                        onlineBadge.textContent = 'Connected';
                        onlineBadge.className = 'auth-badge auth-badge--connected';
                    } else {
                        onlineBadge.textContent = 'Offline';
                        onlineBadge.className = 'auth-badge auth-badge--disconnected';
                    }
                }
            }
        } catch (err) {
            console.error('Failed to update sync statuses:', err);
        }
    }

    // Helper to dynamically update the status pill and its visual state
    function updateStatusPill(text) {
        const autoProvStatus = document.getElementById('auto-prov-status');
        if (!autoProvStatus) return;
        autoProvStatus.textContent = text;
        
        // Remove existing state classes
        autoProvStatus.classList.remove('success', 'error', 'running');
        
        if (text.includes('Success') || text.includes('success') || text.includes('Verified WLED is online') || text.includes('Saved verified WLED IP')) {
            autoProvStatus.classList.add('success');
        } else if (text.includes('Error') || text.includes('❌') || text.includes('failed')) {
            autoProvStatus.classList.add('error');
        } else if (text !== 'Idle' && !text.includes('retrying')) {
            autoProvStatus.classList.add('running');
        }
    }

    // Helper to perform a single auto-provisioning attempt
    async function runAutoProvisioningAttempt() {
        const response = await fetch('/api/wled/auto_provision', { method: 'POST' });
        if (!response.ok) throw new Error('Auto-provisioning endpoint failed');
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value);
            buffer += chunk;
            
            const lines = buffer.split('\n');
            let latestStatus = '';
            for (let i = lines.length - 1; i >= 0; i--) {
                const l = lines[i].trim();
                if (l) {
                    latestStatus = l;
                    break;
                }
            }
            if (latestStatus) {
                updateStatusPill(latestStatus);
                if (isScanForDevicesPage) {
                    const msgEl = document.getElementById('easy-setup-message');
                    if (msgEl) msgEl.textContent = latestStatus;
                }
            }
        }
        
        return buffer.includes('Success! Verified WLED is online') || buffer.includes('Saved verified WLED IP');
    }



    // Toast Notifications
    function showToast(message, type = 'success') {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;

        const icon = type === 'success' ? '✓' : '✗';
        toast.innerHTML = `
            <span class="toast-icon">${icon}</span>
            <span class="toast-message">${message}</span>
        `;

        container.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('fade-out');
            toast.addEventListener('animationend', () => {
                toast.remove();
            });
        }, 3000);
    }
    
    function showConfirm(title, message, confirmText, onConfirm, isDanger = true) {
        const confirmModal = document.getElementById('confirm-modal');
        const confirmTitle = document.getElementById('confirm-modal-title');
        const confirmMessage = document.getElementById('confirm-modal-message');
        const btnYes = document.getElementById('btn-confirm-yes');
        const btnNo = document.getElementById('btn-confirm-no');
        
        if (!confirmModal || !confirmTitle || !confirmMessage || !btnYes || !btnNo) return;
        
        confirmTitle.textContent = title;
        confirmMessage.textContent = message;
        
        confirmModal.classList.add('active');
        
        // Clone buttons to clear previous listeners
        const newBtnYes = btnYes.cloneNode(true);
        const newBtnNo = btnNo.cloneNode(true);
        btnYes.parentNode.replaceChild(newBtnYes, btnYes);
        btnNo.parentNode.replaceChild(newBtnNo, btnNo);
        
        newBtnYes.textContent = confirmText;
        if (isDanger) {
            newBtnYes.className = 'btn-danger';
        } else {
            newBtnYes.className = 'btn-primary';
        }
        
        newBtnYes.addEventListener('click', () => {
            confirmModal.classList.remove('active');
            onConfirm();
        });
        
        newBtnNo.addEventListener('click', () => {
            confirmModal.classList.remove('active');
        });
     }

    function showPrompt(title, message, defaultValue, onOk) {
        const promptModal = document.getElementById('prompt-modal');
        const promptTitle = document.getElementById('prompt-modal-title');
        const promptMessage = document.getElementById('prompt-modal-message');
        const promptInput = document.getElementById('prompt-modal-input');
        const btnOk = document.getElementById('btn-prompt-ok');
        const btnCancel = document.getElementById('btn-prompt-cancel');
        
        if (!promptModal || !promptTitle || !promptMessage || !promptInput || !btnOk || !btnCancel) return;
        
        promptTitle.textContent = title;
        
        if (message) {
            promptMessage.textContent = message;
            promptMessage.style.display = 'block';
            promptMessage.style.margin = '16px 0 12px 0';
        } else {
            promptMessage.textContent = '';
            promptMessage.style.display = 'none';
        }
        
        promptInput.value = defaultValue || '';
        
        if (title.toLowerCase().includes('device') || title.toLowerCase().includes('ip')) {
            promptInput.placeholder = 'WLED IP Address (e.g. 192.168.2.214)';
        } else if (title.toLowerCase().includes('profile')) {
            promptInput.placeholder = 'Profile name...';
        } else {
            promptInput.placeholder = 'Enter value...';
        }
        
        promptModal.classList.add('active');
        setTimeout(() => promptInput.focus(), 50);
        
        const newBtnOk = btnOk.cloneNode(true);
        const newBtnCancel = btnCancel.cloneNode(true);
        btnOk.parentNode.replaceChild(newBtnOk, btnOk);
        btnCancel.parentNode.replaceChild(newBtnCancel, btnCancel);
        
        const close = () => {
            promptModal.classList.remove('active');
        };
        
        newBtnOk.addEventListener('click', () => {
            const val = promptInput.value;
            close();
            onOk(val);
        });
        
        newBtnCancel.addEventListener('click', () => {
            close();
        });
        
        const onKeydown = (e) => {
            if (e.key === 'Enter') {
                newBtnOk.click();
            }
        };
        promptInput.removeEventListener('keydown', promptInput._kd || (() => {}));
        promptInput.addEventListener('keydown', onKeydown);
        promptInput._kd = onKeydown;
    }

    function hasUnsavedChanges() {
        const currentProfile = loadedConfig.current_profile || 'Default';
        
        // Find if this is a PWM White segment
        const activeDevice = getActiveDevice();
        let isPwm = false;
        if (activeDevice && activeSectionIdx >= 0) {
            const resolved = getSegmentByFlatIdx(activeDevice, activeSectionIdx);
            if (resolved && resolved.type === 41) {
                isPwm = true;
            }
        }
        const profileCat = isPwm ? 'pwm-white' : 'ws281x';
        const profileSettings = (loadedConfig.profiles && loadedConfig.profiles[profileCat] && loadedConfig.profiles[profileCat][currentProfile]) || {};
        
        let unsaved = false;
        
        for (const state of ALL_STATES) {
            const row = document.querySelector(`[data-state="${state}"]`);
            if (row) {
                const enabled = row.querySelector('.state-enabled-chk').checked;
                const durationInput = row.querySelector('.state-duration-input');
                const duration = durationInput ? parseFloat(durationInput.value) || 0 : 0;
                
                let fx = 0;
                let colVal = [255, 255, 255];
                
                const pwmSlider = row.querySelector('.state-pwm-bri-slider');
                if (pwmSlider) {
                    const briVal = parseInt(pwmSlider.value, 10);
                    colVal = [briVal, briVal, briVal, briVal];
                } else {
                    const fxSel = row.querySelector('.state-fx-sel');
                    fx = fxSel ? parseInt(fxSel.value, 10) : 0;
                    
                    const colorPick = row.querySelector('.state-color-pick');
                    if (colorPick) {
                        const hex = colorPick.value;
                        colVal = [
                            parseInt(hex.slice(1, 3), 16),
                            parseInt(hex.slice(3, 5), 16),
                            parseInt(hex.slice(5, 7), 16)
                        ];
                    }
                }
                
                const saved = profileSettings[state] || {
                    on: true,
                    bri: 255,
                    tt: 0,
                    enabled: true,
                    seg: { fx: 0, col: [isPwm ? [255, 255, 255, 255] : [255, 255, 255]] }
                };
                
                const savedEnabled = saved.enabled !== false;
                const savedFx = saved.seg?.fx || 0;
                const savedCol = saved.seg?.col?.[0] || (isPwm ? [255, 255, 255, 255] : [255, 255, 255]);
                const savedDuration = saved.duration || 0;
                
                let colorsMatch = true;
                if (colVal.length !== savedCol.length) {
                    colorsMatch = false;
                } else {
                    for (let i = 0; i < colVal.length; i++) {
                        if (colVal[i] !== savedCol[i]) {
                            colorsMatch = false;
                            break;
                        }
                    }
                }
                
                if (enabled !== savedEnabled ||
                    fx !== savedFx ||
                    !colorsMatch ||
                    duration !== savedDuration) {
                    unsaved = true;
                    break;
                }
            }
        }
        
        return unsaved;
    }

    function showUnsavedChangesModal(onSave, onDiscard) {
        const unsavedModal = document.getElementById('unsaved-modal');
        const btnSave = document.getElementById('btn-unsaved-save');
        const btnDiscard = document.getElementById('btn-unsaved-discard');
        const btnCancel = document.getElementById('btn-unsaved-cancel');
        
        if (!unsavedModal || !btnSave || !btnDiscard || !btnCancel) return;
        
        unsavedModal.classList.add('active');
        
        const newBtnSave = btnSave.cloneNode(true);
        const newBtnDiscard = btnDiscard.cloneNode(true);
        const newBtnCancel = btnCancel.cloneNode(true);
        btnSave.parentNode.replaceChild(newBtnSave, btnSave);
        btnDiscard.parentNode.replaceChild(newBtnDiscard, btnDiscard);
        btnCancel.parentNode.replaceChild(newBtnCancel, btnCancel);
        
        const close = () => {
            unsavedModal.classList.remove('active');
        };
        
        newBtnSave.addEventListener('click', () => {
            close();
            onSave();
        });
        
        newBtnDiscard.addEventListener('click', () => {
            close();
            onDiscard();
        });
        
        newBtnCancel.addEventListener('click', () => {
            close();
        });
    }

    async function checkWifiCapability() {
        try {
            const response = await fetch('/api/has_wifi');
            if (response.ok) {
                const data = await response.json();
                hasWifi = data.has_wifi;
            }
        } catch (err) {
            console.error("Error checking wifi capability:", err);
        }
    }

    const btnProfileManage = document.getElementById('btn-profile-manage');

    function isDeviceActive(device) {
        if (!device) return false;
        const connMatch = device.connection_type === 'serial' 
            ? (loadedConfig.connection_type === 'serial' && loadedConfig.manual_port === device.ip)
            : (loadedConfig.connection_type === 'wifi' && loadedConfig.wifi_ip === device.ip);
        
        const apiMatch = (!!loadedConfig.autodarts_online_enabled === (device.api_type === 'online')) &&
                         ((loadedConfig.autodarts_websocket_enabled !== false) === (device.api_type !== 'online'));
        
        return connMatch && apiMatch;
    }

    function switchScreen(screenName) {
        if (screenName === 'main') {
            screenMainMenu.style.display = 'flex';
            if (screenDevices) screenDevices.style.display = 'none';
        } else {
            screenMainMenu.style.display = 'none';
            if (screenDevices) screenDevices.style.display = 'flex';
        }
        // Show profile manager only on active device page
        if (btnProfileManage) {
            btnProfileManage.style.display = 'none';
        }
    }

    function navigateTo(path, push = true) {
        if (push) {
            window.history.pushState(null, '', path);
        } else {
            window.history.replaceState(null, '', path);
        }
        handleRouting();
    }

    function handleRouting(isInitial = false) {
        const path = window.location.pathname;

        // Clean up all modals first
        if (settingsModal) settingsModal.classList.remove('active');
        if (profileModal) profileModal.classList.remove('active');
        if (easySetupModal) easySetupModal.classList.remove('active');
        stopWsPolling(); // Clean up WLED settings websocket polling
        if (syncStatusInterval) {
            clearInterval(syncStatusInterval);
            syncStatusInterval = null;
        }

        if (path === '/setup') {
            navigateTo('/devices', false);
            return;
        } else if (path === '/') {
            navigateTo('/devices', false);
            return;
        } else if (path === '/menu') {
            if (!hasValidConfig()) {
                navigateTo('/devices', false);
                return;
            }
            switchScreen('main');
            // Initialize main menu screen inputs
            if (brightnessSlider) {
                brightnessSlider.value = Math.round((loadedConfig.global_brightness !== undefined ? loadedConfig.global_brightness : 255) * 100 / 255);
                brightnessVal.textContent = brightnessSlider.value + '%';
            }
            if (loadedConfig.connection_type === 'wifi') {
                fetchWledHwConfig();
            }
            renderStatesList();
        } else if (path === '/profile') {
            if (!hasValidConfig()) {
                navigateTo('/devices', false);
                return;
            }
            switchScreen('main');
            // Initialize main menu screen inputs
            if (brightnessSlider) {
                brightnessSlider.value = Math.round((loadedConfig.global_brightness !== undefined ? loadedConfig.global_brightness : 255) * 100 / 255);
                brightnessVal.textContent = brightnessSlider.value + '%';
            }
            if (loadedConfig.connection_type === 'wifi') {
                fetchWledHwConfig();
            }
            renderStatesList();

            // Open profile modal
            if (profileModal) {
                tempSelectedProfile = loadedConfig.current_profile || 'Default';
                profileModal.classList.add('active');
                updateProfileDropdown(tempSelectedProfile);
                if (btnProfileDelete) {
                    btnProfileDelete.disabled = (tempSelectedProfile === 'Default');
                }
                if (btnProfileRename) {
                    btnProfileRename.disabled = (tempSelectedProfile === 'Default');
                }
            }
        } else if (path === '/devices/scan') {
            switchScreen('devices');
            loadDevicesPage();
            startUnifiedScan(true);
            updateSyncStatuses();
            syncStatusInterval = setInterval(updateSyncStatuses, 3000);
        } else if (path === '/devices') {
            switchScreen('devices');
            loadDevicesPage();
            updateSyncStatuses();
            syncStatusInterval = setInterval(updateSyncStatuses, 3000);
        } else if (path.startsWith('/settings/')) {
            const devicename = decodeURIComponent(path.substring(10).replace(/\+/g, ' ')).trim();
            const device = devicesData.find(d => d.name && d.name.trim().toLowerCase() === devicename.toLowerCase());

            if (device) {
                switchScreen('devices');
                loadDevicesPage();
                updateSyncStatuses();
                syncStatusInterval = setInterval(updateSyncStatuses, 3000);

                // Open the specific accordion row
                setTimeout(() => {
                    const row = document.querySelector(`.device-row[data-device-id="${device.id}"]`);
                    if (row) {
                        const toggle = row.querySelector('.btn-device-accordion-toggle');
                        if (toggle && toggle.dataset.isOpen !== 'true') {
                            toggle.click();
                        }
                    }
                }, 150);
            } else {
                showToast(`Device "${devicename}" not found.`, 'error');
                navigateTo('/devices', false);
            }
         } else if (path.startsWith('/menu/')) {
            const parts = path.substring(6).split('/');
            const devicename = decodeURIComponent(parts[0].replace(/\+/g, ' ')).trim();
            const sectionStr = parts[1] ? decodeURIComponent(parts[1]).trim().toLowerCase() : '';
            
            let secIdx = -1;
            if (sectionStr.startsWith('section')) {
                const numStr = sectionStr.substring(7);
                const num = parseInt(numStr, 10);
                if (!isNaN(num)) {
                    secIdx = num - 1; // 0-indexed
                }
            }
            activeSectionIdx = secIdx;

            const device = devicesData.find(d => d.name && d.name.trim().toLowerCase() === devicename.toLowerCase());

            if (device) {
                const isActive = isDeviceActive(device);
                const applySectionProfile = () => {
                    const resolved = getSegmentByFlatIdx(device, secIdx);
                    if (resolved) {
                        const targetProfile = resolved.sub ? resolved.sub.profile : resolved.parent.profile;
                        loadedConfig.current_profile = targetProfile || 'Default';
                    }
                };

                if (isActive) {
                    applySectionProfile();
                    switchScreen('main');
                    if (brightnessSlider) {
                        brightnessSlider.value = Math.round((loadedConfig.global_brightness !== undefined ? loadedConfig.global_brightness : 255) * 100 / 255);
                        brightnessVal.textContent = brightnessSlider.value + '%';
                    }
                    if (loadedConfig.connection_type === 'wifi') {
                        fetchWledHwConfig();
                    }
                    renderStatesList();
                } else {
                    configureDevice(device, false).then(() => {
                        applySectionProfile();
                        switchScreen('main');
                        if (brightnessSlider) {
                            brightnessSlider.value = Math.round((loadedConfig.global_brightness !== undefined ? loadedConfig.global_brightness : 255) * 100 / 255);
                            brightnessVal.textContent = brightnessSlider.value + '%';
                        }
                        if (loadedConfig.connection_type === 'wifi') {
                            fetchWledHwConfig();
                        }
                        renderStatesList();
                    }).catch(err => {
                        console.error('Failed to configure device on route:', err);
                        navigateTo('/devices', false);
                    });
                }
            } else {
                showToast(`Device "${devicename}" not found.`, 'error');
                navigateTo('/devices', false);
            }
        } else {
            // Fallback for any other path
            navigateTo('/devices', false);
        }
    }

    window.addEventListener('popstate', () => handleRouting(false));

    // Fetch config and initialize UI
    async function loadConfig() {
        try {
            // 0. Check host wifi capability
            await checkWifiCapability();

            // 1. Fetch stored configuration settings
            const response = await fetch('/api/config');
            if (!response.ok) throw new Error('Network response was not ok');
            
            loadedConfig = await response.json();
            
            // Fetch devices list so it's populated for routing
            try {
                const devResponse = await fetch('/api/devices');
                if (devResponse.ok) {
                    devicesData = await devResponse.json();
                }
            } catch (err) {
                console.error('Error fetching devices on init:', err);
            }
            
            // Initialize profiles if missing
            if (!loadedConfig.profiles) {
                loadedConfig.profiles = { 'Default': {} };
            }
            if (!loadedConfig.current_profile) {
                loadedConfig.current_profile = 'Default';
            }
            updateProfileDropdown(loadedConfig.current_profile);

            // Trigger initial route resolution
            handleRouting(true);

        } catch (error) {
            console.error('Failed to load configuration:', error);
            showToast('Failed to load configuration from server.', 'error');
        }
    }

    function hasValidConfig() {
        const mode = loadedConfig.connection_type || 'serial';
        if (mode === 'serial') {
            const port = loadedConfig.manual_port || '';
            return port !== '' && port !== 'none';
        } else if (mode === 'wifi') {
            const ip = loadedConfig.wifi_ip || '';
            return ip.trim() !== '';
        }
        return false;
    }



    if (btnSettingsCancel) {
        btnSettingsCancel.addEventListener('click', () => {
            if (window.location.pathname.startsWith('/settings/')) {
                navigateTo('/devices');
            } else {
                settingsModal.classList.remove('active');
            }
        });
    }

    // Duplicate saveSettingsMenu listener removed. Settings modal handles its own save.

    // --- Autodarts WebSocket LED probe ---
    let _wsProbeTimer = null;

    function setWsLed(state) {
        if (!wsLed) return;
        wsLed.className = 'ws-led ws-led--' + state;
    }

    function checkAutodartsWs() {
        setWsLed('checking');
        let done = false;
        let ws;
        try {
            ws = new WebSocket('ws://localhost:3180/api/events');
        } catch (e) {
            setWsLed('disconnected');
            return;
        }
        const timeout = setTimeout(() => {
            if (!done) { done = true; ws.close(); setWsLed('disconnected'); }
        }, 3000);
        ws.onopen = () => {
            if (!done) { done = true; clearTimeout(timeout); setWsLed('connected'); ws.close(); }
        };
        ws.onerror = () => {
            if (!done) { done = true; clearTimeout(timeout); setWsLed('disconnected'); }
        };
    }

    function startWsPolling() {
        if (localBoardApiToggle && !localBoardApiToggle.checked) {
            setWsLed('disabled');
            return;
        }
        checkAutodartsWs();
        _wsProbeTimer = setInterval(checkAutodartsWs, 5000);
    }

    function stopWsPolling() {
        clearInterval(_wsProbeTimer);
        _wsProbeTimer = null;
    }

    function updateOnlineWsLed() {
        if (!onlineWsLed) return;
        if (onlineBoardApiToggle && onlineBoardApiToggle.checked) {
            onlineWsLed.className = 'ws-led ws-led--connected';
        } else {
            onlineWsLed.className = 'ws-led ws-led--disabled';
        }
    }

    function syncSegmentedControl() {
        const seg = document.getElementById('api-mode-segmented');
        if (!seg) return;
        const slider = seg.querySelector('.segment-slider');
        const btns = seg.querySelectorAll('.segment-btn');
        let activeValue = 'disabled';
        if (localBoardApiToggle && localBoardApiToggle.checked) {
            activeValue = 'local';
        } else if (onlineBoardApiToggle && onlineBoardApiToggle.checked) {
            activeValue = 'online';
        }
        
        btns.forEach((btn, idx) => {
            if (btn.getAttribute('data-value') === activeValue) {
                btn.classList.add('active');
                if (slider) {
                    slider.style.left = `calc(${idx * 33.333}% + 4px)`;
                }
            } else {
                btn.classList.remove('active');
            }
        });
    }

    if (localBoardApiToggle) {
        localBoardApiToggle.addEventListener('change', () => {
            stopWsPolling();
            if (localBoardApiToggle.checked) {
                if (onlineBoardApiToggle) {
                    onlineBoardApiToggle.checked = false;
                    updateOnlineWsLed();
                }
                startWsPolling();
            } else {
                setWsLed('disabled');
            }
            syncSegmentedControl();
        });
    }

    if (onlineBoardApiToggle) {
        onlineBoardApiToggle.addEventListener('change', () => {
            if (onlineBoardApiToggle.checked) {
                const isLinked = autodartsAuthBadge && autodartsAuthBadge.classList.contains('auth-badge--connected');
                if (!isLinked) {
                    showToast('Online Board API requires an active Autodarts account link.', 'error');
                    onlineBoardApiToggle.checked = false;
                    syncSegmentedControl();
                    return;
                }
                if (localBoardApiToggle) {
                    localBoardApiToggle.checked = false;
                    stopWsPolling();
                    setWsLed('disabled');
                }
            }
            updateOnlineWsLed();
            // Live-update the lock state of online-exclusive effect rows
            loadedConfig.autodarts_online_enabled = onlineBoardApiToggle.checked;
            updateOnlineStateLocks();
            syncSegmentedControl();
        });
    }

    // Bind click events on segmented control
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('#api-mode-segmented .segment-btn');
        if (!btn) return;
        const val = btn.getAttribute('data-value');
        
        const isLocalChecked = localBoardApiToggle && localBoardApiToggle.checked;
        const isOnlineChecked = onlineBoardApiToggle && onlineBoardApiToggle.checked;
        
        if (val === 'local') {
            if (!isLocalChecked) {
                if (localBoardApiToggle) {
                    localBoardApiToggle.checked = true;
                    localBoardApiToggle.dispatchEvent(new Event('change'));
                }
            }
        } else if (val === 'online') {
            if (!isOnlineChecked) {
                if (onlineBoardApiToggle) {
                    onlineBoardApiToggle.checked = true;
                    onlineBoardApiToggle.dispatchEvent(new Event('change'));
                }
            }
        } else {
            // "disabled"
            if (isLocalChecked) {
                if (localBoardApiToggle) {
                    localBoardApiToggle.checked = false;
                    localBoardApiToggle.dispatchEvent(new Event('change'));
                }
            }
            if (isOnlineChecked) {
                if (onlineBoardApiToggle) {
                    onlineBoardApiToggle.checked = false;
                    onlineBoardApiToggle.dispatchEvent(new Event('change'));
                }
            }
            syncSegmentedControl();
        }
    });
    // --- end WS probe ---

    async function checkAutodartsAuthStatus() {
        if (!autodartsAuthBadge) return;
        
        const isCurrentlyConnected = autodartsAuthBadge.classList.contains('auth-badge--connected');
        const isCurrentlyDisconnected = autodartsAuthBadge.classList.contains('auth-badge--disconnected');
        
        if (!isCurrentlyConnected && !isCurrentlyDisconnected) {
            autodartsAuthBadge.textContent = 'Checking...';
            autodartsAuthBadge.className = 'auth-badge auth-badge--loading';
        }
        
        try {
            const response = await fetch('/api/auth/autodarts');
            if (!response.ok) throw new Error('Failed to fetch auth status');
            const data = await response.json();
            
            if (data.connected) {
                autodartsAuthBadge.textContent = 'Linked';
                autodartsAuthBadge.className = 'auth-badge auth-badge--connected';
                
                autodartsProfileName.textContent = data.name || data.username || 'Linked User';
                autodartsProfileEmail.textContent = data.email || '';
                
                // Update avatar with first letter of username/name
                const initial = (data.name || data.username || 'U')[0].toUpperCase();
                autodartsAvatar.textContent = initial;
                
                autodartsAuthForm.style.display = 'none';
                autodartsAuthStatus.style.display = 'flex';
            } else {
                autodartsAuthBadge.textContent = 'Disconnected';
                autodartsAuthBadge.className = 'auth-badge auth-badge--disconnected';
                
                autodartsAuthForm.style.display = 'flex';
                autodartsAuthStatus.style.display = 'none';
            }
        } catch (err) {
            console.error('Error checking Autodarts auth status:', err);
            autodartsAuthBadge.textContent = 'Disconnected';
            autodartsAuthBadge.className = 'auth-badge auth-badge--disconnected';
            autodartsAuthForm.style.display = 'flex';
            autodartsAuthStatus.style.display = 'none';
        }
    }

    async function linkAutodartsAccount() {
        const email = autodartsEmailInput.value.trim();
        const password = autodartsPasswordInput.value;
        
        if (!email || !password) {
            showToast('Please enter both email/username and password.', 'error');
            return;
        }
        
        btnAutodartsLink.classList.add('loading');
        btnAutodartsLink.disabled = true;
        autodartsAuthBadge.textContent = 'Linking...';
        autodartsAuthBadge.className = 'auth-badge auth-badge--loading';
        
        try {
            const response = await fetch('/api/auth/autodarts', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ email, password })
            });
            
            if (!response.ok) throw new Error('API call failed');
            const data = await response.json();
            
            if (data.status === 'success') {
                showToast('Successfully linked Autodarts account!', 'success');
                autodartsPasswordInput.value = '';
                await checkAutodartsAuthStatus();
            } else {
                throw new Error(data.message || 'Login failed');
            }
        } catch (err) {
            console.error('Error linking Autodarts account:', err);
            showToast(err.message || 'Failed to link account. Please verify credentials.', 'error');
            autodartsAuthBadge.textContent = 'Disconnected';
            autodartsAuthBadge.className = 'auth-badge auth-badge--disconnected';
        } finally {
            btnAutodartsLink.classList.remove('loading');
            btnAutodartsLink.disabled = false;
        }
    }

    function disconnectAutodartsAccount() {
        showConfirm('Disconnect Account', 'Are you sure you want to disconnect your Autodarts account?', 'Yes, Disconnect', async () => {
            btnAutodartsDisconnect.disabled = true;
            autodartsAuthBadge.textContent = 'Disconnecting...';
            autodartsAuthBadge.className = 'auth-badge auth-badge--loading';
            
            try {
                const response = await fetch('/api/auth/autodarts/disconnect', {
                    method: 'POST'
                });
                
                if (!response.ok) throw new Error('API call failed');
                const data = await response.json();
                
                if (data.status === 'success') {
                    showToast('Successfully disconnected Autodarts account.', 'success');
                    autodartsEmailInput.value = '';
                    autodartsPasswordInput.value = '';
                    if (onlineBoardApiToggle && onlineBoardApiToggle.checked) {
                        onlineBoardApiToggle.checked = false;
                        updateOnlineWsLed();
                    }
                    await checkAutodartsAuthStatus();
                } else {
                    throw new Error(data.message || 'Disconnect failed');
                }
            } catch (err) {
                console.error('Error disconnecting Autodarts account:', err);
                showToast(err.message || 'Failed to disconnect account.', 'error');
                await checkAutodartsAuthStatus();
            } finally {
                btnAutodartsDisconnect.disabled = false;
            }
        }, true);
    }

    if (btnAutodartsLink) {
        btnAutodartsLink.addEventListener('click', linkAutodartsAccount);
    }
    if (btnAutodartsDisconnect) {
        btnAutodartsDisconnect.addEventListener('click', disconnectAutodartsAccount);
    }

    function getTypeDropdownOptions(typeVal) {
        let html = '';
        html += `<option value="22" ${typeVal === 22 ? 'selected' : ''}>WS281x</option>`;
        html += `<option value="41" ${typeVal === 41 ? 'selected' : ''}>PWM White</option>`;
        if (typeVal !== 22 && typeVal !== 41) {
            const otherLabels = {
                30: 'SK6812 RGBW',
                42: 'PWM RGB',
                43: 'PWM RGBW',
                44: 'PWM WY',
                45: 'PWM RGB+CCT'
            };
            const label = otherLabels[typeVal] || `Other (${typeVal})`;
            html += `<option value="${typeVal}" selected>${label}</option>`;
        }
        return html;
    }

    function renderSegmentRow(seg = {}) {
        const pin = seg.pin !== undefined ? seg.pin : 16;
        const len = seg.len !== undefined ? seg.len : 60;
        const bootOn = seg.boot_on !== false;
        const segProfile = seg.profile || 'Default';
        const typeVal = seg.type !== undefined ? parseInt(seg.type, 10) : 22;

        const row = document.createElement('div');
        row.className = 'wled-segment-row';
        row.style.cssText = 'background: rgba(255, 255, 255, 0.015); border: 1px solid var(--input-border); padding: 12px; border-radius: var(--radius-sm); display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px;';
        
        const profileNames = Object.keys(loadedConfig.profiles || { 'Default': {} });
        const profileOptions = profileNames.map(pName => 
            `<option value="${pName}" ${pName === segProfile ? 'selected' : ''}>${pName}</option>`
        ).join('');

        row.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <span class="segment-title-label" style="font-size: 11px; font-weight: 600; color: var(--text-secondary);">Strip / Section</span>
                <button type="button" class="btn-wled-remove-segment" style="background: transparent; border: 0; color: var(--accent-red); font-size: 11px; cursor: pointer; padding: 2px 6px; border-radius: 4px; font-weight: 600;">Delete</button>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr 1.5fr 1.5fr; gap: 10px;">
                <div class="form-group" style="margin-bottom: 0;">
                    <label style="font-size: 10px; margin-bottom: 4px; color: var(--text-secondary); display: block;">GPIO Pin</label>
                    <input type="number" class="wled-segment-pin" placeholder="16" min="0" max="39" value="${pin}" style="width: 100%; height: 32px; font-size: 12px; padding: 0 6px; background: var(--input-bg); border: 1px solid var(--input-border); border-radius: var(--radius-sm); color: var(--text-primary);">
                </div>
                <div class="form-group" style="margin-bottom: 0;">
                    <label style="font-size: 10px; margin-bottom: 4px; color: var(--text-secondary); display: block;">LEDs</label>
                    <input type="number" class="wled-segment-len" placeholder="60" min="1" max="1000" value="${len}" style="width: 100%; height: 32px; font-size: 12px; padding: 0 6px; background: var(--input-bg); border: 1px solid var(--input-border); border-radius: var(--radius-sm); color: var(--text-primary);">
                </div>
                <div class="form-group" style="margin-bottom: 0;">
                    <label style="font-size: 10px; margin-bottom: 4px; color: var(--text-secondary); display: block;">Strip Type</label>
                    <select class="wled-segment-type" style="width: 100%; height: 32px; font-size: 12px; padding: 0 6px; background: var(--input-bg); border: 1px solid var(--input-border); border-radius: var(--radius-sm); color: var(--text-primary); outline: none;">
                        ${getTypeDropdownOptions(typeVal)}
                    </select>
                </div>
                <div class="form-group" style="margin-bottom: 0;">
                    <label style="font-size: 10px; margin-bottom: 4px; color: var(--text-secondary); display: block;">Profile</label>
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <select class="wled-segment-profile" style="width: 100%; height: 32px; font-size: 12px; padding: 0 6px; background: var(--input-bg); border: 1px solid var(--input-border); border-radius: var(--radius-sm); color: var(--text-primary); outline: none;">
                            ${profileOptions}
                        </select>
                        <button type="button" class="btn-edit-segment-profile" style="height: 32px; width: 32px; display: inline-flex; align-items: center; justify-content: center; background: var(--input-bg); border: 1px solid var(--input-border); border-radius: var(--radius-sm); color: var(--text-secondary); border: 1px solid var(--input-border); cursor: pointer;" title="Configure Lighting Profile Details">
                            <svg class="icon" style="margin: 0; stroke: currentColor; width: 13px; height: 13px;" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
                        </button>
                    </div>
                </div>
            </div>
            <div class="form-group toggle-row" style="margin-bottom: 0; margin-top: 4px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <label style="margin-bottom: 0; font-size: 11px; font-weight: 500;">Turn LEDs on after power up</label>
                    <label class="toggle-switch">
                        <input type="checkbox" class="wled-segment-boot-on" ${bootOn ? 'checked' : ''}>
                        <span class="toggle-slider"></span>
                    </label>
                </div>
            </div>
        `;

        // Bind delete button
        const btnDelete = row.querySelector('.btn-wled-remove-segment');
        btnDelete.addEventListener('click', () => {
            row.remove();
            updateSegmentLabels();
        });

        const typeSelect = row.querySelector('.wled-segment-type');
        const lenInput = row.querySelector('.wled-segment-len');
        function updateLenDisabled() {
            if (parseInt(typeSelect.value, 10) === 41) {
                lenInput.value = 1;
                lenInput.disabled = true;
            } else {
                lenInput.disabled = false;
            }
        }
        typeSelect.addEventListener('change', updateLenDisabled);
        updateLenDisabled();

        wledSegmentsList.appendChild(row);
        updateSegmentLabels();
    }

    function updateSegmentLabels() {
        const rows = wledSegmentsList.querySelectorAll('.wled-segment-row');
        rows.forEach((row, idx) => {
            const label = row.querySelector('.segment-title-label');
            if (label) {
                label.textContent = `Strip / Section #${idx + 1}`;
            }

            const btnEdit = row.querySelector('.btn-edit-segment-profile');
            if (btnEdit) {
                const activeDevice = getActiveDevice();
                if (activeDevice && activeDevice.name) {
                    btnEdit.style.display = 'inline-flex';
                    btnEdit.onclick = () => {
                        easySetupModal.classList.remove('active');
                        navigateTo('/menu/' + encodeURIComponent(activeDevice.name).replace(/%20/g, '+') + '/section' + (idx + 1));
                    };
                } else {
                    btnEdit.style.display = 'none';
                }
            }
        });
    }

    if (btnWledAddSegment) {
        btnWledAddSegment.addEventListener('click', () => {
            renderSegmentRow({ pin: 16, len: 60, boot_on: true });
        });
    }

    async function fetchWledHwConfig() {
        wledSegmentsList.innerHTML = '<div style="font-size:12px; color:var(--text-secondary);">Fetching configuration...</div>';
        
        try {
            const response = await fetch('/api/wled/config');
            if (!response.ok) throw new Error('Failed to fetch WLED hardware settings');
            const data = await response.json();
            
            wledSegmentsList.innerHTML = '';
            if (data.status === 'success' && data.segments && data.segments.length > 0) {
                data.segments.forEach(seg => {
                    renderSegmentRow(seg);
                });
            } else {
                // Fallback default
                renderSegmentRow({ pin: 16, len: 60, boot_on: true });
            }
        } catch (err) {
            console.error(err);
            showToast(err.message || 'Unable to fetch WLED hardware settings.', 'error');
            wledSegmentsList.innerHTML = '<div style="font-size:12px; color:var(--accent-red);">Error loading settings.</div>';
        }
    }

    async function saveSettingsMenu() {
        if (btnSettingsSave) {
            btnSettingsSave.classList.add('loading');
            btnSettingsSave.disabled = true;
        }
        
        const mode = loadedConfig.connection_type || 'serial';
        const brightness = brightnessSlider ? Math.round(parseInt(brightnessSlider.value, 10) * 255 / 100) : (loadedConfig.global_brightness !== undefined ? loadedConfig.global_brightness : 255);
        const crossfadeEnabled = crossfadeToggle ? crossfadeToggle.checked : true;
        const localBoardApiEnabled = localBoardApiToggle ? localBoardApiToggle.checked : true;
        const onlineBoardApiEnabled = onlineBoardApiToggle ? onlineBoardApiToggle.checked : false;
        
        // Find which device matches the current active connection to update its api_type in devices database
        const activeDevice = getActiveDevice();
        
        const payload = {
            connection_type: mode,
            global_brightness: brightness,
            wled_crossfade: crossfadeEnabled,
            autodarts_websocket_enabled: localBoardApiEnabled,
            autodarts_online_enabled: onlineBoardApiEnabled
        };
        
        try {
            // 1. Save general config
            const response = await fetch('/api/config', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });
            
            if (!response.ok) throw new Error('Failed to update config settings');
            const result = await response.json();
            if (result.status !== 'success') throw new Error(result.message);
            
            // Update local config variables
            loadedConfig.connection_type = mode;
            loadedConfig.global_brightness = brightness;
            loadedConfig.wled_crossfade = crossfadeEnabled;
            loadedConfig.autodarts_websocket_enabled = localBoardApiEnabled;
            loadedConfig.autodarts_online_enabled = onlineBoardApiEnabled;
            
            // Update device api_type in devices database
            if (activeDevice) {
                let newApiType = 'disabled';
                if (onlineBoardApiEnabled) {
                    newApiType = 'online';
                } else if (localBoardApiEnabled) {
                    newApiType = 'local';
                }
                const devResp = await fetch(`/api/devices/${activeDevice.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ api_type: newApiType })
                });
                if (devResp.ok) {
                    const devResult = await devResp.json();
                    if (devResult.status === 'success') {
                        activeDevice.api_type = newApiType;
                    }
                }
            }
            
            // 2. Save WLED hardware config + crossfade together in one atomic round-trip,
            //    before the reboot, so both settings are preserved on the device.
            if (mode === 'wifi') {
                const segmentRows = wledSegmentsList.querySelectorAll('.wled-segment-row');
                const segments = [];
                
                segmentRows.forEach(row => {
                    const pinVal = parseInt(row.querySelector('.wled-segment-pin').value, 10);
                    const lenVal = parseInt(row.querySelector('.wled-segment-len').value, 10);
                    const typeVal = parseInt(row.querySelector('.wled-segment-type').value, 10);
                    const profileVal = row.querySelector('.wled-segment-profile').value;
                    const bootOnVal = row.querySelector('.wled-segment-boot-on').checked;
                    
                    if (!isNaN(pinVal) && !isNaN(lenVal)) {
                        segments.push({
                            pin: pinVal,
                            len: lenVal,
                            type: typeVal,
                            profile: profileVal,
                            boot_on: bootOnVal
                        });
                    }
                });
                
                if (segments.length === 0) {
                    throw new Error('Please configure at least one strip / section.');
                }
                
                const hwResponse = await fetch('/api/wled/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ segments, crossfade: crossfadeEnabled })
                });
                
                if (!hwResponse.ok) throw new Error('Failed to save WLED hardware settings');
                const hwResult = await hwResponse.json();
                if (hwResult.status !== 'success') throw new Error(hwResult.message);
                
                if (activeDevice) {
                    activeDevice.segments = segments;
                }
            }
            
            showToast('Settings saved successfully!', 'success');
            if (window.location.pathname.startsWith('/settings/')) {
                navigateTo('/devices');
            } else {
                navigateTo('/menu');
            }

            
        } catch (err) {
            console.error('Save settings failed:', err);
            showToast(err.message || 'Failed to save settings.', 'error');
        } finally {
            if (btnSettingsSave) {
                btnSettingsSave.classList.remove('loading');
                btnSettingsSave.disabled = false;
            }
        }
    }

    // Modal segmented control bindings removed (Connection Mode moved to segment level)

    const modalBrightnessSlider = document.getElementById('settings-brightness-slider');
    const modalBrightnessVal = document.getElementById('settings-brightness-val');
    if (modalBrightnessSlider && modalBrightnessVal) {
        modalBrightnessSlider.addEventListener('input', () => {
            modalBrightnessVal.textContent = modalBrightnessSlider.value + '%';
        });
    }

    const modalCrossfadeToggle = document.getElementById('settings-crossfade-toggle');
    const modalBootOnToggle = document.getElementById('settings-booton-toggle');
    const modalLocalLed = document.getElementById('settings-ws-local');
    const modalOnlineLed = document.getElementById('settings-ws-online');

    // Settings Cancel listener consolidated above

    async function openSettingsModal(device, rowEl) {
        if (!settingsModal) return;
        settingsModal.classList.add('active');
        
        const btnSaveText = btnSettingsSave.querySelector('.btn-text');
        btnSaveText.textContent = 'Loading...';
        btnSettingsSave.disabled = true;
        
        try {
            const response = await fetch(`/api/wled/config?ip=${encodeURIComponent(device.ip || '')}`);
            if (!response.ok) throw new Error('Failed to fetch config');
            const wledData = await response.json();
            
            // API buttons display logic removed
            
            if (device.connection_type === 'serial') {
                if (modalLocalLed) modalLocalLed.className = 'ws-led ws-led--connected';
            } else {
                if (modalLocalLed) {
                    modalLocalLed.className = 'ws-led ws-led--checking';
                    let ws = new WebSocket('ws://localhost:3180/api/events');
                    const timeout = setTimeout(() => {
                        ws.close();
                        modalLocalLed.className = 'ws-led ws-led--disconnected';
                    }, 1000);
                    ws.onopen = () => {
                        clearTimeout(timeout);
                        ws.close();
                        modalLocalLed.className = 'ws-led ws-led--connected';
                    };
                    ws.onerror = () => {
                        clearTimeout(timeout);
                        modalLocalLed.className = 'ws-led ws-led--disconnected';
                    };
                }
            }
            if (modalOnlineLed) {
                modalOnlineLed.className = wledData.autodarts_online_enabled ? 'ws-led ws-led--connected' : 'ws-led ws-led--disabled';
            }
            
            const brightnessValInt = wledData.global_brightness !== undefined ? wledData.global_brightness : 255;
            modalBrightnessSlider.value = Math.round(brightnessValInt * 100 / 255);
            modalBrightnessVal.textContent = modalBrightnessSlider.value + '%';
            
            modalCrossfadeToggle.checked = wledData.wled_crossfade !== false;
            if (modalBootOnToggle) {
                modalBootOnToggle.checked = wledData.boot_on !== false;
            }
            
            btnSaveText.textContent = 'Save Changes';
            btnSettingsSave.disabled = false;
            
            btnSettingsSave.onclick = async () => {
                btnSaveText.textContent = 'Saving...';
                btnSettingsSave.disabled = true;
                try {
                    
                    // 2. Save global config
                    const brightnessValIntNew = Math.round(parseInt(modalBrightnessSlider.value, 10) * 255 / 100);
                    const crossfadeValNew = modalCrossfadeToggle.checked;
                    
                    const genResp = await fetch('/api/config', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            connection_type: device.connection_type || 'wifi',
                            global_brightness: brightnessValIntNew,
                            wled_crossfade: crossfadeValNew
                        })
                    });
                    if (!genResp.ok) throw new Error('Failed to save global configurations');
                    
                    loadedConfig.global_brightness = brightnessValIntNew;
                    loadedConfig.wled_crossfade = crossfadeValNew;
                    
                    // 3. Write Crossfade setting and boot state to WLED controller
                    const bootOnValNew = modalBootOnToggle ? modalBootOnToggle.checked : true;
                    const hwResponse = await fetch('/api/wled/config', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ip: device.ip, crossfade: crossfadeValNew, boot_on: bootOnValNew })
                    });
                    if (!hwResponse.ok) throw new Error('Failed to save WLED hardware settings');
                    const hwResult = await hwResponse.json();
                    if (hwResult.status !== 'success') throw new Error(hwResult.message);
                    
                    showToast('Settings saved successfully & WLED updated!', 'success');
                    settingsModal.classList.remove('active');
                } catch (err) {
                    console.error(err);
                    showToast(err.message || 'Failed to save settings.', 'error');
                } finally {
                    btnSaveText.textContent = 'Save Changes';
                    btnSettingsSave.disabled = false;
                }
            };
            
        } catch (err) {
            console.error(err);
            showToast('Failed to load settings.', 'error');
            settingsModal.classList.remove('active');
        }
    }

    // Brightness Slider input event
    if (brightnessSlider && brightnessVal) {
        brightnessSlider.addEventListener('input', () => {
            brightnessVal.textContent = brightnessSlider.value + '%';
        });
    }

    // Render profile states list
    // Helper: build the expandable settings panel for a state row
    function buildSettingsPanel(settings) {
        const duration = settings.duration || 0;

        const panel = document.createElement('div');
        panel.className = 'state-settings-panel';

        const inner = document.createElement('div');
        inner.className = 'state-settings-panel-inner';

        const content = document.createElement('div');
        content.className = 'state-settings-content';

        const settingRow = document.createElement('div');
        settingRow.className = 'state-setting-row';

        const label = document.createElement('span');
        label.className = 'state-setting-label';
        label.textContent = 'Active for';

        const inputGroup = document.createElement('div');
        inputGroup.className = 'state-setting-input-group';

        const durationInput = document.createElement('input');
        durationInput.type = 'number';
        durationInput.className = 'state-duration-input';
        durationInput.min = '0';
        durationInput.step = '0.5';
        durationInput.value = duration > 0 ? duration : '';
        durationInput.placeholder = '0';

        const unit = document.createElement('span');
        unit.className = 'state-setting-unit';
        unit.textContent = 'seconds';

        inputGroup.appendChild(durationInput);
        inputGroup.appendChild(unit);
        settingRow.appendChild(label);
        settingRow.appendChild(inputGroup);
        content.appendChild(settingRow);
        inner.appendChild(content);
        panel.appendChild(inner);

        return panel;
    }

    function renderStatesList() {
        statesListContainer.innerHTML = '';
        statesListContainer.style.marginTop = '0px';
        
        const currentProfile = loadedConfig.current_profile || 'Default';
        const activeDevice = getActiveDevice();
        let isPwm = false;
        if (activeDevice && activeSectionIdx >= 0) {
            const resolved = getSegmentByFlatIdx(activeDevice, activeSectionIdx);
            if (resolved && resolved.type === 41) {
                isPwm = true;
            }
        }
        const profileCat = isPwm ? 'pwm-white' : 'ws281x';
        const profileSettings = (loadedConfig.profiles && loadedConfig.profiles[profileCat] && loadedConfig.profiles[profileCat][currentProfile]) || {};
        
        // --- Group wrapper to bypass parent flex gap ---
        const profileHeaderGroup = document.createElement('div');
        profileHeaderGroup.style.display = 'flex';
        profileHeaderGroup.style.flexDirection = 'column';
        profileHeaderGroup.style.gap = '8px';
        profileHeaderGroup.style.marginBottom = '-6px'; // overrides parent 14px gap to leave 8px spacing below separator
        
        // --- Minimalistic Inline Profile Manager Row ---
        const profileRow = document.createElement('div');
        profileRow.className = 'profile-row-container';
        profileRow.style.display = 'flex';
        profileRow.style.alignItems = 'center';
        profileRow.style.justifyContent = 'space-between';
        profileRow.style.gap = '12px';
        profileRow.style.background = 'rgba(255, 255, 255, 0.02)';
        profileRow.style.border = '1px solid var(--input-border)';
        profileRow.style.padding = '12px 14px';
        profileRow.style.borderRadius = 'var(--radius-md)';
        
        profileRow.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px; flex: 1;">
                <span style="font-size: 13px; font-weight: 600; color: var(--text-secondary); white-space: nowrap;">Profile:</span>
                <div class="select-wrapper" style="flex: 1; max-width: 180px;">
                    <select id="menu-profile-select" style="height: 32px; padding: 0 24px 0 10px; font-size: 12px; width: 100%;">
                    </select>
                </div>
            </div>
            <div style="display: flex; gap: 6px;">
                <button type="button" id="btn-menu-profile-rename" class="btn-secondary" style="width: 32px; height: 32px; padding: 0; display: flex; justify-content: center; align-items: center; border-radius: var(--radius-sm);" title="Rename Profile"><svg class="icon" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button>
                <button type="button" id="btn-menu-profile-create" class="btn-primary" style="width: 32px; height: 32px; padding: 0; display: flex; justify-content: center; align-items: center; border-radius: var(--radius-sm);" title="Add New Profile"><svg class="icon" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
                <button type="button" id="btn-menu-profile-delete" class="btn-danger" style="width: 32px; height: 32px; padding: 0; display: flex; justify-content: center; align-items: center; border-radius: var(--radius-sm);" title="Delete Profile"><svg class="icon icon-delete" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>
            </div>
        `;
        profileHeaderGroup.appendChild(profileRow);
        
        // --- Separator Line ---
        const profileSeparator = document.createElement('div');
        profileSeparator.style.borderBottom = '1px solid var(--input-border)';
        profileSeparator.style.margin = '0';
        profileHeaderGroup.appendChild(profileSeparator);
        
        statesListContainer.appendChild(profileHeaderGroup);
        
        const menuProfileSelect = profileRow.querySelector('#menu-profile-select');
        const btnMenuProfileRename = profileRow.querySelector('#btn-menu-profile-rename');
        const btnMenuProfileCreate = profileRow.querySelector('#btn-menu-profile-create');
        const btnMenuProfileDelete = profileRow.querySelector('#btn-menu-profile-delete');
        
        const profileMapForCat = (loadedConfig.profiles && loadedConfig.profiles[profileCat]) || { 'Default': {} };
        const profileNames = Object.keys(profileMapForCat);
        profileNames.forEach(pName => {
            const opt = document.createElement('option');
            opt.value = pName;
            opt.textContent = pName;
            opt.selected = (pName === currentProfile);
            menuProfileSelect.appendChild(opt);
        });
        
        btnMenuProfileDelete.disabled = (currentProfile === 'Default');
        btnMenuProfileRename.disabled = (currentProfile === 'Default');
        
        menuProfileSelect.addEventListener('change', async () => {
            const newProfile = menuProfileSelect.value;
            if (hasUnsavedChanges()) {
                // Revert dropdown visual selection back to the current active profile first
                menuProfileSelect.value = currentProfile;
                
                showUnsavedChangesModal(
                    async () => {
                        // Save changes, then switch profile
                        loadedConfig.current_profile = currentProfile;
                        await saveAllSettings();
                        
                        await updateActiveProfile(newProfile);
                        renderStatesList();
                        showToast(`Profile set to "${newProfile}"`, 'success');
                    },
                    () => {
                        // Discard changes, switch profile
                        updateActiveProfile(newProfile).then(() => {
                            renderStatesList();
                            showToast(`Profile set to "${newProfile}"`, 'success');
                        });
                    }
                );
            } else {
                await updateActiveProfile(newProfile);
                renderStatesList();
                showToast(`Profile set to "${newProfile}"`, 'success');
            }
        });
        
        btnMenuProfileCreate.addEventListener('click', () => {
            showPrompt("New Profile", "", "", async (newName) => {
                if (!newName) return;
                const trimmedName = newName.trim();
                if (!trimmedName) {
                    showToast('Please enter a valid profile name', 'error');
                    return;
                }
                if (loadedConfig.profiles && loadedConfig.profiles[profileCat] && loadedConfig.profiles[profileCat][trimmedName]) {
                    showToast('Profile name already exists', 'error');
                    return;
                }
                
                const currentSettings = JSON.parse(JSON.stringify(
                    (loadedConfig.profiles && loadedConfig.profiles[profileCat] && loadedConfig.profiles[profileCat][currentProfile]) || {}
                ));
                
                if (!loadedConfig.profiles) loadedConfig.profiles = { "ws281x": {}, "pwm-white": {} };
                if (!loadedConfig.profiles[profileCat]) loadedConfig.profiles[profileCat] = {};
                loadedConfig.profiles[profileCat][trimmedName] = currentSettings;
                await updateActiveProfile(trimmedName);
                
                await saveAllSettings();
                renderStatesList();
                showToast(`Profile "${trimmedName}" created!`, 'success');
            });
        });
        
        btnMenuProfileRename.addEventListener('click', () => {
            if (currentProfile === 'Default') {
                showToast('Cannot rename the Default profile', 'error');
                return;
            }
            showPrompt("Rename Profile", "", currentProfile, async (newName) => {
                if (!newName) return;
                const trimmedName = newName.trim();
                if (!trimmedName) {
                    showToast('Please enter a valid profile name', 'error');
                    return;
                }
                if (trimmedName === currentProfile) return;
                if (loadedConfig.profiles && loadedConfig.profiles[profileCat] && loadedConfig.profiles[profileCat][trimmedName]) {
                    showToast('Profile name already exists', 'error');
                    return;
                }
                
                if (!loadedConfig.profiles[profileCat]) loadedConfig.profiles[profileCat] = {};
                loadedConfig.profiles[profileCat][trimmedName] = loadedConfig.profiles[profileCat][currentProfile];
                delete loadedConfig.profiles[profileCat][currentProfile];
                await updateActiveProfile(trimmedName);
                
                await saveAllSettings();
                renderStatesList();
                showToast(`Profile renamed to "${trimmedName}"`, 'success');
            });
        });
        
        btnMenuProfileDelete.addEventListener('click', () => {
            if (currentProfile === 'Default') {
                showToast('Cannot delete the Default profile', 'error');
                return;
            }
            showConfirm('Delete Profile', `Are you sure you want to delete profile "${currentProfile}"?`, 'Yes, Delete', async () => {
                if (loadedConfig.profiles && loadedConfig.profiles[profileCat]) {
                    delete loadedConfig.profiles[profileCat][currentProfile];
                }
                await updateActiveProfile('Default');
                await saveAllSettings();
                renderStatesList();
                showToast(`Profile "${currentProfile}" deleted`, 'success');
            }, true);
        });
        
        const sortedStates = [...DARTBOARD_STATES].sort((a, b) => {
            const aEnabled = profileSettings[a]?.enabled !== false;
            const bEnabled = profileSettings[b]?.enabled !== false;
            if (aEnabled && !bEnabled) return -1;
            if (!aEnabled && bEnabled) return 1;
            return DARTBOARD_STATES.indexOf(a) - DARTBOARD_STATES.indexOf(b);
        });
        
        const isOnlineMode = loadedConfig.autodarts_online_enabled === true;
        
        const gridContainer = document.createElement('div');
        gridContainer.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 18px; margin-top: 14px; width: 100%; align-items: start;';
        
        const colLocal = document.createElement('div');
        colLocal.style.cssText = 'display: flex; flex-direction: column; gap: 12px;';
        colLocal.innerHTML = `
            <h4 style="font-size: 13px; font-weight: 600; color: var(--text-secondary); border-bottom: 1px solid var(--input-border); padding-bottom: 8px; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; margin-top: 0;">
                <span>📡</span> Local API Signals
            </h4>
        `;
        
        const colOnline = document.createElement('div');
        colOnline.style.cssText = 'display: flex; flex-direction: column; gap: 12px;';
        colOnline.innerHTML = `
            <h4 style="font-size: 13px; font-weight: 600; color: var(--text-secondary); border-bottom: 1px solid var(--input-border); padding-bottom: 8px; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; margin-top: 0;">
                <span>🌐</span> Online API Signals
            </h4>
        `;
        
        const colCustom = document.createElement('div');
        colCustom.style.cssText = 'display: flex; flex-direction: column; gap: 12px;';
        colCustom.innerHTML = `
            <h4 style="font-size: 13px; font-weight: 600; color: var(--text-secondary); border-bottom: 1px solid var(--input-border); padding-bottom: 8px; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; margin-top: 0;">
                <span>⚙️</span> Custom Logic (DIY)
            </h4>
            <div style="background: rgba(255, 255, 255, 0.015); border: 1px dashed var(--input-border); border-radius: var(--radius-md); padding: 16px; text-align: center; color: var(--text-secondary); display: flex; flex-direction: column; justify-content: center; align-items: center; flex: 1; min-height: 180px;">
                <div style="font-size: 24px; margin-bottom: 8px;">🛠️</div>
                <div style="font-size: 12px; font-weight: 600; color: var(--text-primary); margin-bottom: 4px;">Placeholder for Custom Logic</div>
                <div style="font-size: 11px; line-height: 1.4;">Add custom events here (e.g. timeouts, hit detection, custom triggers) by altering backend/frontend handlers.</div>
            </div>
        `;
        
        gridContainer.appendChild(colLocal);
        gridContainer.appendChild(colOnline);
        gridContainer.appendChild(colCustom);
        
        statesListContainer.appendChild(gridContainer);
        
        sortedStates.forEach((state, index) => {
            const settings = profileSettings[state] || {
                on: true,
                bri: 255,
                tt: 0,
                enabled: true,
                seg: { fx: 0, col: [[255, 255, 255]] }
            };
            const enabled = settings.enabled !== false;

            const colData = settings.seg?.col?.[0] || [255, 255, 255];
            const r = colData[0], g = colData[1], b = colData[2];
            
            // Convert rgb array to hex string
            const hexColor = '#' + [r, g, b].map(x => {
                const hex = x.toString(16);
                return hex.length === 1 ? '0' + hex : hex;
            }).join('');

            const selectedFx = settings.seg?.fx || 0;

            const isOnlineState = ONLINE_STATES.includes(state);

            const row = document.createElement('div');
            row.className = 'state-row' + (isOnlineState ? ' state-row--online' : '');
            row.setAttribute('data-state', state);
            row.style.display = 'flex';
            row.style.flexDirection = 'column';
            row.style.gap = '10px';
            row.style.background = 'rgba(255, 255, 255, 0.015)';
            row.style.border = '1px solid var(--input-border)';
            row.style.borderRadius = 'var(--radius-md)';
            row.style.padding = '14px';

            // Row header: name & enable toggle
            const headerDiv = document.createElement('div');
            headerDiv.style.display = 'flex';
            headerDiv.style.justifyContent = 'space-between';
            headerDiv.style.alignItems = 'center';

            const namePart = document.createElement('div');
            namePart.style.display = 'flex';
            namePart.style.alignItems = 'center';
            namePart.style.gap = '8px';

            const nameSpan = document.createElement('span');
            nameSpan.style.fontWeight = '600';
            nameSpan.style.fontSize = '13px';
            nameSpan.textContent = state;
            namePart.appendChild(nameSpan);

            if (isOnlineState) {
                const badge = document.createElement('span');
                badge.className = 'online-badge';
                badge.textContent = 'Online';
                namePart.appendChild(badge);
            }

            const labelSwitch = document.createElement('label');
            labelSwitch.className = 'switch-toggle';

            const chk = document.createElement('input');
            chk.type = 'checkbox';
            chk.className = 'state-enabled-chk';
            chk.checked = settings.enabled !== false;

            const spanSlider = document.createElement('span');
            spanSlider.className = 'switch-slider';

            labelSwitch.appendChild(chk);
            labelSwitch.appendChild(spanSlider);

            const settingsBtn = document.createElement('button');
            settingsBtn.type = 'button';
            settingsBtn.className = 'btn-state-settings';
            settingsBtn.title = 'Advanced Effect Settings';
            settingsBtn.innerHTML = '<svg class="icon" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

            const rightControls = document.createElement('div');
            rightControls.style.display = 'flex';
            rightControls.style.alignItems = 'center';
            rightControls.style.gap = '6px';
            rightControls.appendChild(settingsBtn);
            rightControls.appendChild(labelSwitch);

            headerDiv.appendChild(namePart);
            headerDiv.appendChild(rightControls);

            // Row controls: FX, color, test button
            const controlsDiv = document.createElement('div');
            controlsDiv.style.display = 'flex';
            controlsDiv.style.gap = '10px';
            controlsDiv.style.alignItems = 'center';

            let pwmBriSlider = null;
            let pwmBriVal = null;
            let selectWrapper = null;
            let selectFx = null;
            let colorInput = null;

            if (isPwm) {
                const pwmSliderWrapper = document.createElement('div');
                pwmSliderWrapper.style.cssText = 'display: flex; align-items: center; gap: 10px; flex: 1; margin-right: 10px;';
                
                const currentBri = (settings.seg && settings.seg.col && settings.seg.col[0] && settings.seg.col[0][0]) !== undefined 
                    ? settings.seg.col[0][0] 
                    : (settings.bri !== undefined ? settings.bri : 255);
                
                const sliderLabel = document.createElement('span');
                sliderLabel.style.cssText = 'font-size: 11px; color: var(--text-secondary); min-width: 60px;';
                sliderLabel.textContent = 'Brightness:';
                
                pwmBriSlider = document.createElement('input');
                pwmBriSlider.type = 'range';
                pwmBriSlider.className = 'state-pwm-bri-slider';
                pwmBriSlider.min = '0';
                pwmBriSlider.max = '255';
                pwmBriSlider.value = currentBri;
                pwmBriSlider.style.cssText = 'flex: 1; height: 6px; border-radius: 3px; background: var(--input-bg); cursor: pointer;';
                
                pwmBriVal = document.createElement('span');
                pwmBriVal.style.cssText = 'font-size: 11px; color: var(--text-primary); min-width: 32px; text-align: right;';
                pwmBriVal.textContent = Math.round(currentBri * 100 / 255) + '%';
                
                pwmBriSlider.addEventListener('input', () => {
                    pwmBriVal.textContent = Math.round(pwmBriSlider.value * 100 / 255) + '%';
                });
                
                pwmSliderWrapper.appendChild(sliderLabel);
                pwmSliderWrapper.appendChild(pwmBriSlider);
                pwmSliderWrapper.appendChild(pwmBriVal);
                controlsDiv.appendChild(pwmSliderWrapper);
            } else {
                selectWrapper = document.createElement('div');
                selectWrapper.className = 'select-wrapper';
                selectWrapper.style.flex = '1';

                selectFx = document.createElement('select');
                selectFx.className = 'state-fx-sel';
                selectFx.style.height = '38px';
                selectFx.style.padding = '8px 36px 8px 12px';
                selectFx.style.fontSize = '12px';
                selectFx.style.borderRadius = 'var(--radius-sm)';
                selectFx.style.background = 'var(--input-bg)';
                selectFx.style.border = '1px solid var(--input-border)';
                selectFx.style.color = 'white';
                selectFx.style.width = '100%';

                Object.entries(WLED_EFFECTS).forEach(([fxName, fxId]) => {
                    const opt = document.createElement('option');
                    opt.value = fxId;
                    opt.textContent = fxName;
                    if (fxId === selectedFx) {
                        opt.selected = true;
                    }
                    selectFx.appendChild(opt);
                });

                colorInput = document.createElement('input');
                colorInput.type = 'color';
                colorInput.className = 'state-color-pick';
                colorInput.value = hexColor;
                colorInput.style.width = '38px';
                colorInput.style.height = '38px';
                colorInput.style.border = '1px solid var(--input-border)';
                colorInput.style.borderRadius = 'var(--radius-sm)';
                colorInput.style.background = 'none';
                colorInput.style.cursor = 'pointer';
                colorInput.style.padding = '0';

                selectWrapper.appendChild(selectFx);
                controlsDiv.appendChild(selectWrapper);
                controlsDiv.appendChild(colorInput);
            }

            const testBtn = document.createElement('button');
            testBtn.type = 'button';
            testBtn.className = 'btn-action-icon state-test-btn';
            testBtn.title = 'Test / Preview Effect on WLED';
            testBtn.style.width = '38px';
            testBtn.style.height = '38px';
            testBtn.innerHTML = '<svg class="icon" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>';

            testBtn.addEventListener('click', async () => {
                const fxId = isPwm ? 0 : parseInt(selectFx.value, 10);
                let colVal = [255, 255, 255];
                if (isPwm) {
                    const briVal = parseInt(pwmBriSlider.value, 10);
                    colVal = [briVal, briVal, briVal, briVal];
                } else {
                    const hex = colorInput.value;
                    colVal = [
                        parseInt(hex.slice(1, 3), 16),
                        parseInt(hex.slice(3, 5), 16),
                        parseInt(hex.slice(5, 7), 16)
                    ];
                }
                
                testBtn.disabled = true;
                testBtn.textContent = '⏳';
                
                try {
                    const response = await fetch('/api/test_effect', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            fx: fxId,
                            col: colVal,
                            bri: brightnessSlider ? Math.round(parseInt(brightnessSlider.value, 10) * 255 / 100) : (loadedConfig.global_brightness !== undefined ? loadedConfig.global_brightness : 255),
                            connection_type: loadedConfig.connection_type,
                            wifi_ip: loadedConfig.wifi_ip,
                            manual_port: loadedConfig.manual_port,
                            seg_id: activeSectionIdx
                        })
                    });
                    
                    if (!response.ok) throw new Error('Test request failed');
                    const res = await response.json();
                    if (res.status === 'success') {
                        showToast(`Sent test pattern for ${state}!`, 'success');
                    } else {
                        throw new Error(res.message);
                    }
                } catch (err) {
                    console.error('Test pattern failed:', err);
                    showToast(err.message || 'Failed to send test pattern.', 'error');
                } finally {
                    testBtn.disabled = false;
                    testBtn.innerHTML = '<svg class="icon" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
                }
            });

            controlsDiv.appendChild(testBtn);

            const settingsPanel = buildSettingsPanel(settings);

            settingsBtn.addEventListener('click', () => {
                const isOpen = settingsPanel.classList.toggle('open');
                settingsBtn.classList.toggle('active', isOpen);
            });

            row.appendChild(headerDiv);
            row.appendChild(controlsDiv);
            row.appendChild(settingsPanel);
            colLocal.appendChild(row);
        });

        // Render online-exclusive states section
        if (ONLINE_STATES.length > 0) {
            ONLINE_STATES.forEach(state => {
                const settings = profileSettings[state] || {
                    on: true,
                    bri: 255,
                    tt: 0,
                    enabled: true,
                    seg: { fx: 1, col: [[255, 0, 0]] }
                };

                const colData = settings.seg?.col?.[0] || [255, 0, 0];
                const r = colData[0], g = colData[1], b = colData[2];
                const hexColor = '#' + [r, g, b].map(x => {
                    const hex = x.toString(16);
                    return hex.length === 1 ? '0' + hex : hex;
                }).join('');

                const selectedFx = settings.seg?.fx || 0;

                const row = document.createElement('div');
                row.className = 'state-row state-row--online' + (!isOnlineMode ? ' state-row--online-locked' : '');
                row.setAttribute('data-state', state);
                row.style.display = 'flex';
                row.style.flexDirection = 'column';
                row.style.gap = '10px';
                row.style.background = 'rgba(255, 255, 255, 0.015)';
                row.style.border = '1px solid var(--input-border)';
                row.style.borderRadius = 'var(--radius-md)';
                row.style.padding = '14px';

                const headerDiv = document.createElement('div');
                headerDiv.style.display = 'flex';
                headerDiv.style.justifyContent = 'space-between';
                headerDiv.style.alignItems = 'center';

                const namePart = document.createElement('div');
                namePart.style.display = 'flex';
                namePart.style.alignItems = 'center';
                namePart.style.gap = '8px';

                const nameSpan = document.createElement('span');
                nameSpan.style.fontWeight = '600';
                nameSpan.style.fontSize = '13px';
                nameSpan.textContent = state;
                namePart.appendChild(nameSpan);

                const labelSwitch = document.createElement('label');
                labelSwitch.className = 'switch-toggle';
                const chk = document.createElement('input');
                chk.type = 'checkbox';
                chk.className = 'state-enabled-chk';
                chk.checked = settings.enabled !== false;
                const spanSlider = document.createElement('span');
                spanSlider.className = 'switch-slider';
                labelSwitch.appendChild(chk);
                labelSwitch.appendChild(spanSlider);

                const settingsBtnO = document.createElement('button');
                settingsBtnO.type = 'button';
                settingsBtnO.className = 'btn-state-settings';
                settingsBtnO.title = 'Advanced Effect Settings';
                settingsBtnO.innerHTML = '<svg class="icon" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

                const rightControlsO = document.createElement('div');
                rightControlsO.style.display = 'flex';
                rightControlsO.style.alignItems = 'center';
                rightControlsO.style.gap = '6px';
                rightControlsO.appendChild(settingsBtnO);
                rightControlsO.appendChild(labelSwitch);

                headerDiv.appendChild(namePart);
                headerDiv.appendChild(rightControlsO);

                const controlsDiv = document.createElement('div');
                controlsDiv.style.display = 'flex';
                controlsDiv.style.gap = '10px';
                controlsDiv.style.alignItems = 'center';

                let pwmBriSlider = null;
                let pwmBriVal = null;
                let selectWrapper = null;
                let selectFx = null;
                let colorInput = null;

                if (isPwm) {
                    const pwmSliderWrapper = document.createElement('div');
                    pwmSliderWrapper.style.cssText = 'display: flex; align-items: center; gap: 10px; flex: 1; margin-right: 10px;';
                    
                    const currentBri = (settings.seg && settings.seg.col && settings.seg.col[0] && settings.seg.col[0][0]) !== undefined 
                        ? settings.seg.col[0][0] 
                        : (settings.bri !== undefined ? settings.bri : 255);
                    
                    const sliderLabel = document.createElement('span');
                    sliderLabel.style.cssText = 'font-size: 11px; color: var(--text-secondary); min-width: 60px;';
                    sliderLabel.textContent = 'Brightness:';
                    
                    pwmBriSlider = document.createElement('input');
                    pwmBriSlider.type = 'range';
                    pwmBriSlider.className = 'state-pwm-bri-slider';
                    pwmBriSlider.min = '0';
                    pwmBriSlider.max = '255';
                    pwmBriSlider.value = currentBri;
                    pwmBriSlider.style.cssText = 'flex: 1; height: 6px; border-radius: 3px; background: var(--input-bg); cursor: pointer;';
                    
                    pwmBriVal = document.createElement('span');
                    pwmBriVal.style.cssText = 'font-size: 11px; color: var(--text-primary); min-width: 32px; text-align: right;';
                    pwmBriVal.textContent = Math.round(currentBri * 100 / 255) + '%';
                    
                    pwmBriSlider.addEventListener('input', () => {
                        pwmBriVal.textContent = Math.round(pwmBriSlider.value * 100 / 255) + '%';
                    });
                    
                    pwmSliderWrapper.appendChild(sliderLabel);
                    pwmSliderWrapper.appendChild(pwmBriSlider);
                    pwmSliderWrapper.appendChild(pwmBriVal);
                    controlsDiv.appendChild(pwmSliderWrapper);
                } else {
                    selectWrapper = document.createElement('div');
                    selectWrapper.className = 'select-wrapper';
                    selectWrapper.style.flex = '1';

                    selectFx = document.createElement('select');
                    selectFx.className = 'state-fx-sel';
                    selectFx.style.height = '38px';
                    selectFx.style.padding = '8px 36px 8px 12px';
                    selectFx.style.fontSize = '12px';
                    selectFx.style.borderRadius = 'var(--radius-sm)';
                    selectFx.style.background = 'var(--input-bg)';
                    selectFx.style.border = '1px solid var(--input-border)';
                    selectFx.style.color = 'white';
                    selectFx.style.width = '100%';

                    Object.entries(WLED_EFFECTS).forEach(([fxName, fxId]) => {
                        const opt = document.createElement('option');
                        opt.value = fxId;
                        opt.textContent = fxName;
                        if (fxId === selectedFx) opt.selected = true;
                        selectFx.appendChild(opt);
                    });

                    colorInput = document.createElement('input');
                    colorInput.type = 'color';
                    colorInput.className = 'state-color-pick';
                    colorInput.value = hexColor;
                    colorInput.style.width = '38px';
                    colorInput.style.height = '38px';
                    colorInput.style.border = '1px solid var(--input-border)';
                    colorInput.style.borderRadius = 'var(--radius-sm)';
                    colorInput.style.background = 'none';
                    colorInput.style.cursor = 'pointer';
                    colorInput.style.padding = '0';

                    selectWrapper.appendChild(selectFx);
                    controlsDiv.appendChild(selectWrapper);
                    controlsDiv.appendChild(colorInput);
                }

                const testBtn = document.createElement('button');
                testBtn.type = 'button';
                testBtn.className = 'btn-action-icon state-test-btn';
                testBtn.title = 'Test / Preview Effect on WLED';
                testBtn.style.width = '38px';
                testBtn.style.height = '38px';
                testBtn.innerHTML = '<svg class="icon" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>';

                testBtn.addEventListener('click', async () => {
                    const fxId = isPwm ? 0 : parseInt(selectFx.value, 10);
                    let colVal = [255, 255, 255];
                    if (isPwm) {
                        const briVal = parseInt(pwmBriSlider.value, 10);
                        colVal = [briVal, briVal, briVal, briVal];
                    } else {
                        const hex = colorInput.value;
                        colVal = [
                            parseInt(hex.slice(1, 3), 16),
                            parseInt(hex.slice(3, 5), 16),
                            parseInt(hex.slice(5, 7), 16)
                        ];
                    }
                    testBtn.disabled = true;
                    testBtn.textContent = '⏳';
                    try {
                        const response = await fetch('/api/test_effect', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                fx: fxId,
                                col: colVal,
                                bri: brightnessSlider ? Math.round(parseInt(brightnessSlider.value, 10) * 255 / 100) : (loadedConfig.global_brightness !== undefined ? loadedConfig.global_brightness : 255),
                                connection_type: loadedConfig.connection_type,
                                wifi_ip: loadedConfig.wifi_ip,
                                manual_port: loadedConfig.manual_port,
                                seg_id: activeSectionIdx
                            })
                        });
                        if (!response.ok) throw new Error('Test request failed');
                        const res = await response.json();
                        if (res.status === 'success') {
                            showToast(`Sent test pattern for ${state}!`, 'success');
                        } else {
                            throw new Error(res.message);
                        }
                    } catch (err) {
                        console.error('Test pattern failed:', err);
                        showToast(err.message || 'Failed to send test pattern.', 'error');
                    } finally {
                        testBtn.disabled = false;
                        testBtn.innerHTML = '<svg class="icon" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
                    }
                });

                controlsDiv.appendChild(testBtn);

                const settingsPanelO = buildSettingsPanel(settings);

                settingsBtnO.addEventListener('click', () => {
                    const isOpen = settingsPanelO.classList.toggle('open');
                    settingsBtnO.classList.toggle('active', isOpen);
                });

                // Lock hint bar — shown via CSS when state-row--online-locked is present
                const lockHint = document.createElement('div');
                lockHint.className = 'state-online-lock-hint';
                lockHint.textContent = 'Enable Online Board API in Settings to configure this effect';

                row.appendChild(headerDiv);
                row.appendChild(controlsDiv);
                row.appendChild(settingsPanelO);
                row.appendChild(lockHint);
                colOnline.appendChild(row);
            });
        }
    }

    // Update locked state of online-exclusive rows without a full re-render
    function updateOnlineStateLocks() {
        const isOnline = loadedConfig.autodarts_online_enabled === true;
        document.querySelectorAll('.state-row--online').forEach(row => {
            if (isOnline) {
                row.classList.remove('state-row--online-locked');
            } else {
                row.classList.add('state-row--online-locked');
            }
        });
    }

    // Save all profile state settings
    async function saveAllSettings() {
        btnSaveAll.classList.add('loading');
        btnSaveAll.disabled = true;

        const currentProfile = loadedConfig.current_profile || 'Default';
        
        // Find if this is a PWM White segment
        const activeDevice = getActiveDevice();
        let isPwm = false;
        if (activeDevice && activeSectionIdx >= 0) {
            const resolved = getSegmentByFlatIdx(activeDevice, activeSectionIdx);
            if (resolved && resolved.type === 41) {
                isPwm = true;
            }
        }
        const profileCat = isPwm ? 'pwm-white' : 'ws281x';

        if (!loadedConfig.profiles) loadedConfig.profiles = { "ws281x": {}, "pwm-white": {} };
        if (!loadedConfig.profiles[profileCat]) loadedConfig.profiles[profileCat] = {};
        if (!loadedConfig.profiles[profileCat][currentProfile]) loadedConfig.profiles[profileCat][currentProfile] = {};

        ALL_STATES.forEach(state => {
            const row = document.querySelector(`[data-state="${state}"]`);
            if (row) {
                const enabled = row.querySelector('.state-enabled-chk').checked;
                const durationInput = row.querySelector('.state-duration-input');
                const duration = durationInput ? parseFloat(durationInput.value) || 0 : 0;

                let fx = 0;
                let colVal = [[255, 255, 255]];
                
                const pwmSlider = row.querySelector('.state-pwm-bri-slider');
                if (pwmSlider) {
                    const briVal = parseInt(pwmSlider.value, 10);
                    colVal = [[briVal, briVal, briVal, briVal]];
                } else {
                    fx = parseInt(row.querySelector('.state-fx-sel').value, 10);
                    const hex = row.querySelector('.state-color-pick').value;
                    const rVal = parseInt(hex.slice(1, 3), 16);
                    const gVal = parseInt(hex.slice(3, 5), 16);
                    const bVal = parseInt(hex.slice(5, 7), 16);
                    colVal = [[rVal, gVal, bVal]];
                }

                loadedConfig.profiles[profileCat][currentProfile][state] = {
                    on: true,
                    bri: 255,
                    tt: 0,
                    enabled: enabled,
                    ...(duration > 0 ? { duration } : {}),
                    seg: {
                        fx: fx,
                        col: colVal
                    }
                };
            }
        });

        const payload = {
            global_brightness: brightnessSlider ? Math.round(parseInt(brightnessSlider.value, 10) * 255 / 100) : (loadedConfig.global_brightness !== undefined ? loadedConfig.global_brightness : 255),
            connection_type: loadedConfig.connection_type,
            manual_port: loadedConfig.manual_port,
            wifi_ip: loadedConfig.wifi_ip,
            current_profile: currentProfile,
            profiles: loadedConfig.profiles
        };

        const startTime = Date.now();
        try {
            const response = await fetch('/api/config', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) throw new Error('Failed to update config settings');
            const result = await response.json();
            if (result.status !== 'success') throw new Error(result.message);

            // Update local config
            Object.assign(loadedConfig, payload);

            const elapsedTime = Date.now() - startTime;
            const remainingTime = Math.max(0, 600 - elapsedTime);
            
            setTimeout(() => {
                btnSaveAll.classList.remove('loading');
                btnSaveAll.disabled = false;
                showToast('All settings saved successfully!', 'success');
                renderStatesList();
            }, remainingTime);

        } catch (err) {
            console.error('Save all settings failed:', err);
            const elapsedTime = Date.now() - startTime;
            const remainingTime = Math.max(0, 600 - elapsedTime);
            setTimeout(() => {
                btnSaveAll.classList.remove('loading');
                btnSaveAll.disabled = false;
                showToast(err.message || 'Error occurred while saving settings.', 'error');
            }, remainingTime);
        }
    }

    btnSaveAll.addEventListener('click', saveAllSettings);

    // Debug Reset Button Click listener
    const btnDebugReset = document.getElementById('btn-debug-reset');
    if (btnDebugReset) {
        btnDebugReset.addEventListener('click', async () => {
            try {
                const response = await fetch('/api/config/reset', { method: 'POST' });
                if (!response.ok) throw new Error('Reset failed');
                const data = await response.json();
                if (data.status === 'success') {
                    showToast('Configuration reset successfully! Reloading...', 'success');
                    setTimeout(() => {
                        window.location.reload();
                    }, 1000);
                } else {
                    throw new Error(data.message);
                }
            } catch (err) {
                console.error(err);
                showToast('Failed to reset configuration.', 'error');
            }
        });
    }

    // Easy Setup & Device Scanning Implementation
    const btnEasySetup = document.getElementById('btn-easy-setup');
    const btnScanDevices = document.getElementById('btn-scan-devices');
    const easySetupModal = document.getElementById('easy-setup-modal');
    const btnEasySetupClose = document.getElementById('btn-easy-setup-close');
    const btnEasySetupAction = document.getElementById('btn-easy-setup-action');
    const scanStatusSerial = document.getElementById('scan-status-serial');
    const scanStatusNetwork = document.getElementById('scan-status-network');
    const scanStatusWifi = document.getElementById('scan-status-wifi');
    const scanItemSerial = document.getElementById('scan-item-serial');
    const scanItemNetwork = document.getElementById('scan-item-network');
    const scanItemWifi = document.getElementById('scan-item-wifi');
    const easySetupMessage = document.getElementById('easy-setup-message');
    const easySetupSelectionArea = document.getElementById('easy-setup-selection-area');
    const easySetupOptionsList = document.getElementById('easy-setup-options-list');
    const easySetupTitle = document.getElementById('easy-setup-title');
    const easySetupSubtitle = document.getElementById('easy-setup-subtitle');

    let discoveredOptions = [];
    let selectedOption = null;

    if (btnEasySetupClose) {
        btnEasySetupClose.addEventListener('click', () => {
            easySetupModal.classList.remove('active');
            if (isScanForDevicesPage) {
                navigateTo('/devices');
            }
        });
    }

    function setScanStep(step, state) {
        const item = document.getElementById(`scan-item-${step}`);
        const status = document.getElementById(`scan-status-${step}`);
        if (!item || !status) return;

        item.classList.remove('inactive', 'scanning', 'found');
        
        if (state === 'inactive') {
            item.classList.add('inactive');
            status.innerHTML = '<svg class="icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
        } else if (state === 'scanning') {
            if (step === 'wifi' && !hasWifi) {
                status.innerHTML = 'No Wi-Fi on this Device';
            } else {
                item.classList.add('scanning');
                status.innerHTML = `
                    <div class="loading-dots">
                        <span></span><span></span><span></span>
                    </div>
                `;
            }
        } else if (state === 'found') {
            item.classList.add('found');
            status.innerHTML = '<svg class="icon" style="color: var(--accent-blue);" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        } else if (state === 'notfound') {
            if (step === 'wifi' && !hasWifi) {
                status.innerHTML = 'No Wi-Fi on this Device';
            } else {
                status.innerHTML = '<svg class="icon" style="color: var(--accent-red);" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
            }
        }
    }

    async function startUnifiedScan(forDevicesPage) {
        isScanForDevicesPage = forDevicesPage;

        if (easySetupTitle) {
            easySetupTitle.textContent = isScanForDevicesPage ? 'Scan for WLED Devices' : 'Easy Setup Scan';
        }
        if (easySetupSubtitle) {
            easySetupSubtitle.style.display = 'none';
        }

        // Open modal and set loading states
        easySetupModal.classList.add('active');
        
        easySetupMessage.style.display = 'none';
        easySetupSelectionArea.style.display = 'none';
        btnEasySetupAction.style.display = 'none';
        easySetupOptionsList.innerHTML = '';
        if (btnEasySetupClose) {
            btnEasySetupClose.textContent = 'Cancel';
        }
        
        const triggerBtn = isScanForDevicesPage ? btnScanDevices : btnEasySetup;
        if (triggerBtn) {
            triggerBtn.classList.add('loading');
            triggerBtn.disabled = true;
            const spinner = triggerBtn.querySelector('.spinner');
            if (spinner) spinner.style.display = 'inline-block';
        }
        
        try {
            // Fetch latest devices list to filter out already added devices
            try {
                const devRes = await fetch('/api/devices');
                if (devRes.ok) {
                    devicesData = await devRes.json();
                }
            } catch (e) {
                console.error('Failed to update devices list before scan:', e);
            }

            const existingIps = new Set((devicesData || []).map(d => d.ip));
            const getSerialState = (d) => (d && d.serial && d.serial.found && d.serial.devices.some(dev => !existingIps.has(dev.device))) ? 'found' : 'notfound';
            const getNetworkState = (d) => (d && d.network && d.network.found && d.network.devices.some(dev => !existingIps.has(dev.ip))) ? 'found' : 'notfound';
            const getWifiState = (d) => (d && d.wifi_ap && d.wifi_ap.found && d.wifi_ap.ssids.length > 0) ? 'found' : 'notfound';

            // Start the background scan fetch and a minimum animation duration
            const scanPromise = fetch('/api/setup/scan').then(r => r.json());
            const minTimePromise = new Promise(r => setTimeout(r, 1500));
            
            // Set all steps to scanning at the same time
            setScanStep('serial', 'scanning');
            setScanStep('network', 'scanning');
            setScanStep('wifi', 'scanning');
            
            // Wait for both the scan to complete and the minimum duration to pass
            const [data] = await Promise.all([scanPromise, minTimePromise]);
            
            // Finalize all steps
            setScanStep('serial', getSerialState(data));
            setScanStep('network', getNetworkState(data));
            setScanStep('wifi', getWifiState(data));
            
            await new Promise(r => setTimeout(r, 400));
            
            // Build options list
            discoveredOptions = [];

            if (data.serial && data.serial.found) {
                data.serial.devices.forEach(dev => {
                    if (existingIps.has(dev.device)) return; // Skip already added ports
                    discoveredOptions.push({
                        type: 'serial',
                        label: `USB Port: ${dev.device} (${dev.description || 'ESP32'})`,
                        value: dev.device,
                        name: dev.description || 'ESP32 Controller'
                    });
                });
            }
            if (data.network && data.network.found) {
                data.network.devices.forEach(dev => {
                    if (existingIps.has(dev.ip)) return; // Skip already added IPs
                    discoveredOptions.push({
                        type: 'network',
                        label: `Network: ${dev.name} (${dev.ip})`,
                        value: dev.ip,
                        name: dev.name || 'WLED Device'
                    });
                });
            }
            if (data.wifi_ap && data.wifi_ap.found) {
                data.wifi_ap.ssids.forEach(ssid => {
                    discoveredOptions.push({
                        type: 'wifi_ap',
                        label: `WLED-AP Setup: Connect to hotspot (${ssid})`,
                        value: ssid,
                        name: 'WLED Device'
                    });
                });
            }
            
            // Handle results routing
            if (discoveredOptions.length === 0) {
                const totalFound = (data.serial?.devices?.length || 0) + (data.network?.devices?.length || 0) + (data.wifi_ap?.ssids?.length || 0);
                if (totalFound > 0) {
                    easySetupMessage.textContent = 'No new devices found.';
                } else {
                    easySetupMessage.textContent = 'No automatic connection paths found. Please configure settings manually.';
                }
                easySetupMessage.style.display = 'block';
                btnEasySetupAction.style.display = 'none';
                if (btnEasySetupClose) {
                    btnEasySetupClose.textContent = 'Close';
                }
                selectedOption = { type: 'manual' };
            } else {
                // Shows all found devices as a minimalistic list with checkboxes
                easySetupSelectionArea.style.display = 'block';
                discoveredOptions.forEach((opt, idx) => {
                    const item = document.createElement('label');
                    item.className = 'option-select-item';
                    
                    const checkbox = document.createElement('input');
                    checkbox.type = 'checkbox';
                    checkbox.className = 'option-checkbox';
                    checkbox.value = idx;
                    
                    const labelSpan = document.createElement('span');
                    labelSpan.className = 'option-label-text';
                    labelSpan.textContent = opt.label;
                    
                    item.appendChild(checkbox);
                    item.appendChild(labelSpan);
                    
                    checkbox.addEventListener('change', () => {
                        if (!isScanForDevicesPage && checkbox.checked) {
                            // Enforce single-select on setup page (like radio button)
                            easySetupOptionsList.querySelectorAll('.option-checkbox').forEach(cb => {
                                if (cb !== checkbox) cb.checked = false;
                            });
                        }
                        updateScanActionVisibility();
                    });
                    
                    easySetupOptionsList.appendChild(item);
                });
                
                updateScanActionVisibility();
            }
            
        } catch (err) {
            console.error(err);
            showToast('Failed to run automatic scan.', 'error');
            easySetupMessage.textContent = 'Error occurred during scan. Please setup manually.';
            easySetupMessage.style.display = 'block';
            btnEasySetupAction.style.display = 'none';
            if (btnEasySetupClose) {
                btnEasySetupClose.textContent = 'Close';
            }
            selectedOption = { type: 'manual' };
        } finally {
            if (triggerBtn) {
                triggerBtn.classList.remove('loading');
                triggerBtn.disabled = false;
                const spinner = triggerBtn.querySelector('.spinner');
                if (spinner) spinner.style.display = 'none';
            }
        }
    }

    function updateScanActionVisibility() {
        const checkedCount = easySetupOptionsList.querySelectorAll('.option-checkbox:checked').length;
        btnEasySetupAction.style.display = checkedCount > 0 ? 'block' : 'none';
        if (isScanForDevicesPage) {
            btnEasySetupAction.textContent = checkedCount > 1 ? 'Add Selected Devices' : 'Add Selected Device';
        } else {
            btnEasySetupAction.textContent = checkedCount > 1 ? 'Proceed with Selected' : 'Auto Setup';
        }
    }

    if (btnEasySetup) {
        btnEasySetup.addEventListener('click', () => startUnifiedScan(false));
    }

    if (btnEasySetupAction) {
        btnEasySetupAction.addEventListener('click', async () => {
            const checkedBoxes = easySetupOptionsList.querySelectorAll('.option-checkbox:checked');
            
            // Fallback for manual or single setup confirmation when checkboxes are not shown/used
            let selectedOptions = Array.from(checkedBoxes).map(cb => discoveredOptions[parseInt(cb.value)]);
            if (selectedOptions.length === 0 && selectedOption) {
                selectedOptions = [selectedOption];
            }
            
            if (selectedOptions.length === 0) return;
            
            if (isScanForDevicesPage) {
                if (selectedOptions.length === 1 && selectedOptions[0].type === 'manual') {
                    easySetupModal.classList.remove('active');
                    navigateTo('/devices');
                    return;
                }
                
                easySetupModal.classList.remove('active');
                navigateTo('/devices');
                
                let addedCount = 0;
                for (const opt of selectedOptions) {
                    if (opt.type === 'manual') continue;
                    
                    if (opt.type === 'serial') {
                        try {
                            const resp = await fetch('/api/devices', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    name: '',
                                    ip: opt.value,
                                    connection_type: 'serial',
                                    api_type: 'local'
                                })
                            });
                            const data = await resp.json();
                            if (data.status === 'success') {
                                devicesData.push(data.device);
                                addedCount++;
                            }
                        } catch (err) {
                            console.error('Failed to add serial device:', err);
                        }
                    } else if (opt.type === 'network') {
                        try {
                            const resp = await fetch('/api/devices', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    name: '',
                                    ip: opt.value,
                                    connection_type: 'wifi',
                                    api_type: 'local'
                                })
                            });
                            const data = await resp.json();
                            if (data.status === 'success') {
                                devicesData.push(data.device);
                                addedCount++;
                            }
                        } catch (err) {
                            console.error('Failed to add network device:', err);
                        }
                    } else if (opt.type === 'wifi_ap') {
                        // Sequential AP provisioning if multiple (reopen modal to show status)
                        easySetupModal.classList.add('active');
                        easySetupSelectionArea.style.display = 'none';
                        btnEasySetupAction.style.display = 'none';
                        easySetupMessage.style.display = 'block';
                        
                        try {
                            easySetupMessage.textContent = `Starting provisioning for ${opt.value}...`;
                            let success = await runAutoProvisioningAttempt();
                            if (!success) {
                                easySetupMessage.textContent = 'Attempt 1 failed. Retrying in 3 seconds...';
                                await new Promise(resolve => setTimeout(resolve, 3000));
                                success = await runAutoProvisioningAttempt();
                            }
                            
                            if (success) {
                                const configResp = await fetch('/api/config');
                                if (configResp.ok) {
                                    const currentConfig = await configResp.json();
                                    const newIp = currentConfig.wifi_ip;
                                    if (newIp) {
                                        const resp = await fetch('/api/devices', {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({
                                                name: '',
                                                ip: newIp,
                                                connection_type: 'wifi',
                                                api_type: 'local'
                                            })
                                        });
                                        const data = await resp.json();
                                        if (data.status === 'success') {
                                            devicesData.push(data.device);
                                            addedCount++;
                                        }
                                    }
                                }
                            }
                        } catch (err) {
                            console.error('Failed to provision AP:', err);
                        }
                        easySetupModal.classList.remove('active');
                        navigateTo('/devices');
                    }
                }
                
                renderDevicesTable();
                if (addedCount > 0) {
                    showToast(`Added ${addedCount} device${addedCount !== 1 ? 's' : ''}!`, 'success');
                }
                return;
            }

        });
    }

    // Profile Management Logic
    const profileSelect = document.getElementById('profile-select');
    const profileModal = document.getElementById('profile-modal');
    const btnProfileClose = document.getElementById('btn-profile-close');
    const btnProfileCreate = document.getElementById('btn-profile-create');
    const btnProfileDelete = document.getElementById('btn-profile-delete');
    const btnProfileApply = document.getElementById('btn-profile-apply');
    const btnProfileRename = document.getElementById('btn-profile-rename');

    let tempSelectedProfile = 'Default';

    function getSegmentByFlatIdx(device, flatIdx) {
        let currentIdx = 0;
        if (!device || !device.segments) return null;
        for (const seg of device.segments) {
            if (seg.is_split) {
                for (const sub of (seg.sub_segments || [])) {
                    if (currentIdx === flatIdx) {
                        return { parent: seg, sub: sub, type: seg.type };
                    }
                    currentIdx++;
                }
            } else {
                if (currentIdx === flatIdx) {
                    return { parent: seg, sub: null, type: seg.type };
                }
                currentIdx++;
            }
        }
        return null;
    }

    function updateProfileDropdown(selectedVal) {
        if (!profileSelect) return;
        profileSelect.innerHTML = '';
        const profiles = Object.keys(loadedConfig.profiles || { 'Default': {} });
        profiles.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p;
            opt.textContent = p;
            if (p === selectedVal) {
                opt.selected = true;
            }
            profileSelect.appendChild(opt);
        });
    }

    async function saveActiveProfile() {
        try {
            await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ current_profile: loadedConfig.current_profile })
            });
        } catch (err) {
            console.error("Failed to save active profile:", err);
        }
    }

    function getActiveDevice() {
        const path = window.location.pathname;
        if (path.startsWith('/menu/')) {
            const devicename = decodeURIComponent(path.substring(6).split('/')[0].replace(/\+/g, ' ')).trim();
            return devicesData.find(d => d.name && d.name.trim().toLowerCase() === devicename.toLowerCase());
        }
        if (path.startsWith('/settings/')) {
            const devicename = decodeURIComponent(path.substring(10).split('/')[0].replace(/\+/g, ' ')).trim();
            return devicesData.find(d => d.name && d.name.trim().toLowerCase() === devicename.toLowerCase());
        }
        return devicesData.find(d => 
            d.connection_type === 'serial' 
                ? (loadedConfig.connection_type === 'serial' && loadedConfig.manual_port === d.ip)
                : (loadedConfig.connection_type === 'wifi' && loadedConfig.wifi_ip === d.ip)
        );
    }

    async function updateActiveProfile(newProfile) {
        loadedConfig.current_profile = newProfile;
        await saveActiveProfile();
        
        const activeDevice = getActiveDevice();
        if (activeDevice) {
            if (activeSectionIdx >= 0) {
                const resolved = getSegmentByFlatIdx(activeDevice, activeSectionIdx);
                if (resolved) {
                    if (resolved.sub) {
                        resolved.sub.profile = newProfile;
                    } else {
                        resolved.parent.profile = newProfile;
                    }
                }
            }
            try {
                const payload = {};
                if (activeSectionIdx >= 0) {
                    payload.segments = activeDevice.segments;
                } else {
                    payload.profile = newProfile;
                }
                const resp = await fetch(`/api/devices/${activeDevice.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await resp.json();
                if (data.status === 'success') {
                    if (data.device) {
                        Object.assign(activeDevice, data.device);
                    } else if (!payload.segments) {
                        activeDevice.profile = newProfile;
                    }
                }
            } catch (err) {
                console.error('Failed to sync device profile:', err);
            }
        }
    }

    if (profileSelect) {
        profileSelect.addEventListener('change', () => {
            tempSelectedProfile = profileSelect.value;
            if (btnProfileDelete) {
                btnProfileDelete.disabled = (tempSelectedProfile === 'Default');
            }
            if (btnProfileRename) {
                btnProfileRename.disabled = (tempSelectedProfile === 'Default');
            }
        });
    }

    if (btnProfileManage) {
        btnProfileManage.addEventListener('click', () => {
            navigateTo('/profile');
        });
    }

    if (btnProfileClose) {
        btnProfileClose.addEventListener('click', () => {
            navigateTo('/menu');
        });
    }

    if (btnProfileApply) {
        btnProfileApply.addEventListener('click', async () => {
            renderStatesList();
            await updateActiveProfile(tempSelectedProfile);
            showToast(`Applied profile "${tempSelectedProfile}"`, 'success');
            navigateTo('/menu');
        });
    }

    if (btnProfileCreate) {
        btnProfileCreate.addEventListener('click', () => {
            showPrompt("New Profile", "", "", async (newName) => {
                if (!newName) return;
                const trimmedName = newName.trim();
                if (!trimmedName) {
                    showToast('Please enter a valid profile name', 'error');
                    return;
                }
                if (loadedConfig.profiles && loadedConfig.profiles[trimmedName]) {
                    showToast('Profile name already exists', 'error');
                    return;
                }
                
                // Clone settings from the currently selected profile
                const currentSettings = JSON.parse(JSON.stringify(
                    (loadedConfig.profiles && loadedConfig.profiles[tempSelectedProfile]) || {}
                ));
                
                if (!loadedConfig.profiles) loadedConfig.profiles = {};
                loadedConfig.profiles[trimmedName] = currentSettings;
                tempSelectedProfile = trimmedName;
                
                updateProfileDropdown(tempSelectedProfile);
                if (btnProfileDelete) {
                    btnProfileDelete.disabled = (tempSelectedProfile === 'Default');
                }
                if (btnProfileRename) {
                    btnProfileRename.disabled = (tempSelectedProfile === 'Default');
                }
                
                await saveAllSettings();
                showToast(`Profile "${trimmedName}" created!`, 'success');
            });
        });
    }

    if (btnProfileDelete) {
        btnProfileDelete.addEventListener('click', async () => {
            if (tempSelectedProfile === 'Default') {
                showToast('Cannot delete the Default profile', 'error');
                return;
            }
            showConfirm('Delete Profile', `Are you sure you want to delete profile "${tempSelectedProfile}"?`, 'Yes, Delete', async () => {
                const deletedName = tempSelectedProfile;
                delete loadedConfig.profiles[deletedName];
                
                tempSelectedProfile = 'Default';
                updateProfileDropdown(tempSelectedProfile);
                btnProfileDelete.disabled = true;
                if (btnProfileRename) {
                    btnProfileRename.disabled = true;
                }
                
                if (loadedConfig.current_profile === deletedName) {
                    renderStatesList();
                    await updateActiveProfile('Default');
                }
                
                await saveAllSettings();
                showToast(`Profile "${deletedName}" deleted`, 'success');
            }, true);
        });
    }

    if (btnProfileRename) {
        btnProfileRename.addEventListener('click', () => {
            if (tempSelectedProfile === 'Default') {
                showToast('Cannot rename the Default profile', 'error');
                return;
            }
            showPrompt("Rename Profile", "", tempSelectedProfile, async (newName) => {
                if (!newName) return;
                const trimmedName = newName.trim();
                if (!trimmedName) {
                    showToast('Please enter a valid profile name', 'error');
                    return;
                }
                if (trimmedName === tempSelectedProfile) {
                    return; // No change
                }
                if (loadedConfig.profiles && loadedConfig.profiles[trimmedName]) {
                    showToast('Profile name already exists', 'error');
                    return;
                }
                
                const oldName = tempSelectedProfile;
                loadedConfig.profiles[trimmedName] = loadedConfig.profiles[oldName];
                delete loadedConfig.profiles[oldName];
                tempSelectedProfile = trimmedName;
                
                updateProfileDropdown(tempSelectedProfile);
                if (btnProfileDelete) btnProfileDelete.disabled = (tempSelectedProfile === 'Default');
                if (btnProfileRename) btnProfileRename.disabled = (tempSelectedProfile === 'Default');
                
                if (loadedConfig.current_profile === oldName) {
                    renderStatesList();
                    await updateActiveProfile(trimmedName);
                }
                
                await saveAllSettings();
                showToast(`Profile renamed to "${trimmedName}"`, 'success');
            });
        });
    }

    // =========================================================
    // DEVICE MANAGER
    // =========================================================

    let devicesData = [];
    let selectedScanDevices = new Set();


    const btnAddDevice = document.getElementById('btn-add-device');
    const devicesTableContainer = document.getElementById('devices-table-container');
    const devicesEmptyState = document.getElementById('devices-empty-state');

    function loadDevicesPage() {
        fetchAndRenderDevices();
        checkAutodartsAuthStatus();
    }

    async function fetchAndRenderDevices() {
        try {
            const response = await fetch('/api/devices');
            if (!response.ok) throw new Error('Failed to fetch devices');
            devicesData = await response.json();
            renderDevicesTable();
        } catch (err) {
            console.error('Error fetching devices:', err);
            showToast('Failed to load device list.', 'error');
        }
    }

    function getConnectionBadgeHTML(connType) {
        if (connType === 'serial') {
            return `<span class="device-badge device-badge--serial">Serial</span>`;
        }
        return `<span class="device-badge device-badge--wifi">WiFi</span>`;
    }

    function getApiBadgeHTML(device) {
        if (!device) return `<span class="device-badge device-badge--disabled">Disabled</span>`;
        const segments = device.segments || [];
        const sources = new Set();
        segments.forEach(s => {
            if (s.api_source && s.api_source !== 'disabled') {
                if (s.api_source === 'hybrid') {
                    sources.add('local');
                    sources.add('online');
                } else {
                    sources.add(s.api_source);
                }
            }
            if (s.is_split && s.sub_segments) {
                s.sub_segments.forEach(sub => {
                    if (sub.api_source && sub.api_source !== 'disabled') {
                        if (sub.api_source === 'hybrid') {
                            sources.add('local');
                            sources.add('online');
                        } else {
                            sources.add(sub.api_source);
                        }
                    }
                });
            }
        });
        if (sources.size === 0) {
            return `<span class="device-badge device-badge--disabled">Disabled</span>`;
        }
        if (sources.has('local') && sources.has('online')) {
            return `<span class="device-badge" style="background: linear-gradient(135deg, rgba(34,197,94,0.15) 0%, rgba(139,92,246,0.15) 100%); color: #ffffff; border: 1px solid rgba(139,92,246,0.35);">Local + Online</span>`;
        }
        if (sources.has('online')) {
            return `<span class="device-badge device-badge--online">Online</span>`;
        }
        return `<span class="device-badge device-badge--local">Local</span>`;
    }

    function renderDevicesTable() {
        if (!devicesTableContainer) return;
        devicesTableContainer.innerHTML = '';

        if (devicesData.length === 0) {
            if (devicesEmptyState) devicesEmptyState.style.display = 'block';
            return;
        }
        if (devicesEmptyState) devicesEmptyState.style.display = 'none';

        const activeIp = loadedConfig.wifi_ip || '';

        // Table wrapper
        const table = document.createElement('div');
        table.className = 'devices-table';

        // Header row — 5 columns: dot | name | ip | connection | actions
        const head = document.createElement('div');
        head.className = 'devices-table-head';
        head.innerHTML = `
            <span></span>
            <span class="col-name">Name</span>
            <span class="col-ip">IP Address</span>
            <span class="col-conn">Connection</span>
            <span class="col-actions">Actions</span>
        `;
        table.appendChild(head);

        devicesData.forEach(device => {
            const isActive = isDeviceActive(device);
            const isApiDisabled = device.api_type === 'disabled' || device.api_type === 'off';
            const row = document.createElement('div');
            row.className = 'device-row' + (isActive ? ' device-row--active' : '') + (isApiDisabled ? ' device-row--disabled' : '');
            row.dataset.deviceId = device.id;

            // --- Status dot ---
            const statusDot = document.createElement('div');
            statusDot.className = 'device-status-dot status-checking';
            statusDot.title = 'Checking...';

            // --- Name cell ---
            const nameCell = document.createElement('div');
            nameCell.className = 'device-cell-name';
            nameCell.style.cssText = 'display: flex; align-items: center; gap: 8px;';

            const nameSpan = document.createElement('span');
            nameSpan.className = 'device-editable device-name-text';
            nameSpan.textContent = device.name || 'Unnamed Device';
            nameSpan.title = 'Click to rename';

            // Inline edits
            nameSpan.addEventListener('click', () => startInlineEdit(nameSpan, device.id, 'name', device.name || ''));

            nameCell.appendChild(statusDot);
            nameCell.appendChild(nameSpan);

            // --- IP Address cell ---
            const ipCell = document.createElement('div');
            ipCell.className = 'device-cell-ip';

            const ipSpan = document.createElement('span');
            ipSpan.className = 'device-ip-text';
            ipSpan.textContent = device.ip || (device.connection_type === 'serial' ? 'Serial Port' : '—');
            ipCell.appendChild(ipSpan);

            // --- Connection badge ---
            const connCell = document.createElement('div');
            connCell.className = 'device-cell-conn';
            connCell.innerHTML = getConnectionBadgeHTML(device.connection_type);



            // --- Actions ---
            const actionsDiv = document.createElement('div');
            actionsDiv.className = 'device-actions';

            // Settings button (opens settings modal)
            const btnSettings = document.createElement('button');
            btnSettings.type = 'button';
            btnSettings.className = 'btn-device-action btn-device-configure';
            btnSettings.title = 'Device Settings (Connection Mode, Brightness, Crossfade)';
            btnSettings.innerHTML = '<svg class="icon" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
            btnSettings.addEventListener('click', () => openSettingsModal(device, row));

            // Remove button
            const btnRemove = document.createElement('button');
            btnRemove.type = 'button';
            btnRemove.className = 'btn-device-action btn-device-remove';
            btnRemove.title = 'Remove / Delete WLED Device';
            btnRemove.innerHTML = '<svg class="icon icon-delete" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
            btnRemove.addEventListener('click', () => removeDevice(device.id, device.name));

            actionsDiv.appendChild(btnSettings);
            actionsDiv.appendChild(btnRemove);

            const group = document.createElement('div');
            group.className = 'device-group';
            group.style.cssText = 'border-bottom: 1px solid var(--input-border); display: flex; flex-direction: column;';

            row.style.borderBottom = 'none';

            const chevronToggle = document.createElement('span');
            chevronToggle.className = 'btn-device-accordion-toggle';
            chevronToggle.style.cssText = 'cursor: pointer; display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; color: var(--text-secondary); transition: transform 0.2s ease; margin-right: 4px;';
            chevronToggle.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

            const firstCell = document.createElement('div');
            firstCell.style.cssText = 'display: flex; align-items: center; justify-content: center;';
            firstCell.appendChild(chevronToggle);

            row.appendChild(firstCell);
            row.appendChild(nameCell);
            row.appendChild(ipCell);
            row.appendChild(connCell);
            row.appendChild(actionsDiv);
            
            group.appendChild(row);

            const accordion = document.createElement('div');
            accordion.className = 'device-accordion-panel';
            accordion.style.cssText = 'display: none; padding: 6px 0 20px 0; background: rgba(255, 255, 255, 0.005); border-top: 1px dashed var(--input-border); flex-direction: column; gap: 14px;';
            group.appendChild(accordion);
            
            table.appendChild(group);

            let settingsLoaded = false;
            let isOpen = false;

            async function loadAccordionSettings() {
                if (settingsLoaded) return;
                accordion.innerHTML = `<div style="font-size: 12px; color: var(--text-secondary); padding: 10px 0; display: flex; align-items: center; gap: 8px;">
                    <span class="spinner" style="display: inline-block; width: 12px; height: 12px; border-width: 2px;"></span>
                    Loading settings...
                </div>`;
                
                try {
                    const response = await fetch(`/api/wled/config?ip=${encodeURIComponent(device.ip || '')}`);
                    if (!response.ok) throw new Error('Failed to fetch WLED hardware settings');
                    const wledData = await response.json();
                    
                    accordion.innerHTML = `
<div class="inline-settings-container" style="display: flex; flex-direction: column; gap: 16px; width: 100%; margin-top: 0;">
    <!-- Top Block: Strips / Sections Table -->
    <div style="display: flex; flex-direction: column; gap: 12px; width: 100%; overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse; margin-top: 0; margin-bottom: 4px;">
            <thead>
                <tr style="border-bottom: 2px solid var(--accent-blue); text-align: left; text-transform: uppercase; letter-spacing: 0.05em;">
                    <th style="padding: 12px 12px; font-size: 12px; font-weight: 700; color: var(--text-secondary); border-right: 1px solid var(--input-border);">Strip</th>
                    <th style="padding: 12px 12px; font-size: 12px; font-weight: 700; color: var(--text-secondary); width: 80px; text-align: center; border-right: 1px solid var(--input-border);">GPIO Pin</th>
                    <th style="padding: 12px 12px; font-size: 12px; font-weight: 700; color: var(--text-secondary); width: 140px; text-align: center; border-right: 1px solid var(--input-border);">LEDs</th>
                    <th style="padding: 12px 12px; font-size: 12px; font-weight: 700; color: var(--text-secondary); width: 120px; text-align: center; border-right: 1px solid var(--input-border);">Strip Type</th>
                    <th style="padding: 12px 12px; font-size: 12px; font-weight: 700; color: var(--text-secondary); width: 110px; text-align: center; border-right: 1px solid var(--input-border);">API Source</th>
                    <th style="padding: 12px 12px; font-size: 12px; font-weight: 700; color: var(--text-secondary); width: 180px; border-right: 1px solid var(--input-border);">Effect Profile</th>
                    <th style="padding: 12px 12px; font-size: 12px; font-weight: 700; color: var(--text-secondary); width: 60px; text-align: center;">Actions</th>
                </tr>
            </thead>
            <tbody class="inline-segments-tbody">
                <!-- dynamic rows will be appended here -->
            </tbody>
        </table>

    </div>

    <!-- Actions -->
    <div style="display: flex; gap: 8px; justify-content: flex-start; padding: 6px 12px 0 12px; margin-top: 0; width: 100%;">
        <button type="button" class="btn-add-segment-inline btn-secondary" style="height: 28px; font-size: 12px; font-weight: 600; padding: 0 12px; width: auto;">
            + Add Output
        </button>
        <button type="button" class="btn-save-inline btn-primary" style="height: 28px; font-size: 12px; font-weight: 600; padding: 0 12px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; width: auto; background: var(--accent-blue);">
            <span class="btn-text">Save & Apply</span>
            <span class="spinner" style="width: 10px; height: 10px; border-width: 2px;"></span>
        </button>
    </div>
</div>
                    `;
                    const container = accordion.querySelector('.inline-settings-container');
                    const segmentsList = container.querySelector('.inline-segments-tbody');
                    const btnAddSegment = container.querySelector('.btn-add-segment-inline');
                    const btnSave = container.querySelector('.btn-save-inline');

                    function renderSubsegmentRowInline(parentRow, sub = {}) {
                        const subApiSource = sub.api_source || 'local';
                        const subEl = document.createElement('tr');
                        subEl.className = 'wled-subsegment-row-inline';
                        subEl.style.cssText = 'background: rgba(255, 255, 255, 0.015); border-bottom: 1px solid var(--input-border);';
                        
                        const parentTypeVal = parseInt(parentRow.querySelector('.wled-segment-type-inline').value, 10);
                        const profileCat = (parentTypeVal === 41) ? 'pwm-white' : 'ws281x';
                        const profilesMap = (loadedConfig.profiles && loadedConfig.profiles[profileCat]) || { 'Default': {} };
                        const profileNames = Object.keys(profilesMap);
                        const profileOptions = profileNames.map(pName => 
                            `<option value="${pName}" ${pName === (sub.profile || 'Default') ? 'selected' : ''}>${pName}</option>`
                        ).join('');

                        const parentPin = parentRow.querySelector('.wled-segment-pin-inline').value;

                        subEl.innerHTML = `
                            <td style="padding: 6px 12px 6px 28px; vertical-align: middle; border-right: 1px solid var(--input-border);">
                                <div style="display: flex; align-items: center; gap: 6px;">
                                    <span style="font-size: 14px; color: var(--text-secondary); font-weight: 500; white-space: nowrap;">↳ Segment 1:</span>
                                    <input type="text" class="wled-subsegment-name-inline seamless-name-input" value="${sub.name || ''}" placeholder="Name...">
                                </div>
                            </td>
                            <td style="padding: 6px 12px; text-align: center; vertical-align: middle; border-right: 1px solid var(--input-border);"></td>
                            <td style="padding: 6px 12px; text-align: center; vertical-align: middle; border-right: 1px solid var(--input-border);">
                                <div style="display: flex; align-items: center; gap: 4px; justify-content: center; font-size: 14px; color: var(--text-secondary);">
                                    <span>From</span>
                                    <input type="number" class="wled-subsegment-start-inline seamless-field" value="${sub.start !== undefined ? sub.start : 0}" style="width: 24px; height: 28px; font-size: 14px; padding: 0; border-radius: var(--radius-sm); text-align: center;">
                                    <span>to</span>
                                    <input type="number" class="wled-subsegment-stop-inline seamless-field" value="${sub.stop !== undefined ? sub.stop : 10}" style="width: 24px; height: 28px; font-size: 14px; padding: 0; border-radius: var(--radius-sm); text-align: center;">
                                </div>
                            </td>
                            <td style="padding: 6px 12px; vertical-align: middle; border-right: 1px solid var(--input-border);"></td>
                            <td style="padding: 6px 12px; vertical-align: middle; border-right: 1px solid var(--input-border);">
                                <select class="wled-subsegment-apisource-inline seamless-field" style="width: 100px; height: 28px; font-size: 14px; padding: 0 4px; border-radius: var(--radius-sm); text-align: center; text-align-last: center;">
                                    <option value="local" ${subApiSource === 'local' ? 'selected' : ''}>Local</option>
                                    <option value="online" ${subApiSource === 'online' ? 'selected' : ''}>Online</option>
                                    <option value="hybrid" ${subApiSource === 'hybrid' ? 'selected' : ''}>Hybrid</option>
                                    <option value="disabled" ${subApiSource === 'disabled' ? 'selected' : ''}>Disabled</option>
                                </select>
                            </td>
                            <td style="padding: 6px 12px; vertical-align: middle; border-right: 1px solid var(--input-border);">
                                <select class="wled-subsegment-profile-inline seamless-field" style="width: 100%; height: 28px; font-size: 14px; padding: 0 4px; border-radius: var(--radius-sm);">
                                    ${profileOptions}
                                </select>
                            </td>
                            <td style="padding: 6px 12px; text-align: center; vertical-align: middle;">
                                <div style="display: flex; align-items: center; justify-content: center; gap: 4px;">
                                    <button type="button" class="btn-edit-subsegment-profile-inline btn-profile-inline" title="Configure Lighting Profile Details">
                                        <svg class="icon" style="margin: 0; stroke: currentColor; width: 14px; height: 14px;" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
                                    </button>
                                    <button type="button" class="btn-remove-subsegment-inline btn-delete-inline" title="Delete Sub-segment">
                                        <svg class="icon" style="margin: 0; stroke: currentColor; width: 14px; height: 14px;" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                                    </button>
                                </div>
                            </td>
                        `;

                        subEl.querySelector('.btn-remove-subsegment-inline').addEventListener('click', () => {
                            subEl.remove();
                            updateSegmentLabelsInline();
                        });

                        let insertAfter = parentRow;
                        while (insertAfter.nextElementSibling && insertAfter.nextElementSibling.classList.contains('wled-subsegment-row-inline')) {
                            insertAfter = insertAfter.nextElementSibling;
                        }
                        insertAfter.after(subEl);
                        updateSegmentLabelsInline();
                    }

                    function renderSegmentRowInline(seg = {}) {
                        const apiSource = seg.api_source || 'local';
                        const pin = seg.pin !== undefined ? seg.pin : 16;
                        const len = seg.len !== undefined ? seg.len : 60;
                        const bootOn = seg.boot_on !== false;
                        const segProfile = seg.profile || 'Default';
                        const typeVal = seg.type !== undefined ? parseInt(seg.type, 10) : 22;

                        const rowEl = document.createElement('tr');
                        rowEl.className = 'wled-segment-row-inline';
                        rowEl.style.cssText = 'border-bottom: 1px solid var(--input-border);';
                        rowEl.dataset.bootOn = bootOn ? 'true' : 'false';
                        
                        const profileCat = (typeVal === 41) ? 'pwm-white' : 'ws281x';
                        const profilesMap = (loadedConfig.profiles && loadedConfig.profiles[profileCat]) || { 'Default': {} };
                        const profileNames = Object.keys(profilesMap);
                        const profileOptions = profileNames.map(pName => 
                            `<option value="${pName}" ${pName === segProfile ? 'selected' : ''}>${pName}</option>`
                        ).join('');

                        rowEl.innerHTML = `
                                       <td style="padding: 8px 12px; vertical-align: middle; border-right: 1px solid var(--input-border);">
                                <div style="display: flex; align-items: center; gap: 6px;">
                                    <span class="segment-label-inline" style="font-size: 14px; font-weight: 600; color: var(--text-secondary); white-space: nowrap;">#1</span>
                                    <input type="text" class="wled-segment-name-inline seamless-name-input" value="${seg.name || ''}" placeholder="Name...">
                                </div>
                            </td>
                            
                            <td style="padding: 8px 12px; text-align: center; vertical-align: middle; border-right: 1px solid var(--input-border);">
                                <input type="number" class="wled-segment-pin-inline seamless-field" value="${pin}" style="width: 64px; height: 28px; font-size: 14px; padding: 0 6px; border-radius: var(--radius-sm); text-align: center;">
                            </td>
                            
                            <td style="padding: 8px 12px; text-align: center; vertical-align: middle; border-right: 1px solid var(--input-border);">
                                <div style="display: flex; align-items: center; gap: 6px; justify-content: center;">
                                    <input type="number" class="wled-segment-len-inline seamless-field" value="${len}" style="width: 30px; height: 28px; font-size: 14px; padding: 0; border-radius: var(--radius-sm); text-align: center;">
                                    <button type="button" class="btn-split-segment-inline btn-secondary" style="height: 28px; width: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--input-border); background: transparent; cursor: pointer; border-radius: var(--radius-sm);" title="Split this strip into segments">
                                        <svg class="icon" style="margin: 0; stroke: currentColor; width: 14px; height: 14px;" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                            <circle cx="6" cy="6" r="3"/>
                                            <circle cx="6" cy="18" r="3"/>
                                            <line x1="9.8" y1="8.2" x2="20" y2="17"/>
                                            <line x1="9.8" y1="15.8" x2="20" y2="7"/>
                                        </svg>
                                    </button>
                                </div>
                            </td>

                             <td style="padding: 8px 12px; vertical-align: middle; border-right: 1px solid var(--input-border);">
                                <select class="wled-segment-type-inline seamless-field" style="width: 110px; height: 28px; font-size: 14px; padding: 0 6px; border-radius: var(--radius-sm); text-align: center; text-align-last: center;">
                                    ${getTypeDropdownOptions(typeVal)}
                                </select>
                            </td>

                            <td style="padding: 8px 12px; vertical-align: middle; border-right: 1px solid var(--input-border);">
                                <select class="wled-segment-apisource-inline seamless-field" style="width: 100px; height: 28px; font-size: 14px; padding: 0 6px; border-radius: var(--radius-sm); text-align: center; text-align-last: center;">
                                    <option value="local" ${apiSource === 'local' ? 'selected' : ''}>Local</option>
                                    <option value="online" ${apiSource === 'online' ? 'selected' : ''}>Online</option>
                                    <option value="hybrid" ${apiSource === 'hybrid' ? 'selected' : ''}>Hybrid</option>
                                    <option value="disabled" ${apiSource === 'disabled' ? 'selected' : ''}>Disabled</option>
                                </select>
                            </td>

                            <td style="padding: 8px 12px; vertical-align: middle; border-right: 1px solid var(--input-border);">
                                <select class="wled-segment-profile-inline seamless-field" style="width: 100%; height: 28px; font-size: 14px; padding: 0 6px; border-radius: var(--radius-sm);">
                                    ${profileOptions}
                                </select>
                            </td>
                            
                            <td style="padding: 8px 12px; text-align: center; vertical-align: middle;">
                                <div style="display: flex; align-items: center; justify-content: center; gap: 4px;">
                                    <button type="button" class="btn-edit-segment-profile-inline btn-profile-inline" title="Configure Lighting Profile Details">
                                        <svg class="icon" style="margin: 0; stroke: currentColor; width: 14px; height: 14px;" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
                                    </button>
                                    <button type="button" class="btn-remove-segment-inline btn-delete-inline" title="Delete Section">
                                        <svg class="icon" style="margin: 0; stroke: currentColor; width: 14px; height: 14px;" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                                    </button>
                                </div>
                            </td>
                        `;

                        const typeSelect = rowEl.querySelector('.wled-segment-type-inline');
                        const lenInput = rowEl.querySelector('.wled-segment-len-inline');
                        function updateLenDisabledInline() {
                            const btnSplit = rowEl.querySelector('.btn-split-segment-inline');
                            const typeVal = parseInt(typeSelect.value, 10);
                            
                            const profileSelect = rowEl.querySelector('.wled-segment-profile-inline');
                            if (profileSelect) {
                                const profileCat = (typeVal === 41) ? 'pwm-white' : 'ws281x';
                                const profilesMap = (loadedConfig.profiles && loadedConfig.profiles[profileCat]) || { 'Default': {} };
                                const prevVal = profileSelect.value;
                                profileSelect.innerHTML = '';
                                Object.keys(profilesMap).forEach(pName => {
                                    const opt = document.createElement('option');
                                    opt.value = pName;
                                    opt.textContent = pName;
                                    profileSelect.appendChild(opt);
                                });
                                if (Object.keys(profilesMap).includes(prevVal)) {
                                    profileSelect.value = prevVal;
                                }
                            }

                            if (typeVal === 41) {
                                lenInput.value = 1;
                                lenInput.disabled = true;
                                if (btnSplit) btnSplit.style.display = 'none';
                            } else {
                                lenInput.disabled = false;
                                if (btnSplit) btnSplit.style.display = 'inline-block';
                            }
                        }
                        typeSelect.addEventListener('change', updateLenDisabledInline);
                        updateLenDisabledInline();

                        rowEl.querySelector('.btn-remove-segment-inline').addEventListener('click', () => {
                            rowEl.remove();
                            updateSegmentLabelsInline();
                        });

                        const btnSplit = rowEl.querySelector('.btn-split-segment-inline');
                        btnSplit.addEventListener('click', () => {
                            const parentLen = parseInt(rowEl.querySelector('.wled-segment-len-inline').value, 10) || 60;
                            const nextSib = rowEl.nextElementSibling;
                            const hasSubsegments = nextSib && nextSib.classList.contains('wled-subsegment-row-inline');
                            
                            if (hasSubsegments) {
                                // Subsegments already exist: find the last subsegment to offset from
                                let lastSub = nextSib;
                                while (lastSub.nextElementSibling && lastSub.nextElementSibling.classList.contains('wled-subsegment-row-inline')) {
                                    lastSub = lastSub.nextElementSibling;
                                }
                                const lastStopVal = parseInt(lastSub.querySelector('.wled-subsegment-stop-inline').value, 10) || parentLen;
                                renderSubsegmentRowInline(rowEl, { start: lastStopVal, stop: Math.min(parentLen, lastStopVal + 10), profile: 'Default', boot_on: true });
                            } else {
                                // First split: create the minimum of two subsegments
                                renderSubsegmentRowInline(rowEl, { start: 0, stop: Math.round(parentLen / 2), profile: 'Default', boot_on: true });
                                renderSubsegmentRowInline(rowEl, { start: Math.round(parentLen / 2), stop: parentLen, profile: 'Default', boot_on: true });
                            }
                            updateSegmentLabelsInline();
                        });

                        segmentsList.appendChild(rowEl);

                        if (seg.is_split && seg.sub_segments) {
                            seg.sub_segments.forEach(sub => {
                                renderSubsegmentRowInline(rowEl, sub);
                            });
                        }

                        updateSegmentLabelsInline();
                    }

                    function updateSegmentLabelsInline() {
                        const rows = segmentsList.children;
                        let flatIdx = 0;
                        
                        for (let i = 0; i < rows.length; i++) {
                            const r = rows[i];
                            if (r.classList.contains('wled-segment-row-inline')) {
                                const parentIdx = Array.from(segmentsList.querySelectorAll('.wled-segment-row-inline')).indexOf(r);
                                const lbl = r.querySelector('.segment-label-inline');
                                if (lbl) {
                                    lbl.textContent = `#${parentIdx + 1}`;
                                    lbl.style.color = 'var(--accent-blue)';
                                    lbl.style.fontWeight = '700';
                                }
                                
                                // Parent strip styling: dark grey background
                                r.style.background = 'rgba(0, 0, 0, 0.25)';
                                if (parentIdx > 0) {
                                    r.style.borderTop = '2px solid rgba(255, 255, 255, 0.12)';
                                } else {
                                    r.style.borderTop = 'none';
                                }
                                
                                const hasSub = r.nextElementSibling && r.nextElementSibling.classList.contains('wled-subsegment-row-inline');
                                
                                const profileContainer = r.querySelector('.wled-segment-profile-inline');
                                const profileBtn = r.querySelector('.btn-edit-segment-profile-inline');
                                const apiSourceContainer = r.querySelector('.wled-segment-apisource-inline');
                                
                                if (hasSub) {
                                    if (profileContainer) profileContainer.style.display = 'none';
                                    if (profileBtn) profileBtn.style.display = 'none';
                                    if (apiSourceContainer) apiSourceContainer.style.display = 'none';
                                } else {
                                    if (profileContainer) profileContainer.style.display = 'inline-block';
                                    if (profileBtn) profileBtn.style.display = 'inline-flex';
                                    if (apiSourceContainer) apiSourceContainer.style.display = 'inline-block';
                                    
                                    const currentIdx = flatIdx;
                                    if (profileBtn && device.name) {
                                        profileBtn.onclick = () => {
                                            navigateTo('/menu/' + encodeURIComponent(device.name).replace(/%20/g, '+') + '/section' + (currentIdx + 1));
                                        };
                                    }
                                    flatIdx++;
                                }
                            } else if (r.classList.contains('wled-subsegment-row-inline')) {
                                let parentRow = r.previousElementSibling;
                                while (parentRow && !parentRow.classList.contains('wled-segment-row-inline')) {
                                    parentRow = parentRow.previousElementSibling;
                                }
                                const parentIdx = Array.from(segmentsList.querySelectorAll('.wled-segment-row-inline')).indexOf(parentRow);
                                
                                let subIdx = 1;
                                let prev = r.previousElementSibling;
                                while (prev && prev.classList.contains('wled-subsegment-row-inline')) {
                                    subIdx++;
                                    prev = prev.previousElementSibling;
                                }
                                
                                // Child subsegment styling: light grey background
                                r.style.background = 'rgba(255, 255, 255, 0.015)';
                                const firstCell = r.querySelector('td');
                                if (firstCell) {
                                    firstCell.style.borderLeft = '3px solid var(--input-border)';
                                    firstCell.style.paddingLeft = '24px';
                                }
                                
                                const lbl = r.querySelector('span');
                                if (lbl) {
                                    lbl.textContent = `↳ Segment ${subIdx}:`;
                                    lbl.style.color = 'var(--text-secondary)';
                                    lbl.style.fontWeight = '500';
                                }
                                
                                const btnEdit = r.querySelector('.btn-edit-subsegment-profile-inline');
                                const currentIdx = flatIdx;
                                if (btnEdit && device.name) {
                                    btnEdit.onclick = () => {
                                        navigateTo('/menu/' + encodeURIComponent(device.name).replace(/%20/g, '+') + '/section' + (currentIdx + 1));
                                    };
                                }
                                flatIdx++;
                            }
                        }
                    }

                    btnAddSegment.addEventListener('click', () => {
                        renderSegmentRowInline({ pin: 16, len: 60, boot_on: true });
                    });

                    if (wledData.status === 'success' && wledData.segments && wledData.segments.length > 0) {
                        wledData.segments.forEach(seg => {
                            renderSegmentRowInline(seg);
                        });
                    } else {
                        renderSegmentRowInline({ pin: 16, len: 60, boot_on: true });
                    }

                    btnSave.addEventListener('click', async () => {
                        btnSave.classList.add('loading');
                        btnSave.disabled = true;

                        try {
                            const segmentRows = segmentsList.querySelectorAll('.wled-segment-row-inline');
                            const segments = [];
                            segmentRows.forEach(sr => {
                                const pinVal = parseInt(sr.querySelector('.wled-segment-pin-inline').value, 10);
                                const lenVal = parseInt(sr.querySelector('.wled-segment-len-inline').value, 10);
                                const typeVal = parseInt(sr.querySelector('.wled-segment-type-inline').value, 10);
                                const profileVal = sr.querySelector('.wled-segment-profile-inline').value;
                                const apiSourceVal = sr.querySelector('.wled-segment-apisource-inline').value;
                                const bootOnVal = sr.dataset.bootOn !== 'false';
                                const nameVal = sr.querySelector('.wled-segment-name-inline').value.trim();

                                let isSplit = false;
                                const subSegments = [];
                                
                                let nextSib = sr.nextElementSibling;
                                while (nextSib && nextSib.classList.contains('wled-subsegment-row-inline')) {
                                    isSplit = true;
                                    const subStart = parseInt(nextSib.querySelector('.wled-subsegment-start-inline').value, 10) || 0;
                                    const subStop = parseInt(nextSib.querySelector('.wled-subsegment-stop-inline').value, 10) || lenVal;
                                    const subProfile = nextSib.querySelector('.wled-subsegment-profile-inline').value || 'Default';
                                    const subApiSourceVal = nextSib.querySelector('.wled-subsegment-apisource-inline').value;
                                    const subName = nextSib.querySelector('.wled-subsegment-name-inline').value.trim();
                                    
                                    subSegments.push({
                                        start: subStart,
                                        stop: subStop,
                                        profile: subProfile,
                                        api_source: subApiSourceVal,
                                        name: subName
                                    });
                                    nextSib = nextSib.nextElementSibling;
                                }

                                if (!isNaN(pinVal) && !isNaN(lenVal)) {
                                    segments.push({
                                        pin: pinVal,
                                        len: lenVal,
                                        type: typeVal,
                                        is_split: isSplit,
                                        sub_segments: subSegments,
                                        profile: profileVal,
                                        api_source: apiSourceVal,
                                        boot_on: bootOnVal,
                                        name: nameVal
                                    });
                                }
                            });

                            if (segments.length === 0) {
                                throw new Error('Please configure at least one strip / section.');
                            }

                            const hwResponse = await fetch('/api/wled/config', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ ip: device.ip, segments })
                            });
                            if (!hwResponse.ok) throw new Error('Failed to save WLED hardware settings');
                            const hwResult = await hwResponse.json();
                            if (hwResult.status !== 'success') throw new Error(hwResult.message);

                            device.segments = segments;
                            const apiCellEl = row.querySelector('.device-cell-api');
                            if (apiCellEl) apiCellEl.innerHTML = getApiBadgeHTML(device);
                            showToast('Strips saved successfully & WLED rebooted!', 'success');
                            
                            chevronToggle.click();

                        } catch (err) {
                            console.error(err);
                            showToast(err.message || 'Failed to save settings.', 'error');
                        } finally {
                            btnSave.classList.remove('loading');
                            btnSave.disabled = false;
                        }
                    });



                    settingsLoaded = true;

                } catch (err) {
                    console.error(err);
                    accordion.innerHTML = `<div style="font-size: 12px; color: var(--accent-red); padding: 10px 0;">Error: ${err.message}</div>`;
                }
            }

            chevronToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                isOpen = !isOpen;
                chevronToggle.dataset.isOpen = isOpen ? 'true' : 'false';
                if (isOpen) {
                    accordion.style.display = 'flex';
                    chevronToggle.style.transform = 'rotate(-180deg)';
                    loadAccordionSettings();
                } else {
                    accordion.style.display = 'none';
                    chevronToggle.style.transform = 'rotate(0deg)';
                }
            });

            // Ping this device (WiFi only)
            if (device.connection_type !== 'serial' && device.ip) {
                pingDevice(device.ip, statusDot);
            } else {
                statusDot.className = 'device-status-dot';
                statusDot.title = 'Serial — no ping';

            }
        });

        devicesTableContainer.appendChild(table);
    }

    async function pingDevice(ip, dotEl) {
        dotEl.className = 'device-status-dot status-checking';
        try {
            const resp = await fetch(`/api/wled/validate_ip?ip=${encodeURIComponent(ip)}`);
            if (resp.ok) {
                const data = await resp.json();
                if (data.status === 'success') {
                    dotEl.className = 'device-status-dot status-online';
                    dotEl.title = 'Online';
                    return;
                }
            }
            throw new Error('offline');
        } catch {
            dotEl.className = 'device-status-dot status-offline';
            dotEl.title = 'Offline';
        }
    }

    function startInlineEdit(spanEl, deviceId, field, currentValue) {
        // Prevent double editing
        if (spanEl.parentElement.querySelector('.device-inline-input')) return;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'device-inline-input';
        input.value = currentValue;

        spanEl.style.display = 'none';
        spanEl.parentElement.appendChild(input);
        input.focus();
        input.select();

        const commit = async () => {
            const newVal = input.value.trim();
            spanEl.style.display = '';
            input.remove();
            if (newVal === currentValue || newVal === '') return;

            try {
                const resp = await fetch(`/api/devices/${deviceId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ [field]: newVal })
                });
                const data = await resp.json();
                if (data.status !== 'success') throw new Error(data.message);
                // Update local state
                const dev = devicesData.find(d => d.id === deviceId);
                if (dev) dev[field] = newVal;
                spanEl.textContent = newVal;
                showToast('Device updated.', 'success');
                // If this changed the active device's IP, update loadedConfig
                if (field === 'ip' && dev && dev.ip === loadedConfig.wifi_ip) {
                    loadedConfig.wifi_ip = newVal;
                }
            } catch (err) {
                showToast(err.message || 'Failed to update device.', 'error');
            }
        };

        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { input.blur(); }
            if (e.key === 'Escape') {
                spanEl.style.display = '';
                input.remove();
            }
        });
    }

    async function configureDevice(device, navigate = true) {
        // Set this device as the active connection in config
        // Also switch to the device's assigned profile if set
        const targetProfile = device.profile || loadedConfig.current_profile || 'Default';
        const payload = {
            connection_type: device.connection_type === 'serial' ? 'serial' : 'wifi',
            wifi_ip: device.connection_type === 'wifi' ? device.ip : loadedConfig.wifi_ip,
            manual_port: device.connection_type === 'serial' ? device.ip : loadedConfig.manual_port,
            autodarts_online_enabled: device.api_type === 'online',
            autodarts_websocket_enabled: device.api_type === 'local',
            current_profile: targetProfile
        };

        try {
            const resp = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!resp.ok) throw new Error('Failed to set active device');
            Object.assign(loadedConfig, payload);
            showToast(`Now controlling "${device.name}" · Profile: ${targetProfile}`, 'success');
            if (navigate) {
                navigateTo('/menu');
            }
        } catch (err) {
            showToast(err.message || 'Failed to switch device.', 'error');
            throw err;
        }
    }

    function removeDevice(deviceId, deviceName) {
        showConfirm('Remove Device', `Remove device "${deviceName || 'this device'}"?`, 'Yes, Remove', async () => {
            try {
                const resp = await fetch(`/api/devices/${deviceId}`, { method: 'DELETE' });
                const data = await resp.json();
                if (data.status !== 'success') throw new Error(data.message);
                devicesData = devicesData.filter(d => d.id !== deviceId);
                renderDevicesTable();
                showToast(`Device removed.`, 'success');
            } catch (err) {
                console.error(err);
                showToast(err.message || 'Failed to remove device.', 'error');
            }
        }, true);
    }

    // Add device form trigger
    if (btnAddDevice) {
        btnAddDevice.addEventListener('click', () => {
            showPrompt("Add WLED Device", "", "", async (ip) => {
                if (!ip) return;
                const trimmedIp = ip.trim();
                if (!trimmedIp) {
                    showToast('Please enter a valid IP address.', 'error');
                    return;
                }
                
                try {
                    const resp = await fetch('/api/devices', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: "", ip: trimmedIp, connection_type: "wifi", api_type: "local" })
                    });
                    const data = await resp.json();
                    if (data.status !== 'success') throw new Error(data.message);
                    devicesData.push(data.device);
                    renderDevicesTable();
                    showToast(`Device "${data.device.name}" added!`, 'success');
                } catch (err) {
                    showToast(err.message || 'Failed to add device.', 'error');
                }
            });
        });
    }

    // Scan for devices on the network using unified scanner modal
    if (btnScanDevices) {
        btnScanDevices.addEventListener('click', () => navigateTo('/devices/scan'));
    }



    // 🏠 header button wiring
    if (btnHome) {
        btnHome.addEventListener('click', () => {
            if (hasUnsavedChanges()) {
                showUnsavedChangesModal(
                    async () => {
                        await saveAllSettings();
                        navigateTo('/devices');
                    },
                    () => {
                        navigateTo('/devices');
                    }
                );
            } else {
                navigateTo('/devices');
            }
        });
    }

    // Initial load
    loadConfig();
});
