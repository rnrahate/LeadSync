// config/config.js
// Full CRUD for filters + keywords management
// Developed by Keyn Labs
// Version 7.1.0
// ============================================================================
// CHANGELOG v7.1.0
//   • Attio-style UI — removed emojis from all user-facing strings
//   • Filter cards, empty states, toasts all text-only
//   • All functionality preserved
// ============================================================================

console.log('BuyLead Assistant Config v7.1.0');

var browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
var SUPABASE_URL = 'https://chqewpjsibouqvqkxuli.supabase.co';
var SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNocWV3cGpzaWJvdXF2cWt4dWxpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEzODg5OTAsImV4cCI6MjEwNjk2NDk5MH0.b-M_MKu-yVjpNwFNwTEmWqksJhj-ffXcZ2Mr42AW1bE';

var SB_HEADERS = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
};

var SB_FETCH_TIMEOUT = 12000;

// ============================================================
// DEFAULT CONFIG — MIRRORS bundle.js v6.2 / service-worker v4.2
// ============================================================
var DEFAULT_CONFIG = {
    mode: 'AUTOMATIC',
    minScore: 60,

    maxPerMinute: 60,
    maxPerHour: 400,
    maxPerDay: 2000,
    maxPerSession: 1000,
    cooldownMs: 0,

    strictCountryMode: false,
    allowedCountries: ['IN'],
    strictCountryRejectUnknown: true,

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

    autoMinimize: true,
    popupTimeoutMs: 5000,
    confirmationAnswer: 'yes',
    purchaseAction: 'close',

    supabaseEnabled: true
};

var supabaseEnabled = true;
var editingFilterId = null;

// ============================================================
// FETCH HELPER WITH TIMEOUT
// ============================================================
async function sbFetch(url, options, timeoutMs) {
    timeoutMs = timeoutMs || SB_FETCH_TIMEOUT;
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
    try {
        var opts = Object.assign({}, options || {}, { signal: controller.signal });
        var res = await fetch(url, opts);
        clearTimeout(timer);
        return res;
    } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') throw new Error('Timeout after ' + timeoutMs + 'ms');
        throw err;
    }
}

// ============================================================
// TOAST
// ============================================================
function showToast(message, type) {
    type = type || 'info';
    var container = document.getElementById('toastContainer');
    if (!container) return;
    var toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(function() {
        toast.style.animation = 'toastOut 0.3s ease';
        setTimeout(function() {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 300);
    }, 3200);
}

// ============================================================
// SAFE PARSE HELPERS
// ============================================================
function safeInt(val, fallback) {
    var n = parseInt(val, 10);
    return isNaN(n) ? (fallback || 0) : n;
}
function safeFloat(val, fallback) {
    var n = parseFloat(val);
    return isNaN(n) ? (fallback || 0) : n;
}
function parseTextarea(id) {
    var el = document.getElementById(id);
    if (!el) return [];
    return el.value.split('\n').map(function(k) { return k.trim(); }).filter(function(k) { return k.length > 0; });
}
function escapeHtml(text) {
    if (!text) return '';
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', function() {
    autoMigrateIfNeeded().then(function() {
        loadConfig();
        loadKeywords();
        loadSupabaseSetting();
        loadFilters();
        refreshCounts();
        setupTabs();
        setupModeButtons();
        setupEventListeners();
        setupKeywordCounters();
        setupModal();
    });
});

function autoMigrateIfNeeded() {
    return new Promise(function(resolve) {
        browserAPI.storage.local.get(
            ['initialized_v620', 'mode', 'userSetMode', 'keywords'],
            function(result) {
                if (result.initialized_v620) { resolve(); return; }

                var seed = Object.assign({}, DEFAULT_CONFIG);
                if (result.userSetMode && result.mode) {
                    seed.mode = result.mode;
                    seed.userSetMode = true;
                }
                if (result.keywords) seed.keywords = result.keywords;

                browserAPI.storage.local.set(seed, function() {
                    browserAPI.storage.local.set({ initialized_v620: true }, function() {
                        console.log('[Config] Auto-migrated to v6.20 defaults');
                        resolve();
                    });
                });
            }
        );
    });
}

function setupTabs() {
    document.querySelectorAll('.tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
            document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
            this.classList.add('active');
            document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
            var target = document.getElementById('tab-' + this.dataset.tab);
            if (target) target.classList.add('active');
            if (this.dataset.tab === 'data') refreshCounts();
            if (this.dataset.tab === 'filters') loadFilters();
        });
    });
}

function setupModeButtons() {
    document.querySelectorAll('.mode-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.mode-btn').forEach(function(b) { b.classList.remove('active'); });
            this.classList.add('active');
            updateModeInfo(this.dataset.mode);
        });
    });
}

function updateModeInfo(mode) {
    var infoBox = document.getElementById('modeInfo');
    if (!infoBox) return;
    var descriptions = {
        'MONITOR':   '<strong>Monitor:</strong> Only detects and displays leads.',
        'DRY_RUN':   '<strong>Dry Run:</strong> Full pipeline but no real clicks.',
        'ASSISTED':  '<strong>Assisted:</strong> Shows approval popup for each matched lead.',
        'AUTOMATIC': '<strong>Automatic:</strong> Auto-clicks "Contact Buyer Now".'
    };
    infoBox.innerHTML = descriptions[mode] || descriptions['AUTOMATIC'];
}

