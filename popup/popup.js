// popup/popup.js
// Popup controller with strict country toggle + live queue + honest UI
// Developed by Keyn Labs
// Version 5.3.0
// ============================================================================
// CHANGELOG v5.3.0
//   • CRM button — opens CRM in new tab
//   • Fixed misplaced CRM button code
// ============================================================================

console.log('BuyLead Assistant Popup v5.3.0');

var browserAPI = (typeof browser !== 'undefined') ? browser : chrome;

var statusUpdateInterval = null;
var supabaseEnabled = true;
var confirmationAnswer = 'yes';
var autoMinimize = true;
var purchaseAction = 'close';
var strictCountryMode = false;
var strictCountryRejectUnknown = true;
var allowedCountries = ['IN'];

var _pendingLocal = {
    supabase: null,
    confirmation: null,
    autoMinimize: null,
    purchase: null,
    strictCountry: null
};

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', function() {
    // 1. Immediately wire all event listeners (0ms click response)
    setupEventListeners();
    // 2. Immediately load settings and apply saved mode UI
    loadAllSettings();
    // 3. Immediately query status and begin polling
    updateStatus();
    statusUpdateInterval = setInterval(updateStatus, 800);
    // 4. Ensure default mode without delaying UI
    initializeDefaultMode();
});

function initializeDefaultMode() {
    return new Promise(function(resolve) {
        browserAPI.storage.local.get(
            ['mode', 'userSetMode', 'initialized_v620'],
            function(result) {
                var effectiveMode = result.mode || 'AUTOMATIC';
                if (!result.mode || !result.initialized_v620) {
                    browserAPI.storage.local.set({
                        mode: effectiveMode,
                        userSetMode: !!result.userSetMode,
                        initialized_v620: true
                    }, function() {
                        setModeInContent(effectiveMode).finally(function() { resolve(); });
                    });
                    return;
                }
                setModeInContent(effectiveMode).finally(function() { resolve(); });
            }
        );
    });
}

// ============================================================
// LOAD ALL SETTINGS
// ============================================================
function loadAllSettings() {
    browserAPI.storage.local.get([
        'mode',
        'supabaseEnabled', 'confirmationAnswer', 'autoMinimize',
        'strictCountryMode', 'allowedCountries', 'strictCountryRejectUnknown',
        'maxPerMinute', 'cooldownMs'
    ], function(result) {
        if (result.mode) applyModeUI(result.mode);
        supabaseEnabled = result.supabaseEnabled !== false;
        updateSupabaseUI(supabaseEnabled);

        confirmationAnswer = result.confirmationAnswer || 'yes';
        updateConfirmationUI(confirmationAnswer);

        autoMinimize = result.autoMinimize !== false;
        updateAutoMinimizeUI(autoMinimize);

        purchaseAction = result.purchaseAction || 'close';
        updatePurchaseUI(purchaseAction);

        strictCountryMode = result.strictCountryMode === true;
        strictCountryRejectUnknown = result.strictCountryRejectUnknown !== false;
        allowedCountries = result.allowedCountries || ['IN'];
        updateStrictCountryUI(strictCountryMode, allowedCountries, strictCountryRejectUnknown);

        updateSpeedUI(result.maxPerMinute, result.cooldownMs);
    });
}

function updateSupabaseUI(enabled) {
    var toggle    = document.getElementById('supabaseToggle');
    var label     = document.getElementById('connectionLabel');
    var status    = document.getElementById('connectionStatus');
    var container = document.getElementById('connectionToggle');
    if (toggle) toggle.checked = enabled;
    if (!label || !status) return;

    if (enabled) {
        label.innerHTML = 'Supabase: <strong>ON</strong>';
        status.textContent = 'Connected to CRM';
        if (container) container.classList.remove('offline');
    } else {
        label.innerHTML = 'Supabase: <strong>OFF</strong>';
        status.textContent = 'Offline mode • Local keywords only';
        if (container) container.classList.add('offline');
    }
}

