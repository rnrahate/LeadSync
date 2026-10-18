const assert = require('assert');

// Mock chrome environment
global.chrome = {
    runtime: {
        getURL: (p) => 'chrome-extension://mock/' + p,
        onMessage: { addListener: () => {} },
        sendMessage: () => Promise.resolve({ success: true })
    },
    storage: {
        local: {
            get: (keys, cb) => {
                if (typeof keys === 'function') { keys({}); return; }
                if (typeof cb === 'function') cb({});
            },
            set: (data, cb) => { if (cb) cb(); },
            clear: (cb) => { if (cb) cb(); }
        },
        onChanged: { addListener: () => {} }
    }
};

// Mock browser window and document
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
        this._innerHTML = '';
        this.textContent = '';
        this.parentNode = null;
        this._listeners = {};
    }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(html) {
        this._innerHTML = html;
        // Parse child IDs to support mock DOM querying
        const idRegex = /id=["']([^"']+)["']/g;
        let match;
        while ((match = idRegex.exec(html)) !== null) {
            const child = new MockElement('div');
            child.id = match[1];
            this.appendChild(child);
        }
    }
    setAttribute(k, v) { this.attributes[k] = v; }
    getAttribute(k) { return this.attributes[k]; }
    hasAttribute(k) { return k in this.attributes; }
    removeAttribute(k) { delete this.attributes[k]; }
    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }
    removeChild(child) {
        this.children = this.children.filter(c => c !== child);
        child.parentNode = null;
        return child;
    }
    remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
    }
    addEventListener(evt, fn) {
        if (!this._listeners[evt]) this._listeners[evt] = [];
        this._listeners[evt].push(fn);
    }
    dispatchEvent(evt) {
        const list = this._listeners[evt.type] || [];
        list.forEach(fn => fn(evt));
    }
    getBoundingClientRect() {
        return { top: 100, left: 100, width: 200, height: 200, bottom: 300, right: 300 };
    }
    querySelector(sel) {
        return this.querySelectorAll(sel)[0] || null;
    }
    querySelectorAll(sel) {
        const res = [];
        const check = (node) => {
            if (sel.startsWith('#') && node.id === sel.slice(1)) res.push(node);
            else if (sel.startsWith('.') && node.classList.contains(sel.slice(1))) res.push(node);
            node.children.forEach(check);
        };
        check(this);
        return res;
    }
}

global.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
    scrollTo: () => {},
    innerWidth: 1024,
    innerHeight: 768,
    scrollY: 0
};
global.document = new MockElement('document');
global.document.body = new MockElement('body');
global.document.head = new MockElement('head');
global.document.documentElement = new MockElement('html');
global.document.createElement = (tag) => new MockElement(tag);
global.document.getElementById = (id) => {
    let match = null;
    const find = (node) => {
        if (node.id === id) { match = node; return; }
        for (const child of node.children) {
            find(child);
            if (match) return;
        }
    };
    find(global.document.body);
    return match;
};
global.document.querySelector = (sel) => global.document.body.querySelector(sel);
global.document.querySelectorAll = (sel) => global.document.body.querySelectorAll(sel);
global.sessionStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {}
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
            { id: 'f1', name: 'SPF 50 Gel', product_keywords: ['Sunscreen 50g', 'SPF 50 Gel'], negative_keywords: ['lotion'], is_active: true }
        ];
        this._filtersLoaded = true;
    }
    setLogger() {}
    loadFilters() { return Promise.resolve(true); }
    getFilters() { return this._filters; }
    updateFilterStatus() {}
    insertLead() { return Promise.resolve({ id: 'lead-123' }); }
    markLeadContacted() { return Promise.resolve(true); }
}
global.SupabaseService = MockSupabaseService;
global.window.SupabaseService = MockSupabaseService;

console.log('\n=== RUNNING BUNDLE INTEGRATION TESTS ===\n');

// Load bundle.js into environment
try {
    require('../src/bundle.js');
    console.log('  ✅ PASS: src/bundle.js executes without syntax or runtime error');
} catch (e) {
    console.error('  ❌ FAIL: error executing src/bundle.js:', e);
    process.exit(1);
}