function setupKeywordCounters() {
    ['product', 'negative', 'required'].forEach(function(type) {
        var t = document.getElementById(type + 'Keywords');
        if (t) t.addEventListener('input', function() { updateKeywordCount(type); });
    });
}

function updateKeywordCount(type) {
    var t = document.getElementById(type + 'Keywords');
    if (!t) return;
    var count = t.value.split('\n').filter(function(k) { return k.trim().length > 0; }).length;
    var el = document.getElementById(type + 'Count');
    if (el) el.textContent = count;
}

function setupModal() {
    var modal = document.getElementById('filterModal');
    var closeBtn = document.getElementById('filterModalClose');
    var cancelBtn = document.getElementById('filterModalCancel');
    var saveBtn = document.getElementById('filterModalSave');

    function closeModal() {
        modal.style.display = 'none';
        editingFilterId = null;
    }

    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', function(e) {
        if (e.target === modal) closeModal();
    });

    saveBtn.addEventListener('click', saveFilter);
}

// ============================================================
// EVENT LISTENERS
// ============================================================
function setupEventListeners() {
    document.getElementById('saveAllBtn').addEventListener('click', saveAll);
    document.getElementById('resetAllBtn').addEventListener('click', resetAllToDefaults);
    document.getElementById('saveKeywordsBtn').addEventListener('click', saveLocalKeywords);
    document.getElementById('resetKeywordsBtn').addEventListener('click', resetLocalKeywords);
    document.getElementById('saveScoringBtn').addEventListener('click', saveScoring);
    document.getElementById('resetScoringBtn').addEventListener('click', resetScoring);
    document.getElementById('backBtn').addEventListener('click', function() { window.close(); });
    document.getElementById('debugLink').addEventListener('click', function() {
        browserAPI.tabs.create({ url: browserAPI.runtime.getURL('debug/index.html') });
    });

    // Supabase toggle
    document.getElementById('configSupabaseToggle').addEventListener('change', function() {
        var enabled = this.checked;
        supabaseEnabled = enabled;
        browserAPI.storage.local.set({ supabaseEnabled: enabled }, function() {
            updateConfigSupabaseUI(enabled);
            browserAPI.runtime.sendMessage({ action: 'TOGGLE_SUPABASE', enabled: enabled });
            showToast(enabled ? 'Supabase ON' : 'Supabase OFF', 'success');
        });
    });

    // Filters
    document.getElementById('refreshFiltersBtn').addEventListener('click', function() {
        loadFilters(true);
    });
    document.getElementById('addFilterBtn').addEventListener('click', function() {
        openFilterModal(null);
    });
    document.getElementById('bulkSyncBtn').addEventListener('click', bulkSyncKeywords);

    // Strict country
    ['strictCountryMode', 'allowedCountries', 'strictCountryRejectUnknown'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', updateStrictCountryPreview);
            el.addEventListener('input', updateStrictCountryPreview);
        }
    });

    // Counts
    document.getElementById('refreshCountsBtn').addEventListener('click', function() {
        var btn = this;
        var orig = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Refreshing...';
        refreshCounts().then(function() {
            btn.disabled = false;
            btn.textContent = orig;
        });
    });

    // Data management buttons
    var dataActions = {
        'clearDupCache': function() {
            if (!confirm('Clear the duplicate cache?')) return;
            browserAPI.runtime.sendMessage({ action: 'CLEAR_DUPLICATE_CACHE' }, function(r) {
                showToast(r && r.success ? 'Duplicate cache cleared' : (r ? r.error : 'Failed'), r && r.success ? 'success' : 'error');
            });
        },
        'clearAllLocal': function() {
            if (!confirm('Delete ALL local data? (config & keywords kept)')) return;
            if (!confirm('Confirm again?')) return;
            browserAPI.runtime.sendMessage({ action: 'CLEAR_ALL_LOCAL_DATA' }, function() {
                showToast('Local data cleared', 'success');
            });
        },
        'resetStats': function() {
            if (!confirm('Reset filter stats in Supabase?')) return;
            browserAPI.runtime.sendMessage({ action: 'SUPABASE_RESET_STATS' }, function(r) {
                showToast(r && r.success ? 'Stats reset' : (r ? r.error : 'Failed'), r && r.success ? 'success' : 'error');
                refreshCounts();
            });
        },
        'clearHistory': function() {
            if (!confirm('Delete ALL lead history from Supabase?')) return;
            if (!confirm('Confirm again?')) return;
            browserAPI.runtime.sendMessage({ action: 'SUPABASE_CLEAR_HISTORY' }, function(r) {
                showToast(r && r.success ? 'History deleted' : (r ? r.error : 'Failed'), r && r.success ? 'success' : 'error');
                refreshCounts();
            });
        },
        'clearLeads': function() {
            if (!confirm('Delete ALL LEADS from Supabase?\nThis cascades to history.')) return;
            var txt = prompt('Type "DELETE ALL" to confirm:');
            if (txt !== 'DELETE ALL') { showToast('Cancelled', 'error'); return; }
            browserAPI.runtime.sendMessage({ action: 'SUPABASE_CLEAR_LEADS' }, function(r) {
                showToast(r && r.success ? 'Leads deleted' : (r ? r.error : 'Failed'), r && r.success ? 'success' : 'error');
                refreshCounts();
            });
        },
        'clearBefore': function() {
            var dateStr = prompt('Delete leads before (YYYY-MM-DD):');
            if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) { showToast('Invalid date', 'error'); return; }
            if (!confirm('Delete leads before ' + dateStr + '?')) return;
            browserAPI.runtime.sendMessage({ action: 'SUPABASE_CLEAR_BEFORE', date: dateStr + 'T00:00:00Z' }, function(r) {
                showToast(r && r.success ? 'Deleted' : (r ? r.error : 'Failed'), r && r.success ? 'success' : 'error');
                refreshCounts();
            });
        },
        'clearFilters': function() {
            if (!confirm('Delete ALL filters from Supabase?\nThis removes all your filter configurations.')) return;
            var txt = prompt('Type "DELETE FILTERS" to confirm:');
            if (txt !== 'DELETE FILTERS') { showToast('Cancelled', 'error'); return; }
            browserAPI.runtime.sendMessage({ action: 'SUPABASE_CLEAR_FILTERS' }, function(r) {
                showToast(r && r.success ? 'Filters deleted' : (r ? r.error : 'Failed'), r && r.success ? 'success' : 'error');
                loadFilters();
                refreshCounts();
            });
        }
    };

    document.querySelectorAll('[data-action]').forEach(function(el) {
        var action = el.getAttribute('data-action');
        if (dataActions[action]) {
            el.addEventListener('click', dataActions[action]);
        }
    });
}

