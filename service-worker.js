// service-worker.js
// Background service worker — direct Supabase data management
// Developed by Keyn Labs
// Version 4.2.0
// ============================================================================
// CHANGELOG v4.2.0
//   • Default config bumped to match bundle.js v6.2 (faster queue, bigger limits)
//   • checkActiveFilters is now gated on an open IndiaMART tab
//   • Uses chromealarms (60s) instead of setInterval — survives SW suspension
//   • New storage schema key initialized_v620 → re-seeds faster defaults once
//   • Retry-with-backoff on tab hydration for SET_MODE / TOGGLE_SUPABASE
//   • SUPPABASE_CLEAR_BEFORE validates ISO date and returns structured errors
//   • All tabs.sendMessage calls guarded against runtime.lastError
// ============================================================================

console.log('🔧 BuyLead Assistant Service Worker v4.2.0');
console.log('📦 Developed by Keyn Labs');

var browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
var cachedStatus = null;

var SUPABASE_URL = 'https://zvhuromubukylsxrsfiz.supabase.co';
var SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp2aHVyb211YnVreWxzeHJzZml6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgwODI4MDYsImV4cCI6MjEwMzY1ODgwNn0.29J2uGHxFhPtEqRZvnXjaYpL-x4I0uEc2TT8u9d5PVw';

// ============================================================
// DEFAULT CONFIG — MIRRORS bundle.js v6.2
// ============================================================
var DEFAULT_CONFIG = {
    mode: 'AUTOMATIC',
    userSetMode: false,
    supabaseEnabled: true,
    minScore: 60,

    // Speed limits
    maxPerMinute: 60,
    maxPerHour: 400,
    maxPerDay: 2000,
        maxPerSession: 1000,
    cooldownMs: 0,

    // Scoring
    scoreWeights: {
        base: 50,
        perProductKeyword: 10, maxProductBonus: 30,
        preferredState: 15, countryMatch: 15,
        hasMobile: 10, hasEmail: 8, hasPhone: 5,
        detailedRequirement: 5, requirementLengthThreshold: 100
    },
    scorePenalties: { wrongCountry: -20, wrongState: -10, noContact: -5 },
    preferredStates: ['maharashtra'],
    preferredCountries: ['IN'],

    // Country
    strictCountryMode: false,
    allowedCountries: ['IN'],
    strictCountryRejectUnknown: true,

    // Navigator (speed-tuned)
    autoScroll: true,
    scrollSpeed: 900,
    scrollDelayMs: 40,
    bottomWaitMs: 500,
    loopIntervalMs: 250,
    loadMoreWaitMs: 900,
    maxStuckLoops: 3,
    maxReloadsPerSession: 999999,
    autoReloadOnComplete: true,
    autoReloadDelayMs: 100,

    // Popup (speed-tuned)
    autoMinimize: true,
    popupTimeoutMs: 5000,
    confirmationAnswer: 'yes',
    purchaseAction: 'close',

    // Misc
    logs: [],
    keywords: { product: [], negative: [], required: [], location: [] }
};

// ============================================================
// SUPABASE HELPERS
// ============================================================
function sbHeaders(extra) {
    var h = {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json'
    };
    if (extra) {
        for (var k in extra) {
            if (Object.prototype.hasOwnProperty.call(extra, k)) h[k] = extra[k];
        }
    }
    return h;
}

// ============================================================
// INSTALLATION — seed config once per schema version
// ============================================================
browserAPI.runtime.onInstalled.addListener(function() {
    console.log('[SW] BuyLead Assistant v4.2.0 installed');

    browserAPI.storage.local.get(['initialized_v620', 'mode', 'userSetMode'], function(result) {
        if (result.initialized_v620) {
            console.log('[SW] Config schema already at v6.20');
            return;
        }

        // Preserve user-chosen mode if they've set it explicitly
        var seed = Object.assign({}, DEFAULT_CONFIG);
        if (result.userSetMode && result.mode) {
            seed.mode = result.mode;
            seed.userSetMode = true;
        }

        // Preserve any user keywords if present
        browserAPI.storage.local.get('keywords', function(kres) {
            if (kres && kres.keywords) seed.keywords = kres.keywords;

            browserAPI.storage.local.set(seed, function() {
                browserAPI.storage.local.set({ initialized_v620: true }, function() {
                    console.log('[SW] ✅ Defaults v6.20 initialized (fast mode)');
                });
            });
        });
    });

    setupAlarms();
});

// ============================================================
// STARTUP
// ============================================================
browserAPI.runtime.onStartup.addListener(function() {
    console.log('[SW] Extension started');
    setupAlarms();
    // Run once on startup, tab-gated
    runGatedFilterCheck();
});