function updateConfirmationUI(answer) {
    var toggle = document.getElementById('confirmToggle');
    var label  = document.getElementById('confirmLabel');
    var status = document.getElementById('confirmStatus');
    if (toggle) toggle.checked = (answer === 'yes');
    if (!label || !status) return;

    if (answer === 'yes') {
        label.innerHTML = 'Old Lead Confirmation: <strong>YES</strong>';
        status.textContent = 'Auto-answer to "Do you want to contact?"';
    } else {
        label.innerHTML = 'Old Lead Confirmation: <strong>NO</strong>';
        status.textContent = 'Will auto-skip old leads';
    }
}

function updateAutoMinimizeUI(enabled) {
    var toggle = document.getElementById('autoMinToggle');
    var label  = document.getElementById('autoMinLabel');
    var status = document.getElementById('autoMinStatus');
    if (toggle) toggle.checked = enabled;
    if (!label || !status) return;

    if (enabled) {
        label.innerHTML = 'Auto-Handle Popups: <strong>ON</strong>';
        status.textContent = 'Popup handled automatically after acquisition';
    } else {
        label.innerHTML = 'Auto-Handle Popups: <strong>OFF</strong>';
        status.textContent = 'Popups must be closed manually';
    }
}

function updatePurchaseUI(action) {
    var toggle = document.getElementById('purchaseToggle');
    var label  = document.getElementById('purchaseLabel');
    var status = document.getElementById('purchaseStatus');
    if (toggle) toggle.checked = (action === 'close');
    if (!label || !status) return;

    if (action === 'close') {
        label.innerHTML = 'Purchase Modal: <strong>Auto-Close</strong>';
        status.textContent = 'Auto-close and continue';
    } else {
        label.innerHTML = 'Purchase Modal: <strong>Stop</strong>';
        status.textContent = 'Pause queue when purchase prompt appears';
    }
}

function updateStrictCountryUI(enabled, countries, rejectUnknown) {
    var toggle = document.getElementById('strictCountryToggle');
    var label  = document.getElementById('strictCountryLabel');
    var status = document.getElementById('strictCountryStatus');
    if (!toggle) return;

    toggle.checked = enabled;
    if (!label || !status) return;

    if (enabled) {
        label.innerHTML = 'Strict Country: <strong>ON</strong>';
        var list = (countries || []).join(', ') || '—';
        status.textContent = 'Only: ' + list + (rejectUnknown ? ' (unknown rejected)' : '');
    } else {
        label.innerHTML = 'Strict Country: <strong>OFF</strong>';
        status.textContent = 'All countries accepted';
    }
}

function updateSpeedUI(perMinute, cooldownMs) {
    var el = document.getElementById('speedText');
    if (!el) return;
    var pm = perMinute != null ? perMinute : 60;
    el.textContent = pm + '/min';
}

// ============================================================
// EVENT LISTENERS
// ============================================================


