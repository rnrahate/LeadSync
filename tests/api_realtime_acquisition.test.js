const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('\n=== RUNNING PASSIVE NETWORK OBSERVATION & REVIEW WORKFLOW TESTS ===\n');

// Mock browser environment
const bundlePath = path.resolve(__dirname, '../src/bundle.js');

global.window = global;
global.window.addEventListener = () => {};
global.window.removeEventListener = () => {};
global.window.postMessage = () => {};
global.document = {
    readyState: 'complete',
    head: {
        appendChild: () => {},
        removeChild: () => {}
    },
    body: {
        appendChild: () => {},
        removeChild: () => {},
        style: {}
    },
    documentElement: {
        getAttribute: () => null,
        setAttribute: () => {},
        appendChild: () => {}
    },
    createElement: (tag) => {
        return {
            tagName: tag.toUpperCase(),
            id: '',
            className: '',
            style: {},
            classList: {
                add: () => {},
                remove: () => {},
                contains: () => false
            },
            appendChild: () => {},
            removeChild: () => {},
            setAttribute: () => {},
            getAttribute: () => null,
            hasAttribute: () => false,
            querySelectorAll: () => [],
            querySelector: () => ({ addEventListener: () => {} })
        };
    },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {}
};

global.sessionStorage = {
    _data: {},
    getItem: (k) => global.sessionStorage._data[k] || null,
    setItem: (k, v) => { global.sessionStorage._data[k] = String(v); },
    removeItem: (k) => { delete global.sessionStorage._data[k]; }
};

global.localStorage = {
    _data: {},
    getItem: (k) => global.localStorage._data[k] || null,
    setItem: (k, v) => { global.localStorage._data[k] = String(v); },
    removeItem: (k) => { delete global.localStorage._data[k]; }
};

global.chrome = {
    runtime: {
        onMessage: { addListener: () => {} },
        sendMessage: () => {},
        getManifest: () => ({ version: '5.0.0' })
    },
    storage: {
        local: {
            _store: {},
            get: (keys, cb) => {
                const res = {};
                if (typeof keys === 'string') res[keys] = global.chrome.storage.local._store[keys];
                else if (Array.isArray(keys)) keys.forEach(k => { res[k] = global.chrome.storage.local._store[k]; });
                if (cb) cb(res);
            },
            set: (obj, cb) => {
                Object.assign(global.chrome.storage.local._store, obj);
                if (cb) cb();
            },
            remove: (keys, cb) => {
                if (typeof keys === 'string') delete global.chrome.storage.local._store[keys];
                else if (Array.isArray(keys)) keys.forEach(k => delete global.chrome.storage.local._store[k]);
                if (cb) cb();
            }
        },
        onChanged: { addListener: () => {} }
    }
};

global.MutationObserver = class {
    constructor(cb) { this.cb = cb; }
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
};
global.window.MutationObserver = global.MutationObserver;
global.window.location = { href: 'https://seller.indiamart.com/bltxn/', reload: () => {} };

// Mock Supabase service
global.SupabaseService = function() {
    this._filtersLoaded = true;
    this._filters = [
        {
            id: 'filter_pramoxine_api',
            name: 'Pramoxine Foam Filter',
            product_keywords: ['Pramoxine Hydrochloride Foam'],
            negative_keywords: ['capsule'],
            target_lead_count: 5,
            is_active: true
        }
    ];
};
global.SupabaseService.prototype.setLogger = function() {};
global.SupabaseService.prototype.loadFilters = function() { return Promise.resolve(this._filters); };
global.SupabaseService.prototype.getFilters = function() { return this._filters; };
global.SupabaseService.prototype.getRecentLeads = function() { return Promise.resolve([]); };
global.SupabaseService.prototype.updateFilterStatus = function() { return Promise.resolve(true); };
global.SupabaseService.prototype.insertLead = function(l) { return Promise.resolve({ id: 'db_' + l.uniqueQueryId }); };
global.SupabaseService.prototype.markLeadContacted = function() { return Promise.resolve(true); };
global.SupabaseService.prototype.insertLeadHistory = function() { return Promise.resolve(true); };
global.SupabaseService.prototype.updateFilterStats = function() { return Promise.resolve(true); };