// ============================================================
// LOAD CONFIG
// ============================================================
function loadSupabaseSetting() {
    browserAPI.storage.local.get(['supabaseEnabled'], function(result) {
        supabaseEnabled = result.supabaseEnabled !== false;
        var toggle = document.getElementById('configSupabaseToggle');
        if (toggle) toggle.checked = supabaseEnabled;
        updateConfigSupabaseUI(supabaseEnabled);
    });
}

function updateConfigSupabaseUI(enabled) {
    var container = document.getElementById('connectionToggle');
    var label  = document.getElementById('configConnLabel');
    var desc   = document.getElementById('configConnDesc');
    if (!container) return;
    if (enabled) {
        container.classList.remove('offline');
        label.textContent = 'Supabase Mode: ON';
        desc.textContent = 'Using CRM filters from Supabase';
    } else {
        container.classList.add('offline');
        label.textContent = 'Supabase Mode: OFF';
        desc.textContent = 'Offline mode - using local keywords only';
    }
}

function loadConfig() {
    browserAPI.storage.local.get(DEFAULT_CONFIG, function(config) {
        var m = Object.assign({}, DEFAULT_CONFIG, config);

        document.querySelectorAll('.mode-btn').forEach(function(btn) {
            btn.classList.toggle('active', btn.dataset.mode === m.mode);
        });
        updateModeInfo(m.mode);

        var numberFields = {
            minScore: 'minScore',
            perMinute: 'maxPerMinute',
            perHour: 'maxPerHour',
            perDay: 'maxPerDay',
            perSession: 'maxPerSession',
            cooldownMs: 'cooldownMs',
            scrollSpeed: 'scrollSpeed',
            scrollDelayMs: 'scrollDelayMs',
            bottomWaitMs: 'bottomWaitMs',
            loopIntervalMs: 'loopIntervalMs',
            loadMoreWaitMs: 'loadMoreWaitMs',
            maxStuckLoops: 'maxStuckLoops',
            autoReloadDelayMs: 'autoReloadDelayMs',
            maxReloadsPerSession: 'maxReloadsPerSession',
            popupTimeoutMs: 'popupTimeoutMs'
        };
        Object.keys(numberFields).forEach(function(domId) {
            var el = document.getElementById(domId);
            if (el) el.value = m[numberFields[domId]];
        });

        ['autoScroll', 'autoReloadOnComplete', 'autoMinimize'].forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.checked = m[id] !== false;
        });

        ['confirmationAnswer', 'purchaseAction'].forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.value = m[id];
        });

        var w = Object.assign({}, DEFAULT_CONFIG.scoreWeights, m.scoreWeights || {});
        ['base', 'perProductKeyword', 'maxProductBonus', 'preferredState', 'countryMatch',
         'hasMobile', 'hasEmail', 'hasPhone', 'detailedRequirement', 'requirementLengthThreshold'].forEach(function(k) {
            var el = document.getElementById('w' + k.charAt(0).toUpperCase() + k.slice(1));
            if (el) el.value = w[k];
        });

        var p = Object.assign({}, DEFAULT_CONFIG.scorePenalties, m.scorePenalties || {});
        var pMap = { wrongCountry: 'pWrongCountry', wrongState: 'pWrongState', noContact: 'pNoContact' };
        Object.keys(pMap).forEach(function(k) {
            var el = document.getElementById(pMap[k]);
            if (el) el.value = p[k];
        });

        var elPC = document.getElementById('preferredCountries');
        if (elPC) elPC.value = (m.preferredCountries || DEFAULT_CONFIG.preferredCountries).join(', ');
        var elPS = document.getElementById('preferredStates');
        if (elPS) elPS.value = (m.preferredStates || DEFAULT_CONFIG.preferredStates).join(', ');

        var elSCM = document.getElementById('strictCountryMode');
        if (elSCM) elSCM.checked = m.strictCountryMode === true;
        var elAC = document.getElementById('allowedCountries');
        if (elAC) elAC.value = (m.allowedCountries || DEFAULT_CONFIG.allowedCountries).join(', ');
        var elSCRU = document.getElementById('strictCountryRejectUnknown');
        if (elSCRU) elSCRU.checked = m.strictCountryRejectUnknown !== false;
        updateStrictCountryPreview();
    });
}

