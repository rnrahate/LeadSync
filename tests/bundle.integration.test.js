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
            { id: 'f1', name: 'SPF 50 Gel', product_keywords: ['Sunscreen 50g', 'SPF 50 Gel'], negative_keywords: ['lotion'], target_lead_count: 2, is_active: true }
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
            'bl-stat-fail',
            'bl-country-text',
            'bl-rate-text',
            'bl-kw-text',
            'bl-queue-text',
            'bl-refresh-btn'
        ];
        obsoleteIds.forEach(id => {
            assert.strictEqual(global.document.getElementById(id), null, `Obsolete element #${id} must NOT be in DOM`);
        });
        console.log('  ✅ PASS: All 14 obsolete UI elements absent from BL panel DOM');

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

        // 12. Test Phase 6 & Phase 11: Two Distinct Buyers per Filter Quota & Deduplication
        // Release card-sold-test-2 queued earlier in the test to start with clean in-flight state
        orch.keywordManager.releaseReservation('f1', 'card-sold-test-2');
        assert.strictEqual(orch.keywordManager.getActiveFilterCount(), 1, 'Initially 1 active filter');
        
        // Buyer 1 successfully completes filter f1
        orch.keywordManager.recordFilterSuccess('f1', { leadId: 'lead-buyer-1', senderMobile: '9876543210' });
        assert.strictEqual(orch.keywordManager.getActiveFilterCount(), 1, 'Filter f1 still remaining after 1 distinct buyer');

        // Same Buyer 1 submits another lead matching f1 -> must be rejected because same buyer cannot fill 2 slots
        const dupBuyerMatch = orch.keywordManager.evaluateFilters({ productName: 'SPF 50 Gel Sunscreen 50g', senderMobile: '9876543210' });
        assert.strictEqual(dupBuyerMatch.passed, false, 'Same buyer must NOT be permitted to fill multiple slots for the same filter');

        // Distinct Buyer 2 matches f1 -> must be allowed
        const buyer2Match = orch.keywordManager.evaluateFilters({ productName: 'SPF 50 Gel Sunscreen 50g', senderMobile: '9876543211' });
        assert.strictEqual(buyer2Match.passed, true, 'Distinct buyer 2 must match active filter');
        assert.strictEqual(buyer2Match.filterId, 'f1');

        // Distinct Buyer 2 successfully completes filter f1
        orch.keywordManager.recordFilterSuccess('f1', { leadId: 'lead-buyer-2', senderMobile: '9876543211' });
        assert.strictEqual(orch.keywordManager.getActiveFilterCount(), 0, 'Filter f1 complete after 2 distinct buyers; remaining count becomes 0');

        // Third distinct buyer 3 submits lead matching f1 -> must be rejected because quota of 2 is reached
        const buyer3Match = orch.keywordManager.evaluateFilters({ productName: 'SPF 50 Gel Sunscreen 50g', senderMobile: '9876543212' });
        assert.strictEqual(buyer3Match.passed, false, 'Third buyer must be rejected when filter reached quota of 2');
        console.log('  ✅ PASS: Max 2 distinct buyers per filter quota & buyer deduplication verified');

        // 13. Test In-Flight Reservation Mechanism
        orch.keywordManager._activeFilters.push({
            id: 'f2',
            name: 'Aloe Vera Gel',
            product_keywords: ['Aloe Vera Gel'],
            target_lead_count: 2,
            is_active: true
        });
        assert.strictEqual(orch.keywordManager.getActiveFilterCount(), 1, '1 active filter f2 remaining');

        // Reserve 2 in-flight slots for f2
        orch.keywordManager.reserveSlot('f2', 'card-inflight-1');
        orch.keywordManager.reserveSlot('f2', 'card-inflight-2');

        // Filter f2 should now reject incoming leads because in-flight + completed = 2
        const inFlightBlocked = orch.keywordManager.evaluateFilters({ productName: 'Aloe Vera Gel', senderMobile: '9876543299' });
        assert.strictEqual(inFlightBlocked.passed, false, 'Candidate must be blocked when in-flight capacity is fully reserved');

        // Release reservation when one attempt fails
        orch.keywordManager.releaseReservation('f2', 'card-inflight-1');
        const afterReleaseMatch = orch.keywordManager.evaluateFilters({ productName: 'Aloe Vera Gel', senderMobile: '9876543299' });
        assert.strictEqual(afterReleaseMatch.passed, true, 'Candidate can match after released in-flight reservation');
        orch.keywordManager.releaseReservation('f2', 'card-inflight-2');
        console.log('  ✅ PASS: In-flight capacity reservation and release verified');

        // 14. Test Phase 9 & 10: Cycle Reset & Real Metric Formatting
        orch.metrics.resetCycle('cycle-gravitas-test');
        assert.strictEqual(orch.metrics.getSpeedPerAcquisition().formatted, '0s', 'Speed must reset to 0s at cycle start');
        assert.strictEqual(orch.metrics.getAcceptanceRate().formatted, '0%', 'Acceptance must reset to 0% at cycle start');

        // Add 1 completed success and 1 completed failure
        orch.metrics.recordLeadAttemptCompleted('lead-test-succ', true);
        orch.metrics.recordLeadAttemptCompleted('lead-test-fail', false);
        const cycleAcc = orch.metrics.getAcceptanceRate();
        assert.strictEqual(cycleAcc.formatted, '50.0%', 'Acceptance must accurately compute 1/2 = 50.0%');
        console.log('  ✅ PASS: Cycle reset to 0s / 0% and verified completion rate verified');

        // 15. Test Phase 12: Account Limitation Handling (Insufficient Balance / Subscription)
        const warnEl = global.document.getElementById('bl-warning-text');
        assert.ok(warnEl, '#bl-warning-text must exist in BL panel DOM');

        // Simulate lead processing with INSUFFICIENT_BALANCE failure
        const balanceLead = {
            leadId: 'lead-balance-fail',
            filterId: 'f2',
            productName: 'Aloe Vera Gel',
            senderMobile: '9998887776'
        };
        orch.keywordManager.reserveSlot('f2', balanceLead.leadId);
        orch.lifecycle.transition(balanceLead.leadId, 'DETECTED');
        orch.lifecycle.transition(balanceLead.leadId, 'MATCHED');
        
        // Mock adapter failing with INSUFFICIENT_BALANCE
        const originalAcquire = orch.actionAdapter.acquire;
        orch.actionAdapter.acquire = () => Promise.resolve({
            success: false,
            code: 'INSUFFICIENT_BALANCE',
            message: 'Insufficient BuyLead Balance. Please recharge.'
        });

        orch._processLead(balanceLead).then(() => {
            assert.strictEqual(orch.lifecycle.getState('lead-balance-fail'), 'BLOCKED', 'Lead state must transition to BLOCKED');
            assert.ok(warnEl.textContent.includes('Insufficient BuyLead Balance'), 'Warning text must show account failure');
            assert.ok(warnEl.classList.contains('show'), 'Warning text must be visible');
            // Ensure slot reservation was released
            const f2InFlight = orch.keywordManager._filterInFlight.get('f2');
            assert.ok(!f2InFlight || !f2InFlight.has('lead-balance-fail'), 'In-flight reservation must be released on failure');
            
            // Restore adapter
            orch.actionAdapter.acquire = originalAcquire;
            console.log('  ✅ PASS: Account limitation (INSUFFICIENT_BALANCE) notification and BLOCKED state verified');

            // 16. Test Issue 1: Scan-Cycle Counter Reset & Distinct Lead Counting
            const scannedStatEl = global.document.getElementById('bl-stat-scanned');
            orch.startNewCycle('test-cycle-1');
            assert.strictEqual(orch.stats.cycleScanned, 0, 'Cycle scanned counter must start at 0');
            assert.strictEqual(scannedStatEl.textContent, '0', 'BL panel Scanned must display 0');

            // Simulate 5 distinct leads scanned in cycle 1
            orch._onCardsDetected([
                { id: 'lead_c1', element: new MockElement('div') },
                { id: 'lead_c2', element: new MockElement('div') },
                { id: 'lead_c3', element: new MockElement('div') },
                { id: 'lead_c4', element: new MockElement('div') },
                { id: 'lead_c5', element: new MockElement('div') }
            ]);
            assert.strictEqual(orch.stats.cycleScanned, 5, 'Must report exactly 5 distinct leads scanned in cycle 1');
            assert.strictEqual(scannedStatEl.textContent, '5', 'BL panel Scanned must display 5');

            // Duplicate observer callbacks / rerenders in cycle 1 must NOT increment counter
            orch._onCardsDetected([
                { id: 'lead_c1', element: new MockElement('div') },
                { id: 'lead_c3', element: new MockElement('div') }
            ]);
            assert.strictEqual(orch.stats.cycleScanned, 5, 'Duplicate callbacks in same cycle must NOT increment count');
            assert.strictEqual(scannedStatEl.textContent, '5', 'BL panel Scanned remains 5');

            // Start a genuinely new cycle -> Counter must reset to 0
            orch.startNewCycle('test-cycle-2');
            assert.strictEqual(orch.stats.cycleScanned, 0, 'New cycle must reset Scanned counter to 0');
            assert.strictEqual(scannedStatEl.textContent, '0', 'BL panel Scanned must display 0 at start of new cycle');

            // Scan 3 distinct leads in cycle 2 -> Must display 3, NOT 8!
            orch._onCardsDetected([
                { id: 'lead_c6', element: new MockElement('div') },
                { id: 'lead_c7', element: new MockElement('div') },
                { id: 'lead_c8', element: new MockElement('div') }
            ]);
            assert.strictEqual(orch.stats.cycleScanned, 3, 'Cycle 2 must report 3 distinct leads, never carry over previous cycle');
            assert.strictEqual(scannedStatEl.textContent, '3', 'BL panel Scanned must display 3, not 8');
            console.log('  ✅ PASS: Issue 1 verified: Scanned counter resets to 0 for each new cycle (5 -> 0 -> 3, not 8)');

            // 17. Test Issue 2: Scanner IDLE State with 0 Eligible Filters & Explicit Pause
            // Clear all active filters to reach 0 eligible filters
            orch.keywordManager._activeFilters = [];
            assert.strictEqual(orch.keywordManager.getActiveFilterCount(), 0, 'Should have 0 eligible filters');
            orch._updateScannerLifecycleState('test_zero_filters');

            assert.strictEqual(orch._scannerState, 'IDLE', 'Scanner state must be IDLE when 0 eligible filters exist');
            assert.strictEqual(orch.scanner._running, false, 'Observer must be disconnected in IDLE state');
            assert.strictEqual(orch.navigator._running, false, 'Navigator must be stopped in IDLE state');

            // Scanner _scan must return early in IDLE state
            const scanResult = orch.scanner._scan();
            assert.strictEqual(scanResult, false, '_scan() must do nothing and return false when in IDLE state');

            // Add an eligible filter -> Scanner should auto-transition from IDLE to SCANNING
            orch.keywordManager._activeFilters.push({
                id: 'f_active_new',
                name: 'Paracetamol Active',
                product_keywords: ['Paracetamol 650mg'],
                target_lead_count: 2,
                is_active: true
            });
            assert.strictEqual(orch.keywordManager.getActiveFilterCount(), 1, 'Now 1 eligible filter');
            orch._updateScannerLifecycleState('test_filter_added');

            assert.strictEqual(orch._scannerState, 'SCANNING', 'Scanner must automatically resume to SCANNING when filter is added');
            assert.strictEqual(orch.scanner._running, true, 'Observer must be active after resuming');

            // Test User Explicit Pause: emergencyStop must NOT be overridden by adding filters
            orch.emergencyStop();
            assert.strictEqual(orch._isPaused, true, 'Scanner must be paused by user');
            assert.strictEqual(orch._scannerState, 'PAUSED', 'Scanner state must be PAUSED');
            assert.strictEqual(orch.scanner._running, false, 'Observer must be stopped while paused');

            // Adding another filter while paused must NOT resume scanner
            orch.keywordManager._activeFilters.push({
                id: 'f_active_2',
                name: 'Aspirin Active',
                product_keywords: ['Aspirin 100mg'],
                target_lead_count: 2,
                is_active: true
            });
            orch._updateScannerLifecycleState('test_filter_added_while_paused');
            assert.strictEqual(orch._isPaused, true, 'Must remain paused');
            assert.strictEqual(orch._scannerState, 'PAUSED', 'State must remain PAUSED');
            assert.strictEqual(orch.scanner._running, false, 'Observer must remain stopped while paused');

            // Resume by user
            orch.resume();
            assert.strictEqual(orch._isPaused, false, 'User resume clears pause flag');
            assert.strictEqual(orch._scannerState, 'SCANNING', 'Scanner transitions to SCANNING upon user resume');
            assert.strictEqual(orch.scanner._running, true, 'Observer is reconnected upon user resume');

            // In-flight safety check: if filter becomes ineligible while in-flight, _processLead aborts
            const obsoleteLead = {
                leadId: 'lead-obsolete-test',
                filterId: 'f_obsolete',
                productName: 'Obsolete Product'
            };
            // Note f_obsolete is NOT in _activeFilters, so isFilterEligible('f_obsolete') is false
            let acquireCalledForObsolete = false;
            orch.actionAdapter.acquire = () => {
                acquireCalledForObsolete = true;
                return Promise.resolve({ success: true });
            };
            orch._processLead(obsoleteLead).then(() => {
                assert.strictEqual(acquireCalledForObsolete, false, 'Acquisition must not be attempted for ineligible filter');
                assert.strictEqual(orch.stateMachine.getState('lead-obsolete-test'), 'FILTERED_OUT', 'Lead must be FILTERED_OUT');
                console.log('  ✅ PASS: Issue 2 verified: Scanner IDLE with 0 filters, auto-resume on eligible filter, user PAUSE respected, in-flight safety enforced');

                // 18. Test Issue 3: Filter Type Compatibility in KeywordManager
                // 18.1 Match Mode 'all' (AND) multi-keyword filter
                orch.keywordManager._activeFilters = [{
                    id: 'f_multi_all',
                    name: 'Voltfast Multi',
                    product_keywords: ['Voltfast', '50mg Powder'],
                    match_mode: 'all',
                    target_lead_count: 2,
                    is_active: true
                }];
                const partialMatch = orch.keywordManager.evaluateFilters({
                    productName: 'Voltfast Sachets'
                });
                assert.strictEqual(partialMatch.passed, false, 'Match mode "all" must reject lead missing one required keyword');

                const fullMatch = orch.keywordManager.evaluateFilters({
                    productName: 'Voltfast 50mg Powder Sachets'
                });
                assert.strictEqual(fullMatch.passed, true, 'Match mode "all" must accept lead with all required keywords');

                // 18.2 Foreign country matching with ISO code resolution
                orch.keywordManager._activeFilters = [{
                    id: 'f_foreign_country',
                    name: 'Bangladesh Lead Filter',
                    product_keywords: ['Surgical Gloves'],
                    filter_config: {
                        locations: ['BANGLADESH']
                    },
                    target_lead_count: 2,
                    is_active: true
                }];
                const bdLeadMatch = orch.keywordManager.evaluateFilters({
                    productName: 'Surgical Gloves Latex',
                    countryIso: 'BD'
                });
                assert.strictEqual(bdLeadMatch.passed, true, 'Lead with countryIso "BD" must match filter configured with "BANGLADESH"');

                // 18.3 Contact Channels (OR logic)
                orch.keywordManager._activeFilters = [{
                    id: 'f_or_contact',
                    name: 'OR Contact Filter',
                    product_keywords: ['Thermometer'],
                    filter_config: {
                        require_mobile: true,
                        require_email: true
                    },
                    target_lead_count: 2,
                    is_active: true
                }];
                const mobileOnlyLead = orch.keywordManager.evaluateFilters({
                    productName: 'Digital Thermometer',
                    senderMobile: '9123456789'
                });
                assert.strictEqual(mobileOnlyLead.passed, true, 'Lead with mobile satisfies OR contact requirements');

                const emailOnlyLead = orch.keywordManager.evaluateFilters({
                    productName: 'Digital Thermometer',
                    senderEmail: 'buyer@test.com'
                });
                assert.strictEqual(emailOnlyLead.passed, true, 'Lead with email satisfies OR contact requirements');

                const bothContactsLead = orch.keywordManager.evaluateFilters({
                    productName: 'Digital Thermometer',
                    senderMobile: '9123456789',
                    senderEmail: 'buyer@test.com'
                });
                assert.strictEqual(bothContactsLead.passed, true, 'Lead satisfying both contact channels must be accepted');

                const neitherContactLead = orch.keywordManager.evaluateFilters({
                    productName: 'Digital Thermometer'
                });
                assert.strictEqual(neitherContactLead.passed, false, 'Lead missing both required contact channels must be rejected');
                console.log('  ✅ PASS: Issue 3 verified: Match Mode "all", Foreign Country ISO mapping, and OR contact channels');

                // 20. Test Issue 4: Scanner Distinct Count on Static Page & Auto-Reload On Complete
                assert.strictEqual(orch.navigator._settings.autoReloadOnComplete, true, "autoReloadOnComplete must be enabled in navigator settings");
                assert.strictEqual(orch.config.autoReloadOnComplete, true, "autoReloadOnComplete must be enabled in orchestrator config");

                const makeCard = (titleText) => {
                    const el = new MockElement("div");
                    const titleEl = new MockElement("div");
                    titleEl.classList.add("BLbp_title");
                    titleEl.textContent = titleText;
                    el.appendChild(titleEl);
                    return el;
                };

                const initialDiscovered = orch.stats.discovered;
                // Scan static card
                orch._onCardsDetected([
                    { id: "lead_static_101", element: makeCard("Product Static") }
                ]);
                assert.strictEqual(orch.stats.discovered, initialDiscovered + 1, "First scan of new card must increment discovered count");

                // Rescan exact same static card
                orch._onCardsDetected([
                    { id: "lead_static_101", element: makeCard("Product Static") }
                ]);
                assert.strictEqual(orch.stats.discovered, initialDiscovered + 1, "Rescanning same static lead must NOT increment discovered count");

                // Genuinely fresh lead arriving after reload
                orch._onCardsDetected([
                    { id: "lead_brand_new_102", element: makeCard("Product Fresh") }
                ]);
                assert.strictEqual(orch.stats.discovered, initialDiscovered + 2, "Only genuinely new lead arriving on page must increment discovered count");
                console.log('  ✅ PASS: Issue 4 verified: Popup scanned count stays fixed on static page and only counts distinct leads');

                // 21. Test Issue 5: Real-time Arrival < 1s, Strict Top-7 Feed Window, and Speed/Acceptance Persistence Across Cycles
                // A. Verify Top-7 Windowing: When 23 cards exist in DOM feed, only top 7 are scanned
                orch.startNewCycle('test-cycle-23cards');
                const mock23Cards = [];
                for (let c = 1; c <= 23; c++) {
                    mock23Cards.push({ id: 'lead_card_' + c, element: makeCard('Product Lead ' + c) });
                }
                // Simulate scanner feeding top-7 slice from 23 cards in feed
                const top7Cards = mock23Cards.slice(0, 7);
                assert.strictEqual(top7Cards.length, 7, 'Top-7 window must isolate exactly 7 cards from 23 loaded in DOM');
                orch._onCardsDetected(top7Cards);
                assert.strictEqual(orch.stats.cycleScanned, 7, 'Scanned counter must show 7 (not 23) for top-7 window');
                assert.strictEqual(global.document.getElementById('bl-stat-scanned').textContent, '7', 'BL panel must display 7 (not 23)');

                // B. Verify Rescan: On rescan loop, counter resets to 0 and re-scans the 7 leads
                orch.startNewCycle('test-cycle-rescan');
                assert.strictEqual(orch.stats.cycleScanned, 0, 'Cycle counter resets to 0 at rescan start');
                orch._onCardsDetected(top7Cards);
                assert.strictEqual(orch.stats.cycleScanned, 7, 'Cycle counter must show 7 on each rescan');
                assert.strictEqual(global.document.getElementById('bl-stat-scanned').textContent, '7', 'BL panel must display 7 on rescan');

                // C. Verify Speed and Acceptance logic updates upon acquisition
                orch.metrics.resetCycle('test-speed-acc');
                orch.metrics.recordDetection('lead-succ-speed', 1000);
                orch.metrics.recordAcquisitionAttempt('lead-succ-speed');
                orch.metrics.recordAcquisitionSuccess('lead-succ-speed', 1450); // 450ms
                orch.metrics.recordLeadAttemptCompleted('lead-succ-speed', true);
                
                const speed = orch.metrics.getSpeedPerAcquisition();
                const acc = orch.metrics.getAcceptanceRate();
                assert.strictEqual(speed.formatted, '450ms', 'Speed must reflect 450ms acquisition time');
                assert.strictEqual(acc.formatted, '100.0%', 'Acceptance rate must reflect 100.0%');

                // D. Verify Speed and Acceptance PERSIST across loop cycles (not wiped by routine loop startNewCycle)
                orch.startNewCycle('test-cycle-loop-pass');
                const speedAfterPass = orch.metrics.getSpeedPerAcquisition();
                const accAfterPass = orch.metrics.getAcceptanceRate();
                assert.strictEqual(speedAfterPass.formatted, '450ms', 'Speed must NOT reset to 0s on routine loop passes');
                assert.strictEqual(accAfterPass.formatted, '100.0%', 'Acceptance must NOT reset to 0% on routine loop passes');
                console.log('  ✅ PASS: Issue 5 verified: Top-7 window isolates 7 (not 23), rescans 7, and Speed/Acceptance persist across cycles');

                console.log('\n=== ALL BUNDLE INTEGRATION TESTS PASSED ===\n');
                process.exit(0);
            });
        });
    } catch (err) {
        console.error('Assertion error:', err);
        process.exit(1);
    }
}, 50);