function setupEventListeners() {
    // Mode buttons (ultra-responsive 1-click handler)
    document.querySelectorAll('.mode-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            var targetBtn = this.closest('.mode-btn') || this;
            var mode = targetBtn.getAttribute('data-mode') || (targetBtn.dataset && targetBtn.dataset.mode);
            if (mode) setMode(mode);
        });
    });

    // Supabase toggle
    var sbToggle = document.getElementById('supabaseToggle');
    if (sbToggle) {
        sbToggle.addEventListener('change', function() {
            var enabled = this.checked;
            supabaseEnabled = enabled;
            _pendingLocal.supabase = enabled;
            browserAPI.storage.local.set({ supabaseEnabled: enabled }, function() {
                updateSupabaseUI(enabled);
                showToast(enabled ? 'Supabase ON - CRM mode' : 'Supabase OFF - Offline mode', enabled ? 'success' : 'warning');
                sendToContent({ action: 'TOGGLE_SUPABASE', enabled: enabled }, function() {
                    _pendingLocal.supabase = null;
                });
            });
        });
    }

    // Strict country toggle
    var strictToggle = document.getElementById('strictCountryToggle');
    if (strictToggle) {
        strictToggle.addEventListener('change', function() {
            var enabled = this.checked;
            if (enabled && (!allowedCountries || allowedCountries.length === 0)) {
                this.checked = false;
                showToast('Configure countries in Config first', 'warning');
                return;
            }
            strictCountryMode = enabled;
            _pendingLocal.strictCountry = enabled;
            browserAPI.storage.local.set({ strictCountryMode: enabled }, function() {
                updateStrictCountryUI(enabled, allowedCountries, strictCountryRejectUnknown);
                browserAPI.runtime.sendMessage({
                    action: 'SET_STRICT_COUNTRY',
                    enabled: enabled,
                    countries: allowedCountries,
                    rejectUnknown: strictCountryRejectUnknown
                });
                showToast(
                    enabled ? 'Strict: ' + allowedCountries.join(', ') : 'Strict country OFF',
                    'success'
                );
                setTimeout(function() { _pendingLocal.strictCountry = null; }, 800);
            });
        });
    }

    // Confirmation toggle
    var confirmToggle = document.getElementById('confirmToggle');
    if (confirmToggle) {
        confirmToggle.addEventListener('change', function() {
            var answer = this.checked ? 'yes' : 'no';
            confirmationAnswer = answer;
            _pendingLocal.confirmation = answer;
            browserAPI.storage.local.set({ confirmationAnswer: answer }, function() {
                updateConfirmationUI(answer);
                showToast('Old lead answer: ' + answer.toUpperCase(), answer === 'yes' ? 'success' : 'warning');
                sendToContent({ action: 'SET_CONFIRMATION_ANSWER', answer: answer }, function() {
                    _pendingLocal.confirmation = null;
                });
            });
        });
    }

    // Auto-minimize toggle
    var autoMinToggle = document.getElementById('autoMinToggle');
    if (autoMinToggle) {
        autoMinToggle.addEventListener('change', function() {
            var enabled = this.checked;
            autoMinimize = enabled;
            _pendingLocal.autoMinimize = enabled;
            browserAPI.storage.local.set({ autoMinimize: enabled }, function() {
                updateAutoMinimizeUI(enabled);
                showToast(enabled ? 'Auto-popup ON' : 'Auto-popup OFF', enabled ? 'success' : 'warning');
                sendToContent({ action: 'SET_AUTO_MINIMIZE', enabled: enabled }, function() {
                    _pendingLocal.autoMinimize = null;
                });
            });
        });
    }



    // Purchase toggle
    var purchaseToggle = document.getElementById('purchaseToggle');
    if (purchaseToggle) {
        purchaseToggle.addEventListener('change', function() {
            var action = this.checked ? 'close' : 'stop';
            purchaseAction = action;
            _pendingLocal.purchase = action;
            browserAPI.storage.local.set({ purchaseAction: action }, function() {
                updatePurchaseUI(action);
                showToast(
                    action === 'close' ? 'Purchase: Auto-close' : 'Purchase: Stop queue',
                    action === 'close' ? 'success' : 'warning'
                );
                sendToContent({ action: 'SET_PURCHASE_ACTION', purchaseAction: action }, function() {
                    _pendingLocal.purchase = null;
                });
            });
        });
    }

    // Emergency stop
    var emergencyBtn = document.getElementById('emergencyBtn');
    if (emergencyBtn) {
        emergencyBtn.addEventListener('click', function() {
            if (confirm('Emergency Stop - Stop all automation?')) {
                sendToContent({ action: 'EMERGENCY_STOP' });
                showToast('Emergency stop activated', 'error');
            }
        });
    }

    // Resume
    var resumeBtn = document.getElementById('resumeBtn');
    if (resumeBtn) {
        resumeBtn.addEventListener('click', function() {
            sendToContent({ action: 'RESUME' });
            showToast('Resumed', 'success');
        });
    }

    // Config link
    var configLink = document.getElementById('configLink');
    if (configLink) {
        configLink.addEventListener('click', function() {
            browserAPI.tabs.create({ url: browserAPI.runtime.getURL('config/index.html') });
        });
    }

    // Debug link
    var debugLink = document.getElementById('debugLink');
    if (debugLink) {
        debugLink.addEventListener('click', function() {
            browserAPI.tabs.create({ url: browserAPI.runtime.getURL('debug/index.html') });
        });
    }

    // CRM Link
    var crmBtn = document.getElementById('crmBtn');
    if (crmBtn) {
        crmBtn.addEventListener('click', function() {
            browserAPI.tabs.create({ url: 'https://leadsync-tau-sand.vercel.app/' });
        });
    }

    // Stats toggle (expand/collapse)
    var statsSummary = document.getElementById('statsSummary');
    if (statsSummary) {
        statsSummary.addEventListener('click', function() {
            var compact = document.getElementById('statsCompact');
            var expanded = document.getElementById('statsExpanded');
            if (!compact || !expanded) return;
            var isOpen = compact.classList.toggle('open');
            expanded.style.display = isOpen ? 'block' : 'none';
        });
    }
}

