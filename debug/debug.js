// debug/debug.js
// Debug log viewer — Complete working version with country/reason filters
// Developed by Keyn Labs
// Version 6.2.0
// ============================================================================
// CHANGELOG v6.2.0
//   • Country filter chip (STRICT_COUNTRY_* reasons)
//   • Reason filter chip (keyword / safety / purchase reasons)
//   • Auto-refresh: 3000ms → 1200ms
//   • Logs fetched via background SW first (more reliable than tab)
//   • Product name + reason surfaced per row
//   • Copy-to-clipboard per row
//   • Sticky filter bar
//   • Filters persisted in chrome.storage.local
//   • Debounced search (200ms)
//   • Live "showing X of Y" counter
//   • Cap visible logs at 500 for perf
//   • Event delegation instead of inline onclick
// ============================================================================

console.log('🐞 BuyLead Assistant Debug v6.2.0');

var browserAPI = (typeof browser !== 'undefined') ? browser : chrome;

var refreshInterval = null;
var autoRefresh = true;
var allLogs = [];
var filteredLogs = [];

var MAX_VISIBLE = 500;
var REFRESH_MS = 1200;
var SEARCH_DEBOUNCE_MS = 200;
var _searchTimer = null;

// Persist key for filter state
var FILTER_STORAGE_KEY = 'debugFilters_v620';

// ============================================================
// DOM READY
// ============================================================
document.addEventListener('DOMContentLoaded', function() {
    console.log('[Debug] Page loaded');
    restoreFilters();
    loadLogs();
    setupEventListeners();
    startAutoRefresh();
});

// ============================================================
// EVENT LISTENERS (with event delegation for row buttons)
// ============================================================
function setupEventListeners() {
    var applyBtn = document.getElementById('applyFilter');
    if (applyBtn) applyBtn.addEventListener('click', applyFilters);

    var clearFilterBtn = document.getElementById('clearFilter');
    if (clearFilterBtn) {
        clearFilterBtn.addEventListener('click', function() {
            var lf = document.getElementById('levelFilter');    if (lf) lf.value = 'ALL';
            var mf = document.getElementById('moduleFilter');   if (mf) mf.value = 'ALL';
            var rf = document.getElementById('reasonFilter');   if (rf) rf.value = 'ALL';
            var cf = document.getElementById('countryFilter');  if (cf) cf.value = 'ALL';
            var sf = document.getElementById('searchFilter');   if (sf) sf.value = '';
            saveFilters();
            applyFilters();
        });
    }

    var refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', function() {
            loadLogs();
            showToast('🔄 Refreshed');
        });
    }

    var autoRefreshBtn = document.getElementById('autoRefreshBtn');
    if (autoRefreshBtn) {
        autoRefreshBtn.addEventListener('click', function() {
            autoRefresh = !autoRefresh;
            this.textContent = autoRefresh ? '⏸ Pause Auto' : '▶ Resume Auto';
            showToast(autoRefresh ? '▶ Auto-refresh ON' : '⏸ Auto-refresh OFF');
        });
    }

    var clearBtn = document.getElementById('clearBtn');
    if (clearBtn) clearBtn.addEventListener('click', clearLogs);

    var exportBtn = document.getElementById('exportBtn');
    if (exportBtn) exportBtn.addEventListener('click', exportLogs);

    var backLink = document.getElementById('backLink');
    if (backLink) {
        backLink.addEventListener('click', function() { window.close(); });
    }

    var searchInput = document.getElementById('searchFilter');
    if (searchInput) {
        searchInput.addEventListener('input', function() {
            if (_searchTimer) clearTimeout(_searchTimer);
            _searchTimer = setTimeout(function() {
                saveFilters();
                applyFilters();
            }, SEARCH_DEBOUNCE_MS);
        });
        searchInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                if (_searchTimer) clearTimeout(_searchTimer);
                saveFilters();
                applyFilters();
            } else if (e.key === 'Escape') {
                this.value = '';
                saveFilters();
                applyFilters();
            }
        });
    }

    var levelFilter = document.getElementById('levelFilter');
    if (levelFilter) {
        levelFilter.addEventListener('change', function() {
            saveFilters();
            applyFilters();
        });
    }
    var moduleFilter = document.getElementById('moduleFilter');
    if (moduleFilter) {
        moduleFilter.addEventListener('change', function() {
            saveFilters();
            applyFilters();
        });
    }
    var reasonFilter = document.getElementById('reasonFilter');
    if (reasonFilter) {
        reasonFilter.addEventListener('change', function() {
            saveFilters();
            applyFilters();
        });
    }
    var countryFilter = document.getElementById('countryFilter');
    if (countryFilter) {
        countryFilter.addEventListener('change', function() {
            saveFilters();
            applyFilters();
        });
    }

    // Event delegation for expand + copy buttons
    var logContainer = document.getElementById('logContainer');
    if (logContainer) {
        logContainer.addEventListener('click', function(e) {
            var target = e.target;
            if (!target) return;

            if (target.classList.contains('expand-btn')) {
                e.stopPropagation();
                toggleData(target);
            } else if (target.classList.contains('copy-btn')) {
                e.stopPropagation();
                copyRowToClipboard(target);
            }
        });
    }
}

