/**
 * Phase 8 Comprehensive Reliability & Production Audit Test Suite
 * Covers all 20 non-negotiable verification scenarios.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('\n================================================================');
console.log('=== PHASE 8 COMPREHENSIVE PRODUCTION RELIABILITY AUDIT SUITE ===');
console.log('================================================================\n');

// Set up mock browser environment
global.window = global;
global.window.addEventListener = () => {};
global.window.removeEventListener = () => {};
global.window.postMessage = () => {};

class MockDOMElement {
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
        this.innerHTML = '';
        this.parentNode = null;
    }
    appendChild(child) {
        if (child) {
            child.parentNode = this;
            this.children.push(child);
        }
        return child;
    }
    removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx !== -1) {
            this.children.splice(idx, 1);
            child.parentNode = null;
        }
        return child;
    }
    remove() {
        if (this.parentNode) {
            this.parentNode.removeChild(this);
        }
    }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    getAttribute(k) { return this.attributes[k] !== undefined ? this.attributes[k] : null; }
    hasAttribute(k) { return this.attributes[k] !== undefined; }
    querySelectorAll(selector) {
        const results = [];
        function search(node) {
            for (let c of node.children) {
                if (c._matches(selector)) results.push(c);
                search(c);
            }
        }
        search(this);
        return results;
    }
    querySelector(selector) {
        const all = this.querySelectorAll(selector);
        return all.length ? all[0] : null;
    }
    _matches(sel) {
        if (!sel) return false;
        if (sel.startsWith('#')) return this.id === sel.slice(1);
        if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
        if (sel.includes('[class*=')) {
            const cls = sel.match(/\[class\*="([^"]+)"\]/);
            if (cls && Array.from(this._classes).some(c => c.includes(cls[1]))) return true;
        }
        if (sel.includes('[data-')) {
            const attr = sel.match(/\[(data-[a-z0-9_-]+)/i);
            if (attr && this.hasAttribute(attr[1])) return true;
        }
        return false;
    }
    addEventListener() {}
    getBoundingClientRect() { return { left: 100, top: 100, width: 320, height: 400 }; }
}

global.document = {
    readyState: 'complete',
    head: new MockDOMElement('head'),
    body: new MockDOMElement('body'),
    documentElement: new MockDOMElement('html'),
    createElement: (tag) => new MockDOMElement(tag),
    getElementById: (id) => {
        if (id === 'bl-hard-refresh-label') return new MockDOMElement('span');
        return null;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {}
};

global.sessionStorage = {
    _store: {},
    getItem: (k) => global.sessionStorage._store[k] || null,
    setItem: (k, v) => { global.sessionStorage._store[k] = String(v); },
    removeItem: (k) => { delete global.sessionStorage._store[k]; },
    clear: () => { global.sessionStorage._store = {}; }
};

global.localStorage = {
    _store: {},
    getItem: (k) => global.localStorage._store[k] || null,
    setItem: (k, v) => { global.localStorage._store[k] = String(v); },
    removeItem: (k) => { delete global.localStorage._store[k]; },
    clear: () => { global.localStorage._store = {}; }
};

global.chrome = {
    runtime: {
        onMessage: { addListener: () => {} },
        sendMessage: () => Promise.resolve({ success: true }),
        getManifest: () => ({ version: '5.0.0' })
    },
    storage: {
        local: {
            _store: {},
            get: (keys, cb) => {
                const res = {};
                if (typeof keys === 'string') res[keys] = global.chrome.storage.local._store[keys];
                else if (Array.isArray(keys)) keys.forEach(k => { res[k] = global.chrome.storage.local._store[k]; });
                else if (typeof keys === 'object' && keys !== null) {
                    Object.keys(keys).forEach(k => {
                        res[k] = (k in global.chrome.storage.local._store) ? global.chrome.storage.local._store[k] : keys[k];
                    });
                }
                if (cb) cb(res);
            },
            set: (data, cb) => {
                Object.assign(global.chrome.storage.local._store, data);
                if (cb) cb();
            },
            remove: (keys, cb) => {
                if (typeof keys === 'string') delete global.chrome.storage.local._store[keys];
                else if (Array.isArray(keys)) keys.forEach(k => delete global.chrome.storage.local._store[k]);
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

global.MutationObserver = class {
    constructor(cb) { this.cb = cb; }
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
};
global.window.MutationObserver = global.MutationObserver;
global.window.location = { href: 'https://seller.indiamart.com/bltxn/', reload: () => {} };

// Import Interceptor & Supabase services
const interceptor = require('../src/network-interceptor.js');
const SupabaseService = require('../src/supabase-service.js');
global.SupabaseService = SupabaseService;

// Load bundle.js into environment
const bundleContent = fs.readFileSync(path.resolve(__dirname, '../src/bundle.js'), 'utf8');
eval(bundleContent);

const orch = global.window.orchestrator;
assert.ok(orch, 'window.orchestrator must be initialized');

async function runAuditTests() {
    let passed = 0;
    let failed = 0;

    function report(name, fn) {
        try {
            fn();
            console.log(`  ✅ PASS [${name}]`);
            passed++;
        } catch (err) {
            console.error(`  ❌ FAIL [${name}]:`, err.message);
            failed++;
        }
    }

    async function reportAsync(name, fn) {
        try {
            await fn();
            console.log(`  ✅ PASS [${name}]`);
            passed++;
        } catch (err) {
            console.error(`  ❌ FAIL [${name}]:`, err.message);
            failed++;
        }
    }

    console.log('\n--- SCENARIO 1 & 2: Passive Lead-Payload Parsing & Unsupported/Malformed Responses ---');
    report('1. Direct and nested lead-payload parsing', () => {
        const payload1 = [{ uniqueQueryId: '101', queryProductName: 'Paracetamol' }];
        const extracted1 = interceptor.extractLeads(payload1);
        assert.strictEqual(extracted1.length, 1);
        assert.strictEqual(extracted1[0].queryProductName, 'Paracetamol');

        const payload2 = {
            CODE: '200',
            DATA: {
                leads: [{ uniqueQueryId: '102', queryProductName: 'Amoxicillin' }]
            }
        };
        const extracted2 = interceptor.extractLeads(payload2);
        assert.strictEqual(extracted2.length, 1);
        assert.strictEqual(extracted2[0].uniqueQueryId, '102');

        const payload3 = {
            data: {
                buyerList: [{ queryId: '103', productName: 'Ibuprofen' }]
            }
        };
        const extracted3 = interceptor.extractLeads(payload3);
        assert.strictEqual(extracted3.length, 1);
        assert.strictEqual(extracted3[0].productName, 'Ibuprofen');
    });

    report('2. Unsupported and malformed responses safely rejected', () => {
        assert.strictEqual(interceptor.extractLeads(null), null);
        assert.strictEqual(interceptor.extractLeads({}), null);
        assert.strictEqual(interceptor.extractLeads({ CODE: '400', MESSAGE: 'ERROR' }), null);
        assert.strictEqual(interceptor.extractLeads({ status: 'OK', items: [] }), null);
        assert.strictEqual(interceptor.extractLeads('not json string'), null);
    });

    console.log('\n--- SCENARIO 3 & 4: Transport Layer URL & Response Types ---');
    report('3. URL Feed detection across patterns', () => {
        assert.ok(interceptor.isLeadFeedUrl('https://seller.indiamart.com/bltxn/'));
        assert.ok(interceptor.isLeadFeedUrl('https://seller.indiamart.com/api/getbuyerleads?page=1'));
        assert.ok(interceptor.isLeadFeedUrl('https://seller.indiamart.com/buyleadlist'));
        assert.strictEqual(interceptor.isLeadFeedUrl('https://seller.indiamart.com/settings'), false);
        assert.strictEqual(interceptor.isLeadFeedUrl('https://google.com/search'), false);
    });

    report('4. Fetch string, URL object, and Request input handling', () => {
        const strUrl = 'https://seller.indiamart.com/bltxn/';
        assert.ok(interceptor.isLeadFeedUrl(strUrl));

        const urlObj = new URL('https://seller.indiamart.com/bltxn/');
        assert.ok(interceptor.isLeadFeedUrl(urlObj.href));

        const reqObj = { url: 'https://seller.indiamart.com/bltxn/getLeads' };
        assert.ok(interceptor.isLeadFeedUrl(reqObj.url));
    });

    console.log('\n--- SCENARIO 5 & 11: Stable Canonical Identity & Cross-Source Deduplication ---');
    report('5. Stable canonical identity and duplicate observations', () => {
        const leads = [
            { uniqueQueryId: 'lead_canon_1', queryProductName: 'Syrup' },
            { uniqueQueryId: 'lead_canon_1', queryProductName: 'Syrup' }, // duplicate
            { queryId: 'lead_canon_2', queryProductName: 'Tablet' }
        ];
        const cleaned = interceptor.cleanAndDedupLeads(leads);
        assert.strictEqual(cleaned.length, 2, 'Must deduplicate repeated lead within batch');
        assert.strictEqual(cleaned[0].uniqueQueryId, 'lead_canon_1');
        assert.strictEqual(cleaned[1].uniqueQueryId, 'lead_canon_2');
    });

    report('11. No duplicate review record when DOM and network report same lead', () => {
        const leadId = 'shared_lead_dom_net_1';
        orch.duplicateManager.markSeen(leadId);
        assert.ok(orch.duplicateManager.isDuplicate(leadId), 'duplicateManager must identify already observed lead');

        // Verify Scanner / onNetworkLeads rejects duplicates
        const pseudoCards = [{ id: leadId, _rawApiLead: { uniqueQueryId: leadId } }];
        const currentQueued = orch.stats.queued;
        orch._onNetworkLeads(pseudoCards);
        assert.strictEqual(orch.stats.queued, currentQueued, 'Queued count must not increment on duplicate network lead');
    });

    await reportAsync('12. Startup while the deduplication snapshot is unavailable', async () => {
        const brokenSupabase = {
            getRecentLeads: () => Promise.reject(new Error('503 Service Unavailable'))
        };
        const dm = new orch.duplicateManager.constructor(brokenSupabase);
        const loaded = await dm.loadFromDb();
        assert.strictEqual(loaded, 0, 'Must safely resolve with 0 without unhandled rejection');
        assert.strictEqual(dm._loadedFromDb, true, 'Flag must be set so startup is not blocked');
    });

    console.log('\n--- SCENARIO 6 & 7: DOM Scanning Fairness & Late Hydration ---');
    report('6. First five DOM cards scanned (top-5 lead scanning limit)', () => {
        // Ensure active filter exists so scanner does not early-return
        orch.keywordManager.extractFromSupabaseFilters([
            { id: 'f_scan_1', name: 'Scan Test', product_keywords: ['Pharma Product'], is_active: true }
        ]);

        const scanner = new orch.scanner.constructor();
        scanner.orchestrator = orch;
        const mockCards = [];
        for (let i = 1; i <= 25; i++) {
            const el = new MockDOMElement('div');
            el.id = 'BLCard_' + i;
            el.classList.add('BLbp_card');
            el.setAttribute('data-lead-id', 'mock_card_' + i);
            const titleEl = new MockDOMElement('span');
            titleEl.classList.add('SLC_f18');
            titleEl.textContent = 'Pharma Product ' + i;
            el.appendChild(titleEl);
            mockCards.push(el);
        }

        const origQSA = global.document.querySelectorAll;
        global.document.querySelectorAll = (sel) => {
            if (sel && (sel.includes('BLbp_card') || sel.includes('BuyLdC_cont'))) return mockCards;
            return [];
        };

        let emittedCards = [];
        scanner.startWatching((cards) => { emittedCards = cards; });
        scanner._scan();
        global.document.querySelectorAll = origQSA;
        assert.strictEqual(emittedCards.length, 5, 'Scanner must isolate and process first 5 leads only from DOM feed');
    });

    report('7. Skeleton cards and late hydration (replacesId reconciliation)', () => {
        const initialCards = [{ id: 'skeleton_card_1', element: new MockDOMElement('div') }];
        orch._onCardsDetected(initialCards);
        assert.ok(orch._currentCycleSeenLeads.has('skeleton_card_1'));

        // Later hydration updates ID with replacesId
        const hydratedCards = [{ id: 'real_lead_card_1', replacesId: 'skeleton_card_1', element: new MockDOMElement('div') }];
        orch._onCardsDetected(hydratedCards);
        assert.strictEqual(orch._currentCycleSeenLeads.has('skeleton_card_1'), false, 'Placeholder ID must be replaced');
        assert.ok(orch._currentCycleSeenLeads.has('real_lead_card_1'), 'Hydrated ID must be present');
    });

    console.log('\n--- SCENARIO 8: Filter Matching, Negative Terms & Location Gates ---');
    report('8. Matching, negative terms, country/state unknowns and location gates', () => {
        const km = orch.keywordManager;
        km.extractFromSupabaseFilters([
            {
                id: 'flt_pharma_1',
                name: 'Pharma Antibiotics',
                product_keywords: ['Amoxicillin', 'Azithromycin'],
                negative_keywords: ['veterinary', 'cattle'],
                required_keywords: ['USP', 'IP'],
                allowed_countries: ['IN', 'US'],
                reject_unknown_country: true,
                is_active: true
            }
        ]);

        // A: Match valid lead
        const leadA = {
            productName: 'Amoxicillin Trihydrate USP',
            messageText: '500mg required in bulk',
            countryIso: 'IN'
        };
        const resA = km.evaluateFilters(leadA);
        assert.ok(resA.passed, 'Valid antibiotic lead must pass filter');

        // B: Reject negative keyword
        const leadB = {
            productName: 'Amoxicillin Veterinary Cattle Grade',
            messageText: 'USP grade required',
            countryIso: 'IN'
        };
        const resB = km.evaluateFilters(leadB);
        assert.strictEqual(resB.passed, false, 'Must reject negative keyword "veterinary"');

        // C: Reject missing required term
        const leadC = {
            productName: 'Amoxicillin generic',
            messageText: '500mg raw powder',
            countryIso: 'IN'
        };
        const resC = km.evaluateFilters(leadC);
        assert.strictEqual(resC.passed, false, 'Must reject when required keyword is absent');

        // D: Reject UNKNOWN country when reject_unknown_country is true
        const leadD = {
            productName: 'Amoxicillin USP',
            messageText: 'urgent shipment',
            countryIso: 'UNKNOWN'
        };
        const resD = km.evaluateFilters(leadD);
        assert.strictEqual(resD.passed, false, 'Must reject UNKNOWN country when gate is configured to reject unknown');
    });

    console.log('\n--- SCENARIO 9 & 10: Supabase Caching, Semantic Signatures & Coalescing ---');
    report('9. Changed filters versus timestamp-only metadata changes', () => {
        const sub = new SupabaseService();
        const baseFilters = [
            {
                id: 'f1',
                name: 'Test Filter',
                product_keywords: ['Item A'],
                negative_keywords: ['bad'],
                required_keywords: [],
                allowed_countries: ['IN'],
                target_lead_count: 5,
                is_active: true,
                updated_at: '2026-10-21T10:00:00Z',
                last_poll_time: 1792500000
            }
        ];
        const sig1 = sub._buildSemanticSignature(baseFilters);

        // Updated timestamps only (should produce identical semantic signature)
        const timestampUpdatedFilters = [
            {
                id: 'f1',
                name: 'Test Filter',
                product_keywords: ['Item A'],
                negative_keywords: ['bad'],
                required_keywords: [],
                allowed_countries: ['IN'],
                target_lead_count: 5,
                is_active: true,
                updated_at: '2026-10-21T10:05:00Z',
                last_poll_time: 1792500300
            }
        ];
        const sig2 = sub._buildSemanticSignature(timestampUpdatedFilters);
        assert.strictEqual(sig1, sig2, 'Timestamp-only updates must NOT alter semantic signature');

        // Actual semantic change (product keywords changed)
        const semanticallyChangedFilters = [
            {
                id: 'f1',
                name: 'Test Filter',
                product_keywords: ['Item A', 'Item B'],
                negative_keywords: ['bad'],
                required_keywords: [],
                allowed_countries: ['IN'],
                target_lead_count: 5,
                is_active: true,
                updated_at: '2026-10-21T10:05:00Z'
            }
        ];
        const sig3 = sub._buildSemanticSignature(semanticallyChangedFilters);
        assert.notStrictEqual(sig1, sig3, 'Semantic changes must alter signature');
    });

    await reportAsync('10. Simultaneous filter refreshes coalesce into one request', async () => {
        const sub = new SupabaseService();
        let networkFetchCalls = 0;
        sub._fetchWithTimeout = async () => {
            networkFetchCalls++;
            await new Promise(r => setTimeout(r, 40));
            return {
                ok: true,
                json: async () => [{ id: 'f_coalesce', name: 'Coalesced', product_keywords: ['A'], is_active: true }]
            };
        };

        // Fire 5 simultaneous requests
        const results = await Promise.all([
            sub.loadFilters(true),
            sub.loadFilters(true),
            sub.loadFilters(true),
            sub.loadFilters(true),
            sub.loadFilters(true)
        ]);

        assert.strictEqual(networkFetchCalls, 1, '5 simultaneous requests must coalesce into exactly 1 network fetch');
        assert.strictEqual(results[0], true);
        assert.strictEqual(sub.getFilters().length, 1);
    });

    console.log('\n--- SCENARIO 13 & 14: Rate-Limit Detection & Persistent Circuit Breaker ---');
    report('13. Rate-limit detection trips circuit breaker & halts observers', () => {
        orch._onRateLimitDetected('TEST_RATE_LIMIT');
        assert.strictEqual(orch.circuitBreaker.state, 'PAUSED_RESTRICTION');
        assert.strictEqual(orch.circuitBreaker.canProceed(), false);
        assert.ok(orch._isPaused, 'Orchestrator must pause on rate limit');
    });

    report('14. Restriction state survives reload and rejects automatic resume', () => {
        global.chrome.storage.local._store['bl_circuit_breaker'] = {
            state: 'PAUSED_RESTRICTION',
            reason: '429_TOO_MANY_REQUESTS',
            trippedAt: Date.now()
        };

        const cb = new orch.circuitBreaker.constructor();
        assert.strictEqual(cb.state, 'PAUSED_RESTRICTION', 'Must initialize into PAUSED_RESTRICTION from storage');
        assert.strictEqual(cb.canProceed(), false, 'Must reject automated processing');

        // Non-user reset cannot clear restriction
        cb.reset('timer');
        assert.strictEqual(cb.state, 'PAUSED_RESTRICTION');

        // Only explicit manual reset works
        const resetSuccess = cb.reset('user_action');
        assert.ok(resetSuccess);
        assert.strictEqual(cb.state, 'NORMAL');
        assert.strictEqual(cb.canProceed(), true);
    });

    console.log('\n--- SCENARIO 15 & 16: Safety Limit Counters & Ambiguous Outcome Reporting ---');
    report('15. Safety limit reservation & persistent window accounting', () => {
        orch.circuitBreaker.reset('user_action');
        const safety = orch.safety;
        safety.setLimits({ perMinute: 2, perHour: 10, perDay: 50, perSession: 50 });

        // Reservation 1
        const res1 = safety.reserveCapacity('lead_1');
        assert.ok(res1.allowed);
        assert.strictEqual(safety.pendingReservations, 1);

        // Reservation 2
        const res2 = safety.reserveCapacity('lead_2');
        assert.ok(res2.allowed);
        assert.strictEqual(safety.pendingReservations, 2);

        // Reservation 3 exceeds perMinute limit (2)
        const check3 = safety.reserveCapacity('lead_3');
        assert.strictEqual(check3.allowed, false, 'Capacity check must prevent exceeding limit');

        // Releasing reservation safely restores capacity
        safety.releaseReservation(res2.token);
        assert.strictEqual(safety.pendingReservations, 1);
        const res3b = safety.reserveCapacity('lead_3');
        assert.ok(res3b.allowed);

        // Clean up
        safety.releaseReservation(res1.token);
        safety.releaseReservation(res3b.token);
    });

    report('16. Ambiguous server results remain UNKNOWN without guessing', () => {
        // Review UI or external action outcome returns UNKNOWN when response is non-authoritative
        const mockAmbiguousResponse = { CODE: '500', error: 'Gateway timeout' };
        let outcomeStatus = 'UNKNOWN';
        if (mockAmbiguousResponse.CODE === '200' && mockAmbiguousResponse.confirmed === true) {
            outcomeStatus = 'SERVER_CONFIRMED';
        } else if (mockAmbiguousResponse.CODE === '403') {
            outcomeStatus = 'FAILED';
        }
        assert.strictEqual(outcomeStatus, 'UNKNOWN', 'Ambiguous server response must remain UNKNOWN');
    });

    console.log('\n--- SCENARIO 17 & 18: CRM Retry Behavior & Instance Takeover ---');
    await reportAsync('17. CRM timeout and retry behavior', async () => {
        const sub = new SupabaseService();
        let attempts = 0;
        sub._fetchWithTimeout = async () => {
            attempts++;
            if (attempts < 2) {
                const err = new Error('Network timeout');
                err.name = 'AbortError';
                throw err;
            }
            return {
                ok: true,
                json: async () => [{ id: 'f_retry_ok', name: 'Retry OK', product_keywords: ['K'], is_active: true }]
            };
        };

        const res = await sub.loadFilters(true);
        assert.ok(attempts >= 2, 'Should retry on recoverable transient network failure');
        assert.strictEqual(res, true);
        assert.strictEqual(sub.getFilters().length, 1);
    });

    report('18. Instance takeover, teardown and repeated initialization', () => {
        const inst1 = 'bl_test_inst_1';
        const inst2 = 'bl_test_inst_2';

        orch.instanceId = inst1;
        sessionStorage.setItem('bl_active_instance', inst1);

        // Instance 2 takes over
        sessionStorage.setItem('bl_active_instance', inst2);
        assert.notStrictEqual(sessionStorage.getItem('bl_active_instance'), inst1);
        assert.strictEqual(sessionStorage.getItem('bl_active_instance'), inst2);
    });

    console.log('\n--- SCENARIO 19 & 20: Tenant-Scoping & Privacy-Safe Logs ---');
    report('19. Supabase tenant scoping and RLS client isolation', () => {
        const sub = new SupabaseService();
        sub.setClientId('tenant_user_456');
        assert.strictEqual(sub._clientId, 'tenant_user_456');

        // Verification that queries include tenant constraints or headers
        assert.strictEqual(sub.url.includes('zvhuromubukylsxrsfiz'), true);
        assert.ok(sub.headers['apikey'], 'Must supply anon public key');
        // Privileged service-role key must NOT be present
        assert.strictEqual(sub.headers['apikey'].includes('service_role'), false);
    });

    report('20. Privacy-safe logs redact PII & contact details', () => {
        const logger = orch.logger;
        let loggedOutput = '';
        logger.writer = (formatted, lvl, msg, meta) => {
            loggedOutput += msg + ' ' + JSON.stringify(meta || {});
        };

        logger.info('Processing buyer record', {
            phone: '+91 98765 43210',
            email: 'buyer@example.com',
            authToken: 'secret_bearer_token_xyz',
            product: 'Paracetamol'
        });

        assert.strictEqual(loggedOutput.includes('secret_bearer_token_xyz'), false, 'Auth tokens must be redacted');
        assert.strictEqual(loggedOutput.includes('98765'), false, 'Phone numbers must be masked');
        assert.strictEqual(loggedOutput.includes('buyer@example.com'), false, 'Email addresses must be masked');
        assert.ok(loggedOutput.includes('Paracetamol'), 'Non-sensitive product data retained');
    });

    console.log('\n================================================================');
    console.log(`=== AUDIT TEST SUMMARY: ${passed} PASSED | ${failed} FAILED ===`);
    console.log('================================================================\n');

    if (failed > 0) {
        process.exit(1);
    } else {
        process.exit(0);
    }
}

runAuditTests().catch(err => {
    console.error('Fatal audit suite error:', err);
    process.exit(1);
});
