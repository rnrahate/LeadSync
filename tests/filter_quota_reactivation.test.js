const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('\n=== TEST SUITE: 10 Unique Sellers Quota, 60s Deactivation & Toast Prompts ===\n');

const bundlePath = path.join(__dirname, '../src/bundle.js');
const bundleCode = fs.readFileSync(bundlePath, 'utf8');

let deactivatedFilterIdInSupabase = null;
let reactivatedFilterIdInSupabase = null;
const mockStorage = {};
const capturedToasts = [];
const capturedLogs = [];

class MockElement {
    constructor(tagName = 'div') {
        this.tagName = tagName.toUpperCase();
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
    setAttribute(k, v) { this.attributes[k] = v; }
    getAttribute(k) { return this.attributes[k]; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    remove() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
}

class MockSupabaseService {
    constructor() {
        this._filters = [];
        this._filtersLoaded = true;
    }
    setLogger() {}
    loadFilters() { return Promise.resolve(true); }
    getFilters() { return this._filters; }
    getRecentLeads() { return Promise.resolve([]); }
    updateFilterStatus() { return Promise.resolve(true); }
    insertLead() { return Promise.resolve({ id: 'lead-123' }); }
    markLeadContacted() { return Promise.resolve(true); }
    async deactivateFilter(filterId) {
        deactivatedFilterIdInSupabase = filterId;
        return true;
    }
    async reactivateFilter(filterId) {
        reactivatedFilterIdInSupabase = filterId;
        return true;
    }
}

const mockDoc = new MockElement('document');
mockDoc.body = new MockElement('body');
mockDoc.head = new MockElement('head');
mockDoc.documentElement = new MockElement('html');
mockDoc.createElement = (tag) => new MockElement(tag);
mockDoc.getElementById = () => null;
mockDoc.querySelector = () => null;
mockDoc.querySelectorAll = () => [];

const sandbox = {
    console: console,
    performance: { now: () => Date.now() },
    Date: Date,
    Map: Map,
    Set: Set,
    Array: Array,
    Object: Object,
    String: String,
    Number: Number,
    RegExp: RegExp,
    parseInt: parseInt,
    parseFloat: parseFloat,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    Promise: Promise,
    document: mockDoc,
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    MutationObserver: class { constructor() {} observe() {} disconnect() {} },
    window: {
        location: { href: 'https://seller.indiamart.com/bltxn/' },
        addEventListener: () => {},
        removeEventListener: () => {},
        postMessage: () => {},
        SupabaseService: MockSupabaseService
    },
    chrome: {
        runtime: {
            getURL: (p) => 'chrome-extension://mock/' + p,
            getManifest: () => ({ version: '5.0.0' }),
            onMessage: { addListener: () => {} },
            sendMessage: (msg, cb) => { if (cb) cb({ success: true }); }
        },
        storage: {
            local: {
                _store: mockStorage,
                get: (keys, cb) => {
                    const res = {};
                    if (Array.isArray(keys)) {
                        keys.forEach(k => { res[k] = mockStorage[k]; });
                    }
                    if (cb) cb(res);
                },
                set: (data, cb) => {
                    Object.assign(mockStorage, data);
                    if (cb) cb();
                }
            }
        }
    }
};

vm.createContext(sandbox);
vm.runInContext(bundleCode, sandbox);

// 1. Get orchestrator and KeywordManager instance
const orchestrator = sandbox.window.orchestrator;
assert.ok(orchestrator, 'orchestrator must be attached to window');
const km = orchestrator.keywordManager;
assert.ok(km, 'keywordManager must exist on orchestrator');

// Intercept toasts
const origShowTopToast = orchestrator.showTopToast.bind(orchestrator);
orchestrator.showTopToast = function(type, title, message, durationMs) {
    capturedToasts.push({ type, title, message, durationMs });
    return origShowTopToast(type, title, message, durationMs);
};

// Intercept logs
const origLogInfo = km.logger.info.bind(km.logger);
km.logger.info = function(msg, meta) {
    capturedLogs.push({ msg, meta });
    return origLogInfo(msg, meta);
};

// Hook Supabase mocks
orchestrator.supabase.deactivateFilter = async (filterId) => {
    deactivatedFilterIdInSupabase = filterId;
    return true;
};
orchestrator.supabase.reactivateFilter = async (filterId) => {
    reactivatedFilterIdInSupabase = filterId;
    return true;
};

// 2. Setup a test filter with default quota (no targetQuantity specified -> should default to 10)
const initialFilters = [
    {
        id: 'filter_pharma_1',
        name: 'Pharma Tablets Filter',
        product_keywords: ['Paracetamol', 'Azithromycin'],
        is_active: true
    }
];

orchestrator.supabase._filters = initialFilters;
km.extractFromSupabaseFilters(initialFilters);

console.log('--- 1. Quota Initialization ---');
assert.strictEqual(km._activeFilters.length, 1);
assert.strictEqual(km._activeFilters[0].targetQuantity, 10, 'Target quantity must default to 10 unique sellers');
assert.strictEqual(km.getActiveFilterCount(), 1, 'Filter must be initially active and eligible');
assert.strictEqual(km.isFilterEligible('filter_pharma_1'), true, 'Filter must be eligible');
console.log('  ✅ PASS: Default quota initialized to 10 unique sellers');

console.log('\n--- 2. Acquiring 10 Unique Sellers (Sequential Acquisition) ---');
for (let i = 1; i <= 9; i++) {
    const lead = {
        leadId: 'lead_' + i,
        productName: 'Paracetamol 650mg Tablets',
        senderMobile: '987654321' + i,
        sellerName: 'Pharma Distributor ' + i
    };
    km.recordFilterSuccess('filter_pharma_1', lead);
    assert.strictEqual(km.isFilterEligible('filter_pharma_1'), true, 'Filter must remain eligible before reaching 10 (at ' + i + ')');
    assert.strictEqual(km.getActiveFilterCount(), 1, 'Filter count should still be 1');
}
console.log('  ✅ PASS: 9 unique sellers acquired without deactivation');

console.log('\n--- 3. 10th Unique Seller Acquisition (Quota Reached, 60s Deactivation & Toasts) ---');
const lead10 = {
    leadId: 'lead_10',
    productName: 'Paracetamol 650mg Tablets',
    senderMobile: '9876543210',
    sellerName: 'Pharma Distributor 10'
};
km.recordFilterSuccess('filter_pharma_1', lead10);

assert.strictEqual(km.isFilterEligible('filter_pharma_1'), false, 'Filter must NOT be eligible after 10 leads acquired');
assert.strictEqual(km.getActiveFilterCount(), 0, 'Active filter count must be 0 after deactivation');
assert.strictEqual(km._activeFilters[0].isActive, false, 'Rule isActive must be set to false');
assert.ok(km._deactivatedFilterIds.has('filter_pharma_1'), 'Filter ID must be recorded in deactivatedFilterIds');
assert.strictEqual(deactivatedFilterIdInSupabase, 'filter_pharma_1', 'Supabase deactivateFilter must be called');

// Verify limit reached and deactivated toasts were prompted
const limitToast = capturedToasts.find(t => t.title === 'Limit Reached' && t.message.includes('Pharma Tablets Filter'));
assert.ok(limitToast, 'Limit Reached toast prompt must be shown');
assert.strictEqual(limitToast.type, 'warning');

// Fast-forward 500ms to allow chained deactivated toast to fire
setTimeout(() => {
    const deactToast = capturedToasts.find(t => t.title === 'Filter Deactivated' && t.message.includes('60s'));
    assert.ok(deactToast, 'Filter Deactivated toast prompt must be shown');
    assert.strictEqual(deactToast.type, 'failed');

    // Verify structured logging for limit reached and filter deactivated
    const limitLog = capturedLogs.find(l => l.msg === 'filter.limit.reached');
    assert.ok(limitLog, 'filter.limit.reached must be logged');
    assert.strictEqual(limitLog.meta.filterId, 'filter_pharma_1');
    assert.strictEqual(limitLog.meta.count, 10);

    const deactLog = capturedLogs.find(l => l.msg === 'filter.deactivated');
    assert.ok(deactLog, 'filter.deactivated must be logged');
    assert.strictEqual(deactLog.meta.filterId, 'filter_pharma_1');
    assert.strictEqual(deactLog.meta.durationSeconds, 60);

    console.log('  ✅ PASS: Limit reached toast and filter deactivated toast prompted and logged');

    console.log('\n--- 4. 60-Second Auto-Reactivation & Reactivated Toast ---');
    // Verify 60s timer exists
    assert.ok(km._reactivationTimers.has('filter_pharma_1'), '60s auto-reactivation timer must be registered');

    // Trigger reactivation
    km.reactivateFilter('filter_pharma_1', '60s_timer_elapsed');

    assert.strictEqual(km._deactivatedFilterIds.has('filter_pharma_1'), false, 'Filter must be removed from deactivatedFilterIds');
    assert.strictEqual(km.isFilterEligible('filter_pharma_1'), true, 'Filter must be eligible again after 60s reactivation');
    assert.strictEqual(km.getActiveFilterCount(), 1, 'Active filter count must be 1 again');
    assert.strictEqual(km._filterCompletedBuyers.has('filter_pharma_1'), false, 'Completed buyers set must be reset for fresh quota');
    assert.strictEqual(reactivatedFilterIdInSupabase, 'filter_pharma_1', 'Supabase reactivateFilter must be called');

    // Verify filter reactivated toast prompt
    const reactToast = capturedToasts.find(t => t.title === 'Filter Reactivated' && t.message.includes('Pharma Tablets Filter'));
    assert.ok(reactToast, 'Filter Reactivated toast prompt must be shown');
    assert.strictEqual(reactToast.type, 'reactivated');

    // Verify filter reactivated structured log
    const reactLog = capturedLogs.find(l => l.msg === 'filter.reactivated');
    assert.ok(reactLog, 'filter.reactivated must be logged');
    assert.strictEqual(reactLog.meta.filterId, 'filter_pharma_1');

    // Verify incoming 11th lead now matches successfully
    const lead11 = {
        leadId: 'lead_11',
        productName: 'Paracetamol 650mg Tablets',
        senderMobile: '9876543299',
        sellerName: 'Pharma Distributor 11'
    };
    const evalMatchAfterReactivation = km.evaluateFilters(lead11);
    assert.ok(evalMatchAfterReactivation && evalMatchAfterReactivation.passed === true, 'Lead must match now that filter was reactivated');
    assert.strictEqual(evalMatchAfterReactivation.filterId, 'filter_pharma_1');

    console.log('  ✅ PASS: 60s auto-reactivation successfully triggered, toast prompted, logged, and leads acquired');

    console.log('\n=== ALL FILTER QUOTA, 60S DEACTIVATION & TOAST TESTS PASSED ===\n');
    process.exit(0);
}, 600);
