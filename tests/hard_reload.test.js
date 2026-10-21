// Tests for Ultra-Low-Latency Hard Reload & Safe Session Resumption
const assert = require('assert');

// Setup mock chrome environment
global.chrome = {
    runtime: {
        getURL: (p) => 'chrome-extension://mock/' + p,
        onMessage: { addListener: () => {} },
        sendMessage: (msg, cb) => {
            if (typeof cb === 'function') cb({ success: true });
            return Promise.resolve({ success: true });
        }
    },
    storage: {
        local: {
            _store: {},
            get: (keys, cb) => {
                const res = {};
                if (typeof keys === 'string') {
                    res[keys] = global.chrome.storage.local._store[keys];
                } else if (Array.isArray(keys)) {
                    keys.forEach(k => { res[k] = global.chrome.storage.local._store[k]; });
                } else if (typeof keys === 'object' && keys !== null) {
                    Object.keys(keys).forEach(k => {
                        res[k] = (k in global.chrome.storage.local._store) ? global.chrome.storage.local._store[k] : keys[k];
                    });
                }
                if (typeof cb === 'function') cb(res);
            },
            set: (data, cb) => {
                Object.assign(global.chrome.storage.local._store, data);
                if (cb) cb();
            },
            clear: (cb) => {
                global.chrome.storage.local._store = {};
                if (cb) cb();
            }
        },
        onChanged: { addListener: () => {} }
    }
};

// Setup mock DOM & sessionStorage
class MockElement {
    constructor(tag = 'div') {
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.attributes = {};
        this.style = {};
        this._classes = new Set();
        this.classList = {
            add: (c) => this._classes.add(c),
            contains: (c) => this._classes.has(c),
            remove: (c) => this._classes.delete(c)
        };
        this.id = '';
        this.textContent = '';
        this.parentNode = null;
    }
    appendChild(c) {
        c.parentNode = this;
        this.children.push(c);
        return c;
    }
    removeChild(c) {
        this.children = this.children.filter(x => x !== c);
        c.parentNode = null;
        return c;
    }
    remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
    }
    setAttribute(k, v) { this.attributes[k] = v; }
    getAttribute(k) { return this.attributes[k]; }
    hasAttribute(k) { return k in this.attributes; }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    getBoundingClientRect() { return { top: 0, bottom: 200, width: 200, height: 100 }; }
}

global.document = new MockElement('document');
global.document.head = new MockElement('head');
global.document.body = new MockElement('body');
global.document.documentElement = new MockElement('html');
global.document.createElement = (tag) => new MockElement(tag);
global.document.getElementById = (id) => {
    let match = null;
    const find = (n) => {
        if (n.id === id) { match = n; return; }
        for (const c of n.children) { find(c); if (match) return; }
    };
    find(global.document.body);
    return match;
};
global.document.querySelector = () => null;
global.document.querySelectorAll = () => [];

const mockSessionStorage = {
    _data: {},
    getItem: function(k) { return this._data[k] !== undefined ? this._data[k] : null; },
    setItem: function(k, v) { this._data[k] = String(v); },
    removeItem: function(k) { delete this._data[k]; },
    clear: function() { this._data = {}; }
};
global.sessionStorage = mockSessionStorage;

let reloadCountCalls = 0;
global.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
    scrollTo: () => {},
    innerWidth: 1024,
    innerHeight: 768,
    scrollY: 0,
    location: {
        reload: () => { reloadCountCalls++; }
    },
    postMessage: () => {}
};

global.MutationObserver = class {
    constructor(cb) { this.cb = cb; }
    observe() {}
    disconnect() {}
};

// Mock SupabaseService
class MockSupabaseService {
    constructor() {
        this._filters = [
            { id: 'f1', name: 'Filter 1', product_keywords: ['Sunscreen'], target_lead_count: 5, is_active: true }
        ];
        this._filtersLoaded = true;
    }
    setLogger() {}
    loadFilters() { return Promise.resolve(true); }
    getFilters() { return this._filters; }
    updateFilterStatus() {}
    updateFilterStats() {}
    getRecentLeads() { return Promise.resolve([]); }
    insertLead() { return Promise.resolve({ id: 'lead-123' }); }
    markLeadContacted() { return Promise.resolve(true); }
}
global.SupabaseService = MockSupabaseService;
global.window.SupabaseService = MockSupabaseService;

// Load bundle
require('../src/bundle.js');

let passed = 0;
let failed = 0;

function it(name, fn) {
    return Promise.resolve().then(() => fn()).then(() => {
        console.log('  ✅ PASS: ' + name);
        passed++;
    }).catch(err => {
        console.error('  ❌ FAIL: ' + name);
        console.error('     ' + err.message);
        failed++;
    });
}