// Load bundle.js into environment
const bundleContent = fs.readFileSync(bundlePath, 'utf8');
eval(bundleContent);

const orch = global.window.orchestrator;
assert.ok(orch, 'window.orchestrator must be initialized');

async function runTests() {
    await new Promise(r => setTimeout(r, 250));

    const recordedToasts = [];
    orch.showTopToast = function(type, title, message, durationMs) {
        recordedToasts.push({ type, title, message, durationMs });
    };

    let reviewUIPresented = false;
    let presentedLead = null;
    orch._showReviewUI = function(lead) {
        reviewUIPresented = true;
        presentedLead = lead;
    };

    console.log('--- Test 1: Passive network lead matching routes to READY_FOR_REVIEW without auto-contact ---');
    const initialAcquired = orch.stats.acquired;

    const mockNetworkPseudoCards = [
        {
            id: 'api_uqid_test_9999',
            _rawApiLead: {
                uniqueQueryId: 'uqid_test_9999',
                queryId: 'uqid_test_9999',
                buyerId: 'buyer_7777',
                queryProductName: 'Pramoxine Hydrochloride 1% Foam',
                queryMessage: 'Need 500 bottles urgent delivery to Mumbai',
                city: 'Mumbai',
                state: 'Maharashtra',
                senderMobile: '+919876543210'
            }
        }
    ];

    orch._onNetworkLeads(mockNetworkPseudoCards);
    await new Promise(r => setTimeout(r, 50));

    // Must NOT have automatically acquired the lead
    assert.strictEqual(orch.stats.acquired, initialAcquired, 'stats.acquired must NOT be incremented automatically');
    assert.ok(reviewUIPresented, 'Review UI must be displayed for user review');
    assert.strictEqual(presentedLead.uniqueQueryId, 'uqid_test_9999', 'Presented lead matches network lead');
    assert.strictEqual(orch.stateMachine.getState('api_uqid_test_9999'), 'READY_FOR_REVIEW', 'Lead must be in READY_FOR_REVIEW state');

    const foundToast = recordedToasts.find(t => t.type === 'found' && t.message.indexOf('Pramoxine') !== -1);
    assert.ok(foundToast, 'Found toast must be shown for review-ready network lead');
    console.log('  ✅ PASS: Passive network lead routes to review workflow without automated contact');

    console.log('\n--- Test 2: Explicit user confirmation completes contact and records authoritative confirmation ---');
    let actionAdapterCalled = false;
    orch.actionAdapter.acquire = function(lead) {
        actionAdapterCalled = true;
        return Promise.resolve({ success: true, contactSuccess: true, action: 'confirmed' });
    };

    const outcome = await orch._confirmAndContactLead(presentedLead);
    assert.ok(actionAdapterCalled, 'actionAdapter must be called only upon explicit user confirmation');
    assert.strictEqual(outcome.status, 'SERVER_CONFIRMED', 'Authoritative outcome must be SERVER_CONFIRMED');
    assert.strictEqual(orch.stats.acquired, initialAcquired + 1, 'Acquired counter must increment after confirmation');
    assert.ok(orch._acquiredLeadIds.has('uqid_test_9999'), 'Lead ID must be registered in _acquiredLeadIds');
    console.log('  ✅ PASS: Explicit user confirmation completes contact and transitions to SERVER_CONFIRMED');

    console.log('\n--- Test 3: Deduplication prevents DOM cards from double-reviewing already acquired leads ---');
    const duplicateDetected = orch._isLeadAcquired({ leadId: 'api_uqid_test_9999', uniqueQueryId: 'uqid_test_9999' });
    assert.strictEqual(duplicateDetected, true, 'Lead 9999 must be recognized as acquired by deduplication');
    console.log('  ✅ PASS: Deduplication prevents duplicate actions on already processed leads');

    console.log('\n=== ALL PASSIVE NETWORK OBSERVATION & REVIEW WORKFLOW TESTS PASSED ===\n');
    process.exit(0);
}

runTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