// ============================================================
// AUTO REFRESH
// ============================================================
function startAutoRefresh() {
    if (refreshInterval) clearInterval(refreshInterval);
    refreshInterval = setInterval(function() {
        if (autoRefresh) loadLogs();
    }, REFRESH_MS);
}

// ============================================================
// LOAD LOGS — background SW first, then content script
// ============================================================
function loadLogs() {
    // Primary: background service worker (always alive, holds batched logs)
    browserAPI.runtime.sendMessage({ action: 'GET_LOGS' }, function(response) {
        if (browserAPI.runtime.lastError) {
            // Background unreachable — try the tab
            loadFromContentScript();
            return;
        }
        if (Array.isArray(response)) {
            updateLogs(response);
            return;
        }
        // Response shape unexpected — fall back
        loadFromContentScript();
    });
}

function loadFromContentScript() {
    browserAPI.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        if (!tabs || !tabs[0]) {
            loadFromStorage();
            return;
        }
        browserAPI.tabs.sendMessage(tabs[0].id, { action: 'GET_LOGS' }, function(response) {
            if (browserAPI.runtime.lastError) {
                loadFromStorage();
                return;
            }
            if (Array.isArray(response)) {
                updateLogs(response);
            } else {
                loadFromStorage();
            }
        });
    });
}

function loadFromStorage() {
    browserAPI.storage.local.get('logs', function(result) {
        var logs = result.logs || [];
        updateLogs(logs);
    });
}

function updateLogs(logs) {
    // Only re-render if logs actually changed (compare last log timestamp)
    var lastOld = allLogs.length > 0 ? allLogs[allLogs.length - 1].timestamp : null;
    var lastNew = logs.length > 0 ? logs[logs.length - 1].timestamp : null;

    if (lastOld === lastNew && allLogs.length === logs.length) {
        return; // no change, skip re-render
    }

    allLogs = logs;
    populateFilterOptions();
    applyFilters();
}

// ============================================================
// POPULATE FILTER DROPDOWNS
// ============================================================
function populateFilterOptions() {
    var modules = {};
    var reasons = {};
    var countries = {};

    for (var i = 0; i < allLogs.length; i++) {
        var log = allLogs[i];
        if (log.module) modules[log.module] = true;

        var reason = log.data && log.data.reason;
        if (reason) {
            reasons[reason] = true;
            if (typeof reason === 'string' && reason.indexOf('STRICT_COUNTRY') === 0) {
                countries[reason] = true;
                if (log.data.leadCountry) countries[log.data.leadCountry] = true;
            }
        }
        // Also collect from message text
        var msg = log.message || '';
        if (msg.indexOf('COUNTRY BLOCK') !== -1) {
            var m = msg.match(/\[(STRICT_COUNTRY_[A-Z_]+)\]/);
            if (m) countries[m[1]] = true;
        }
    }

    populateSelect('moduleFilter', modules, 'All Modules');
    populateSelect('reasonFilter', reasons, 'All Reasons');
    populateSelect('countryFilter', countries, 'All Country Events');
}