// ============================================================
// MODE
// ============================================================
var _currentMode = "AUTOMATIC";
var _lastModeChangeTime = 0;

function applyModeUI(mode) {
    if (!mode) return;
    _currentMode = mode;

    var buttons = document.querySelectorAll(".mode-btn");
    for (var i = 0; i < buttons.length; i++) {
        var b = buttons[i];
        var m = b.getAttribute("data-mode") || (b.dataset && b.dataset.mode);
        if (m === mode) {
            b.classList.add("active");
        } else {
            b.classList.remove("active");
        }
    }

    var badge = document.getElementById("modeBadge");
    if (badge) {
        badge.textContent = mode;
        badge.className = "badge badge-" + mode.toLowerCase().replace("_", "");
    }

    var autoNotice = document.getElementById("autoNotice");
    if (autoNotice) {
        if (mode === "AUTOMATIC") {
            autoNotice.classList.remove("hidden");
        } else {
            autoNotice.classList.add("hidden");
        }
    }

    var safetyEl = document.getElementById("safetyStatus");
    if (safetyEl) {
        if (mode === "MONITOR") { safetyEl.textContent = "Monitor"; safetyEl.style.color = "#71717a"; }
        else if (mode === "DRY_RUN") { safetyEl.textContent = "Dry Run"; safetyEl.style.color = "#d97706"; }
        else if (mode === "AUTOMATIC") { safetyEl.textContent = "Auto"; safetyEl.style.color = "#18181b"; }
        else if (mode === "ASSISTED") { safetyEl.textContent = "Assisted"; safetyEl.style.color = "#0d9488"; }
    }
}

function setMode(mode) {
    if (!mode) return;

    // 1. INSTANT OPTIMISTIC UI (0ms latency — instant 1-click visual response)
    _currentMode = mode;
    _lastModeChangeTime = Date.now();
    applyModeUI(mode);
    showToast('Mode: ' + mode, 'success');

    // 2. Persist to storage immediately
    browserAPI.storage.local.set({ mode: mode, userSetMode: true });

    // 3. Notify content script & background
    setModeInContent(mode);
}

function setModeInContent(mode) {
    return new Promise(function(resolve) {
        var settled = false;
        var timer = setTimeout(function() {
            if (settled) return;
            settled = true;
            browserAPI.runtime.sendMessage({ action: 'SET_MODE', mode: mode }, function(bgResponse) {
                resolve(bgResponse || { success: false, timeout: true });
            });
        }, 400);

        browserAPI.tabs.query({ active: true, currentWindow: true }, function(tabs) {
            if (!tabs || !tabs[0]) {
                clearTimeout(timer);
                if (!settled) { settled = true; resolve({ success: false }); }
                return;
            }
            browserAPI.tabs.sendMessage(tabs[0].id, { action: 'SET_MODE', mode: mode }, function(response) {
                clearTimeout(timer);
                if (settled) return;
                settled = true;
                if (browserAPI.runtime.lastError) {
                    browserAPI.runtime.sendMessage({ action: 'SET_MODE', mode: mode }, function(bgResponse) {
                        resolve(bgResponse);
                    });
                } else {
                    resolve(response || { success: true });
                }
            });
        });
    });
}

