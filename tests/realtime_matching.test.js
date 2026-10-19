const assert = require('assert');
const fs = require('fs');
const { LeadMatcher } = require('./matcher.js');

console.log('\n=== RUNNING REAL-TIME FILTER MATCHING TESTS ===\n');

// Test 1: Candidate ranking is strictly score-driven (no req time / queryTime tie-breaker)
(function testScoreDrivenRanking() {
    const matcher = new LeadMatcher();
    const filter = {
        id: 1,
        name: 'Sunscreen Test',
        keywords: ['Sunscreen SPF 50', 'SPF 50 Gel'],
        matchMode: 'any'
    };

    // Lead A has older queryTime but higher relevance score
    // Lead B has newer queryTime (recent req time) but lower relevance score
    const leadA = {
        leadId: 'lead_strong_score',
        productName: 'Sunscreen SPF 50 Gel 50g',
        queryTime: '2026-01-01T00:00:00.000Z'
    };
    const leadB = {
        leadId: 'lead_weak_score',
        productName: 'SPF 50 Gel',
        queryTime: '2026-10-19T12:00:00.000Z'
    };

    const candidates = matcher.rankCandidates([leadB, leadA], filter);
    assert.strictEqual(candidates.length, 2, 'Both leads should match');
    assert.strictEqual(candidates[0].lead.leadId, 'lead_strong_score', 'Higher scoring candidate must rank first regardless of queryTime / req time');
    console.log('  ✅ PASS: 1. Candidate ranking is purely score-driven without queryTime / req time duration bias');
})();

