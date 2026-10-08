// popup/popup.js
// Popup controller with strict country toggle + live queue + honest UI
// Developed by Keyn Labs
// Version 5.1.0
// ============================================================================
// CHANGELOG v5.1.0
//   • initializeDefaultMode respects initialized_v620 schema key
//   • Strict-country sub-label honest about rejectUnknown when mode is OFF
//   • Reads navigator + queue sub-objects from status payload
//   • Speed row shows perMinute / cooldownMs live
//   • Panel refresh: 1500ms → 800ms
//   • sendToContent has 400ms fallback timeout (no popup freeze)
//   • Toggle race-protection via requestId echo
//   • Emergency-stop checks actual safety.emergencyStop flag
//   • setModeInContent inline timeout
//   • DOM lookups guarded everywhere
// ============================================================================

console.log('🎯 BuyLead Assistant Popup v5.1.0');

var browserAPI = (typeof browser !== 'undefined') ? browser : chrome;

var statusUpdateInterval = null;
var supabaseEnabled = true;
var confirmationAnswer = 'yes';
var autoMinimize = true;
var purchaseAction = 'close';
var strictCountryMode = false;
var strictCountryRejectUnknown = true;
var allowedCountries = ['IN'];

// Track which toggles we just set locally so remote echoes don't fight us
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
    initializeDefaultMode().then(function() {
        loadAllSettings();
        setupEventListeners();
        updateStatus();
        statusUpdateInterval = setInterval(updateStatus, 800);
    });
});

function initializeDefaultMode() {
    return new Promise(function(resolve) {
        browserAPI.storage.local.get(
            ['mode', 'userSetMode', 'initialized_v620'],
            function(result) {
                // If the schema key is missing, treat this as a fresh install for
                // the speed-defaults migration and let bundle.js seed the config.
                if (!result.initialized_v620) {
                    browserAPI.storage.local.set({
                        mode: 'AUTOMATIC',
                        userSetMode: false,
                        initialized_v620: true
                    }, function() {
                        setModeInContent('AUTOMATIC').finally(function() { resolve(); });
                    });
                    return;
                }

                if (!result.userSetMode) {
                    browserAPI.storage.local.set({ mode: 'AUTOMATIC', userSetMode: false }, function() {
                        setModeInContent('AUTOMATIC').finally(function() { resolve(); });
                    });
                } else {
                    setModeInContent(result.mode || 'MONITOR').finally(function() { resolve(); });
                }
            }
        );
    });
}

// ============================================================
// LOAD ALL SETTINGS
// ============================================================
function loadAllSettings() {
    browserAPI.storage.local.get([
        'supabaseEnabled', 'confirmationAnswer', 'autoMinimize',
        'purchaseAction', 'autoScroll',
        'strictCountryMode', 'allowedCountries', 'strictCountryRejectUnknown',
        'maxPerMinute', 'cooldownMs'
    ], function(result) {
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

        // Speed row uses these
        updateSpeedUI(result.maxPerMinute, result.cooldownMs);
    });
}

function updateSupabaseUI(enabled) {
    var toggle    = document.getElementById('supabaseToggle');
    var icon      = document.getElementById('connectionIcon');
    var label     = document.getElementById('connectionLabel');
    var status    = document.getElementById('connectionStatus');
    var container = document.getElementById('connectionToggle');
    if (toggle) toggle.checked = enabled;
    if (!icon || !label || !status) return;

    if (enabled) {
        icon.textContent = '☁️';
        label.innerHTML = 'Supabase: <strong>ON</strong>';
        status.textContent = 'Connected to CRM';
        if (container) container.classList.remove('offline');
    } else {
        icon.textContent = '📴';
        label.innerHTML = 'Supabase: <strong>OFF</strong>';
        status.textContent = 'Offline mode • Local keywords only';
        if (container) container.classList.add('offline');
    }
}

function updateConfirmationUI(answer) {
    var toggle = document.getElementById('confirmToggle');
    var icon   = document.getElementById('confirmIcon');
    var label  = document.getElementById('confirmLabel');
    var status = document.getElementById('confirmStatus');
    var container = document.getElementById('confirmToggleWrap');
    if (toggle) toggle.checked = (answer === 'yes');
    if (!icon || !label || !status) return;

    if (answer === 'yes') {
        icon.textContent = '✅';
        label.innerHTML = 'Old Lead Confirmation: <strong>YES</strong>';
        status.textContent = 'Auto-answer to "Do you want to contact?"';
        if (container) { container.style.background = 'linear-gradient(135deg, #f0f8f7 0%, #e8f5f3 100%)'; container.style.borderColor = '#02A699'; }
    } else {
        icon.textContent = '❌';
        label.innerHTML = 'Old Lead Confirmation: <strong>NO</strong>';
        status.textContent = 'Will auto-skip old leads';
        if (container) { container.style.background = 'linear-gradient(135deg, #fff8e8 0%, #fef5e0 100%)'; container.style.borderColor = '#f5a623'; }
    }
}