// ============================================================
// ALARMS (replace setInterval — survives SW suspension)
// ============================================================
var FILTER_CHECK_ALARM = 'buylead_filter_check';

function setupAlarms() {
    try {
        browserAPI.alarms.create(FILTER_CHECK_ALARM, { periodInMinutes: 1 });
        console.log('[SW] ⏰ Filter-check alarm scheduled (1 min)');
    } catch (e) {
        console.warn('[SW] alarms.create failed:', e.message);
    }
}

if (browserAPI.alarms && browserAPI.alarms.onAlarm) {
    browserAPI.alarms.onAlarm.addListener(function(alarm) {
        if (alarm.name === FILTER_CHECK_ALARM) runGatedFilterCheck();
    });
}

// ============================================================
// GATED FILTER CHECK
// Only runs if at least one IndiaMART seller tab is open.
// ============================================================
function runGatedFilterCheck() {
    try {
        browserAPI.tabs.query({ url: 'https://seller.indiamart.com/*' }, function(tabs) {
            if (browserAPI.runtime.lastError) {
                // Firefox may not support the url filter the same way — fall back to scanning
                browserAPI.tabs.query({}, function(allTabs) {
                    var relevant = (allTabs || []).filter(function(t) {
                        return t.url && t.url.indexOf('seller.indiamart.com') !== -1;
                    });
                    if (relevant.length === 0) return;
                    checkActiveFilters();
                });
                return;
            }
            if (!tabs || tabs.length === 0) return; // no IM tab → skip
            checkActiveFilters();
        });
    } catch (e) {
        // last-resort: still try, the fetch is cheap
        checkActiveFilters();
    }
}

async function checkActiveFilters() {
    try {
        var settings = await new Promise(function(resolve) {
            browserAPI.storage.local.get(['supabaseEnabled'], function(result) { resolve(result); });
        });

        if (settings.supabaseEnabled === false) {
            await browserAPI.storage.local.set({
                hasActiveFilters: false,
                activeFilterCount: 0,
                lastFilterCheck: Date.now()
            });
            return;
        }

        var url = SUPABASE_URL + '/rest/v1/filters?is_active=eq.true&select=id,is_running,stats_scanned,stats_matched,stats_clicked';
        var response = await fetch(url, { headers: sbHeaders() });
        if (!response.ok) return;

        var filters = await response.json();
        var hasActiveFilters = filters.length > 0;

        await browserAPI.storage.local.set({
            hasActiveFilters: hasActiveFilters,
            activeFilterCount: filters.length,
            lastFilterCheck: Date.now()
        });

               try {
            var p = browserAPI.runtime.sendMessage({
                action: 'FILTER_STATUS_UPDATE',
                hasActiveFilters: hasActiveFilters,
                filterCount: filters.length,
                filters: filters
            });
            if (p && typeof p.catch === 'function') {
                p.catch(function() { /* no listeners */ });
            }
        } catch (e) { /* no listeners */ }
    } catch (err) {
        console.warn('[SW] checkActiveFilters failed:', err && err.message);
    }
}

// ============================================================
// SUPABASE DATA OPERATIONS
// ============================================================

async function sbClearAllLeads() {
    console.log('[SW] sbClearAllLeads called');
    try {
        var url = SUPABASE_URL + '/rest/v1/leads?id=gte.0';
        var response = await fetch(url, {
            method: 'DELETE',
            headers: sbHeaders({ 'Prefer': 'return=minimal' })
        });
        if (!response.ok) {
            var text = await response.text();
            throw new Error('HTTP ' + response.status + ': ' + text.substring(0, 200));
        }
        console.log('[SW] 🗑️ All leads deleted');
        return { success: true, message: 'All leads deleted' };
    } catch (err) {
        console.error('[SW] Clear leads failed:', err);
        return { success: false, error: err.message };
    }
}

async function sbClearAllHistory() {
    console.log('[SW] sbClearAllHistory called');
    try {
        var url = SUPABASE_URL + '/rest/v1/lead_history?id=gte.0';
        var response = await fetch(url, {
            method: 'DELETE',
            headers: sbHeaders({ 'Prefer': 'return=minimal' })
        });
        if (!response.ok) {
            var text = await response.text();
            throw new Error('HTTP ' + response.status + ': ' + text.substring(0, 200));
        }
        console.log('[SW] 🗑️ All history deleted');
        return { success: true, message: 'All history deleted' };
    } catch (err) {
        console.error('[SW] Clear history failed:', err);
        return { success: false, error: err.message };
    }
}