function updateStrictCountryPreview() {
    var el = document.getElementById('strictCountryPreview');
    if (!el) return;
    var enabledEl = document.getElementById('strictCountryMode');
    var allowedEl = document.getElementById('allowedCountries');
    var rejectEl  = document.getElementById('strictCountryRejectUnknown');
    if (!enabledEl || !allowedEl || !rejectEl) return;

    var enabled = enabledEl.checked;
    var raw = allowedEl.value || '';
    var list = raw.split(',').map(function(c) { return c.toUpperCase().trim(); }).filter(function(c) { return c; });
    var rejectUnknown = rejectEl.checked;

    if (!enabled) {
        el.innerHTML = '<strong>Strict mode OFF</strong> — all countries accepted' +
            (rejectUnknown ? ' <em style="font-size:10px;">(unknown still rejected)</em>' : '');
        el.style.background = '#fffbeb';
        el.style.borderLeftColor = '#d97706';
        el.style.color = '#92400e';
    } else if (list.length === 0) {
        el.innerHTML = '<strong>Strict mode ON but no countries configured</strong> — ALL leads blocked';
        el.style.background = '#fef2f2';
        el.style.borderLeftColor = '#dc2626';
        el.style.color = '#b91c1c';
    } else {
        el.innerHTML = '<strong>STRICT MODE ON</strong> — Only: <strong>' + list.join(', ') + '</strong>' +
            (rejectUnknown ? '<br><em style="font-size:10px;">Unknown countries also rejected</em>' : '');
        el.style.background = '#f0fdfa';
        el.style.borderLeftColor = '#0d9488';
        el.style.color = '#0f766e';
    }
}

function loadKeywords() {
    browserAPI.storage.local.get(['keywords'], function(result) {
        var k = result.keywords || {};
        var el1 = document.getElementById('productKeywords');  if (el1) el1.value = (k.product  || []).join('\n');
        var el2 = document.getElementById('negativeKeywords'); if (el2) el2.value = (k.negative || []).join('\n');
        var el3 = document.getElementById('requiredKeywords'); if (el3) el3.value = (k.required || []).join('\n');
        updateKeywordCount('product');
        updateKeywordCount('negative');
        updateKeywordCount('required');
    });
}

// ============================================================
// FILTERS CRUD
// ============================================================
async function loadFilters(forceRefresh) {
    var container = document.getElementById('filtersList');
    var countEl = document.getElementById('filtersCount');
    if (!container) return;

    if (!supabaseEnabled) {
        container.innerHTML = '<div class="empty-state">Supabase is OFF — filters not available</div>';
        if (countEl) countEl.textContent = '0';
        return;
    }

    container.innerHTML = '<div class="empty-state">Loading filters...</div>';

    try {
        var res = await sbFetch(SUPABASE_URL + '/rest/v1/filters?select=*&order=id.asc', {
            headers: SB_HEADERS
        });
        if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()).substring(0, 200));

        var filters = await res.json();
        if (countEl) countEl.textContent = filters.length;

        if (filters.length === 0) {
            container.innerHTML = '<div class="empty-state">No filters yet. Click "Add New Filter" to create one.</div>';
            return;
        }

        container.innerHTML = filters.map(renderFilterCard).join('');
        bindFilterActions();
    } catch (err) {
        container.innerHTML = '<div class="empty-state error">Failed: ' + escapeHtml(err.message) + '</div>';
        if (countEl) countEl.textContent = '0';
    }
}