function populateSelect(id, valuesObj, defaultLabel) {
    var select = document.getElementById(id);
    if (!select) return;

    var currentValue = select.value;
    select.innerHTML = '<option value="ALL">' + defaultLabel + '</option>';

    var names = Object.keys(valuesObj).sort();
    for (var i = 0; i < names.length; i++) {
        var option = document.createElement('option');
        option.value = names[i];
        option.textContent = names[i];
        select.appendChild(option);
    }

    if (currentValue && (currentValue === 'ALL' || valuesObj[currentValue] || currentValue.indexOf('STRICT_') === 0)) {
        select.value = currentValue;
    }
}

// ============================================================
// APPLY FILTERS
// ============================================================
function applyFilters() {
    var levelFilter    = getVal('levelFilter', 'ALL');
    var moduleFilter   = getVal('moduleFilter', 'ALL');
    var reasonFilter   = getVal('reasonFilter', 'ALL');
    var countryFilter  = getVal('countryFilter', 'ALL');
    var searchFilter   = (getVal('searchFilter', '') || '').toLowerCase();

    filteredLogs = allLogs.filter(function(log) {
        if (levelFilter !== 'ALL' && log.level !== levelFilter) return false;
        if (moduleFilter !== 'ALL' && log.module !== moduleFilter) return false;

        var reason = log.data && log.data.reason;
        if (reasonFilter !== 'ALL') {
            if (reason !== reasonFilter) return false;
        }
        if (countryFilter !== 'ALL') {
            var isCountryEvent =
                (typeof reason === 'string' && reason.indexOf('STRICT_COUNTRY') === 0) ||
                (log.message && log.message.indexOf('COUNTRY BLOCK') !== -1);
            if (!isCountryEvent) return false;

            // Match either the reason OR the lead country code
            var hit = false;
            if (reason === countryFilter) hit = true;
            if (log.data && log.data.leadCountry === countryFilter) hit = true;
            if (log.data && log.data.got === countryFilter) hit = true;
            if (log.message && log.message.indexOf(countryFilter) !== -1) hit = true;
            if (!hit) return false;
        }

        if (searchFilter) {
            var searchText = (
                (log.message || '') + ' ' +
                (log.module || '') + ' ' +
                (log.data ? safeStringify(log.data) : '')
            ).toLowerCase();
            if (searchText.indexOf(searchFilter) === -1) return false;
        }
        return true;
    });

    renderLogs(filteredLogs);
    updateStats();
}

function getVal(id, fallback) {
    var el = document.getElementById(id);
    return el ? el.value : fallback;
}

function safeStringify(obj) {
    try { return JSON.stringify(obj); } catch (e) { return '[unserializable]'; }
}

// ============================================================
// STATS
// ============================================================
function updateStats() {
    var countEl = document.getElementById('logCount');
    if (countEl) {
        if (filteredLogs.length === allLogs.length) {
            countEl.textContent = filteredLogs.length + ' entries';
        } else {
            countEl.textContent = 'showing ' + filteredLogs.length + ' of ' + allLogs.length;
        }
    }

    var statTotal = document.getElementById('statTotal');
    if (statTotal) statTotal.textContent = allLogs.length;

    var info = 0, warn = 0, error = 0, debug = 0;
    for (var i = 0; i < allLogs.length; i++) {
        switch (allLogs[i].level) {
            case 'INFO':  info++;  break;
            case 'WARN':  warn++;  break;
            case 'ERROR':
            case 'FATAL': error++; break;
            case 'DEBUG': debug++; break;
        }
    }
    setText('statInfo',  info);
    setText('statWarn',  warn);
    setText('statError', error);
    setText('statDebug', debug);
}

function setText(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val;
}

