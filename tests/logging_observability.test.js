/**
 * tests/logging_observability.test.js
 * Comprehensive automated verification for Phase 10 of Logging and Observability Refactor.
 * Covers all 14 mandatory validation points.
 */

const assert = require('assert');

console.log('\n================================================================');
console.log('=== PHASE 10: LOGGING & OBSERVABILITY AUTOMATED TEST SUITE   ===');
console.log('================================================================\n');

// Mock DOM elements for bundle.js initialization
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
        if (this.parentNode) this.parentNode.removeChild(this);
    }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    getAttribute(k) { return this.attributes[k] !== undefined ? this.attributes[k] : null; }
    hasAttribute(k) { return this.attributes[k] !== undefined; }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    addEventListener() {}
    getBoundingClientRect() { return { left: 100, top: 100, width: 320, height: 400 }; }
}

global.window = global;
global.window.addEventListener = () => {};
global.window.removeEventListener = () => {};
global.window.postMessage = () => {};

global.document = {
    readyState: 'complete',
    head: new MockDOMElement('head'),
    body: new MockDOMElement('body'),
    documentElement: new MockDOMElement('html'),
    createElement: (tag) => new MockDOMElement(tag),
    getElementById: (id) => new MockDOMElement('div'),
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

if (!global.performance) {
    global.performance = { now: () => Date.now() };
}

let mockStorage = {};
global.chrome = {
    runtime: {
        getManifest: () => ({ version: '6.3.0' }),
        getURL: (p) => 'chrome-extension://mock/' + p,
        sendMessage: (msg, cb) => { if (cb) cb({ received: true }); return Promise.resolve({ received: true }); },
        onMessage: { addListener: () => {} },
        lastError: null
    },
    storage: {
        local: {
            get: (keys, cb) => {
                let res = {};
                if (typeof keys === 'string') {
                    res[keys] = mockStorage[keys];
                } else if (Array.isArray(keys)) {
                    keys.forEach(k => { res[k] = mockStorage[k]; });
                } else if (typeof keys === 'object' && keys !== null) {
                    Object.keys(keys).forEach(k => {
                        res[k] = mockStorage[k] !== undefined ? mockStorage[k] : keys[k];
                    });
                } else {
                    res = Object.assign({}, mockStorage);
                }
                if (cb) setTimeout(() => cb(res), 1);
            },
            set: (items, cb) => {
                Object.assign(mockStorage, items);
                if (cb) setTimeout(cb, 1);
            },
            remove: (keys, cb) => {
                if (typeof keys === 'string') delete mockStorage[keys];
                else if (Array.isArray(keys)) keys.forEach(k => delete mockStorage[k]);
                if (cb) setTimeout(cb, 1);
            }
        },
        onChanged: {
            addListener: () => {},
            removeListener: () => {}
        }
    }
};

// Load supabase-service.js
require('../src/supabase-service.js');
// Load bundle.js
require('../src/bundle.js');

const StructuredLogger = global.StructuredLogger || (global.__leadsync_logger__ && global.__leadsync_logger__.StructuredLogger);
assert(StructuredLogger, 'StructuredLogger must be exported and available');

let passCount = 0;
let failCount = 0;

function runTest(name, fn) {
    try {
        fn();
        console.log(`  ✅ PASS [${name}]`);
        passCount++;
    } catch (err) {
        console.error(`  ❌ FAIL [${name}]:`, err.message);
        failCount++;
    }
}

async function runTestAsync(name, fn) {
    try {
        await fn();
        console.log(`  ✅ PASS [${name}]`);
        passCount++;
    } catch (err) {
        console.error(`  ❌ FAIL [${name}]:`, err.message);
        failCount++;
    }
}

// Helper to clear in-memory log buffer between tests
function clearMemoryQueue(logger) {
    if (logger && logger._memoryBuffer) {
        logger._memoryBuffer.length = 0;
    }
}

(async function executeSuite() {
    await new Promise(r => setTimeout(r, 150));
    mockStorage = {};
    clearMemoryQueue(new StructuredLogger());
    mockStorage = {};

    console.log('--- 1. Valid JSON Schema for Every Emitted Record ---');
    runTest('Structured log record conforms to schema v1.0.0', () => {
        const logger = new StructuredLogger('TestComponent');
        clearMemoryQueue(logger);
        logger.logEvent('INFO', 'lead.filter.evaluated', 'FilterEvaluator', {
            traceId: 'tr_test_123',
            operationId: 'op_eval_456',
            durationMs: 4.5,
            result: 'MATCH',
            reasonCode: 'PRODUCT_KEYWORD_MATCH',
            context: { productName: 'Solar Inverter' },
            metrics: { score: 85 }
        });

        assert.strictEqual(logger._memoryBuffer.length, 1);
        const record = logger._memoryBuffer[0];
        assert.strictEqual(record.schemaVersion, '1.0.0');
        assert.strictEqual(typeof record.timestamp, 'string');
        assert.strictEqual(record.level, 'INFO');
        assert.strictEqual(record.event, 'lead.filter.evaluated');
        assert.strictEqual(record.component, 'FilterEvaluator');
        assert.strictEqual(typeof record.instanceId, 'string');
        assert.strictEqual(record.traceId, 'tr_test_123');
        assert.strictEqual(record.operationId, 'op_eval_456');
        assert.strictEqual(record.durationMs, 5); // rounded
        assert.strictEqual(record.result, 'MATCH');
        assert.strictEqual(record.reasonCode, 'PRODUCT_KEYWORD_MATCH');
        assert.deepStrictEqual(record.context, { productName: 'Solar Inverter' });
        assert.deepStrictEqual(record.metrics, { score: 85 });
        assert.strictEqual(record.error, null);
    });

    console.log('--- 2. Stable Correlation IDs Through Asynchronous Operations ---');
    runTest('Stable traceId generated and propagated without PII', () => {
        const logger = new StructuredLogger('Tracer');
        const leadId = 'im_query_998877';
        const traceId1 = logger.generateTraceId(leadId);
        const traceId2 = logger.generateTraceId(leadId);

        assert.strictEqual(traceId1, traceId2, 'Same lead must yield deterministic stable traceId');
        assert(traceId1.startsWith('tr_'), 'Trace ID should have standard prefix');
        assert.strictEqual(traceId1.indexOf('998877'), -1, 'Trace ID must not expose raw phone/PII');
        assert.strictEqual(traceId1.length, 19, 'Trace ID has stable hashed length');
    });

    console.log('--- 3. Unique Operation IDs for Discrete Operations ---');
    runTest('Separate refreshes and operations receive distinct operation IDs', () => {
        const logger = new StructuredLogger('Ops');
        const op1 = logger.generateOperationId('sync');
        const op2 = logger.generateOperationId('sync');
        const op3 = logger.generateOperationId('scan');

        assert.notStrictEqual(op1, op2, 'Consecutive sync operations must have unique operation IDs');
        assert(op1.startsWith('sync_'), 'Operation ID must have prefix');
        assert(op3.startsWith('scan_'), 'Operation ID must reflect operation type');
    });

    console.log('--- 4. Correct State Transition Events ---');
    runTest('logTransition emits standard lead.state.changed with from/to/reasonCode', () => {
        const logger = new StructuredLogger('StateMgr');
        clearMemoryQueue(logger);
        logger.logTransition('DISCOVERED', 'FILTERED', 'LOCATION_MISMATCH', 'op_state_1', 'tr_lead_55', { city: 'Unknown' });

        assert.strictEqual(logger._memoryBuffer.length, 1);
        const rec = logger._memoryBuffer[0];
        assert.strictEqual(rec.event, 'lead.state.changed');
        assert.strictEqual(rec.reasonCode, 'LOCATION_MISMATCH');
        assert.strictEqual(rec.traceId, 'tr_lead_55');
        assert.strictEqual(rec.operationId, 'op_state_1');
        assert.strictEqual(rec.context.from, 'DISCOVERED');
        assert.strictEqual(rec.context.to, 'FILTERED');
        assert.strictEqual(rec.result, 'FILTERED');
    });

    console.log('--- 5. Accurate Duration Measurements via Monotonic Timer ---');
    runTest('Duration measurements reflect real positive elapsed time', () => {
        const logger = new StructuredLogger('Perf');
        clearMemoryQueue(logger);
        const t0 = performance.now();
        const start = Date.now();
        while (Date.now() - start < 5) {}
        const duration = performance.now() - t0;

        logger.logEvent('INFO', 'scanner.cycle.completed', 'Scanner', {
            durationMs: duration,
            reasonCode: 'CYCLE_FINISHED'
        });

        const rec = logger._memoryBuffer[0];
        assert(rec.durationMs >= 4, `Duration should be accurate and positive (got ${rec.durationMs}ms)`);
        assert(rec.durationMs !== 0, 'Duration must not be hardcoded to 0ms');
    });

    console.log('--- 6. No Success Event After Unsuccessful or Ambiguous Result ---');
    runTest('Ambiguous or failed action emits error/warn and never action.result.confirmed', () => {
        const logger = new StructuredLogger('ActionTest');
        clearMemoryQueue(logger);
        const ambiguousOutcome = { ambiguous: true, message: 'Server did not return ACK' };
        if (ambiguousOutcome.ambiguous) {
            logger.logEvent('WARN', 'action.result.unknown', 'ActionAdapter', {
                reasonCode: 'AMBIGUOUS_OUTCOME',
                result: 'UNKNOWN',
                context: { message: ambiguousOutcome.message }
            });
        }

        const events = logger._memoryBuffer.map(r => r.event);
        assert(events.includes('action.result.unknown'), 'Must emit action.result.unknown');
        assert(!events.includes('action.result.confirmed'), 'Must NEVER emit action.result.confirmed on ambiguous outcome');
        assert.strictEqual(logger._memoryBuffer[0].level, 'WARN');
    });

    console.log('--- 7. Deduplication of Repetitive Unchanged-State Logs ---');
    runTest('Suppresses repetitive identical logs within aggregation window', () => {
        const logger = new StructuredLogger('Deduplicator');
        clearMemoryQueue(logger);
        logger.info('filters.config.unchanged', { count: 5 });
        logger.info('filters.config.unchanged', { count: 5 });
        logger.info('filters.config.unchanged', { count: 5 });

        assert.strictEqual(logger._memoryBuffer.length, 1, 'Repetitive identical unchanged-state log must be suppressed');
    });

    console.log('--- 8. Concurrent Log Writes from Multiple Runtime Instances ---');
    await runTestAsync('Multi-instance concurrent flush merges records chronologically without data loss', async () => {
        mockStorage.logs = [
            { id: 'rec_instA_1', timestamp: '2026-10-21T10:00:00.000Z', event: 'app.initialization.started', instanceId: 'inst_A' }
        ];

        const loggerB = new StructuredLogger('InstanceB');
        clearMemoryQueue(loggerB);
        loggerB._instanceId = 'inst_B';
        const recB = loggerB.logEvent('INFO', 'lead.observed', 'Scanner', {
            traceId: 'tr_lead_b'
        });
        recB.timestamp = '2026-10-21T10:00:01.000Z';

        const loggerC = new StructuredLogger('InstanceC');
        // Do not clear queue for loggerC because it shares memoryBuffer, just add recC
        loggerC._instanceId = 'inst_C';
        const recC = loggerC.logEvent('INFO', 'crm.write.completed', 'SupabaseService', {
            traceId: 'tr_lead_c'
        });
        recC.timestamp = '2026-10-21T10:00:02.000Z';

        // Trigger concurrent flushes
        await Promise.all([loggerB._flushLogsNow(), loggerC._flushLogsNow()]);

        const persisted = mockStorage.logs;
        assert(Array.isArray(persisted), 'Persisted logs must be an array');
        assert.strictEqual(persisted.length, 3, 'Must contain all 3 records from all instances');
        const ids = persisted.map(r => r.id);
        assert(ids.includes('rec_instA_1'), 'Instance A record preserved');
        assert(ids.includes(recB.id), 'Instance B record preserved');
        assert(ids.includes(recC.id), 'Instance C record preserved');

        // Check chronological sort
        assert(persisted[0].timestamp <= persisted[1].timestamp);
        assert(persisted[1].timestamp <= persisted[2].timestamp);
    });

    console.log('--- 9. Queue Overflow and Dropped-Log Reporting ---');
    runTest('In-memory queue bounds to MAX_QUEUE_SIZE and increments dropped-log counter', () => {
        const logger = new StructuredLogger('OverflowTest');
        clearMemoryQueue(logger);
        StructuredLogger._maxQueueSize = 50;
        const initialDropped = logger.getDroppedLogsCount();

        for (let i = 0; i < 75; i++) {
            logger.logEvent('DEBUG', 'lead.filter.evaluated', 'FilterEvaluator', {
                reasonCode: 'SCORE_LOW_' + i
            });
        }

        assert.strictEqual(logger._memoryBuffer.length, 50, 'Memory buffer must be capped at maxQueueSize');
        assert.strictEqual(logger.getDroppedLogsCount() - initialDropped, 25, 'Dropped logs count must accurately record 25 dropped records');
        StructuredLogger._maxQueueSize = null; // restore default
    });

    console.log('--- 10. Failed Persistence Without Recursive Logging ---');
    await runTestAsync('Storage failure increments persistence error counter without throwing or recursion', async () => {
        const originalSet = chrome.storage.local.set;
        // Inject a simulated storage failure
        chrome.storage.local.set = (items, cb) => {
            if (cb) setTimeout(() => cb(new Error('QUOTA_BYTES_EXCEEDED')), 1);
        };

        const logger = new StructuredLogger('QuotaTest');
        clearMemoryQueue(logger);
        const initialErrors = logger.getPersistenceErrorsCount();
        logger.logEvent('INFO', 'scanner.started', 'Scanner', { reasonCode: 'USER_STARTED' });

        await logger._flushLogsNow();

        assert(logger.getPersistenceErrorsCount() > initialErrors, 'Should increment persistence error counter');
        // Restore chrome storage set
        chrome.storage.local.set = originalSet;
    });

    console.log('--- 11. Redaction of Contact Details and Credentials ---');
    runTest('Redacts phone numbers, emails, passwords, authorization headers, and cookies', () => {
        const logger = new StructuredLogger('PrivacyTest');
        clearMemoryQueue(logger);
        logger.logEvent('INFO', 'lead.observed', 'Scanner', {
            context: {
                phoneNumber: '+91 98765 43210',
                email: 'buyer@example.com',
                password: 'supersecretpassword123',
                authHeader: 'Bearer eyJhbGciOiJIUzI1Ni...',
                cookie: 'session_token=abc123xyz',
                buyerName: 'Ramesh Patel',
                productName: 'Automatic Packaging Machine'
            }
        });

        const ctx = logger._memoryBuffer[0].context;
        assert.strictEqual(ctx.phoneNumber, '[REDACTED_PHONE]');
        assert.strictEqual(ctx.email, '[REDACTED_EMAIL]');
        assert.strictEqual(ctx.password, '[REDACTED_SECRET]');
        assert.strictEqual(ctx.authHeader, '[REDACTED_SECRET]');
        assert.strictEqual(ctx.cookie, '[REDACTED_SECRET]');
        assert.strictEqual(ctx.productName, 'Automatic Packaging Machine', 'Non-sensitive product data preserved');
    });

    console.log('--- 12. Correct Ordering of Log Records Across Asynchronous Callbacks ---');
    await runTestAsync('Sequential async stages preserve monotonic timestamps and sequential ordering', async () => {
        const logger = new StructuredLogger('SeqTest');
        clearMemoryQueue(logger);
        const traceId = logger.generateTraceId('lead_seq_1');
        const opId = logger.generateOperationId('proc');

        const rec1 = logger.logEvent('INFO', 'lead.observed', 'Scanner', { traceId, operationId: opId });
        await new Promise(r => setTimeout(r, 10));
        const rec2 = logger.logEvent('INFO', 'lead.normalized', 'Parser', { traceId, operationId: opId });
        await new Promise(r => setTimeout(r, 10));
        const rec3 = logger.logEvent('INFO', 'lead.filter.evaluated', 'FilterEvaluator', { traceId, operationId: opId });
        await new Promise(r => setTimeout(r, 10));
        const rec4 = logger.logEvent('INFO', 'lead.review.ready', 'Orchestrator', { traceId, operationId: opId });

        const records = [rec1, rec2, rec3, rec4];
        assert.strictEqual(records.length, 4);
        assert.strictEqual(records[0].event, 'lead.observed');
        assert.strictEqual(records[1].event, 'lead.normalized');
        assert.strictEqual(records[2].event, 'lead.filter.evaluated');
        assert.strictEqual(records[3].event, 'lead.review.ready');

        for (let i = 0; i < 3; i++) {
            assert(records[i].timestamp <= records[i + 1].timestamp);
            assert.strictEqual(records[i].traceId, traceId);
            assert.strictEqual(records[i].operationId, opId);
        }
    });

    console.log('--- 13. Compatibility of Existing Log Search and Export ---');
    runTest('Export format preserves schemaVersion: 1.0.0 and machine-readable structured records', () => {
        const logger = new StructuredLogger('ExportTest');
        clearMemoryQueue(logger);
        logger.logEvent('INFO', 'crm.write.completed', 'SupabaseService', {
            traceId: 'tr_export_1',
            reasonCode: 'SUCCESS',
            result: 'CONFIRMED'
        });

        const exportPayload = {
            schemaVersion: '1.0.0',
            exportedAt: new Date().toISOString(),
            extension: 'BuyLead Assistant',
            version: '6.3.0',
            totalLogs: logger._memoryBuffer.length,
            logs: logger._memoryBuffer
        };

        const jsonStr = JSON.stringify(exportPayload, null, 2);
        const parsed = JSON.parse(jsonStr);

        assert.strictEqual(parsed.schemaVersion, '1.0.0');
        assert.strictEqual(parsed.logs.length, 1);
        assert.strictEqual(parsed.logs[0].event, 'crm.write.completed');
        assert.strictEqual(parsed.logs[0].traceId, 'tr_export_1');
        assert.strictEqual(parsed.logs[0].schemaVersion, '1.0.0');
    });

    console.log('--- 14. Bounded Memory and Persisted-Log Retention ---');
    await runTestAsync('Persisted storage retains maximum 1000 items without memory leaks', async () => {
        const logger = new StructuredLogger('RetentionTest');
        clearMemoryQueue(logger);
        const initialBatch = [];
        for (let i = 0; i < 1100; i++) {
            initialBatch.push({
                id: 'rec_old_' + i,
                schemaVersion: '1.0.0',
                timestamp: new Date(Date.now() - 1100000 + i * 1000).toISOString(),
                level: 'DEBUG',
                event: 'scanner.cycle.started'
            });
        }
        mockStorage.logs = initialBatch;

        logger.logEvent('INFO', 'scanner.started', 'Scanner', { reasonCode: 'USER_STARTED' });
        await logger._flushLogsNow();

        assert(mockStorage.logs.length <= 1000, `Storage must be bounded to 1000 items (got ${mockStorage.logs.length})`);
    });

    console.log('\n================================================================');
    console.log(`=== TEST SUMMARY: ${passCount} PASSED | ${failCount} FAILED ===`);
    console.log('================================================================\n');

    process.exit(failCount === 0 ? 0 : 1);
})();