function renderFilterCard(f) {
    var config = f.filter_config || {};
    var pk = Array.isArray(f.product_keywords)  ? f.product_keywords  : (config.product_names     || []);
    var nk = Array.isArray(f.negative_keywords) ? f.negative_keywords : (config.negative_keywords || []);
    var rk = Array.isArray(f.required_keywords) ? f.required_keywords : (config.required_keywords || []);
    var lk = Array.isArray(f.location_keywords) ? f.location_keywords : [];

    if (pk.length === 0 && Array.isArray(config.product_names))     pk = config.product_names;
    if (nk.length === 0 && Array.isArray(config.negative_keywords)) nk = config.negative_keywords;
    if (rk.length === 0 && Array.isArray(config.required_keywords)) rk = config.required_keywords;
    if (lk.length === 0) {
        lk = []
            .concat(Array.isArray(config.countries) ? config.countries : [])
            .concat(Array.isArray(config.states)    ? config.states    : []);
    }

    var isLegacy = (!f.product_keywords || f.product_keywords.length === 0) &&
                   f.filter_config &&
                   (config.product_names && config.product_names.length > 0);

    var isActive = f.is_active !== false;
    var isRunning = f.is_running === true;

    function pillList(arr, emptyMsg) {
        if (!arr || arr.length === 0) {
            return '<span style="color:#a1a1aa;font-style:italic;">' + emptyMsg + '</span>';
        }
        return arr.slice(0, 30).map(function(k) {
            return '<span class="kw-pill">' + escapeHtml(String(k)) + '</span>';
        }).join('') + (arr.length > 30 ? ' <span style="color:#71717a;">+' + (arr.length - 30) + ' more</span>' : '');
    }

    return '' +
        '<div class="filter-card ' + (isActive ? '' : 'inactive') + '" data-filter-id="' + f.id + '">' +
            '<div class="filter-header">' +
                '<div class="filter-header-left">' +
                    '<div class="filter-name">' +
                        escapeHtml(f.filter_name || 'Unnamed Filter') +
                        '<span class="filter-badge ' + (isActive ? 'active' : 'inactive') + '">' +
                            (isActive ? 'Active' : 'Inactive') +
                        '</span>' +
                        (isRunning ? '<span class="filter-badge running">Running</span>' : '') +
                        (isLegacy  ? '<span class="filter-badge legacy">Legacy</span>' : '') +
                    '</div>' +
                    '<div class="filter-meta">ID: ' + f.id + ' · Client: ' + escapeHtml(f.client_id || 'default') + '</div>' +
                '</div>' +
            '</div>' +

            '<div class="filter-kw-section">' +
                '<div class="filter-kw-row"><span class="filter-kw-label">Product</span><span class="filter-kw-value">' + pillList(pk, '(empty — matches any product)') + '</span></div>' +
                '<div class="filter-kw-row"><span class="filter-kw-label">Negative</span><span class="filter-kw-value">' + pillList(nk, '(none)') + '</span></div>' +
                '<div class="filter-kw-row"><span class="filter-kw-label">Required</span><span class="filter-kw-value">' + pillList(rk, '(none)') + '</span></div>' +
                '<div class="filter-kw-row"><span class="filter-kw-label">Location</span><span class="filter-kw-value">' + pillList(lk, '(none)') + '</span></div>' +
            '</div>' +

            '<div class="filter-stats">' +
                '<span>Scanned: <strong>' + (f.stats_scanned || 0) + '</strong></span>' +
                '<span>Matched: <strong>' + (f.stats_matched || 0) + '</strong></span>' +
                '<span>Clicked: <strong>' + (f.stats_clicked || 0) + '</strong></span>' +
                '<span>P-KW: <strong>' + pk.length + '</strong></span>' +
                '<span>L-KW: <strong>' + lk.length + '</strong></span>' +
            '</div>' +

            '<div class="filter-actions">' +
                '<button class="btn-tiny btn-edit"   data-action="edit"   data-id="' + f.id + '">Edit</button>' +
                '<button class="btn-tiny btn-toggle" data-action="toggle" data-id="' + f.id + '" data-active="' + isActive + '">' + (isActive ? 'Disable' : 'Enable') + '</button>' +
                '<button class="btn-tiny btn-delete" data-action="delete" data-id="' + f.id + '">Delete</button>' +
            '</div>' +
        '</div>';
}

function bindFilterActions() {
    document.querySelectorAll('[data-action][data-id]').forEach(function(btn) {
        var action = btn.getAttribute('data-action');
        var id = btn.getAttribute('data-id');

        if (action === 'edit') {
            btn.addEventListener('click', function() { editFilter(id); });
        } else if (action === 'toggle') {
            btn.addEventListener('click', function() {
                var active = btn.getAttribute('data-active') === 'true';
                toggleFilter(id, !active);
            });
        } else if (action === 'delete') {
            btn.addEventListener('click', function() { deleteFilter(id); });
        }
    });
}