// ============================================================
// SEND TO CONTENT
// ============================================================
function sendToContent(message, callback) {
    callback = callback || function() {};

    var settled = false;
    var timer = setTimeout(function() {
        if (settled) return;
        settled = true;
        browserAPI.runtime.sendMessage(message, function(response) {
            if (browserAPI.runtime.lastError) {
                callback({ success: false, error: 'no receiver', timeout: true });
            } else {
                callback(response);
            }
        });
    }, 400);

    browserAPI.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        if (!tabs || !tabs[0]) {
            clearTimeout(timer);
            if (settled) return;
            settled = true;
            callback({ success: false, error: 'No active tab' });
            return;
        }
        browserAPI.tabs.sendMessage(tabs[0].id, message, function(response) {
            clearTimeout(timer);
            if (settled) return;
            settled = true;
            if (browserAPI.runtime.lastError) {
                browserAPI.runtime.sendMessage(message, function(bgResponse) {
                    if (browserAPI.runtime.lastError) {
                        callback({ success: false, error: 'no receiver' });
                    } else {
                        callback(bgResponse);
                    }
                });
            } else {
                callback(response);
            }
        });
    });
}

// ============================================================
// STATUS UPDATE
// ============================================================
function updateStatus() {
    sendToContent({ action: 'GET_STATUS' }, function(response) {
        if (!response || !response.success) {
            showDisconnected();
            return;
        }

        var data = response;
        var currentMode = data.mode || _currentMode || 'AUTOMATIC';

        // Anti-race guard: If user recently switched mode within the last 2500ms, do NOT let a stale poll revert it!
        if (_lastModeChangeTime && (Date.now() - _lastModeChangeTime < 2500)) {
            currentMode = _currentMode;
        } else {
            _currentMode = currentMode;
        }
        applyModeUI(currentMode);

        // Mode badge
        var badge = document.getElementById('modeBadge');
        if (badge) {
            badge.textContent = currentMode;
            badge.className = 'badge badge-' + currentMode.toLowerCase().replace('_', '');
            if (data.safety && data.safety.emergencyStop) {
                badge.className = 'badge badge-emergency';
                badge.textContent = 'STOP';
            }
        }

        // Status text
        var statusText = document.getElementById('statusText');
        var isRunning = data.scanner && data.scanner.running;
        if (statusText) {
            if (data.safety && data.safety.emergencyStop) statusText.textContent = 'Emergency Stop';
            else if (isRunning && currentMode === 'AUTOMATIC') statusText.textContent = 'Auto-Acquiring';
            else if (isRunning) statusText.textContent = 'Running';
            else statusText.textContent = 'Stopped';
        }

        // Queue
        var queueEl = document.getElementById('queueStatus');
        if (queueEl) {
            var q = data.queue || {};
            var queueStr = (q.size || 0);
            if (q.processing) queueStr += ' (1 active)';
            queueEl.textContent = queueStr;
        }

        // Safety
        var safetyEl = document.getElementById('safetyStatus');
        if (safetyEl) {
            if (data.safety && data.safety.emergencyStop) { safetyEl.textContent = 'EMERGENCY'; safetyEl.style.color = '#dc2626'; }
            else if (data.safety && data.safety.cooldown) { safetyEl.textContent = 'Cooldown'; safetyEl.style.color = '#d97706'; }
            else if (currentMode === 'MONITOR') { safetyEl.textContent = 'Monitor'; safetyEl.style.color = '#71717a'; }
            else if (currentMode === 'DRY_RUN') { safetyEl.textContent = 'Dry Run'; safetyEl.style.color = '#d97706'; }
            else if (currentMode === 'AUTOMATIC') { safetyEl.textContent = 'Auto'; safetyEl.style.color = '#18181b'; }
            else { safetyEl.textContent = 'OK'; safetyEl.style.color = '#059669'; }
        }

        // Auto notice
        var autoNotice = document.getElementById('autoNotice');
        if (autoNotice) {
            if (currentMode === 'AUTOMATIC' && !(data.safety && data.safety.emergencyStop)) {
                autoNotice.classList.remove('hidden');
            } else {
                autoNotice.classList.add('hidden');
            }
        }

        // Acquired count
        var acquiredEl = document.getElementById('acquiredCount');
        if (acquiredEl) acquiredEl.textContent = (data.stats && data.stats.acquired) || 0;

        // Stats
        if (data.stats) {
            setText('statDiscovered',     data.stats.discovered || 0);
            setText('statValidated',      data.stats.validated || 0);
            setText('statScored',         data.stats.scored || 0);
            setText('statQueued',         data.stats.queued || 0);
            setText('statAcquired',       data.stats.acquired || 0);
            setText('statRejected',       data.stats.rejected || 0);
            setText('statCountryBlocked', data.stats.countryBlocked || 0);
            setText('statDuplicate',      data.stats.duplicate || 0);
            setText('statFailed',         data.stats.failed || 0);
            setText('statPopups',         data.stats.popupsHandled || data.popupsHandled || 0);

            var inlineEl = document.getElementById('statsInline');
            if (inlineEl) {
                inlineEl.textContent = (data.stats.discovered || 0) + ' scanned · ' + (data.stats.acquired || 0) + ' acquired';
            }
        }

        // Speed row
        if (data.safety && data.safety.limits) {
            updateSpeedUI(data.safety.limits.perMinute, data.safety.cooldownMs);
        }

        // Remote state sync
        if (data.supabaseEnabled !== undefined &&
            _pendingLocal.supabase === null &&
            data.supabaseEnabled !== supabaseEnabled) {
            supabaseEnabled = data.supabaseEnabled;
            updateSupabaseUI(supabaseEnabled);
        }
        if (data.confirmationAnswer !== undefined &&
            _pendingLocal.confirmation === null &&
            data.confirmationAnswer !== confirmationAnswer) {
            confirmationAnswer = data.confirmationAnswer;
            updateConfirmationUI(confirmationAnswer);
        }
        if (data.autoMinimize !== undefined &&
            _pendingLocal.autoMinimize === null &&
            data.autoMinimize !== autoMinimize) {
            autoMinimize = data.autoMinimize;
            updateAutoMinimizeUI(autoMinimize);
        }
        if (data.purchaseAction !== undefined &&
            _pendingLocal.purchase === null &&
            data.purchaseAction !== purchaseAction) {
            purchaseAction = data.purchaseAction;
            updatePurchaseUI(purchaseAction);
        }
        if (data.strictCountryMode !== undefined &&
            _pendingLocal.strictCountry === null) {
            strictCountryMode = data.strictCountryMode;
            allowedCountries = data.allowedCountries || allowedCountries;
            strictCountryRejectUnknown = data.strictCountryRejectUnknown !== false;
            updateStrictCountryUI(strictCountryMode, allowedCountries, strictCountryRejectUnknown);
        }

        // Emergency / resume button swap
        var emergencyBtn = document.getElementById('emergencyBtn');
        var resumeBtn = document.getElementById('resumeBtn');
        if (emergencyBtn && resumeBtn) {
            if (data.safety && data.safety.emergencyStop) {
                emergencyBtn.style.display = 'none';
                resumeBtn.style.display = 'inline-flex';
            } else {
                emergencyBtn.style.display = 'inline-flex';
                resumeBtn.style.display = 'none';
            }
        }

        // Mode button highlight handled uniformly by applyModeUI(currentMode)
    });
}