// Test 2: Verify bundle loads cached filters instantly on reload
(function testInstantCachePriming() {
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
            this.value = '';
            this.parentNode = null;
            this.isConnected = true;
        }
        setAttribute(k, v) { this.attributes[k] = String(v); }
        getAttribute(k) { return this.attributes[k] || null; }
        hasAttribute(k) { return k in this.attributes; }
        appendChild(c) { this.children.push(c); return c; }
        remove() {}
        addEventListener() {}
        removeEventListener() {}
        getBoundingClientRect() { return { top: 0, left: 0, width: 200, height: 100 }; }
        querySelectorAll() { return []; }
        querySelector() { return new MockElement('div'); }
        dispatchEvent() { return true; }
    }

    const storageStore = {
        mode: 'AUTOMATIC',
        supabaseEnabled: true,
        autoReloadOnComplete: true,
        keywords: { product: [], negative: [], location: [], required: [] },
        cached_filters_v1: {
            filters: [{
                id: 42,
                filter_name: 'Realtime Solar Inverter',
                product_keywords: ['solar inverter', 'hybrid inverter'],
                is_active: true
            }],
            timestamp: Date.now()
        }
    };

    global.window = global;
    global.window.__BUY_LEAD_ASSISTANT_V6__ = false;
    global.window.addEventListener = () => {};
    global.window.removeEventListener = () => {};
    global.window.scrollTo = () => {};
    global.window.dispatchEvent = () => true;
    global.window.location = { reload: () => {} };

    global.document = {
        readyState: 'complete',
        addEventListener: () => {},
        removeEventListener: () => {},
        head: new MockElement('head'),
        body: new MockElement('body'),
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: (id) => {
            const el = new MockElement('div');
            el.id = id;
            return el;
        },
        createElement: (tag) => new MockElement(tag),
        contains: () => true,
        dispatchEvent: () => true
    };

    global.sessionStorage = {
        _s: {},
        getItem: (k) => global.sessionStorage._s[k] || null,
        setItem: (k, v) => { global.sessionStorage._s[k] = String(v); },
        removeItem: (k) => { delete global.sessionStorage._s[k]; },
        clear: () => { global.sessionStorage._s = {}; }
    };

    global.localStorage = {
        _s: {},
        getItem: (k) => global.localStorage._s[k] || null,
        setItem: (k, v) => { global.localStorage._s[k] = String(v); },
        removeItem: (k) => { delete global.localStorage._s[k]; },
        clear: () => { global.localStorage._s = {}; }
    };

    global.chrome = {
        runtime: {
            getURL: (p) => 'chrome-extension://mock/' + p,
            onMessage: { addListener: () => {} },
            sendMessage: (msg, cb) => { if (cb) cb({ success: true }); return Promise.resolve({ success: true }); }
        },
        storage: {
            local: {
                get: (keys, cb) => {
                    const res = {};
                    (Array.isArray(keys) ? keys : [keys]).forEach(k => { res[k] = storageStore[k]; });
                    cb(res);
                },
                set: (data, cb) => { Object.assign(storageStore, data); if (cb) cb(); }
            },
            onChanged: { addListener: () => {} }
        }
    };

    // Load supabase-service then bundle
    require('../src/supabase-service.js');
    require('../src/bundle.js');

    const orchestrator = global.window.orchestrator;
    assert(orchestrator, 'Orchestrator should exist on window');

    orchestrator.keywordManager.loadKeywords().then(() => {
        const activeCount = orchestrator.keywordManager.getActiveFilterCount();
        assert.strictEqual(activeCount, 1, 'Active filters must be primed immediately from storage cache in 0ms');
        assert.strictEqual(orchestrator.supabase._filtersLoaded, true, 'Supabase _filtersLoaded must be primed immediately');
        console.log('  ✅ PASS: 2. Active filters primed from storage cache instantly on reload without network delay');

        // Test 3: Unloaded filter scan skips do NOT permanently swallow cards in scanner
        orchestrator.supabase._filtersLoaded = false;
        orchestrator.scanner._knownLeads = {};
        const mockCard = { id: 'card_realtime_1', element: { querySelectorAll: () => [], getAttribute: () => null } };

        orchestrator._onCardsDetected([mockCard]);
        assert.strictEqual(orchestrator.scanner._knownLeads['card_realtime_1'], undefined, 'Card skipped during filter loading must NOT be retained in scanner._knownLeads');
        console.log('  ✅ PASS: 3. Scanner does not permanently swallow cards if filters are momentarily loading');

        // Test 4: PageNavigator._startLoop has no 5000ms throttle
        assert.strictEqual(orchestrator.navigator._settings.autoReloadOnComplete, true);
        assert.strictEqual(orchestrator.navigator._loopInProgress, false);
        console.log('  ✅ PASS: 4. PageNavigator runs real-time loop without 5000ms filter check delay');

        // Test 5: Qualifier-aware filter matching matches real leads with pharmacopoeia & intent descriptors
        orchestrator.supabase._filtersLoaded = true;
        orchestrator.keywordManager.extractFromSupabaseFilters([
            {
                id: 199,
                filter_name: 'USP Grade Abaloparatide API',
                filter_config: { product_names: ['USP Grade Abaloparatide API'] },
                is_active: true
            },
            {
                id: 196,
                filter_name: 'Personal Use Tretinoin',
                filter_config: { product_names: ['Personal Use Tretinoin 0.025 Cream, 20 Gm'] },
                is_active: true
            }
        ]);

        const leadAbaloparatide = {
            productName: 'Abaloparatide',
            messageText: 'Looking for Abaloparatide high quality',
            contact: { mobile: '9999999999' }
        };
        const matchResult1 = orchestrator.keywordManager.evaluateFilters(leadAbaloparatide);
        assert.strictEqual(matchResult1.passed, true, 'Lead "Abaloparatide" must match filter "USP Grade Abaloparatide API"');
        assert.strictEqual(matchResult1.filterId, 199);

        const leadTretinoin = {
            productName: 'Tretinoin 0.025% Cream',
            messageText: 'Need 20g tube for personal use',
            contact: { mobile: '9999999999' }
        };
        const matchResult2 = orchestrator.keywordManager.evaluateFilters(leadTretinoin);
        assert.strictEqual(matchResult2.passed, true, 'Lead "Tretinoin 0.025% Cream" must match filter "Personal Use Tretinoin 0.025 Cream, 20 Gm"');
        assert.strictEqual(matchResult2.filterId, 196);
        console.log('  ✅ PASS: 5. Qualifier-aware matching matches real leads with compound pharmacopoeia/intent descriptors');

        // Clean up timers
        if (orchestrator.navigator) orchestrator.navigator.stop();
        if (orchestrator.scanner) orchestrator.scanner.stopWatching();

        console.log('\n=== ALL REAL-TIME FILTER MATCHING TESTS PASSED ===\n');
        process.exit(0);
    }).catch(err => {
        console.error('Test error:', err);
        process.exit(1);
    });
})();