// ============================================================
// RENDER LOGS
// ============================================================
function renderLogs(logs) {
    var container = document.getElementById('logContainer');
    if (!container) return;

    if (!logs || logs.length === 0) {
        var reason = allLogs.length === 0
            ? 'No logs recorded yet — logs will appear here as the extension runs.'
            : 'No logs match the current filters. Try clearing them.';
        container.innerHTML =
            '<div class="empty">' +
                '<span class="empty-icon">📭</span>' +
                'No logs to show' +
                '<br><small style="color:#444;margin-top:8px;display:block;">' + reason + '</small>' +
            '</div>';
        return;
    }

    // Cap visible rows for perf
    var total = logs.length;
    var trimmed = logs;
    var capped = false;
    if (total > MAX_VISIBLE) {
        trimmed = logs.slice(-MAX_VISIBLE);
        capped = true;
    }

    var reversed = trimmed.slice().reverse();

    var html = '';
    for (var i = 0; i < reversed.length; i++) {
        html += renderRow(reversed[i]);
    }

    if (capped) {
        html += '<div class="empty" style="font-size:12px;padding:12px;">' +
            '⚠️ Showing latest ' + MAX_VISIBLE + ' of ' + total + ' matching logs. Refine filters to see older entries.' +
        '</div>';
    }

    container.innerHTML = html;
    container.scrollTop = 0;
}

function renderRow(log) {
    var levelClass = 'level-' + (log.level || 'INFO');
    var timestamp = log.timestamp || '';

    var timeStr = timestamp;
    try {
        var date = new Date(timestamp);
        timeStr = date.toLocaleTimeString() + '.' + String(date.getMilliseconds()).padStart(3, '0');
    } catch (e) {}

    var moduleName = log.module || '-';
    var message = escapeHtml(log.message || '');

    // Surface product name + reason if present in data
    var extraInfo = '';
    if (log.data) {
        var productName = log.data.productName || log.data.leadId;
        var reason = log.data.reason;
        if (productName) {
            extraInfo += '<span class="log-extra">' + escapeHtml(String(productName).substring(0, 60)) + '</span>';
        }
        if (reason && reason !== 'ok') {
            var isCountry = typeof reason === 'string' && reason.indexOf('STRICT_COUNTRY') === 0;
            extraInfo += '<span class="log-reason" style="color:' + (isCountry ? '#02A699' : '#f5a623') + ';">' +
                escapeHtml(reason) + '</span>';
        }
    }

    var dataStr = '';
    var dataFull = '';
    if (log.data && Object.keys(log.data).length > 0) {
        try {
            dataStr = safeStringify(log.data).substring(0, 80);
            if (dataStr.length >= 80) dataStr += '...';
            dataFull = safeStringify(log.data, null, 2);
        } catch (e) {
            dataStr = '[object]';
        }
    }

    var hasData = dataFull.length > 0;

    return '<div class="log-entry">' +
        '<span class="log-level ' + levelClass + '">' + (log.level || 'INFO') + '</span>' +
        '<span class="log-time">' + timeStr + '</span>' +
        '<span class="log-module">' + escapeHtml(moduleName) + '</span>' +
        '<span class="log-message">' + message + extraInfo + '</span>' +
        (hasData ? '<span class="log-data">' + escapeHtml(dataStr) + '</span>' : '') +
        '<span class="log-buttons">' +
            (hasData ? '<button class="expand-btn" aria-label="Expand">▼</button>' : '') +
            '<button class="copy-btn" aria-label="Copy" title="Copy JSON">📋</button>' +
        '</span>' +
        (hasData ? '<div class="log-data-full">' + escapeHtml(dataFull) + '</div>' : '') +
    '</div>';
}

// ============================================================
// ROW ACTIONS
// ============================================================
function toggleData(btn) {
    var entry = btn.closest('.log-entry');
    if (!entry) return;
    var fullData = entry.querySelector('.log-data-full');
    if (fullData) {
        var shown = fullData.classList.toggle('show');
        btn.textContent = shown ? '▲' : '▼';
    }
}

function copyRowToClipboard(btn) {
    var entry = btn.closest('.log-entry');
    if (!entry) return;

    var levelEl  = entry.querySelector('.log-level');
    var timeEl   = entry.querySelector('.log-time');
    var moduleEl = entry.querySelector('.log-module');
    var msgEl    = entry.querySelector('.log-message');
    var dataEl   = entry.querySelector('.log-data-full');

    var payload = {
        level:   levelEl ? levelEl.textContent.trim() : '',
        time:    timeEl ? timeEl.textContent.trim() : '',
        module:  moduleEl ? moduleEl.textContent.trim() : '',
        message: msgEl ? msgEl.textContent.trim() : ''
    };

    if (dataEl && dataEl.textContent) {
        try { payload.data = JSON.parse(dataEl.textContent); }
        catch (e) { payload.data = dataEl.textContent; }
    }

    var text = safeStringify(payload, null, 2);

    var done = function() {
        btn.textContent = '✓';
        setTimeout(function() { btn.textContent = '📋'; }, 1200);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function() {
            fallbackCopy(text);
            done();
        });
    } else {
        fallbackCopy(text);
        done();
    }
}

