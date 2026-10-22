// debug/debug.js
// Debug log viewer & Structured Observability Dashboard — Attio theme
// Developed by Keyn Labs
// Version 6.4.0
// ============================================================================

console.log('BuyLead Assistant Debug & Observability v6.4.0');

var browserAPI = (typeof browser !== 'undefined') ? browser : chrome;

var refreshInterval = null;
var autoRefresh = true;
var allLogs = [];
var filteredLogs = [];

var MAX_VISIBLE = 500;
var REFRESH_MS = 1200;
var SEARCH_DEBOUNCE_MS = 200;
var _searchTimer = null;

var FILTER_STORAGE_KEY = 'debugFilters_v640';

var ICON_EXPAND = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
var ICON_COLLAPSE = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';
var ICON_COPY = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
var ICON_CHECK = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

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
// EVENT LISTENERS
// ============================================================
function setupEventListeners() {
    var applyBtn = document.getElementById('applyFilter');
    if (applyBtn) applyBtn.addEventListener('click', applyFilters);

    var clearFilterBtn = document.getElementById('clearFilter');
    if (clearFilterBtn) {
        clearFilterBtn.addEventListener('click', function() {
            var lf = document.getElementById('levelFilter');    if (lf) lf.value = 'ALL';
            var ef = document.getElementById('eventFilter');    if (ef) ef.value = 'ALL';
            var mf = document.getElementById('moduleFilter');   if (mf) mf.value = 'ALL';
            var rf = document.getElementById('reasonFilter');   if (rf) rf.value = 'ALL';
            var cf = document.getElementById('countryFilter');  if (cf) cf.value = 'ALL';
            var tf = document.getElementById('traceFilter');    if (tf) tf.value = '';
            var sf = document.getElementById('searchFilter');   if (sf) sf.value = '';
            saveFilters();
            applyFilters();
        });
    }

    var refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', function() {
            loadLogs();
            showToast('Refreshed');
        });
    }

    var autoRefreshBtn = document.getElementById('autoRefreshBtn');
    if (autoRefreshBtn) {
        autoRefreshBtn.addEventListener('click', function() {
            autoRefresh = !autoRefresh;
            this.textContent = autoRefresh ? 'Pause Auto' : 'Resume Auto';
            showToast(autoRefresh ? 'Auto-refresh ON' : 'Auto-refresh OFF');
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

    var traceInput = document.getElementById('traceFilter');
    if (traceInput) {
        traceInput.addEventListener('input', function() {
            if (_searchTimer) clearTimeout(_searchTimer);
            _searchTimer = setTimeout(function() {
                saveFilters();
                applyFilters();
            }, SEARCH_DEBOUNCE_MS);
        });
    }

    ['levelFilter', 'eventFilter', 'moduleFilter', 'reasonFilter', 'countryFilter'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', function() {
                saveFilters();
                applyFilters();
            });
        }
    });

    var logContainer = document.getElementById('logContainer');
    if (logContainer) {
        logContainer.addEventListener('click', function(e) {
            var target = e.target;
            if (!target) return;

            var traceBadge = target.closest('.trace-badge');
            var expandBtn = target.closest('.expand-btn');
            var copyBtn = target.closest('.copy-btn');
            var rawJsonBtn = target.closest('.raw-json-toggle');

            if (rawJsonBtn) {
                e.stopPropagation();
                var block = rawJsonBtn.nextElementSibling;
                if (block) {
                    var isShowing = block.classList.toggle('show');
                    rawJsonBtn.textContent = isShowing ? 'Hide Raw JSON' : 'View Raw JSON';
                }
            } else if (traceBadge) {
                e.stopPropagation();
                var tid = traceBadge.getAttribute('data-trace-id');
                if (tid) {
                    var tf = document.getElementById('traceFilter');
                    if (tf) tf.value = tid;
                    saveFilters();
                    applyFilters();
                    showToast('Filtered to trace: ' + tid);
                }
            } else if (expandBtn) {
                e.stopPropagation();
                toggleData(expandBtn);
            } else if (copyBtn) {
                e.stopPropagation();
                copyRowToClipboard(copyBtn);
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
// LOAD LOGS
// ============================================================
function loadLogs() {
    browserAPI.runtime.sendMessage({ action: 'GET_LOGS' }, function(response) {
        if (browserAPI.runtime.lastError) {
            loadFromContentScript();
            return;
        }
        if (Array.isArray(response)) {
            updateLogs(response);
            return;
        }
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
    browserAPI.storage.local.get(['logs', '_droppedLogsCount', '_persistenceErrorsCount'], function(result) {
        var logs = result.logs || [];
        if (typeof result._droppedLogsCount === 'number') {
            setText('statDropped', result._droppedLogsCount);
        }
        updateLogs(logs);
    });
}

function updateLogs(logs) {
    var lastOld = allLogs.length > 0 ? (allLogs[allLogs.length - 1].timestamp || allLogs[allLogs.length - 1].id) : null;
    var lastNew = logs.length > 0 ? (logs[logs.length - 1].timestamp || logs[logs.length - 1].id) : null;

    if (lastOld === lastNew && allLogs.length === logs.length) {
        return;
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
    var events = {};
    var reasons = {};
    var countries = {};

    for (var i = 0; i < allLogs.length; i++) {
        var log = allLogs[i];
        var comp = log.component || log.module;
        if (comp) modules[comp] = true;

        if (log.event) events[log.event] = true;

        var reason = log.reasonCode || (log.data && log.data.reason);
        if (reason) {
            reasons[reason] = true;
            if (typeof reason === 'string' && reason.indexOf('STRICT_COUNTRY') === 0) {
                countries[reason] = true;
                if (log.data && log.data.leadCountry) countries[log.data.leadCountry] = true;
            }
        }
        var msg = log.message || '';
        if (msg.indexOf('COUNTRY BLOCK') !== -1) {
            var m = msg.match(/\[(STRICT_COUNTRY_[A-Z_]+)\]/);
            if (m) countries[m[1]] = true;
        }
    }

    populateSelect('eventFilter', events, 'All Events');
    populateSelect('moduleFilter', modules, 'All Components');
    populateSelect('reasonFilter', reasons, 'All Reasons');
    populateSelect('countryFilter', countries, 'All Country Events');
    applySavedDropdowns();
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
    var eventFilter    = getVal('eventFilter', 'ALL');
    var moduleFilter   = getVal('moduleFilter', 'ALL');
    var reasonFilter   = getVal('reasonFilter', 'ALL');
    var countryFilter  = getVal('countryFilter', 'ALL');
    var traceFilter    = (getVal('traceFilter', '') || '').trim().toLowerCase();
    var searchFilter   = (getVal('searchFilter', '') || '').toLowerCase();

    filteredLogs = allLogs.filter(function(log) {
        if (levelFilter !== 'ALL' && log.level !== levelFilter) return false;
        if (eventFilter !== 'ALL' && log.event !== eventFilter) return false;

        var comp = log.component || log.module;
        if (moduleFilter !== 'ALL' && comp !== moduleFilter) return false;

        var reason = log.reasonCode || (log.data && log.data.reason);
        if (reasonFilter !== 'ALL' && reason !== reasonFilter) return false;

        if (countryFilter !== 'ALL') {
            var isCountryEvent =
                (typeof reason === 'string' && reason.indexOf('STRICT_COUNTRY') === 0) ||
                (log.message && log.message.indexOf('COUNTRY BLOCK') !== -1);
            if (!isCountryEvent) return false;

            var hit = false;
            if (reason === countryFilter) hit = true;
            if (log.data && log.data.leadCountry === countryFilter) hit = true;
            if (log.data && log.data.got === countryFilter) hit = true;
            if (log.message && log.message.indexOf(countryFilter) !== -1) hit = true;
            if (!hit) return false;
        }

        if (traceFilter) {
            var tid = (log.traceId || (log.data && log.data.traceId) || '').toLowerCase();
            if (tid.indexOf(traceFilter) === -1) return false;
        }

        if (searchFilter) {
            var searchText = (
                (log.event || '') + ' ' +
                (log.message || '') + ' ' +
                (comp || '') + ' ' +
                (log.traceId || '') + ' ' +
                (log.operationId || '') + ' ' +
                (reason || '') + ' ' +
                (log.result || '') + ' ' +
                (log.error || '') + ' ' +
                (log.context ? safeStringify(log.context) : '') + ' ' +
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

function safeStringify(obj, replacer, space) {
    try { return JSON.stringify(obj, replacer, space); } catch (e) { return '[unserializable]'; }
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
    var scans = 0, obs = 0, dups = 0, rejected = 0, crm = 0;

    for (var i = 0; i < allLogs.length; i++) {
        var log = allLogs[i];
        switch (log.level) {
            case 'INFO':  info++;  break;
            case 'WARN':  warn++;  break;
            case 'ERROR':
            case 'FATAL': error++; break;
            case 'DEBUG':
            case 'TRACE': debug++; break;
        }

        var ev = log.event || '';
        var r = log.reasonCode || (log.data && log.data.reason) || '';

        if (ev.indexOf('scanner.cycle') !== -1 || ev === 'scanner.started') scans++;
        if (ev === 'lead.observed') obs++;
        if (ev === 'scanner.card.duplicate' || r === 'DUPLICATE_OBSERVATION') dups++;
        if (ev === 'lead.normalization.rejected' || r === 'LOCATION_MISMATCH' || r === 'NEGATIVE_KEYWORD_MATCH' || (typeof r === 'string' && r.indexOf('STRICT_') === 0)) rejected++;
        if (ev === 'crm.write.completed') crm++;
    }

    setText('statInfo',     info);
    setText('statWarn',     warn);
    setText('statError',    error);
    setText('statDebug',    debug);
    setText('statScans',    scans);
    setText('statObs',      obs);
    setText('statDups',     dups);
    setText('statRejected', rejected);
    setText('statCrm',      crm);
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
                'No logs to show' +
                '<br><small style="color:var(--text-3);margin-top:8px;display:block;">' + reason + '</small>' +
            '</div>';
        return;
    }

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
            'Showing latest ' + MAX_VISIBLE + ' of ' + total + ' matching logs. Refine filters to see older entries.' +
        '</div>';
    }

    container.innerHTML = html;
    container.scrollTop = 0;
}

function formatContextChips(ctx) {
    if (!ctx || typeof ctx !== 'object') return '';
    var keys = Object.keys(ctx);
    if (keys.length === 0) return '';

    var chips = [];
    var priority = ['leadName', 'product', 'filterName', 'filterId', 'seller', 'location', 'leadId', 'status', 'from', 'to', 'count', 'url'];
    var seen = {};

    for (var p = 0; p < priority.length; p++) {
        var pk = priority[p];
        if (ctx[pk] !== undefined && ctx[pk] !== null && ctx[pk] !== '') {
            // Avoid duplicate chips if leadName and product are identical
            if (pk === 'product' && ctx.leadName && ctx.leadName === ctx.product) {
                seen[pk] = true;
                continue;
            }
            if (pk === 'leadName' && ctx.product && ctx.leadName === ctx.product) {
                chips.push({ key: 'lead', val: String(ctx[pk]) });
                seen['leadName'] = true;
                seen['product'] = true;
                continue;
            }
            chips.push({ key: pk === 'leadName' ? 'lead' : pk, val: String(ctx[pk]) });
            seen[pk] = true;
        }
    }
    for (var k = 0; k < keys.length; k++) {
        var rk = keys[k];
        if (!seen[rk] && ctx[rk] !== undefined && ctx[rk] !== null && ctx[rk] !== '' && typeof ctx[rk] !== 'object') {
            chips.push({ key: rk, val: String(ctx[rk]) });
        }
    }

    if (chips.length === 0) {
        var s = safeStringify(ctx);
        return s.length > 50 ? escapeHtml(s.substring(0, 47) + '...') : escapeHtml(s);
    }

    var html = '<span class="log-data-chips">';
    var maxChips = 3;
    for (var c = 0; c < Math.min(chips.length, maxChips); c++) {
        var item = chips[c];
        var val = item.val;
        if (val.length > 25) val = val.substring(0, 22) + '...';
        html += '<span class="data-chip"><span class="data-chip-key">' + escapeHtml(item.key) + ':</span><span class="data-chip-val">' + escapeHtml(val) + '</span></span>';
    }
    if (chips.length > maxChips) {
        html += '<span class="data-chip" style="color:var(--text-3); font-size:10px;">+' + (chips.length - maxChips) + '</span>';
    }
    html += '</span>';
    return html;
}

function renderStructuredDetails(log, fullRecord, dataFull) {
    var ctx = log.context || log.data || {};
    var hasContext = ctx && typeof ctx === 'object' && Object.keys(ctx).length > 0;
    var hasMetrics = log.metrics && typeof log.metrics === 'object' && Object.keys(log.metrics).length > 0;
    var hasError = !!log.error;

    var html = '<div class="log-structured-card">';

    // 1. Meta strip
    html += '<div class="log-meta-row">';
    if (log.event) {
        html += '<div class="log-meta-item"><span class="log-meta-label">Event</span><span class="log-meta-val" style="color:#4338ca;">' + escapeHtml(log.event) + '</span></div>';
    }
    if (log.result) {
        var resColor = (log.result === 'PASSED' || log.result === 'SUCCESS' || log.result === 'COMPLETED') ? 'var(--success)' : (log.result === 'FAILED' ? 'var(--danger)' : 'var(--warning)');
        html += '<div class="log-meta-item"><span class="log-meta-label">Result</span><span class="log-meta-val" style="color:' + resColor + ';">' + escapeHtml(log.result) + '</span></div>';
    }
    if (log.reasonCode) {
        html += '<div class="log-meta-item"><span class="log-meta-label">Reason</span><span class="log-meta-val" style="color:var(--accent);">' + escapeHtml(log.reasonCode) + '</span></div>';
    }
    if (typeof log.durationMs === 'number') {
        html += '<div class="log-meta-item"><span class="log-meta-label">Duration</span><span class="log-meta-val">' + log.durationMs + ' ms</span></div>';
    }
    if (log.traceId) {
        html += '<div class="log-meta-item"><span class="log-meta-label">Trace ID</span><span class="log-meta-val trace-badge" data-trace-id="' + escapeHtml(log.traceId) + '" style="cursor:pointer;" title="Click to filter">' + escapeHtml(log.traceId) + '</span></div>';
    }
    if (log.operationId) {
        html += '<div class="log-meta-item"><span class="log-meta-label">Op ID</span><span class="log-meta-val">' + escapeHtml(log.operationId) + '</span></div>';
    }
    html += '</div>';

    // 2. Context Table
    if (hasContext) {
        html += '<div>';
        html += '<div class="log-section-title">Context &amp; Evaluated Attributes</div>';
        html += '<table class="log-kv-table"><tbody>';
        for (var k in ctx) {
            if (Object.prototype.hasOwnProperty.call(ctx, k)) {
                var v = ctx[k];
                var displayVal = '';
                if (typeof v === 'object' && v !== null) {
                    displayVal = '<code>' + escapeHtml(safeStringify(v)) + '</code>';
                } else {
                    displayVal = '<strong>' + escapeHtml(String(v)) + '</strong>';
                }
                html += '<tr><th>' + escapeHtml(k) + '</th><td>' + displayVal + '</td></tr>';
            }
        }
        html += '</tbody></table></div>';
    }

    // 3. Metrics Table (if any)
    if (hasMetrics) {
        html += '<div>';
        html += '<div class="log-section-title">Performance Metrics</div>';
        html += '<table class="log-kv-table"><tbody>';
        for (var mk in log.metrics) {
            if (Object.prototype.hasOwnProperty.call(log.metrics, mk)) {
                html += '<tr><th>' + escapeHtml(mk) + '</th><td><strong>' + escapeHtml(String(log.metrics[mk])) + '</strong></td></tr>';
            }
        }
        html += '</tbody></table></div>';
    }

    // 4. Error Display (if any)
    if (hasError) {
        var errObj = log.error;
        var errMsg = typeof errObj === 'string' ? errObj : (errObj.message || safeStringify(errObj));
        var errStack = (errObj && errObj.stack) ? errObj.stack : '';
        html += '<div style="background:var(--danger-bg); border:1px solid #fecaca; border-radius:4px; padding:8px 10px; margin-bottom:6px;">';
        html += '<div style="color:var(--danger); font-weight:700; font-size:11px; margin-bottom:2px;">Error: ' + escapeHtml(errMsg) + '</div>';
        if (errStack) {
            html += '<pre style="color:#991b1b; font-size:10px; margin-top:4px; white-space:pre-wrap; font-family:ui-monospace, monospace;">' + escapeHtml(errStack) + '</pre>';
        }
        html += '</div>';
    }

    // 5. Collapsible Raw JSON
    html += '<button type="button" class="raw-json-toggle">View Raw JSON</button>';
    html += '<pre class="raw-json-block">' + escapeHtml(dataFull) + '</pre>';

    html += '</div>';
    return html;
}

function renderRow(log) {
    var levelClass = 'level-' + (log.level || 'INFO');
    var timestamp = log.timestamp || '';

    var timeStr = timestamp;
    try {
        var date = new Date(timestamp);
        timeStr = date.toLocaleTimeString() + '.' + String(date.getMilliseconds()).padStart(3, '0');
    } catch (e) {}

    var componentName = log.component || log.module || '-';
    var eventName = log.event || '';
    var traceId = log.traceId || (log.data && log.data.traceId) || '';
    var duration = typeof log.durationMs === 'number' ? (log.durationMs + 'ms') : '';
    var reason = log.reasonCode || (log.data && log.data.reason) || '';

    var message = '';
    if (log.message && log.message !== log.event) {
        message = escapeHtml(log.message);
    }

    var badges = '';
    // ── Filter lifecycle events: amber / red / green prominent badges ──
    var isFilterLimit = eventName === 'filter.limit.reached';
    var isFilterDeact = eventName === 'filter.deactivated';
    var isFilterReact = eventName === 'filter.reactivated';

    if (isFilterLimit) {
        badges += '<span class="event-badge-limit">⚠️ ' + escapeHtml(eventName) + '</span>';
    } else if (isFilterDeact) {
        badges += '<span class="event-badge-deact">🔴 ' + escapeHtml(eventName) + '</span>';
    } else if (isFilterReact) {
        badges += '<span class="event-badge-react">🟢 ' + escapeHtml(eventName) + '</span>';
    } else if (eventName) {
        badges += '<span class="event-badge">' + escapeHtml(eventName) + '</span>';
    }
    if (traceId) {
        badges += '<span class="trace-badge" data-trace-id="' + escapeHtml(traceId) + '" title="Click to isolate this trace">' + escapeHtml(traceId.substring(0, 16)) + '</span>';
    }
    if (duration) {
        badges += '<span class="duration-badge">' + escapeHtml(duration) + '</span>';
    }
    if (log.result) {
        var resCls = (log.result === 'PASSED' || log.result === 'SUCCESS' || log.result === 'COMPLETED') ? 'level-INFO' : (log.result === 'FAILED' ? 'level-ERROR' : 'level-WARN');
        badges += '<span class="result-badge ' + resCls + '">' + escapeHtml(log.result) + '</span>';
    }
    if (reason && reason !== 'ok') {
        var isCountry = typeof reason === 'string' && reason.indexOf('STRICT_COUNTRY') === 0;
        badges += '<span class="log-reason" style="color:' + (isCountry ? 'var(--accent)' : 'var(--warning)') + ';">' + escapeHtml(reason) + '</span>';
    }

    var contextChips = formatContextChips(log.context || log.data);

    // Authoritative full JSON object
    var fullRecord = Object.assign({
        schemaVersion: log.schemaVersion || '1.0.0',
        timestamp: log.timestamp,
        level: log.level,
        event: log.event || null,
        component: componentName,
        instanceId: log.instanceId || null,
        traceId: log.traceId || null,
        operationId: log.operationId || null,
        durationMs: log.durationMs != null ? log.durationMs : null,
        result: log.result || null,
        reasonCode: log.reasonCode || null,
        context: log.context || log.data || null,
        metrics: log.metrics || null,
        error: log.error || null
    }, log);

    var dataFull = safeStringify(fullRecord, null, 2);

    // Row-level CSS class for filter lifecycle events
    var extraRowClass = isFilterLimit ? ' filter-limit' : isFilterDeact ? ' filter-deact' : isFilterReact ? ' filter-react' : '';

    return '<div class="log-entry' + extraRowClass + '">' +
        '<span class="log-level ' + levelClass + '">' + (log.level || 'INFO') + '</span>' +
        '<span class="log-time">' + timeStr + '</span>' +
        '<span class="log-module">' + escapeHtml(componentName) + '</span>' +
        '<span class="log-message">' + badges + (message ? (' ' + message) : '') + '</span>' +
        (contextChips ? '<span class="log-data">' + contextChips + '</span>' : '') +
        '<span class="log-buttons">' +
            '<button class="expand-btn" aria-label="Expand" data-state="collapsed">' + ICON_EXPAND + '</button>' +
            '<button class="copy-btn" aria-label="Copy" title="Copy Authoritative JSON">' + ICON_COPY + '</button>' +
        '</span>' +
        '<div class="log-data-full">' + renderStructuredDetails(log, fullRecord, dataFull) + '</div>' +
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
        btn.innerHTML = shown ? ICON_COLLAPSE : ICON_EXPAND;
    }
}

function copyRowToClipboard(btn) {
    var entry = btn.closest('.log-entry');
    if (!entry) return;

    var dataEl = entry.querySelector('.raw-json-block') || entry.querySelector('.log-data-full');
    var text = dataEl ? dataEl.textContent : '';

    var done = function() {
        btn.innerHTML = ICON_CHECK;
        setTimeout(function() { btn.innerHTML = ICON_COPY; }, 1200);
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
    if (!confirm('Clear all debug logs?\n\nThis action cannot be undone.')) return;

    browserAPI.storage.local.set({ logs: [], _droppedLogsCount: 0, _persistenceErrorsCount: 0 }, function() {
        allLogs = [];
        filteredLogs = [];
        renderLogs([]);
        updateStats();
        showToast('Logs cleared');
    });
}

function exportLogs() {
    if (allLogs.length === 0) {
        showToast('No logs to export');
        return;
    }

    var filterState = {
        level: getVal('levelFilter', 'ALL'),
        event: getVal('eventFilter', 'ALL'),
        module: getVal('moduleFilter', 'ALL'),
        reason: getVal('reasonFilter', 'ALL'),
        country: getVal('countryFilter', 'ALL'),
        trace: getVal('traceFilter', ''),
        search: getVal('searchFilter', '')
    };

    var exportLogsArray = filteredLogs.length > 0 ? filteredLogs : allLogs;

    var payload = {
        schemaVersion: '1.0.0',
        exportedAt: new Date().toISOString(),
        extension: 'BuyLead Assistant',
        version: '6.4.0',
        totalLogs: allLogs.length,
        exportedCount: exportLogsArray.length,
        filters: filterState,
        logs: exportLogsArray
    };

    var dataStr = JSON.stringify(payload, null, 2);
    var blob = new Blob([dataStr], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'buylead-observability-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast('Exported ' + exportLogsArray.length + ' structured logs (Schema v1.0.0)');
}

// ============================================================
// PERSIST FILTERS
// ============================================================
function saveFilters() {
    var state = {
        level: getVal('levelFilter', 'ALL'),
        event: getVal('eventFilter', 'ALL'),
        module: getVal('moduleFilter', 'ALL'),
        reason: getVal('reasonFilter', 'ALL'),
        country: getVal('countryFilter', 'ALL'),
        trace: getVal('traceFilter', ''),
        search: getVal('searchFilter', '')
    };
    browserAPI.storage.local.set({ [FILTER_STORAGE_KEY]: state });
}

function restoreFilters() {
    browserAPI.storage.local.get(FILTER_STORAGE_KEY, function(result) {
        var state = result && result[FILTER_STORAGE_KEY];
        if (!state) return;

        var lf = document.getElementById('levelFilter');   if (lf && state.level)   lf.value = state.level;
        var ef = document.getElementById('eventFilter');   if (ef && state.event)   ef.setAttribute('data-saved', state.event);
        var mf = document.getElementById('moduleFilter');  if (mf && state.module)  mf.value = state.module;
        var rf = document.getElementById('reasonFilter');  if (rf && state.reason)  rf.setAttribute('data-saved', state.reason);
        var cf = document.getElementById('countryFilter'); if (cf && state.country) cf.setAttribute('data-saved', state.country);
        var tf = document.getElementById('traceFilter');   if (tf && state.trace)   tf.value = state.trace;
        var sf = document.getElementById('searchFilter');  if (sf && state.search)  sf.value = state.search;
    });
}

function applySavedDropdowns() {
    ['eventFilter', 'reasonFilter', 'countryFilter'].forEach(function(id) {
        var el = document.getElementById(id);
        if (!el) return;
        var saved = el.getAttribute('data-saved');
        if (saved) {
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