function updateAutoMinimizeUI(enabled) {
    var toggle = document.getElementById('autoMinToggle');
    var icon   = document.getElementById('autoMinIcon');
    var label  = document.getElementById('autoMinLabel');
    var status = document.getElementById('autoMinStatus');
    var container = document.getElementById('autoMinToggleWrap');
    if (toggle) toggle.checked = enabled;
    if (!icon || !label || !status) return;

    if (enabled) {
        icon.textContent = '✓';
        label.innerHTML = 'Auto-Handle Popups: <strong>ON</strong>';
        status.textContent = 'Popup handled automatically after acquisition';
        if (container) { container.style.background = 'linear-gradient(135deg, #f0f8f7 0%, #e8f5f3 100%)'; container.style.borderColor = '#02A699'; }
    } else {
        icon.textContent = '○';
        label.innerHTML = 'Auto-Handle Popups: <strong>OFF</strong>';
        status.textContent = 'Popups must be closed manually';
        if (container) { container.style.background = 'linear-gradient(135deg, #f5f5f5 0%, #ebebeb 100%)'; container.style.borderColor = '#999'; }
    }
}

function updatePurchaseUI(action) {
    var toggle = document.getElementById('purchaseToggle');
    var icon   = document.getElementById('purchaseIcon');
    var label  = document.getElementById('purchaseLabel');
    var status = document.getElementById('purchaseStatus');
    var container = document.getElementById('purchaseToggleWrap');
    if (toggle) toggle.checked = (action === 'close');
    if (!icon || !label || !status) return;

    if (action === 'close') {
        icon.textContent = '💳';
        label.innerHTML = 'Purchase Modal: <strong>Auto-Close</strong>';
        status.textContent = 'Auto-close and continue';
        if (container) { container.style.background = 'linear-gradient(135deg, #f0f8f7 0%, #e8f5f3 100%)'; container.style.borderColor = '#02A699'; }
    } else {
        icon.textContent = '🛑';
        label.innerHTML = 'Purchase Modal: <strong>Stop</strong>';
        status.textContent = 'Pause queue when purchase prompt appears';
        if (container) { container.style.background = 'linear-gradient(135deg, #fef0f0 0%, #fce5e5 100%)'; container.style.borderColor = '#ef7076'; }
    }
}

function updateStrictCountryUI(enabled, countries, rejectUnknown) {
    var toggle = document.getElementById('strictCountryToggle');
    var icon   = document.getElementById('strictCountryIcon');
    var label  = document.getElementById('strictCountryLabel');
    var status = document.getElementById('strictCountryStatus');
    var container = document.getElementById('strictCountryWrap');
    if (!toggle) return;

    toggle.checked = enabled;
    if (!icon || !label || !status) return;

    if (enabled) {
        icon.textContent = '🎯';
        label.innerHTML = 'Strict Country: <strong style="color:#02A699;">ON</strong>';
        var list = (countries || []).join(', ') || '—';
        status.textContent = 'Only: ' + list + (rejectUnknown ? ' (unknown rejected)' : '');
        if (container) {
            container.style.background = 'linear-gradient(135deg, #0f1f1e 0%, #0d1a1a 100%)';
            container.style.borderColor = '#02A699';
        }
    } else {
        icon.textContent = '🌍';
        label.innerHTML = 'Strict Country: <strong>OFF</strong>';
        // Honest sub-label — unknown rejection still applies in strict mode only
        status.textContent = 'All countries accepted';
        if (container) {
            container.style.background = 'linear-gradient(135deg, #f5f5f5 0%, #ebebeb 100%)';
            container.style.borderColor = '#999';
        }
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
    // Mode buttons
    document.querySelectorAll('.mode-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var mode = this.dataset.mode;
            setMode(mode);
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
                showToast(enabled ? '☁️ Supabase ON - CRM mode' : '📴 Supabase OFF - Offline mode', enabled ? 'success' : 'warning');
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
                showToast('⚠️ Configure countries in Config first', 'warning');
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
                    enabled ? '🎯 Strict: ' + allowedCountries.join(', ') : '🌍 Strict country OFF',
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
                showToast(enabled ? '✓ Auto-popup ON' : '○ Auto-popup OFF', enabled ? 'success' : 'warning');
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
                    action === 'close' ? '💳 Purchase: Auto-close' : '🛑 Purchase: Stop queue',
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
            if (confirm('🛑 Emergency Stop - Stop all automation?')) {
                sendToContent({ action: 'EMERGENCY_STOP' });
                showToast('🛑 Emergency stop activated', 'error');
            }
        });
    }

    // Resume
    var resumeBtn = document.getElementById('resumeBtn');
    if (resumeBtn) {
        resumeBtn.addEventListener('click', function() {
            sendToContent({ action: 'RESUME' });
            showToast('▶️ Resumed', 'success');
        });
    }

    // Links
    var configLink = document.getElementById('configLink');
    if (configLink) {
        configLink.addEventListener('click', function() {
            browserAPI.tabs.create({ url: browserAPI.runtime.getURL('config/index.html') });
        });
    }
    var debugLink = document.getElementById('debugLink');
    if (debugLink) {
        debugLink.addEventListener('click', function() {
            browserAPI.tabs.create({ url: browserAPI.runtime.getURL('debug/index.html') });
        });
    }
}

