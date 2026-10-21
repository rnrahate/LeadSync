const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('\n=== COMPREHENSIVE WORKFLOW & COMPATIBILITY TEST SUITE ===\n');

const basePath = 'c:/Users/Asus/Documents/LeadSync-IndiaMart Extension/Leadsync extension  (Main)/Leadsync extension  (Main)';
const bundlePath = basePath + '/src/bundle.js';
const swPath = basePath + '/service-worker.js';
const popupPath = basePath + '/popup/popup.js';
const supabasePath = basePath + '/src/supabase-service.js';

// 1. Verify all files exist and compile
const filesToCheck = [
    { name: 'src/bundle.js', path: bundlePath },
    { name: 'service-worker.js', path: swPath },
    { name: 'popup/popup.js', path: popupPath },
    { name: 'src/supabase-service.js', path: supabasePath }
];

filesToCheck.forEach(f => {
    assert.ok(fs.existsSync(f.path), f.name + ' must exist');
    const code = fs.readFileSync(f.path, 'utf8');
    assert.doesNotThrow(() => new vm.Script(code), 'Syntax error in ' + f.name);
    console.log('  ✅ PASS: ' + f.name + ' syntax & compilation verified');
});

class MockElement {
    constructor(tagName = 'div') {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.attributes = {};
        this.style = { display: 'block', visibility: 'visible', opacity: '1' };
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
    removeAttribute(k) { delete this.attributes[k]; }
    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }
    remove() {
        if (this.parentNode && this.parentNode.children) {
            const idx = this.parentNode.children.indexOf(this);
            if (idx !== -1) this.parentNode.children.splice(idx, 1);
        }
        this.parentNode = null;
        this.isConnected = false;
    }
    addEventListener() {}
    removeEventListener() {}
    contains(child) {
        if (child === this) return true;
        for (let c of this.children) {
            if (c === child || (c.contains && c.contains(child))) return true;
        }
        return false;
    }
    closest(selector) {
        let cur = this;
        while (cur) {
            if (cur.matches && cur.matches(selector)) return cur;
            cur = cur.parentNode;
        }
        return null;
    }
    matches(selector) {
        const s = selector.toLowerCase();
        if (s.startsWith('.')) return this.classList.contains(s.slice(1));
        if (s === this.tagName.toLowerCase()) return true;
        if (s.includes('button') && this.tagName === 'BUTTON') return true;
        if (s.includes('a') && this.tagName === 'A') return true;
        return false;
    }
    getBoundingClientRect() {
        if (this.style.display === 'none' || this.style.visibility === 'hidden') {
            return { top: 0, left: 0, width: 0, height: 0 };
        }
        return { top: 10, left: 10, width: 200, height: 100 };
    }
    querySelector(selector) {
        const res = this.querySelectorAll(selector);
        return res.length ? res[0] : null;
    }
    querySelectorAll(selector) {
        const matches = [];
        const s = selector.toLowerCase();
        function search(node) {
            for (let child of node.children) {
                const tag = child.tagName.toLowerCase();
                const cls = Array.from(child._classes).join(' ').toLowerCase();
                const id = (child.id || '').toLowerCase();
                if (s.includes(tag) || s.split(',').some(part => {
                    const p = part.trim();
                    if (p.startsWith('.')) return cls.includes(p.slice(1));
                    if (p.startsWith('#')) return id === p.slice(1);
                    return tag === p;
                })) {
                    matches.push(child);
                }
                search(child);
            }
        }
        search(this);
        return matches;
    }
    dispatchEvent() { return true; }
    click() {
        this._clicked = true;
        if (typeof this.onclick === 'function') this.onclick();
    }
}