async function sbClearAllFilters() {
    console.log('[SW] sbClearAllFilters called');
    try {
        var url = SUPABASE_URL + '/rest/v1/filters?id=gte.0';
        var response = await fetch(url, {
            method: 'DELETE',
            headers: sbHeaders({ 'Prefer': 'return=minimal' })
        });
        if (!response.ok) {
            var text = await response.text();
            throw new Error('HTTP ' + response.status + ': ' + text.substring(0, 200));
        }
        console.log('[SW] 🗑️ All filters deleted');
        return { success: true, message: 'All filters deleted' };
    } catch (err) {
        console.error('[SW] Clear filters failed:', err);
        return { success: false, error: err.message };
    }
}

async function sbResetFilterStats() {
    console.log('[SW] sbResetFilterStats called');
    try {
        var url = SUPABASE_URL + '/rest/v1/filters?is_active=eq.true';
        var body = {
            stats_scanned: 0,
            stats_matched: 0,
            stats_clicked: 0,
            is_running: false,
            updated_at: new Date().toISOString()
        };
        var response = await fetch(url, {
            method: 'PATCH',
            headers: sbHeaders(),
            body: JSON.stringify(body)
        });
        if (!response.ok) {
            var text = await response.text();
            throw new Error('HTTP ' + response.status + ': ' + text.substring(0, 200));
        }
        console.log('[SW] 🔄 Filter stats reset');
        return { success: true, message: 'Stats reset' };
    } catch (err) {
        console.error('[SW] Reset stats failed:', err);
        return { success: false, error: err.message };
    }
}

async function sbClearLeadsBefore(dateISO) {
    console.log('[SW] sbClearLeadsBefore called:', dateISO);

    // Validate ISO-ish date: YYYY-MM-DD or full ISO
    if (!dateISO || typeof dateISO !== 'string') {
        return { success: false, error: 'Missing date' };
    }
    if (!/^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/.test(dateISO)) {
        return { success: false, error: 'Invalid date format (expected YYYY-MM-DD or ISO)' };
    }

    try {
        var url = SUPABASE_URL + '/rest/v1/leads?created_at=lt.' + encodeURIComponent(dateISO);
        var response = await fetch(url, {
            method: 'DELETE',
            headers: sbHeaders({ 'Prefer': 'return=minimal' })
        });
        if (!response.ok) {
            var text = await response.text();
            throw new Error('HTTP ' + response.status + ': ' + text.substring(0, 200));
        }
        console.log('[SW] 🗑️ Old leads deleted before', dateISO);
        return { success: true, message: 'Old leads deleted' };
    } catch (err) {
        console.error('[SW] Clear before failed:', err);
        return { success: false, error: err.message };
    }
}

/**
 * RLS-safe table counts: fetch ids and count.
 */
async function sbGetTableCounts() {
    console.log('[SW] sbGetTableCounts called');
    try {
        var leadsResp   = await fetch(SUPABASE_URL + '/rest/v1/leads?select=id',        { headers: sbHeaders() });
        var historyResp = await fetch(SUPABASE_URL + '/rest/v1/lead_history?select=id', { headers: sbHeaders() });
        var filtersResp = await fetch(SUPABASE_URL + '/rest/v1/filters?select=id',      { headers: sbHeaders() });

        if (!leadsResp.ok) {
            var errL = await leadsResp.text();
            throw new Error('leads HTTP ' + leadsResp.status + ': ' + errL.substring(0, 150));
        }
        if (!historyResp.ok) {
            var errH = await historyResp.text();
            throw new Error('history HTTP ' + historyResp.status + ': ' + errH.substring(0, 150));
        }

        var leads   = await leadsResp.json();
        var history = await historyResp.json();
        var filters = filtersResp.ok ? await filtersResp.json() : [];

        var result = {
            success: true,
            leads:   Array.isArray(leads)   ? leads.length   : 0,
            history: Array.isArray(history) ? history.length : 0,
            filters: Array.isArray(filters) ? filters.length : 0
        };
        console.log('[SW] ✅ Counts:', result);
        return result;
    } catch (err) {
        console.error('[SW] ❌ Count fetch failed:', err);
        return { success: false, error: err.message };
    }
}

// ============================================================
// TAB MESSAGING (safe wrapper)
// ============================================================
function safeSendToTab(tabId, message, callback) {
    try {
        browserAPI.tabs.sendMessage(tabId, message, function(response) {
            if (browserAPI.runtime.lastError) {
                if (callback) callback(null, browserAPI.runtime.lastError.message);
            } else {
                if (callback) callback(response, null);
            }
        });
    } catch (e) {
        if (callback) callback(null, e.message);
    }
}