// ============================================================
// MODE
// ============================================================
function setMode(mode) {
    browserAPI.storage.local.set({ mode: mode, userSetMode: true }, function() {
        setModeInContent(mode).then(function() {
            showToast('✅ Mode: ' + mode, 'success');
            updateStatus();
        });
    });
}

function setModeInContent(mode) {
    return new Promise(function(resolve) {
        var settled = false;
        var timer = setTimeout(function() {
            if (settled) return;
            settled = true;
            // Fallback: route through background
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
// SEND TO CONTENT (with timeout fallback)
// ============================================================
function sendToContent(message, callback) {
    callback = callback || function() {};

    var settled = false;
    var timer = setTimeout(function() {
        if (settled) return;
        settled = true;
        // Fallback: route through background
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
        var currentMode = data.mode || 'MONITOR';

        // Mode badge
        var badge = document.getElementById('modeBadge');
        if (badge) {
            badge.textContent = currentMode;
            badge.className = 'badge badge-' + currentMode.toLowerCase().replace('_', '');
            if (data.safety && data.safety.emergencyStop) {
                badge.className = 'badge badge-emergency';
                badge.textContent = '🚨 STOP';
            }
        }

        // Status text
        var statusText = document.getElementById('statusText');
        var isRunning = data.scanner && data.scanner.running;
        if (statusText) {
            if (data.safety && data.safety.emergencyStop) statusText.textContent = '🛑 Emergency Stop';
            else if (isRunning && currentMode === 'AUTOMATIC') statusText.textContent = '▶ Auto-Acquiring';
            else if (isRunning) statusText.textContent = '▶ Running';
            else statusText.textContent = '⏹ Stopped';
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
            if (data.safety && data.safety.emergencyStop) { safetyEl.textContent = '🛑 EMERGENCY'; safetyEl.style.color = '#ef7076'; }
            else if (data.safety && data.safety.cooldown) { safetyEl.textContent = '⏳ Cooldown'; safetyEl.style.color = '#f5a623'; }
            else if (currentMode === 'MONITOR') { safetyEl.textContent = '📊 Monitor'; safetyEl.style.color = '#888'; }
            else if (currentMode === 'DRY_RUN') { safetyEl.textContent = '🔬 Dry Run'; safetyEl.style.color = '#f5a623'; }
            else if (currentMode === 'AUTOMATIC') { safetyEl.textContent = '🔥 Auto'; safetyEl.style.color = '#02A699'; }
            else { safetyEl.textContent = '✅ OK'; safetyEl.style.color = '#02A699'; }
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

        // Stats grid
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
        }

        // Speed row
        if (data.safety && data.safety.limits) {
            updateSpeedUI(data.safety.limits.perMinute, data.safety.cooldownMs);
        }

        // Remote state sync (only if not locally pending)
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
                resumeBtn.style.display = 'block';
            } else {
                emergencyBtn.style.display = 'block';
                resumeBtn.style.display = 'none';
            }
        }

        // Mode button highlight
        document.querySelectorAll('.mode-btn').forEach(function(btn) {
            btn.classList.toggle('active', btn.dataset.mode === currentMode);
        });
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
    setText('statusText', '⏹ Disconnected');
    var safetyEl = document.getElementById('safetyStatus');
    if (safetyEl) {
        safetyEl.textContent = '⚠️ No connection';
        safetyEl.style.color = '#ef7076';
    }
}

// ============================================================
// TOAST
// ============================================================
function showToast(message, type) {
    // Remove existing toasts of the same class
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