async function editFilter(id) {
    try {
        var res = await sbFetch(SUPABASE_URL + '/rest/v1/filters?id=eq.' + id + '&select=*', {
            headers: SB_HEADERS
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var arr = await res.json();
        if (arr.length === 0) throw new Error('Filter not found');
        openFilterModal(arr[0]);
    } catch (err) {
        showToast('Failed to load filter: ' + err.message, 'error');
    }
}

function openFilterModal(filter) {
    editingFilterId = filter ? filter.id : null;

    var modal = document.getElementById('filterModal');
    var title = document.getElementById('filterModalTitle');
    var config = filter && filter.filter_config ? filter.filter_config : {};

    if (filter) {
        title.textContent = 'Edit Filter #' + filter.id;
        document.getElementById('editFilterId').value = filter.id;
        document.getElementById('editFilterName').value = filter.filter_name || '';
        document.getElementById('editClientId').value   = filter.client_id || 'default';
        document.getElementById('editIsActive').checked = filter.is_active !== false;

        var pk = (Array.isArray(filter.product_keywords)  && filter.product_keywords.length  > 0)
            ? filter.product_keywords
            : (Array.isArray(config.product_names) ? config.product_names : []);
        var nk = (Array.isArray(filter.negative_keywords) && filter.negative_keywords.length > 0)
            ? filter.negative_keywords
            : (Array.isArray(config.negative_keywords) ? config.negative_keywords : []);
        var rk = (Array.isArray(filter.required_keywords) && filter.required_keywords.length > 0)
            ? filter.required_keywords
            : (Array.isArray(config.required_keywords) ? config.required_keywords : []);
        var lk = (Array.isArray(filter.location_keywords) && filter.location_keywords.length > 0)
            ? filter.location_keywords
            : [].concat(
                Array.isArray(config.countries) ? config.countries : [],
                Array.isArray(config.states)    ? config.states    : []
            );

        document.getElementById('editProductKeywords').value  = pk.join('\n');
        document.getElementById('editNegativeKeywords').value = nk.join('\n');
        document.getElementById('editRequiredKeywords').value = rk.join('\n');
        document.getElementById('editLocationKeywords').value = lk.join('\n');
    } else {
        title.textContent = 'Add New Filter';
        document.getElementById('editFilterId').value = '';
        document.getElementById('editFilterName').value = '';
        document.getElementById('editClientId').value = 'default';
        document.getElementById('editIsActive').checked = true;
        document.getElementById('editProductKeywords').value  = '';
        document.getElementById('editNegativeKeywords').value = '';
        document.getElementById('editRequiredKeywords').value = '';
        document.getElementById('editLocationKeywords').value = '';
    }

    modal.style.display = 'flex';
}

async function saveFilter() {
    var name     = document.getElementById('editFilterName').value.trim();
    var clientId = document.getElementById('editClientId').value.trim() || 'default';
    var isActive = document.getElementById('editIsActive').checked;
    var productKw  = parseTextarea('editProductKeywords');
    var negativeKw = parseTextarea('editNegativeKeywords');
    var requiredKw = parseTextarea('editRequiredKeywords');
    var locationKw = parseTextarea('editLocationKeywords');

    if (!name) {
        showToast('Filter name is required', 'error');
        return;
    }

    var saveBtn = document.getElementById('filterModalSave');
    var orig = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
        var countries = locationKw.filter(function(l) {
            return /^(in|us|uk|gb|ae|sa|ru|cn|au|ca|de|fr|jp|br|mx|it|es|kr|nl|za|sg|th|vn|id|my|ph|tr|eg|il|pk|bd|lk|np|india|usa|uk|uae)$/i.test(l)
                || l.length === 2;
        });
        var states = locationKw.filter(function(l) { return countries.indexOf(l) === -1; });

        var row = {
            filter_name: name,
            client_id: clientId,
            is_active: isActive,
            product_keywords:  productKw,
            negative_keywords: negativeKw,
            required_keywords: requiredKw,
            location_keywords: locationKw,
            updated_at: new Date().toISOString()
        };

        var url, method;
        if (editingFilterId) {
            url = SUPABASE_URL + '/rest/v1/filters?id=eq.' + editingFilterId;
            method = 'PATCH';
        } else {
            url = SUPABASE_URL + '/rest/v1/filters';
            method = 'POST';
        }

        var res = await sbFetch(url, {
            method: method,
            headers: SB_HEADERS,
            body: JSON.stringify(row)
        });

        if (!res.ok) {
            var errText = await res.text();
            throw new Error('HTTP ' + res.status + ': ' + errText.substring(0, 200));
        }

        document.getElementById('filterModal').style.display = 'none';
        var wasEditing = !!editingFilterId;
        editingFilterId = null;

        showToast(wasEditing ? 'Filter updated' : 'Filter created', 'success');

        await loadFilters(true);
        refreshCounts();

        browserAPI.runtime.sendMessage({ action: 'REFRESH_FILTERS' });
    } catch (err) {
        showToast('Save failed: ' + err.message, 'error');
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = orig;
    }
}

async function toggleFilter(id, isActive) {
    try {
        var res = await sbFetch(SUPABASE_URL + '/rest/v1/filters?id=eq.' + id, {
            method: 'PATCH',
            headers: SB_HEADERS,
            body: JSON.stringify({ is_active: isActive, updated_at: new Date().toISOString() })
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        showToast(isActive ? 'Filter enabled' : 'Filter disabled', 'success');
        await loadFilters(true);
        browserAPI.runtime.sendMessage({ action: 'REFRESH_FILTERS' });
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function deleteFilter(id) {
    if (!confirm('Delete filter #' + id + ' permanently?')) return;
    if (!confirm('This cannot be undone. Continue?')) return;

    try {
        var res = await sbFetch(SUPABASE_URL + '/rest/v1/filters?id=eq.' + id, {
            method: 'DELETE',
            headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': 'Bearer ' + SUPABASE_KEY,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            }
        });
        if (!res.ok) {
            var errText = await res.text();
            throw new Error('HTTP ' + res.status + ': ' + errText.substring(0, 200));
        }
        showToast('Filter deleted', 'success');
        await loadFilters(true);
        refreshCounts();
        browserAPI.runtime.sendMessage({ action: 'REFRESH_FILTERS' });
    } catch (err) {
        showToast('Delete failed: ' + err.message, 'error');
    }
}

// ============================================================
// BULK SYNC — parallel batches of 5
// ============================================================
async function bulkSyncKeywords() {
    var cleanupLegacy = confirm(
        'Sync keywords from filter_config → new keyword columns for ALL filters?\n\n' +
        'Click OK to sync AND clear legacy filter_config afterward.\n' +
        'Click Cancel to sync only (keep legacy for safety).'
    );
    var shouldClearLegacy = cleanupLegacy;

    if (!confirm('Proceed with bulk sync?')) return;

    var btn = document.getElementById('bulkSyncBtn');
    var orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Syncing...';

    try {
        var res = await sbFetch(SUPABASE_URL + '/rest/v1/filters?select=*', {
            headers: SB_HEADERS
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var filters = await res.json();

        var success = 0, failed = 0;
        var BATCH = 5;

        for (var i = 0; i < filters.length; i += BATCH) {
            var batch = filters.slice(i, i + BATCH);
            var promises = batch.map(function(f) {
                var config = f.filter_config || {};
                var pk = Array.isArray(config.product_names)     ? config.product_names     : [];
                var nk = Array.isArray(config.negative_keywords) ? config.negative_keywords : [];
                var rk = Array.isArray(config.required_keywords) ? config.required_keywords : [];
                var lk = [].concat(
                    Array.isArray(config.countries) ? config.countries : [],
                    Array.isArray(config.states)    ? config.states    : []
                );

                var updateBody = {
                    product_keywords:  pk,
                    negative_keywords: nk,
                    required_keywords: rk,
                    location_keywords: lk,
                    updated_at: new Date().toISOString()
                };

                if (shouldClearLegacy) {
                    updateBody.filter_config = null;
                }

                return sbFetch(SUPABASE_URL + '/rest/v1/filters?id=eq.' + f.id, {
                    method: 'PATCH',
                    headers: SB_HEADERS,
                    body: JSON.stringify(updateBody)
                }).then(function(r) {
                    if (r.ok) success++;
                    else failed++;
                }).catch(function() { failed++; });
            });

            await Promise.all(promises);
            btn.textContent = 'Syncing... ' + Math.min(i + BATCH, filters.length) + '/' + filters.length;
        }

        showToast(
            'Sync complete: ' + success + ' updated, ' + failed + ' failed' +
            (shouldClearLegacy ? ' (legacy cleared)' : ''),
            'success'
        );
        await loadFilters(true);
    } catch (err) {
        showToast('Sync failed: ' + err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = orig;
    }
}

// ============================================================
// COUNTS
// ============================================================
async function refreshCounts() {
    var el1 = document.getElementById('countLeads');
    var el2 = document.getElementById('countHistory');
    var el3 = document.getElementById('countFilters');
    if (el1) el1.textContent = '...';
    if (el2) el2.textContent = '...';
    if (el3) el3.textContent = '...';

    try {
        var results = await Promise.allSettled([
            sbFetch(SUPABASE_URL + '/rest/v1/leads?select=id',        { headers: SB_HEADERS }),
            sbFetch(SUPABASE_URL + '/rest/v1/lead_history?select=id', { headers: SB_HEADERS }),
            sbFetch(SUPABASE_URL + '/rest/v1/filters?select=id',      { headers: SB_HEADERS })
        ]);

        var leads  = await safeJsonFromSettled(results[0]);
        var hist   = await safeJsonFromSettled(results[1]);
        var filts  = await safeJsonFromSettled(results[2]);

        if (el1) el1.textContent = Array.isArray(leads) ? leads.length : '?';
        if (el2) el2.textContent = Array.isArray(hist)  ? hist.length  : '?';
        if (el3) el3.textContent = Array.isArray(filts) ? filts.length : '?';
    } catch (err) {
        if (el1) el1.textContent = '?';
        if (el2) el2.textContent = '?';
        if (el3) el3.textContent = '?';
    }
}

async function safeJsonFromSettled(settled) {
    if (!settled || settled.status !== 'fulfilled') return [];
    var resp = settled.value;
    if (!resp || !resp.ok) return [];
    try { return await resp.json(); } catch (e) { return []; }
}

// ============================================================
// SAVE / RESET
// ============================================================
function getConfig() {
    var activeMode = document.querySelector('.mode-btn.active');
    var c = Object.assign({}, DEFAULT_CONFIG);
    c.mode = activeMode ? activeMode.dataset.mode : 'AUTOMATIC';

    var numberFields = {
        minScore: 'minScore',
        perMinute: 'maxPerMinute',
        perHour: 'maxPerHour',
        perDay: 'maxPerDay',
        perSession: 'maxPerSession',
        cooldownMs: 'cooldownMs',
        scrollSpeed: 'scrollSpeed',
        scrollDelayMs: 'scrollDelayMs',
        bottomWaitMs: 'bottomWaitMs',
        loopIntervalMs: 'loopIntervalMs',
        loadMoreWaitMs: 'loadMoreWaitMs',
        maxStuckLoops: 'maxStuckLoops',
        autoReloadDelayMs: 'autoReloadDelayMs',
        maxReloadsPerSession: 'maxReloadsPerSession',
        popupTimeoutMs: 'popupTimeoutMs'
    };
    Object.keys(numberFields).forEach(function(domId) {
        var el = document.getElementById(domId);
        if (el) c[numberFields[domId]] = safeInt(el.value, DEFAULT_CONFIG[numberFields[domId]]);
    });

    ['autoScroll', 'autoReloadOnComplete', 'autoMinimize'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) c[id] = el.checked;
    });

    var caEl = document.getElementById('confirmationAnswer');
    if (caEl) c.confirmationAnswer = caEl.value;
    var paEl = document.getElementById('purchaseAction');
    if (paEl) c.purchaseAction = paEl.value;

    c.supabaseEnabled = supabaseEnabled;

    c.scoreWeights = {
        base: safeInt(document.getElementById('wBase').value, 50),
        perProductKeyword: safeInt(document.getElementById('wPerProductKeyword').value, 10),
        maxProductBonus: safeInt(document.getElementById('wMaxProductBonus').value, 30),
        preferredState: safeInt(document.getElementById('wPreferredState').value, 15),
        countryMatch: safeInt(document.getElementById('wCountryMatch').value, 15),
        hasMobile: safeInt(document.getElementById('wHasMobile').value, 10),
        hasEmail: safeInt(document.getElementById('wHasEmail').value, 8),
        hasPhone: safeInt(document.getElementById('wHasPhone').value, 5),
        detailedRequirement: safeInt(document.getElementById('wDetailedRequirement').value, 5),
        requirementLengthThreshold: safeInt(document.getElementById('wRequirementLengthThreshold').value, 100)
    };

    c.scorePenalties = {
        wrongCountry: safeInt(document.getElementById('pWrongCountry').value, -20),
        wrongState: safeInt(document.getElementById('pWrongState').value, -10),
        noContact: safeInt(document.getElementById('pNoContact').value, -5)
    };

    c.preferredCountries = (document.getElementById('preferredCountries').value || '')
        .split(',').map(function(x) { return x.trim().toUpperCase(); }).filter(function(x) { return x; });
    c.preferredStates = (document.getElementById('preferredStates').value || '')
        .split(',').map(function(x) { return x.trim().toLowerCase(); }).filter(function(x) { return x; });

    var scmEl = document.getElementById('strictCountryMode');
    c.strictCountryMode = scmEl ? scmEl.checked : false;

    var acEl = document.getElementById('allowedCountries');
    c.allowedCountries = (acEl ? acEl.value : '')
        .split(',').map(function(x) { return x.toUpperCase().trim(); }).filter(function(x) { return x; });

    var scruEl = document.getElementById('strictCountryRejectUnknown');
    c.strictCountryRejectUnknown = scruEl ? scruEl.checked : true;

    return c;
}

function getLocalKeywords() {
    return {
        product:  parseTextarea('productKeywords'),
        negative: parseTextarea('negativeKeywords'),
        required: parseTextarea('requiredKeywords')
    };
}

function saveAll() {
    var c = getConfig();
    var kw = getLocalKeywords();
    if (c.strictCountryMode && c.allowedCountries.length === 0) {
        showToast('Add at least one country before enabling strict mode', 'error');
        return;
    }
    c.keywords = kw;
    c.userSetMode = true;
    browserAPI.storage.local.set(c, function() {
        browserAPI.runtime.sendMessage({ action: 'UPDATE_FULL_CONFIG', config: c });
        browserAPI.runtime.sendMessage({ action: 'UPDATE_KEYWORDS', keywords: kw });
        showToast('All settings saved!', 'success');
    });
}

function saveScoring() {
    var c = getConfig();
    browserAPI.storage.local.set({
        scoreWeights: c.scoreWeights,
        scorePenalties: c.scorePenalties,
        preferredCountries: c.preferredCountries,
        preferredStates: c.preferredStates,
        strictCountryMode: c.strictCountryMode,
        allowedCountries: c.allowedCountries,
        strictCountryRejectUnknown: c.strictCountryRejectUnknown
    }, function() {
        browserAPI.runtime.sendMessage({ action: 'UPDATE_FULL_CONFIG', config: c });
        showToast('Scoring & country saved!', 'success');
    });
}

function resetScoring() {
    if (!confirm('Reset scoring + country to defaults?')) return;
    browserAPI.storage.local.set({
        scoreWeights: DEFAULT_CONFIG.scoreWeights,
        scorePenalties: DEFAULT_CONFIG.scorePenalties,
        preferredCountries: DEFAULT_CONFIG.preferredCountries,
        preferredStates: DEFAULT_CONFIG.preferredStates,
        strictCountryMode: DEFAULT_CONFIG.strictCountryMode,
        allowedCountries: DEFAULT_CONFIG.allowedCountries,
        strictCountryRejectUnknown: DEFAULT_CONFIG.strictCountryRejectUnknown
    }, function() {
        loadConfig();
        browserAPI.runtime.sendMessage({ action: 'UPDATE_FULL_CONFIG', config: getConfig() });
        showToast('Reset', 'success');
    });
}

function saveLocalKeywords() {
    var k = getLocalKeywords();
    browserAPI.storage.local.set({ keywords: k }, function() {
        browserAPI.runtime.sendMessage({ action: 'UPDATE_KEYWORDS', keywords: k });
        showToast('Local keywords saved!', 'success');
    });
}

function resetLocalKeywords() {
    if (!confirm('Clear all local keywords?')) return;
    var e = { product: [], negative: [], required: [] };
    browserAPI.storage.local.set({ keywords: e }, function() {
        loadKeywords();
        browserAPI.runtime.sendMessage({ action: 'UPDATE_KEYWORDS', keywords: e });
        showToast('Cleared', 'success');
    });
}

function resetAllToDefaults() {
    if (!confirm('Reset ALL settings to defaults?')) return;
    if (!confirm('Confirm again?')) return;

    var seed = Object.assign({}, DEFAULT_CONFIG, {
        userSetMode: true,
        initialized_v620: true
    });

    browserAPI.storage.local.set(seed, function() {
        loadConfig();
        browserAPI.runtime.sendMessage({ action: 'UPDATE_FULL_CONFIG', config: seed });
        showToast('Reset to defaults', 'success');
    });
}