// Retry broadcast with backoff (IndiaMART React hydrates late)
function broadcastToActiveTab(message, delays) {
    delays = delays || [2500, 4000, 6000];
    var idx = 0;
    function attempt() {
        browserAPI.tabs.query({ active: true, currentWindow: true }, function(tabs) {
            if (browserAPI.runtime.lastError || !tabs || !tabs[0]) return;
            var tab = tabs[0];
            if (!tab.url || tab.url.indexOf('seller.indiamart.com/bltxn') === -1) return;
            safeSendToTab(tab.id, message, function(response, err) {
                if (err && idx < delays.length) {
                    idx++;
                    setTimeout(attempt, delays[idx - 1]);
                }
            });
        });
    }
    attempt();
}

// ============================================================
// MESSAGE HANDLING
// ============================================================
browserAPI.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (!request || !request.action) {
        sendResponse({ success: false, error: 'No action' });
        return true;
    }

    console.log('[SW] Message:', request.action);

    // === LOGS ===
    if (request.action === 'GET_LOGS') {
        browserAPI.storage.local.get('logs', function(result) {
            sendResponse(result.logs || []);
        });
        return true;
    }

    if (request.action === 'CLEAR_LOGS') {
        browserAPI.storage.local.set({ logs: [] }, function() {
            sendResponse({ success: true });
        });
        return true;
    }

    // === STATUS ===
    if (request.action === 'UPDATE_STATUS') {
        cachedStatus = request.status;
        sendResponse({ received: true });
        return true;
    }

    if (request.action === 'GET_CACHED_STATUS') {
        sendResponse({ success: true, status: cachedStatus });
        return true;
    }

    if (request.action === 'CHECK_FILTERS') {
        checkActiveFilters().then(function() {
            browserAPI.storage.local.get(['hasActiveFilters', 'activeFilterCount'], function(result) {
                sendResponse({
                    success: true,
                    hasActiveFilters: result.hasActiveFilters || false,
                    filterCount: result.activeFilterCount || 0
                });
            });
        });
        return true;
    }

    // ============================================================
    // SUPABASE DIRECT OPERATIONS
    // ============================================================
    if (request.action === 'SUPABASE_CLEAR_LEADS')    { sbClearAllLeads().then(sendResponse);       return true; }
    if (request.action === 'SUPABASE_CLEAR_HISTORY')  { sbClearAllHistory().then(sendResponse);     return true; }
    if (request.action === 'SUPABASE_CLEAR_FILTERS')  { sbClearAllFilters().then(sendResponse);     return true; }
    if (request.action === 'SUPABASE_RESET_STATS')    { sbResetFilterStats().then(sendResponse);    return true; }
    if (request.action === 'SUPABASE_CLEAR_BEFORE')   { sbClearLeadsBefore(request.date).then(sendResponse); return true; }
    if (request.action === 'SUPABASE_GET_COUNTS')     { sbGetTableCounts().then(sendResponse);      return true; }

    // === TOGGLE_SUPABASE ===
    if (request.action === 'TOGGLE_SUPABASE') {
        browserAPI.storage.local.set({ supabaseEnabled: request.enabled }, function() {
            broadcastToActiveTab(request, [0, 2000, 4000]);
            sendResponse({ success: true, enabled: request.enabled });
            if (request.enabled) setTimeout(runGatedFilterCheck, 800);
        });
        return true;
    }

    // === SET_MODE with user tracking ===
    if (request.action === 'SET_MODE') {
        browserAPI.storage.local.set({
            mode: request.mode,
            userSetMode: true
        }, function() {
            broadcastToActiveTab(request, [0, 2000, 4000]);
            sendResponse({ success: true, mode: request.mode });
        });
        return true;
    }

    if (request.action === 'GET_MODE') {
        browserAPI.storage.local.get(['mode', 'userSetMode', 'supabaseEnabled'], function(result) {
            sendResponse({
                success: true,
                mode: result.mode || 'AUTOMATIC',
                userSetMode: result.userSetMode || false,
                supabaseEnabled: result.supabaseEnabled !== false
            });
        });
        return true;
    }

    // === CLEAR_DUPLICATE_CACHE — forward to content script, fallback to local ===
    if (request.action === 'CLEAR_DUPLICATE_CACHE') {
        browserAPI.tabs.query({ active: true, currentWindow: true }, function(tabs) {
            if (tabs && tabs[0] && tabs[0].url && tabs[0].url.indexOf('seller.indiamart.com') !== -1) {
                safeSendToTab(tabs[0].id, request, function(r, err) {
                    if (err || !r) {
                        fallbackClearDup(sendResponse);
                    } else {
                        sendResponse(r);
                    }
                });
            } else {
                fallbackClearDup(sendResponse);
            }
        });
        return true;
    }

    // === FORWARD to content script ===
    var forwardActions = [
        'GET_STATUS', 'SET_LIMITS', 'SET_MIN_SCORE',
        'EMERGENCY_STOP', 'RESUME', 'UPDATE_KEYWORDS',
        'UPDATE_CONFIG', 'UPDATE_FULL_CONFIG', 'REFRESH_FILTERS',
        'RESET_PANEL_POSITION', 'SET_AUTO_MINIMIZE', 'SET_CONFIRMATION_ANSWER',
        'SET_PURCHASE_ACTION', 'SET_AUTO_SCROLL', 'CLEAR_ALL_LOCAL_DATA',
        'GET_CONFIG', 'GET_KEYWORDS_DEBUG', 'RESET_DUPLICATES',
        'SET_STRICT_COUNTRY', 'TEST_LOAD_MORE'
    ];

    if (forwardActions.indexOf(request.action) !== -1) {
        browserAPI.tabs.query({ active: true, currentWindow: true }, function(tabs) {
            if (tabs && tabs[0]) {
                safeSendToTab(tabs[0].id, request, function(response, err) {
                    if (err || !response) {
                        if (request.action === 'GET_STATUS' && cachedStatus) {
                            sendResponse(Object.assign({ success: true, cached: true }, cachedStatus));
                        } else {
                            sendResponse({ success: false, error: err || 'Content script not available' });
                        }
                    } else {
                        sendResponse(response);
                    }
                });
            } else {
                if (request.action === 'GET_STATUS' && cachedStatus) {
                    sendResponse(Object.assign({ success: true, cached: true }, cachedStatus));
                } else {
                    sendResponse({ success: false, error: 'No active tab' });
                }
            }
        });
        return true;
    }

    sendResponse({ success: false, error: 'Unknown action: ' + request.action });
    return true;
});

