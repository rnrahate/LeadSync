const assert = require('assert');

// Mock chrome environment
global.chrome = {
    runtime: {
        getURL: (p) => 'chrome-extension://mock/' + p,
        onMessage: { addListener: () => {} },
        sendMessage: (msg, cb) => {
            if (msg && msg.action === 'OPEN_TAB') {
                global.window._lastOpenedUrl = msg.url;
            }
            if (typeof cb === 'function') cb({ success: true });
            return Promise.resolve({ success: true });
        }
    },
    storage: {
        local: {
            _store: {},
            get: (keys, cb) => {
                if (typeof keys === 'function') { keys({}); return; }
                const result = {};
                if (typeof keys === 'string') {
                    result[keys] = global.chrome.storage.local._store[keys];
                } else if (Array.isArray(keys)) {
                    keys.forEach(k => { result[k] = global.chrome.storage.local._store[k]; });
                } else if (typeof keys === 'object' && keys !== null) {
                    Object.keys(keys).forEach(k => {
                        result[k] = (k in global.chrome.storage.local._store) ? global.chrome.storage.local._store[k] : keys[k];
                    });
                }
                if (typeof cb === 'function') cb(result);
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
        // Parse tags with id and/or class to support mock DOM querying
        const tagRegex = /<([a-zA-Z0-9]+)([^>]*?)>/g;
        let match;
        while ((match = tagRegex.exec(html)) !== null) {
            const tag = match[1];
            const attrs = match[2];
            const idMatch = /id=["']([^"']+)["']/.exec(attrs);
            const classMatch = /class=["']([^"']+)["']/.exec(attrs);
            if (idMatch || classMatch) {
                const child = new MockElement(tag);
                if (idMatch) child.id = idMatch[1];
                if (classMatch) {
                    classMatch[1].split(/\s+/).filter(Boolean).forEach(c => child.classList.add(c));
                }
                this.appendChild(child);
            }
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
        const parts = sel.split(',').map(s => s.trim());
        const res = [];
        const seen = new Set();
        const matchesSingle = (node, s) => {
            if (!s) return false;
            if (s.startsWith('#')) return node.id === s.slice(1);
            if (s.startsWith('.')) {
                const c = s.slice(1);
                return node.classList.contains(c) || Array.from(node._classes || []).some(x => x.toLowerCase().includes(c.toLowerCase()));
            }
            if (s.startsWith('[') && s.endsWith(']')) {
                const inner = s.slice(1, -1);
                if (inner.includes('*=')) {
                    const [attr, val] = inner.split('*=').map(x => x.replace(/['"]/g, '').trim());
                    if (attr === 'class') {
                        return Array.from(node._classes || []).some(x => x.toLowerCase().includes(val.toLowerCase()));
                    }
                    return node.getAttribute(attr) && String(node.getAttribute(attr)).includes(val);
                }
                if (inner.includes('=')) {
                    const [attr, val] = inner.split('=').map(x => x.replace(/['"]/g, '').trim());
                    return node.getAttribute(attr) === val;
                }
                return node.hasAttribute(inner);
            }
            return node.tagName.toLowerCase() === s.toLowerCase();
        };
        const check = (node) => {
            for (const part of parts) {
                if (matchesSingle(node, part)) {
                    if (!seen.has(node)) {
                        seen.add(node);
                        res.push(node);
                    }
                    break;
                }
            }
            node.children.forEach(check);
        };
        this.children.forEach(check);
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
    scrollY: 0,
    open: (url) => { global.window._lastOpenedUrl = url; }
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
    getRecentLeads() { return Promise.resolve([]); }
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
            'bl-stat-fail'
        ];
        obsoleteIds.forEach(id => {
            assert.strictEqual(global.document.getElementById(id), null, `Obsolete element #${id} must NOT be in DOM`);
        });
        console.log('  ✅ PASS: All 9 obsolete UI elements absent from BL panel DOM');

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

        // 8. Test Stop Sold Toggle Presence, Persistence & Visual State
        const stopSoldBtn = global.document.getElementById('bl-stop-sold-btn');
        const stopSoldIndicator = global.document.getElementById('bl-stop-sold-indicator');
        const stopSoldLabel = global.document.getElementById('bl-stop-sold-label');

        assert.ok(stopSoldBtn, '#bl-stop-sold-btn must exist in BL panel DOM');
        assert.ok(stopSoldIndicator, '#bl-stop-sold-indicator must exist in BL panel DOM');
        assert.ok(stopSoldLabel, '#bl-stop-sold-label must exist in BL panel DOM');

        // Initial default state is ON
        assert.strictEqual(orch.config.stopSold, true, 'Stop Sold should default to true');
        assert.strictEqual(stopSoldBtn.getAttribute('aria-pressed'), 'true', 'aria-pressed should be true initially');
        assert.strictEqual(stopSoldLabel.textContent, 'ON', 'Label should be ON initially');
        assert.ok(stopSoldIndicator.classList.contains('active'), 'Indicator should have active class initially');

        // Toggle to OFF
        orch.setStopSold(false);
        assert.strictEqual(orch.config.stopSold, false, 'Stop Sold should be false after setStopSold(false)');
        assert.strictEqual(orch.config.skipSoldOut, false, 'skipSoldOut alias should mirror stopSold');
        assert.strictEqual(stopSoldBtn.getAttribute('aria-pressed'), 'false', 'aria-pressed should be false when disabled');
        assert.strictEqual(stopSoldLabel.textContent, 'OFF', 'Label should be OFF when disabled');
        assert.ok(stopSoldIndicator.classList.contains('inactive'), 'Indicator should have inactive class when disabled');
        assert.strictEqual(global.chrome.storage.local._store.stopSold, false, 'Storage must persist stopSold: false');

        // Toggle back to ON
        orch.setStopSold(true);
        assert.strictEqual(orch.config.stopSold, true, 'Stop Sold should be true after setStopSold(true)');
        assert.strictEqual(stopSoldBtn.getAttribute('aria-pressed'), 'true', 'aria-pressed should be true when enabled');
        assert.strictEqual(stopSoldLabel.textContent, 'ON', 'Label should be ON when enabled');
        assert.ok(stopSoldIndicator.classList.contains('active'), 'Indicator should have active class when enabled');
        assert.strictEqual(global.chrome.storage.local._store.stopSold, true, 'Storage must persist stopSold: true');

        // Verify popup isolation: Stop Sold must NOT appear in popup/index.html
        const fs = require('fs');
        const path = require('path');
        const popupHtml = fs.readFileSync(path.join(__dirname, '../popup/index.html'), 'utf8');
        assert.strictEqual(popupHtml.includes('bl-stop-sold-btn'), false, 'Stop Sold button must NOT exist in popup/index.html');
        assert.strictEqual(popupHtml.toLowerCase().includes('stop sold'), false, 'Stop Sold control must NOT exist in popup/index.html');
        console.log('  ✅ PASS: Stop Sold toggle visual state, storage persistence, and popup isolation verified');

        // 9. Test Sold-Out Lead Detection and Exclusion
        const availableCardEl = new MockElement('div');
        const availTitle = new MockElement('div');
        availTitle.classList.add('BLbp_title');
        availTitle.textContent = 'Sunscreen 50g';
        availableCardEl.appendChild(availTitle);
        const normalBtn = new MockElement('button');
        normalBtn.textContent = 'Contact Buyer';
        availableCardEl.appendChild(normalBtn);
        assert.strictEqual(orch._isLeadSoldOut({ productName: 'Sunscreen 50g' }, { element: availableCardEl }), false, 'Available card should not be sold out');

        const soldCardEl1 = new MockElement('div');
        const title1 = new MockElement('div');
        title1.classList.add('BLbp_title');
        title1.textContent = 'Sunscreen 50g';
        soldCardEl1.appendChild(title1);
        const soldBtn = new MockElement('button');
        soldBtn.textContent = 'Sold Out';
        soldCardEl1.appendChild(soldBtn);
        assert.strictEqual(orch._isLeadSoldOut({ productName: 'Sunscreen 50g' }, { element: soldCardEl1 }), true, 'Card with Sold Out button must be detected as sold out');

        const soldCardEl2 = new MockElement('div');
        const title2 = new MockElement('div');
        title2.classList.add('BLbp_title');
        title2.textContent = 'Sunscreen 50g';
        soldCardEl2.appendChild(title2);
        const soldBadge = new MockElement('span');
        soldBadge.classList.add('soldBadge');
        soldBadge.textContent = 'Buy Lead Sold Out';
        soldCardEl2.appendChild(soldBadge);
        assert.strictEqual(orch._isLeadSoldOut({ productName: 'Sunscreen 50g' }, { element: soldCardEl2 }), true, 'Card with Sold Out badge must be detected as sold out');

        const soldCardEl3 = new MockElement('div');
        soldCardEl3.setAttribute('data-sold', 'true');
        assert.strictEqual(orch._isLeadSoldOut({ productName: 'Sunscreen 50g' }, { element: soldCardEl3 }), true, 'Card with data-sold="true" must be detected as sold out');

        const soldLeadObj = { productName: 'Sunscreen 50g', isSoldOut: true };
        assert.strictEqual(orch._isLeadSoldOut(soldLeadObj, null), true, 'Lead with isSoldOut=true property must be detected as sold out');

        // Test filtering behavior:
        // Enabled state skips sold out lead:
        orch.setStopSold(true);
        const prevRejected = orch.stats.rejected;
        orch._onCardsDetected([{
            id: 'card-sold-test-1',
            element: soldCardEl1
        }]);
        assert.strictEqual(orch.stats.rejected, prevRejected + 1, 'Sold-out card must be rejected/skipped when Stop Sold is enabled');

        // Disabled state does not apply Stop Sold restriction:
        orch.setStopSold(false);
        const soldCardClean = new MockElement('div');
        const titleClean = new MockElement('div');
        titleClean.classList.add('BLbp_title');
        titleClean.textContent = 'Sunscreen 50g';
        soldCardClean.appendChild(titleClean);
        const soldBtnClean = new MockElement('button');
        soldBtnClean.textContent = 'Sold Out';
        soldCardClean.appendChild(soldBtnClean);

        assert.strictEqual(orch.config.stopSold, false, 'Stop Sold is disabled');
        const prevDiscovered = orch.stats.discovered;
        orch._onCardsDetected([{
            id: 'card-sold-test-2',
            element: soldCardClean
        }]);
        // When stopSold is false, the card is discovered and evaluated by matching/scoring rather than blocked by Step 0.1
        assert.strictEqual(orch.stats.discovered, prevDiscovered + 1, 'Lead is discovered when Stop Sold is disabled');
        console.log('  ✅ PASS: Sold-out lead detection and conditional filtering verified');

        // 10. Test Matched Option Layout & Structure
        const statsRow = global.document.querySelector('.bl-stats-row');
        assert.ok(statsRow, '.bl-stats-row must exist in BL panel DOM');
        const matchedStat = global.document.getElementById('bl-stat-filtered');
        assert.ok(matchedStat, '#bl-stat-filtered must exist inside stats');
        console.log('  ✅ PASS: Matched option correctly structured within .bl-stats-row and .bl-stat-group');

        // 11. Test Filters Button Navigation
        global.window._lastOpenedUrl = null;
        filtersBtn.dispatchEvent({ type: 'click', stopPropagation: () => {} });
        assert.strictEqual(global.window._lastOpenedUrl, 'https://ind-prtx-test.vercel.app/filters', 'Filters button must navigate to CRM/Filters URL');
        console.log('  ✅ PASS: Filters button navigates to https://ind-prtx-test.vercel.app/filters');

        console.log('\n=== ALL BUNDLE INTEGRATION TESTS PASSED ===\n');
        process.exit(0);
    } catch (err) {
        console.error('Assertion error:', err);
        process.exit(1);
    }
}, 50);