function fallbackCopy(text) {
    try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
    } catch (e) {}
}

function escapeHtml(text) {
    if (text == null) return '';
    var div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

// ============================================================
// CLEAR / EXPORT
// ============================================================
function clearLogs() {
    if (!confirm('🗑 Clear all debug logs?\n\nThis action cannot be undone.')) return;

    browserAPI.storage.local.set({ logs: [] }, function() {
        allLogs = [];
        filteredLogs = [];
        renderLogs([]);
        updateStats();
        showToast('🗑 Logs cleared');
    });
}

function exportLogs() {
    if (allLogs.length === 0) {
        showToast('No logs to export');
        return;
    }

    var filterState = {
        level: getVal('levelFilter', 'ALL'),
        module: getVal('moduleFilter', 'ALL'),
        reason: getVal('reasonFilter', 'ALL'),
        country: getVal('countryFilter', 'ALL'),
        search: getVal('searchFilter', '')
    };

    var payload = {
        exportedAt: new Date().toISOString(),
        extension: 'BuyLead Assistant',
        version: '6.2.0',
        totalLogs: allLogs.length,
        filters: filterState,
        logs: filteredLogs.length > 0 ? filteredLogs : allLogs
    };

    var dataStr = JSON.stringify(payload, null, 2);
    var blob = new Blob([dataStr], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'buylead-debug-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast('📥 Exported ' + (filteredLogs.length > 0 ? filteredLogs.length : allLogs.length) + ' logs');
}

// ============================================================
// PERSIST FILTERS
// ============================================================
function saveFilters() {
    var state = {
        level: getVal('levelFilter', 'ALL'),
        module: getVal('moduleFilter', 'ALL'),
        reason: getVal('reasonFilter', 'ALL'),
        country: getVal('countryFilter', 'ALL'),
        search: getVal('searchFilter', '')
    };
    browserAPI.storage.local.set({ [FILTER_STORAGE_KEY]: state });
}

function restoreFilters() {
    browserAPI.storage.local.get(FILTER_STORAGE_KEY, function(result) {
        var state = result && result[FILTER_STORAGE_KEY];
        if (!state) return;

        var lf = document.getElementById('levelFilter');   if (lf && state.level)   lf.value = state.level;
        var mf = document.getElementById('moduleFilter');  if (mf && state.module)  mf.value = state.module;
        // reason + country are populated after first log load
        var rf = document.getElementById('reasonFilter');  if (rf && state.reason)  rf.setAttribute('data-saved', state.reason);
        var cf = document.getElementById('countryFilter'); if (cf && state.country) cf.setAttribute('data-saved', state.country);
        var sf = document.getElementById('searchFilter');  if (sf && state.search)  sf.value = state.search;
    });
}

function applySavedDropdowns() {
    // Called after populateFilterOptions — restores saved selections
    ['reasonFilter', 'countryFilter'].forEach(function(id) {
        var el = document.getElementById(id);
        if (!el) return;
        var saved = el.getAttribute('data-saved');
        if (saved) {
            // Only set if option exists
            var found = false;
            for (var i = 0; i < el.options.length; i++) {
                if (el.options[i].value === saved) { found = true; break; }
            }
            if (found) el.value = saved;
        }
    });
}

// ============================================================
// TOAST
// ============================================================
function showToast(message) {
    var existing = document.querySelector('.toast');
    if (existing) existing.remove();

    var toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    toast.style.animation = 'fadeInUp 0.3s ease';
    document.body.appendChild(toast);

    setTimeout(function() {
        toast.style.animation = 'fadeOutDown 0.3s ease';
        setTimeout(function() { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
    }, 2500);
}

// ============================================================
// CLEANUP
// ============================================================
window.addEventListener('unload', function() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
    }
    if (_searchTimer) {
        clearTimeout(_searchTimer);
        _searchTimer = null;
    }
});