function setText(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val;
}

function showDisconnected() {
    var badge = document.getElementById('modeBadge');
    if (badge) {
        badge.textContent = '--';
        badge.className = 'badge badge-monitor';
    }
    setText('statusText', 'Disconnected');
    var safetyEl = document.getElementById('safetyStatus');
    if (safetyEl) {
        safetyEl.textContent = 'No connection';
        safetyEl.style.color = '#dc2626';
    }
}

// ============================================================
// TOAST
// ============================================================
function showToast(message, type) {
    var existing = document.querySelectorAll('.toast');
    existing.forEach(function(t) { t.remove(); });

    var toast = document.createElement('div');
    toast.className = 'toast' + (type ? ' ' + type : '');
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(function() {
        toast.style.animation = 'fadeOutDown 0.3s ease';
        setTimeout(function() {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 300);
    }, 2500);
}

// ============================================================
// CLEANUP
// ============================================================
window.addEventListener('unload', function() {
    if (statusUpdateInterval) {
        clearInterval(statusUpdateInterval);
        statusUpdateInterval = null;
    }
});
if (typeof browserAPI !== 'undefined' && browserAPI.storage && browserAPI.storage.onChanged) {
    browserAPI.storage.onChanged.addListener(function(changes, area) {
        if (area === 'local' && changes.mode && changes.mode.newValue) {
            if (!_lastModeChangeTime || (Date.now() - _lastModeChangeTime >= 2500)) {
                applyModeUI(changes.mode.newValue);
            }
        }
    });
}