async function runTests() {
    console.log('\n=== RUNNING HARD RELOAD & RESUMPTION TESTS ===\n');

    const orch = global.window.orchestrator;
    assert.ok(orch, 'Orchestrator must be initialized');
    orch.keywordManager.getActiveFilterCount = () => 1;

    await it('1. PageNavigator defaults to autoReloadOnComplete: true and autoReloadDelayMs: 2500', () => {
        assert.strictEqual(orch.navigator._settings.autoReloadOnComplete, true);
        assert.strictEqual(orch.navigator._settings.autoReloadDelayMs, 2500);
    });

    await it('2. Defer reload when acquisition/contact queue is active or busy', async () => {
        reloadCountCalls = 0;
        orch.navigator._running = true;
        orch.navigator._reloadInProgress = false;

        // Simulate busy queue
        orch.queue.processing = 1;
        orch.queue.queue = [{ leadId: 'lead_in_flight' }];

        orch.navigator._waitForQueueAndReload();
        assert.strictEqual(reloadCountCalls, 0, 'Must NOT reload while queue is processing');
        assert.strictEqual(orch.navigator._reloadInProgress, false, 'Reload must not be in progress while queue is busy');

        // Clean up queue
        orch.queue.processing = 0;
        orch.queue.queue = [];
        if (orch.navigator._queueWaitTimer) {
            clearTimeout(orch.navigator._queueWaitTimer);
            orch.navigator._queueWaitTimer = null;
        }
    });

    await it('3. Completed scan cycle triggers hard reload with configured delay when idle', async () => {
        reloadCountCalls = 0;
        // stop() now correctly resets _lastReloadTime (bug fixed in bundle.js),
        // so a clean stop() is all that's needed before re-enabling for this test.
        orch.navigator.stop();
        orch.navigator._running = true;
        orch.navigator._reloadInProgress = false;
        // Clear persisted storm guard from sessionStorage mock
        delete mockSessionStorage._data['bl_last_reload_time'];
        delete mockSessionStorage._data['bl_last_reload_flag'];
        // Use a small delay for test speed — just validate flags + state, not timer firing
        orch.navigator._settings.autoReloadDelayMs = 50;
        orch.navigator._settings.reloadJitterMs    = 0;

        // State to be persisted
        orch.stats.acquired = 3;
        orch.stats.discovered = 10;
        orch._uniqueSeenIds.add('lead_1');
        orch._uniqueSeenIds.add('lead_2');
        orch.metrics.recordDetection('lead_m1', 1000);
        orch.metrics.recordAcquisitionAttempt('lead_m1');
        orch.metrics.recordAcquisitionSuccess('lead_m1', 1350); // 350ms
        orch.metrics.recordLeadAttemptCompleted('lead_m1', true);

        orch.navigator._waitForQueueAndReload();

        // Reload must NOT fire synchronously (settle timer is 50ms, reload timer is 50ms)
        assert.strictEqual(reloadCountCalls, 0, 'Reload should not happen synchronously before delay');

        // Wait for the 50ms settle timer to fire and call _autoReloadPage(), which sets _reloadInProgress
        await new Promise(r => setTimeout(r, 80));

        assert.strictEqual(orch.navigator._reloadInProgress, true, 'Reload in progress flag must be set');

        // Check persisted state in sessionStorage
        assert.strictEqual(mockSessionStorage.getItem('bl_last_reload_flag'), 'from_reload');
        assert.strictEqual(mockSessionStorage.getItem('bl_reload_pending'), 'true');
        assert.strictEqual(mockSessionStorage.getItem('bl_scanner_auto_resume'), 'true');

        const savedStats = JSON.parse(mockSessionStorage.getItem('bl_session_stats'));
        assert.strictEqual(savedStats.acquired, 3);
        assert.strictEqual(savedStats.discovered, 10);

        const savedSeen = JSON.parse(mockSessionStorage.getItem('bl_session_seen_ids'));
        assert.ok(savedSeen.includes('lead_1'));
        assert.ok(savedSeen.includes('lead_2'));

        const savedMetrics = JSON.parse(mockSessionStorage.getItem('bl_session_metrics'));
        assert.ok(savedMetrics && savedMetrics.acquisitions.length > 0);

        // Wait for the 50ms reload timer to fire (total elapsed ~130ms at this point)
        await new Promise(r => setTimeout(r, 80));
        assert.strictEqual(reloadCountCalls, 1, 'window.location.reload() must be called exactly once');

        // Restore default for subsequent tests
        orch.navigator._settings.autoReloadDelayMs = 2500;
        orch.navigator._settings.reloadJitterMs    = 400;
    });

    await it('4. Reload storms prevented (cooldown and in-progress guards)', async () => {
        reloadCountCalls = 0;
        orch.navigator._running = true;
        orch.navigator._reloadInProgress = false;
        orch.navigator._lastReloadTime = Date.now();

        // Attempt second reload immediately within 500ms
        const triggered = orch.navigator._autoReloadPage();
        assert.strictEqual(triggered, false, 'Rapid reload request must be throttled');
        assert.strictEqual(reloadCountCalls, 0, 'No reload should be called during throttle window');
    });

    await it('5. Session state and metrics restore cleanly after reload, and flags clear', async () => {
        // Pre-populate sessionStorage as if page just reloaded
        mockSessionStorage.setItem('bl_last_reload_flag', 'from_reload');
        mockSessionStorage.setItem('bl_reload_pending', 'true');
        mockSessionStorage.setItem('bl_session_stats', JSON.stringify({ acquired: 5, discovered: 14, loopsCompleted: 2 }));
        mockSessionStorage.setItem('bl_session_seen_ids', JSON.stringify(['seen_a', 'seen_b']));
        mockSessionStorage.setItem('bl_session_metrics', JSON.stringify({
            acquisitions: [{ leadId: 'lead_prev', durationMs: 400, timestamp: Date.now() }],
            contacts: [],
            attempts: 2,
            failedAttempts: 0,
            completedAttempts: 2,
            completedSuccesses: 2,
            lastDurationMs: 400
        }));
        mockSessionStorage.setItem('bl_scanner_auto_resume', 'true');

        // Instantiate new Orchestrator
        // Clear global flag to allow re-construction
        const OrchestratorClass = orch.constructor;
        const reloadedOrch = new OrchestratorClass();

        // Flags should be cleaned up immediately upon startup to prevent loops
        assert.strictEqual(mockSessionStorage.getItem('bl_reload_pending'), null, 'bl_reload_pending must be cleared');
        assert.strictEqual(mockSessionStorage.getItem('bl_last_reload_flag'), null, 'bl_last_reload_flag must be cleared');

        // State restored
        assert.strictEqual(reloadedOrch.stats.acquired, 5, 'Acquired count restored');
        assert.strictEqual(reloadedOrch.stats.discovered, 14, 'Discovered count restored');
        assert.strictEqual(reloadedOrch.stats.loopsCompleted, 2, 'Loops completed restored');
        assert.ok(reloadedOrch._uniqueSeenIds.has('seen_a'));
        assert.ok(reloadedOrch._uniqueSeenIds.has('seen_b'));

        // Metrics restored
        const speed = reloadedOrch.metrics.getSpeedPerAcquisition();
        const acc = reloadedOrch.metrics.getAcceptanceRate();
        assert.strictEqual(speed.formatted, '400ms', 'Speed metric must restore across reloads');
        assert.strictEqual(acc.formatted, '100.0%', 'Acceptance rate must restore across reloads');

        reloadedOrch.shutdown();
    });

    await it('6. Acquired leads are permanently remembered and not re-acquired across reloads', async () => {
        // Pre-store acquired leads in chrome.storage.local
        global.chrome.storage.local.set({
            acquiredLeadIds: ['acq_lead_999'],
            acquiredRecords: [{ id: 'acq_lead_999', seller: 'Seller ABC', acquiredAt: Date.now() }]
        });

        const OrchestratorClass = orch.constructor;
        const reloadedOrch = new OrchestratorClass();

        await new Promise(r => setTimeout(r, 20));

        assert.ok(reloadedOrch._acquiredLeadIds.has('acq_lead_999'), 'Acquired lead ID must be loaded');

        // Check deduplication check
        const isAcquired = reloadedOrch._isLeadAcquired({ leadId: 'acq_lead_999' }, { id: 'acq_lead_999' });
        assert.strictEqual(isAcquired, true, 'Already acquired lead must be identified as duplicate');

        reloadedOrch.shutdown();
    });

    await it('7. Stop navigator halts reload timer and prevents reloading', async () => {
        reloadCountCalls = 0;
        orch.navigator._running = true;
        orch.navigator._reloadInProgress = false;
        orch.navigator._lastReloadTime = 0;

        orch.navigator._autoReloadPage();
        assert.strictEqual(orch.navigator._reloadInProgress, true);

        // User or system calls stop
        orch.navigator.stop();
        assert.strictEqual(orch.navigator._reloadTimer, null, 'Reload timer must be cleared on stop');
        assert.strictEqual(orch.navigator._reloadInProgress, false, 'Reload in progress must be reset');

        // Wait past reload delay
        await new Promise(r => setTimeout(r, 130));
        assert.strictEqual(reloadCountCalls, 0, 'No reload must occur after navigator stopped');
    });

    console.log(`\n=== RESULTS: Passed ${passed} | Failed ${failed} ===\n`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

runTests().catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
});