// Allow asynchronous _init() promise chain to resolve
setTimeout(() => {
    try {
        // 1. Verify window.orchestrator instance exists
        assert.ok(global.window.orchestrator, 'window.orchestrator must be initialized');
        const orch = global.window.orchestrator;
        console.log('  ✅ PASS: window.orchestrator successfully instantiated');

        // 2. Verify Metrics & Lifecycle instances
        assert.ok(orch.metrics, 'PerformanceMetrics must be attached to orchestrator');
        assert.ok(orch.lifecycle, 'LeadLifecycleManager must be attached to orchestrator');
        console.log('  ✅ PASS: PerformanceMetrics and LeadLifecycleManager attached');

        // 3. Verify Filters Button & Metric Elements created in DOM
        const filtersBtn = global.document.getElementById('bl-filters-btn');
        const filtersCount = global.document.getElementById('bl-filters-count');
        const speedEl = global.document.getElementById('bl-stat-speed');
        const acceptanceEl = global.document.getElementById('bl-stat-acceptance');

        assert.ok(filtersBtn, '#bl-filters-btn must be present in DOM');
        assert.ok(filtersCount, '#bl-filters-count badge must be present in DOM');
        assert.ok(speedEl, '#bl-stat-speed must be present in DOM');
        assert.ok(acceptanceEl, '#bl-stat-acceptance must be present in DOM');
        console.log('  ✅ PASS: Filters button and performance metric DOM elements created');

        // 4. Verify obsolete elements are completely ABSENT from DOM
        const obsoleteIds = [
            'bl-unmatched-count',
            'bl-unmatched-list',
            'bl-unmatched-drawer',
            'bl-scanall-btn',
            'bl-age-filter',
            'bl-age-refresh',
            'bl-stat-dup',
            'bl-stat-soldout',
            'bl-stat-fail',
            'bl-soldout-toggle'
        ];
        obsoleteIds.forEach(id => {
            assert.strictEqual(global.document.getElementById(id), null, `Obsolete element #${id} must NOT be in DOM`);
        });
        console.log('  ✅ PASS: All 10 obsolete UI elements absent from BL panel DOM');

        // 5. Verify Active Filter Count calculation
        const activeCount = orch.keywordManager.getActiveFilterCount();
        assert.strictEqual(activeCount, 1, 'Should report 1 active filter');
        console.log('  ✅ PASS: getActiveFilterCount() accurately computes active filters');

        // 6. Test Lifecycle state transitions on a lead
        const testLeadId = 'lead-test-001';
        orch.lifecycle.transition(testLeadId, 'DETECTED');
        assert.strictEqual(orch.lifecycle.getState(testLeadId), 'DETECTED');

        orch.lifecycle.transition(testLeadId, 'MATCHED');
        assert.strictEqual(orch.lifecycle.getState(testLeadId), 'MATCHED');

        orch.lifecycle.transition(testLeadId, 'ACQUISITION_PENDING');
        assert.strictEqual(orch.lifecycle.getState(testLeadId), 'ACQUISITION_PENDING');

        orch.lifecycle.transition(testLeadId, 'ACQUIRED');
        assert.strictEqual(orch.lifecycle.getState(testLeadId), 'ACQUIRED');

        orch.lifecycle.transition(testLeadId, 'CONTACT_PENDING');
        assert.strictEqual(orch.lifecycle.getState(testLeadId), 'CONTACT_PENDING');

        orch.lifecycle.transition(testLeadId, 'CONTACTED');
        assert.strictEqual(orch.lifecycle.getState(testLeadId), 'CONTACTED');
        console.log('  ✅ PASS: Lead lifecycle transitioned strictly through all verified states');

        // 7. Test Metrics reporting
        orch.metrics.recordDetection(testLeadId, 1000);
        orch.metrics.recordMatch(testLeadId, 1050);
        orch.metrics.recordAcquisitionAttempt(testLeadId);
        orch.metrics.recordAcquisitionSuccess(testLeadId, 2500);
        orch.metrics.recordContactSuccess(testLeadId, 2800);

        const speed = orch.metrics.getSpeedPerAcquisition();
        assert.strictEqual(speed.formatted, '1.5s', 'Speed should equal 2500 - 1000 = 1500ms -> 1.5s');

        const acc = orch.metrics.getAcceptanceRate();
        assert.strictEqual(acc.formatted, '100.0%', 'Acceptance rate should be 100%');
        console.log('  ✅ PASS: Centralized metrics update accurately from real timestamps');

        console.log('\n=== ALL BUNDLE INTEGRATION TESTS PASSED ===\n');
        process.exit(0);
    } catch (err) {
        console.error('Assertion error:', err);
        process.exit(1);
    }
}, 50);
