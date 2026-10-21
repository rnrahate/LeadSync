const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('\n=== RUNNING API REAL-TIME LEAD MATCH & INSTANT ACQUISITION TESTS ===\n');

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
            querySelector: () => null
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
        getManifest: () => ({ version: '6.4.2' })
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
    // Wait for orchestrator async initialization and filter sync to complete
    await new Promise(r => setTimeout(r, 250));

    // Collect toasts
    const recordedToasts = [];
    orch.showTopToast = function(type, title, message, durationMs) {
        recordedToasts.push({ type, title, message, durationMs });
    };

    // Test 1: Direct API acquire (Option 1) when API template is present
    console.log('--- Test 1: Direct API acquire on API-matched lead before DOM render ---');
    orch.acqApiCaller.storeTemplate({
        url: 'https://seller.indiamart.com/bltxn/contactbuyer',
        method: 'POST',
        body: 'queryId=ORIGINAL_QUERY_ID&buyerId=ORIGINAL_BUYER_ID',
        contentType: 'application/x-www-form-urlencoded'
    });

    // Mock global fetch for Direct API call
    let fetchCalled = false;
    let fetchedUrl = '';
    let fetchedBody = '';
    global.fetch = function(url, opts) {
        fetchCalled = true;
        fetchedUrl = url;
        fetchedBody = opts.body;
        return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(JSON.stringify({ CODE: '200', MESSAGE: 'SUCCESS' }))
        });
    };

    const initialAcquired = orch.stats.acquired;
    const initialFilterActive = orch.keywordManager.getActiveFilterCount();

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

    // Wait for the async Direct API promise to resolve
    await new Promise(r => setTimeout(r, 100));

    assert.ok(fetchCalled, 'fetch must be called directly via AcqApiCaller before DOM render');
    assert.ok(fetchedBody.indexOf('uqid_test_9999') !== -1, 'Direct API body must contain the lead uniqueQueryId');
    assert.strictEqual(orch.stats.acquired, initialAcquired + 1, 'stats.acquired must be incremented by 1');
    assert.ok(orch._acquiredLeadIds.has('uqid_test_9999'), 'Lead ID must be registered in _acquiredLeadIds');

    // Verify toasts
    const foundToast = recordedToasts.find(t => t.type === 'found' && t.message.indexOf('Pramoxine') !== -1);
    const acquiringToast = recordedToasts.find(t => t.type === 'acquiring' && t.message.indexOf('Pramoxine') !== -1);
    const contactedToast = recordedToasts.find(t => t.type === 'contacted' && t.message.indexOf('Pramoxine') !== -1);

    assert.ok(foundToast, 'Found toast must be shown for network lead');
    assert.ok(acquiringToast, 'Acquiring toast must be shown immediately');
    assert.ok(contactedToast, 'Contacted toast must be shown once successfully acquired');
    console.log('  ✅ PASS: Direct API acquire succeeded before DOM render with acquiring & contacted toasts');

    // Test 2: Fast DOM targeted acquire (Option 2) when template is missing
    console.log('\n--- Test 2: Fast DOM acquire with 0ms immediate check when no template ---');
    orch.acqApiCaller.clearTemplate();
    orch._isPaused = false;
    recordedToasts.length = 0;

    let actionAdapterCalled = false;
    orch.actionAdapter.acquire = function(lead) {
        actionAdapterCalled = true;
        return Promise.resolve({ success: true, contactSuccess: true, action: 'confirmed' });
    };

    // Mock DOM card presence for uqid_test_8888
    const origQuerySelector = global.document.querySelector;
    global.document.querySelector = (sel) => {
        if (sel && sel.indexOf('uqid_test_8888') !== -1) {
            return {
                id: 'id_BLCard_uqid_test_8888',
                getAttribute: (attr) => attr === 'data-query-id' ? 'uqid_test_8888' : null,
                querySelector: () => null,
                querySelectorAll: () => []
            };
        }
        return origQuerySelector ? origQuerySelector(sel) : null;
    };

    const mockLead2 = [
        {
            id: 'api_uqid_test_8888',
            _rawApiLead: {
                uniqueQueryId: 'uqid_test_8888',
                queryId: 'uqid_test_8888',
                buyerId: 'buyer_6666',
                queryProductName: 'Pramoxine Hydrochloride 1% Foam',
                queryMessage: 'Requirement for foam',
                city: 'Delhi',
                state: 'Delhi',
                senderMobile: '+919988776655'
            }
        }
    ];

    orch._onNetworkLeads(mockLead2);
    await new Promise(r => setTimeout(r, 50));

    const acqToast2 = recordedToasts.find(t => t.type === 'acquiring' && t.message.indexOf('Pramoxine') !== -1);
    const contToast2 = recordedToasts.find(t => t.type === 'contacted' && t.message.indexOf('Pramoxine') !== -1);

    assert.ok(acqToast2, 'Acquiring toast must be shown for Fast DOM path');
    assert.ok(contToast2, 'Contacted toast must be shown upon completion of Fast DOM path');
    assert.ok(orch._acquiredLeadIds.has('uqid_test_8888'), 'Lead 8888 must be marked acquired');
    console.log('  ✅ PASS: Fast DOM acquire executes instant toasts and records acquisition');

    // Test 3: Deduplication prevents DOM cards from double-acquiring already acquired network leads
    console.log('\n--- Test 3: Pre-approved lead card ignores duplicate scan after acquire ---');
    const duplicateDetected = orch._isLeadAcquired({ leadId: 'api_uqid_test_9999', uniqueQueryId: 'uqid_test_9999' });
    assert.strictEqual(duplicateDetected, true, 'Lead 9999 must be recognized as acquired by deduplication');
    console.log('  ✅ PASS: Acquired network lead is excluded from double acquisition when card mounts');

    console.log('\n=== ALL API REAL-TIME ACQUISITION TESTS PASSED ===\n');
    process.exit(0);
}

runTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