// 2. Setup mock environment for bundle execution
global.window = global;
global.window.addEventListener = () => {};
global.window.removeEventListener = () => {};
global.window.postMessage = () => {};
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
    createElement: (tag) => {
        const el = new MockElement(tag);
        return el;
    },
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
        onMessage: { addListener: (fn) => { global._msgListener = fn; } },
        sendMessage: (msg, cb) => {
            if (typeof cb === 'function') cb({ success: true });
            return Promise.resolve({ success: true });
        }
    },
    storage: {
        local: {
            _store: {
                mode: 'AUTOMATIC',
                supabaseEnabled: true,
                autoReloadOnComplete: true
            },
            get: (keys, cb) => {
                if (typeof keys === 'function') { keys(global.chrome.storage.local._store); return; }
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

global.window.getComputedStyle = (el) => el.style || { display: 'block', visibility: 'visible', opacity: '1' };
global.window.location = { href: 'https://seller.indiamart.com/bltxn/', reload: () => { global._reloaded = true; } };

// Load SupabaseService mock
global.SupabaseService = function() {
    this._filtersLoaded = true;
    this._filters = [
        {
            id: 'filter_pramoxine',
            name: 'Pramoxine Foam Filter',
            product_keywords: ['Pramoxine Hydrochloride Foam'],
            negative_keywords: ['capsule'],
            target_lead_count: 1,
            is_active: true
        },
        {
            id: 'filter_sunscreen',
            name: 'Sunscreen Gel Filter',
            product_keywords: ['Sunscreen 50g', 'SPF 50 Gel'],
            negative_keywords: ['soap'],
            target_lead_count: 2,
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

// Load bundle.js into VM
const bundleContent = fs.readFileSync(bundlePath, 'utf8');
eval(bundleContent);

const orch = global.window.orchestrator;
assert.ok(orch, 'window.orchestrator must be initialized');
console.log('  ✅ PASS: bundle.js instantiated successfully in mock environment');

// Test 1: Matching variations (Title with 1%, Message with requirement)
const filterPramoxine = orch.supabase.getFilters()[0];
const leadTitleVariation = {
    productName: 'Pramoxine Hydrochloride 1% Foam',
    messageText: ''
};
const resTitleVar = orch.keywordManager.matcher.evaluate(leadTitleVariation, filterPramoxine);
assert.strictEqual(resTitleVar.passed, true, 'Title variation (Pramoxine Hydrochloride 1% Foam) must pass');
assert.ok(resTitleVar.score >= 50, 'Score must be >= 50, got: ' + resTitleVar.score);
console.log('  ✅ PASS: Lead title variation matching verified (score=' + resTitleVar.score + ')');

const leadMsgMatch = {
    productName: 'Pharmaceutical Intermediate',
    messageText: 'Buyer searched for: Pramoxine Hydrochloride Foam 100ml'
};
const resMsgMatch = orch.keywordManager.matcher.evaluate(leadMsgMatch, filterPramoxine);
assert.strictEqual(resMsgMatch.passed, true, 'Message keyword match must pass');
assert.ok(resMsgMatch.score >= 50, 'Message match score must be >= 50, got: ' + resMsgMatch.score);
console.log('  ✅ PASS: Lead requirement in messageText matching verified (score=' + resMsgMatch.score + ')');

// Test 2: Negative keyword rejection
const leadNeg = {
    productName: 'Pramoxine Hydrochloride Foam Capsule',
    messageText: ''
};
const resNeg = orch.keywordManager.matcher.evaluate(leadNeg, filterPramoxine);
assert.strictEqual(resNeg.passed, false, 'Negative keyword match must be rejected');
assert.strictEqual(resNeg.reason, 'negative_keyword_match');
console.log('  ✅ PASS: Negative keyword rejection verified');

// Test 3: ActionAdapter card button discovery and acquisition
const cardEl = new MockElement('div');
const cardTitle = new MockElement('div');
cardTitle.classList.add('BLbp_title');
cardTitle.textContent = 'Pramoxine Hydrochloride 1% Foam';
cardEl.appendChild(cardTitle);

const cardBtn = new MockElement('button');
cardBtn.textContent = 'Contact Buyer Now';
cardEl.appendChild(cardBtn);

// Mock modal popup in document
let popupContainer = new MockElement('div');
popupContainer.classList.add('SLC_PopCntr');
let sendBtn = new MockElement('button');
sendBtn.textContent = 'Send Enquiry';
popupContainer.appendChild(sendBtn);

// When sendBtn is clicked in portal, simulate modal closing and card updating to "Contacted"
sendBtn.onclick = function() {
    setTimeout(function() {
        popupContainer.style.display = 'none';
        cardBtn.textContent = 'Contacted';
    }, 50);
};

global.document.querySelectorAll = (sel) => {
    if ((sel.includes('SLC_PopCntr') || sel.includes('popup')) && popupContainer.style.display !== 'none') {
        return [popupContainer];
    }
    return [];
};

// Test 4: End-to-end processing of matched lead through _processLead
orch.keywordManager.extractFromSupabaseFilters(orch.supabase.getFilters());

const leadToProcess = {
    leadId: 'lead_e2e_test_1',
    filterId: 'filter_pramoxine',
    productName: 'Pramoxine Hydrochloride 1% Foam',
    senderMobile: '9988776655',
    raw: { element: cardEl }
};

orch.keywordManager.reserveSlot('filter_pramoxine', leadToProcess.leadId);
const activeFiltersBefore = orch.keywordManager.getActiveFilterCount();

orch._processLead(leadToProcess).then(() => {
    assert.strictEqual(cardBtn._clicked, true, 'Card button must be clicked');
    assert.strictEqual(sendBtn._clicked, true, 'Send Enquiry button in modal must be clicked');
    console.log('  ✅ PASS: Card button discovery, modal popup detection, and affirmative Send action verified');

    const activeFiltersAfter = orch.keywordManager.getActiveFilterCount();
    assert.strictEqual(activeFiltersAfter, activeFiltersBefore - 1, 'Active filter count must be deduced by 1 after successful contact');
    console.log('  ✅ PASS: Active filter successfully deduced (' + activeFiltersBefore + ' -> ' + activeFiltersAfter + ')');

    // Test 5: Popup & service worker messaging compatibility
    let statusResp = null;
    global._msgListener({ action: 'GET_STATUS' }, null, (r) => { statusResp = r; });
    assert.ok(statusResp && statusResp.success, 'GET_STATUS must succeed');
    assert.strictEqual(statusResp.mode, 'AUTOMATIC');
    console.log('  ✅ PASS: GET_STATUS message exchange verified');

    new Promise((resolve) => {
        global._msgListener({ action: 'SET_MODE', mode: 'ASSISTED' }, null, resolve);
    }).then((modeResp) => {
        assert.ok(modeResp && modeResp.success, 'SET_MODE must succeed');
        assert.strictEqual(orch.config.mode, 'ASSISTED');
        console.log('  ✅ PASS: SET_MODE message exchange verified');

        console.log('\n=== ALL WORKFLOW & COMPATIBILITY TESTS PASSED ===\n');
        process.exit(0);
    });
});