function fallbackClearDup(sendResponse) {
    browserAPI.storage.local.get(null, function(all) {
        var toRemove = [];
        for (var k in all) {
            if (Object.prototype.hasOwnProperty.call(all, k) && k.indexOf('clicked_') === 0) {
                toRemove.push(k);
            }
        }
        if (toRemove.length > 0) {
            browserAPI.storage.local.remove(toRemove, function() {
                sendResponse({ success: true, message: 'Cleared ' + toRemove.length + ' local dup keys' });
            });
        } else {
            sendResponse({ success: true, message: 'No dup keys found' });
        }
    });
}

// ============================================================
// KEEP ALIVE (MV3: service worker survives via events, not intervals)
// ============================================================
browserAPI.runtime.onConnect.addListener(function(port) {
    if (port.name === 'keepAlive') {
        port.onDisconnect.addListener(function() {});
        try { port.postMessage({ type: 'keepAlive' }); } catch (e) {}
    }
});

// ============================================================
// TAB UPDATE LISTENER — retry with backoff on hydration
// ============================================================
browserAPI.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
    if (changeInfo.status !== 'complete') return;
    if (!tab || !tab.url || tab.url.indexOf('seller.indiamart.com/bltxn') === -1) return;

    console.log('[SW] IndiaMART page loaded');
    runGatedFilterCheck();

    browserAPI.storage.local.get(['mode', 'userSetMode', 'supabaseEnabled'], function(result) {
        var mode = result.mode || 'AUTOMATIC';
        var supabaseEnabled = result.supabaseEnabled !== false;
        if (!result.userSetMode) {
            mode = 'AUTOMATIC';
            browserAPI.storage.local.set({ mode: 'AUTOMATIC' });
        }

        // Try at 2.5s, 4s, 6s, 8s — content script may attach late on slow networks
        var delays = [2500, 4000, 6000, 8000];
        var attempt = 0;
        function push() {
            if (attempt >= delays.length) return;
            setTimeout(function() {
                safeSendToTab(tabId, { action: 'SET_MODE', mode: mode }, function(r, err) {
                    if (err) {
                        attempt++;
                        push();
                        return;
                    }
                    // Once mode lands, also push supabase state
                    safeSendToTab(tabId, { action: 'TOGGLE_SUPABASE', enabled: supabaseEnabled }, function() {});
                });
            }, delays[attempt] - (attempt > 0 ? delays[attempt - 1] : 0));
        }
        push();
    });
});

console.log('[SW] BuyLead Assistant v4.2.0 loaded');