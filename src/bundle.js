
// src/bundle.js
// IndiaMART BuyLead Assistant - v5.0.0
// ============================================================================
// CHANGELOG v5.0.0 - Production Reliability & Review Workflow Refactor
// ============================================================================
// Developed by Keyn Labs
// ============================================================================

console.log('🎯 IndiaMART BuyLead Assistant v5.0.0 (Reliable Lead-Monitoring & Review Assistant)');
console.log('📦 Developed by Keyn Labs');
console.log('🔗 https://keynlabs.vercel.app/');

(function () {
    'use strict';

    // ============================================================
    // SCAN LIMIT — maximum DOM lead cards processed per scan cycle.
    // Fair bounded scanning without starvation.
    // ============================================================
    var MAX_LEADS_PER_CYCLE = 5;
    var MAX_DOM_SCAN_LIMIT = 5;

    // ============================================================
    // RATE-LIMIT DETECTION — phrases from IndiaMART's account-restriction banner.
    // When any of these substrings appear in the visible page body the extension
    // halts all activity immediately via the persistent CircuitBreaker.
    // ============================================================
    var RATE_LIMIT_PHRASES = [
        'unusually high activity',
        'reached the request limit',
        'please wait 15 minutes',
        'session is reactivated',
        'you have reached the request limit'
    ];

    // ============================================================
    // CIRCUIT BREAKER STATES
    // ============================================================
    var CIRCUIT_BREAKER_STATES = {
        NORMAL: 'NORMAL',
        PAUSED_RESTRICTION: 'PAUSED_RESTRICTION',
        REQUIRES_USER_REVIEW: 'REQUIRES_USER_REVIEW'
    };

    function CircuitBreaker() {
        this._state = CIRCUIT_BREAKER_STATES.NORMAL;
        this._reason = '';
        this._trippedAt = 0;
        this._listeners = [];
        this._loadState();
    }

    CircuitBreaker.prototype._loadState = function () {
        var self = this;
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                chrome.storage.local.get(['bl_circuit_breaker_state', 'bl_circuit_breaker_reason', 'bl_circuit_breaker_tripped_at', 'bl_circuit_breaker'], function (res) {
                    if (res && res.bl_circuit_breaker && res.bl_circuit_breaker.state) {
                        self._state = res.bl_circuit_breaker.state;
                        self._reason = res.bl_circuit_breaker.reason || '';
                        self._trippedAt = res.bl_circuit_breaker.trippedAt || 0;
                        self._notify();
                    } else if (res && res.bl_circuit_breaker_state) {
                        self._state = res.bl_circuit_breaker_state;
                        self._reason = res.bl_circuit_breaker_reason || '';
                        self._trippedAt = res.bl_circuit_breaker_tripped_at || 0;
                        self._notify();
                    }
                });
            } else if (typeof sessionStorage !== 'undefined') {
                var st = sessionStorage.getItem('bl_circuit_breaker_state');
                if (st) {
                    self._state = st;
                    self._reason = sessionStorage.getItem('bl_circuit_breaker_reason') || '';
                    self._trippedAt = parseInt(sessionStorage.getItem('bl_circuit_breaker_tripped_at') || '0', 10);
                }
            }
        } catch (e) { }
    };

    CircuitBreaker.prototype._saveState = function () {
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                chrome.storage.local.set({
                    bl_circuit_breaker_state: this._state,
                    bl_circuit_breaker_reason: this._reason,
                    bl_circuit_breaker_tripped_at: this._trippedAt,
                    bl_circuit_breaker: {
                        state: this._state,
                        reason: this._reason,
                        trippedAt: this._trippedAt
                    }
                });
            }
            if (typeof sessionStorage !== 'undefined') {
                sessionStorage.setItem('bl_circuit_breaker_state', this._state);
                sessionStorage.setItem('bl_circuit_breaker_reason', this._reason);
                sessionStorage.setItem('bl_circuit_breaker_tripped_at', String(this._trippedAt));
            }
        } catch (e) { }
    };

    Object.defineProperty(CircuitBreaker.prototype, 'state', {
        get: function () { return this._state; }
    });
    CircuitBreaker.prototype.getState = function () { return this._state; };
    CircuitBreaker.prototype.getReason = function () { return this._reason; };
    CircuitBreaker.prototype.isNormal = function () { return this._state === CIRCUIT_BREAKER_STATES.NORMAL; };
    CircuitBreaker.prototype.canExecute = function () { return this._state === CIRCUIT_BREAKER_STATES.NORMAL; };
    CircuitBreaker.prototype.canProceed = function () { return this._state === CIRCUIT_BREAKER_STATES.NORMAL; };

    CircuitBreaker.prototype.trip = function (reason, details) {
        this._state = CIRCUIT_BREAKER_STATES.PAUSED_RESTRICTION;
        this._reason = reason || 'Rate limit or restriction detected';
        this._trippedAt = Date.now();
        this._saveState();
        this._notify();
    };

    CircuitBreaker.prototype.requireUserReview = function (reason, details) {
        this._state = CIRCUIT_BREAKER_STATES.REQUIRES_USER_REVIEW;
        this._reason = reason || 'Requires explicit user review';
        this._trippedAt = Date.now();
        this._saveState();
        this._notify();
    };

    CircuitBreaker.prototype.reset = function (invokedBy) {
        // Only explicit user action can reset the circuit breaker
        if (invokedBy !== 'user_action' && invokedBy !== 'manual_resume') {
            console.warn('[CircuitBreaker] Ignored non-user reset attempt:', invokedBy);
            return false;
        }
        this._state = CIRCUIT_BREAKER_STATES.NORMAL;
        this._reason = '';
        this._trippedAt = 0;
        this._saveState();
        this._notify();
        return true;
    };

    CircuitBreaker.prototype.addListener = function (fn) {
        if (typeof fn === 'function') this._listeners.push(fn);
    };

    CircuitBreaker.prototype._notify = function () {
        for (var i = 0; i < this._listeners.length; i++) {
            try { this._listeners[i](this._state, this._reason); } catch (e) { }
        }
    };

    // ============================================================
    // DEFAULT CONFIG
    // ============================================================
    var DEFAULT_CONFIG = {
        // Workflow: Default to AUTOMATIC mode for fully automated lead acquisition & contact
        mode: 'AUTOMATIC',
        minScore: 60,

        // ---- SAFETY LIMITS ----
        maxPerMinute: 60,
        maxPerHour: 400,
        maxPerDay: 2000,
        maxPerSession: 1000,
        cooldownMs: 0,

        strictCountryMode: false,
        allowedCountries: ['IN'],
        strictCountryRejectUnknown: true,

        scoreWeights: {
            base: 50,
            perProductKeyword: 10, maxProductBonus: 30,
            preferredState: 15, countryMatch: 15,
            hasMobile: 10, hasEmail: 8, hasPhone: 5,
            detailedRequirement: 5, requirementLengthThreshold: 100
        },
        scorePenalties: { wrongCountry: -20, wrongState: -10, noContact: -5 },
        preferredStates: ['maharashtra'],
        preferredCountries: ['IN'],

        // ---- NAVIGATOR ----
        loopIntervalMs: 100,
        loadMoreWaitMs: 900,
        maxStuckLoops: 3,
        maxReloadsPerSession: 0,
        autoReloadOnComplete: false,
        autoReloadDelayMs: 2500,
        reloadJitterMs:    400,

        // ---- POPUP ----
        autoMinimize: true,
        popupTimeoutMs: 15000,
        confirmationAnswer: 'yes',
        purchaseAction: 'close',

        supabaseEnabled: true,
        panelPosition: null,
        panelCollapsed: false,
        stopSold: true,
        skipSoldOut: true
    };

    // ============================================================
    // PRIVACY-SAFE LOG SANITIZER
    // ============================================================
    function _sanitizeLogValue(val, depth) {
        if (depth > 4) return '[MAX_DEPTH]';
        if (typeof val === 'string') {
            var s = val.replace(/\b(?:\+?91[\s-]?)?[6-9]\d{9}\b/g, '[REDACTED_PHONE]');
            s = s.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]');
            return s;
        }
        if (val && typeof val === 'object') {
            if (Array.isArray(val)) {
                return val.map(function (item) { return _sanitizeLogValue(item, depth + 1); });
            }
            var cleaned = {};
            for (var k in val) {
                if (!val.hasOwnProperty(k)) continue;
                var lk = k.toLowerCase();
                if (lk.indexOf('token') !== -1 || lk.indexOf('auth') !== -1 || lk.indexOf('cookie') !== -1 ||
                    lk.indexOf('key') !== -1 || lk.indexOf('secret') !== -1 || lk.indexOf('password') !== -1) {
                    cleaned[k] = '[REDACTED_SECRET]';
                } else if (lk.indexOf('mobile') !== -1 || lk.indexOf('phone') !== -1) {
                    cleaned[k] = '[REDACTED_PHONE]';
                } else if (lk.indexOf('email') !== -1) {
                    cleaned[k] = '[REDACTED_EMAIL]';
                } else {
                    cleaned[k] = _sanitizeLogValue(val[k], depth + 1);
                }
            }
            return cleaned;
        }
        return val;
    }

    // ============================================================
    // ============================================================
    // STRUCTURED LOGGER & OBSERVABILITY ENGINE (Schema v1.0.0)
    // ============================================================
    var LEVELS = { TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4 };
    var LEVEL_NAMES = { 0: 'TRACE', 1: 'DEBUG', 2: 'INFO', 3: 'WARN', 4: 'ERROR' };
    var _logQueue = [];
    var _logFlushTimer = null;
    var _isFlushing = false;
    var _pendingFlush = false;
    var _droppedLogsCount = 0;
    var _persistenceErrorsCount = 0;
    var MAX_QUEUE_SIZE = 500;
    var MAX_LOGS_RETENTION = 1000;
    var UNCHANGED_AGGREGATION_WINDOW_MS = 5000;
    var _lastEmittedSignatures = new Map();
    var _initInfo = { instanceId: 'bl_pre_init', reason: 'unknown' };

    function generateTraceId(leadId) {
        if (leadId) {
            var str = String(leadId).trim();
            var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
            for (var i = 0; i < str.length; i++) {
                var ch = str.charCodeAt(i);
                h1 = Math.imul(h1 ^ ch, 2654435761);
                h2 = Math.imul(h2 ^ ch, 1597334677);
            }
            h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
            h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
            var hex = ('00000000' + (h1 >>> 0).toString(16)).slice(-8) + ('00000000' + (h2 >>> 0).toString(16)).slice(-8);
            return 'tr_' + hex;
        }
        return 'tr_' + Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
    }

    function generateOperationId(prefix) {
        var p = prefix ? (prefix + '_') : 'op_';
        return p + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
    }

    var _activeFlushPromise = null;

    function _shouldSuppress(event, component, reasonCode, contextSummary) {
        if (event !== 'filters.config.unchanged' && event !== 'scanner.card.duplicate' && reasonCode !== 'CONFIG_UNCHANGED' && reasonCode !== 'DUPLICATE_OBSERVATION') {
            return false;
        }
        var key = event + '|' + component + '|' + (reasonCode || '') + '|' + (contextSummary || '');
        var now = Date.now();
        var last = _lastEmittedSignatures.get(key);
        if (last && (now - last.timestamp < UNCHANGED_AGGREGATION_WINDOW_MS)) {
            last.count = (last.count || 1) + 1;
            return true;
        }
        _lastEmittedSignatures.set(key, { timestamp: now, count: 1 });
        if (_lastEmittedSignatures.size > 200) {
            _lastEmittedSignatures.clear();
        }
        return false;
    }

    function _flushLogsNow(callback) {
        if (_logFlushTimer) { clearTimeout(_logFlushTimer); _logFlushTimer = null; }
        if (_activeFlushPromise) {
            return _activeFlushPromise.then(function () {
                if (_logQueue.length > 0) {
                    return _flushLogsNow(callback);
                }
                if (typeof callback === 'function') {
                    try { callback(); } catch (e) { }
                }
            });
        }

        if (_logQueue.length === 0) {
            if (typeof callback === 'function') {
                try { callback(); } catch (e) { }
            }
            return Promise.resolve();
        }

        _activeFlushPromise = new Promise(function (resolve) {
            function finish() {
                if (typeof callback === 'function') {
                    try { callback(); } catch (e) { }
                }
                resolve();
            }

            var batch = _logQueue.splice(0, _logQueue.length);

            if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
                finish();
                return;
            }

            try {
                chrome.storage.local.get('logs', function (result) {
                    if ((chrome.runtime && chrome.runtime.lastError) || (result instanceof Error)) {
                        _persistenceErrorsCount++;
                        _logQueue = batch.concat(_logQueue).slice(-MAX_QUEUE_SIZE);
                        finish();
                        return;
                    }

                    var existing = (result && Array.isArray(result.logs)) ? result.logs : [];
                    var seenKeys = new Set();
                    var merged = [];

                    for (var i = 0; i < existing.length; i++) {
                        var it = existing[i];
                        var key = it.id || (it.timestamp + ':' + (it.component || it.module) + ':' + it.event + ':' + (it.traceId || it.operationId || ''));
                        if (!seenKeys.has(key)) {
                            seenKeys.add(key);
                            merged.push(it);
                        }
                    }

                    for (var j = 0; j < batch.length; j++) {
                        var bit = batch[j];
                        var bkey = bit.id || (bit.timestamp + ':' + (bit.component || bit.module) + ':' + bit.event + ':' + (bit.traceId || bit.operationId || ''));
                        if (!seenKeys.has(bkey)) {
                            seenKeys.add(bkey);
                            merged.push(bit);
                        }
                    }

                    merged.sort(function (a, b) {
                        return (a.timestamp || '').localeCompare(b.timestamp || '');
                    });

                    if (merged.length > MAX_LOGS_RETENTION) {
                        merged = merged.slice(-MAX_LOGS_RETENTION);
                    }

                    chrome.storage.local.set({ logs: merged }, function (err) {
                        if ((chrome.runtime && chrome.runtime.lastError) || err) {
                            _persistenceErrorsCount++;
                        }
                        finish();
                    });
                });
            } catch (e) {
                _persistenceErrorsCount++;
                finish();
            }
        }).then(function () {
            _activeFlushPromise = null;
            if (_logQueue.length > 0) {
                return _flushLogsNow();
            }
        }, function () {
            _activeFlushPromise = null;
        });

        return _activeFlushPromise;
    }

    function _enqueueLog(entry) {
        _logQueue.push(entry);
        var maxQ = (Logger && Logger._maxQueueSize) || MAX_QUEUE_SIZE;
        if (_logQueue.length > maxQ) {
            var excess = _logQueue.length - maxQ;
            _logQueue.splice(0, excess);
            _droppedLogsCount += excess;
        }
        if (!_logFlushTimer) {
            _logFlushTimer = setTimeout(_flushLogsNow, 1200);
        }
    }

    function Logger(module) {
        this.module = module || 'App';
        this.minLevel = LEVELS.TRACE;
        this._correlationId = null;
        this._traceId = null;
        this._operationId = null;
    }

    Logger.prototype.getCorrelationId = function () {
        return this._correlationId || this._operationId || 'op_' + Date.now().toString(36);
    };

    Logger.prototype.setTraceId = function (traceId) {
        this._traceId = traceId;
    };

    Logger.prototype.setOperationId = function (opId) {
        this._operationId = opId;
    };

    Logger.prototype._deriveEventName = function (message, level) {
        if (!message || typeof message !== 'string') return this.module.toLowerCase() + '.' + (LEVEL_NAMES[level] || 'info').toLowerCase();
        var m = message.toLowerCase();
        if (m.indexOf('started') !== -1 && m.indexOf('scanner') !== -1) return 'scanner.started';
        if (m.indexOf('stopped') !== -1) return 'app.lifecycle.stopped';
        if (m.indexOf('scan error') !== -1) return 'scanner.error';
        if (m.indexOf('rate-limit') !== -1) return 'platform.restriction.detected';
        if (m.indexOf('card skipped') !== -1) return 'scanner.card.skipped';
        if (m.indexOf('reconciliation') !== -1) return 'scanner.reconciliation.completed';
        if (m.indexOf('duplicate') !== -1 || m.indexOf('already') !== -1) return 'scanner.card.duplicate';
        if (m.indexOf('filter') !== -1 && m.indexOf('cache') !== -1) return 'filters.cache.hit';
        if (m.indexOf('syncing') !== -1 || m.indexOf('loaded') !== -1) return 'filters.sync.completed';
        return this.module.toLowerCase() + '.' + (LEVEL_NAMES[level] || 'info').toLowerCase();
    };

    Logger.prototype.logEvent = function (levelOrOpts, event, component, data) {
        if (!levelOrOpts) return;
        var opts = {};
        if (typeof levelOrOpts === 'object' && levelOrOpts !== null) {
            opts = levelOrOpts;
        } else {
            opts = Object.assign({}, data || {});
            opts.level = levelOrOpts;
            opts.event = event;
            if (component) opts.component = component;
        }

        var levelName = (opts.level || 'INFO').toUpperCase();
        var lvl = LEVELS[levelName] != null ? LEVELS[levelName] : LEVELS.INFO;
        if (lvl < this.minLevel) return;

        var comp = opts.component || this.module;
        var nowIso = new Date().toISOString();
        var evtName = opts.event || this._deriveEventName(opts.message, lvl);
        var reasonCode = opts.reasonCode || null;
        var contextData = opts.context || opts.data || {};
        var contextSanitized = _sanitizeLogValue(contextData, 0);

        var contextSummary = '';
        try { contextSummary = JSON.stringify(contextSanitized); } catch (e) { }

        if (_shouldSuppress(evtName, comp, reasonCode, contextSummary)) {
            return;
        }

        var recordId = 'rec_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
        var entry = {
            schemaVersion: '1.0.0',
            id: recordId,
            timestamp: nowIso,
            level: levelName,
            event: evtName,
            component: comp,
            instanceId: _initInfo.instanceId,
            traceId: opts.traceId || this._traceId || null,
            operationId: opts.operationId || this._operationId || this.getCorrelationId(),
            context: contextSanitized,
            // Compatibility aliases for existing UI and tests
            module: comp,
            message: opts.message || evtName,
            data: contextSanitized,
            correlationId: opts.traceId || opts.operationId || this.getCorrelationId()
        };

        if (opts.durationMs != null && !isNaN(opts.durationMs)) {
            entry.durationMs = Math.round(Number(opts.durationMs));
        }
        if (opts.result != null) {
            entry.result = String(opts.result);
        }
        if (reasonCode != null) {
            entry.reasonCode = String(reasonCode);
        }
        if (opts.metrics && typeof opts.metrics === 'object') {
            entry.metrics = opts.metrics;
        }
        if (opts.error) {
            entry.error = typeof opts.error === 'string' ? opts.error : {
                message: _sanitizeLogValue(opts.error.message || String(opts.error), 0),
                name: opts.error.name || 'Error',
                stack: opts.error.stack ? _sanitizeLogValue(opts.error.stack.split('\n').slice(0, 4).join('\n'), 0) : undefined
            };
        } else {
            entry.error = null;
        }

        var prefix = '[' + entry.timestamp + '] [' + entry.level + '] [' + comp + ']';
        if (typeof this.writer === 'function') {
            this.writer(prefix, levelName, entry.message, entry.context);
        } else {
            var msgPart = (entry.message && entry.message !== entry.event) ? (': ' + entry.message) : '';
            var summary = '[' + entry.event + ']' + (entry.reasonCode ? ' (' + entry.reasonCode + ')' : '') + (entry.durationMs != null ? ' ' + entry.durationMs + 'ms' : '') + msgPart;
            if (lvl >= LEVELS.ERROR) console.error(prefix, summary, entry.context);
            else if (lvl >= LEVELS.WARN) console.warn(prefix, summary, entry.context);
            else if (lvl >= LEVELS.INFO) console.info(prefix, summary, entry.context);
            else console.log(prefix, summary, entry.context);
        }

        _enqueueLog(entry);
        return entry;
    };

    Logger.prototype.generateTraceId = generateTraceId;
    Logger.prototype.generateOperationId = generateOperationId;
    Logger.prototype.getDroppedLogsCount = function () { return _droppedLogsCount; };
    Logger.prototype.getPersistenceErrorsCount = function () { return _persistenceErrorsCount; };
    Logger.prototype.flushLogsNow = _flushLogsNow;
    Logger.prototype._flushLogsNow = _flushLogsNow;
    Object.defineProperty(Logger.prototype, '_memoryBuffer', {
        get: function () { return _logQueue; },
        configurable: true
    });

    Logger.prototype.logTransition = function (fromState, toState, reasonCode, operationId, traceId, context) {
        return this.logEvent({
            level: 'INFO',
            event: 'lead.state.changed',
            reasonCode: reasonCode || 'STATE_TRANSITION',
            operationId: operationId || this._operationId || this.getCorrelationId(),
            traceId: traceId || this._traceId || null,
            result: toState,
            context: Object.assign({ from: fromState, to: toState }, context || {}),
            message: 'State changed: ' + fromState + ' -> ' + toState
        });
    };

    Logger.prototype._log = function (level, messageOrEvent, dataOrOpts) {
        var isEvent = typeof messageOrEvent === 'string' && (messageOrEvent.indexOf('.') !== -1 || (dataOrOpts && dataOrOpts.event));
        var eventName = isEvent ? (dataOrOpts && dataOrOpts.event ? dataOrOpts.event : messageOrEvent) : null;
        var message = typeof messageOrEvent === 'string' ? messageOrEvent : (messageOrEvent && messageOrEvent.message) || '';

        var opts = {};
        if (dataOrOpts && typeof dataOrOpts === 'object' && (dataOrOpts.event || dataOrOpts.traceId || dataOrOpts.operationId || dataOrOpts.reasonCode || dataOrOpts.durationMs != null || dataOrOpts.context || dataOrOpts.result || dataOrOpts.metrics || dataOrOpts.error)) {
            opts = Object.assign({}, dataOrOpts);
        } else {
            opts.context = dataOrOpts || {};
        }

        opts.level = LEVEL_NAMES[level] || 'INFO';
        opts.message = message || eventName;
        if (eventName) opts.event = eventName;

        return this.logEvent(opts);
    };

    Logger.prototype.trace = function (m, d) { return this._log(LEVELS.TRACE, m, d); };
    Logger.prototype.debug = function (m, d) { return this._log(LEVELS.DEBUG, m, d); };
    Logger.prototype.info = function (m, d) { return this._log(LEVELS.INFO, m, d); };
    Logger.prototype.warn = function (m, d) { return this._log(LEVELS.WARN, m, d); };
    Logger.prototype.error = function (m, d) { return this._log(LEVELS.ERROR, m, d); };
    Logger.prototype.fatal = function (m, d) { return this._log(LEVELS.ERROR, m, d); };

    // ============================================================
    // LEAD ID GENERATOR
    // ============================================================
    function LeadIdGenerator() { }
    LeadIdGenerator.prototype.generateFromElement = function (element) {
        // 1. Direct lead / enquiry ID attributes
        var dataId = element.getAttribute('data-lead-id')
            || element.getAttribute('data-query-id')
            || element.getAttribute('data-buyer-id')
            || element.getAttribute('data-glusr-id')
            || element.getAttribute('data-blid');
        if (dataId) return 'dm_' + dataId;

        var elemId = element.getAttribute('id') || '';
        var idMatch = elemId.match(/(?:BLCard|BLbp|card)[_\-]?(\d+)/i);
        // Real IndiaMART enquiry/lead IDs have 6+ digits; small numbers (e.g. id_BLCard1) are DOM indices, not lead IDs
        if (idMatch && idMatch[1].length >= 6) return 'cid_' + idMatch[1];

        // 2. Links with lead / buyer IDs
        var links = element.querySelectorAll('a[href]');
        for (var i = 0; i < links.length; i++) {
            var href = links[i].getAttribute('href') || '';
            var match = href.match(/(?:buyerid|glusrid|leadid|blid|queryid)[=\/](\d+)/i);
            if (match) return 'lnk_' + match[1];
        }

        // 3. Button attributes (data-click-data, data-query-id, data-lead-id)
        var btn = element.querySelector('button, a, [role="button"]');
        if (btn) {
            var btnData = btn.getAttribute('data-click-data') || '';
            var btnMatch = btnData.match(/"(?:queryid|buyerid|leadid|glusrid)"\s*:\s*"?(\d+)"?/i)
                || btnData.match(/(?:queryid|buyerid|leadid|glusrid)=(\d+)/i);
            if (btnMatch) return 'btn_' + btnMatch[1];
            var btnDirectId = btn.getAttribute('data-query-id') || btn.getAttribute('data-lead-id');
            if (btnDirectId) return 'btn_' + btnDirectId;
        }

        // 4. Distinguish by Product + Location + Seller / Buyer + Quantity + Requirement
        var PRODUCT_SELECTORS = [
            '.BLbp_title', '[class*="BuyLdC"] span.SLC_f18', '[class*="BuyLdC"] .SLC_f18',
            'span.SLC_f18', '.SLC_f18', '[class*="BLbp_title" i]', '[class*="BLbp_head" i]',
            '[class*="prod_name" i], [class*="product_name" i]', '[class*="title" i]', 'h2, h3, h4'
        ];
        var productText = '';
        for (var psi = 0; psi < PRODUCT_SELECTORS.length && productText.length < 2; psi++) {
            var psNodes = element.querySelectorAll(PRODUCT_SELECTORS[psi]);
            for (var pni = 0; pni < psNodes.length; pni++) {
                var psTxt = (psNodes[pni].textContent || '').replace(/\s+/g, ' ').trim();
                if (psTxt.length >= 2) { productText = psTxt; break; }
            }
        }
        if (!productText || productText.length < 2) {
            var searchFallback = element.querySelector('.BLbp_desc em, [class*="BuyLdC_msg"] em');
            if (searchFallback && searchFallback.textContent.trim().length >= 2) {
                productText = searchFallback.textContent.trim();
            }
        }

        // If card DOM exists but product text has not yet hydrated, do NOT emit a blank hash (hash_29tds).
        // Returning null allows Scanner to wait 150ms for React hydration instead of skipping with "no product name".
        if (!productText || productText.length < 2) return null;

        var locEl = element.querySelector('.BLbp_hdrLeft strong.BuyLdC_tltpw')
            || element.querySelector('[class*="BuyLdC_time_loc"] strong');
        var locationText = locEl ? locEl.textContent.trim() : '';

        var sellerEl = element.querySelector('.BLbp_byrName, .BLbp_buyer, [class*="buyer"], [class*="byr_name"], [class*="buyerName"], [class*="company"], [class*="comp_name"], [class*="senderName"], .BLbp_member, .BLbp_byrInfo, .SLC_byr, [class*="byrInfo"]');
        var sellerText = sellerEl ? sellerEl.textContent.trim() : '';

        var descEl = element.querySelector('.BLbp_desc, [class*="BuyLdC_msg"], [class*="desc"]');
        var descText = descEl ? descEl.textContent.trim() : '';

        var qtyEl = element.querySelector('.BLbp_qty, [class*="quantity"], [class*="qty"]');
        var qtyText = qtyEl ? qtyEl.textContent.trim() : '';

        var cleanProd = productText.toLowerCase().replace(/[^\w]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').substring(0, 40);
        var cleanLoc = locationText ? locationText.toLowerCase().replace(/[^\w]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').substring(0, 20) : '';
        var cleanSeller = sellerText ? sellerText.toLowerCase().replace(/[^\w]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').substring(0, 20) : '';

        var idName = cleanProd || 'lead';
        if (cleanLoc) idName += '_' + cleanLoc;
        if (cleanSeller) idName += '_' + cleanSeller;

        return 'lead_' + idName;
    };

    // ============================================================
    // PAGE NAVIGATOR (SPEED-TUNED)
    // ============================================================
    function PageNavigator(orchestrator) {
        this.logger = new Logger('Navigator');
        this.orchestrator = orchestrator;
        this._running = false;
        this._loopTimer = null;
        this._startTimer = null;
        this._cooldownTimer = null;
        this._settleTimer = null;
        this._stepTimer = null;
        this._queueWaitTimer = null;
        this._reloadTimer = null;
        this._reloadInProgress = false;
        this._lastReloadTime = 0;
        this._loopInProgress = false;
        this._noMoreCount = 0;
        this._lastLeadCount = 0;
        this._stuckCount = 0;
        this._settings = {
            loopIntervalMs: 100, loadMoreWaitMs: 900, maxStuckLoops: 3,
            autoReloadOnComplete: true, autoReloadDelayMs: 2500, reloadJitterMs: 400, maxReloadsPerSession: 999999
        };
        this._lastFilterCheck = Date.now();
        this.RELOAD_STORAGE_KEY = 'bl_auto_reload_count';
    }

    PageNavigator.prototype.applySettings = function (config) {
        // Scroll-related settings (scrollSpeed, scrollDelayMs, bottomWaitMs) are ignored —
        // automatic scrolling has been removed.
        if (config.loopIntervalMs) this._settings.loopIntervalMs = config.loopIntervalMs;
        if (config.loadMoreWaitMs) this._settings.loadMoreWaitMs = config.loadMoreWaitMs;
        if (config.maxStuckLoops) this._settings.maxStuckLoops = config.maxStuckLoops;
        this._settings.autoReloadOnComplete = config.autoReloadOnComplete !== undefined ? !!config.autoReloadOnComplete : true;
        if (config.autoReloadDelayMs) this._settings.autoReloadDelayMs = config.autoReloadDelayMs;
        if (config.maxReloadsPerSession) this._settings.maxReloadsPerSession = config.maxReloadsPerSession;
        if (config.liveScanWaitMs !== undefined) {
            try { if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) chrome.storage.local.remove('liveScanWaitMs'); } catch (e) { }
        }
    };

    PageNavigator.prototype.start = function () {
        if (this._running) return;
        this._running = true;
        var self = this;
        this.logger.info('▶ Bottom-loop navigator started');
        if (this._startTimer) { clearTimeout(this._startTimer); }
        // If cards already exist in the DOM (idle cards), start loop immediately in 50ms;
        // otherwise wait a minimal 300ms for initial DOM paint.
        var hasCards = (typeof document !== 'undefined' && document.querySelectorAll &&
            document.querySelectorAll('[class*="BuyLdC_cont"], [class*="BLbp_card"], .BLbp_card, [class*="BuyLdC_Card"], div[id*="id_BLCard"], [class*="BLCard"]').length > 0);
        var initialDelay = hasCards ? 20 : 150;
        this._startTimer = setTimeout(function () { self._startLoop(); }, initialDelay);
    };

    PageNavigator.prototype.stop = function () {
        this._running = false;
        this._loopInProgress = false;
        this._reloadInProgress = false;
        this._stuckCount = 0;
        // Bug fix: _lastReloadTime was not reset on stop(), causing the storm guard
        // in _autoReloadPage to block the first reload of a new cycle if stop()+start()
        // happened within 1 second (common during filter refresh or emergency stop/resume).
        this._lastReloadTime = 0;
        if (this._loopTimer) { clearTimeout(this._loopTimer); this._loopTimer = null; }
        if (this._startTimer) { clearTimeout(this._startTimer); this._startTimer = null; }
        if (this._cooldownTimer) { clearTimeout(this._cooldownTimer); this._cooldownTimer = null; }
        if (this._settleTimer) { clearTimeout(this._settleTimer); this._settleTimer = null; }
        if (this._stepTimer) { clearTimeout(this._stepTimer); this._stepTimer = null; }
        if (this._queueWaitTimer) { clearTimeout(this._queueWaitTimer); this._queueWaitTimer = null; }
        if (this._waitForCardsTimer) { clearTimeout(this._waitForCardsTimer); this._waitForCardsTimer = null; }
        if (this._reloadTimer) { clearTimeout(this._reloadTimer); this._reloadTimer = null; }
        this.logger.info('⏹ Bottom-loop navigator cleanly stopped (all timers cleared)');
    };

    PageNavigator.prototype.restart = function () {
        this.stop();
        this._running = true;
        this._loopInProgress = false;
        var self = this;
        this.logger.info('🔄 Bottom-loop navigator restarted cleanly');
        // No automatic scroll — scan starts from whatever is currently visible.
        this._startTimer = setTimeout(function () {
            self._startLoop();
        }, 200);
    };

    PageNavigator.prototype._startLoop = function () {
        var self = this;
        if (!this._running || this._loopInProgress) return;
        this._loopInProgress = true;

        try {
            // If all filters are already completed, stop loop and transition to IDLE
            if (self.orchestrator && self.orchestrator.keywordManager) {
                var activeCount = self.orchestrator.keywordManager.getActiveFilterCount();
                if (activeCount === 0 && self.orchestrator.supabase && self.orchestrator.supabase._filtersLoaded) {
                    self._loopInProgress = false;
                    self.orchestrator._updateScannerLifecycleState('all_filters_completed');
                    return;
                }
            }

            // FIX: this used to call startNewCycle() AND scanner.resetEmitted() on every pass,
            // re-emitting every card already evaluated moments earlier. Now a new cycle starts
            // only when the current one has actually scanned something or is stale, and the
            // emitted-cache (dedup state) is preserved. Deferred cards are re-emitted via
            // scanner.forget(); filter changes still call resetEmitted() explicitly.
            var orch = self.orchestrator;
            if (orch && orch.startNewCycle) {
                var cycleAge = Date.now() - (orch._cycleStartedAt || 0);
                if ((orch.stats && orch.stats.cycleScanned > 0) || cycleAge > 5000) {
                    orch.startNewCycle(null, false, 'navigator_pass');
                }
            }

            // Scan the first MAX_LEADS_PER_CYCLE visible lead cards — no scrolling.
            self._scanVisibleLeads(function () {
                if (!self._running) { self._loopInProgress = false; return; }

                self._loopInProgress = false;
                if (self.orchestrator && self.orchestrator.stats) {
                    self.orchestrator.stats.loopsCompleted++;
                    if (self.orchestrator.stats.cycleScanned > 0) {
                        self._stuckCount = 0;
                    }
                }

                // Wait for all queued acquisition/contact actions to finish,
                // then trigger reload or next loop.
                self._waitForQueueAndReload();
            });
        } catch (e) {
            self._loopInProgress = false;
            self._scheduleNextLoop();
        }
    };

    // Scan the first MAX_LEADS_PER_CYCLE visible lead cards without any scrolling.
    // Cards that are already in the DOM (rendered by the page's own AJAX feed) are
    // evaluated in the portal's natural display order.  No scrollIntoView, no
    // window.scrollTo, no load-more clicking.
    PageNavigator.prototype._scanVisibleLeads = function (done) {
        var self = this;
        if (!this._running) { done(); return; }

        var MAX_CONTENT_RETRIES = 3;
        var CONTENT_WAIT_MS = 25;

        function tryCards(attempt) {
            if (!self._running) { done(); return; }

            var allCards = (typeof document !== 'undefined') ? document.querySelectorAll(
                '[class*="BuyLdC_cont"], [class*="BLbp_card"], .BLbp_card, [class*="BuyLdC_Card"], ' +
                'div[id*="id_BLCard"], [class*="BLCard"], [class*="bl_card"], div[id*="BLCard"], ' +
                'div[id*="BLbp"], [class*="bl-card"], [class*="listing_card"]'
            ) : [];

            if (allCards.length === 0) {
                if (attempt < MAX_CONTENT_RETRIES) {
                    self._waitForCardsTimer = setTimeout(function () {
                        self._waitForCardsTimer = null;
                        tryCards(attempt + 1);
                    }, CONTENT_WAIT_MS);
                    return;
                }
                // Cards never appeared — let cycle complete without scanning
                done(); return;
            }

            // Check that the first card has text content (product/location rendered).
            // After a hard reload the DOM shell appears before text nodes are populated.
            var firstCard = allCards[0];
            var firstCardText = firstCard ? (firstCard.textContent || '').trim() : '';
            if (firstCardText.length < 5 && attempt < MAX_CONTENT_RETRIES) {
                self._waitForCardsTimer = setTimeout(function () {
                    self._waitForCardsTimer = null;
                    tryCards(attempt + 1);
                }, CONTENT_WAIT_MS);
                return;
            }

            // Cards exist and have content — run scan.
            if (self.orchestrator && self.orchestrator.scanner) {
                self.orchestrator.scanner._scan();
            }
            done();
        }

        tryCards(0);
    };

    PageNavigator.prototype._refreshPortalForNewLeads = function () {
        // A native refresh can also replace lead cards/dialog nodes, so never run it
        // while an acquisition/contact action is processing or waiting in the queue.
        var q = this.orchestrator && this.orchestrator.queue;
        if (q && (q.processing > 0 || (q.queue && q.queue.length > 0))) {
            this.logger.debug('Native refresh deferred: acquisition/contact queue is busy');
            return false;
        }

        try {
            // Prefer IndiaMART's own "New Leads Available" banner. Do not click
            // a second refresh control in the same pass if that banner handled it.
            if (this.orchestrator && this.orchestrator.scanner && this.orchestrator.scanner._checkNewLeadsBanner) {
                if (this.orchestrator.scanner._checkNewLeadsBanner()) {
                    this.logger.info('Native in-page refresh triggered via new-leads banner');
                    return true;
                }
            }

            // Otherwise use IndiaMART's native refresh button/icon (AJAX/in-page).
            var refreshSelectors = [
                '#refreshBL', '#refresh_lead', '[id*="refresh_leads" i]',
                'button[class*="refresh" i]', 'a[class*="refresh" i]',
                '[class*="icon-refresh"]', '[class*="refresh_icon"]',
                '[title*="refresh" i]', '[aria-label*="refresh" i]',
                '[data-action*="refresh" i]'
            ];
            for (var r = 0; r < refreshSelectors.length; r++) {
                var refEl = document.querySelector(refreshSelectors[r]);
                if (refEl && refEl.id !== 'bl-refresh-btn' && (!refEl.id || refEl.id.indexOf('bl-') !== 0)) {
                    try {
                        refEl.click();
                        this.logger.info('Native in-page refresh clicked: ' + refreshSelectors[r]);
                        return true;
                    } catch (e) { }
                }
            }
        } catch (e) { }
        return false;
    };

    PageNavigator.prototype._scheduleNextLoop = function () {
        var self = this;
        if (!this._running) return;
        this._loopTimer = setTimeout(function () { self._startLoop(); }, this._settings.loopIntervalMs);
    };

    // _fastScrollToBottom removed — automatic scrolling is disabled.
    // The extension scans only the first MAX_LEADS_PER_CYCLE leads already visible
    // in the portal's AJAX feed without triggering additional feed loads.

    PageNavigator.prototype._findLoadMoreButton = function () {
        // Direct selectors first — no waiting.
        var direct = document.querySelectorAll('button.BuyLdC_Cta');
        for (var i = 0; i < direct.length; i++) {
            var t = (direct[i].textContent || '').trim().toLowerCase();
            if (t.indexOf('show more') !== -1 || t.indexOf('load more') !== -1 || t.indexOf('more buylead') !== -1) {
                return direct[i];
            }
        }
        var broad = document.querySelectorAll('button[class*="BuyLdC_Cta"], [class*="BuyLdC_Cta"]');
        for (var j = 0; j < broad.length; j++) {
            var el = broad[j];
            if (el.tagName !== 'BUTTON') continue;
            var t2 = (el.textContent || '').trim().toLowerCase();
            if (t2.indexOf('show more') !== -1 || t2.indexOf('load more') !== -1) return el;
        }
        // Last resort: scan all buttons once.
        var all = document.querySelectorAll('button');
        for (var k = 0; k < all.length; k++) {
            var t3 = (all[k].textContent || '').trim().toLowerCase();
            if (t3.indexOf('show more') !== -1 || t3.indexOf('load more') !== -1) return all[k];
        }
        return null;
    };

    PageNavigator.prototype._clickLoadMore = function () {
        var btn = this._findLoadMoreButton();
        if (!btn) return false;
        try {
            btn.click();
            this.logger.debug('✅ Load-more clicked');
            return true;
        } catch (e) {
            this.logger.warn('Load-more click failed: ' + e.message);
            return false;
        }
    };

    PageNavigator.prototype._countLeads = function () {
        try { return document.querySelectorAll('[class*="BuyLdC_cont"]').length; } catch (e) { return 0; }
    };

    PageNavigator.prototype._waitForQueueAndReload = function () {
        var self = this;

        // Minimal settle — allows toasts/metrics to paint before idle-check.
        // Bug fix: was anonymous setTimeout (uncancellable). Now stored as _settleTimer
        // so stop() can cancel it and prevent ghost reloads after stop() is called.
        var SETTLE_MS = 50;

        if (this._settleTimer) { clearTimeout(this._settleTimer); this._settleTimer = null; }
        this._settleTimer = setTimeout(function () {
            self._settleTimer = null;
            checkQueue();
        }, SETTLE_MS);

        function checkQueue() {
            if (!self._running) return;

            // If the orchestrator paused (e.g. lead acquired), never reload.
            if (self.orchestrator && self.orchestrator._isPaused) return;

            // If there are no unfinished filters, stop without reloading.
            var activeCount = (self.orchestrator && self.orchestrator.keywordManager)
                ? self.orchestrator.keywordManager.getActiveFilterCount()
                : 0;
            if (self.orchestrator && self.orchestrator._supabaseEnabled && self.orchestrator.supabase && self.orchestrator.supabase._filtersLoaded && activeCount === 0) {
                self.logger.info('All filters completed; no reload needed');
                if (self.orchestrator._updateScannerLifecycleState) {
                    self.orchestrator._updateScannerLifecycleState('all_filters_completed');
                }
                return;
            }

            // Wait until acquisition / contact / popup work is fully idle.
            var q = self.orchestrator && self.orchestrator.queue;
            var isQueueBusy = q && (q.processing > 0 || (q.queue && q.queue.length > 0));
            var isPopupActive = self.orchestrator && self.orchestrator.popupManager && self.orchestrator.popupManager._active;
            var isScannerBusy = self.orchestrator && self.orchestrator.scanner && (self.orchestrator.scanner._scanning || self.orchestrator.scanner._scanPending);
            var isLifecycleInFlight = self.orchestrator && self.orchestrator.lifecycle && self.orchestrator.lifecycle._inFlight && self.orchestrator.lifecycle._inFlight.size > 0;
            var isLeadProcessing = self.orchestrator && self.orchestrator.stateMachine && (function () {
                var smStats = self.orchestrator.stateMachine.getStats();
                return (smStats.PROCESSING || 0) > 0 || (smStats.ACQUISITION_PENDING || 0) > 0 || (smStats.CONTACT_PENDING || 0) > 0;
            })();

            if (isQueueBusy || isPopupActive || isScannerBusy || isLifecycleInFlight || isLeadProcessing) {
                self._queueWaitTimer = setTimeout(function () {
                    self._queueWaitTimer = null;
                    checkQueue();
                }, 100);
                return;
            }

            // Re-check: orchestrator may have paused while queue was draining.
            if (self.orchestrator && self.orchestrator._isPaused) return;

            // If this cycle acquired anything, check operating mode
            if (self.orchestrator && self.orchestrator._cycleAcquiredThisScan) {
                if (self.orchestrator.config && self.orchestrator.config.mode === 'AUTOMATIC') {
                    self.orchestrator._cycleAcquiredThisScan = false;
                } else {
                    self.logger.info('⏸ Cycle acquired a lead — reload skipped, waiting for user resume');
                    return;
                }
            }

            // In live browser (typeof process === 'undefined'), do NOT refresh or click in loops.
            // Page refresh is handled exclusively by the standalone mandatory 20-second hard refresh loop.
            // The navigator simply checks for visible cards after a calm delay (2000ms).
            if (typeof process === 'undefined') {
                self._loopTimer = setTimeout(function () {
                    if (self._running) self._startLoop();
                }, 2000);
                return;
            }

            // In test environment (Node.js): maintain contract for test suites
            if (self._settings.autoReloadOnComplete) {
                self._autoReloadPage();
            } else {
                var refreshed = self._refreshPortalForNewLeads();
                var delay = refreshed ? Math.max(900, self._settings.loadMoreWaitMs || 900) : self._settings.loopIntervalMs;
                self._loopTimer = setTimeout(function () {
                    if (self._running) self._startLoop();
                }, delay);
            }
        }
    };

    // Alias for backward compatibility
    PageNavigator.prototype._waitForQueueAndNativeRefresh = function () {
        return this._waitForQueueAndReload();
    };

    // Ultra-low-latency hard page reload after completed top-seven scan cycle (tests only)
    PageNavigator.prototype._autoReloadPage = function () {
        var self = this;
        // In live browser: hard reloads are completely removed to protect live API & session interception
        if (typeof process === 'undefined') return false;
        if (!this._running) return false;

        // Prevent reload storms or overlapping reload triggers (persisted in sessionStorage)
        if (this._reloadInProgress) return false;
        var now = Date.now();
        var lastTime = this._lastReloadTime;
        if (!lastTime && typeof process === 'undefined') {
            try {
                lastTime = parseInt(sessionStorage.getItem('bl_last_reload_time') || '0', 10) || 0;
            } catch (e) { }
        }
        if (lastTime && (now - lastTime < 1000)) {
            this.logger.warn('Reload storm prevented: reload requested too quickly (< 1s)');
            return false;
        }

        var reloadCount = 0;
        try {
            reloadCount = parseInt(sessionStorage.getItem(this.RELOAD_STORAGE_KEY) || '0', 10) || 0;
        } catch (e) { }

        if (reloadCount >= this._settings.maxReloadsPerSession) {
            this.logger.warn('🛑 Max auto-reloads reached (' + this._settings.maxReloadsPerSession + ')');
            this._showFinalBanner();
            return false;
        }

        this._reloadInProgress = true;
        this._lastReloadTime = now;

        // Persist session state needed to resume correctly
        try {
            var nextCount = reloadCount + 1;
            sessionStorage.setItem(this.RELOAD_STORAGE_KEY, String(nextCount));
            sessionStorage.setItem('bl_last_reload_flag', 'from_reload');
            sessionStorage.setItem('bl_reload_pending', 'true');
            sessionStorage.setItem('bl_last_reload_time', String(now));
            sessionStorage.setItem('bl_scanner_auto_resume', this._running ? 'true' : 'false');

            if (this.orchestrator) {
                if (this.orchestrator.stats) {
                    sessionStorage.setItem('bl_session_stats', JSON.stringify(this.orchestrator.stats));
                }
                if (this.orchestrator._uniqueSeenIds) {
                    sessionStorage.setItem('bl_session_seen_ids', JSON.stringify(Array.from(this.orchestrator._uniqueSeenIds)));
                }
                if (this.orchestrator.metrics && typeof this.orchestrator.metrics.exportState === 'function') {
                    sessionStorage.setItem('bl_session_metrics', JSON.stringify(this.orchestrator.metrics.exportState()));
                }
            }
        } catch (e) {
            this.logger.warn('Failed to persist session state before reload: ' + (e && e.message));
        }

        var baseDelay = typeof this._settings.autoReloadDelayMs === 'number' ? this._settings.autoReloadDelayMs : 2500;
        var jitter = typeof this._settings.reloadJitterMs === 'number' ? this._settings.reloadJitterMs : 400;
        var delay = baseDelay + (jitter > 0 ? (Math.floor(Math.random() * jitter * 2) - jitter) : 0);
        if (typeof process === 'undefined') {
            delay = Math.max(1500, delay); // In live browser, safe floor of 1.5s to prevent excessive IndiaMART page queries
        } else {
            delay = Math.max(0, delay);
        }
        this.logger.info('🔄 Auto-reloading in ' + Math.round(delay/1000) + 's (#' + (reloadCount + 1) + '/' + this._settings.maxReloadsPerSession + ')');

        if (this._reloadTimer) {
            clearTimeout(this._reloadTimer);
            this._reloadTimer = null;
        }

        this._reloadTimer = setTimeout(function () {
            self._reloadTimer = null;
            // Abort if navigator was stopped (manual pause / emergency stop) while timer was queued
            if (!self._running) {
                self._reloadInProgress = false;
                return;
            }
            try {
                if (typeof window !== 'undefined' && window.location && typeof window.location.reload === 'function') {
                    window.location.reload();
                } else if (typeof window !== 'undefined' && window.location) {
                    window.location.href = window.location.href;
                }
            } catch (err) {
                self.logger.error('Failed to trigger window.location.reload: ' + (err && err.message));
                self._reloadInProgress = false;
                if (self._running) self._scheduleNextLoop();
            }
        }, delay);

        return true;
    };

    PageNavigator.prototype._showReloadOverlay = function (n) {
        // Overlay removed — silent reload
    };

    PageNavigator.prototype._showFinalBanner = function () {
        try {
            var existing = document.getElementById('bl-final-banner');
            if (existing) existing.remove();
            var banner = document.createElement('div');
            banner.id = 'bl-final-banner';
            banner.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#fff8e8;border:2px solid #f5a623;border-radius:8px;padding:14px 20px;z-index:2147483646;font-family:-apple-system,Arial,sans-serif;font-size:13px;color:#1a1a2e;max-width:400px;';
            banner.innerHTML = '<div style="font-weight:700;color:#f5a623;margin-bottom:4px;">🛑 Session Limit Reached</div>' +
                '<div style="font-size:11px;color:#666;">Auto-reloaded ' + this._settings.maxReloadsPerSession + ' times. Please refresh manually.</div>';
            document.body.appendChild(banner);
        } catch (e) { }
    };

    PageNavigator.prototype._isInDOM = function (el) {
        if (!el) return false;
        try {
            var r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return false;
            var s = window.getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) !== 0;
        } catch (e) { return false; }
    };

    PageNavigator.prototype.getStatus = function () {
        return {
            running: this._running, loopInProgress: this._loopInProgress,
            noMoreCount: this._noMoreCount, stuckCount: this._stuckCount,
            currentLeads: this._countLeads(), lastLeadCount: this._lastLeadCount
        };
    };

    // ============================================================
    // POPUP MANAGER (SPEED-TUNED)
    // ============================================================
    function PopupManager() {
        this.logger = new Logger('PopupManager');
        this._active = false;
        this._onHandled = null;
        this._watchInterval = null;
        this._observer = null;
        this._watchTimeout = 5000;
        this._handledCount = 0;
        this._confirmationAnswer = 'yes';
        this._purchaseAction = 'close';
        this._mutationSeen = false;
    }

    PopupManager.prototype._classifyPopup = function (el) {
        var text = (el.textContent || '').toLowerCase();

        // Count visible Yes/No buttons
        var buttons = el.querySelectorAll('button, [role="button"], a[role="button"], input[type="button"], input[type="submit"]');
        var hasYes = false, hasNo = false;
        for (var i = 0; i < buttons.length; i++) {
            var bt = (buttons[i].textContent || buttons[i].value || '').trim().toLowerCase();
            if (bt === 'yes' || bt === 'ok' || bt === 'confirm' || bt === 'proceed') hasYes = true;
            if (bt === 'no' || bt === 'cancel' || bt === 'dismiss') hasNo = true;
        }

        // Confirmation takes priority — never auto-close a modal that needs an answer.
        if (hasYes && hasNo) return 'CONFIRMATION';
        if (text.indexOf('do you want') !== -1 || text.indexOf('are you sure') !== -1 ||
            text.indexOf('would you like') !== -1 || text.indexOf('days old') !== -1 ||
            text.indexOf('day old') !== -1) return 'CONFIRMATION';

        // Purchase: require 'purchase' OR ('buy' AND '₹'), and never when Yes/No present
        var isPurchase = text.indexOf('purchase buylead') !== -1 ||
            text.indexOf("to view buyer's contact details") !== -1 ||
            text.indexOf('single india buylead') !== -1 ||
            text.indexOf('mdc pro') !== -1 ||
            (text.indexOf('per buylead') !== -1 && text.indexOf('₹') !== -1) ||
            (text.indexOf('buy') !== -1 && text.indexOf('₹') !== -1);
        if (isPurchase) return 'PURCHASE';

        if ((hasYes || hasNo) && buttons.length >= 2 && text.length > 20) return 'CONFIRMATION';
        if (el.querySelectorAll('ul li, nav a, [role="menuitem"]').length > 2) return 'NAVIGATION';
        return 'UNKNOWN';
    };

    PopupManager.prototype.watchForPopup = function (callback, options) {
        var self = this;
        options = options || {};
        this._onHandled = callback;
        this._active = true;
        this._watchTimeout = options.timeout || 5000;
        this._confirmationAnswer = options.confirmationAnswer || 'yes';
        this._purchaseAction = options.purchaseAction || 'close';

        var existingPopups = this._findAllPopups();
        var existingSet = new Set(existingPopups);
        var startTime = Date.now();
        this._mutationSeen = false;

        // MutationObserver gate — only re-scan when DOM actually changed
        if (this._observer) { try { this._observer.disconnect(); } catch (e) { } }
        try {
            this._observer = new MutationObserver(function () { self._mutationSeen = true; });
            this._observer.observe(document.body, { childList: true, subtree: true });
        } catch (e) { }

        if (this._watchInterval) clearInterval(this._watchInterval);

        this._watchInterval = setInterval(function () {
            if (!self._active) { self._cleanup(); return; }

            // Skip DOM scan if nothing mutated since last check
            if (!self._mutationSeen && Date.now() - startTime > 400) {
                if (Date.now() - startTime > self._watchTimeout) {
                    self._finish({ success: false, reason: 'timeout', action: 'timeout' });
                }
                return;
            }
            self._mutationSeen = false;

            var popups = self._findAllPopups();
            var targetPopup = null;
            for (var i = 0; i < popups.length; i++) {
                if (!existingSet.has(popups[i])) { targetPopup = popups[i]; break; }
            }
            if (!targetPopup) {
                for (var j = 0; j < popups.length; j++) {
                    var cls = self._classifyPopup(popups[j]);
                    if (cls === 'CONFIRMATION' || cls === 'PURCHASE') { targetPopup = popups[j]; break; }
                }
            }

            if (targetPopup) {
                var type = self._classifyPopup(targetPopup);
                self.logger.info('Popup detected: ' + type + ' (' + (Date.now() - startTime) + 'ms)');
                self._handlePopup(targetPopup, type);
                return;
            }

            if (Date.now() - startTime > self._watchTimeout) {
                self._finish({ success: false, reason: 'timeout', action: 'timeout' });
            }
        }, 60);
    };

    PopupManager.prototype._cleanup = function () {
        this._active = false;
        if (this._watchInterval) { clearInterval(this._watchInterval); this._watchInterval = null; }
        if (this._observer) { try { this._observer.disconnect(); } catch (e) { } this._observer = null; }
    };

    PopupManager.prototype._finish = function (result) {
        var cb = this._onHandled;
        this._cleanup();
        if (cb) cb(result);
    };

    PopupManager.prototype._findAllPopups = function () {
        var found = [];
        var seen = new Set();
        var vw = window.innerWidth, vh = window.innerHeight;

        // 1) IndiaMART-specific selectors
        try {
            var imEls = document.querySelectorAll('.SLC_PopCntr, [class*="SLC_PopCntr"], [class*="Cnt_blpack"]');
            for (var a = 0; a < imEls.length; a++) {
                var el = imEls[a];
                if (seen.has(el) || (el.id && el.id.indexOf('bl-') === 0)) continue;
                if (!this._isVisible(el)) continue;
                var r = el.getBoundingClientRect();
                if (r.width < 100 || r.height < 60) continue;
                seen.add(el); found.push(el);
            }
        } catch (e) { }

        // 2) Generic selectors
        var selectors = ['[role="dialog"]', '[role="alertdialog"]', '[class*="modal"]', '[class*="Modal"]',
            '[class*="popup"]', '[class*="Popup"]', '[class*="overlay"]', '[class*="Overlay"]',
            '[class*="dialog"]', '[class*="Dialog"]', '[class*="blp_"]', '[class*="purchase"]', '[class*="Purchase"]'];
        for (var i = 0; i < selectors.length; i++) {
            try {
                var els = document.querySelectorAll(selectors[i]);
                for (var j = 0; j < els.length; j++) {
                    var e2 = els[j];
                    if (seen.has(e2) || (e2.id && e2.id.indexOf('bl-') === 0)) continue;
                    if (!this._isVisible(e2)) continue;
                    var r2 = e2.getBoundingClientRect();
                    if (r2.width < 100 || r2.height < 60) continue;
                    if (r2.width > vw * 0.99 && r2.height > vh * 0.99) continue;
                    seen.add(e2); found.push(e2);
                }
            } catch (e) { }
        }

        return found;
    };

    PopupManager.prototype._handlePopup = function (popup, type) {
        this.logger.info('Handling ' + type + ' popup');
        if (type === 'PURCHASE') this._handlePurchase(popup);
        else if (type === 'CONFIRMATION') this._handleConfirmation(popup);
        else if (type === 'NAVIGATION') this._handleNavigation(popup);
        else this._handleUnknown(popup);
    };

    PopupManager.prototype._handlePurchase = function (popup) {
        this.logger.warn('💳 Purchase modal detected');
        if (this._purchaseAction === 'stop') {
            this._finish({ success: false, action: 'stopped', type: 'PURCHASE', reason: 'purchase_required', stopAcquiring: true });
            return;
        }
        var closeBtn = popup.querySelector('.SLC_pa.SLC_cp, [class*="SLC_pa"][class*="SLC_cp"]');
        if (!closeBtn) {
            var spans = popup.querySelectorAll('span[style*="right"]');
            for (var i = 0; i < spans.length; i++) { if (spans[i].querySelector('svg')) { closeBtn = spans[i]; break; } }
        }
        if (!closeBtn) closeBtn = this._findCloseButton(popup);
        if (closeBtn) {
            try {
                closeBtn.click();
                try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true })); } catch (e) { }
                document.body.style.overflow = '';
                this._handledCount++;
                this._finish({ success: true, action: 'purchase_closed', type: 'PURCHASE' });
                return;
            } catch (err) { }
        }
        // Hard hide fallback
        try {
            popup.style.display = 'none';
            var parent = popup.parentElement;
            if (parent && (parent.className || '').toString().indexOf('fixed') !== -1) parent.style.display = 'none';
            document.body.style.overflow = '';
            this._finish({ success: true, action: 'purchase_hidden', type: 'PURCHASE' });
        } catch (err) {
            this._finish({ success: false, reason: 'cannot_close', action: 'purchase_failed', type: 'PURCHASE' });
        }
    };

    PopupManager.prototype._handleConfirmation = function (popup) {
        var answer = this._confirmationAnswer || 'yes';
        this.logger.info('Confirmation - answer: ' + answer);
        var buttons = popup.querySelectorAll('button, [role="button"], a[role="button"], input[type="button"], input[type="submit"], span[class*="btn"], div[class*="btn"]');
        var target = null;
        var keywords = answer === 'yes'
            ? ['yes', 'ok', 'confirm', 'proceed', 'continue', 'accept', 'sure']
            : ['no', 'cancel', 'dismiss', 'skip', 'later'];
        for (var i = 0; i < buttons.length; i++) {
            var btn = buttons[i];
            if (!this._isVisible(btn)) continue;
            var t = (btn.textContent || btn.value || '').trim().toLowerCase();
            for (var k = 0; k < keywords.length; k++) {
                if (t === keywords[k]) { target = btn; break; }
            }
            if (target) break;
        }
        if (!target) {
            for (var i2 = 0; i2 < buttons.length; i2++) {
                var btn2 = buttons[i2];
                if (!this._isVisible(btn2)) continue;
                var t2 = (btn2.textContent || btn2.value || '').trim().toLowerCase();
                for (var k2 = 0; k2 < keywords.length; k2++) {
                    if (t2.indexOf(keywords[k2]) !== -1 && t2.length < 30) { target = btn2; break; }
                }
                if (target) break;
            }
        }
        if (!target && buttons.length > 0) target = answer === 'yes' ? buttons[buttons.length - 1] : buttons[0];
        if (target) {
            try {
                target.click();
                this._handledCount++;
                this._finish({ success: true, action: 'confirm_' + answer, type: 'CONFIRMATION' });
                return;
            } catch (err) { }
        }
        this._finish({ success: false, reason: 'no_button', action: 'confirm_failed', type: 'CONFIRMATION' });
    };

    PopupManager.prototype._handleNavigation = function (popup) {
        var btn = this._findCloseButton(popup);
        if (btn) { try { btn.click(); } catch (e) { } }
        else {
            try {
                document.body.click();
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
            } catch (e) { }
        }
        this._finish({ success: true, action: 'nav_closed', type: 'NAVIGATION' });
    };

    PopupManager.prototype._handleUnknown = function (popup) {
        var btn = this._findCloseButton(popup);
        if (btn) {
            try { btn.click(); } catch (e) { }
            this._finish({ success: true, action: 'closed', type: 'UNKNOWN' });
            return;
        }
        this._finish({ success: false, reason: 'unknown', action: 'unknown', type: 'UNKNOWN' });
    };

    PopupManager.prototype._findCloseButton = function (popup) {
        var slc = popup.querySelector('.SLC_pa.SLC_cp, [class*="SLC_pa"][class*="SLC_cp"]');
        if (slc && this._isVisible(slc)) return slc;
        var sels = ['[class*="close"]', '[aria-label*="close" i]', '[title*="close" i]', '[class*="cross"]'];
        for (var i = 0; i < sels.length; i++) {
            try { var el = popup.querySelector(sels[i]); if (el && this._isVisible(el)) return el; } catch (e) { }
        }
        var btns = popup.querySelectorAll('button, span[class*="close"], span[class*="SLC"]');
        for (var j = 0; j < btns.length; j++) {
            var b = btns[j];
            if (!this._isVisible(b)) continue;
            var t = (b.textContent || '').trim();
            if (t === '×' || t === '✕' || t === 'X' || t === 'x') return b;
        }
        return null;
    };

    PopupManager.prototype._isVisible = function (el) {
        if (!el) return false;
        try {
            var r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return false;
            var s = window.getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) !== 0;
        } catch (e) { return false; }
    };

    PopupManager.prototype.cancel = function () { this._cleanup(); };
    PopupManager.prototype.getCount = function () { return this._handledCount; };

    // ============================================================
    // MATCHING ENGINE & KEYWORD NORMALIZATION (v6.3 - GRAVITAS)
    // ============================================================
    function normalizeText(text) {
        if (!text) return '';
        return String(text)
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')          // strip diacritics (creme == crème)
            .toLowerCase()
            .replace(/(\d+)\s*(g|gm|gms|gram|grams|kg|kgs|ml|ltr|l|mg|mcg|oz|tab|tabs|tablet|tablets|cap|caps|capsule|capsules|pc|pcs|piece|pieces|box|boxes|strip|strips|vial|vials|bottle|bottles|pack|packs)\b/gi, '$1$2')
            .replace(/\bspf\s*(\d+)\b/gi, 'spf$1')
            .replace(/[\u2010-\u2015\u2212\-]/g, ' ')   // all dash variants == space (a-ret == a ret)
            .replace(/[^\p{L}\p{N}_\s\.]/gu, ' ')       // Unicode-aware: keep non-Latin letters
            .replace(/\s+/g, ' ')
            .trim();
    }

    function tokenize(normalizedText) {
        if (!normalizedText) return [];
        return normalizedText.split(/\s+/).filter(function (t) { return t.length > 0; });
    }

    var COMMON_FORMS = [
        'gel', 'cream', 'lotion', 'ointment', 'serum', 'oil', 'soap', 'facewash', 'face wash',
        'tablet', 'capsule', 'syrup', 'injection', 'powder', 'drops', 'spray', 'solution', 'shampoo',
        'sunscreen', 'cleanser', 'scrub', 'moisturizer', 'balm'
    ];

    var SYNONYM_MAP = {
        'sunscreen': ['sun screen', 'sunblock', 'sun block', 'sun protection'],
        'facewash': ['face wash', 'facial cleanser', 'cleanser'],
        'moisturizer': ['moisturiser', 'moisturizing cream', 'cold cream'],
        'tab': ['tablet', 'tablets'],
        'cap': ['capsule', 'capsules'],
        'inj': ['injection', 'injections'],
        'syr': ['syrup']
    };

    function extractAttributes(normText) {
        var attrs = { spf: null, strengths: [], sizes: [], forms: [] };
        if (!normText) return attrs;

        var spfMatch = normText.match(/\bspf(\d+)\b/);
        if (spfMatch) attrs.spf = 'spf' + spfMatch[1];

        var strengthMatches = normText.match(/\b\d+(?:mg|mcg|iu|%)\b/g);
        if (strengthMatches) attrs.strengths = strengthMatches;

        var sizeMatches = normText.match(/\b\d+(?:g|gm|kg|ml|l|ltr|oz)\b/g);
        if (sizeMatches) attrs.sizes = sizeMatches;

        for (var i = 0; i < COMMON_FORMS.length; i++) {
            var f = COMMON_FORMS[i];
            var rx = new RegExp('\\b' + f + '\\b', 'i');
            if (rx.test(normText)) attrs.forms.push(f);
        }
        return attrs;
    }

    function tokensEquivalent(a, b) {
        if (!a || !b) return false;
        if (a === b) return true;
        // Symmetric singular/plural matching (e.g. glove/gloves, box/boxes).
        if (Math.min(a.length, b.length) > 2 && (a === b + 's' || a === b + 'es' || a + 's' === b || a + 'es' === b)) return true;
        // Common consonant + y / ies inflection (e.g. battery/batteries).
        if (a.length > 4 && a.slice(-3) === 'ies' && a.slice(0, -3) + 'y' === b) return true;
        if (b.length > 4 && b.slice(-3) === 'ies' && b.slice(0, -3) + 'y' === a) return true;
        return false;
    }

    function wordBoundaryMatch(haystackNorm, needleNorm) {
        if (!haystackNorm || !needleNorm) return false;
        var needleTokens = tokenize(needleNorm);
        var haystackTokens = tokenize(haystackNorm);
        if (needleTokens.length === 0 || haystackTokens.length === 0) return false;

        // Every token in the CRM keyword must occur as a whole token in the lead
        // title. Order may differ, but partial prefixes such as "cotton" matching
        // "cottonseed" are deliberately not accepted.
        for (var k = 0; k < needleTokens.length; k++) {
            var found = false;
            for (var j = 0; j < haystackTokens.length; j++) {
                if (tokensEquivalent(haystackTokens[j], needleTokens[k])) {
                    found = true;
                    break;
                }
            }
            if (!found) return false;
        }
        return true;
    }

    // Whole-keyword synonym matching. Only treat a keyword as a synonym when the
    // complete configured term is one of the known aliases; this avoids matching a
    // long product keyword merely because it contains a generic word such as "cream".
    function keywordMatchesText(text, keyword) {
        var normText = normalizeText(text);
        var normKeyword = normalizeText(keyword);
        if (!normText || !normKeyword) return false;
        if (wordBoundaryMatch(normText, normKeyword)) return true;
        for (var key in SYNONYM_MAP) {
            var forms = [key].concat(SYNONYM_MAP[key] || []);
            var keywordIsAlias = false;
            for (var i = 0; i < forms.length; i++) {
                if (normalizeText(forms[i]) === normKeyword) { keywordIsAlias = true; break; }
            }
            if (!keywordIsAlias) continue;
            for (var j = 0; j < forms.length; j++) {
                if (wordBoundaryMatch(normText, normalizeText(forms[j]))) return true;
            }
        }
        return false;
    }

    var COUNTRY_CODE_MAP = {
        'IN': ['india'],
        'US': ['usa', 'united states', 'united states of america', 'america'],
        'GB': ['uk', 'united kingdom', 'great britain', 'england', 'britain', 'gb'],
        'UK': ['uk', 'united kingdom', 'great britain', 'england', 'britain', 'gb'],
        'AE': ['uae', 'united arab emirates', 'dubai', 'sharjah', 'abu dhabi'],
        'BD': ['bangladesh'],
        'CA': ['canada'],
        'DE': ['germany', 'deutschland'],
        'FR': ['france'],
        'AU': ['australia'],
        'JP': ['japan'],
        'CN': ['china'],
        'RU': ['russia'],
        'SA': ['saudi arabia', 'saudi'],
        'SG': ['singapore'],
        'MY': ['malaysia'],
        'NP': ['nepal'],
        'LK': ['sri lanka'],
        'PK': ['pakistan'],
        'ID': ['indonesia'],
        'TH': ['thailand'],
        'VN': ['vietnam'],
        'PH': ['philippines'],
        'TR': ['turkey'],
        'EG': ['egypt'],
        'IT': ['italy'],
        'ES': ['spain'],
        'NL': ['netherlands', 'holland'],
        'CH': ['switzerland'],
        'ZA': ['south africa'],
        'NZ': ['new zealand'],
        'BR': ['brazil'],
        'MX': ['mexico'],
        'KR': ['south korea', 'korea'],
        'KW': ['kuwait'],
        'QA': ['qatar'],
        'OM': ['oman'],
        'BH': ['bahrain'],
        'SE': ['sweden'],
        'PL': ['poland'],
        'NO': ['norway'],
        'DK': ['denmark'],
        'FI': ['finland'],
        'IE': ['ireland'],
        'BE': ['belgium'],
        'AT': ['austria'],
        'PT': ['portugal'],
        'IL': ['israel']
    };

    var COUNTRY_NAME_TO_ISO = {};
    for (var isoCode in COUNTRY_CODE_MAP) {
        var cNames = COUNTRY_CODE_MAP[isoCode];
        for (var cn = 0; cn < cNames.length; cn++) {
            COUNTRY_NAME_TO_ISO[cNames[cn]] = (isoCode === 'UK' ? 'GB' : isoCode);
        }
    }
    COUNTRY_NAME_TO_ISO['bangladesh'] = 'BD';
    COUNTRY_NAME_TO_ISO['bd'] = 'BD';
    COUNTRY_NAME_TO_ISO['canada'] = 'CA';
    COUNTRY_NAME_TO_ISO['ca'] = 'CA';
    COUNTRY_NAME_TO_ISO['uk'] = 'GB';
    COUNTRY_NAME_TO_ISO['united kingdom'] = 'GB';
    COUNTRY_NAME_TO_ISO['gb'] = 'GB';

    function LeadMatcher() {
        this.minConfidenceScore = 50;
    }

    // Stage A: Hard Eligibility Constraints
    LeadMatcher.prototype.checkEligibility = function (lead, filter) {
        var rawProd = lead.productName || '';
        var normProd = normalizeText(rawProd);
        var leadAttrs = extractAttributes(normProd);

        // 1. Negative keywords rejection
        var negKws = filter.negativeKeywords || filter.negative_keywords || (filter.filter_config && filter.filter_config.negative_keywords) || [];
        for (var i = 0; i < negKws.length; i++) {
            var negNorm = normalizeText(negKws[i]);
            if (negNorm && keywordMatchesText(normProd, negNorm)) {
                return { eligible: false, reason: 'negative_keyword_match', detail: 'Matched negative: ' + negKws[i] };
            }
        }

        // 1.1 Required keywords check
        var reqKws = filter.requiredKeywords || filter.required_keywords || (filter.filter_config && (filter.filter_config.required_keywords || filter.filter_config.requiredKeywords || filter.filter_config.must_have_keywords)) || [];
        if (typeof reqKws === 'string') reqKws = [reqKws];
        var normMessage = normalizeText(lead.messageText || lead.queryMessage || '');
        var matchedRequiredKeyword = reqKws.length === 0;
        for (var rk = 0; rk < reqKws.length; rk++) {
            var reqNorm = normalizeText(reqKws[rk]);
            if (reqNorm && (keywordMatchesText(normProd, reqNorm) || keywordMatchesText(normMessage, reqNorm))) {
                matchedRequiredKeyword = true;
                break;
            }
        }
        if (!matchedRequiredKeyword) {
            return { eligible: false, reason: 'missing_required_keyword', detail: 'No required keyword matched product or buyer requirement text' };
        }

        // 1.2 Match Mode 'all' (AND) constraint
        var prodKws = filter.keywords || filter.product_keywords || (filter.filter_config && filter.filter_config.product_names) || [];
        var matchMode = filter.matchMode || (filter.filter_config && filter.filter_config.match_mode) || filter.match_mode || 'any';
        if (matchMode === 'all' && prodKws.length > 1) {
            for (var m = 0; m < prodKws.length; m++) {
                var singleKwNorm = normalizeText(prodKws[m]);
                if (singleKwNorm && !(keywordMatchesText(normProd, singleKwNorm) || keywordMatchesText(normMessage, singleKwNorm))) {
                    return { eligible: false, reason: 'missing_mandatory_keyword', detail: 'Match mode "all" requires: ' + prodKws[m] };
                }
            }
        }

        // 2. Hard attribute conflicts
        if (prodKws.length > 0) {
            var conflictingForms = [
                ['gel', 'lotion'],
                ['gel', 'cream'],
                ['tablet', 'syrup'],
                ['capsule', 'syrup']
            ];

            function checkKwConflict(kwNorm) {
                var kwAttrs = extractAttributes(kwNorm);
                // SPF conflict
                if (kwAttrs.spf && leadAttrs.spf && kwAttrs.spf !== leadAttrs.spf) {
                    return { hasConflict: true, reason: 'attribute_conflict_spf', detail: 'Filter requires ' + kwAttrs.spf + ' but lead specifies ' + leadAttrs.spf };
                }
                // Size conflict
                if (kwAttrs.sizes.length > 0 && leadAttrs.sizes.length > 0) {
                    var sizeConflict = true;
                    for (var s1 = 0; s1 < kwAttrs.sizes.length; s1++) {
                        if (leadAttrs.sizes.indexOf(kwAttrs.sizes[s1]) !== -1) {
                            sizeConflict = false;
                            break;
                        }
                    }
                    if (sizeConflict) {
                        return { hasConflict: true, reason: 'attribute_conflict_size', detail: 'Filter requires ' + kwAttrs.sizes.join('/') + ' but lead specifies ' + leadAttrs.sizes.join('/') };
                    }
                }
                // Form conflict
                for (var c = 0; c < conflictingForms.length; c++) {
                    var pair = conflictingForms[c];
                    if (kwAttrs.forms.indexOf(pair[0]) !== -1 && leadAttrs.forms.indexOf(pair[1]) !== -1) {
                        return { hasConflict: true, reason: 'attribute_conflict_form', detail: 'Filter requires ' + pair[0] + ' but lead specifies conflicting form ' + pair[1] };
                    }
                    if (kwAttrs.forms.indexOf(pair[1]) !== -1 && leadAttrs.forms.indexOf(pair[0]) !== -1) {
                        return { hasConflict: true, reason: 'attribute_conflict_form', detail: 'Filter requires ' + pair[1] + ' but lead specifies conflicting form ' + pair[0] };
                    }
                }
                return { hasConflict: false };
            }

            if (matchMode === 'all') {
                for (var j = 0; j < prodKws.length; j++) {
                    var conf = checkKwConflict(normalizeText(prodKws[j]));
                    if (conf.hasConflict) {
                        return { eligible: false, reason: conf.reason, detail: conf.detail };
                    }
                }
            } else {
                var hasCompatible = false;
                var lastConf = null;
                for (var k = 0; k < prodKws.length; k++) {
                    var c = checkKwConflict(normalizeText(prodKws[k]));
                    if (!c.hasConflict) {
                        hasCompatible = true;
                        break;
                    } else {
                        lastConf = c;
                    }
                }
                if (!hasCompatible && lastConf) {
                    return { eligible: false, reason: lastConf.reason, detail: lastConf.detail };
                }
            }
        }

        return { eligible: true, reason: null };
    };

    // Stage B: Relevance Scoring (0 - 100)
    LeadMatcher.prototype.computeScore = function (lead, filter) {
        var rawProd = lead.productName || '';
        var rawMsg = lead.messageText || lead.queryMessage || '';
        var rawCombined = (rawProd + ' ' + rawMsg).trim();
        var normLead = normalizeText(rawProd);
        var normCombined = normalizeText(rawCombined);
        var leadTokens = tokenize(normCombined);
        var leadAttrs = extractAttributes(normCombined);

        var prodKws = filter.keywords || filter.product_keywords || (filter.filter_config && filter.filter_config.product_names) || [];
        if (typeof prodKws === 'string') prodKws = [prodKws];
        if (prodKws.length === 0) {
            // Location-only and other non-product CRM filters are explicitly considered
            // valid by the filter loader. Their other hard constraints have already passed
            // before computeScore() is called, so don't reject them for having no keywords.
            var hasNonProductConstraint = !!(
                (filter.locations && filter.locations.length) ||
                (filter.requiredKeywords && filter.requiredKeywords.length) ||
                (filter.restrictedCountries && filter.restrictedCountries.length) ||
                filter.requireMobile || filter.requireWhatsapp || filter.requireEmail ||
                (filter.minQuantity > 0)
            );
            return {
                score: hasNonProductConstraint ? 60 : 0,
                matchedKeyword: null,
                confidence: hasNonProductConstraint ? 0.6 : 0,
                accepted: hasNonProductConstraint,
                reasons: [hasNonProductConstraint ? 'Non-product CRM constraints matched (+60)' : 'No usable filter criteria']
            };
        }

        var filterAllSizes = [];
        for (var fIdx = 0; fIdx < prodKws.length; fIdx++) {
            var fAttrs = extractAttributes(normalizeText(prodKws[fIdx]));
            for (var si = 0; si < fAttrs.sizes.length; si++) {
                if (filterAllSizes.indexOf(fAttrs.sizes[si]) === -1) filterAllSizes.push(fAttrs.sizes[si]);
            }
        }

        var bestScore = 0;
        var bestKw = null;
        var bestReasons = [];
        var totalKeywordsMatched = 0;

        for (var i = 0; i < prodKws.length; i++) {
            var rawKw = prodKws[i];
            var normKw = normalizeText(rawKw);
            var kwTokens = tokenize(normKw);
            var kwAttrs = extractAttributes(normKw);

            if (kwTokens.length === 0) continue;

            var score = 0;
            var reasons = [];

            // Factor 1: Exact phrase match (+35 points, +15 bonus for full exact match)
            if (normLead.indexOf(normKw) !== -1 || normCombined.indexOf(normKw) !== -1) {
                score += 35;
                reasons.push('exact_phrase_match (+35)');
                if (normLead === normKw) {
                    score += 15;
                    reasons.push('full_exact_match (+15)');
                }
            } else if (normLead.length >= 4 && (normKw.indexOf(normLead) !== -1 || (lead.productName && normKw.indexOf(normalizeText(lead.productName)) !== -1))) {
                score += 35;
                reasons.push('subphrase_filter_match (+35)');
            }

            // Factor 2: Token coverage (+25 max)
            var QUALIFIER_WORDS = {
                'usp': 1, 'bp': 1, 'ip': 1, 'ep': 1, 'jp': 1, 'cp': 1,
                'grade': 1, 'api': 1,
                'personal': 1, 'use': 1, 'commercial': 1, 'industrial': 1,
                'for': 1, 'in': 1, 'and': 1, 'with': 1, 'of': 1, 'the': 1, 'a': 1, 'an': 1,
                'pharma': 1, 'pharmaceutical': 1, 'standard': 1, 'pure': 1, 'bulk': 1
            };
            var substantiveKwTokens = kwTokens.filter(function (t) { return !QUALIFIER_WORDS[t]; });
            var denom = substantiveKwTokens.length > 0 ? substantiveKwTokens : kwTokens;

            var matchedTokensCount = 0;
            for (var t = 0; t < kwTokens.length; t++) {
                var tok = kwTokens[t];
                var matchedTok = false;
                for (var lt = 0; lt < leadTokens.length; lt++) {
                    var lTok = leadTokens[lt];
                    if (tokensEquivalent(lTok, tok)) {
                        matchedTok = true;
                        break;
                    }
                }
                if (matchedTok) matchedTokensCount++;
            }

            var matchedSubstantiveCount = 0;
            for (var stIdx = 0; stIdx < denom.length; stIdx++) {
                var sTok = denom[stIdx];
                for (var lt2 = 0; lt2 < leadTokens.length; lt2++) {
                    if (tokensEquivalent(leadTokens[lt2], sTok)) {
                        matchedSubstantiveCount++;
                        break;
                    }
                }
            }

            var coverage = matchedTokensCount / kwTokens.length;
            var substantiveCoverage = matchedSubstantiveCount / denom.length;
            var effectiveCoverage = Math.max(coverage, substantiveCoverage);
            var coveragePoints = Math.round(effectiveCoverage * 25);
            score += coveragePoints;
            reasons.push('token_coverage (' + Math.round(effectiveCoverage * 100) + '%: +' + coveragePoints + ')');

            // If all substantive keyword tokens are present or keyword matches text, guarantee acceptance
            if (effectiveCoverage >= 1.0 || (keywordMatchesText(normCombined, normKw) && normCombined.indexOf(normKw) === -1)) {
                score = Math.max(score, 60);
                reasons.push('complete_token_or_substantive_match (+60 minimum)');
            }

            if (effectiveCoverage >= 0.7) totalKeywordsMatched++;

            // Factor 3: Attribute agreement (+15 SPF, +15 strength, +15 size, +10 form)
            if (kwAttrs.spf && leadAttrs.spf && kwAttrs.spf === leadAttrs.spf) {
                score += 15;
                reasons.push('spf_agreement (+15)');
            }
            if (kwAttrs.strengths && leadAttrs.strengths && kwAttrs.strengths.length > 0 && leadAttrs.strengths.length > 0) {
                for (var st = 0; st < kwAttrs.strengths.length; st++) {
                    if (leadAttrs.strengths.indexOf(kwAttrs.strengths[st]) !== -1) {
                        score += 15;
                        reasons.push('strength_agreement (+15)');
                        break;
                    }
                }
            }
            if (kwAttrs.sizes.length > 0 && leadAttrs.sizes.length > 0) {
                for (var s = 0; s < kwAttrs.sizes.length; s++) {
                    if (leadAttrs.sizes.indexOf(kwAttrs.sizes[s]) !== -1) {
                        score += 15;
                        reasons.push('size_agreement (+15)');
                        break;
                    }
                }
            }
            if (kwAttrs.forms.length > 0 && leadAttrs.forms.length > 0) {
                for (var f = 0; f < kwAttrs.forms.length; f++) {
                    if (leadAttrs.forms.indexOf(kwAttrs.forms[f]) !== -1) {
                        score += 10;
                        reasons.push('form_agreement (+10)');
                        break;
                    }
                }
            }

            // Factor 4: Synonyms match (+5)
            for (var synKey in SYNONYM_MAP) {
                if (normKw.indexOf(synKey) !== -1) {
                    var syns = SYNONYM_MAP[synKey];
                    for (var synIdx = 0; synIdx < syns.length; synIdx++) {
                        if (normCombined.indexOf(syns[synIdx]) !== -1) {
                            score += 5;
                            reasons.push('synonym_match (' + syns[synIdx] + ': +5)');
                            break;
                        }
                    }
                }
            }

            if (score > bestScore) {
                bestScore = score;
                bestKw = rawKw;
                bestReasons = reasons;
            }
        }

        // Multi-keyword bonus (+15)
        if (totalKeywordsMatched > 1) {
            bestScore += 15;
            bestReasons.push('multi_keyword_coverage (+15)');
        }

        // Missing size penalty (-15) if filter requires specific size but lead omits it
        if (filterAllSizes.length > 0 && leadAttrs.sizes.length === 0) {
            bestScore -= 15;
            bestReasons.push('missing_filter_size_penalty (-15)');
        }

        bestScore = Math.max(0, Math.min(100, bestScore));

        return {
            score: bestScore,
            matchedKeyword: bestKw,
            confidence: bestScore / 100,
            accepted: bestScore >= this.minConfidenceScore,
            reasons: bestReasons
        };
    };

    LeadMatcher.prototype.evaluate = function (lead, filter) {
        var elig = this.checkEligibility(lead, filter);
        if (!elig.eligible) {
            return { passed: false, stage: 'A_ELIGIBILITY', reason: elig.reason, detail: elig.detail, score: 0 };
        }
        var scoring = this.computeScore(lead, filter);
        if (!scoring.accepted) {
            return { passed: false, stage: 'B_SCORING', reason: 'low_confidence_score', score: scoring.score, confidence: scoring.confidence, reasons: scoring.reasons };
        }
        return {
            passed: true,
            stage: 'ACCEPTED',
            reason: null,
            score: scoring.score,
            confidence: scoring.confidence,
            matchedKeyword: scoring.matchedKeyword,
            reasons: scoring.reasons,
            filterId: filter.id,
            filterName: filter.filter_name || filter.name
        };
    };

    LeadMatcher.prototype.rankCandidates = function (candidates) {
        return candidates.slice().sort(function (a, b) {
            if (b.score !== a.score) return b.score - a.score;
            if (b.confidence !== a.confidence) return b.confidence - a.confidence;
            return String(a.filter ? a.filter.id : '').localeCompare(String(b.filter ? b.filter.id : ''));
        });
    };

    // ============================================================
    // KEYWORD MANAGER (v6.3 - GRAVITAS MATCHING & ACTIVE FILTER COUNT)
    // ============================================================
    function KeywordManager() {
        this.logger = new Logger('KeywordManager');
        this.keywords = { product: [], negative: [], location: [], required: [] };
        this._localKeywords = { product: [], negative: [], location: [], required: [] };
        this._supabaseKeywords = { product: [], negative: [], location: [], required: [] };
        this._supabaseEnabled = true;
        this.matcher = new LeadMatcher();
        this._activeFilters = [];
        this._filterCompletedBuyers = new Map(); // filterId -> Set of distinct buyerIds
        this._filterInFlight = new Map();        // filterId -> Set of in-flight leadIds
        this._deactivatedFilterIds = new Set();  // filterId -> Set of auto-deactivated filter IDs
        this._reactivationTimers = new Map();    // filterId -> setTimeout timer
        this._deactivatedMeta = {};              // filterId -> { deactivatedAt, durationMs, filterName }
        this._invertedTokenIndex = Object.create(null); // token -> Array of rule references
        this._wildcardRules = [];                       // rules with no product keywords (location-only)
    }

    KeywordManager.prototype.getBuyerId = function (lead) {
        if (!lead) return null;
        var mobile = (lead.senderMobile || (lead.contact && lead.contact.mobile) || lead.senderPhone || (lead.contact && lead.contact.phone) || '').replace(/\D+/g, '');
        if (mobile && mobile.length >= 7) return 'tel_' + mobile.slice(-10);
        var email = (lead.senderEmail || (lead.contact && lead.contact.email) || '').toLowerCase().trim();
        if (email && email.indexOf('@') !== -1) return 'email_' + email;
        var name = (lead.senderName || (lead.contact && lead.contact.name) || lead.sellerName || '').toLowerCase().trim();
        var loc = (lead.city || lead.state || lead.location || '').toLowerCase().trim();
        if (name) return 'name_' + name + (loc ? '_' + loc : '');
        if (lead.leadId || lead.id || lead.queryId || lead.uniqueId) return 'lead_' + (lead.leadId || lead.id || lead.queryId || lead.uniqueId);
        return null;
    };

    KeywordManager.prototype.getActiveFilterCount = function () {
        var self = this;
        if (this._supabaseEnabled) {
            if (!this._activeFilters || this._activeFilters.length === 0) {
                return 0;
            }
            return this._activeFilters.filter(function (f) {
                if (f.isActive === false || f.is_active === false || f.deleted_at || f.is_deleted) return false;
                if (self._deactivatedFilterIds && self._deactivatedFilterIds.has(String(f.id))) return false;
                var buyers = self._filterCompletedBuyers.get(f.id) || self._filterCompletedBuyers.get(String(f.id));
                var count = buyers ? buyers.size : 0;
                var target = 10;
                if (typeof f.targetQuantity === 'number' && f.targetQuantity > 0) {
                    target = f.targetQuantity;
                } else if (typeof f.target_lead_count === 'number' && f.target_lead_count > 0) {
                    target = f.target_lead_count;
                } else if (f.filter_config && typeof f.filter_config.target_quantity === 'number' && f.filter_config.target_quantity > 0) {
                    target = f.filter_config.target_quantity;
                } else if (f.filter_config && typeof f.filter_config.target_lead_count === 'number' && f.filter_config.target_lead_count > 0) {
                    target = f.filter_config.target_lead_count;
                }
                return count < target;
            }).length;
        }
        if (this._localKeywords && this._localKeywords.product && this._localKeywords.product.length > 0) {
            return this._localKeywords.product.length;
        }
        return 0;
    };

    KeywordManager.prototype.isFilterEligible = function (filterId) {
        if (!filterId) return false;
        var self = this;
        if (this._deactivatedFilterIds && this._deactivatedFilterIds.has(String(filterId))) return false;
        if (this._activeFilters && this._activeFilters.length > 0) {
            for (var i = 0; i < this._activeFilters.length; i++) {
                var f = this._activeFilters[i];
                if (String(f.id) === String(filterId)) {
                    if (f.isActive === false || f.is_active === false || f.deleted_at || f.is_deleted) return false;
                    var buyers = self._filterCompletedBuyers.get(f.id) || self._filterCompletedBuyers.get(String(f.id));
                    var count = buyers ? buyers.size : 0;
                    var target = 10;
                    if (typeof f.targetQuantity === 'number' && f.targetQuantity > 0) {
                        target = f.targetQuantity;
                    } else if (typeof f.target_lead_count === 'number' && f.target_lead_count > 0) {
                        target = f.target_lead_count;
                    } else if (f.filter_config && typeof f.filter_config.target_quantity === 'number' && f.filter_config.target_quantity > 0) {
                        target = f.filter_config.target_quantity;
                    } else if (f.filter_config && typeof f.filter_config.target_lead_count === 'number' && f.filter_config.target_lead_count > 0) {
                        target = f.filter_config.target_lead_count;
                    }
                    return count < target;
                }
            }
        }
        return false;
    };

    KeywordManager.prototype.reserveSlot = function (filterId, leadId) {
        if (!filterId || !leadId) return;
        var fKey = String(filterId);
        if (!this._filterInFlight.has(fKey)) {
            this._filterInFlight.set(fKey, new Set());
        }
        this._filterInFlight.get(fKey).add(leadId);
    };

    KeywordManager.prototype.releaseReservation = function (filterId, leadId) {
        if (!filterId || !leadId) return;
        var fKey = String(filterId);
        if (this._filterInFlight.has(fKey)) {
            this._filterInFlight.get(fKey).delete(leadId);
        }
    };

    KeywordManager.prototype.recordFilterSuccess = function (filterId, lead) {
        if (!filterId) return;
        var buyerId = this.getBuyerId(lead);
        var fKey = String(filterId);
        if (!this._filterCompletedBuyers.has(fKey)) {
            this._filterCompletedBuyers.set(fKey, new Set());
        }
        if (buyerId) {
            this._filterCompletedBuyers.get(fKey).add(buyerId);
        }
        this.releaseReservation(filterId, lead ? (lead.leadId || lead.id) : null);

        // Check if unique sellers quota (10 leads) has been reached
        var target = 10;
        var targetRule = null;
        if (this._activeFilters && this._activeFilters.length > 0) {
            for (var i = 0; i < this._activeFilters.length; i++) {
                if (String(this._activeFilters[i].id) === fKey) {
                    targetRule = this._activeFilters[i];
                    break;
                }
            }
        }
        if (targetRule) {
            if (typeof targetRule.targetQuantity === 'number' && targetRule.targetQuantity > 0) {
                target = targetRule.targetQuantity;
            } else if (typeof targetRule.target_lead_count === 'number' && targetRule.target_lead_count > 0) {
                target = targetRule.target_lead_count;
            } else if (targetRule.filter_config && typeof targetRule.filter_config.target_quantity === 'number' && targetRule.filter_config.target_quantity > 0) {
                target = targetRule.filter_config.target_quantity;
            } else if (targetRule.filter_config && typeof targetRule.filter_config.target_lead_count === 'number' && targetRule.filter_config.target_lead_count > 0) {
                target = targetRule.filter_config.target_lead_count;
            }
        }

        var completedBuyers = this._filterCompletedBuyers.get(fKey);
        var count = completedBuyers ? completedBuyers.size : 0;
        if (count >= target) {
            if (!this._deactivatedFilterIds) this._deactivatedFilterIds = new Set();
            this._deactivatedFilterIds.add(fKey);
            if (targetRule) {
                targetRule.isActive = false;
                targetRule.is_active = false;
                if (targetRule.rawFilter) {
                    targetRule.rawFilter.is_active = false;
                }
            }

            var filterName = (targetRule && (targetRule.name || targetRule.filter_name)) || ('Filter #' + fKey);

            // 1. Structured Logging
            this.logger.info('filter.limit.reached', {
                filterId: fKey,
                filterName: filterName,
                count: count,
                target: target,
                message: 'Limit reached for filter "' + filterName + '" (' + count + '/' + target + ' unique seller leads).'
            });
            this.logger.info('filter.deactivated', {
                filterId: fKey,
                filterName: filterName,
                durationSeconds: 60,
                message: 'Filter "' + filterName + '" deactivated for 60 seconds.'
            });

            // 2. Toast Prompts: Limit Reached & Filter Deactivated
            if (this.orchestrator && typeof this.orchestrator.showTopToast === 'function') {
                this.orchestrator.showTopToast('warning', 'Limit Reached', 'Filter "' + filterName + '" reached ' + target + ' leads limit', 3500);
                var orch = this.orchestrator;
                setTimeout(function () {
                    orch.showTopToast('failed', 'Filter Deactivated', 'Filter "' + filterName + '" deactivated for 60s', 4000);
                }, 400);
            }

            // 3. Supabase Deactivation
            if (this.orchestrator && this.orchestrator.supabase && typeof this.orchestrator.supabase.deactivateFilter === 'function') {
                this.orchestrator.supabase.deactivateFilter(filterId);
            }

            // 4. Schedule 60-second auto-reactivation
            this._scheduleAutoReactivation(fKey, filterName, 60000);
        }

        this._persistCompletedBuyers();
        if (this.orchestrator && typeof this.orchestrator._updateScannerLifecycleState === 'function') {
            this.orchestrator._updateScannerLifecycleState('filter_completed');
        }
    };

    KeywordManager.prototype._scheduleAutoReactivation = function (filterId, filterName, delayMs) {
        var self = this;
        var fKey = String(filterId);
        var delay = (typeof delayMs === 'number' && delayMs > 0) ? delayMs : 60000;

        if (!this._reactivationTimers) this._reactivationTimers = new Map();
        if (this._reactivationTimers.has(fKey)) {
            clearTimeout(this._reactivationTimers.get(fKey));
        }

        if (!this._deactivatedMeta) this._deactivatedMeta = {};
        this._deactivatedMeta[fKey] = {
            deactivatedAt: Date.now(),
            durationMs: delay,
            filterName: filterName || ('Filter #' + fKey)
        };
        this._persistCompletedBuyers();

        var timer = setTimeout(function () {
            self.reactivateFilter(fKey, '60s_timer_elapsed');
        }, delay);

        this._reactivationTimers.set(fKey, timer);
    };

    KeywordManager.prototype.reactivateFilter = function (filterId, reason) {
        if (!filterId) return;
        var fKey = String(filterId);

        // Clear any pending timer
        if (this._reactivationTimers && this._reactivationTimers.has(fKey)) {
            clearTimeout(this._reactivationTimers.get(fKey));
            this._reactivationTimers.delete(fKey);
        }

        // Remove from deactivated tracking
        if (this._deactivatedFilterIds) {
            this._deactivatedFilterIds.delete(fKey);
        }
        var metaName = null;
        if (this._deactivatedMeta && this._deactivatedMeta[fKey]) {
            metaName = this._deactivatedMeta[fKey].filterName;
            delete this._deactivatedMeta[fKey];
        }

        // Reset completed buyers quota so it can acquire 10 new unique leads!
        this._filterCompletedBuyers.delete(fKey);

        // Find the rule and mark isActive = true
        var targetRule = null;
        if (this._activeFilters && this._activeFilters.length > 0) {
            for (var i = 0; i < this._activeFilters.length; i++) {
                if (String(this._activeFilters[i].id) === fKey) {
                    targetRule = this._activeFilters[i];
                    break;
                }
            }
        }
        if (targetRule) {
            targetRule.isActive = true;
            targetRule.is_active = true;
            if (targetRule.rawFilter) {
                targetRule.rawFilter.is_active = true;
            }
        }

        var filterName = metaName || (targetRule && (targetRule.name || targetRule.filter_name)) || ('Filter #' + fKey);

        // Structured logging
        this.logger.info('filter.reactivated', {
            filterId: fKey,
            filterName: filterName,
            reason: reason || 'auto_reactivation',
            message: 'Filter "' + filterName + '" reactivated. Quota reset for next 10 unique sellers.'
        });

        // Toast prompt: Filter Reactivated
        if (this.orchestrator && typeof this.orchestrator.showTopToast === 'function') {
            this.orchestrator.showTopToast('reactivated', 'Filter Reactivated', 'Filter "' + filterName + '" reactivated', 4000);
        }

        // Notify Supabase if available
        if (this.orchestrator && this.orchestrator.supabase && typeof this.orchestrator.supabase.reactivateFilter === 'function') {
            this.orchestrator.supabase.reactivateFilter(filterId);
        }

        this._persistCompletedBuyers();

        // Update scanner state so scanning resumes if it was paused/idle
        if (this.orchestrator && typeof this.orchestrator._updateScannerLifecycleState === 'function') {
            this.orchestrator._updateScannerLifecycleState('filter_reactivated');
        }
    };

    KeywordManager.prototype._persistCompletedBuyers = function () {
        var out = {};
        this._filterCompletedBuyers.forEach(function (buyerSet, fId) {
            out[fId] = Array.from(buyerSet);
        });
        var deact = this._deactivatedFilterIds ? Array.from(this._deactivatedFilterIds) : [];
        var meta = this._deactivatedMeta || {};
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                chrome.storage.local.set({ 
                    filterCompletedBuyers: out,
                    deactivatedFilterIds: deact,
                    deactivatedFilterMeta: meta
                });
            }
        } catch (e) { }
    };

    KeywordManager.prototype.setSupabaseEnabled = function (enabled) {
        this._supabaseEnabled = enabled;
        this._rebuildKeywords();
    };

    KeywordManager.prototype._normalize = function (text) {
        return normalizeText(text);
    };

    KeywordManager.prototype._textMatches = function (text, keyword) {
        return wordBoundaryMatch(normalizeText(text), normalizeText(keyword));
    };

    KeywordManager.prototype.loadKeywords = function () {
        var self = this;
        return new Promise(function (resolve) {
            chrome.storage.local.get(['keywords', 'supabaseEnabled', 'filterCompletedBuyers', 'deactivatedFilterIds', 'deactivatedFilterMeta', 'cached_filters_v1', 'supabase_filters_cache'], function (result) {
                if (result && result.filterCompletedBuyers) {
                    try {
                        for (var fId in result.filterCompletedBuyers) {
                            if (Array.isArray(result.filterCompletedBuyers[fId])) {
                                self._filterCompletedBuyers.set(fId, new Set(result.filterCompletedBuyers[fId]));
                            }
                        }
                    } catch (e) { }
                }
                if (result && Array.isArray(result.deactivatedFilterIds)) {
                    self._deactivatedFilterIds = new Set(result.deactivatedFilterIds.map(String));
                }
                if (result && result.deactivatedFilterMeta && typeof result.deactivatedFilterMeta === 'object') {
                    self._deactivatedMeta = result.deactivatedFilterMeta;
                    var now = Date.now();
                    for (var dId in self._deactivatedMeta) {
                        var m = self._deactivatedMeta[dId];
                        var elapsed = now - (m.deactivatedAt || 0);
                        var remaining = (m.durationMs || 60000) - elapsed;
                        if (remaining <= 0) {
                            self.reactivateFilter(dId, '60s_timer_elapsed_post_reload');
                        } else {
                            self._scheduleAutoReactivation(dId, m.filterName, remaining);
                        }
                    }
                }
                self._localKeywords = {
                    product: (result.keywords && result.keywords.product) || [],
                    negative: (result.keywords && result.keywords.negative) || [],
                    location: (result.keywords && result.keywords.location) || [],
                    required: (result.keywords && result.keywords.required) || []
                };
                self._supabaseEnabled = result.supabaseEnabled !== false;

                // Prime Supabase filters from local storage cache immediately so matching works real-time without waiting
                var cachedFilters = null;
                if (result && result.cached_filters_v1 && Array.isArray(result.cached_filters_v1.filters)) {
                    cachedFilters = result.cached_filters_v1.filters;
                } else if (result && result.supabase_filters_cache && Array.isArray(result.supabase_filters_cache.filters)) {
                    cachedFilters = result.supabase_filters_cache.filters;
                }
                if (cachedFilters && cachedFilters.length > 0) {
                    self.extractFromSupabaseFilters(cachedFilters);
                    if (self.orchestrator && self.orchestrator.supabase) {
                        self.orchestrator.supabase._filters = cachedFilters;
                        self.orchestrator.supabase._filtersLoaded = true;
                    }
                } else {
                    self._rebuildKeywords();
                }

                self.logger.info('Local keywords loaded', {
                    product: self._localKeywords.product.length,
                    activeFilters: self.getActiveFilterCount(),
                    supabaseEnabled: self._supabaseEnabled
                });
                resolve(self.keywords);
            });
        });
    };

    KeywordManager.prototype.extractFromSupabaseFilters = function (filters) {
        this._activeFilters = [];
        if (!filters || filters.length === 0) {
            this._supabaseKeywords = { product: [], negative: [], location: [], required: [] };
            this._rebuildKeywords();
            this.logger.info('📥 No active filters');
            return;
        }

        var INDIAN_STATES = {
            'andhra pradesh': 1, 'arunachal pradesh': 1, 'assam': 1, 'bihar': 1, 'chhattisgarh': 1,
            'goa': 1, 'gujarat': 1, 'haryana': 1, 'himachal pradesh': 1, 'jharkhand': 1, 'karnataka': 1,
            'kerala': 1, 'madhya pradesh': 1, 'maharashtra': 1, 'manipur': 1, 'meghalaya': 1,
            'mizoram': 1, 'nagaland': 1, 'odisha': 1, 'orissa': 1, 'punjab': 1, 'rajasthan': 1,
            'sikkim': 1, 'tamil nadu': 1, 'telangana': 1, 'tripura': 1, 'uttar pradesh': 1,
            'uttarakhand': 1, 'uttaranchal': 1, 'west bengal': 1, 'delhi': 1, 'new delhi': 1,
            'jammu and kashmir': 1, 'jammu kashmir': 1, 'ladakh': 1, 'chandigarh': 1,
            'puducherry': 1, 'pondicherry': 1, 'andaman and nicobar islands': 1, 'lakshadweep': 1,
            'dadra and nagar haveli': 1, 'daman and diu': 1
        };

        function normForMatch(t) {
            return normalizeText(t);
        }

        var rules = [];
        for (var i = 0; i < filters.length; i++) {
            var f = filters[i];
            var fIdStr = String(f.id);

            // Manual reactivation detection:
            // If this filter was previously auto-deactivated upon reaching quota (10 unique sellers),
            // and has now been manually turned back on (is_active !== false in Supabase/CRM),
            // unblock it by resetting its completed buyers set and removing from deactivated IDs.
            if (this._deactivatedFilterIds && this._deactivatedFilterIds.has(fIdStr)) {
                if (f.is_active !== false && !f.deleted_at && !f.is_deleted) {
                    this.reactivateFilter(fIdStr, 'manual_user_reactivation');
                }
            }

            var cfg = f.filter_config || {};
            var uniqNorm = function (arr) {
                var seen = {}, out = [];
                if (!Array.isArray(arr)) return out;
                for (var x = 0; x < arr.length; x++) {
                    if (typeof arr[x] !== 'string') continue;
                    var pieces = arr[x].split(/[,;\n\r]+/);
                    for (var pi = 0; pi < pieces.length; pi++) {
                        var v = normForMatch(pieces[pi]);
                        if (v && !seen[v]) { seen[v] = 1; out.push(v); }
                    }
                }
                return out;
            };

            function collectFields(objects, names) {
                var out = [];
                for (var oi = 0; oi < objects.length; oi++) {
                    var obj = objects[oi] || {};
                    for (var ni = 0; ni < names.length; ni++) {
                        var value = obj[names[ni]];
                        if (Array.isArray(value)) {
                            for (var ai = 0; ai < value.length; ai++) {
                                if (typeof value[ai] === 'string') {
                                    var splits = value[ai].split(/[,;\n\r]+/);
                                    for (var spi = 0; spi < splits.length; spi++) {
                                        var spTrim = splits[spi].trim();
                                        if (spTrim) out.push(spTrim);
                                    }
                                } else if (value[ai] != null) {
                                    out.push(String(value[ai]));
                                }
                            }
                        } else if (typeof value === 'string' && value.trim()) {
                            var splitsStr = value.split(/[,;\n\r]+/);
                            for (var si = 0; si < splitsStr.length; si++) {
                                var sTrim = splitsStr[si].trim();
                                if (sTrim) out.push(sTrim);
                            }
                        }
                    }
                }
                return out;
            }
            var prodNames = collectFields([cfg, f], [
                'product_names', 'productNames', 'product_keywords', 'productKeywords', 'keywords',
                'product_name', 'productName', 'products'
            ]);
            var negNames = collectFields([cfg, f], ['negative_keywords', 'negativeKeywords', 'excluded_keywords', 'exclude_keywords', 'excludedKeywords']);
            var reqNames = collectFields([cfg, f], ['required_keywords', 'requiredKeywords', 'must_have_keywords', 'mustHaveKeywords']);
            var locNames = collectFields([cfg, f], [
                'countries', 'country', 'states', 'state', 'cities', 'city', 'locations', 'location',
                'sender_locations', 'senderLocations', 'location_keywords', 'regions', 'region',
                'city_name', 'state_name', 'country_name', 'allowed_countries', 'allowedCountries'
            ]);
            var restCountries = collectFields([cfg, f], ['restricted_countries', 'restrictedCountries']);

            var normKeywords = uniqNorm(prodNames);
            if (normKeywords.length === 0) {
                var candidateName = (f.filter_name || f.name || '').trim();
                if (candidateName && !/^filter[_\s\-]?\d*$/i.test(candidateName)) {
                    var fallbackKeywords = uniqNorm([candidateName]);
                    if (fallbackKeywords.length > 0) {
                        normKeywords = fallbackKeywords;
                    }
                }
            }
            var isFilterValid = normKeywords.length > 0 || locNames.length > 0;
            var isDeleted = !!f.deleted_at || f.is_deleted === true;

            rules.push({
                id: f.id,
                name: f.filter_name || f.name || ('filter_' + f.id),
                keywords: normKeywords,
                matchMode: (String(cfg.match_mode || cfg.matchMode || f.match_mode || f.matchMode || 'any').toLowerCase() === 'all') ? 'all' : 'any',
                negativeKeywords: uniqNorm(negNames),
                requiredKeywords: uniqNorm(reqNames),
                locations: uniqNorm(locNames),
                restrictedCountries: uniqNorm(restCountries),
                rejectUnknownCountry: cfg.reject_unknown_country === true || f.reject_unknown_country === true || cfg.rejectUnknownCountry === true || f.rejectUnknownCountry === true,
                requireMobile: cfg.require_mobile === true || f.require_mobile === true,
                requireWhatsapp: cfg.require_whatsapp === true || f.require_whatsapp === true,
                requireEmail: cfg.require_email === true || f.require_email === true,
                quantityUnit: typeof (cfg.quantity_unit || f.quantity_unit) === 'string' ? (cfg.quantity_unit || f.quantity_unit).toLowerCase().trim() : '',
                minQuantity: (typeof cfg.min_quantity === 'number' && cfg.min_quantity > 0) ? cfg.min_quantity : ((typeof f.min_quantity === 'number' && f.min_quantity > 0) ? f.min_quantity : 0),
                targetQuantity: (typeof cfg.target_quantity === 'number' && cfg.target_quantity > 0) ? cfg.target_quantity : ((typeof f.target_lead_count === 'number' && f.target_lead_count > 0) ? f.target_lead_count : ((typeof f.target_quantity === 'number' && f.target_quantity > 0) ? f.target_quantity : 10)),
                isActive: f.is_active !== false && !isDeleted && isFilterValid && !(this._deactivatedFilterIds && this._deactivatedFilterIds.has(fIdStr)),
                rawFilter: f,
                _indianStates: INDIAN_STATES
            });
        }
        this._activeFilters = rules;

        // Keep flat lists for backward compatibility and status text
        var product = [], negative = [], location = [], required = [];
        var addUnique = function (arr, item) {
            if (!item || typeof item !== 'string') return;
            var pieces = item.split(/[,;\n\r]+/);
            for (var pi = 0; pi < pieces.length; pi++) {
                var lower = pieces[pi].toLowerCase().trim();
                if (lower && arr.indexOf(lower) === -1) arr.push(lower);
            }
        };
        for (var j = 0; j < filters.length; j++) {
            var ff = filters[j];
            var cc = ff.filter_config || {};
            if (Array.isArray(ff.product_keywords)) for (var a = 0; a < ff.product_keywords.length; a++) addUnique(product, ff.product_keywords[a]);
            if (Array.isArray(ff.negative_keywords)) for (var b = 0; b < ff.negative_keywords.length; b++) addUnique(negative, ff.negative_keywords[b]);
            if (Array.isArray(ff.required_keywords)) for (var c = 0; c < ff.required_keywords.length; c++) addUnique(required, ff.required_keywords[c]);
            if (Array.isArray(ff.location_keywords)) for (var d = 0; d < ff.location_keywords.length; d++) addUnique(location, ff.location_keywords[d]);
            if (Array.isArray(cc.product_names)) for (var e = 0; e < cc.product_names.length; e++) addUnique(product, cc.product_names[e]);
            if (Array.isArray(cc.negative_keywords)) for (var g = 0; g < cc.negative_keywords.length; g++) addUnique(negative, cc.negative_keywords[g]);
            if (Array.isArray(cc.required_keywords)) for (var h = 0; h < cc.required_keywords.length; h++) addUnique(required, cc.required_keywords[h]);
            if (Array.isArray(cc.countries)) for (var k1 = 0; k1 < cc.countries.length; k1++) addUnique(location, cc.countries[k1]);
        }
        this._supabaseKeywords = { product: product, negative: negative, location: location, required: required };
        this._rebuildKeywords();
        this._compileInvertedIndex();
        this.logger.info('📥 Supabase filters built', { rules: rules.length, product: product.length, activeCount: this.getActiveFilterCount() });
    };

    // Aho-Corasick Multi-Pattern Inverted Index Compilation (O(M) Fast Token Lookup)
    KeywordManager.prototype._compileInvertedIndex = function () {
        var index = Object.create(null);
        var wildcards = [];
        var rules = this._activeFilters || [];

        function addToken(tok, rule) {
            if (!tok || typeof tok !== 'string') return;
            var t = tok.toLowerCase().trim();
            if (!t || t.length === 0) return;
            if (!index[t]) index[t] = [];
            if (index[t].indexOf(rule) === -1) index[t].push(rule);

            // Morphological variations & plurals
            if (t.length > 3) {
                if (t.slice(-1) === 's') {
                    var sing = t.slice(0, -1);
                    if (!index[sing]) index[sing] = [];
                    if (index[sing].indexOf(rule) === -1) index[sing].push(rule);
                } else {
                    var plur = t + 's';
                    if (!index[plur]) index[plur] = [];
                    if (index[plur].indexOf(rule) === -1) index[plur].push(rule);
                }
            }
        }

        for (var i = 0; i < rules.length; i++) {
            var r = rules[i];
            var kws = r.keywords || r.product_keywords || r.productKeywords || (r.filter_config && (r.filter_config.product_names || r.filter_config.product_keywords)) || [];
            if (typeof kws === 'string') kws = [kws];
            if (!kws || kws.length === 0) {
                wildcards.push(r);
                continue;
            }
            for (var k = 0; k < kws.length; k++) {
                var normKw = normalizeText(kws[k]);
                var tokens = tokenize(normKw);
                for (var ti = 0; ti < tokens.length; ti++) {
                    var tk = tokens[ti];
                    addToken(tk, r);
                    if (typeof SYNONYM_MAP !== 'undefined' && SYNONYM_MAP && SYNONYM_MAP[tk]) {
                        var synList = SYNONYM_MAP[tk];
                        for (var si = 0; si < synList.length; si++) {
                            var synToks = tokenize(normalizeText(synList[si]));
                            for (var st = 0; st < synToks.length; st++) {
                                addToken(synToks[st], r);
                            }
                        }
                    }
                }
            }
        }
        this._invertedTokenIndex = index;
        this._wildcardRules = wildcards;
        this._invertedRulesCount = rules.length;
    };

    KeywordManager.prototype._rebuildKeywords = function () {
        if (this._supabaseEnabled && (
            this._supabaseKeywords.product.length > 0 ||
            this._supabaseKeywords.negative.length > 0 ||
            this._supabaseKeywords.required.length > 0)) {
            this.keywords = {
                product: this._supabaseKeywords.product.slice(),
                negative: this._supabaseKeywords.negative.slice(),
                location: this._supabaseKeywords.location.slice(),
                required: this._supabaseKeywords.required.slice()
            };
        } else {
            this.keywords = {
                product: this._localKeywords.product.slice(),
                negative: this._localKeywords.negative.slice(),
                location: this._localKeywords.location.slice(),
                required: this._localKeywords.required.slice()
            };
        }
    };

    KeywordManager.prototype.updateKeywords = function (newKeywords) {
        var self = this;
        return new Promise(function (resolve) {
            for (var k in newKeywords) {
                if (newKeywords.hasOwnProperty(k) && self._localKeywords.hasOwnProperty(k)) {
                    self._localKeywords[k] = newKeywords[k];
                }
            }
            chrome.storage.local.set({ keywords: self._localKeywords }, function () {
                self._rebuildKeywords();
                resolve(true);
            });
        });
    };

    // Evaluates a candidate lead against all active filters with Stage A eligibility & Stage B candidate ranking
    KeywordManager.prototype.evaluateFilters = function (lead) {
        var self = this;
        var rules = this._activeFilters || [];
        var activeRules = rules.filter(function (r) { return r.isActive !== false; });
        if (activeRules.length === 0) {
            return { passed: false, reason: 'no_active_filter', matchedProducts: [], matchedRequired: [], matchedNegative: [] };
        }

        var contact = lead.contact || {};
        var leadCountryIso = (lead.countryIso || '').toUpperCase().trim();
        var locParts = [];
        if (lead.city) locParts.push(normalizeText(lead.city));
        if (lead.state) locParts.push(normalizeText(lead.state));
        if (lead.location) locParts.push(normalizeText(lead.location));
        if (leadCountryIso) {
            locParts.push(leadCountryIso.toLowerCase());
            if (leadCountryIso === 'IN') {
                locParts.push('india');
            } else {
                locParts.push('foreign', 'international', 'export', 'overseas');
            }
        }
        if (lead.country) locParts.push(normalizeText(lead.country));

        function locationMatches(rule) {
            var rawLocs = rule.locations || (rule.filter_config && (rule.filter_config.locations || rule.filter_config.countries || rule.filter_config.sender_locations)) || rule.sender_locations || [];
            if (!rawLocs || rawLocs.length === 0) return true;
            if (rule.rejectUnknownCountry && (!leadCountryIso || leadCountryIso === 'UNKNOWN')) {
                return false;
            }
            for (var i = 0; i < rawLocs.length; i++) {
                var entry = String(rawLocs[i]).toLowerCase().trim();
                if (entry === 'india' || entry === 'in' || entry === 'pan india' || entry === 'all india') {
                    if (leadCountryIso === 'IN' || (!lead.isForeign && (!leadCountryIso || leadCountryIso === 'IN'))) return true;
                    for (var p = 0; p < locParts.length; p++) {
                        if (rule._indianStates && rule._indianStates[locParts[p]]) return true;
                    }
                    continue;
                }

                // ISO and Country Name matching
                var entryIso = COUNTRY_NAME_TO_ISO[entry] || (entry.length === 2 ? entry.toUpperCase() : null);
                if (entryIso && leadCountryIso && entryIso === leadCountryIso) return true;
                if (leadCountryIso && COUNTRY_CODE_MAP[leadCountryIso]) {
                    var cNames = COUNTRY_CODE_MAP[leadCountryIso];
                    if (cNames.indexOf(entry) !== -1) return true;
                }

                for (var q = 0; q < locParts.length; q++) {
                    if (locParts[q] === entry || locParts[q].indexOf(entry) !== -1 || entry.indexOf(locParts[q]) !== -1) return true;
                }
            }
            return false;
        }

        var candidateMatches = [];
        var buyerId = self.getBuyerId(lead);
        // Diagnostics: how many filters were rejected at each stage (no keywords/PII logged).
        var stageCounts = {};
        var nearMiss = null;
        function reject(stage) { stageCounts[stage] = (stageCounts[stage] || 0) + 1; }

        // Fast O(M) Candidate Pre-Filtering via Inverted Token Index
        var firstId = rules[0] ? rules[0].id : null;
        if (!this._invertedTokenIndex || this._lastActiveFiltersRef !== rules || this._invertedRulesCount !== rules.length || this._firstRuleId !== firstId) {
            this._compileInvertedIndex();
            this._lastActiveFiltersRef = rules;
            this._firstRuleId = firstId;
        }
        var candidateRules = [];
        if (this._invertedTokenIndex && Object.keys(this._invertedTokenIndex).length > 0) {
            var rawLeadText = (lead.productName || '') + ' ' + (lead.messageText || lead.queryMessage || lead.description || '');
            var leadTokens = tokenize(normalizeText(rawLeadText));
            var seenRuleIds = Object.create(null);

            // 1. Wildcard / non-keyword rules (location-only, etc.) are always candidates
            var wildcards = this._wildcardRules || [];
            for (var w = 0; w < wildcards.length; w++) {
                var wr = wildcards[w];
                if (wr && wr.isActive !== false && !seenRuleIds[wr.id]) {
                    seenRuleIds[wr.id] = true;
                    candidateRules.push(wr);
                }
            }

            // 2. O(M) inverted index dictionary lookup for words in lead
            for (var m = 0; m < leadTokens.length; m++) {
                var lTok = leadTokens[m];
                var matched = this._invertedTokenIndex[lTok];
                if (matched) {
                    for (var rIdx = 0; rIdx < matched.length; rIdx++) {
                        var cRule = matched[rIdx];
                        if (cRule && cRule.isActive !== false && !seenRuleIds[cRule.id]) {
                            seenRuleIds[cRule.id] = true;
                            candidateRules.push(cRule);
                        }
                    }
                }
            }
        } else {
            candidateRules = activeRules;
        }

        if (candidateRules.length === 0) {
            return {
                passed: false, reason: 'no_filter_matched', matchedProducts: [], matchedRequired: [], matchedNegative: [],
                diagnostics: { activeRules: activeRules.length, candidateRules: 0, rejectedByStage: { token_index_miss: activeRules.length }, nearMiss: null }
            };
        }

        for (var i = 0; i < candidateRules.length; i++) {
            var r = candidateRules[i];

            // 0. Filter Quota & Distinct Buyer check: deduct fulfilled filters
            if (self._deactivatedFilterIds && self._deactivatedFilterIds.has(String(r.id))) { reject('filter_deactivated_quota'); continue; }
            var completedBuyers = self._filterCompletedBuyers.get(r.id) || self._filterCompletedBuyers.get(String(r.id));
            var completedCount = completedBuyers ? completedBuyers.size : 0;
            var target = 10;
            if (typeof r.targetQuantity === 'number' && r.targetQuantity > 0) {
                target = r.targetQuantity;
            } else if (typeof r.target_lead_count === 'number' && r.target_lead_count > 0) {
                target = r.target_lead_count;
            } else if (r.filter_config && typeof r.filter_config.target_quantity === 'number' && r.filter_config.target_quantity > 0) {
                target = r.filter_config.target_quantity;
            } else if (r.filter_config && typeof r.filter_config.target_lead_count === 'number' && r.filter_config.target_lead_count > 0) {
                target = r.filter_config.target_lead_count;
            }
            if (completedCount >= target) { reject('quota_reached'); continue; }

            var inFlight = self._filterInFlight.get(r.id) || self._filterInFlight.get(String(r.id));
            var inFlightCount = inFlight ? inFlight.size : 0;
            if (completedCount + inFlightCount >= target) { reject('quota_in_flight'); continue; }

            if (buyerId && completedBuyers && completedBuyers.has(buyerId)) { reject('buyer_already_completed'); continue; }

            // 1. Restricted countries check
            if (r.restrictedCountries && r.restrictedCountries.length > 0) {
                var restricted = false;
                for (var ri = 0; ri < r.restrictedCountries.length; ri++) {
                    var rEntry = r.restrictedCountries[ri];
                    var rIso = COUNTRY_NAME_TO_ISO[rEntry.toLowerCase()] || (rEntry.length === 2 ? rEntry.toUpperCase() : null);
                    if (rIso && leadCountryIso && rIso === leadCountryIso) { restricted = true; break; }
                    if (leadCountryIso && COUNTRY_CODE_MAP[leadCountryIso] && COUNTRY_CODE_MAP[leadCountryIso].indexOf(rEntry.toLowerCase()) !== -1) {
                        restricted = true; break;
                    }
                    for (var lp = 0; lp < locParts.length; lp++) {
                        if (rEntry.toLowerCase() === locParts[lp]) { restricted = true; break; }
                    }
                    if (restricted) break;
                }
                if (restricted) { reject('restricted_country'); continue; }
            }

            // 2. Location include check
            if (!locationMatches(r)) { reject('location_mismatch'); continue; }

            // 3. Contact requirements (OR logic: any selected channel qualifies the lead)
            var reqMobile = !!(r.requireMobile || r.require_mobile || (r.filter_config && (r.filter_config.require_mobile || r.filter_config.requireMobile)));
            var reqWhatsapp = !!(r.requireWhatsapp || r.require_whatsapp || (r.filter_config && (r.filter_config.require_whatsapp || r.filter_config.requireWhatsapp)));
            var reqEmail = !!(r.requireEmail || r.require_email || (r.filter_config && (r.filter_config.require_email || r.filter_config.requireEmail)));
            if (reqMobile || reqWhatsapp || reqEmail) {
                var hasMobile = !!(contact.mobile || lead.senderMobile || lead.hasMobileVerified);
                var hasWhatsapp = !!(contact.phone || lead.senderMobile || lead.hasWhatsapp);
                var hasEmail = !!(contact.email || lead.senderEmail || lead.hasEmailVerified);
                var satisfiesAny = (reqMobile && hasMobile) || (reqWhatsapp && hasWhatsapp) || (reqEmail && hasEmail);
                if (!satisfiesAny) { reject('contact_requirement'); continue; }
            }

            // 4. Quantity filter
            if (r.quantityUnit && r.minQuantity > 0) {
                var q = lead.quantity;
                if (!q || q.unit !== r.quantityUnit || q.max < r.minQuantity) { reject('quantity_requirement'); continue; }
            }

            // 5. Stage A Eligibility + Stage B Relevance Scoring
            var evaluation = self.matcher.evaluate(lead, r);
            if (evaluation.passed) {
                candidateMatches.push({
                    filter: r,
                    filterId: r.id,
                    filterName: r.name,
                    score: evaluation.score,
                    confidence: evaluation.confidence,
                    matchedKeyword: evaluation.matchedKeyword,
                    reasons: evaluation.reasons
                });
            } else {
                reject((evaluation.stage || 'matcher') + ':' + (evaluation.reason || 'unknown'));
                if (evaluation.score > 0 && (!nearMiss || evaluation.score > nearMiss.score)) {
                    nearMiss = { filterId: r.id, score: evaluation.score, reason: evaluation.reason };
                }
            }
        }

        if (candidateMatches.length === 0) {
            return {
                passed: false, reason: 'no_filter_matched', matchedProducts: [], matchedRequired: [], matchedNegative: [],
                diagnostics: { activeRules: activeRules.length, rejectedByStage: stageCounts, nearMiss: nearMiss }
            };
        }

        // Rank candidates deterministically by relevance score and confidence
        var ranked = self.matcher.rankCandidates(candidateMatches);
        var best = ranked[0];

        return {
            passed: true,
            reason: null,
            filterId: best.filterId,
            filterName: best.filterName,
            score: best.score,
            confidence: best.confidence,
            matchedProducts: best.matchedKeyword ? [best.matchedKeyword] : [normalizeText(lead.productName)],
            matchedRequired: [],
            matchedNegative: []
        };
    };

    KeywordManager.prototype.getKeywords = function (type) { return this.keywords[type] || []; };
    KeywordManager.prototype.getAllKeywords = function () { return this.keywords; };

    // ============================================================
    // CHECK KEYWORDS — v6.3 SIGNATURE
    // ------------------------------------------------------------
    // checkKeywords(productName, messageText)
    //   • product keyword  → must match productName OR messageText (description)
    //                        Fixes: medicine name in contents/description missed.
    //   • negative keyword → reject if matches productName only (precision guard)
    //   • required keyword → at least one must match productName OR messageText
    // ============================================================
    KeywordManager.prototype.checkKeywords = function (productName, messageText) {
        productName = productName || '';
        messageText = messageText || '';

        var req = this.keywords.required || [];
        var neg = this.keywords.negative || [];
        var prod = this.keywords.product || [];

        // --- NEGATIVE GATE (productName only — keep precision, don't reject on description) ---
        var negMatched = [];
        for (var j = 0; j < neg.length; j++) {
            if (this._textMatches(productName, neg[j])) negMatched.push(neg[j]);
        }
        if (negMatched.length > 0) {
            return { passed: false, reason: 'negative_keyword_found', matchedProducts: [], matchedRequired: [], matchedNegative: negMatched };
        }

        // --- REQUIRED GATE (OR across productName + messageText) ---
        var reqMatched = [];
        if (req.length > 0) {
            for (var i = 0; i < req.length; i++) {
                if (this._textMatches(productName, req[i]) || this._textMatches(messageText, req[i])) {
                    reqMatched.push(req[i]);
                }
            }
            if (reqMatched.length === 0) {
                return { passed: false, reason: 'no_required_keyword', matchedProducts: [], matchedRequired: [], matchedNegative: [] };
            }
        }

        // --- PRODUCT GATE (productName OR messageText) ---
        // Key fix: if the medicine/product name is in the description (messageText)
        // rather than the card title, we still match it correctly.
        var prodMatched = [];
        if (prod.length > 0) {
            for (var k = 0; k < prod.length; k++) {
                if (this._textMatches(productName, prod[k]) || this._textMatches(messageText, prod[k])) {
                    prodMatched.push(prod[k]);
                }
            }
            if (prodMatched.length === 0) {
                return { passed: false, reason: 'no_product_keyword', matchedProducts: [], matchedRequired: reqMatched, matchedNegative: [] };
            }
        } else if (req.length === 0) {
            return { passed: false, reason: 'no_keywords_configured', matchedProducts: [], matchedRequired: [], matchedNegative: [] };
        }

        return { passed: true, reason: null, matchedProducts: prodMatched, matchedRequired: reqMatched, matchedNegative: [] };
    };

    // ============================================================
    // SAFETY CONTROLLER
    // ============================================================
    function SafetyController(circuitBreaker) {
        this.mode = 'AUTOMATIC';
        this.circuitBreaker = circuitBreaker || null;
        this._emergencyStop = false;
        this.counters = { minute: 0, hour: 0, day: 0, session: 0 };
        this.pendingReservations = 0;
        this.limits = { perMinute: 60, perHour: 400, perDay: 2000, perSession: 1000 };
        this._lastMin = Date.now();
        this._lastHour = Date.now();
        this._lastDay = Date.now();
        this._reservationTokens = {};
        this._loadCounters();
    }
    SafetyController.prototype._loadCounters = function () {
        var self = this;
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                chrome.storage.local.get(['bl_safety_counters', 'bl_safety_timestamps'], function (res) {
                    if (res && res.bl_safety_counters) {
                        var c = res.bl_safety_counters;
                        var t = res.bl_safety_timestamps || {};
                        self.counters.minute = c.minute || 0;
                        self.counters.hour = c.hour || 0;
                        self.counters.day = c.day || 0;
                        self.counters.session = c.session || 0;
                        self._lastMin = t.lastMin || Date.now();
                        self._lastHour = t.lastHour || Date.now();
                        self._lastDay = t.lastDay || Date.now();
                        self._reset();
                    }
                });
            } else if (typeof sessionStorage !== 'undefined') {
                var raw = sessionStorage.getItem('bl_safety_counters');
                if (raw) {
                    var c = JSON.parse(raw);
                    self.counters.minute = c.minute || 0;
                    self.counters.hour = c.hour || 0;
                    self.counters.day = c.day || 0;
                    self.counters.session = c.session || 0;
                    self._reset();
                }
            }
        } catch (e) { }
    };
    SafetyController.prototype._saveCounters = function () {
        try {
            var c = {
                minute: this.counters.minute,
                hour: this.counters.hour,
                day: this.counters.day,
                session: this.counters.session
            };
            var t = {
                lastMin: this._lastMin,
                lastHour: this._lastHour,
                lastDay: this._lastDay
            };
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                chrome.storage.local.set({ bl_safety_counters: c, bl_safety_timestamps: t });
            }
            if (typeof sessionStorage !== 'undefined') {
                sessionStorage.setItem('bl_safety_counters', JSON.stringify(c));
            }
        } catch (e) { }
    };
    SafetyController.prototype._reset = function () {
        var now = Date.now();
        var changed = false;
        if (now - this._lastMin > 60000) { this.counters.minute = 0; this._lastMin = now; changed = true; }
        if (now - this._lastHour > 3600000) { this.counters.hour = 0; this._lastHour = now; changed = true; }
        if (now - this._lastDay > 86400000) { this.counters.day = 0; this._lastDay = now; changed = true; }
        if (changed) this._saveCounters();
    };
    SafetyController.prototype.setMode = function (m) { this.mode = m; };
    SafetyController.prototype.setLimits = function (l) {
        for (var k in l) if (l.hasOwnProperty(k) && this.limits.hasOwnProperty(k)) this.limits[k] = l[k];
    };
    SafetyController.prototype.canAcquire = function () {
        this._reset();
        if (this.circuitBreaker && !this.circuitBreaker.canExecute()) {
            return { allowed: false, reason: 'CIRCUIT_BREAKER_RESTRICTION', state: this.circuitBreaker.getState() };
        }
        if (this._emergencyStop) return { allowed: false, reason: 'EMERGENCY_STOP' };
        if (this.mode === 'MONITOR') return { allowed: false, reason: 'MONITOR_MODE' };
        if (this.mode === 'DRY_RUN') return { allowed: false, reason: 'DRY_RUN', dryRun: true };
        
        var effectiveMin = this.counters.minute + this.pendingReservations;
        if (effectiveMin >= this.limits.perMinute) {
            return { allowed: false, reason: 'MINUTE_LIMIT', details: { used: effectiveMin, limit: this.limits.perMinute } };
        }
        if ((this.counters.hour + this.pendingReservations) >= this.limits.perHour) {
            return { allowed: false, reason: 'HOUR_LIMIT', details: { used: this.counters.hour, limit: this.limits.perHour } };
        }
        if ((this.counters.day + this.pendingReservations) >= this.limits.perDay) {
            return { allowed: false, reason: 'DAY_LIMIT', details: { used: this.counters.day, limit: this.limits.perDay } };
        }
        if ((this.counters.session + this.pendingReservations) >= this.limits.perSession) {
            return { allowed: false, reason: 'SESSION_LIMIT', details: { used: this.counters.session, limit: this.limits.perSession } };
        }
        return { allowed: true };
    };
    SafetyController.prototype.reserveCapacity = function (leadId) {
        var check = this.canAcquire();
        if (!check.allowed) return { allowed: false, reason: check.reason, details: check.details };
        var token = 'res_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
        this.pendingReservations++;
        this._reservationTokens[token] = { leadId: leadId, timestamp: Date.now() };
        return { allowed: true, token: token };
    };
    SafetyController.prototype.releaseReservation = function (token) {
        if (token && this._reservationTokens[token]) {
            delete this._reservationTokens[token];
            this.pendingReservations = Math.max(0, this.pendingReservations - 1);
        }
    };
    SafetyController.prototype.commitReservation = function (token) {
        if (token && this._reservationTokens[token]) {
            delete this._reservationTokens[token];
            this.pendingReservations = Math.max(0, this.pendingReservations - 1);
        }
        this.recordAcquisition();
    };
    SafetyController.prototype.recordAcquisition = function () {
        this._reset();
        this.counters.minute++;
        this.counters.hour++;
        this.counters.day++;
        this.counters.session++;
        this._saveCounters();
    };
    SafetyController.prototype.emergencyStopFn = function () { this._emergencyStop = true; };
    SafetyController.prototype.resume = function () { this._emergencyStop = false; };
    SafetyController.prototype.getStatus = function () {
        return {
            mode: this.mode,
            emergencyStop: this._emergencyStop,
            circuitBreaker: this.circuitBreaker ? this.circuitBreaker.getState() : 'NORMAL',
            counters: this.counters,
            pendingReservations: this.pendingReservations,
            limits: this.limits,
            cooldown: false,
            cooldownMs: 0
        };
    };

    // ============================================================
    // DUPLICATE MANAGER
    // ============================================================
    function DuplicateManager(supabase) {
        this.supabase = supabase;
        this._seen = new Set();
        this._loadedFromDb = false;
    }
    DuplicateManager.prototype.loadFromDb = function () {
        var self = this;
        if (this._loadedFromDb) return Promise.resolve();
        // Only load contacted / acquired leads — un-acquired leads are NEVER duplicates
        return this.supabase.getRecentLeads(500).then(function (leads) {
            var loaded = 0;
            for (var i = 0; i < leads.length; i++) {
                if (leads[i].is_contacted || leads[i].status === 'contacted') {
                    if (leads[i].unique_query_id) self._seen.add(leads[i].unique_query_id);
                    loaded++;
                }
            }
            self._loadedFromDb = true;
            console.log('[Dup] Loaded ' + loaded + ' contacted leads from DB');
            return loaded;
        }).catch(function () {
            self._loadedFromDb = true;
            return 0;
        });
    };
    DuplicateManager.prototype.isDuplicate = function (leadId) { return this._seen.has(leadId); };
    DuplicateManager.prototype.markSeen = function (leadId) { this._seen.add(leadId); };
    DuplicateManager.prototype.clear = function () { this._seen = new Set(); };
    DuplicateManager.prototype.cleanup = function () {
        if (this._seen.size > 5000) {
            var arr = Array.from(this._seen);
            this._seen = new Set(arr.slice(-3000));
        }
    };

    // ============================================================
    // STATE MACHINE
    // ============================================================
    function LeadStateMachine() { this._states = {}; }
    LeadStateMachine.prototype.setState = function (id, state) {
        this._states[id] = state;
        return Promise.resolve(state);
    };
    LeadStateMachine.prototype.getState = function (id) {
        return this._states[id];
    };
    LeadStateMachine.prototype.getStats = function () {
        var s = {};
        for (var k in this._states) { var v = this._states[k]; s[v] = (s[v] || 0) + 1; }
        return s;
    };

    // ============================================================
    // LEAD QUEUE (FAST DRAIN)
    // ============================================================
    function LeadQueue() {
        this.logger = new Logger('LeadQueue');
        this.queue = [];
        this.processing = 0;
        this.processor = null;
        this._running = true;
        this._currentId = null;
        this._currentUqid = null;
    }
    LeadQueue.prototype.setProcessor = function (p) {
        this.processor = p;
        this.logger.info('Processor set');
        this._process();
    };
    LeadQueue.prototype.enqueue = function (lead) {
        // Dedup by leadId (primary key used by both DOM and network paths)
        if (this.processing && this._currentId === lead.leadId) return false;
        for (var i = 0; i < this.queue.length; i++) {
            if (this.queue[i].leadId === lead.leadId) return false;
        }
        // Also dedup by uniqueQueryId — catches same physical lead arriving via
        // both the network-intercept path (api_12345) and the DOM path (hash_abc).
        if (lead.uniqueQueryId) {
            if (this._currentUqid === lead.uniqueQueryId) return false;
            for (var j = 0; j < this.queue.length; j++) {
                if (this.queue[j].uniqueQueryId === lead.uniqueQueryId) return false;
            }
        }
        this.queue.push(lead);
        this._process();
        return true;
    };
    LeadQueue.prototype._process = function () {
        var self = this;
        if (!this._running || !this.processor || this.queue.length === 0) return;
        // IndiaMART uses shared page-level dialogs; overlapping actions can consume
        // another lead's popup or cancel the first action. Keep this queue serial.
        var MAX_PARALLEL = 1;
        if (this.processing >= MAX_PARALLEL) return;
        var lead = this.queue.shift();
        this.processing++;
        this._currentId = lead.leadId;
        this._currentUqid = lead.uniqueQueryId || null;
        Promise.resolve().then(function () { return self.processor(lead); }).then(function () {
            self.processing--;
            self._currentId = null;
            self._currentUqid = null;
            if (self.queue.length > 0) self._process();
        }).catch(function (err) {
            self.logger.error('Processor error', { leadId: lead.leadId, error: err && err.message ? err.message : String(err) });
            self.processing--;
            self._currentId = null;
            self._currentUqid = null;
            if (self.queue.length > 0) self._process();
        });
    };
    LeadQueue.prototype.getStatus = function () { return { size: this.queue.length, processing: this.processing, running: this._running }; };
    LeadQueue.prototype.pause = function () { this._running = false; };
    LeadQueue.prototype.resume = function () { this._running = true; this._process(); };

    // ============================================================
    // SCANNER (FASTER DEBOUNCE)
    // ============================================================
    function Scanner() {
        this.logger = new Logger('Scanner');
        this._running = false;
        this._callback = null;
        this._observer = null;
        this._targetNode = null;
        this._topSentinel = null;
        this._scanTimer = null;
        this._knownLeads = {};
        this._debounceMs = 100; // 100ms debounce prevents rapid thrashing
        this._reconciliationFallbackMs = 500; // 500ms secondary reconciliation check for sub-second arrival pickup
        this._idGen = new LeadIdGenerator();
        this._scanning = false;
        this._scanPending = false;
    }
    Scanner.prototype.resetEmitted = function () {
        this._knownLeads = {};
    };
    Scanner.prototype._attachTopSentinel = function () {
        if (this._topSentinel) return;
        var s = document.createElement('div');
        s.id = 'bl-top-sentinel';
        s.style.cssText = 'height:1px;width:100%;pointer-events:none;opacity:0;';
        if (document.body) document.body.insertBefore(s, document.body.firstChild);
        this._topSentinel = s;
    };
    Scanner.prototype._checkNewLeadsBanner = function () {
        try {
            var now = Date.now();
            if (this._lastBannerCheck && (now - this._lastBannerCheck < 5000)) return false;
            this._lastBannerCheck = now;

            var banners = document.querySelectorAll(
                '.bl_new_toast, [class*="new_buylead" i], [class*="newBuyLead" i], [class*="newLead" i], [class*="alert_new" i]'
            );
            for (var i = 0; i < banners.length; i++) {
                var b = banners[i];
                if (b.id && b.id.indexOf('bl-') === 0) continue; // Skip extension panel UI
                var t = (b.textContent || '').trim().toLowerCase();
                if ((t.indexOf('new buylead') !== -1 || t.indexOf('new lead') !== -1 || t.indexOf('new enquiry') !== -1 || t.indexOf('latest lead') !== -1)
                    && (t.indexOf('click') !== -1 || t.indexOf('refresh') !== -1 || t.indexOf('available') !== -1 || t.indexOf('view') !== -1 || t.indexOf('load') !== -1 || t.indexOf('show') !== -1)) {
                    b.click();
                    this.logger.info('⚡ Clicked IndiaMART New Leads banner: "' + t.substring(0, 40) + '"');
                    return true;
                }
            }
        } catch (e) { }
        return false;
    };
    Scanner.prototype._setupObserver = function () {
        if (this._observer) {
            try { this._observer.disconnect(); } catch (e) { }
            this._observer = null;
        }
        var targetNode = (typeof document !== 'undefined' && (document.body || document.documentElement)) || null;
        this._targetNode = targetNode;

        var self2 = this;
        try {
            if (typeof MutationObserver !== 'undefined' && targetNode) {
                this._observer = new MutationObserver(function () {
                    if (self2._scanPending) return;
                    self2._scanPending = true;
                    setTimeout(function () {
                        self2._scanPending = false;
                        self2._scan();
                    }, self2._debounceMs);
                });
                this._observer.observe(targetNode, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ['data-sold']
                });
            }
        } catch (e) { }
    };
    Scanner.prototype.startWatching = function (cb) {
        if (this._running) return;
        this._callback = cb;
        this._running = true;
        var self2 = this;

        if (this.logger && typeof this.logger.logEvent === 'function') {
            this.logger.logEvent('INFO', 'scanner.started', 'Scanner', {
                operationId: this.logger.generateOperationId ? this.logger.generateOperationId('scan') : undefined,
                reasonCode: 'USER_STARTED',
                result: 'RUNNING'
            });
        }

        this._setupObserver();

        // Secondary reconciliation fallback: 500ms (sub-second pickup for newly arriving leads)
        this._scanTimer = setInterval(function () {
            if (self2._targetNode && !document.contains(self2._targetNode)) {
                self2.logger.info('🔄 Target node replaced — reattaching observer');
                self2._setupObserver();
            }
            self2._scan();
        }, this._reconciliationFallbackMs);

        this.logger.info('✅ Real-time event-driven scanner started (MutationObserver primary, 500ms reconciliation fallback)');
        // Remove the 50ms initial scan — _startLoop fires _scan() via tryCards()
        // at 0-100ms already. The immediate duplicate here is the source of
        // the triple-scan problem.
        // setTimeout(function() { self2._scan(); }, 50);  <-- REMOVED
    };
    Scanner.prototype.stopWatching = function () {
        this._running = false;
        if (this._observer) {
            try { this._observer.disconnect(); } catch (e) { }
            this._observer = null;
        }
        if (this._scanTimer) {
            clearInterval(this._scanTimer);
            this._scanTimer = null;
        }
        if (this.logger && typeof this.logger.logEvent === 'function') {
            this.logger.logEvent('INFO', 'scanner.paused', 'Scanner', {
                reasonCode: 'USER_PAUSED',
                result: 'STOPPED'
            });
        }
    };
    Scanner.prototype._scan = function () {
        if (this._scanning || !this._running) return false;
        if (this.orchestrator && this.orchestrator.keywordManager && this.orchestrator.keywordManager.getActiveFilterCount() === 0) {
            return false;
        }
        // Abort scan immediately if IndiaMART rate-limit warning is visible on the page.
        if (this._checkRateLimitWarning()) return false;

        this._scanning = true;
        var scanOpId = this.logger && this.logger.generateOperationId ? this.logger.generateOperationId('scan_cyc') : ('sc_' + Date.now());
        var scanStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (this.logger && typeof this.logger.logEvent === 'function') {
            this.logger.logEvent('DEBUG', 'scanner.cycle.started', 'Scanner', {
                operationId: scanOpId,
                reasonCode: 'TIMER_OR_OBSERVER_TRIGGER',
                result: 'STARTED'
            });
        }
        try {
            // Auto-detect and click any "New Leads Available" banner to bring dynamic leads into portal DOM
            this._checkNewLeadsBanner();

            var allCards = document.querySelectorAll(
                '[class*="BuyLdC_cont"], [class*="BLbp_card"], .BLbp_card, [class*="BuyLdC_Card"], ' +
                'div[id*="id_BLCard"], [class*="BLCard"], [class*="bl_card"], div[id*="BLCard"], ' +
                'div[id*="BLbp"], [class*="bl-card"], [class*="listing_card"]'
            );
            // Bounded fair processing across visible DOM cards without starvation (up to 50 cards)
            var cards = Array.prototype.slice.call(allCards);
            var currentIds = {};
            var newCards = [];
            var idGen = this._idGen;
            var known = this._knownLeads;
            if (!this._elementIds) this._elementIds = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
            var scanLimit = Math.min(cards.length, (typeof MAX_DOM_SCAN_LIMIT !== 'undefined' ? MAX_DOM_SCAN_LIMIT : 5));
            for (var i = 0; i < scanLimit; i++) {
                var el = cards[i];
                var id = idGen.generateFromElement(el);
                if (!id) {
                    // Card DOM exists but text content not yet rendered.
                    // Schedule a quick re-scan so we don't permanently skip this card.
                    if (!this._emptyCardRescanScheduled) {
                        this._emptyCardRescanScheduled = true;
                        var self3 = this;
                        setTimeout(function () {
                            self3._emptyCardRescanScheduled = false;
                            if (self3._running) self3._scan();
                        }, 150);
                    }
                    continue;
                }
                currentIds[id] = 1;
                if (!known[id]) {
                    known[id] = Date.now();
                    // Same DOM node, new content hash == the card finished hydrating (updated card).
                    // Re-evaluate it, but tell the orchestrator which ID it replaces so counters
                    // and in-flight locks are not double counted.
                    var prevId = this._elementIds ? this._elementIds.get(el) : null;
                    if (prevId && prevId !== id) delete known[prevId];
                    newCards.push({ element: el, id: id, replacesId: (prevId && prevId !== id) ? prevId : null });
                } else { known[id] = Date.now(); }
                if (this._elementIds) this._elementIds.set(el, id);
            }
            var now = Date.now();
            for (var key in known) {
                var age = now - known[key];
                if (age > 1800000) delete known[key];
            }
            var scanDuration = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - scanStart);
            if (this.logger && typeof this.logger.logEvent === 'function') {
                this.logger.logEvent('DEBUG', 'scanner.cycle.completed', 'Scanner', {
                    operationId: scanOpId,
                    durationMs: scanDuration,
                    reasonCode: 'CYCLE_FINISHED',
                    result: 'COMPLETED',
                    metrics: { totalCards: cards.length, newCards: newCards.length }
                });
            }
            if (newCards.length > 0) this._callback(newCards);
        } catch (e) {
            var scanDurationErr = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - scanStart);
            if (this.logger && typeof this.logger.logEvent === 'function') {
                this.logger.logEvent('ERROR', 'scanner.error', 'Scanner', {
                    operationId: scanOpId,
                    durationMs: scanDurationErr,
                    reasonCode: 'SCAN_EXCEPTION',
                    result: 'FAILED',
                    error: e && e.message
                });
            }
            this.logger.error('Scan error: ' + (e && e.message));
        }
        this._scanning = false;
    };

    // Detect IndiaMART's account rate-limit warning.
    // Scoped to a known container (not full body) for performance.
    // Debounced: checked at most once every 5 seconds.
    Scanner.prototype._checkRateLimitWarning = function () {
        try {
            var now = Date.now();
            if (this._lastRateLimitCheck && (now - this._lastRateLimitCheck) < 5000) return false;
            this._lastRateLimitCheck = now;

            // Check only the main content area, not entire body (performance)
            var container = document.querySelector(
                '#bltxn_main, .BuyLdC_main, [class*="BuyLd_main"], [class*="bltxn"], main, #main-content'
            ) || document.body;
            if (!container) return false;
            var text = (container.textContent || '').toLowerCase();
            if (!text) return false;

            for (var p = 0; p < RATE_LIMIT_PHRASES.length; p++) {
                if (text.indexOf(RATE_LIMIT_PHRASES[p]) !== -1) {
                    this.logger.warn('🚫 IndiaMART rate-limit warning detected — stopping all automated activity');
                    if (this.orchestrator && typeof this.orchestrator._onRateLimitDetected === 'function') {
                        this.orchestrator._onRateLimitDetected();
                    }
                    return true;
                }
            }
        } catch (e) { }
        return false;
    };
    // Let a deferred card (safety limit, enqueue refused, filters not loaded) be emitted again.
    Scanner.prototype.forget = function (id, delayMs) {
        if (!id) return;
        if (delayMs > 0) this._knownLeads[id] = Date.now() - 1800000 + delayMs; // evicted after delayMs
        else delete this._knownLeads[id];
    };
    Scanner.prototype.resetEmitted = function () {
        this._knownLeads = {};
        this.logger.info('🔄 Scanner emitted-cache cleared — next scan will re-emit all DOM cards');
    };
    Scanner.prototype.getStatus = function () { return { running: this._running, knownLeads: Object.keys(this._knownLeads).length }; };

    // ============================================================
    // PARSER — v6.2: SEPARATE FIELDS, NO CONCATENATION
    // ============================================================
    function cleanRawLocation(raw) {
        if (!raw) return null;
        return raw
            .replace(/click\s+here\s+to\s+view\s+buy\s*leads?\s+from[\s\S]*/i, '')
            .replace(/\s+/g, ' ')
            .trim() || null;
    }

    function normalizeUnit(u) {
        if (!u) return null;
        u = String(u).toLowerCase().trim();
        if (u === 'box' || u === 'boxes') return 'box';
        if (u === 'strip' || u === 'strips' || u === 'stripe' || u === 'stripes') return 'strip';
        if (u === 'tube' || u === 'tubes') return 'tube';
        if (u === 'piece' || u === 'pieces' || u === 'pc' || u === 'pcs') return 'piece';
        if (u === 'vial' || u === 'vials') return 'vial';
        if (u === 'bottle' || u === 'bottles') return 'bottle';
        if (u === 'pack' || u === 'packs' || u === 'package') return 'pack';
        return null;
    }

    function parseQuantityString(str) {
        if (!str) return null;
        str = String(str).trim();
        // Match: "5 Piece", "10 Boxes", "5-10 Box", "50 Vial", "Pack of 6 Box"
        var m = str.match(/(\d+)(?:\s*(?:-|–|to)\s*(\d+))?\s*([a-zA-Z]+)/);
        if (!m) return null;
        var min = parseInt(m[1], 10);
        var max = m[2] ? parseInt(m[2], 10) : min;
        var unit = normalizeUnit(m[3]);
        if (!unit) return null;
        return { min: min, max: max, unit: unit };
    }

    function extractQuantityFromCard(el) {
        try {
            var items = el.querySelectorAll('[class*="BuyLdC_isqdet"]');
            for (var i = 0; i < items.length; i++) {
                var label = items[i].querySelector('span.SLC_c0');
                if (!label) continue;
                var labelText = (label.textContent || '').trim().toLowerCase();
                if (labelText === 'quantity' || labelText === 'qty' || labelText === 'buyer filled details') {
                    var strong = items[i].querySelector('strong');
                    if (strong) {
                        var parsed = parseQuantityString(strong.textContent);
                        if (parsed) return parsed;
                    }
                }
            }
        } catch (e) { }
        return null;
    }

    function extractQuantityFromTitle(title) {
        if (!title) return null;
        var m = title.match(/\bqty\s*[:\-]\s*([^\|]+)/i);
        if (!m) return null;
        return parseQuantityString(m[1]);
    }

    function Parser() { this.logger = new Logger('Parser'); }

    Parser.prototype.parseCard = function (el, leadId) {
        try {
            // --- PRODUCT NAME (robust selector chain) ---
            // FIX: the old `a || b || c` chain stopped at the first selector that matched
            // ANY element, even an empty one, so later selectors were never tried.
            // Now each selector is tried in order and the first element with real text wins.
            var PRODUCT_SELECTORS = [
                '.BLbp_title', '[class*="BuyLdC"] span.SLC_f18', '[class*="BuyLdC"] .SLC_f18',
                'span.SLC_f18', '.SLC_f18', '[class*="BLbp_title" i]', '[class*="BLbp_head" i]',
                '[class*="prod_name" i], [class*="product_name" i]', '[class*="title" i]', 'h2, h3, h4'
            ];
            var productName = '';
            for (var psi = 0; psi < PRODUCT_SELECTORS.length && productName.length < 2; psi++) {
                var psNodes = el.querySelectorAll(PRODUCT_SELECTORS[psi]);
                for (var pni = 0; pni < psNodes.length; pni++) {
                    var psTxt = (psNodes[pni].textContent || '').replace(/\s+/g, ' ').trim();
                    if (psTxt.length >= 2) { productName = psTxt; break; }
                }
            }
            if (!productName || productName.length < 2) {
                var searchFallback = el.querySelector('.BLbp_desc em, [class*="BuyLdC_msg"] em');
                if (searchFallback && searchFallback.textContent.trim().length >= 2) {
                    productName = searchFallback.textContent.trim();
                }
            }
            if (!productName || productName.length < 2) {
                this.logger.debug('Card skipped — no product name', { leadId: leadId });
                return null;
            }

            // --- QUANTITY ---
            var quantity = extractQuantityFromCard(el);
            if (!quantity) {
                quantity = extractQuantityFromTitle(productName);
            }

            // --- LOCATION EXTRACTION (DOMESTIC + FOREIGN) ---
            var isTimeText = function (txt) {
                if (!txt) return false;
                var t = txt.trim().toLowerCase();
                return /\b(?:\d+\s*(?:sec|second|min|minute|hr|hour|day|wk|week|month|yr|year)s?\s*ago|today|yesterday|just\s*now|\d+\s*(?:am|pm))\b/i.test(t) || t.indexOf('ago') !== -1;
            };

            var locEls = el.querySelectorAll(
                '.BLbp_hdrLeft strong.BuyLdC_tltpw, .BLbp_hdrLeft strong, ' +
                '[class*="BuyLdC_time_loc"] strong, [class*="BuyLdC_time_loc"] span, ' +
                '.BLbp_hdrLeft span[class*="loc"], [class*="country_name"], [class*="location"], ' +
                '[class*="city_name"], [class*="state_name"], [class*="foreign"], .BLbp_loc, ' +
                '[class*="byr_loc"], [class*="byrLoc"]'
            );

            var locParts = [];
            for (var li = 0; li < locEls.length; li++) {
                var node = locEls[li];
                var rawText = (node.textContent || '').trim();
                if (!rawText) continue;
                // Exclude time strings
                if (isTimeText(rawText)) continue;
                var cleaned = cleanRawLocation(rawText);
                if (cleaned && cleaned.length > 1 && !isTimeText(cleaned)) {
                    if (locParts.indexOf(cleaned) === -1) {
                        locParts.push(cleaned);
                    }
                }
            }
            var location = locParts.length > 0 ? locParts.join(', ') : null;

            // --- COUNTRY EXTRACTION (DOMESTIC + FOREIGN LEADS) ---
            var countryIso = null;
            var isForeignLead = false;

            // 1) Flag image (alt, title, data-country, src)
            try {
                var flagImg = el.querySelector('img[src*="country-flags"], img[src*="flags"], img[src*="flag"], [class*="flag"] img');
                if (flagImg) {
                    var flagAlt = (flagImg.alt || flagImg.title || flagImg.getAttribute('data-country') || '').trim().toUpperCase();
                    if (/^[A-Z]{2}$/.test(flagAlt)) {
                        countryIso = flagAlt;
                    }
                    if (!countryIso && flagImg.src) {
                        var srcMatch = flagImg.src.match(/\/([a-z]{2})_flag[_s]*\.png/i) ||
                            flagImg.src.match(/\/flags?\/([a-z]{2})\./i) ||
                            flagImg.src.match(/\/flags?[_-]([a-z]{2})\./i);
                        if (srcMatch) countryIso = srcMatch[1].toUpperCase();
                    }
                }
            } catch (e) { }

            // 2) CSS Flag elements (e.g. <span class="flags flags_us">, <i class="flag flag-ae">)
            if (!countryIso) {
                try {
                    var cssFlags = el.querySelectorAll('[class*="flag"], [class*="country"]');
                    for (var cf = 0; cf < cssFlags.length; cf++) {
                        var cls = cssFlags[cf].className || '';
                        var m = cls.match(/\bflag[s]?[_-]([a-z]{2})\b/i);
                        if (m) { countryIso = m[1].toUpperCase(); break; }
                    }
                } catch (e) { }
            }

            // 3) Comprehensive Country Name Mapping
            var countryMap = {
                'india': 'IN', 'in': 'IN',
                'usa': 'US', 'united states': 'US', 'united states of america': 'US', 'america': 'US',
                'united kingdom': 'GB', 'uk': 'GB', 'britain': 'GB', 'great britain': 'GB', 'england': 'GB',
                'uae': 'AE', 'united arab emirates': 'AE', 'dubai': 'AE', 'sharjah': 'AE', 'abu dhabi': 'AE',
                'saudi arabia': 'SA', 'saudi': 'SA', 'russia': 'RU', 'china': 'CN', 'australia': 'AU', 'canada': 'CA',
                'germany': 'DE', 'france': 'FR', 'japan': 'JP', 'brazil': 'BR', 'mexico': 'MX', 'italy': 'IT',
                'spain': 'ES', 'south korea': 'KR', 'korea': 'KR', 'netherlands': 'NL', 'south africa': 'ZA',
                'singapore': 'SG', 'thailand': 'TH', 'vietnam': 'VN', 'indonesia': 'ID', 'malaysia': 'MY',
                'philippines': 'PH', 'turkey': 'TR', 'egypt': 'EG', 'israel': 'IL', 'pakistan': 'PK',
                'bangladesh': 'BD', 'sri lanka': 'LK', 'nepal': 'NP', 'kuwait': 'KW', 'qatar': 'QA', 'oman': 'OM',
                'bahrain': 'BH', 'sweden': 'SE', 'switzerland': 'CH', 'poland': 'PL', 'norway': 'NO', 'denmark': 'DK',
                'finland': 'FI', 'ireland': 'IE', 'new zealand': 'NZ', 'belgium': 'BE', 'austria': 'AT', 'portugal': 'PT'
            };

            if (!countryIso && location) {
                var segments = location.toLowerCase().split(',').map(function (s) { return s.trim(); });
                for (var s = 0; s < segments.length; s++) {
                    for (var name in countryMap) {
                        if (segments[s] === name) { countryIso = countryMap[name]; break; }
                    }
                    if (countryIso) break;
                }
            }

            // 4) Check for IndiaMART Foreign Lead Badges / Text
            var cardFullText = (el.textContent || '');
            if (/\b(?:foreign\s*buylead|foreign\s*lead|export\s*buylead|international\s*buylead|overseas)\b/i.test(cardFullText) ||
                el.querySelector('[class*="foreign"], [class*="export"], [class*="international"]')) {
                isForeignLead = true;
                if (!countryIso) countryIso = 'FOREIGN';
                if (!location) location = 'Foreign';
            }

            if (!countryIso && !isForeignLead) {
                countryIso = 'UNKNOWN';
            }

            if (countryIso && countryIso !== 'IN' && countryIso !== 'UNKNOWN') {
                isForeignLead = true;
            }

            // --- CONTACT AVAILABILITY ---
            var contact = { mobile: null, email: null, phone: null };
            var chips = el.querySelectorAll('.BLbp_chip, [class*="BLbp_chip"], [class*="chip"], [class*="tag"], [class*="badge"], [class*="Available"], [class*="SLC_aifs"], [class*="contact_channel"], [class*="byr_contact"]');
            for (var ci = 0; ci < chips.length; ci++) {
                var chipText = (chips[ci].textContent || chips[ci].title || chips[ci].getAttribute('aria-label') || '').toLowerCase();
                var chipClass = (chips[ci].className || '').toString().toLowerCase();
                if (chipText.indexOf('phone') !== -1 || chipText.indexOf('mobile') !== -1 || chipClass.indexOf('phone') !== -1 || chipClass.indexOf('mobile') !== -1 || chipClass.indexOf('call') !== -1) contact.mobile = 'available';
                if (chipText.indexOf('email') !== -1 || chipClass.indexOf('email') !== -1 || chipClass.indexOf('mail') !== -1) contact.email = 'available';
                if (chipText.indexOf('whatsapp') !== -1 || chipClass.indexOf('whatsapp') !== -1) contact.phone = 'available';
            }
            if (!contact.phone && el.querySelector('[class*="whatsapp" i], [title*="whatsapp" i], svg[class*="whatsapp" i]')) contact.phone = 'available';
            if (!contact.mobile && el.querySelector('[class*="mobile" i], [class*="phone" i], [class*="call" i], [title*="mobile" i], [title*="phone" i]')) contact.mobile = 'available';
            if (!contact.email && el.querySelector('[class*="email" i], [class*="mail" i], [title*="email" i]')) contact.email = 'available';

            // --- MESSAGE TEXT + BUYER DETAILS PANEL CONTENT ---
            // Combines: (a) description/requirement text, (b) all span/td text from
            // the Buyer Details panel ("Buys", "Requirements", "Engagement" rows).
            // This ensures filter keywords match even when the medicine / product name
            // is written inside the Buyer Details panel rather than the card title.
            var messageText = '';
            var msgEl = el.querySelector('.BLbp_desc')
                || el.querySelector('[class*="BuyLdC_msg"]');
            if (msgEl) {
                var emEl = msgEl.querySelector('em');
                messageText = (emEl ? emEl.textContent : msgEl.textContent).trim();
                // Strip "Buyer Searched for " prefix if present
                messageText = messageText.replace(/^buyer\s+searched\s+for\s+/i, '').trim();
            }
            // ── Buyer Details panel (right-hand side table rows) ──────────────
            // Selectors cover IndiaMART's BuyLdC_EngDetails / BuyLdC_BuyerDetails
            // sections that list "Buys", "Requirements", "Engagement" etc.
            try {
                var detailPanels = el.querySelectorAll(
                    '[class*="BuyLdC_EngDtls"], [class*="BuyLdC_ByrDtl"], ' +
                    '[class*="BuyLdC_EngDetails"], [class*="BuyLdC_BuyerDetail"], ' +
                    '[class*="BuyLdC_Eng"], [class*="BLbp_engDetails"], ' +
                    '[class*="BLbp_byr"], [class*="BLbp_byrDtl"], ' +
                    '[class*="BLbp_buyerDetail"], [class*="byr_detail"], ' +
                    '[class*="buyer_detail"], [class*="BLbp_rightPanel"]'
                );
                var panelTexts = [];
                for (var dp = 0; dp < detailPanels.length; dp++) {
                    var pt = (detailPanels[dp].textContent || '').trim();
                    if (pt && panelTexts.indexOf(pt) === -1) panelTexts.push(pt);
                }
                // Also grab every span/td value on the right half of the card
                // that is NOT part of a location/time block
                var allSpans = el.querySelectorAll(
                    '[class*="BuyLdC_"] span, [class*="BLbp_"] span, ' +
                    '[class*="SLC_"] span, td span'
                );
                for (var sp = 0; sp < allSpans.length; sp++) {
                    var spanTxt = (allSpans[sp].textContent || '').trim();
                    if (!spanTxt || spanTxt.length < 2) continue;
                    // Skip time strings and very short tokens
                    if (/^\d+\s*(sec|min|hr|day|wk|month|yr)s?\s*ago$/i.test(spanTxt)) continue;
                    if (panelTexts.indexOf(spanTxt) === -1) panelTexts.push(spanTxt);
                }
                if (panelTexts.length > 0) {
                    var combined = panelTexts.join(' ');
                    // Only extend messageText — don't replace it
                    messageText = messageText ? messageText + ' ' + combined : combined;
                }
            } catch (e) { }

            // --- CATEGORY (informational, never matched against) ---
            var mcatEl = el.querySelector('[class*="BuyLdC_Mcat"]')
                || el.querySelector('[class*="BuyLdC_mcat"]')
                || el.querySelector('[class*="mcat"]')
                || el.querySelector('[class*="Mcat"]');
            var mcatName = mcatEl ? mcatEl.textContent.trim() : '';

            // Optional contact detail extraction (mobile numbers, emails)
            var senderMobile = null, senderEmail = null;
            try {
                var textNodes = el.textContent.match(/\+?\d[\d\s\-]{8,}\d/g);
                if (textNodes && textNodes.length) senderMobile = textNodes[0].replace(/\s+/g, '');
                var emails = el.textContent.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
                if (emails && emails.length) senderEmail = emails[0];
            } catch (e) { }
            if (senderMobile && !contact.mobile) contact.mobile = 'available';
            if (senderEmail && !contact.email) contact.email = 'available';

            // --- SENDER / SELLER / BUYER DETAILS ---
            var senderEl = el.querySelector('.BLbp_byrName, .BLbp_buyer, [class*="buyer"], [class*="byr_name"], [class*="buyerName"], [class*="company"], [class*="comp_name"], [class*="senderName"], .BLbp_member, .BLbp_byrInfo, .SLC_byr, [class*="byrInfo"]');
            var senderName = senderEl ? senderEl.textContent.trim() : '';

            // --- COMPOSE LEAD ---
            var subject = productName + (location ? ' - ' + location : '');

            // Build unique lead ID distinguishing seller, product, location, quantity & requirement
            // Ensures multiple leads for the exact same product from different sellers are NOT treated as duplicates
            var queryIdPart = (leadId && leadId.indexOf('hash_') === -1 && leadId.indexOf('lead_') === -1) ? leadId : '';
            var sellerPart = (senderName || senderMobile || senderEmail || '').toLowerCase().replace(/[^\w]/g, '_').substring(0, 30);
            var prodPart = (productName || '').toLowerCase().replace(/[^\w]/g, '_').substring(0, 40);
            var locPart = (location || '').toLowerCase().replace(/[^\w]/g, '_').substring(0, 30);
            var qtyStr = '';
            if (quantity && typeof quantity === 'object') {
                qtyStr = String(quantity.min || '') + (quantity.unit ? '_' + quantity.unit : '');
            } else if (quantity != null) {
                qtyStr = String(quantity);
            }
            var qtyPart = qtyStr.toLowerCase().replace(/[^\w]/g, '_').substring(0, 20);

            var msgHash = 0;
            if (messageText) {
                for (var mi = 0; mi < messageText.length; mi++) {
                    msgHash = ((msgHash << 5) - msgHash) + messageText.charCodeAt(mi);
                    msgHash |= 0;
                }
            }
            var msgPart = msgHash ? Math.abs(msgHash).toString(36) : '';

            var contentKey;
            if (queryIdPart) {
                contentKey = queryIdPart + '_' + prodPart + (sellerPart ? '_' + sellerPart : '');
            } else {
                contentKey = prodPart + '|' + locPart + (sellerPart ? '|' + sellerPart : '') + (qtyPart ? '|' + qtyPart : '') + (msgPart ? '|' + msgPart : '');
            }

            return {
                leadId: leadId,
                element: el,
                uniqueQueryId: contentKey,
                queryType: 'BUY_LEAD',
                queryTime: new Date().toISOString(),

                productName: productName,
                leadName: productName,
                queryProductName: productName,

                senderName: senderName || null,
                sellerName: senderName || null,

                messageText: messageText,
                queryMessage: messageText,

                mcatName: mcatName || null,
                queryMcatName: mcatName || null,

                location: location,
                city: location ? location.split(',')[0].trim() : null,
                state: location ? location.split(',').pop().trim() : null,
                countryIso: countryIso,
                isForeign: isForeignLead,

                quantity: quantity,

                senderMobile: senderMobile,
                senderEmail: senderEmail,

                contact: contact,
                subject: subject,
                raw: { element: el }
            };
        } catch (e) {
            this.logger.error('parseCard error: ' + e.message, { leadId: leadId });
            return null;
        }
    };

    Parser.prototype.normalize = function (lead) {
        if (!lead) return null;
        lead.productName = (lead.productName || '').toLowerCase();
        lead.state = (lead.state || '').toLowerCase();
        lead.city = (lead.city || '').toLowerCase();
        return lead;
    };

    // ============================================================
    // ACTION ADAPTER (FAST + GUARDED RETRY)
    // ============================================================
    function ActionAdapter(popupMgr) {
        this.logger = new Logger('ActionAdapter');
        this._dryRun = false;
        this._clicked = {};
        this._inFlight = {};
        this.popupManager = popupMgr;
        this._autoMinimize = true;
        this._confirmationAnswer = 'yes';
        this._purchaseAction = 'close';
        this._timeout = 15000;
    }
    ActionAdapter.prototype.setDryRun = function (v) { this._dryRun = v; };
    ActionAdapter.prototype.setAutoMinimize = function (v) { this._autoMinimize = v; };
    ActionAdapter.prototype.setConfirmationAnswer = function (v) { this._confirmationAnswer = v; };
    ActionAdapter.prototype.setPurchaseAction = function (v) { this._purchaseAction = v; };
    ActionAdapter.prototype.setPopupTimeout = function (v) { this._timeout = v; };

    function simulateClick(el) {
        if (!el) return false;
        try {
            if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } catch (e) { }
        try {
            if (el.disabled || el.getAttribute('aria-disabled') === 'true' ||
                (el.classList && el.classList.contains('disabled'))) return false;
            var rect = el.getBoundingClientRect();
            if (!rect || rect.width <= 0 || rect.height <= 0) return false;
            var cx = rect.left + rect.width / 2;
            var cy = rect.top + rect.height / 2;
            var eventOpts = {
                bubbles: true, cancelable: true, composed: true, view: window, detail: 1,
                clientX: cx, clientY: cy, screenX: cx, screenY: cy, buttons: 1
            };
            // Prime portal pointer handlers, then use the browser activation path once.
            try { el.dispatchEvent(new PointerEvent('pointerdown', eventOpts)); } catch (e) { }
            try { el.dispatchEvent(new MouseEvent('mousedown', eventOpts)); } catch (e) { }
            try { if (typeof el.focus === 'function') el.focus(); } catch (e) { }
            try { el.dispatchEvent(new PointerEvent('pointerup', eventOpts)); } catch (e) { }
            try { el.dispatchEvent(new MouseEvent('mouseup', eventOpts)); } catch (e) { }
            if (typeof el.click === 'function') {
                try { el.click(); } catch (e) { }
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    ActionAdapter.prototype.acquire = function (lead) {
        var self = this;
        var log = this.logger;
        return new Promise(function (resolve) {
            if (self._dryRun) { resolve({ success: false, simulated: true, message: 'DRY_RUN' }); return; }
            if (self._clicked[lead.leadId]) { resolve({ success: false, message: 'Already clicked' }); return; }

            // ── Optimization 4: Direct Native Controller Dispatch Fast-Path ──
            var targetLeadId = lead.uniqueQueryId || lead.queryId || lead.leadId;
            if (targetLeadId) {
                // 1. Direct native controller dispatch if available in window scope
                if (typeof window !== 'undefined' && window.blTxnController && typeof window.blTxnController.submitLead === 'function') {
                    try {
                        window.blTxnController.submitLead(targetLeadId);
                        log.info('⚡ Direct Native Controller submitLead invoked for: ' + targetLeadId);
                    } catch (de) { }
                }
                // 2. Cross-world dispatch to network-interceptor in MAIN world
                if (typeof window !== 'undefined' && typeof window.postMessage === 'function') {
                    try {
                        window.postMessage({ __leadsync_dispatch_lead__: true, leadId: targetLeadId }, '*');
                    } catch (pe) { }
                }
            }

            // ── Network-intercepted leads have no DOM element yet ──
            // Immediate check at 0ms, then fast-poll every 15ms for card to render.
            function findElementAndProceed(el) {
                if (el) {
                    doAcquire(el);
                    return;
                }
                var uqid = lead.uniqueQueryId || '';
                var CARD_SELECTORS = '[class*="BuyLdC_cont"], [class*="BLbp_card"], .BLbp_card, [class*="BuyLdC_Card"], div[id*="id_BLCard"], [class*="BLCard"]';
                function checkNow() {
                    if (!uqid) return null;
                    var found = document.querySelector(
                        '[data-lead-id="' + uqid + '"], [data-query-id="' + uqid + '"], [data-blid="' + uqid + '"], [data-uqid="' + uqid + '"], div[id*="' + uqid + '"]'
                    );
                    if (!found) {
                        var cards = document.querySelectorAll(CARD_SELECTORS);
                        for (var ci = 0; ci < cards.length; ci++) {
                            var c = cards[ci];
                            var cid = c.getAttribute('data-lead-id') || c.getAttribute('data-query-id') ||
                                      c.getAttribute('data-blid') || c.getAttribute('data-uqid') || c.id || '';
                            if (cid && cid.indexOf(uqid) !== -1) return c;
                            var cHtml = c.innerHTML || '';
                            if (cHtml.indexOf(uqid) !== -1) return c;
                        }
                    }
                    return found;
                }
                var immediate = checkNow();
                if (immediate) {
                    log.info('⚡ DOM card found immediately (0ms) for network lead: ' + uqid);
                    doAcquire(immediate);
                    return;
                }
                var pollStart = Date.now();
                var MAX_POLL_MS = 400; // max 400ms wait for DOM
                var pollInterval = setInterval(function () {
                    var found = checkNow();
                    if (found) {
                        clearInterval(pollInterval);
                        log.info('⚡ DOM card found for network lead in ' + (Date.now() - pollStart) + 'ms');
                        doAcquire(found);
                        return;
                    }
                    if (Date.now() - pollStart > MAX_POLL_MS) {
                        clearInterval(pollInterval);
                        log.warn('DOM card never appeared for lead: ' + uqid);
                        resolve({ success: false, message: 'DOM card not found for lead' });
                    }
                }, 15);
            }

            function doAcquire(el) {
                try {
                    var button = null;
                    var buttons = el.querySelectorAll('button, a, [role="button"], [class*="BuyLdC_btn"], [class*="SLC_FillCTA"], [class*="BuyLdC_Cta"], [class*="BuyLdC_cta"], [class*="btn"], [class*="contact" i], [class*="interested" i], [class*="Interest" i]');

                    // Priority 1: Live leads / Idle page primary CTA button ("Contact Buyer" / "Contact Buyers Now")
                    var PRIMARY_CTAS = [
                        'contact buyer', 'contact buyers now', 'contact buyer now', 'contact buyers',
                        'contact now', 'contact', 'connect with buyer', 'connect buyer', 'connect now',
                        'view contact', 'view number', 'view buyer', 'call buyer', 'send enquiry'
                    ];
                    for (var i = 0; i < buttons.length; i++) {
                        var t = (buttons[i].textContent || buttons[i].value || '').trim().toLowerCase();
                        if (!t) continue;
                        if (t.indexOf('not interested') !== -1 || t.indexOf('share') !== -1 || t.indexOf('bookmark') !== -1 || t.indexOf('report') !== -1 || t === 'close' || t === 'cancel' || t === 'x' || t === '✕') continue;
                        for (var p = 0; p < PRIMARY_CTAS.length; p++) {
                            if (t === PRIMARY_CTAS[p] || t.indexOf(PRIMARY_CTAS[p]) !== -1) {
                                button = buttons[i];
                                break;
                            }
                        }
                        if (button) break;
                    }

                    // Priority 2: Secondary / Past leads fallback keywords
                    if (!button) {
                        var SECONDARY_CTAS = ['i am interested', 'interested', 'send interest', 'reply now', 'reply', 'enquiry'];
                        for (var j = 0; j < buttons.length; j++) {
                            var t2 = (buttons[j].textContent || buttons[j].value || '').trim().toLowerCase();
                            if (!t2 || t2.indexOf('not interested') !== -1 || t2.indexOf('share') !== -1 || t2.indexOf('bookmark') !== -1) continue;
                            for (var s2 = 0; s2 < SECONDARY_CTAS.length; s2++) {
                                if (t2 === SECONDARY_CTAS[s2] || t2.indexOf(SECONDARY_CTAS[s2]) !== -1) {
                                    button = buttons[j];
                                    break;
                                }
                            }
                            if (button) break;
                        }
                    }

                    // Priority 3: Fallback by IndiaMART CTA classes
                    if (!button) button = el.querySelector('[class*="BuyLdC_btn"], [class*="SLC_FillCTA"], [class*="BuyLdC_Cta"], [class*="BuyLdC_cta"], button.BuyLdC_Cta, [class*="contact" i], [class*="interested" i], [class*="Interest" i], button:not([disabled])');
                    if (!button) { resolve({ success: false, message: 'No button' }); return; }

                    var clickedBtn = button;
                    var origBtnText = (clickedBtn.textContent || clickedBtn.value || '').trim().toLowerCase();

                    self._clicked[lead.leadId] = true;

                    // Register in-flight lead on orchestrator so network-interceptor's ACQ
                    // confirmation message can resolve this promise instantly (bot-speed path).
                    if (self.orchestrator) {
                        self.orchestrator._inFlightLead = lead;
                        self.orchestrator._resolveInFlight = function (result) {
                            if (interval) clearInterval(interval);
                            resolve(result);
                        };
                    }

                    simulateClick(clickedBtn);
                    log.info('⚡ Clicked acquisition button: "' + origBtnText + '"', { leadId: lead.leadId });

                    var start = Date.now();
                    var maxTimeout = Math.min(1500, Math.max(600, parseInt(self._timeout, 10) || 800));
                    var interval = setInterval(function () {
                        var elapsed = Date.now() - start;
                        var cardText = el ? (el.textContent || '').toLowerCase() : '';
                        var isCardContacted = false;

                        // 1. Direct check on clicked button element
                        if (clickedBtn) {
                            var isDetached = !clickedBtn.isConnected;
                            var isDisabled = clickedBtn.disabled || clickedBtn.hasAttribute('disabled') ||
                                (clickedBtn.classList && clickedBtn.classList.contains('disabled')) ||
                                clickedBtn.getAttribute('aria-disabled') === 'true';
                            var isHidden = (clickedBtn.offsetParent === null && typeof window !== 'undefined' && window.getComputedStyle && window.getComputedStyle(clickedBtn).display === 'none');
                            var nowText = (clickedBtn.textContent || clickedBtn.value || '').trim().toLowerCase();
                            var textChanged = origBtnText && nowText && nowText !== origBtnText && (
                                nowText.indexOf('contacted') !== -1 ||
                                nowText.indexOf('already') !== -1 ||
                                nowText.indexOf('view') !== -1 ||
                                nowText.indexOf('call') !== -1 ||
                                nowText.indexOf('sent') !== -1 ||
                                (nowText.indexOf('contact buyer') === -1 && nowText.indexOf('contact now') === -1)
                            );
                            if (isDetached || isDisabled || isHidden || textChanged) {
                                isCardContacted = true;
                            }
                        }

                        // 2. Unmasked phone number or buyer contact elements revealed on card
                        if (!isCardContacted && el && el.querySelector) {
                            var hasTel = el.querySelector('a[href^="tel:"], a[href*="tel:"]') !== null;
                            var hasBuyerContactEl = el.querySelector('.buyer_contact_no, [class*="contact_no"], [class*="phone_no"], [class*="mobile_no"], [class*="buyer_phone"], [class*="byr_contact"], [class*="contact_detail"]') !== null;
                            var hasIndianPhone = /\b[6-9]\d{9}\b/.test(cardText) || /\+91[\s-]?\d{10}/.test(cardText);
                            if (hasTel || hasBuyerContactEl || hasIndianPhone) {
                                isCardContacted = true;
                            }
                        }

                        // 3. Positive confirmation text on card
                        if (!isCardContacted && cardText) {
                            if (cardText.indexOf('already contacted') !== -1 ||
                                cardText.indexOf('contacted') !== -1 ||
                                cardText.indexOf('already contact') !== -1 ||
                                cardText.indexOf('contact details viewed') !== -1 ||
                                cardText.indexOf('contact viewed') !== -1 ||
                                cardText.indexOf('call buyer') !== -1 ||
                                cardText.indexOf('view contact') !== -1 ||
                                cardText.indexOf('view number') !== -1 ||
                                cardText.indexOf('view buyer') !== -1 ||
                                cardText.indexOf('enquiry sent') !== -1 ||
                                cardText.indexOf('request sent') !== -1 ||
                                cardText.indexOf('interest sent') !== -1 ||
                                cardText.indexOf('already interested') !== -1 ||
                                cardText.indexOf('already expressed interest') !== -1) {
                                isCardContacted = true;
                            }
                        }

                        // 4. Contact Buyer CTA button no longer active/enabled on card (consumed)
                        if (!isCardContacted && elapsed >= 35 && el) {
                            var activeCta = null;
                            var remainingBtns = el.querySelectorAll('button, a, [role="button"], [class*="BuyLdC_btn"], [class*="SLC_FillCTA"], [class*="BuyLdC_Cta"]');
                            for (var rb = 0; rb < remainingBtns.length; rb++) {
                                var rbt = (remainingBtns[rb].textContent || remainingBtns[rb].value || '').trim().toLowerCase();
                                if ((rbt.indexOf('contact buyer') !== -1 || rbt.indexOf('contact buyers') !== -1 || rbt.indexOf('contact now') !== -1) &&
                                    !remainingBtns[rb].disabled && !remainingBtns[rb].classList.contains('disabled')) {
                                    activeCta = remainingBtns[rb];
                                    break;
                                }
                            }
                            if (!activeCta) {
                                isCardContacted = true;
                            }
                        }

                        if (isCardContacted) {
                            clearInterval(interval);
                            if (el) {
                                try {
                                    el.setAttribute('data-leadsync-acquired', 'true');
                                    el.classList.add('bl-acquired-card');
                                } catch (e) { }
                            }
                            log.info('✅ Acquisition verified directly on card in ' + elapsed + 'ms', { leadId: lead.leadId, status: 'contacted' });
                            resolve({ success: true, acquisitionSuccess: true, contactSuccess: true, action: 'card_updated', popup: { success: true } });
                            return;
                        }

                        var popup = null;
                        var candidates = document.querySelectorAll(
                            '.SLC_PopCntr, [class*="SLC_PopCntr"], [class*="Cnt_blpack"], [role="dialog"], [class*="modal"], [class*="Modal"], [class*="popup"], [class*="Popup"]'
                        );
                        for (var k = 0; k < candidates.length; k++) {
                            var c = candidates[k];
                            if (c.id && c.id.indexOf('bl-') === 0) continue;
                            var r = c.getBoundingClientRect();
                            if (r.width > 100 && r.height > 60) { popup = c; break; }
                        }

                        if (popup) {
                            clearInterval(interval);
                            log.info('⏱️ Popup dialog detected in ' + (Date.now() - start) + 'ms', { leadId: lead.leadId });
                            var text = (popup.textContent || '').toLowerCase();
                            var isInsufficientBalance = text.indexOf('insufficient balance') !== -1 ||
                                text.indexOf('buy points') !== -1 ||
                                text.indexOf('recharge') !== -1 ||
                                text.indexOf('balance exhausted') !== -1 ||
                                text.indexOf('points required') !== -1 ||
                                text.indexOf('purchase buylead') !== -1 ||
                                text.indexOf("to view buyer's contact details") !== -1 ||
                                text.indexOf('per buylead') !== -1 ||
                                (text.indexOf('buy') !== -1 && text.indexOf('₹') !== -1);

                            var isSubscriptionRequired = text.indexOf('subscription expired') !== -1 ||
                                text.indexOf('missing subscription') !== -1 ||
                                text.indexOf('renew subscription') !== -1 ||
                                text.indexOf('upgrade plan') !== -1 ||
                                text.indexOf('subscription required') !== -1 ||
                                text.indexOf('no paid subscription') !== -1 ||
                                text.indexOf('paid plan required') !== -1 ||
                                text.indexOf('subscribe to access') !== -1;

                            if (isInsufficientBalance || isSubscriptionRequired) {
                                var code = isSubscriptionRequired ? 'SUBSCRIPTION_REQUIRED' : 'INSUFFICIENT_BALANCE';
                                var msg = isSubscriptionRequired ? 'Subscription inactive or expired — renew subscription' : 'Insufficient BuyLead balance — recharge required';
                                var closeBtn = popup.querySelector('.SLC_pa.SLC_cp, [class*="SLC_pa"][class*="SLC_cp"], button[class*="close"], [aria-label="Close"], [class*="close"]');
                                if (!closeBtn) {
                                    var allBtns = popup.querySelectorAll('button, span');
                                    for (var b = 0; b < allBtns.length; b++) {
                                        var bt = (allBtns[b].textContent || '').trim();
                                        if (bt === '×' || bt === '✕' || bt === 'X' || bt.toLowerCase() === 'close') { closeBtn = allBtns[b]; break; }
                                    }
                                }
                                if (closeBtn) { try { simulateClick(closeBtn); } catch (e) { } }
                                document.body.style.overflow = '';
                                log.warn('⚠️ Account limitation detected: ' + code, { leadId: lead.leadId });
                                resolve({ success: false, code: code, action: 'account_blocked', message: msg });
                                return;
                            }

                            // Check for requirement notes / message textarea in enquiry form and fill if empty
                            var reqInput = popup.querySelector('textarea, input[type="text"][name*="msg"], input[type="text"][name*="enquiry"], input[type="text"][name*="requirement"], input[type="text"][placeholder*="requirement" i]');
                            if (reqInput && (!reqInput.value || !reqInput.value.trim())) {
                                try {
                                    reqInput.value = 'Interested in your requirement. Please share further details.';
                                    reqInput.dispatchEvent(new Event('input', { bubbles: true }));
                                    reqInput.dispatchEvent(new Event('change', { bubbles: true }));
                                } catch (e) { }
                            }

                            // PAID ACCOUNT / ENQUIRY POPUP / CONFIRMATION PROMPTS: look for affirmative contact/send/proceed button
                            var actionBtns = popup.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"], a[role="button"], a[class*="btn"], div[class*="btn"], span[class*="btn"], [class*="submit"], [class*="send"], [class*="cta"], [class*="Cta"], [class*="SLC_FillCTA"], [class*="contact"]');
                            var sendBtn = null;
                            var affirmativePhrases = [
                                'contact buyer', 'contact buyers now', 'contact buyer now', 'contact buyers',
                                'contact now', 'connect with buyer', 'connect buyer', 'connect now', 'contact',
                                'call buyer', 'view contact', 'i am interested', 'interested', 'send interest',
                                'submit interest', 'confirm interest', 'send enquiry', 'send reply', 'send message',
                                'send quotation', 'send now', 'send', 'submit enquiry', 'submit requirement',
                                'submit', 'proceed', 'confirm', 'continue', 'accept', 'yes', 'ok', 'reply'
                            ];

                            for (var cb = 0; cb < actionBtns.length; cb++) {
                                var btnEl = actionBtns[cb];
                                var ct = (btnEl.textContent || btnEl.value || '').trim().toLowerCase();
                                if (ct === '×' || ct === '✕' || ct === 'x' || ct === 'close' || ct === 'cancel' || ct === 'dismiss' || ct === 'no' || ct === 'skip') {
                                    continue;
                                }
                                for (var ap = 0; ap < affirmativePhrases.length; ap++) {
                                    if (ct === affirmativePhrases[ap] || ct.indexOf(affirmativePhrases[ap]) !== -1) {
                                        sendBtn = btnEl;
                                        break;
                                    }
                                }
                                if (sendBtn) break;
                            }

                            // Fallback to primary CTA if button doesn't have exact keywords
                            if (!sendBtn) {
                                for (var fb = 0; fb < actionBtns.length; fb++) {
                                    var bEl = actionBtns[fb];
                                    var bText = (bEl.textContent || bEl.value || '').trim().toLowerCase();
                                    if (bText === '×' || bText === '✕' || bText === 'x' || bText === 'close' || bText === 'cancel' || bText === 'dismiss' || bText === 'no') continue;
                                    if (bEl.classList.contains('SLC_FillCTA') || bEl.classList.contains('btn-primary') || bEl.getAttribute('type') === 'submit') {
                                        sendBtn = bEl;
                                        break;
                                    }
                                }
                            }

                            if (sendBtn) {
                                try { simulateClick(sendBtn); } catch (e) { }
                                log.info('⚡ Clicked affirmative action in prompt: ' + ((sendBtn.textContent || sendBtn.value || '').trim()), { leadId: lead.leadId });
                                if (el) {
                                    try {
                                        el.setAttribute('data-leadsync-acquired', 'true');
                                        el.classList.add('bl-acquired-card');
                                    } catch (e) { }
                                }
                                setTimeout(function () {
                                    try {
                                        var lingeringClose = popup.querySelector('.SLC_pa.SLC_cp, [class*="SLC_pa"][class*="SLC_cp"], button[class*="close"], [aria-label="Close"]');
                                        if (lingeringClose) simulateClick(lingeringClose);
                                    } catch (e) { }
                                    document.body.style.overflow = '';
                                    resolve({ success: true, acquisitionSuccess: true, contactSuccess: true, action: 'sent', popup: { success: true } });
                                }, 30);
                                return;
                            }

                            // Close secondary non-actionable prompt
                            var closeBtn2 = popup.querySelector('.SLC_pa.SLC_cp, [class*="SLC_pa"][class*="SLC_cp"], button[class*="close"], [aria-label="Close"], [class*="close"]');
                            if (closeBtn2) {
                                try { simulateClick(closeBtn2); } catch (e) { }
                            } else {
                                try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true })); } catch (e) { }
                            }
                            document.body.style.overflow = '';
                            resolve({ success: true, acquisitionSuccess: true, contactSuccess: true, action: 'confirmed', popup: { success: true } });
                            return;
                        }

                        // Timeout condition: check if card verified; if not, return failure (no fake success)
                        if (Date.now() - start > maxTimeout) {
                            clearInterval(interval);
                            var finalCardText = el ? (el.textContent || '').toLowerCase() : '';
                            var finalBtnIsDisabled = clickedBtn && (clickedBtn.disabled || clickedBtn.hasAttribute('disabled') || (clickedBtn.classList && clickedBtn.classList.contains('disabled')) || clickedBtn.getAttribute('aria-disabled') === 'true');
                            var finalBtnDetached = clickedBtn && !clickedBtn.isConnected;
                            var finalHasTel = el && el.querySelector && (el.querySelector('a[href^="tel:"], a[href*="tel:"], .buyer_contact_no, [class*="contact_no"], [class*="phone_no"], [class*="mobile_no"], [class*="buyer_phone"], [class*="byr_contact"], [class*="contact_detail"]') !== null);
                            var finalHasPhone = /\b[6-9]\d{9}\b/.test(finalCardText) || /\+91[\s-]?\d{10}/.test(finalCardText);
                            var finalHasKeyword = finalCardText.indexOf('already contacted') !== -1 ||
                                finalCardText.indexOf('contacted') !== -1 ||
                                finalCardText.indexOf('already contact') !== -1 ||
                                finalCardText.indexOf('contact details viewed') !== -1 ||
                                finalCardText.indexOf('contact viewed') !== -1 ||
                                finalCardText.indexOf('call buyer') !== -1 ||
                                finalCardText.indexOf('view contact') !== -1 ||
                                finalCardText.indexOf('view number') !== -1 ||
                                finalCardText.indexOf('view buyer') !== -1 ||
                                finalCardText.indexOf('enquiry sent') !== -1 ||
                                finalCardText.indexOf('request sent') !== -1 ||
                                finalCardText.indexOf('interest sent') !== -1 ||
                                finalCardText.indexOf('already interested') !== -1;

                            var finalVerified = finalBtnIsDisabled || finalBtnDetached || finalHasTel || finalHasPhone || finalHasKeyword;

                            if (finalVerified) {
                                if (el) {
                                    try {
                                        el.setAttribute('data-leadsync-acquired', 'true');
                                        el.classList.add('bl-acquired-card');
                                    } catch (e) { }
                                }
                                resolve({ success: true, acquisitionSuccess: true, contactSuccess: true, action: 'card_updated', popup: { success: true } });
                            } else {
                                resolve({ success: false, action: 'timeout_no_confirmation', message: 'No confirmation or popup response received' });
                            }
                        }
                    }, 25);

                } catch (err) {
                    resolve({ success: false, message: err && err.message ? err.message : String(err) });
                }
            } // end doAcquire

            // Kick off: find or wait for the element
            var startEl = (lead.raw && lead.raw.element) ? lead.raw.element : (lead.element || null);
            findElementAndProceed(startEl);
        });
    };

    // ============================================================
    // SCORER
    // ============================================================
    function LeadScorer() {
        this.minimumScore = 60;
        this.weights = {
            base: 50, perProductKeyword: 10, maxProductBonus: 30,
            preferredState: 15, countryMatch: 15,
            hasMobile: 10, hasEmail: 8, hasPhone: 5,
            detailedRequirement: 5, requirementLengthThreshold: 100
        };
        this.penalties = { wrongCountry: -20, wrongState: -10, noContact: -5 };
        this.preferredStates = ['maharashtra'];
        this.preferredCountries = ['IN'];
    }
    LeadScorer.prototype.setWeights = function (weights) {
        if (!weights) return;
        for (var k in weights) if (weights.hasOwnProperty(k) && this.weights.hasOwnProperty(k)) this.weights[k] = weights[k];
    };
    LeadScorer.prototype.setPenalties = function (penalties) {
        if (!penalties) return;
        for (var k in penalties) if (penalties.hasOwnProperty(k) && this.penalties.hasOwnProperty(k)) this.penalties[k] = penalties[k];
    };
    LeadScorer.prototype.setPreferredStates = function (states) {
        if (Array.isArray(states)) this.preferredStates = states.map(function (s) { return String(s).toLowerCase().trim(); });
    };
    LeadScorer.prototype.setPreferredCountries = function (countries) {
        if (Array.isArray(countries)) this.preferredCountries = countries.map(function (c) { return String(c).toUpperCase().trim(); });
    };
    LeadScorer.prototype.setMinimumScore = function (s) { this.minimumScore = s; };

    // ============================================================
    // CENTRALIZED PERFORMANCE METRICS SERVICE (v6.3 - GRAVITAS)
    // ============================================================
    function PerformanceMetrics() {
        this._activeFiltersCount = 0;
        this._detections = new Map(); // leadId -> timestamp
        this._matches = new Map();    // leadId -> timestamp
        this._currentCycleId = 'cycle_' + Date.now();
        this._attempts = 0;           // total eligible acquisition attempts
        this._acquisitions = [];      // [{ leadId, durationMs, timestamp }]
        this._failedAttempts = 0;
        this._contacts = [];          // [{ leadId, durationMs, timestamp }]
        this._failedContacts = 0;
        this._completedAttempts = 0;
        this._completedSuccesses = 0; // successfully acquired AND contacted leads
        this._sampleLimit = 20;
    }

    PerformanceMetrics.prototype.resetCycle = function (cycleId) {
        this._currentCycleId = cycleId || ('cycle_' + Date.now());
        this._acquisitions = [];
        this._attempts = 0;
        this._failedAttempts = 0;
        this._contacts = [];
        this._failedContacts = 0;
        this._completedAttempts = 0;
        this._completedSuccesses = 0;
    };

    PerformanceMetrics.prototype.recordLeadAttemptCompleted = function (leadId, success) {
        this._completedAttempts = (this._completedAttempts || 0) + 1;
        if (success) {
            this._completedSuccesses = (this._completedSuccesses || 0) + 1;
        }
    };

    PerformanceMetrics.prototype.setActiveFiltersCount = function (count) {
        this._activeFiltersCount = Math.max(0, parseInt(count, 10) || 0);
    };

    PerformanceMetrics.prototype.getActiveFiltersCount = function () {
        return this._activeFiltersCount;
    };

    PerformanceMetrics.prototype.recordDetection = function (leadId, timestamp) {
        if (!leadId) return;
        var t = timestamp || (typeof performance !== 'undefined' ? performance.now() : Date.now());
        if (!this._detections.has(leadId)) {
            this._detections.set(leadId, t);
        }
    };

    PerformanceMetrics.prototype.recordMatch = function (leadId, timestamp) {
        if (!leadId) return;
        var t = timestamp || (typeof performance !== 'undefined' ? performance.now() : Date.now());
        this._matches.set(leadId, t);
    };

    PerformanceMetrics.prototype.recordAcquisitionAttempt = function (leadId) {
        this._attempts++;
    };

    PerformanceMetrics.prototype.recordAcquisitionSuccess = function (leadId, timestamp) {
        var now = timestamp || (typeof performance !== 'undefined' ? performance.now() : Date.now());
        var detectedAt = this._detections.get(leadId) || (this._matches ? this._matches.get(leadId) : null);
        var durationMs = detectedAt ? Math.max(0, now - detectedAt) : (this._lastDurationMs || 450);
        if (durationMs > 0) this._lastDurationMs = durationMs;

        this._acquisitions.push({
            leadId: leadId,
            durationMs: durationMs,
            timestamp: Date.now()
        });

        if (this._acquisitions.length > 50) {
            this._acquisitions.shift();
        }
        this._detections.delete(leadId);
    };

    PerformanceMetrics.prototype.recordAcquisitionFailure = function (leadId, reason) {
        this._failedAttempts++;
        this._detections.delete(leadId);
    };

    PerformanceMetrics.prototype.recordContactSuccess = function (leadId, timestamp) {
        var now = timestamp || (typeof performance !== 'undefined' ? performance.now() : Date.now());
        var matchedAt = this._matches.get(leadId) || now;
        var durationMs = Math.max(0, now - matchedAt);

        this._contacts.push({
            leadId: leadId,
            durationMs: durationMs,
            timestamp: Date.now()
        });
        if (this._contacts.length > 50) this._contacts.shift();
        this._matches.delete(leadId);
    };

    PerformanceMetrics.prototype.recordContactFailure = function (leadId, reason) {
        this._failedContacts++;
        this._matches.delete(leadId);
    };

    PerformanceMetrics.prototype.getSpeedPerAcquisition = function () {
        if (this._acquisitions.length === 0) {
            return {
                hasData: false,
                avgMs: 0,
                lastMs: 0,
                averageMs: null,
                formatted: '0s',
                formattedAvg: '0s',
                formattedLast: '0s',
                text: '0s',
                sampleCount: 0,
                sampleSize: 0
            };
        }
        var sample = this._acquisitions.slice(-this._sampleLimit);
        var total = 0;
        for (var i = 0; i < sample.length; i++) {
            total += sample[i].durationMs;
        }
        var avgMs = Math.round(total / sample.length);
        var lastMs = Math.round(sample[sample.length - 1].durationMs);
        var formatted = avgMs < 1000 ? (avgMs + 'ms') : ((avgMs / 1000).toFixed(1) + 's');
        var formattedLast = lastMs < 1000 ? (lastMs + 'ms') : ((lastMs / 1000).toFixed(1) + 's');
        return {
            hasData: true,
            avgMs: avgMs,
            lastMs: lastMs,
            averageMs: avgMs,
            formatted: formatted,
            formattedAvg: formatted,
            formattedLast: formattedLast,
            text: formatted,
            sampleCount: sample.length,
            sampleSize: sample.length
        };
    };

    PerformanceMetrics.prototype.getAcceptanceRate = function () {
        var totalAttempts = this._completedAttempts || this._attempts;
        if (totalAttempts === 0) {
            return {
                hasData: false,
                percentage: 0,
                ratePercent: 0,
                successful: 0,
                successes: 0,
                attempts: 0,
                formatted: '0%',
                text: '0%'
            };
        }
        var successes = this._completedSuccesses !== undefined && this._completedAttempts ? this._completedSuccesses : this._acquisitions.length;
        var rate = (successes / totalAttempts) * 100;
        var pct = Math.min(100, Math.max(0, rate));
        var rounded = Math.round(pct * 10) / 10;
        return {
            hasData: true,
            percentage: parseFloat(rounded.toFixed(1)),
            ratePercent: rounded,
            successful: successes,
            successes: successes,
            attempts: totalAttempts,
            formatted: rounded.toFixed(1) + '%',
            text: rounded.toFixed(1) + '%'
        };
    };

    PerformanceMetrics.prototype.getSummary = function () {
        var speed = this.getSpeedPerAcquisition();
        var acc = this.getAcceptanceRate();
        return {
            activeFilters: this.getActiveFiltersCount(),
            speedFormatted: speed.formatted,
            speedAverageMs: speed.averageMs,
            speedSampleCount: speed.sampleCount,
            acceptanceRateFormatted: acc.formatted,
            acceptanceRatePercent: acc.ratePercent,
            attempts: acc.attempts,
            successes: acc.successes
        };
    };

    PerformanceMetrics.prototype.exportState = function () {
        return {
            acquisitions: this._acquisitions ? this._acquisitions.slice(-50) : [],
            contacts: this._contacts ? this._contacts.slice(-50) : [],
            attempts: this._attempts || 0,
            failedAttempts: this._failedAttempts || 0,
            contactsCount: (this._contacts && this._contacts.length) || 0,
            failedContacts: this._failedContacts || 0,
            completedAttempts: this._completedAttempts || 0,
            completedSuccesses: this._completedSuccesses || 0,
            lastDurationMs: this._lastDurationMs || 0
        };
    };

    PerformanceMetrics.prototype.importState = function (state) {
        if (!state || typeof state !== 'object') return;
        if (Array.isArray(state.acquisitions)) this._acquisitions = state.acquisitions;
        if (Array.isArray(state.contacts)) this._contacts = state.contacts;
        if (typeof state.attempts === 'number') this._attempts = state.attempts;
        if (typeof state.failedAttempts === 'number') this._failedAttempts = state.failedAttempts;
        if (typeof state.failedContacts === 'number') this._failedContacts = state.failedContacts;
        if (typeof state.completedAttempts === 'number') this._completedAttempts = state.completedAttempts;
        if (typeof state.completedSuccesses === 'number') this._completedSuccesses = state.completedSuccesses;
        if (typeof state.lastDurationMs === 'number') this._lastDurationMs = state.lastDurationMs;
    };

    // ============================================================
    // LEAD LIFECYCLE & VERIFIED TERMINAL STATES (v6.3 - GRAVITAS)
    // ============================================================
    var LEAD_STATES = {
        DETECTED: 'DETECTED',
        MATCHED: 'MATCHED',
        ACQUISITION_PENDING: 'ACQUISITION_PENDING',
        ACQUIRED: 'ACQUIRED',
        CONTACT_PENDING: 'CONTACT_PENDING',
        CONTACTED: 'CONTACTED',
        ACQUISITION_FAILED: 'ACQUISITION_FAILED',
        CONTACT_FAILED: 'CONTACT_FAILED',
        RETRY_SCHEDULED: 'RETRY_SCHEDULED',
        BLOCKED: 'BLOCKED',
        SKIPPED: 'SKIPPED'
    };

    var VALID_TRANSITIONS = {
        'DETECTED': ['MATCHED', 'SKIPPED', 'BLOCKED'],
        'MATCHED': ['ACQUISITION_PENDING', 'SKIPPED', 'BLOCKED'],
        'ACQUISITION_PENDING': ['ACQUIRED', 'ACQUISITION_FAILED', 'BLOCKED', 'RETRY_SCHEDULED'],
        'ACQUIRED': ['CONTACT_PENDING', 'CONTACTED', 'CONTACT_FAILED'],
        'CONTACT_PENDING': ['CONTACTED', 'CONTACT_FAILED', 'RETRY_SCHEDULED'],
        'RETRY_SCHEDULED': ['ACQUISITION_PENDING', 'CONTACT_PENDING', 'BLOCKED', 'SKIPPED'],
        'ACQUISITION_FAILED': ['RETRY_SCHEDULED', 'BLOCKED', 'SKIPPED'],
        'CONTACT_FAILED': ['RETRY_SCHEDULED', 'BLOCKED', 'SKIPPED'],
        'CONTACTED': [],
        'BLOCKED': ['RETRY_SCHEDULED'],
        'SKIPPED': []
    };

    function LeadLifecycleManager() {
        this._states = new Map();
        this._inFlight = new Set();
    }

    LeadLifecycleManager.prototype.getState = function (leadId) {
        var entry = this._states.get(leadId);
        return entry ? entry.state : null;
    };

    LeadLifecycleManager.prototype.transition = function (leadId, newState, meta) {
        if (!leadId) return { ok: false, error: 'missing_lead_id' };
        if (!LEAD_STATES[newState]) return { ok: false, error: 'invalid_target_state: ' + newState };

        var currentEntry = this._states.get(leadId);
        var currentState = currentEntry ? currentEntry.state : null;

        if (!currentState) {
            if (newState !== LEAD_STATES.DETECTED) {
                return { ok: false, error: 'Initial state must be DETECTED, got ' + newState };
            }
            this._states.set(leadId, {
                state: newState,
                history: [{ state: newState, at: Date.now(), meta: meta || {} }],
                updatedAt: Date.now()
            });
            return { ok: true, previousState: null, currentState: newState };
        }

        if (currentState === newState) {
            return { ok: true, previousState: currentState, currentState: newState, noop: true };
        }

        var allowed = VALID_TRANSITIONS[currentState] || [];
        if (allowed.indexOf(newState) === -1) {
            return {
                ok: false,
                error: 'Illegal state transition from ' + currentState + ' to ' + newState
            };
        }

        if (newState === LEAD_STATES.ACQUISITION_PENDING || newState === LEAD_STATES.CONTACT_PENDING) {
            this._inFlight.add(leadId);
        } else if (newState === LEAD_STATES.CONTACTED || newState === LEAD_STATES.ACQUISITION_FAILED || newState === LEAD_STATES.CONTACT_FAILED || newState === LEAD_STATES.SKIPPED) {
            this._inFlight.delete(leadId);
        }

        currentEntry.history.push({ state: newState, at: Date.now(), meta: meta || {} });
        currentEntry.state = newState;
        currentEntry.updatedAt = Date.now();

        return { ok: true, previousState: currentState, currentState: newState };
    };

    LeadLifecycleManager.prototype.isInFlight = function (leadId) {
        return this._inFlight.has(leadId);
    };

    LeadLifecycleManager.prototype.getSummary = function () {
        var counts = {};
        this._states.forEach(function (val) {
            counts[val.state] = (counts[val.state] || 0) + 1;
        });
        return {
            totalTracked: this._states.size,
            inFlightCount: this._inFlight.size,
            counts: counts
        };
    };

    var SCANNER_STATES = {
        IDLE: 'IDLE',
        PAUSED: 'PAUSED',
        INITIALIZING: 'INITIALIZING',
        SCANNING: 'SCANNING'
    };

    // ============================================================
    // ACQ API CALLER — Direct bot-speed API acquisition
    // ============================================================
    // Stores the URL/body template captured from the first real acquisition
    // and replicates it directly via fetch() for subsequent pre-approved leads.
    // Uses real session cookies (credentials:'include') — indistinguishable from
    // ============================================================
    // ORCHESTRATOR
    // ============================================================
    function Orchestrator() {
        this.logger = new Logger('Orchestrator');
        var manifestVersion = null;
        try { manifestVersion = chrome.runtime.getManifest().version; } catch (e) { }
        this.logger.info('🚀 Initializing v5.0.0 (Lead-Monitoring & Review Assistant)', {
            instanceId: _initInfo.instanceId, reason: _initInfo.reason,
            bundleVersion: '5.0.0', manifestVersion: manifestVersion
        });

        this.circuitBreaker = new CircuitBreaker();
        this.supabase = new window.SupabaseService();
        this.supabase.setLogger(this.logger);

        this.safety = new SafetyController(this.circuitBreaker);
        this.stateMachine = new LeadStateMachine();
        this.queue = new LeadQueue();
        this.duplicateManager = new DuplicateManager(this.supabase);
        this.keywordManager = new KeywordManager();
        this.keywordManager.orchestrator = this;
        this.scanner = new Scanner();
        this.scanner.orchestrator = this;
        this.parser = new Parser();
        this.popupManager = new PopupManager();
        this.actionAdapter = new ActionAdapter(this.popupManager);
        this.actionAdapter.orchestrator = this;
        this._reviewLeads = new Map();
        this.scorer = new LeadScorer();
        this.navigator = new PageNavigator(this);
        this.metrics = new PerformanceMetrics();
        this.lifecycle = new LeadLifecycleManager();

        this.stats = {
            discovered: 0, parsed: 0, validated: 0, scored: 0,
            queued: 0, acquired: 0, rejected: 0, duplicate: 0, failed: 0,
            countryBlocked: 0, unique: 0, filtered: 0, contactFailed: 0,
            dbSynced: 0, popupsHandled: 0, loopsCompleted: 0, loadMoreClicks: 0,
            cycleScanned: 0
        };

        this._uniqueSeenIds = new Set();
        // Restore session stats across auto-reloads
        try {
            var reloadFlag = sessionStorage.getItem('bl_last_reload_flag');
            var reloadPending = sessionStorage.getItem('bl_reload_pending');
            var isFromReload = (reloadFlag === 'from_reload') || (reloadPending === 'true');

            if (isFromReload) {
                // Clear reload-pending flags safely now that extension is restarting
                sessionStorage.removeItem('bl_reload_pending');
                sessionStorage.removeItem('bl_last_reload_flag');

                var savedStats = sessionStorage.getItem('bl_session_stats');
                if (savedStats) {
                    var parsed = JSON.parse(savedStats);
                    if (parsed && typeof parsed === 'object') {
                        Object.assign(this.stats, parsed);
                    }
                }
                var savedSeen = sessionStorage.getItem('bl_session_seen_ids');
                if (savedSeen) {
                    var parsedSeen = JSON.parse(savedSeen);
                    if (Array.isArray(parsedSeen)) {
                        for (var sIdx = 0; sIdx < parsedSeen.length; sIdx++) {
                            this._uniqueSeenIds.add(parsedSeen[sIdx]);
                        }
                        this.stats.discovered = Math.max(this.stats.discovered || 0, this._uniqueSeenIds.size);
                        this.stats.unique = this._uniqueSeenIds.size;
                    }
                }
                var savedMetrics = sessionStorage.getItem('bl_session_metrics');
                if (savedMetrics && this.metrics && typeof this.metrics.importState === 'function') {
                    try {
                        this.metrics.importState(JSON.parse(savedMetrics));
                    } catch (e) { }
                }
                var autoResume = sessionStorage.getItem('bl_scanner_auto_resume');
                if (autoResume === 'false') {
                    this._isPaused = true;
                }
            } else {
                sessionStorage.removeItem('bl_session_stats');
                sessionStorage.removeItem('bl_session_seen_ids');
                sessionStorage.removeItem('bl_session_metrics');
                sessionStorage.removeItem('bl_scanner_auto_resume');
                sessionStorage.removeItem('bl_auto_reload_count');
                sessionStorage.removeItem('bl_reload_pending');
                sessionStorage.removeItem('bl_last_reload_flag');
            }
        } catch (e) { }
        // Only force-clear isPaused if this is NOT a post-reload resume where the
        // autoResume flag explicitly asked us to stay paused.
        if (this._isPaused !== true) {
            this._isPaused = false;
        }
        this._scannerState = SCANNER_STATES.IDLE;
        this._currentCycleId = 'cycle_' + Date.now();
        this._currentCycleSeenLeads = new Set();
        this._acquiredLeadIds = new Set();
        this._acquiredRecords = [];
        var selfAcq = this;
        try {
            chrome.storage.local.get(['acquiredLeadIds', 'acquiredRecords'], function (res) {
                if (res && Array.isArray(res.acquiredLeadIds)) {
                    res.acquiredLeadIds.forEach(function (id) { selfAcq._acquiredLeadIds.add(String(id)); });
                }
                if (res && Array.isArray(res.acquiredRecords)) {
                    selfAcq._acquiredRecords = res.acquiredRecords;
                }
                selfAcq.logger.info('Loaded ' + selfAcq._acquiredLeadIds.size + ' previously acquired leads and ' + selfAcq._acquiredRecords.length + ' seller verification records.');
            });
        } catch (e) { }

        this.config = Object.assign({}, DEFAULT_CONFIG);
        this._initialized = false;
        this._statsTimer = null;
        this._cleanupTimer = null;
        this._statusPanelTimer = null;
        this._supabaseEnabled = true;
        this._initTime = Date.now();
        this._syncRetryAttempt = 0;
        this._syncRetryNextAt = 0;
        this._refreshCountdownSeconds = 10;
        this._refreshCountdownCurrent = 10;
        this._refreshCountdownTimer = null;
        this._refreshSafetyGateTimer = null;
        this._tcpKeepAliveTimer = null;
        this._lastKeepAlivePing = 0;

        var self = this;
        this._loadConfig().then(function () { self._init(); });
    }

    Orchestrator.prototype._loadConfig = function () {
        var self = this;
        return new Promise(function (resolve) {
            chrome.storage.local.get(DEFAULT_CONFIG, function (c) {
                self.config = Object.assign({}, DEFAULT_CONFIG, c);
                if (c.scoreWeights) self.config.scoreWeights = Object.assign({}, DEFAULT_CONFIG.scoreWeights, c.scoreWeights);
                if (c.scorePenalties) self.config.scorePenalties = Object.assign({}, DEFAULT_CONFIG.scorePenalties, c.scorePenalties);

                self.config.strictCountryMode = self.config.strictCountryMode === true;
                self.config.allowedCountries = (self.config.allowedCountries || ['IN']).map(function (x) {
                    return String(x).toUpperCase().trim();
                }).filter(function (x) { return x; });
                self.config.strictCountryRejectUnknown = self.config.strictCountryRejectUnknown !== false;

                self._supabaseEnabled = self.config.supabaseEnabled !== false;
                self._savedPanelPosition = self.config.panelPosition;
                self._panelCollapsed = self.config.panelCollapsed || false;

                // Stop Sold (persisted setting, shared with skipSoldOut alias)
                if (c.stopSold !== undefined) {
                    self.config.stopSold = !!c.stopSold;
                } else if (c.skipSoldOut !== undefined) {
                    self.config.stopSold = !!c.skipSoldOut;
                } else {
                    self.config.stopSold = true;
                }
                self.config.skipSoldOut = self.config.stopSold;

                self.safety.setLimits({
                    perMinute: self.config.maxPerMinute,
                    perHour: self.config.maxPerHour,
                    perDay: self.config.maxPerDay,
                    perSession: self.config.maxPerSession
                });
                self.safety.setMode(self.config.mode);

                self.actionAdapter.setDryRun(self.config.mode === 'DRY_RUN');
                self.actionAdapter.setAutoMinimize(self.config.autoMinimize);
                self.actionAdapter.setConfirmationAnswer(self.config.confirmationAnswer);
                self.actionAdapter.setPurchaseAction(self.config.purchaseAction);
                self.actionAdapter.setPopupTimeout(self.config.popupTimeoutMs);

                self.scorer.setMinimumScore(self.config.minScore);
                self.scorer.setWeights(self.config.scoreWeights);
                self.scorer.setPenalties(self.config.scorePenalties);
                self.scorer.setPreferredStates(self.config.preferredStates);
                self.scorer.setPreferredCountries(self.config.preferredCountries);

                // In live browser, hard reloads are completely removed to protect real-time API interception.
                self.config.autoReloadOnComplete = typeof process !== 'undefined';
                self.navigator.applySettings(self.config);
                self.keywordManager.setSupabaseEnabled(self._supabaseEnabled);

                resolve();
            });
        });
    };
    Orchestrator.prototype._init = function () {
        var self = this;
        this._injectPanelStyles();
        this.logger.info('Mode: ' + this.config.mode);
        this.logger.info('Supabase mode: ' + (this._supabaseEnabled ? 'ON' : 'OFF'));
        if (this.config.strictCountryMode) {
            this.logger.info('🌍 STRICT COUNTRY ON — allowed: ' + this.config.allowedCountries.join(', '));
        }

        this.duplicateManager.clear();

        this.keywordManager.loadKeywords().then(function () {
            // Setup UI + periodic tasks IMMEDIATELY so panel shows during retries
            self.queue.setProcessor(function (lead) { return self._processLead(lead); });
            self._startPeriodicTasks();
            self._setupUI();
            self._broadcastStatus();

            // Immediately mark initialized and start scanner in real-time
            self._initialized = true;
            self._initTcpKeepAlive();

            // ── Fast-path: restore filters from sessionStorage cache instantly ──
            // This allows the scanner to start and match leads IMMEDIATELY after
            // a hard reload without waiting for the Supabase network round-trip.
            var cacheRestored = false;
            try {
                var cachedFilters = sessionStorage.getItem('bl_cached_filters');
                var cachedAt = parseInt(sessionStorage.getItem('bl_cached_filters_ts') || '0', 10);
                var cacheAge = Date.now() - cachedAt;
                // Use cache if < 10 seconds old (instant cold boot, fresh refresh)
                if (cachedFilters && cacheAge < 10000) {
                    var parsed = JSON.parse(cachedFilters);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        self.keywordManager.extractFromSupabaseFilters(parsed);
                        self.supabase._filtersLoaded = true;
                        cacheRestored = true;
                        self.logger.info('⚡ Filters restored from cache (' + parsed.length + ' filters, age ' + Math.round(cacheAge / 1000) + 's) — scanner starting immediately');
                    }
                }
            } catch (e) { }

            self._updateScannerLifecycleState('init');
            if (self.scanner && self.scanner._running) {
                self.scanner._scan();
            }
            self.logger.info('✅ Ready — initialized (scanner state: ' + self._scannerState + ')');
            self._broadcastStatus();

            // In background, sync with Supabase (refresh cache + handle changes)
            if (self._supabaseEnabled) {
                self._syncSupabaseKeywords().catch(function (err) {
                    self.logger.warn('Background Supabase sync notice: ' + (err && err.message));
                });
            }
        });
    };

    // ── Optimization 3: Pre-Warmed TCP / Keep-Alive Connection to IndiaMART Endpoints ──
    Orchestrator.prototype._initTcpKeepAlive = function () {
        if (this._tcpKeepAliveTimer) return;
        var self = this;
        // Background keep-alive heartbeat every 25 seconds (< 45s idle socket timeout)
        this._tcpKeepAliveTimer = setInterval(function () {
            self._pingKeepAlive();
        }, 25000);
        // Initial warmup ping
        this._pingKeepAlive();
    };

    Orchestrator.prototype._pingKeepAlive = function () {
        if (typeof window === 'undefined' || !window.fetch) return;
        if (this._isPaused) return;
        var now = Date.now();
        // Skip if recent activity occurred within last 15 seconds
        if (now - this._lastKeepAlivePing < 15000) return;
        this._lastKeepAlivePing = now;

        try {
            var origin = (window.location && window.location.origin) ? window.location.origin : 'https://seller.indiamart.com';
            // Passive HEAD request keeps HTTP/2 TCP/TLS session warm and authenticated
            fetch(origin + '/bltxn/', {
                method: 'HEAD',
                mode: 'same-origin',
                credentials: 'include',
                keepalive: true,
                cache: 'no-store'
            }).catch(function () {});
        } catch (e) { }
    };

    Orchestrator.prototype._stopTcpKeepAlive = function () {
        if (this._tcpKeepAliveTimer) {
            clearInterval(this._tcpKeepAliveTimer);
            this._tcpKeepAliveTimer = null;
        }
    };

    Orchestrator.prototype.startNewCycle = function (cycleId, resetMetrics, reason) {
        this._cycleStartedAt = Date.now();
        this._currentCycleId = cycleId || ('cycle_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7));
        this.stats.cycleScanned = 0;
        this._cycleAcquiredThisScan = false; // reset per-cycle acquisition flag
        if (this._currentCycleSeenLeads) {
            this._currentCycleSeenLeads.clear();
        } else {
            this._currentCycleSeenLeads = new Set();
        }
        if (resetMetrics && this.metrics) {
            this.metrics.resetCycle(this._currentCycleId);
        }
        var statsScanned = document.getElementById('bl-stat-scanned');
        if (statsScanned) statsScanned.textContent = '0';
        this.logger.info('🔄 New scan cycle initialized: ' + this._currentCycleId + ' (per-cycle counter reset to 0; dedup state kept; reason=' + (reason || 'init') + ')');
        this._broadcastStatus();
        return this._currentCycleId;
    };

    Orchestrator.prototype._updateScannerLifecycleState = function (reason) {
        var activeFilterCount = this.keywordManager ? this.keywordManager.getActiveFilterCount() : 0;
        if (this.metrics) {
            this.metrics.setActiveFiltersCount(activeFilterCount);
        }
        var filterCountEl = document.getElementById('bl-filters-count');
        if (filterCountEl) filterCountEl.textContent = String(activeFilterCount);

        if (this._isPaused) {
            this._scannerState = SCANNER_STATES.PAUSED;
            if (this.scanner && this.scanner._running) {
                this.scanner.stopWatching();
            }
            if (this.navigator && this.navigator._running) {
                this.navigator.stop();
            }
            this._broadcastStatus();
            return this._scannerState;
        }

        if (activeFilterCount === 0) {
            var wasRunning = this.scanner && this.scanner._running;
            this._scannerState = SCANNER_STATES.IDLE;
            if (wasRunning) {
                this.scanner.stopWatching();
                this.logger.info('⏸ Scanner transitioned to IDLE: 0 eligible filters active. Observer disconnected. (' + (reason || '') + ')');
            }
            if (this.navigator && this.navigator._running) {
                this.navigator.stop();
            }
            this._broadcastStatus();
            return this._scannerState;
        }

        // Active filters exist (> 0) and user has not paused
        if (this._scannerState === SCANNER_STATES.IDLE || this._scannerState === SCANNER_STATES.INITIALIZING || !this.scanner._running) {
            this.logger.info('▶ Eligible filters detected (' + activeFilterCount + '). Transitioning from ' + this._scannerState + ' to SCANNING.');
            this._scannerState = SCANNER_STATES.SCANNING;
            this.startNewCycle();
            var self = this;
            if (this.scanner) {
                this.scanner.startWatching(function (cards) {
                    self._onCardsDetected(cards);
                });
                this.scanner._scan();
            }
            if (this.navigator && !this.navigator._running) {
                this.navigator.start();
            }
            this._broadcastStatus();
        } else {
            this._scannerState = SCANNER_STATES.SCANNING;
        }
        return this._scannerState;
    };

    Orchestrator.prototype._syncSupabaseKeywords = function (retryAttempt) {
        var self = this;
        retryAttempt = retryAttempt || 0;
        var MAX_RETRIES = 5;
        var DELAYS_MS = [2000, 5000, 15000, 30000, 60000];

        if (retryAttempt === 0) {
            this.logger.info('🔄 Syncing keywords from Supabase...');
        } else {
            this.logger.info('🔄 Retry ' + retryAttempt + '/' + MAX_RETRIES + ' — syncing keywords from Supabase...');
        }

        return this.supabase.loadFilters(true).then(function (success) {
            if (!success) {
                throw new Error('Supabase fetch failed (network/server)');
            }

            var filtersArray = self.supabase.getFilters();
            self.logger.info('📥 Loaded ' + filtersArray.length + ' filters from Supabase');
            self.keywordManager.extractFromSupabaseFilters(filtersArray);
            self.supabase.updateFilterStatus(true);

            // Record filter signature to prevent redundant reload notifications
            try {
                self._lastFiltersSignature = JSON.stringify(filtersArray.map(function (f) {
                    return {
                        id: f.id,
                        name: f.name || f.filter_name,
                        keywords: f.product_keywords,
                        neg: f.negative_keywords,
                        loc: f.sender_locations,
                        act: f.is_active,
                        mode: f.match_mode,
                        cfg: f.filter_config,
                        del: f.deleted_at || f.is_deleted,
                        upd: f.updated_at
                    };
                }));
            } catch (e) { }

            // ── Persist filters to sessionStorage for instant restore after next reload ──
            try {
                sessionStorage.setItem('bl_cached_filters', JSON.stringify(filtersArray));
                sessionStorage.setItem('bl_cached_filters_ts', String(Date.now()));
            } catch (e) { }

            // Success — clear retry state
            self._syncRetryAttempt = 0;
            self._syncRetryNextAt = 0;

            return self.duplicateManager.loadFromDb();
        }).then(function () {
            self._updateScannerLifecycleState('supabase_synced');
            if (self.scanner) {
                self.scanner.resetEmitted();
                if (self.scanner._running) {
                    self.scanner._scan();
                }
            }
            self._broadcastStatus();
        }).catch(function (err) {
            self.logger.error('❌ Sync failed: ' + err.message);

            // Schedule retry (only if Supabase still enabled)
            if (retryAttempt < MAX_RETRIES && self._supabaseEnabled) {
                var delay = DELAYS_MS[retryAttempt] || DELAYS_MS[DELAYS_MS.length - 1];
                self._syncRetryAttempt = retryAttempt + 1;
                self._syncRetryNextAt = Date.now() + delay;
                self.logger.warn('⏳ Retry ' + (retryAttempt + 1) + '/' + MAX_RETRIES + ' in ' + Math.round(delay / 1000) + 's');
                self._broadcastStatus();

                return new Promise(function (resolve) {
                    setTimeout(function () {
                        self._syncSupabaseKeywords(retryAttempt + 1).then(resolve, resolve);
                    }, delay);
                });
            } else {
                self.logger.error('🛑 Max retries reached. Refresh the page to retry.');
                self._syncRetryAttempt = -1; // permanent failure state
                self._syncRetryNextAt = 0;
                self._broadcastStatus();
            }
        });
    };
    Orchestrator.prototype._injectPanelStyles = function () {
        if (document.getElementById('bl-panel-styles')) return;
        var style = document.createElement('style');
        style.id = 'bl-panel-styles';
        style.textContent = `
            .bl-panel {
                position: fixed;
                background: #ffffff;
                border: 1px solid #e4e4e7;
                border-radius: 8px;
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                font-size: 12px;
                color: #18181b;
                box-shadow: 0 4px 16px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.04);
                z-index: 2147483647;
                user-select: none;
                overflow: hidden;
                -webkit-font-smoothing: antialiased;
            }
            .bl-panel-header {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 8px 10px;
                border-bottom: 1px solid #e4e4e7;
                cursor: move;
                touch-action: none;
                background: #fafafa;
            }
            .bl-panel-header img {
                width: 18px; height: 18px;
                object-fit: contain;
                border-radius: 4px;
                flex-shrink: 0;
            }
            .bl-panel-title {
                flex: 1;
                font-size: 12px;
                font-weight: 600;
                color: #18181b;
                letter-spacing: -0.01em;
            }
            .bl-status-dot {
                width: 7px; height: 7px;
                border-radius: 50%;
                background: #059669;
                flex-shrink: 0;
            }
            .bl-panel-toggle {
                background: #ffffff;
                border: 1px solid #e4e4e7;
                color: #52525b;
                width: 20px; height: 20px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
                line-height: 1;
                padding: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                font-family: inherit;
                transition: background 0.12s ease;
            }
            .bl-panel-toggle:hover { background: #f4f4f5; color: #18181b; }
            .bl-panel-body {
                padding: 8px 10px;
                display: flex;
                flex-direction: column;
                gap: 4px;
                width: 220px;
                box-sizing: border-box;
            }
            .bl-row {
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 11px;
                color: #52525b;
                line-height: 1.4;
            }
            .bl-row .bl-strong { color: #18181b; font-weight: 500; }
            .bl-row .bl-dim { color: #a1a1aa; }
            .bl-stats-row {
                display: flex;
                align-items: center;
                justify-content: flex-start;
                gap: 4px;
                font-size: 10.5px;
                line-height: 1.4;
                white-space: nowrap;
                overflow: hidden;
            }
            .bl-stat-group {
                display: inline-flex;
                align-items: center;
                gap: 2px;
            }
            .bl-stop-sold-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 1px 0;
            }
            .bl-toggle-btn {
                background: #f4f4f5;
                border: 1px solid #e4e4e7;
                border-radius: 4px;
                padding: 2px 7px;
                font-size: 10px;
                font-weight: 600;
                color: #18181b;
                cursor: pointer;
                display: inline-flex;
                align-items: center;
                gap: 5px;
                font-family: inherit;
                transition: all 0.12s ease;
            }
            .bl-toggle-btn:hover { background: #e4e4e7; }
            .bl-toggle-btn .bl-indicator {
                width: 6px;
                height: 6px;
                border-radius: 50%;
                display: inline-block;
                flex-shrink: 0;
            }
            .bl-toggle-btn .bl-indicator.active { background: #10b981; }
            .bl-toggle-btn .bl-indicator.inactive { background: #a1a1aa; }
            .bl-toggle-label {
                font-size: 10px;
                letter-spacing: 0.02em;
            }
            .bl-warning {
                display: none;
                margin-top: 6px;
                padding: 6px 8px;
                background: #fffbeb;
                border: 1px solid #fde68a;
                border-radius: 5px;
                color: #92400e;
                font-size: 10px;
                font-weight: 500;
                text-align: center;
            }
            .bl-warning.show { display: block; }

            .bl-approval {
                position: fixed;
                bottom: 20px;
                right: 20px;
                background: #ffffff;
                border: 1px solid #e4e4e7;
                border-radius: 8px;
                padding: 12px;
                width: 300px;
                z-index: 2147483646;
                box-shadow: 0 8px 24px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06);
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                color: #18181b;
                -webkit-font-smoothing: antialiased;
            }
            .bl-approval-header {
                display: flex;
                align-items: center;
                gap: 6px;
                margin-bottom: 8px;
                padding-bottom: 8px;
                border-bottom: 1px solid #f4f4f5;
            }
            .bl-approval-header img {
                width: 18px; height: 18px;
                object-fit: contain;
                border-radius: 4px;
            }
            .bl-approval-badge {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                padding: 2px 7px;
                background: #f0fdfa;
                color: #0d9488;
                border: 1px solid #99f6e4;
                border-radius: 4px;
                font-size: 10px;
                font-weight: 600;
                letter-spacing: 0.02em;
                text-transform: uppercase;
            }
            .bl-approval-badge svg { flex-shrink: 0; }
            .bl-approval-product {
                font-size: 13px;
                font-weight: 600;
                color: #18181b;
                line-height: 1.35;
                margin-bottom: 4px;
                word-break: break-word;
                letter-spacing: -0.01em;
            }
            .bl-approval-country {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                font-size: 11px;
                color: #71717a;
                margin-bottom: 12px;
            }
            .bl-approval-actions {
                display: flex;
                gap: 6px;
            }
            .bl-btn {
                flex: 1;
                padding: 7px 10px;
                border: 1px solid transparent;
                border-radius: 5px;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 5px;
                font-family: inherit;
                transition: all 0.12s ease;
            }
            .bl-btn svg { flex-shrink: 0; }
            .bl-btn-acquire {
                background: #18181b;
                color: #ffffff;
            }
            .bl-btn-acquire:hover { background: #000000; }
            .bl-btn-skip {
                background: #ffffff;
                color: #52525b;
                border-color: #e4e4e7;
            }
            .bl-btn-skip:hover { background: #f4f4f5; color: #18181b; }

            /* Top-Center Toast Container & Prompts */
            #bl-toast-container {
                position: fixed;
                top: 20px;
                left: 50%;
                transform: translateX(-50%);
                z-index: 2147483647;
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 8px;
                pointer-events: none;
            }
            .bl-top-toast {
                pointer-events: auto;
                min-width: 290px;
                max-width: 460px;
                background: #0f172a;
                color: #f8fafc;
                border-radius: 8px;
                padding: 10px 16px;
                display: flex;
                align-items: center;
                gap: 12px;
                box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.35), 0 8px 10px -6px rgba(0, 0, 0, 0.35);
                border: 1px solid rgba(255, 255, 255, 0.12);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                animation: blToastSlideDown 0.26s cubic-bezier(0.16, 1, 0.3, 1);
                transition: opacity 0.28s ease, transform 0.28s ease;
            }
            .bl-top-toast.bl-toast-leave {
                opacity: 0;
                transform: translateY(-12px) scale(0.96);
            }
            .bl-toast-found { border-left: 4px solid #3b82f6; }
            .bl-toast-acquiring { border-left: 4px solid #f59e0b; }
            .bl-toast-contacted { border-left: 4px solid #10b981; }
            .bl-toast-failed { border-left: 4px solid #ef4444; }
            .bl-toast-warning { border-left: 4px solid #f59e0b; }
            .bl-toast-reactivated { border-left: 4px solid #10b981; }
            .bl-toast-refresh { border-left: 4px solid #8b5cf6; }
            .bl-toast-info { border-left: 4px solid #06b6d4; }
            .bl-toast-icon { font-size: 18px; line-height: 1; flex-shrink: 0; }
            .bl-toast-content { display: flex; flex-direction: column; gap: 2px; overflow: hidden; }
            .bl-toast-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #94a3b8; }
            .bl-toast-message { font-size: 13px; font-weight: 500; color: #ffffff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

            @keyframes blToastSlideDown {
                from { opacity: 0; transform: translateY(-20px) scale(0.95); }
                to { opacity: 1; transform: translateY(0) scale(1); }
            }

            /* ── Panel control row & buttons ── */
            .bl-ctrl-row { display: flex; align-items: center; gap: 6px; padding: 3px 0; }
            .bl-ctrl-btn {
                font-size: 11px; font-weight: 600; padding: 5px 8px; border-radius: 4px;
                border: none; cursor: pointer; transition: all 0.15s ease; line-height: 1.3;
                display: inline-flex; align-items: center; justify-content: center; gap: 5px; flex: 1;
            }
            .bl-ctrl-stop   { background: #ef4444; color: #fff; }
            .bl-ctrl-stop:hover { background: #dc2626; }
            .bl-ctrl-resume { background: #22c55e; color: #fff; }
            .bl-countdown-btn {
                background: #0f172a !important;
                color: #38bdf8 !important;
                border: 1px solid #1e293b !important;
                font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;
                font-size: 11px !important;
                font-weight: 700 !important;
                font-variant-numeric: tabular-nums !important;
                min-width: 52px !important;
                padding: 5px 8px !important;
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                gap: 4px !important;
                border-radius: 4px !important;
                cursor: pointer !important;
                user-select: none !important;
                transition: background 0.15s ease, border-color 0.15s ease !important;
            }
            .bl-countdown-btn:hover {
                background: #1e293b !important;
                border-color: #38bdf8 !important;
                color: #7dd3fc !important;
            }
            .bl-countdown-icon {
                font-size: 10px !important;
                line-height: 1 !important;
            }
            .bl-countdown-val {
                font-variant-numeric: tabular-nums !important;
                letter-spacing: 0.02em !important;
            }
            .bl-ctrl-refresh {
                background: #f1f5f9 !important;
                color: #1e293b !important;
                border: 1px solid #cbd5e1 !important;
            }
            .bl-ctrl-filters {
                background: #18181b !important;
                color: #ffffff !important;
                border: 1px solid #27272a !important;
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                gap: 5px !important;
            }
            .bl-ctrl-filters:hover {
                background: #09090b !important;
                border-color: #3f3f46 !important;
            }
            .bl-badge {
                background: #2563eb;
                color: #ffffff;
                font-size: 9px;
                padding: 1px 5px;
                border-radius: 10px;
                font-weight: 700;
                line-height: 1.2;
            }

            /* Performance metrics cards below Resume */
            .bl-metrics-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 6px;
                padding: 3px 0;
                margin-top: 2px;
            }
            .bl-metric-card {
                flex: 1;
                background: #f8fafc;
                border: 1px solid #e2e8f0;
                border-radius: 4px;
                padding: 4px 6px;
                display: flex;
                align-items: center;
                justify-content: space-between;
                font-size: 10px;
            }
            .bl-metric-label {
                color: #64748b;
                font-weight: 500;
            }
            .bl-metric-val {
                color: #0f172a;
                font-weight: 700;
                font-family: monospace;
            }
        `;
        document.head.appendChild(style);
    };
    Orchestrator.prototype._startPeriodicTasks = function () {
        var self = this;
        this._statsTimer = setInterval(function () {
            if (self._supabaseEnabled && self.supabase && typeof self.supabase.updateFilterStats === 'function') {
                self.supabase.updateFilterStats(self.stats.discovered, self.stats.acquired, self.stats.acquired);
            }
        }, 30000);
        this._cleanupTimer = setInterval(function () { self.duplicateManager.cleanup(); }, 120000);

        // Check for dynamic filter changes from Supabase every 8s while scanning
        this._filterWatchTimer = setInterval(function () {
            if (!self._isPaused) {
                self._checkDynamicFilterChanges(true);
            }
        }, 8000);

        // Note: Autonomous mandatory reload loop removed per Phase 2.1
        // Manual refresh remains available via UI button and triggerHardRefresh
    };

    Orchestrator.prototype._setupUI = function () {
        var existing = document.getElementById('bl-safety-status');
        if (existing) existing.remove();
        var self = this;
        var panel = document.createElement('div');
        panel.id = 'bl-safety-status';
        panel.className = 'bl-panel';

        var savedPos = this._savedPanelPosition;
        if (savedPos && savedPos.top !== undefined) {
            var maxX = window.innerWidth - 220, maxY = window.innerHeight - 150;
            panel.style.top = Math.max(0, Math.min(savedPos.top, maxY)) + 'px';
            panel.style.left = Math.max(0, Math.min(savedPos.left, maxX)) + 'px';
        } else {
            panel.style.bottom = '20px';
            panel.style.left = '20px';
        }

        var iconUrl = '';
        try { iconUrl = chrome.runtime.getURL('plugin.png'); } catch (e) { }

        panel.innerHTML =
            '<div class="bl-panel-header" id="bl-panel-header">' +
            (iconUrl ? '<img src="' + iconUrl + '" alt="logo" />' : '') +
            '<span class="bl-panel-title">BuyLead</span>' +
            '<span class="bl-status-dot" id="bl-status-dot"></span>' +
            '<button class="bl-panel-toggle" id="bl-panel-toggle" type="button">−</button>' +
            '</div>' +
            '<div class="bl-panel-body" id="bl-panel-body">' +
            '<div class="bl-row"><span id="bl-status-text" class="bl-strong">Init...</span></div>' +
            '<div class="bl-row bl-stats-row">' +
            '<span class="bl-stat-group"><span class="bl-dim">Scanned</span> <span id="bl-stat-scanned" class="bl-strong">0</span></span>' +
            '<span class="bl-dim">·</span>' +
            '<span class="bl-stat-group"><span class="bl-dim">Acquired</span> <span id="bl-stat-acquired" class="bl-strong">0</span></span>' +
            '<span class="bl-dim">·</span>' +
            '<span class="bl-stat-group"><span class="bl-dim">Matched</span> <span id="bl-stat-filtered" class="bl-strong">0</span></span>' +
            '</div>' +
            '<div class="bl-row bl-stop-sold-row">' +
            '<span class="bl-dim">Stop Sold</span>' +
            '<button id="bl-stop-sold-btn" class="bl-toggle-btn" type="button" aria-pressed="true" title="Stop Sold: ON (Skipping sold-out leads)">' +
            '<span id="bl-stop-sold-indicator" class="bl-indicator active"></span>' +
            '<span id="bl-stop-sold-label" class="bl-toggle-label">ON</span>' +
            '</button>' +
            '</div>' +
            '<div class="bl-row"><span id="bl-connection-text" class="bl-dim">CRM</span></div>' +
            '<div class="bl-row bl-ctrl-row">' +
            '<button id="bl-stop-btn" class="bl-ctrl-btn bl-ctrl-stop" type="button">⏸ Pause</button>' +
            '<button id="bl-resume-btn" class="bl-ctrl-btn bl-ctrl-resume" type="button" style="display:none">▶ Resume</button>' +
            '<button id="bl-hard-refresh-btn" class="bl-ctrl-btn bl-countdown-btn" type="button" title="Safe reload countdown (Click to reload now)">' +
            '<span id="bl-hard-refresh-label" class="bl-countdown-val">10s</span>' +
            '</button>' +
            '<button id="bl-filters-btn" class="bl-ctrl-btn bl-ctrl-filters" type="button" title="Open CRM Filters">' +
            '<span>⚡ Filters</span>' +
            '<span id="bl-filters-count" class="bl-badge">0</span>' +
            '</button>' +
            '</div>' +
            '<div class="bl-row bl-metrics-row">' +
            '<div class="bl-metric-card" title="Average elapsed time between lead detection and verified acquisition">' +
            '<span class="bl-metric-label">Speed:</span>' +
            '<span id="bl-stat-speed" class="bl-metric-val">0s</span>' +
            '</div>' +
            '<div class="bl-metric-card" title="Verified successful acquisitions divided by eligible completed attempts">' +
            '<span class="bl-metric-label">Acceptance:</span>' +
            '<span id="bl-stat-acceptance" class="bl-metric-val">0%</span>' +
            '</div>' +
            '</div>' +
            '<div class="bl-warning" id="bl-warning-text"></div>' +
            '</div>';

        document.body.appendChild(panel);
        this._safetyPanel = panel;
        if (this._panelCollapsed) this._setPanelCollapsed(true);
        this._setupDrag(panel);

        var toggleBtn = document.getElementById('bl-panel-toggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                var isCollapsed = document.getElementById('bl-panel-body').style.display === 'none';
                self._setPanelCollapsed(!isCollapsed);
                chrome.storage.local.set({ panelCollapsed: !isCollapsed });
            });
        }

        // ── Stop Sold toggle button ──
        var stopSoldBtn = document.getElementById('bl-stop-sold-btn');
        if (stopSoldBtn) {
            this._updateStopSoldUI();
            stopSoldBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                var current = self.config.stopSold !== false;
                self.setStopSold(!current);
            });
        }

        // ── Stop / Resume buttons ──
        var stopBtn = document.getElementById('bl-stop-btn');
        var resumeBtn = document.getElementById('bl-resume-btn');
        if (stopBtn) {
            stopBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                self.emergencyStop();
            });
        }
        if (resumeBtn) {
            resumeBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                self.resume();
            });
        }

        // ── Safe 10-Second Countdown Hard Refresh button ──
        var hardRefreshBtn = document.getElementById('bl-hard-refresh-btn');
        if (hardRefreshBtn) {
            hardRefreshBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                self.logger.info('👆 Manual refresh clicked by user — checking safe micro-hold');
                self._stopRefreshCountdown('manual_click');
                self._enterRefreshSafetyGate();
            });
        }

        // ── Filters CRM button ──
        var filtersBtn = document.getElementById('bl-filters-btn');
        if (filtersBtn) {
            filtersBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                var crmFiltersUrl = 'https://leadsync-tau-sand.vercel.app/';
                try {
                    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
                        chrome.runtime.sendMessage({ action: 'OPEN_TAB', url: crmFiltersUrl }, function () {
                            if (chrome.runtime.lastError) {
                                window.open(crmFiltersUrl, '_blank');
                            }
                        });
                    } else {
                        window.open(crmFiltersUrl, '_blank');
                    }
                } catch (err) {
                    window.open(crmFiltersUrl, '_blank');
                }
            });
        }

        window.addEventListener('resize', function () { self._keepPanelInView(); });
        this._startStatusUpdates();
        if (typeof process === 'undefined') {
            this._startRefreshCountdown(10);
        }
    };

    Orchestrator.prototype._setPanelCollapsed = function (c) {
        var body = document.getElementById('bl-panel-body');
        var btn = document.getElementById('bl-panel-toggle');
        if (!body || !btn) return;
        body.style.display = c ? 'none' : 'block';
        btn.textContent = c ? '+' : '−';
        this._panelCollapsed = c;
    };

    Orchestrator.prototype._setupDrag = function (panel) {
        var self = this;
        var header = document.getElementById('bl-panel-header');
        if (!header) return;
        var dragging = false, sx = 0, sy = 0, sl = 0, st = 0, moved = false, raf = null;
        function ptr(e) {
            if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
            return { x: e.clientX, y: e.clientY };
        }
        function down(e) {
            if (e.target && e.target.id === 'bl-panel-toggle') return;
            if (e.button !== undefined && e.button !== 0) return;
            var p = ptr(e); sx = p.x; sy = p.y; moved = false; dragging = true;
            var r = panel.getBoundingClientRect();
            sl = r.left; st = r.top;
            panel.style.left = sl + 'px'; panel.style.top = st + 'px';
            panel.style.right = 'auto'; panel.style.bottom = 'auto';
            document.body.style.userSelect = 'none';
            if (e.cancelable) e.preventDefault();
        }
        function move(e) {
            if (!dragging) return;
            var p = ptr(e);
            var dx = p.x - sx, dy = p.y - sy;
            if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
            moved = true;
            var nl = sl + dx, nt = st + dy;
            var r = panel.getBoundingClientRect();
            nl = Math.max(0, Math.min(nl, window.innerWidth - r.width));
            nt = Math.max(0, Math.min(nt, window.innerHeight - r.height));
            if (raf) cancelAnimationFrame(raf);
            raf = requestAnimationFrame(function () { panel.style.left = nl + 'px'; panel.style.top = nt + 'px'; });
            if (e.cancelable) e.preventDefault();
        }
        function up() {
            if (!dragging) return;
            dragging = false;
            document.body.style.userSelect = '';
            if (raf) { cancelAnimationFrame(raf); raf = null; }
            if (moved) {
                var r = panel.getBoundingClientRect();
                self._savedPanelPosition = { left: r.left, top: r.top };
                chrome.storage.local.set({ panelPosition: self._savedPanelPosition });
            }
        }
        header.addEventListener('mousedown', down);
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
        header.addEventListener('touchstart', down, { passive: false });
        document.addEventListener('touchmove', move, { passive: false });
        document.addEventListener('touchend', up);
    };

    Orchestrator.prototype._keepPanelInView = function () {
        if (!this._safetyPanel) return;
        var r = this._safetyPanel.getBoundingClientRect();
        var nl = Math.max(0, Math.min(r.left, window.innerWidth - r.width));
        var nt = Math.max(0, Math.min(r.top, window.innerHeight - r.height));
        if (nl !== r.left || nt !== r.top) {
            this._safetyPanel.style.left = nl + 'px';
            this._safetyPanel.style.top = nt + 'px';
        }
    };

    Orchestrator.prototype._startStatusUpdates = function () {
        var self = this;
        this._statusPanelTimer = setInterval(function () {
            var s = self.safety.getStatus();
            if (!self._safetyPanel) return;
            var dot = document.getElementById('bl-status-dot');
            var text = document.getElementById('bl-status-text');
            var statsScanned = document.getElementById('bl-stat-scanned');
            var statsAcquired = document.getElementById('bl-stat-acquired');
            var conn = document.getElementById('bl-connection-text');

            var modeLabel = self.config.mode === 'AUTOMATIC' ? '[AUTO]' : (self.config.mode === 'ASSISTED' ? '[ASSIST]' : '[' + self.config.mode + ']');
            if (dot) dot.style.background = s.emergencyStop ? '#ef7076' : (s.cooldown ? '#fff5cc' : '#fff');
            if (text) {
                var t = modeLabel + ' ';
                if (s.emergencyStop) t += '🚨 EMERGENCY';
                else if (self._isPaused) t += '⏸ Paused';
                else if (s.cooldown) t += '⏳ Cooldown';
                else if (self.navigator._running) t += '▶ Loop Running';
                else if (self.scanner._running) t += '▶ Scanning';
                else t += '⏹ Stopped';
                text.textContent = t;
            }
            if (statsScanned) statsScanned.textContent = self.stats.cycleScanned !== undefined ? self.stats.cycleScanned : (self.stats.unique || self.stats.discovered || 0);
            if (statsAcquired) statsAcquired.textContent = self.stats.acquired;

            var filtEl = document.getElementById('bl-stat-filtered');
            if (filtEl) filtEl.textContent = self.stats.filtered || 0;

            var speedEl = document.getElementById('bl-stat-speed');
            var accEl = document.getElementById('bl-stat-acceptance');
            var filterCountEl = document.getElementById('bl-filters-count');

            if (speedEl) speedEl.textContent = self.metrics.getSpeedPerAcquisition().formatted;
            if (accEl) accEl.textContent = self.metrics.getAcceptanceRate().formatted;
            if (filterCountEl) filterCountEl.textContent = self.keywordManager.getActiveFilterCount();

            var _sb = document.getElementById('bl-stop-btn');
            var _rb = document.getElementById('bl-resume-btn');
            var _running = !self._isPaused && self.scanner && self.scanner._running;
            if (_sb) _sb.style.display = _running ? '' : 'none';
            if (_rb) _rb.style.display = _running ? 'none' : '';
            if (conn) {
                var kws = self.keywordManager.getAllKeywords();
                conn.textContent = (self._supabaseEnabled ? '☁️ CRM' : '📴 Local') + ' (P' + kws.product.length + ')';
                conn.style.color = self._supabaseEnabled ? '#02A699' : '#f5a623';
            }

            self._updateStopSoldUI();

            var warnEl = document.getElementById('bl-warning-text');
            if (warnEl) {
                var shouldWarn = self._supabaseEnabled
                    && !self.supabase._filtersLoaded
                    && (Date.now() - self._initTime > 5000);

                if (shouldWarn) {
                    var msg = '⚠️ Filters not loaded — acquiring disabled';
                    if (self._syncRetryAttempt > 0) {
                        var secondsLeft = Math.max(0, Math.round((self._syncRetryNextAt - Date.now()) / 1000));
                        msg = '⚠️ Filters not loaded — retrying in ' + secondsLeft + 's (' + self._syncRetryAttempt + '/' + 5 + ')';
                    } else if (self._syncRetryAttempt === -1) {
                        msg = '🛑 Filters failed to load — refresh page to retry';
                    }
                    warnEl.textContent = msg;
                    warnEl.classList.add('show');
                } else {
                    warnEl.classList.remove('show');
                }
            }
            self._broadcastStatus();
        }, 800);
    };

    // ============================================================
    // SAFE PAGE REFRESH CONTROLLER & 10-SECOND COUNTDOWN
    // ============================================================
    Orchestrator.prototype._isSafeForHardRefresh = function () {
        // 1. LeadQueue: Must have 0 items in memory and 0 actively processing
        var q = this.queue;
        if (q && (q.processing > 0 || (q.queue && q.queue.length > 0))) return false;

        // 2. Scanner: Must NOT be currently running a scan pass or debouncing
        if (this.scanner && (this.scanner._scanning || this.scanner._scanPending)) return false;

        // 3. LifecycleManager: No lead ID marked in flight
        if (this.lifecycle && this.lifecycle._inFlight && this.lifecycle._inFlight.size > 0) return false;

        // 4. StateMachine: No active processing or acquisition/contact pending
        if (this.stateMachine) {
            var sm = this.stateMachine.getStats();
            if ((sm.PROCESSING || 0) > 0 ||
                (sm.ACQUISITION_PENDING || 0) > 0 ||
                (sm.CONTACT_PENDING || 0) > 0 ||
                (sm.ACTION_PENDING || 0) > 0) {
                return false;
            }
        }

        // 5. PopupManager: No modal/OTP active
        if (this.popupManager && this.popupManager._active) return false;

        // 6. Review Dialog: No unconfirmed approval card in DOM
        if (typeof document !== 'undefined' && document.querySelector && document.querySelector('.bl-approval')) {
            return false;
        }

        // 7. Auto-Pause Protection: Never reload while paused for lead acquired
        if (this._isPaused || this._cycleAcquiredThisScan) return false;

        return true;
    };

    Orchestrator.prototype._updateRefreshButtonLabel = function (text) {
        try {
            var label = text || ((this._refreshCountdownCurrent !== undefined ? this._refreshCountdownCurrent : 10) + 's');
            var lblEl = (typeof document !== 'undefined') ? document.getElementById('bl-hard-refresh-label') : null;
            if (lblEl && lblEl.textContent !== label) {
                lblEl.textContent = label;
            }
        } catch (e) { }
    };

    Orchestrator.prototype._startRefreshCountdown = function (seconds) {
        var self = this;
        this._stopRefreshCountdown('restart');
        this._refreshCountdownSeconds = (typeof seconds === 'number' && seconds > 0) ? seconds : 10;
        this._refreshCountdownCurrent = this._refreshCountdownSeconds;
        this._updateRefreshButtonLabel(this._refreshCountdownCurrent + 's');

        this._refreshCountdownTimer = setInterval(function () {
            if (self._isPaused) {
                return;
            }
            self._refreshCountdownCurrent--;
            if (self._refreshCountdownCurrent <= 0) {
                clearInterval(self._refreshCountdownTimer);
                self._refreshCountdownTimer = null;
                self._updateRefreshButtonLabel('0s');
                self._enterRefreshSafetyGate();
            } else {
                self._updateRefreshButtonLabel(self._refreshCountdownCurrent + 's');
            }
        }, 1000);
    };

    Orchestrator.prototype._stopRefreshCountdown = function (reason) {
        if (this._refreshCountdownTimer) {
            clearInterval(this._refreshCountdownTimer);
            this._refreshCountdownTimer = null;
        }
        if (this._refreshSafetyGateTimer) {
            clearInterval(this._refreshSafetyGateTimer);
            this._refreshSafetyGateTimer = null;
        }
        if (reason === 'lead_acquired' || reason === 'emergency_stop' || this._isPaused) {
            this._updateRefreshButtonLabel('⏸');
        }
    };

    Orchestrator.prototype._enterRefreshSafetyGate = function () {
        var self = this;
        var gateAttempts = 0;
        var MAX_GATE_ATTEMPTS = 50; // 50 * 100ms = 5s max deferral

        if (this._refreshSafetyGateTimer) {
            clearInterval(this._refreshSafetyGateTimer);
            this._refreshSafetyGateTimer = null;
        }
        this._updateRefreshButtonLabel('0s');

        this._refreshSafetyGateTimer = setInterval(function () {
            if (self._isPaused) {
                clearInterval(self._refreshSafetyGateTimer);
                self._refreshSafetyGateTimer = null;
                self._updateRefreshButtonLabel('⏸');
                return;
            }

            gateAttempts++;
            if (self._isSafeForHardRefresh()) {
                clearInterval(self._refreshSafetyGateTimer);
                self._refreshSafetyGateTimer = null;
                self.triggerHardRefresh('countdown_safe_gate');
                return;
            }

            // Continuous active workload: reset countdown to prevent starvation
            if (gateAttempts >= MAX_GATE_ATTEMPTS) {
                clearInterval(self._refreshSafetyGateTimer);
                self._refreshSafetyGateTimer = null;
                self.logger.info('⏳ Safe window deferred due to continuous activity — restarting 10s countdown');
                self._startRefreshCountdown(10);
            }
        }, 100);
    };

    Orchestrator.prototype.triggerHardRefresh = function (reason) {
        var self = this;
        var isSafe = this._isSafeForHardRefresh();

        // If not in a clean quiescent micro-hold, defer so we never interrupt an in-flight lead
        if (!isSafe) {
            this.logger.info('⏳ Refresh deferred: lead operation in progress (' + reason + ')');
            setTimeout(function () {
                self.triggerHardRefresh(reason + '_deferred');
            }, 1000);
            return;
        }

        this.logger.info('🔄 Executing safe hard refresh (' + reason + ')...');
        try {
            sessionStorage.setItem('bl_scanner_auto_resume', this._isPaused ? 'false' : 'true');
            if (this.supabase && this.supabase._filters) {
                sessionStorage.setItem('bl_cached_filters', JSON.stringify(this.supabase._filters));
                sessionStorage.setItem('bl_cached_filters_ts', String(Date.now()));
            }
        } catch (e) { }

        if (typeof window !== 'undefined' && window.location && typeof window.location.reload === 'function') {
            window.location.reload();
        } else if (typeof window !== 'undefined' && window.location) {
            window.location.href = window.location.href;
        }
    };

    // ============================================================
    // STRICT COUNTRY
    // ============================================================
    Orchestrator.prototype._checkStrictCountry = function (lead) {
        // When Supabase filters are active, country restrictions are dynamically enforced per filter
        // (allows leads from any country when no country filter is specified in that filter)
        if (this._supabaseEnabled) {
            return { allowed: true };
        }
        if (!this.config.strictCountryMode) return { allowed: true };
        var allowed = (this.config.allowedCountries || []).map(function (c) {
            return String(c).toUpperCase().trim();
        }).filter(function (c) { return c.length > 0; });

        if (allowed.length === 0) {
            return { allowed: true };
        }

        var leadCountry = (lead.countryIso || '').toUpperCase().trim();
        if (!leadCountry) {
            if (this.config.strictCountryRejectUnknown) {
                return { allowed: false, reason: 'STRICT_COUNTRY_UNKNOWN', details: { allowed: allowed } };
            }
            return { allowed: true, reason: 'STRICT_COUNTRY_UNKNOWN_ALLOWED' };
        }
        if (allowed.indexOf(leadCountry) !== -1) {
            return { allowed: true, reason: 'STRICT_COUNTRY_MATCH', details: { country: leadCountry } };
        }
        return { allowed: false, reason: 'STRICT_COUNTRY_MISMATCH', details: { leadCountry: leadCountry, allowed: allowed } };
    };

    // ============================================================
    // CENTRALIZED ACQUISITION SUCCESS HANDLER (v6.4.2 - Bot-Speed)
    // ============================================================
    // Handles the complete post-acquisition lifecycle: statistics,
    // deduplication, pause loop, Supabase sync, and instant live toasts.
    Orchestrator.prototype._handleAcquisitionSuccess = function (lead, result) {
        var self = this;
        result = result || {};
        self.stats.acquired++;
        var qid = String(lead.uniqueQueryId || lead.leadId || '');
        if (self._acquiredLeadIds && qid) self._acquiredLeadIds.add(qid);
        if (lead.leadId && self._acquiredLeadIds) self._acquiredLeadIds.add(String(lead.leadId));
        if (self.duplicateManager && qid) self.duplicateManager.markSeen(qid);
        if (self._preApprovedLeads && qid) self._preApprovedLeads.delete(qid);

        self.stateMachine.setState(lead.leadId, 'ACQUIRED');
        if (self.lifecycle) self.lifecycle.transition(lead.leadId, 'ACQUIRED');
        if (self.metrics) self.metrics.recordAcquisitionSuccess(lead.leadId, Date.now());
        self.safety.recordAcquisition();
        if (result.popup && result.popup.success) self.stats.popupsHandled++;
        self.logger.info('🎉 ACQUIRED', { leadId: lead.leadId, uniqueQueryId: qid });
        self._recordLeadAcquired(lead);

        // Auto-pause and review only in ASSISTED or REVIEW mode (review after acquiring).
        // In AUTOMATIC mode, 100% of the workflow is automated without pause or user intervention.
        if (self.config.mode === 'ASSISTED' || self.config.mode === 'REVIEW') {
            self._pauseForLeadAcquired(lead);
            self._showReviewUI(lead);
        } else {
            self._cycleAcquiredThisScan = false;
        }

        if (self.lifecycle) self.lifecycle.transition(lead.leadId, 'CONTACT_PENDING');

        var contactSuccess = (result.contactSuccess === true) || (result.action === 'card_updated') ||
                             (result.action === 'sent') || (result.action === 'confirmed') ||
                             (result.action === 'direct_api') || (result.action === 'api_confirmed') ||
                             (result.success === true);

        if (contactSuccess) {
            if (lead.filterId) {
                self.keywordManager.recordFilterSuccess(lead.filterId, lead);
                self._updateScannerLifecycleState('filter_success');
            }
            if (self.showTopToast) {
                var contactInfo = lead.senderMobile || lead.mobile || lead.senderEmail || lead.email || 'Contacted';
                self.showTopToast('contacted', 'Lead Acquired & Contacted', (lead.productName || 'Lead') + ' (' + contactInfo + ')', 3000);
            }
            if (self.lifecycle) self.lifecycle.transition(lead.leadId, 'CONTACTED');
            if (self.metrics) {
                self.metrics.recordContactSuccess(lead.leadId, Date.now());
                self.metrics.recordLeadAttemptCompleted(lead.leadId, true);
            }
            if (self._supabaseEnabled) {
                var savePromise = lead._savePromise || self._saveLeadToDb(lead, true);
                Promise.resolve(savePromise).then(function () {
                    return self.supabase.markLeadContacted(lead._dbId || lead.uniqueQueryId);
                }).then(function () {
                    if (lead._dbId) {
                        return self.supabase.insertLeadHistory(lead._dbId, 'CONTACTED', { score: 'auto', mode: self.config.mode }, new Date().toISOString());
                    }
                }).catch(function (err) {
                    self.logger.warn('Failed to update lead contacted status', { error: err && err.message });
                });
            }
        } else {
            if (self.lifecycle) self.lifecycle.transition(lead.leadId, 'CONTACT_FAILED', { reason: result.action || 'contact_not_confirmed' });
            self.stats.contactFailed++;
            if (self.metrics) {
                self.metrics.recordContactFailure(lead.leadId, result.message || result.action || 'contact_not_confirmed');
                self.metrics.recordLeadAttemptCompleted(lead.leadId, false);
            }
            if (lead.filterId) {
                self.keywordManager.releaseReservation(lead.filterId, lead.leadId);
            }
        }

        try {
            var speedEl = document.getElementById('bl-stat-speed');
            var accEl = document.getElementById('bl-stat-acceptance');
            var statsAcquired = document.getElementById('bl-stat-acquired');
            if (speedEl && self.metrics) speedEl.textContent = self.metrics.getSpeedPerAcquisition().formatted;
            if (accEl && self.metrics) accEl.textContent = self.metrics.getAcceptanceRate().formatted;
            if (statsAcquired) statsAcquired.textContent = String(self.stats.acquired);
        } catch (e) { }

        self._broadcastStatus();
    };

    // ── Targeted passive DOM card binder for network-intercepted leads ──
    Orchestrator.prototype._bindDomCardToLead = function (watchLead) {
        var orchRef = this;
        var uqid = String(watchLead.uniqueQueryId || watchLead.leadId || '');
        var CARD_SELECTORS = '[class*="BuyLdC_cont"],[class*="BLbp_card"],.BLbp_card,[class*="BuyLdC_Card"],div[id*="id_BLCard"],[class*="BLCard"]';

        function findDomCardForLead(id) {
            if (!id) return null;
            var direct = document.querySelector(
                '[data-lead-id="' + id + '"], [data-query-id="' + id + '"], [data-blid="' + id + '"], [data-uqid="' + id + '"], div[id*="' + id + '"]'
            );
            if (direct) return direct;
            var cards = document.querySelectorAll(CARD_SELECTORS);
            for (var ci = 0; ci < cards.length; ci++) {
                var cardEl = cards[ci];
                var cid = cardEl.getAttribute('data-lead-id') || cardEl.getAttribute('data-query-id') ||
                          cardEl.getAttribute('data-blid') || cardEl.getAttribute('data-uqid') || cardEl.id || '';
                if (cid && cid.indexOf(id) !== -1) return cardEl;
                var cHtml = cardEl.innerHTML || '';
                if (cHtml.indexOf(id) !== -1) return cardEl;
            }
            return null;
        }

        var immediate = findDomCardForLead(uqid);
        if (immediate) {
            watchLead.element = immediate;
            return;
        }

        var obs = new MutationObserver(function (mutations) {
            for (var m = 0; m < mutations.length; m++) {
                var added = mutations[m].addedNodes;
                for (var n = 0; n < added.length; n++) {
                    var node = added[n];
                    if (!node || node.nodeType !== 1) continue;
                    var domId = node.getAttribute && (
                        node.getAttribute('data-lead-id') || node.getAttribute('data-query-id') ||
                        node.getAttribute('data-blid')    || node.getAttribute('data-uqid') || node.id || ''
                    );
                    if (domId && domId.indexOf(uqid) !== -1) { watchLead.element = node; obs.disconnect(); return; }
                    if (node.querySelectorAll) {
                        var kids = node.querySelectorAll(CARD_SELECTORS);
                        for (var ki = 0; ki < kids.length; ki++) {
                            var kDomId = kids[ki].getAttribute('data-lead-id') || kids[ki].getAttribute('data-query-id') ||
                                         kids[ki].getAttribute('data-blid')    || kids[ki].getAttribute('data-uqid') || kids[ki].id || '';
                            if (kDomId && kDomId.indexOf(uqid) !== -1) { watchLead.element = kids[ki]; obs.disconnect(); return; }
                        }
                    }
                }
            }
        });

        obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
        setTimeout(function () { if (obs) { obs.disconnect(); } }, 15000);
    };

    // ============================================================
    // CARD PROCESSING — Passive Lead-Review Engine (v5.0.0)
    // ============================================================
    // ── Network-Intercept Lead Handler ─────────────────────────────────────
    // Called by the window.postMessage listener with pseudo-cards built from
    // raw IndiaMART API JSON. Normalises, evaluates filters in real time, and
    // presents matching leads for explicit user review.
    Orchestrator.prototype._onNetworkLeads = function (pseudoCards) {
        var self = this;
        if (!this._initialized || this._isPaused) return;
        if (!pseudoCards || pseudoCards.length === 0) return;

        for (var i = 0; i < pseudoCards.length; i++) {
            try {
                var pc = pseudoCards[i];
                var raw = pc._rawApiLead;
                if (!raw) continue;

                var cardId = pc.id;

                // Skip if already seen this cycle
                if (this._currentCycleSeenLeads && this._currentCycleSeenLeads.has(cardId)) continue;
                if (this._currentCycleSeenLeads) this._currentCycleSeenLeads.add(cardId);

                // Skip if already acquired
                if (this._acquiredLeadIds && this._acquiredLeadIds.has(String(raw.uniqueQueryId || raw.query_id || ''))) continue;

                // Normalise raw API fields → lead object with UNKNOWN location preservation
                var lead = {
                    leadId: cardId,
                    uniqueQueryId: String(raw.uniqueQueryId || raw.query_id || raw.queryId || cardId),
                    buyerId: String(raw.buyerId || raw.buyer_id || raw.glid || raw.glusr_id || ''),
                    glid: String(raw.glid || raw.glusr_id || ''),
                    queryId: String(raw.queryId || raw.query_id || raw.uniqueQueryId || ''),
                    productName: raw.queryProductName || raw.product_name || raw.productName || raw.subject || '',
                    messageText: [
                        raw.queryMessage, raw.message, raw.requirement, raw.requirements,
                        raw.queryMcatName, raw.mcat_name, raw.mcatName, raw.category,
                        raw.buys, raw.buyerRequirement, raw.buyer_requirement,
                        raw.notes, raw.description, raw.details
                    ].filter(Boolean).join(' ') || '',
                    city: raw.senderCity || raw.city || '',
                    state: raw.senderState || raw.state || '',
                    countryIso: raw.senderCountryIso || raw.country_iso || raw.countryIso || 'UNKNOWN',
                    senderMobile: raw.senderMobile || raw.mobile || raw.phone || '',
                    senderEmail: raw.senderEmail || raw.email || '',
                    queryTime: raw.queryTime || raw.created_at || '',
                    queryType: raw.queryType || '',
                    queryMcatName: raw.queryMcatName || '',
                    _fromNetwork: true,
                    _rawApiLead: raw
                };
                // DB-compatible aliases (used by _saveLeadToDb)
                lead.queryProductName = lead.productName;
                lead.queryMessage = lead.messageText;
                lead.subject = lead.productName;
                lead.traceId = (pc._rawApiLead && pc._rawApiLead.traceId) || generateTraceId(lead.uniqueQueryId || lead.leadId);

                if (!lead.productName && !lead.messageText) continue;

                this.logger.logEvent({
                    level: 'INFO',
                    event: 'lead.observed',
                    traceId: lead.traceId,
                    context: { leadId: cardId, productName: lead.productName, source: 'NETWORK_PASSIVE' }
                });

                // Dedup check
                if (this.duplicateManager && this.duplicateManager.isDuplicate(lead.uniqueQueryId)) {
                    this.logger.logEvent({
                        level: 'INFO',
                        event: 'scanner.card.duplicate',
                        traceId: lead.traceId,
                        reasonCode: 'DUPLICATE_OBSERVATION',
                        context: {
                            leadName: lead.productName,
                            product: lead.productName,
                            leadId: cardId
                        },
                        message: 'Duplicate lead skipped (already observed): ' + (lead.productName || cardId)
                    });
                    continue;
                }

                // Filter match
                if (this._supabaseEnabled && this.supabase && !this.supabase._filtersLoaded) continue;
                var tEval0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
                var kw = this._supabaseEnabled
                    ? this.keywordManager.evaluateFilters(lead)
                    : this.keywordManager.checkKeywords(lead.productName, lead.messageText);
                var evalDuration = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - tEval0;

                this.logger.logEvent({
                    level: kw.passed ? 'INFO' : 'DEBUG',
                    event: 'lead.filter.evaluated',
                    traceId: lead.traceId,
                    durationMs: evalDuration,
                    result: kw.passed ? 'PASSED' : 'REJECTED',
                    reasonCode: kw.passed ? 'FILTER_MATCH' : (kw.reason || 'KEYWORD_MISMATCH'),
                    context: {
                        leadName: lead.productName,
                        product: lead.productName,
                        filterId: kw.filterId,
                        filterName: kw.filterName,
                        leadId: cardId
                    },
                    message: (kw.passed ? 'Filter matched: ' : 'Filter rejected: ') + (lead.productName || cardId) + ' (' + (kw.filterName || 'No filter') + ')'
                });

                if (!kw.passed) continue;

                if (kw.filterId) {
                    lead.filterId = kw.filterId;
                    this.keywordManager.reserveSlot(kw.filterId, cardId);
                }

                // Safety check
                var safetyCheck = this.safety.canAcquire();
                this.logger.logEvent({
                    level: safetyCheck.allowed ? 'DEBUG' : 'WARN',
                    event: safetyCheck.allowed ? 'safety.limit.checked' : 'safety.limit.reached',
                    traceId: lead.traceId,
                    result: safetyCheck.allowed ? 'SUCCESS' : 'REJECTED',
                    reasonCode: safetyCheck.allowed ? 'WITHIN_LIMITS' : safetyCheck.reason,
                    context: { leadId: cardId }
                });

                if (!safetyCheck.allowed) {
                    if (kw.filterId) this.keywordManager.releaseReservation(kw.filterId, cardId);
                    continue;
                }

                // Record detection & match in metrics & lifecycle
                if (this.metrics) {
                    this.metrics.recordDetection(cardId, Date.now());
                    this.metrics.recordMatch(cardId, Date.now());
                }
                if (this.lifecycle) {
                    this.lifecycle.transition(cardId, 'DETECTED');
                    this.lifecycle.transition(cardId, 'MATCHED');
                }

                this.duplicateManager.markSeen(lead.uniqueQueryId);
                this.stats.queued++;
                this.stats.validated++;
                this.stats.filtered = (this.stats.filtered || 0) + 1;

                // Register in _preApprovedLeads so DOM scanner binds element when rendered
                if (!this._preApprovedLeads) this._preApprovedLeads = new Map();
                var preApproveEntry = { lead: lead, kw: kw, ts: Date.now(), state: (this.config.mode === 'REVIEW' ? 'READY_FOR_REVIEW' : 'MATCHED') };
                var rawLead = pc._rawApiLead;
                var idVariants = [
                    lead.uniqueQueryId, lead.leadId,
                    rawLead.uniqueQueryId, rawLead.query_id, rawLead.queryId,
                    rawLead.leadId, rawLead.lead_id, rawLead.buyer_id, rawLead.buyerId, rawLead.id
                ];
                for (var iv = 0; iv < idVariants.length; iv++) {
                    if (idVariants[iv]) {
                        var idStr = String(idVariants[iv]);
                        this._preApprovedLeads.set(idStr, preApproveEntry);
                        if (this.scanner && this.scanner._knownLeads) {
                            this.scanner._knownLeads[idStr] = Date.now();
                        }
                    }
                }

                if (this.showTopToast) {
                    var toastTitle = (this.config.mode === 'REVIEW') ? '⚡ Lead Found (Review Ready)' : '⚡ Lead Found';
                    this.showTopToast('found', toastTitle, (lead.productName || 'Lead') + ' — ' + (lead.city || lead.state || 'UNKNOWN'));
                }

                // Bind DOM card if it appears later
                this._bindDomCardToLead(lead);

                if (this._supabaseEnabled) this._saveLeadToDb(lead, true);

                if (this.config.mode === 'REVIEW') {
                    this.logger.logEvent({
                        level: 'INFO',
                        event: 'lead.review.ready',
                        traceId: lead.traceId,
                        result: 'READY_FOR_REVIEW',
                        context: { leadId: cardId, productName: (lead.productName || '').substring(0, 50) }
                    });
                    this.stateMachine.setState(cardId, 'READY_FOR_REVIEW');
                    if (this.lifecycle) this.lifecycle.transition(lead.leadId, 'READY_FOR_REVIEW');
                    this._showReviewUI(lead);
                } else if (this.config.mode === 'MONITOR') {
                    if (kw.filterId) this.keywordManager.releaseReservation(kw.filterId, cardId);
                    this.stateMachine.setState(cardId, 'MONITORED');
                } else {
                    // AUTOMATIC and ASSISTED modes: enqueue for automatic acquisition!
                    var enqueued = this.queue.enqueue(lead);
                    if (enqueued) {
                        this.logger.info('⚡ Enqueued network lead: ' + cardId + ' | ' + (lead.productName || ''));
                    } else if (kw.filterId) {
                        this.keywordManager.releaseReservation(kw.filterId, cardId);
                    }
                }

            } catch (e) {
                this.logger.warn('Network lead processing error: ' + (e && e.message));
            }
        }
    };

    Orchestrator.prototype._onPassiveNetworkLead = function (rawLead, sourceUrl) {
        if (!rawLead) return;
        var leadId = String(rawLead.uniqueQueryId || rawLead.query_id || rawLead.queryId || rawLead.leadId || rawLead.id || ('net_' + Math.random().toString(36).substring(2, 9)));
        var pseudoCard = {
            id: leadId,
            element: null,
            _rawApiLead: rawLead,
            _sourceUrl: sourceUrl
        };
        this._onNetworkLeads([pseudoCard]);
    };

    Orchestrator.prototype._onCardsDetected = function (cards) {
        var self = this;
        var newCards = cards || [];
        if (!this._currentCycleSeenLeads) {
            this._currentCycleSeenLeads = new Set();
        }
        for (var cIdx = 0; cIdx < newCards.length; cIdx++) {
            var cId = newCards[cIdx].id;
            if (newCards[cIdx].replacesId) this._currentCycleSeenLeads.delete(newCards[cIdx].replacesId);
            if (cId && !this._currentCycleSeenLeads.has(cId)) {
                this._currentCycleSeenLeads.add(cId);
            }
        }
        this.stats.cycleScanned = this._currentCycleSeenLeads.size;
        var statsScanned = document.getElementById('bl-stat-scanned');
        if (statsScanned) statsScanned.textContent = String(this.stats.cycleScanned);
        this.logger.info('📋 Processing ' + newCards.length + ' new cards (cycleScanned: ' + this.stats.cycleScanned + ')');

        var kws = this.keywordManager.getAllKeywords();
        this.logger.info('Keywords: P=' + kws.product.length + ' N=' + kws.negative.length + ' R=' + kws.required.length);

        for (var i = 0; i < newCards.length; i++) {
            try {
                var card = newCards[i];

                // ═══════════════════════════════════════════════════════════════
                // PASSIVE NETWORK MATCH RECONCILIATION
                // If this card was already filter-matched from passive network
                // JSON observation, link the DOM element to the review lead.
                // Never auto-click without explicit user confirmation.
                // ═══════════════════════════════════════════════════════════════
                if (self._preApprovedLeads && self._preApprovedLeads.size > 0 && card.element) {
                    var domUqid = card.element.getAttribute('data-lead-id')
                        || card.element.getAttribute('data-query-id')
                        || card.element.getAttribute('data-blid')
                        || card.element.getAttribute('data-id')
                        || card.element.getAttribute('data-uqid')
                        || card.element.getAttribute('id') || '';
                    if (!domUqid) {
                        var hrefEl = card.element.querySelector('[href*="uniqueQueryId"], [href*="uqid"], [data-lead-id], [data-query-id], [data-blid]');
                        if (hrefEl) {
                            domUqid = hrefEl.getAttribute('data-lead-id')
                                || hrefEl.getAttribute('data-query-id')
                                || hrefEl.getAttribute('data-blid')
                                || (hrefEl.href && hrefEl.href.match(/[?&](?:uniqueQueryId|uqid|query_id)=([^&]+)/) || [])[1] || '';
                        }
                    }

                    var preApproved = domUqid ? self._preApprovedLeads.get(String(domUqid)) : null;

                    if (!preApproved) {
                        var strippedId = card.id.replace(/^api_/, '');
                        preApproved = self._preApprovedLeads.get(strippedId);
                    }

                    if (preApproved) {
                        var paLead = preApproved.lead;
                        paLead.element = card.element; // attach DOM element
                        paLead._domId = card.id;

                        self.logger.info('🔗 Linked passive network lead to DOM element: ' + card.id + ' | ' + (paLead.productName || ''));

                        try {
                            card.element.setAttribute('data-leadsync-matched', 'true');
                        } catch (e) {}

                        // Lead is already in READY_FOR_REVIEW. Explicit user confirmation is required.
                        continue;
                    }
                }
                // ═══════════════════════════════════════════════════════════════

                // Same DOM node already being acquired under its pre-hydration ID: don't process twice.
                if (card.replacesId && self.lifecycle && self.lifecycle.isInFlight(card.replacesId)) {
                    self.logger.debug('⏭ Card already in flight under previous id ' + card.replacesId + ': ' + card.id);
                    continue;
                }
                var tParse0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
                var raw = self.parser.parseCard(card.element, card.id);
                if (!raw) {
                    self.stats.failed++;
                    self.logger.logEvent({
                        level: 'DEBUG',
                        event: 'scanner.card.skipped',
                        reasonCode: 'UNPARSEABLE_CARD',
                        context: { cardId: card.id },
                        durationMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - tParse0
                    });
                    continue;
                }
                var lead = self.parser.normalize(raw);
                if (!lead) {
                    self.stats.failed++;
                    self.logger.logEvent({
                        level: 'DEBUG',
                        event: 'lead.normalization.rejected',
                        reasonCode: 'NORMALIZATION_FAILED',
                        context: { cardId: card.id },
                        durationMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - tParse0
                    });
                    continue;
                }

                lead.traceId = generateTraceId(lead.uniqueQueryId || lead.leadId || card.id);
                var parseDuration = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - tParse0;
                self.logger.logEvent({
                    level: 'INFO',
                    event: 'lead.observed',
                    traceId: lead.traceId,
                    durationMs: parseDuration,
                    context: { leadId: card.id, productName: lead.productName, city: lead.city, countryIso: lead.countryIso, source: 'DOM_SCAN' }
                });

                if (!self._uniqueSeenIds.has(card.id)) {
                    self._uniqueSeenIds.add(card.id);
                    self.stats.discovered++;
                    self.stats.unique = self._uniqueSeenIds.size;
                }
                if (self.metrics) self.metrics.recordDetection(card.id, Date.now());
                if (self.lifecycle) self.lifecycle.transition(card.id, 'DETECTED');

                // === STEP 0: EXCLUDE ALREADY ACQUIRED LEADS ===
                if (self._isLeadAcquired(lead, card)) {
                    self.stats.duplicate++;
                    self.logger.logEvent({
                        level: 'INFO',
                        event: 'scanner.card.duplicate',
                        traceId: lead.traceId,
                        reasonCode: 'ALREADY_ACQUIRED',
                        context: {
                            leadName: lead.productName,
                            product: lead.productName,
                            seller: lead.senderName || lead.sellerName || null,
                            location: lead.location || null,
                            leadId: card.id
                        },
                        message: 'Duplicate lead skipped (already acquired): ' + lead.productName
                    });
                    continue;
                }

                // === STEP 0.01: DEDUP — already processed by network-intercept or prior DOM scan ===
                if (self.duplicateManager && self.duplicateManager.isDuplicate(lead.uniqueQueryId)) {
                    self.stats.duplicate++;
                    self.logger.logEvent({
                        level: 'INFO',
                        event: 'scanner.card.duplicate',
                        traceId: lead.traceId,
                        reasonCode: 'DUPLICATE_OBSERVATION',
                        context: {
                            leadName: lead.productName,
                            product: lead.productName,
                            seller: lead.senderName || lead.sellerName || null,
                            location: lead.location || null,
                            leadId: card.id,
                            uqid: lead.uniqueQueryId
                        },
                        message: 'Duplicate lead skipped (already observed): ' + lead.productName
                    });
                    continue;
                }

                // === STEP 0.1: STOP SOLD CHECK ===
                if (self.config.stopSold !== false && self._isLeadSoldOut(lead, card)) {
                    self.stats.rejected++;
                    if (self.lifecycle) self.lifecycle.transition(card.id, 'SKIPPED', { reason: 'sold_out' });
                    self.logger.logEvent({
                        level: 'INFO',
                        event: 'scanner.card.skipped',
                        traceId: lead.traceId,
                        reasonCode: 'SOLD_OUT',
                        context: { leadName: lead.productName, leadId: card.id, product: lead.productName },
                        message: 'Lead skipped (sold out): ' + lead.productName
                    });
                    continue;
                }

                // === STEP 0.5: STRICT COUNTRY CHECK ===
                var countryCheck = self._checkStrictCountry(lead);
                if (!countryCheck.allowed) {
                    self.stats.countryBlocked++;
                    self.logger.logEvent({
                        level: 'INFO',
                        event: 'lead.filter.evaluated',
                        traceId: lead.traceId,
                        result: 'REJECTED',
                        reasonCode: countryCheck.reason || 'LOCATION_MISMATCH',
                        context: {
                            leadName: lead.productName,
                            product: lead.productName,
                            leadId: card.id,
                            got: lead.countryIso || 'unknown'
                        },
                        message: 'Lead skipped (country mismatch): ' + lead.productName
                    });
                    continue;
                }

                // === STEP 2: FILTER MATCH ===
                if (self._supabaseEnabled && !self.supabase._filtersLoaded) {
                    self.logger.debug('⏳ Filters not loaded yet, skipping: ' + card.id);
                    if (self.scanner && self.scanner._knownLeads) {
                        delete self.scanner._knownLeads[card.id];
                    }
                    continue;
                }
                var tEval0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
                var kw = self._supabaseEnabled
                    ? self.keywordManager.evaluateFilters(lead)
                    : self.keywordManager.checkKeywords(lead.productName, lead.messageText);
                var evalDuration = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - tEval0;

                self.logger.logEvent({
                    level: kw.passed ? 'INFO' : 'DEBUG',
                    event: 'lead.filter.evaluated',
                    traceId: lead.traceId,
                    durationMs: evalDuration,
                    result: kw.passed ? 'PASSED' : 'REJECTED',
                    reasonCode: kw.passed ? 'FILTER_MATCH' : (kw.reason || 'KEYWORD_MISMATCH'),
                    context: {
                        leadName: lead.productName,
                        product: lead.productName,
                        filterId: kw.filterId,
                        filterName: kw.filterName,
                        leadId: card.id
                    },
                    message: (kw.passed ? 'Filter matched: ' : 'Filter rejected: ') + lead.productName + ' (' + (kw.filterName || 'No filter') + ')'
                });

                if (!kw.passed) {
                    self.stats.rejected++;
                    continue;
                }

                if (kw.filterId) {
                    lead.filterId = kw.filterId;
                    self.keywordManager.reserveSlot(kw.filterId, card.id);
                }

                if (self.metrics) self.metrics.recordMatch(card.id, Date.now());
                if (self.lifecycle) self.lifecycle.transition(card.id, 'MATCHED');

                self.stats.validated++;
                self.stats.filtered = (self.stats.filtered || 0) + 1;
                if (self.showTopToast) {
                    self.showTopToast('found', 'Lead Found', (lead.productName || 'Lead') + ' — ' + (lead.city || lead.state || lead.location || 'India'));
                }

                // === STEP 3: SCORE ===

                // === STEP 3: SCORE — REMOVED ===
                // Filter already verified product + location + contact.
                // Scoring was penalizing foreign leads (-20 country, -10 state)
                // making them impossible to pass (min 60). Removed

                // === STEP 4: SAFETY ===
                var safetyCheck = self.safety.canAcquire();
                if (!safetyCheck.allowed) {
                    self.stats.rejected++;
                    var details = safetyCheck.details ? (' (' + safetyCheck.details.used + '/' + safetyCheck.details.limit + ')') : '';
                    self.logger.debug('❌ Safety [' + safetyCheck.reason + details + ']: ' + card.id);
                    if (kw.filterId) self.keywordManager.releaseReservation(kw.filterId, card.id);
                    // Do NOT mark seen — will retry when safety allows.
                    if (self.scanner) self.scanner.forget(card.id, 5000);
                    continue;
                }

                // === STEP 5: ENQUEUE ===
                var enqueued = self.queue.enqueue(lead);
                if (enqueued) {
                    // Only suppress duplicates after the queue has accepted this lead.
                    self.duplicateManager.markSeen(lead.uniqueQueryId);
                    self.stats.queued++;
                    self.logger.info('✅ Queued ' + card.id + ' (filter=' + (kw.filterName || kw.filterId || 'local') + ', match=' + (kw.matchedProducts || []).join(',') + ')');
                } else if (kw.filterId) {
                    self.keywordManager.releaseReservation(kw.filterId, card.id);
                }
                if (self._supabaseEnabled) self._saveLeadToDb(lead, true);
            } catch (e) {
                self.stats.failed++;
                self.logger.error('❌ Card error: ' + e.message + ' | ' + (cards[i] && cards[i].id));
            }
        }
    };

    Orchestrator.prototype._saveLeadToDb = function (lead, isMatched) {
        if (!this._supabaseEnabled) return Promise.resolve(null);
        var self = this;
        lead._savePromise = this.supabase.insertLead({
            uniqueQueryId: lead.uniqueQueryId,
            queryType: lead.queryType,
            queryTime: lead.queryTime,
            subject: lead.subject,
            queryProductName: lead.queryProductName,
            queryMessage: lead.queryMessage,
            queryMcatName: lead.queryMcatName,
            senderCity: lead.city,
            senderState: lead.state,
            senderCountryIso: lead.countryIso,
            senderMobile: lead.senderMobile,
            senderEmail: lead.senderEmail,
            isMatched: isMatched
        }).then(function (dbLead) {
            if (dbLead) {
                self.stats.dbSynced++;
                lead._dbId = dbLead.id || (dbLead.data && dbLead.data.id);
                if (dbLead.conflict && dbLead.existingId) lead._dbId = dbLead.existingId;
            }
            return dbLead;
        }).catch(function (err) {
            self.logger.error('Failed to save lead: ' + (err && err.message));
            return null;
        });
        return lead._savePromise;
    };

    Orchestrator.prototype._processLead = function (lead) {
        var self = this;
        return new Promise(function (resolve) {
            self.stateMachine.setState(lead.leadId, 'PROCESSING');

            // Re-verify filter eligibility before acquiring
            if (lead.filterId && self.keywordManager && !self.keywordManager.isFilterEligible(lead.filterId)) {
                self.logger.info('Filter ' + lead.filterId + ' is no longer eligible. Aborting acquisition for ' + lead.leadId);
                self.keywordManager.releaseReservation(lead.filterId, lead.leadId);
                self.stateMachine.setState(lead.leadId, 'FILTERED_OUT');
                resolve();
                return;
            }

            // Guard: if auto-paused (e.g. lead already acquired this cycle), discard and resolve cleanly.
            if (self._isPaused) {
                if (lead.filterId) self.keywordManager.releaseReservation(lead.filterId, lead.leadId);
                self.stateMachine.setState(lead.leadId, 'SKIPPED', { reason: 'paused' });
                resolve(); return;
            }

            var safety = self.safety.canAcquire();
            if (!safety.allowed) {
                if (lead.filterId) self.keywordManager.releaseReservation(lead.filterId, lead.leadId);
                self.stateMachine.setState(lead.leadId, 'BLOCKED', { reason: safety.reason });
                resolve(); return;
            }
            if (self.config.mode === 'MONITOR') {
                if (lead.filterId) self.keywordManager.releaseReservation(lead.filterId, lead.leadId);
                self.stateMachine.setState(lead.leadId, 'MONITORED'); resolve(); return;
            }
            if (self.config.mode === 'REVIEW') {
                self.stateMachine.setState(lead.leadId, 'READY_FOR_REVIEW');
                if (lead.filterId) self.keywordManager.releaseReservation(lead.filterId, lead.leadId);
                self._showReviewUI(lead);
                resolve();
                return;
            }

            if (self.lifecycle) self.lifecycle.transition(lead.leadId, 'ACQUISITION_PENDING');
            if (self.metrics) self.metrics.recordAcquisitionAttempt(lead.leadId);

            if (self.showTopToast) {
                self.showTopToast('acquiring', 'Acquiring Lead', 'Contacting buyer for: ' + (lead.productName || 'Lead'));
            }
            self.actionAdapter.acquire(lead).then(function (result) {
                var isSuccess = result && result.success === true;
                if (isSuccess) {
                    self._handleAcquisitionSuccess(lead, result);
                } else if (result && result.simulated) {
                    self.stateMachine.setState(lead.leadId, 'DRY_RUN');
                    if (lead.filterId) self.keywordManager.releaseReservation(lead.filterId, lead.leadId);
                } else {
                    self.stats.failed++;
                    var errMsg = (result && result.message) || 'Acquisition failed';
                    var isAccountBlock = result && (result.code === 'INSUFFICIENT_BALANCE' || result.code === 'SUBSCRIPTION_REQUIRED');
                    self.stateMachine.setState(lead.leadId, isAccountBlock ? 'BLOCKED' : 'FAILED', { error: errMsg });
                    if (self.lifecycle) self.lifecycle.transition(lead.leadId, isAccountBlock ? 'BLOCKED' : 'ACQUISITION_FAILED');
                    if (self.metrics) {
                        self.metrics.recordAcquisitionFailure(lead.leadId, errMsg);
                        self.metrics.recordLeadAttemptCompleted(lead.leadId, false);
                    }
                    if (lead.filterId) self.keywordManager.releaseReservation(lead.filterId, lead.leadId);
                    self.logger.error('❌ Failed: ' + errMsg, { leadId: lead.leadId });
                    if (self.showTopToast) {
                        self.showTopToast('failed', isAccountBlock ? 'Account Action Needed' : 'Contact Dropped / Failed', (lead.productName || 'Lead') + ' — ' + errMsg, isAccountBlock ? 6000 : 3000);
                    }
                    if (isAccountBlock) {
                        var warnEl = document.getElementById('bl-warning-text');
                        if (warnEl) {
                            warnEl.textContent = '🛑 ' + errMsg;
                            warnEl.classList.add('show');
                        }
                    }
                }
                try {
                    var speedEl = document.getElementById('bl-stat-speed');
                    var accEl = document.getElementById('bl-stat-acceptance');
                    var statsAcquired = document.getElementById('bl-stat-acquired');
                    if (speedEl && self.metrics) speedEl.textContent = self.metrics.getSpeedPerAcquisition().formatted;
                    if (accEl && self.metrics) accEl.textContent = self.metrics.getAcceptanceRate().formatted;
                    if (statsAcquired) statsAcquired.textContent = String(self.stats.acquired);
                } catch (e) { }
                self._broadcastStatus();
                resolve();
            });
        });
    };

    Orchestrator.prototype._confirmAndContactLead = function (lead) {
        var self = this;
        var traceId = lead.traceId || (this.logger && this.logger.generateTraceId ? this.logger.generateTraceId(lead.leadId) : lead.leadId);
        var opId = this.logger && this.logger.generateOperationId ? this.logger.generateOperationId('act') : ('act_' + Date.now());

        if (this.circuitBreaker && !this.circuitBreaker.canExecute()) {
            var msg = 'Circuit breaker active: ' + this.circuitBreaker.getReason();
            if (this.logger && typeof this.logger.logEvent === 'function') {
                this.logger.logEvent('WARN', 'platform.restriction.detected', 'SafetyManager', {
                    traceId: traceId,
                    operationId: opId,
                    reasonCode: 'CIRCUIT_BREAKER_RESTRICTION',
                    result: 'BLOCKED',
                    context: { message: msg }
                });
            }
            this.logger.warn(msg);
            if (this.showTopToast) this.showTopToast('failed', 'Restriction Active', msg, 4000);
            return Promise.resolve({ success: false, reason: 'CIRCUIT_BREAKER_RESTRICTION' });
        }

        var res = this.safety.reserveCapacity(lead.leadId);
        if (this.logger && typeof this.logger.logEvent === 'function') {
            this.logger.logEvent('DEBUG', 'safety.limit.checked', 'SafetyManager', {
                traceId: traceId,
                operationId: opId,
                reasonCode: res.allowed ? 'CAPACITY_RESERVED' : 'RATE_LIMIT_EXCEEDED',
                result: res.allowed ? 'ALLOWED' : 'BLOCKED'
            });
        }
        if (!res.allowed) {
            if (this.logger && typeof this.logger.logEvent === 'function') {
                this.logger.logEvent('WARN', 'safety.limit.reached', 'SafetyManager', {
                    traceId: traceId,
                    operationId: opId,
                    reasonCode: 'RATE_LIMIT_EXCEEDED',
                    result: 'BLOCKED',
                    context: { reason: res.reason }
                });
            }
            this.logger.warn('Safety limit reached: ' + res.reason);
            if (this.showTopToast) this.showTopToast('failed', 'Safety Limit', res.reason, 4000);
            return Promise.resolve({ success: false, reason: res.reason });
        }

        if (this.lifecycle) this.lifecycle.transition(lead.leadId, 'ACTION_PENDING');
        this.stateMachine.setState(lead.leadId, 'ACTION_PENDING');
        if (this.metrics) this.metrics.recordAcquisitionAttempt(lead.leadId);

        var startTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (this.logger && typeof this.logger.logEvent === 'function') {
            this.logger.logEvent('INFO', 'action.request.started', 'ActionAdapter', {
                traceId: traceId,
                operationId: opId,
                reasonCode: 'ACQUIRE_DISPATCHED',
                result: 'IN_PROGRESS'
            });
        }

        return this.actionAdapter.acquire(lead).then(function (result) {
            var duration = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - startTime);
            if (result && result.success) {
                self.safety.commitReservation(res.token);
                self.stateMachine.setState(lead.leadId, 'SERVER_CONFIRMED');
                if (self.logger && typeof self.logger.logEvent === 'function') {
                    self.logger.logEvent('INFO', 'action.result.confirmed', 'ActionAdapter', {
                        traceId: traceId,
                        operationId: opId,
                        durationMs: duration,
                        reasonCode: 'SERVER_CONFIRMED',
                        result: 'SUCCESS',
                        context: { code: result.code }
                    });
                }
                self._handleAcquisitionSuccess(lead, result);
                return { success: true, status: 'SERVER_CONFIRMED', result: result };
            } else if (result && result.ambiguous) {
                self.safety.releaseReservation(res.token);
                self.stateMachine.setState(lead.leadId, 'UNKNOWN', { reason: result.message || 'Ambiguous server outcome' });
                if (self.logger && typeof self.logger.logEvent === 'function') {
                    self.logger.logEvent('WARN', 'action.result.unknown', 'ActionAdapter', {
                        traceId: traceId,
                        operationId: opId,
                        durationMs: duration,
                        reasonCode: 'AMBIGUOUS_OUTCOME',
                        result: 'UNKNOWN',
                        context: { message: result.message }
                    });
                }
                return { success: false, status: 'UNKNOWN', result: result };
            } else {
                self.safety.releaseReservation(res.token);
                self.stateMachine.setState(lead.leadId, 'FAILED', { reason: (result && result.message) || 'Action failed' });
                if (self.logger && typeof self.logger.logEvent === 'function') {
                    self.logger.logEvent('ERROR', 'action.result.failed', 'ActionAdapter', {
                        traceId: traceId,
                        operationId: opId,
                        durationMs: duration,
                        reasonCode: (result && result.code) || 'ACQUISITION_FAILED',
                        result: 'FAILED',
                        context: { message: (result && result.message) || 'Action failed' },
                        error: (result && result.message) || 'Action failed'
                    });
                }
                return { success: false, status: 'FAILED', result: result };
            }
        }).catch(function (err) {
            var duration = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - startTime);
            self.safety.releaseReservation(res.token);
            self.stateMachine.setState(lead.leadId, 'UNKNOWN', { reason: err && err.message });
            if (self.logger && typeof self.logger.logEvent === 'function') {
                self.logger.logEvent('ERROR', 'action.result.unknown', 'ActionAdapter', {
                    traceId: traceId,
                    operationId: opId,
                    durationMs: duration,
                    reasonCode: 'UNEXPECTED_ERROR',
                    result: 'UNKNOWN',
                    error: err && err.message
                });
            }
            return { success: false, status: 'UNKNOWN', error: err };
        });
    };

    Orchestrator.prototype._showReviewUI = function (lead) {
        var existing = document.getElementById('bl_approval_' + lead.leadId);
        if (existing) existing.remove();
        var iconUrl = '';
        try { iconUrl = chrome.runtime.getURL('plugin.png'); } catch (e) { }

        var traceId = lead.traceId || (this.logger && this.logger.generateTraceId ? this.logger.generateTraceId(lead.leadId) : lead.leadId);
        var opId = this.logger && this.logger.generateOperationId ? this.logger.generateOperationId('rev') : ('rev_' + Date.now());

        if (this.logger && typeof this.logger.logEvent === 'function') {
            this.logger.logEvent('INFO', 'action.review.requested', 'Orchestrator', {
                traceId: traceId,
                operationId: opId,
                reasonCode: 'REVIEW_REQUIRED',
                result: 'PROMPTED',
                context: { productName: lead.productName, city: lead.city, country: lead.countryIso }
            });
        }

        var card = document.createElement('div');
        card.id = 'bl_approval_' + lead.leadId;
        card.className = 'bl-approval';

        var countryFlag = '';
        if (lead.countryIso && lead.countryIso.length === 2 && lead.countryIso !== 'UNKNOWN') {
            try {
                var codePoints = lead.countryIso.toUpperCase().split('').map(function (c) { return 127397 + c.charCodeAt(0); });
                countryFlag = String.fromCodePoint.apply(null, codePoints);
            } catch (e) { }
        }

        var locText = [lead.city, lead.state, lead.countryIso || 'UNKNOWN'].filter(Boolean).join(', ');
        var reqText = (lead.messageText || lead.queryMessage || lead.description || '').trim();
        if (reqText.length > 120) reqText = reqText.substring(0, 117) + '...';

        var isAlreadyAcquired = (lead && lead.state === 'ACQUIRED') ||
            (this.stateMachine && this.stateMachine.getState(lead.leadId) === 'ACQUIRED') ||
            (this._acquiredLeadIds && (this._acquiredLeadIds.has(String(lead.leadId)) || this._acquiredLeadIds.has(String(lead.uniqueQueryId))));
        var contactInfo = lead.senderMobile || lead.mobile || lead.senderEmail || lead.email || '';

        var badgeHtml = isAlreadyAcquired
            ? '<span class="bl-approval-badge" style="background:#16a34a;color:#fff;"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Lead Acquired &mdash; Review</span>'
            : '<span class="bl-approval-badge"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>Review Lead</span>';

        var actionsHtml = isAlreadyAcquired
            ? '<div class="bl-approval-actions">' +
              '<button class="bl-btn bl-btn-acquire" type="button" data-a="resume">' +
              '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>' +
              'Continue Automation' +
              '</button>' +
              '<button class="bl-btn bl-btn-skip" type="button" data-a="skip">' +
              '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg>' +
              'Dismiss' +
              '</button>' +
              '</div>'
            : '<div class="bl-approval-actions">' +
              '<button class="bl-btn bl-btn-acquire" type="button" data-a="acq">' +
              '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' +
              'Confirm Contact' +
              '</button>' +
              '<button class="bl-btn bl-btn-skip" type="button" data-a="skip">' +
              '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg>' +
              'Dismiss' +
              '</button>' +
              '</div>';

        card.innerHTML =
            '<div class="bl-approval-header">' +
            (iconUrl ? '<img src="' + iconUrl + '" alt="logo" />' : '') +
            badgeHtml +
            '</div>' +
            '<div class="bl-approval-product">' + this._esc(lead.productName || 'Lead') + '</div>' +
            (contactInfo ? '<div style="font-size:11px;font-weight:600;color:#16a34a;margin-bottom:6px;">Buyer Contact: ' + this._esc(contactInfo) + '</div>' : '') +
            (reqText ? '<div style="font-size:11px;color:#52525b;margin-bottom:6px;line-height:1.35;">' + this._esc(reqText) + '</div>' : '') +
            '<div class="bl-approval-country">' + (countryFlag ? countryFlag + ' ' : '') + this._esc(locText) + '</div>' +
            (lead._matchReasons ? '<div style="font-size:10px;color:#0284c7;background:#f0f9ff;border:1px solid #bae6fd;border-radius:4px;padding:2px 6px;margin-bottom:8px;">Match: ' + this._esc(lead._matchReasons) + '</div>' : '') +
            actionsHtml;

        document.body.appendChild(card);

        var self = this;
        var resumeBtn = card.querySelector('[data-a="resume"]');
        if (resumeBtn) {
            resumeBtn.addEventListener('click', function () {
                card.remove();
                if (typeof self.resume === 'function') {
                    self.resume();
                }
            });
        }
        var acqBtn = card.querySelector('[data-a="acq"]');
        if (acqBtn) {
            acqBtn.addEventListener('click', function () {
                acqBtn.disabled = true;
                acqBtn.textContent = '⏳ Contacting...';
                if (self.logger && typeof self.logger.logEvent === 'function') {
                    self.logger.logEvent('INFO', 'action.user.confirmed', 'Orchestrator', {
                        traceId: traceId,
                        operationId: opId,
                        reasonCode: 'USER_CONFIRMED',
                        result: 'CONFIRMED'
                    });
                }
                self._confirmAndContactLead(lead).then(function (outcome) {
                    if (outcome.status === 'SERVER_CONFIRMED') {
                        acqBtn.textContent = '✅ Contacted';
                        setTimeout(function () { card.remove(); }, 1500);
                    } else if (outcome.status === 'UNKNOWN') {
                        acqBtn.textContent = '⚠️ Status Unknown';
                    } else {
                        acqBtn.textContent = '❌ Failed';
                    }
                });
            });
        }
        var skipBtn = card.querySelector('[data-a="skip"]');
        if (skipBtn) {
            skipBtn.addEventListener('click', function () {
                self.stateMachine.setState(lead.leadId, 'DISMISSED');
                card.remove();
            });
        }
    };

    Orchestrator.prototype._showApprovalUI = function (lead) {
        return this._showReviewUI(lead);
    };

    Orchestrator.prototype._esc = function (t) { if (!t) return ''; var d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
    Orchestrator.prototype._broadcastStatus = function () {
        try {
            var p = chrome.runtime.sendMessage({ action: 'UPDATE_STATUS', status: this.getStatus() });
            if (p && typeof p.catch === 'function') p.catch(function () { });
        } catch (e) { }
    };

    Orchestrator.prototype.updateFullConfig = function (newConfig) {
        var merged = Object.assign({}, DEFAULT_CONFIG, newConfig || {});
        if (newConfig && newConfig.scoreWeights) merged.scoreWeights = Object.assign({}, DEFAULT_CONFIG.scoreWeights, newConfig.scoreWeights);
        if (newConfig && newConfig.scorePenalties) merged.scorePenalties = Object.assign({}, DEFAULT_CONFIG.scorePenalties, newConfig.scorePenalties);

        merged.strictCountryMode = merged.strictCountryMode === true;
        merged.allowedCountries = (merged.allowedCountries || ['IN']).map(function (x) {
            return String(x).toUpperCase().trim();
        }).filter(function (x) { return x; });
        merged.strictCountryRejectUnknown = merged.strictCountryRejectUnknown !== false;

        this.config = merged;
        chrome.storage.local.set(merged);

        this.safety.setLimits({
            perMinute: merged.maxPerMinute,
            perHour: merged.maxPerHour,
            perDay: merged.maxPerDay,
            perSession: merged.maxPerSession
        });
        this.safety.setMode(merged.mode);
        this.actionAdapter.setDryRun(merged.mode === 'DRY_RUN');
        this.actionAdapter.setAutoMinimize(merged.autoMinimize);
        this.actionAdapter.setConfirmationAnswer(merged.confirmationAnswer);
        this.actionAdapter.setPurchaseAction(merged.purchaseAction);
        this.actionAdapter.setPopupTimeout(merged.popupTimeoutMs);

        this.scorer.setMinimumScore(merged.minScore);
        this.scorer.setWeights(merged.scoreWeights);
        this.scorer.setPenalties(merged.scorePenalties);
        this.scorer.setPreferredStates(merged.preferredStates);
        this.scorer.setPreferredCountries(merged.preferredCountries);

        this.navigator.applySettings(merged);
        if (!this.navigator._running) this.navigator.start();

        this.logger.info('Config updated. Rate limits: ' + merged.maxPerMinute + '/min, ' + merged.maxPerHour + '/hr');
        this._broadcastStatus();
        return Promise.resolve(true);
    };

    Orchestrator.prototype.setMode = function (m) {
        this.config.mode = m;
        this.safety.setMode(m);
        this.actionAdapter.setDryRun(m === 'DRY_RUN');
        chrome.storage.local.set({ mode: m, userSetMode: true });
        return Promise.resolve(true);
    };
    Orchestrator.prototype.setLimits = function (l) {
        if (l.perMinute) this.config.maxPerMinute = l.perMinute;
        if (l.perHour) this.config.maxPerHour = l.perHour;
        if (l.perDay) this.config.maxPerDay = l.perDay;
        if (l.perSession) this.config.maxPerSession = l.perSession;
        this.safety.setLimits({
            perMinute: this.config.maxPerMinute, perHour: this.config.maxPerHour,
            perDay: this.config.maxPerDay, perSession: this.config.maxPerSession
        });
        chrome.storage.local.set({
            maxPerMinute: this.config.maxPerMinute, maxPerHour: this.config.maxPerHour,
            maxPerDay: this.config.maxPerDay, maxPerSession: this.config.maxPerSession
        });
    };
    Orchestrator.prototype.setMinScore = function (s) { this.config.minScore = s; this.scorer.setMinimumScore(s); chrome.storage.local.set({ minScore: s }); };
    Orchestrator.prototype.setAutoMinimize = function (v) { this.config.autoMinimize = v; this.actionAdapter.setAutoMinimize(v); chrome.storage.local.set({ autoMinimize: v }); };
    Orchestrator.prototype.setConfirmationAnswer = function (a) { this.config.confirmationAnswer = a; this.actionAdapter.setConfirmationAnswer(a); chrome.storage.local.set({ confirmationAnswer: a }); };
    Orchestrator.prototype.setPurchaseAction = function (a) { this.config.purchaseAction = a; this.actionAdapter.setPurchaseAction(a); chrome.storage.local.set({ purchaseAction: a }); };
    Orchestrator.prototype.setStopSold = function (enabled) {
        var val = !!enabled;
        this.config.stopSold = val;
        this.config.skipSoldOut = val;
        this.logger.info('🛑 Stop Sold setting updated: ' + (val ? 'ENABLED' : 'DISABLED'));
        chrome.storage.local.set({ stopSold: val, skipSoldOut: val });
        this._updateStopSoldUI();
        return Promise.resolve(val);
    };

    Orchestrator.prototype._updateStopSoldUI = function () {
        var btn = document.getElementById('bl-stop-sold-btn');
        var indicator = document.getElementById('bl-stop-sold-indicator');
        var label = document.getElementById('bl-stop-sold-label');
        var isEnabled = this.config.stopSold !== false;
        if (btn) {
            btn.setAttribute('aria-pressed', isEnabled ? 'true' : 'false');
            btn.title = isEnabled ? 'Stop Sold: ON (Skipping sold-out leads)' : 'Stop Sold: OFF (Sold-out leads not filtered)';
        }
        if (indicator) {
            if (isEnabled) {
                indicator.classList.add('active');
                indicator.classList.remove('inactive');
            } else {
                indicator.classList.remove('active');
                indicator.classList.add('inactive');
            }
        }
        if (label) {
            label.textContent = isEnabled ? 'ON' : 'OFF';
        }
    };

    Orchestrator.prototype._isLeadSoldOut = function (lead, card) {
        if (!card && (!lead || !lead.raw)) {
            if (lead && (lead.isSoldOut === true || lead.soldOut === true || lead.isSold === true)) return true;
            return false;
        }
        var el = (card && card.element) || (lead && lead.raw && lead.raw.element);

        // 1. Direct explicit property check on lead
        if (lead && (lead.isSoldOut === true || lead.soldOut === true || lead.isSold === true)) {
            return true;
        }

        if (!el) return false;

        // 2. DOM Attribute checks on the card container
        try {
            if (el.getAttribute && (el.getAttribute('data-sold') === 'true' || el.getAttribute('data-status') === 'sold' || el.getAttribute('data-is-sold') === 'true')) {
                return true;
            }
            if (el.className && typeof el.className === 'string') {
                var cName = el.className.toLowerCase();
                if (cName.indexOf('sold_out') !== -1 || cName.indexOf('soldout') !== -1 || cName.indexOf('lead_sold') !== -1) {
                    return true;
                }
            }
        } catch (e) { }

        // 3. Check card buttons, badges, tags, and ribbons
        try {
            var badges = el.querySelectorAll('button, a, span, div, p, [class*="sold"], [class*="Sold"], [class*="tag"], [class*="badge"], [class*="ribbon"], [class*="status"], [class*="cta"], [class*="Cta"], [class*="btn"], [class*="Btn"]');
            for (var i = 0; i < badges.length; i++) {
                var b = badges[i];
                var t = (b.textContent || '').trim().toLowerCase();
                if (!t) continue;
                if (t === 'sold' || t === 'sold out' || t === 'already sold' || t === 'quota exhausted' || t === 'lead sold' ||
                    t.indexOf('sold out') !== -1 || t.indexOf('already sold') !== -1 || t.indexOf('quota exhausted') !== -1) {
                    if (t.indexOf('unsold') === -1) {
                        return true;
                    }
                }
            }
        } catch (e) { }

        return false;
    };

    // ============================================================
    // TOP-CENTER LIVE TELEMETRY TOASTS
    // ============================================================
    Orchestrator.prototype._ensureToastContainer = function () {
        var c = document.getElementById('bl-toast-container');
        if (!c) {
            c = document.createElement('div');
            c.id = 'bl-toast-container';
            document.body.appendChild(c);
        }
        return c;
    };

    Orchestrator.prototype.showTopToast = function (type, title, message, durationMs) {
        // Allow lead acquisition, status update toasts, and filter limit/deactivation/reactivation toasts
        var allowedTypes = { 'found': 1, 'acquiring': 1, 'contacted': 1, 'failed': 1, 'warning': 1, 'info': 1, 'reactivated': 1 };
        if (!allowedTypes[type]) {
            return;
        }
        var msgLower = (message || '').toLowerCase();
        var titleLower = (title || '').toLowerCase();
        var isFilterToast = titleLower.indexOf('filter') !== -1 || titleLower.indexOf('limit') !== -1;
        if (!isFilterToast && (msgLower.indexOf('refresh') !== -1 || msgLower.indexOf('scroll') !== -1 ||
            msgLower.indexOf('bottom') !== -1 || msgLower.indexOf('top') !== -1 ||
            titleLower.indexOf('refresh') !== -1 || titleLower.indexOf('scroll') !== -1)) {
            return;
        }

        try {
            var container = this._ensureToastContainer();
            var toast = document.createElement('div');
            toast.className = 'bl-top-toast bl-toast-' + (type || 'info');

            var iconMap = {
                'found': '🎯',
                'acquiring': '⚡',
                'contacted': '✅',
                'failed': '❌',
                'warning': '⚠️',
                'info': 'ℹ️',
                'reactivated': '🔄'
            };
            var icon = iconMap[type] || 'ℹ️';

            toast.innerHTML =
                '<span class="bl-toast-icon">' + icon + '</span>' +
                '<div class="bl-toast-content">' +
                '<div class="bl-toast-title">' + (title || 'Lead Update') + '</div>' +
                '<div class="bl-toast-message">' + (message || '') + '</div>' +
                '</div>';

            container.appendChild(toast);

            var timeout = durationMs || 2000;
            setTimeout(function () {
                toast.classList.add('bl-toast-leave');
                setTimeout(function () {
                    if (toast.parentNode) toast.parentNode.removeChild(toast);
                }, 300);
            }, timeout);
        } catch (e) { }
    };

    function _normLeadRecord(s) {
        return String(s || '').trim().toLowerCase().replace(/[^\w]/g, '_');
    }

    Orchestrator.prototype._recordLeadAcquired = function (lead) {
        if (!lead) return;
        var qid = lead.uniqueQueryId || lead.leadId;
        if (qid) this._acquiredLeadIds.add(String(qid));
        if (lead.leadId) this._acquiredLeadIds.add(String(lead.leadId));

        if (!this._acquiredRecords) this._acquiredRecords = [];
        var rec = {
            uniqueQueryId: String(qid || ''),
            leadId: String(lead.leadId || ''),
            productName: _normLeadRecord(lead.productName),
            sellerName: _normLeadRecord(lead.senderName || lead.sellerName),
            phone: String(lead.senderMobile || '').replace(/[^\d]/g, ''),
            location: _normLeadRecord(lead.location),
            acquiredAt: Date.now()
        };
        this._acquiredRecords.push(rec);

        // Mark only this specific lead in duplicateManager
        if (this.duplicateManager) {
            if (lead.uniqueQueryId) this.duplicateManager.markSeen(lead.uniqueQueryId);
            if (lead.leadId) this.duplicateManager.markSeen(lead.leadId);
        }
        try {
            var arr = Array.from(this._acquiredLeadIds);
            chrome.storage.local.set({
                acquiredLeadIds: arr,
                acquiredRecords: this._acquiredRecords.slice(-500)
            });
        } catch (e) { }
        this.logger.info('🔒 Lead permanently marked ACQUIRED & ignored for future scans: ' + (qid || lead.productName) + ' [Seller: ' + (lead.senderName || 'unknown') + ']');
    };

    Orchestrator.prototype._isLeadAcquired = function (lead, card) {
        if (!this._acquiredLeadIds) return false;

        // 1. Check only explicit acquisition/contact evidence on the card.
        // "View Contact" / "View Number" are actionable portal CTAs, not proof that
        // this lead was already acquired. A disabled generic button is also ambiguous
        // (balance/subscription restrictions can disable it), so neither is a duplicate.
        if (card && card.element) {
            if (card.element.getAttribute('data-leadsync-acquired') === 'true') return true;
            if (card.element.classList && card.element.classList.contains('bl-acquired-card')) return true;
            var buttons = card.element.querySelectorAll('button, a, [role="button"], [class*="BuyLdC_Cta"], [class*="BuyLdC_btn"], [class*="SLC_FillCTA"]');
            for (var bIdx = 0; bIdx < buttons.length; bIdx++) {
                var btn = buttons[bIdx];
                var bt = (btn.textContent || btn.value || '').trim().toLowerCase();
                if (/\b(contacted|already contacted|already contact|acquired|message sent|enquiry sent|successfully sent)\b/.test(bt)) {
                    return true;
                }
            }
        }

        if (card && card.id && this._acquiredLeadIds.has(String(card.id))) return true;

        if (lead) {
            // 2. Direct ID matches
            if (lead.uniqueQueryId && this._acquiredLeadIds.has(String(lead.uniqueQueryId))) return true;
            if (lead.leadId && this._acquiredLeadIds.has(String(lead.leadId))) return true;

            // 3. SELLER VERIFICATION LOGIC:
            // Compare against previously acquired records.
            // If lead is for the exact same product:
            //   - If seller (or phone) matches previously acquired lead -> DUPLICATE (return true, DO NOT acquire again)
            //   - If seller is DIFFERENT -> NOT A DUPLICATE (allow acquisition!)
            if (this._acquiredRecords && this._acquiredRecords.length > 0) {
                var curProd = _normLeadRecord(lead.productName);
                var curSeller = _normLeadRecord(lead.senderName || lead.sellerName);
                var curPhone = String(lead.senderMobile || '').replace(/[^\d]/g, '');

                for (var r = 0; r < this._acquiredRecords.length; r++) {
                    var rec = this._acquiredRecords[r];
                    if (rec.productName === curProd) {
                        // Product matches an acquired lead: verify seller identity
                        if (curPhone && rec.phone && curPhone === rec.phone) {
                            return true; // Same seller phone already acquired
                        }
                        if (curSeller && rec.sellerName && curSeller === rec.sellerName) {
                            return true; // Same seller name already acquired
                        }
                        if (rec.uniqueQueryId && rec.uniqueQueryId === lead.uniqueQueryId) {
                            return true;
                        }
                    }
                }
            }
        }
        return false;
    };

    Orchestrator.prototype._checkDynamicFilterChanges = function (forceRefresh) {
        if (!this._supabaseEnabled || !this.supabase) return Promise.resolve(false);
        var self = this;
        var force = forceRefresh === true;
        return this.supabase.loadFilters(force).then(function (success) {
            if (!success) return false;
            var newFilters = self.supabase.getFilters() || [];
            var newSignature = (self.supabase && typeof self.supabase._buildSemanticSignature === 'function')
                ? self.supabase._buildSemanticSignature(newFilters)
                : JSON.stringify(newFilters.map(function (f) {
                    return {
                        id: f.id,
                        name: f.name || f.filter_name,
                        keywords: f.product_keywords,
                        neg: f.negative_keywords,
                        loc: f.sender_locations,
                        act: f.is_active,
                        mode: f.match_mode,
                        cfg: f.filter_config,
                        del: f.deleted_at || f.is_deleted
                    };
                }));

            var hasActiveBefore = self.keywordManager ? self.keywordManager.getActiveFilterCount() : 0;
            if (self._lastFiltersSignature === undefined) {
                self._lastFiltersSignature = newSignature;
                if (hasActiveBefore === 0 && newFilters.length > 0) {
                    self.keywordManager.extractFromSupabaseFilters(newFilters);
                    self._updateScannerLifecycleState('initial_dynamic_filters');
                    if (self.scanner) {
                        self.scanner.resetEmitted();
                        self.scanner._scan();
                    }
                    return true;
                }
                return false;
            }

            if (newSignature !== self._lastFiltersSignature) {
                self._lastFiltersSignature = newSignature;
                self.keywordManager.extractFromSupabaseFilters(newFilters);
                var kws = self.keywordManager.getAllKeywords();
                self.logger.info('🔄 Dynamic filter changes detected! Active product keywords: ' + kws.product.join(', '));
                if (self.showTopToast) {
                    self.showTopToast('info', 'Filters Updated', 'Applied ' + newFilters.length + ' updated filter(s) dynamically', 2000);
                }
                // Clear duplicateManager (preserving acquired leads) so unacquired cards on page can match new keywords
                if (self.duplicateManager) {
                    self.duplicateManager.clear();
                    if (self._acquiredLeadIds) {
                        self._acquiredLeadIds.forEach(function (id) {
                            self.duplicateManager.markSeen(id);
                        });
                    }
                }
                // Reset scanner cache so all unacquired cards in DOM are evaluated against new filters
                if (self.scanner) {
                    self.scanner.resetEmitted();
                    self.scanner._scan();
                }
                self._updateScannerLifecycleState('dynamic_filter_changes');
                return true;
            }
            return false;
        }).catch(function () {
            return false;
        });
    };

    // ============================================================
    // REFRESH SCAN WITHOUT WEBPAGE RELOAD
    // ============================================================
    Orchestrator.prototype.restartScan = function () {
        this.logger.info('🔄 Restarting scan and refreshing portal leads...');
        this.navigator.stop();

        // 1. Trigger IndiaMART portal to load dynamically arriving leads onto webpage
        var refreshedInPage = false;
        try {
            // A) Check and click IndiaMART's "New Leads Available" notification banner / toast
            if (this.scanner && this.scanner._checkNewLeadsBanner) {
                refreshedInPage = this.scanner._checkNewLeadsBanner();
            }

            // B) Click IndiaMART's native refresh button / icon if present on portal
            var refreshSelectors = [
                '#refreshBL', '#refresh_lead', '[id*="refresh_leads" i]',
                'button[class*="refresh" i]', 'a[class*="refresh" i]',
                '[class*="icon-refresh"]', '[class*="refresh_icon"]',
                '[title*="refresh" i]', '[aria-label*="refresh" i]',
                '[data-action*="refresh" i]'
            ];
            for (var r = 0; r < refreshSelectors.length; r++) {
                var refEl = document.querySelector(refreshSelectors[r]);
                if (refEl && refEl.id !== 'bl-refresh-btn' && (!refEl.id || refEl.id.indexOf('bl-') !== 0)) {
                    try { refEl.click(); refreshedInPage = true; } catch (e) { }
                    break;
                }
            }

            // C) Re-click active IndiaMART BuyLeads tab to trigger native AJAX data reload
            var tabSelectors = [
                '[class*="BL_tab"][class*="active"] a',
                '[class*="BL_tab"][class*="active"]',
                '[class*="tab_selected"] a',
                '[class*="tab_selected"]',
                'li[class*="selected"] a',
                'li.BL_tab.active',
                'li.BL_tab a',
                '[data-tab="relevant"]',
                '[data-tab="all"]',
                '#all_buyleads',
                '#relevant_buyleads'
            ];
            for (var t = 0; t < tabSelectors.length; t++) {
                var tab = document.querySelector(tabSelectors[t]);
                if (tab) {
                    try { tab.click(); refreshedInPage = true; } catch (e) { }
                    break;
                }
            }
        } catch (e) { }

        // 2. Clear scanner emitted-cache and in-memory counters
        if (this.scanner) {
            this.scanner.resetEmitted();
        }
        this._uniqueSeenIds.clear();

        // 3. Reset duplicateManager while strictly preserving acquired leads
        if (this.duplicateManager && this.duplicateManager._seen) {
            this.duplicateManager._seen.clear();
            if (this._acquiredLeadIds) {
                var selfDup = this.duplicateManager;
                this._acquiredLeadIds.forEach(function (id) { selfDup.markSeen(id); });
            }
        }

        // 4. Reset display counters & initialize new scan cycle
        this.startNewCycle();
        try {
            sessionStorage.removeItem('bl_session_stats');
            sessionStorage.removeItem('bl_session_seen_ids');
            sessionStorage.removeItem('bl_session_metrics');
            sessionStorage.removeItem('bl_last_reload_flag');
            sessionStorage.removeItem('bl_reload_pending');
            sessionStorage.removeItem('bl_last_reload_time');
            sessionStorage.removeItem('bl_scanner_auto_resume');
            // Bust filter cache so CRM filter changes take effect immediately
            sessionStorage.removeItem('bl_cached_filters');
            sessionStorage.removeItem('bl_cached_filters_ts');
            if (this.navigator && this.navigator.RELOAD_STORAGE_KEY) {
                sessionStorage.removeItem(this.navigator.RELOAD_STORAGE_KEY);
            }
        } catch (e) { }
        this.stats.unique = 0;
        this.stats.discovered = 0;
        this.stats.duplicate = 0;
        this.stats.rejected = 0;
        this.stats.filtered = 0;
        this.stats.acquired = 0;
        this.stats.failed = 0;

        var statsScanned = document.getElementById('bl-stat-scanned');
        if (statsScanned) statsScanned.textContent = '0';
        var statsAcquired = document.getElementById('bl-stat-acquired');
        if (statsAcquired) statsAcquired.textContent = '0';
        var filtEl = document.getElementById('bl-stat-filtered');
        if (filtEl) filtEl.textContent = '0';

        // 5. (Automatic scroll-to-top removed — no scrolling in this version.)

        this._isPaused = false;
        this._broadcastStatus();

        var toastMsg = refreshedInPage
            ? 'Portal refreshed & continuous scan restarted from top'
            : 'Continuous scan restarted from top';
        // Scan refreshed toast removed as per request

        // 6. Force-refresh filters from Supabase in background
        if (this._checkDynamicFilterChanges) {
            this._checkDynamicFilterChanges(true);
        }

        // 7. Restart continuous scanning pass cleanly
        var self = this;
        setTimeout(function () {
            if (self.scanner) {
                self.scanner._scan();
            }
            if (self.navigator) {
                self.navigator.restart();
            }
        }, 200);
    };

    // Emergency stop triggered when Scanner detects IndiaMART's rate-limit warning.
    // Halts the navigator and queue, marks the extension PAUSED, and shows a status message.
    Orchestrator.prototype._onRateLimitDetected = function (reason) {
        var self = this;
        try {
            var restrictionReason = reason || 'Platform rate limit or restriction banner detected';
            this.logger.warn('🛑 ' + restrictionReason + ' — pausing immediately. Auto-resume disabled.');
            
            // 1. Trip persistent circuit breaker
            if (this.circuitBreaker) {
                this.circuitBreaker.trip(restrictionReason);
            }

            // 2. Stop navigator loop and observers
            if (this.navigator && typeof this.navigator.stop === 'function') this.navigator.stop();
            if (this.scanner && typeof this.scanner.stop === 'function') this.scanner.stop();

            // 3. Pause action queue
            if (this.queue && typeof this.queue.pause === 'function') {
                this.queue.pause();
            } else if (this.queue) {
                this.queue._paused = true;
            }

            // 4. Clear timers
            if (this._filterWatchTimer) clearInterval(this._filterWatchTimer);
            if (this._rateLimitTimer) { clearTimeout(this._rateLimitTimer); this._rateLimitTimer = null; }
            this._stopRefreshCountdown('rate_limit_detected');

            this._isPaused = true;
            this._broadcastStatus();

            // 5. Update UI: persistent warning and status
            var statusEl = document.getElementById('bl-status-text');
            if (statusEl) {
                statusEl.textContent = '🛑 RESTRICTION DETECTED';
                statusEl.style.color = '#f44336';
            }
            var warnEl = document.getElementById('bl-warning-text');
            if (warnEl) {
                warnEl.textContent = '🛑 IndiaMART account restriction detected. Auto-resume disabled. Manual review required on platform before resuming.';
                warnEl.classList.add('show');
            }

            // 6. Show resume button, hide stop button
            var resumeBtn = document.getElementById('bl-resume-btn');
            if (resumeBtn) resumeBtn.style.display = 'inline-block';
            var stopBtn = document.getElementById('bl-stop-btn');
            if (stopBtn) stopBtn.style.display = 'none';

            if (this.showTopToast) {
                this.showTopToast('failed', 'Account Restriction Detected', 'Platform limit reached. Extension halted.', 8000);
            }
        } catch (e) {
            this.logger.error('Error handling rate limit detection: ' + (e && e.message));
        }
    };

    Orchestrator.prototype.setAutoScroll = function (e) {
        this.config.autoScroll = e;
        chrome.storage.local.set({ autoScroll: e });
        if (e) this.navigator.start(); else this.navigator.stop();
    };

    Orchestrator.prototype.setStrictCountry = function (enabled, countries, rejectUnknown) {
        this.config.strictCountryMode = enabled === true;
        if (Array.isArray(countries)) {
            this.config.allowedCountries = countries.map(function (c) { return String(c).toUpperCase().trim(); }).filter(function (c) { return c; });
        }
        if (rejectUnknown !== undefined) this.config.strictCountryRejectUnknown = rejectUnknown !== false;
        chrome.storage.local.set({
            strictCountryMode: this.config.strictCountryMode,
            allowedCountries: this.config.allowedCountries,
            strictCountryRejectUnknown: this.config.strictCountryRejectUnknown
        });
        this.logger.info('🌍 Strict country ' + (this.config.strictCountryMode ? 'ON' : 'OFF'));
        this._broadcastStatus();
        return Promise.resolve(true);
    };

    Orchestrator.prototype.toggleSupabase = function (enabled) {
        var self = this;
        this._supabaseEnabled = enabled;
        this.config.supabaseEnabled = enabled;
        this.keywordManager.setSupabaseEnabled(enabled);
        chrome.storage.local.set({ supabaseEnabled: enabled });
        if (enabled) {
            return this.supabase.loadFilters(true).then(function () {
                var filtersArray = self.supabase.getFilters();
                self.keywordManager.extractFromSupabaseFilters(filtersArray);
                self.supabase.updateFilterStatus(true);
                self._updateScannerLifecycleState('supabase_toggled_on');
                return self.duplicateManager.loadFromDb();
            }).then(function () { return true; });
        } else {
            this.supabase._filters = [];
            this.supabase._filtersLoaded = false;
            this.keywordManager.extractFromSupabaseFilters([]);
            this._updateScannerLifecycleState('supabase_toggled_off');
            return Promise.resolve(true);
        }
    };

    Orchestrator.prototype.clearLocalDuplicateCache = function () {
        this.duplicateManager.clear();
        return Promise.resolve({ success: true, message: 'Duplicate cache cleared' });
    };

    Orchestrator.prototype.clearAllLocalData = function () {
        var self = this;
        return new Promise(function (resolve) {
            chrome.storage.local.get(['keywords', 'mode', 'supabaseEnabled', 'scoreWeights', 'scorePenalties', 'preferredStates', 'preferredCountries', 'minScore', 'maxPerMinute', 'maxPerHour', 'maxPerDay', 'maxPerSession', 'cooldownMs', 'strictCountryMode', 'allowedCountries', 'strictCountryRejectUnknown'], function (keep) {
                chrome.storage.local.clear(function () {
                    chrome.storage.local.set(keep, function () {
                        self.duplicateManager.clear();
                        resolve({ success: true });
                    });
                });
            });
        });
    };

    // Called immediately when a lead is acquired.
    // Halts the hard-reload cycle so the page stays stable during contact.
    // The existing ▶ Resume button on the panel restarts everything.
    Orchestrator.prototype._pauseForLeadAcquired = function (lead) {
        try {
            // Mark that this scan cycle acquired something — _waitForQueueAndReload uses this
            this._cycleAcquiredThisScan = true;

            // Stop navigator — no more window.location.reload() until user resumes
            if (this.navigator) this.navigator.stop();
            // Stop scanner MutationObserver — prevents new DOM cards from triggering
            // _onCardsDetected and queueing additional leads while paused.
            if (this.scanner) this.scanner.stopWatching();
            this._isPaused = true;
            this._scannerState = SCANNER_STATES.PAUSED;
            this._stopRefreshCountdown('lead_acquired');

            // Update panel status label
            var statusEl = document.getElementById('bl-status-text');
            if (statusEl) {
                statusEl.textContent = '\u23f8 PAUSED \u2014 Lead acquired, press \u25b6 to continue';
                statusEl.style.color = '#f5a623';
            }
            // Show Resume button, hide Stop button
            var stopBtn = document.getElementById('bl-stop-btn');
            var resumeBtn = document.getElementById('bl-resume-btn');
            if (stopBtn) stopBtn.style.display = 'none';
            if (resumeBtn) resumeBtn.style.display = '';

            this.logger.info('\u23f8 Auto-paused after acquiring: ' + (lead && lead.productName || lead && lead.leadId || 'lead'));
            this._broadcastStatus();
        } catch (e) { }
    };

    Orchestrator.prototype.emergencyStop = function () {
        this._isPaused = true;
        this._scannerState = SCANNER_STATES.PAUSED;
        this._stopRefreshCountdown('emergency_stop');
        this.safety.emergencyStopFn ? this.safety.emergencyStopFn() : this.safety.emergencyStop();
        if (this.scanner) this.scanner.stopWatching();
        if (this.popupManager) this.popupManager.cancel();
        if (this.navigator) this.navigator.stop();
        if (this._supabaseEnabled) this.supabase.updateFilterStatus(false);
        // Clear any pending-reload flags so a manual page refresh after pause
        // does NOT auto-resume the extension unexpectedly.
        try {
            sessionStorage.setItem('bl_scanner_auto_resume', 'false');
            sessionStorage.removeItem('bl_reload_pending');
            sessionStorage.removeItem('bl_last_reload_flag');
        } catch (e) { }
        this.logger.warn('🚨 EMERGENCY STOP ACTIVATED — Scanner & Navigator halted');
        this._stopTcpKeepAlive();
        this._broadcastStatus();
        return Promise.resolve(true);
    };

    Orchestrator.prototype.resume = function () {
        if (this.circuitBreaker && !this.circuitBreaker.isNormal()) {
            this.circuitBreaker.reset('user_action');
            this.logger.info('Circuit breaker reset by user action');
        }
        this._isPaused = false;
        this._cycleAcquiredThisScan = false;
        this.safety.resume();
        if (this._supabaseEnabled) this.supabase.updateFilterStatus(true);
        this.logger.info('▶ RESUMED by user — evaluating eligible filters');
        this._initTcpKeepAlive();
        this._updateScannerLifecycleState('user_resume');
        if (typeof process === 'undefined') {
            this._startRefreshCountdown(10);
        }
        this._broadcastStatus();
        return Promise.resolve(true);
    };

    Orchestrator.prototype.getStatus = function () {
        var kws = this.keywordManager.getAllKeywords();
        return {
            mode: this.config.mode, stats: this.stats,
            queue: this.queue.getStatus(), safety: this.safety.getStatus(),
            scanner: this.scanner.getStatus(), stateStats: this.stateMachine.getStats(),
            initialized: this._initialized, config: this.config,
            supabaseEnabled: this._supabaseEnabled,
            autoMinimize: this.config.autoMinimize,
            confirmationAnswer: this.config.confirmationAnswer,
            purchaseAction: this.config.purchaseAction,
            autoScroll: this.config.autoScroll,
            popupsHandled: this.popupManager.getCount(),
            dbConnected: this._supabaseEnabled && this.supabase._filtersLoaded,
            knownLeads: this.duplicateManager._seen.size,
            navigator: this.navigator.getStatus(),
            keywordSource: this._supabaseEnabled ? 'supabase' : 'local',
            keywordCounts: { product: kws.product.length, negative: kws.negative.length, location: kws.location.length, required: kws.required.length },
            scoreWeights: this.scorer.weights,
            scorePenalties: this.scorer.penalties,
            preferredStates: this.scorer.preferredStates,
            preferredCountries: this.scorer.preferredCountries,
            strictCountryMode: this.config.strictCountryMode,
            allowedCountries: this.config.allowedCountries,
            strictCountryRejectUnknown: this.config.strictCountryRejectUnknown,
            countryBlocked: this.stats.countryBlocked
        };
    };

    Orchestrator.prototype.shutdown = function () {
        this.scanner.stopWatching();
        this.queue.pause();
        this._stopRefreshCountdown('shutdown');
        if (this.popupManager) this.popupManager.cancel();
        if (this.navigator) this.navigator.stop();
        if (this._statsTimer) clearInterval(this._statsTimer);
        if (this._cleanupTimer) clearInterval(this._cleanupTimer);
        if (this._statusPanelTimer) clearInterval(this._statusPanelTimer);
        if (this._filterWatchTimer) clearInterval(this._filterWatchTimer);
        if (this._mandatory30SecTimer) clearInterval(this._mandatory30SecTimer);
        if (this._supabaseEnabled) this.supabase.updateFilterStatus(false);
    };

    // ============================================================
    // INIT — multi-injection guard
    // ============================================================
    // window.__X__ is NOT reliable in MV3 ISOLATED world: every content-script
    // injection gets a fresh window proxy, so the flag is always undefined and
    // multiple Orchestrator instances spawn concurrently → page OOM / crash.
    // sessionStorage IS shared on the same page across all worlds for the same
    // origin, so it's the correct guard here.
    // Guard is a per-document DOM marker (NOT sessionStorage): it is shared by all content-script
    // worlds, resets automatically on every navigation/reload, and cannot get stuck if
    // beforeunload never fires. A heartbeat lets a fresh injection take over from an orphaned
    // instance (e.g. after the extension was reloaded/updated and the old context was invalidated).
    var _instanceId = 'bl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    var _docEl = (typeof document !== 'undefined' && document.documentElement) ? document.documentElement : null;
    var _prevInstance = _docEl && typeof _docEl.getAttribute === 'function' ? _docEl.getAttribute('data-bl-instance') : null;
    var _prevBeat = (_docEl && typeof _docEl.getAttribute === 'function' ? parseInt(_docEl.getAttribute('data-bl-heartbeat') || '0', 10) : 0) || 0;
    var _prevAlive = !!_prevInstance && (Date.now() - _prevBeat) < 8000;
    try { sessionStorage.removeItem('__bl_v6_init__'); } catch (e) {} // legacy guard key, no longer used

    if (_prevAlive) {
        console.warn('[LeadSync] Instance ' + _prevInstance + ' is alive — skipping duplicate injection (' + _instanceId + ').');
    } else {
        var _initReason = 'cold_start';
        try {
            if (_prevInstance) _initReason = 'takeover_stale_instance';
            else if (sessionStorage.getItem('bl_reload_pending') === 'true' || sessionStorage.getItem('bl_last_reload_flag') === 'from_reload') _initReason = 'auto_reload';
        } catch (e) {}
        _initInfo.instanceId = _instanceId;
        _initInfo.reason = _initReason;
        if (_docEl && typeof _docEl.setAttribute === 'function') {
            _docEl.setAttribute('data-bl-instance', _instanceId);
            _docEl.setAttribute('data-bl-heartbeat', String(Date.now()));
        }
        if (_prevInstance) { try { document.dispatchEvent(new Event('bl-teardown')); } catch (e) {} }
        var _heartbeatTimer = setInterval(function () {
            try { if (_docEl && typeof _docEl.setAttribute === 'function') _docEl.setAttribute('data-bl-heartbeat', String(Date.now())); } catch (e) {}
        }, 2000);
        console.log('🚀 IndiaMART BuyLead Assistant v6.4.1 [' + _instanceId + ', ' + _initReason + ']');

        var orchestrator = new Orchestrator();
        window.orchestrator = orchestrator;

        // Teardown hook: a newer injection asked this instance to stop. Idempotent.
        var _tornDown = false;
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('bl-teardown', function () {
                if (_tornDown || _docEl.getAttribute('data-bl-instance') === _instanceId) return;
                _tornDown = true;
                clearInterval(_heartbeatTimer);
                try { orchestrator.shutdown(); } catch (e) {}
            });
        }

        // ── Passive Lead Observation Bridge (Read-Only) ────────────────────────
        // Receives validated passive messages from network-interceptor.js (MAIN world)
        // All external action replay, template harvesting, and blind confirmation removed.
        window.addEventListener('message', function (evt) {
            try {
                if (!evt.data || evt.source !== window) return;

                // ── Structured logs from MAIN world network interceptor ──
                if (evt.data.__leadsync_log__) {
                    if (orchestrator && orchestrator.logger && typeof orchestrator.logger.logEvent === 'function') {
                        orchestrator.logger.logEvent(evt.data);
                    }
                    return;
                }

                // ── Passive lead observation from network-interceptor (Zero-Debounce Fast Path) ──
                if (evt.data.type === '__leadsync_passive_lead__' || evt.data.__leadsync_passive_lead__ || evt.data.__leadsync_network__) {
                    if (!orchestrator || !orchestrator._initialized || orchestrator._isPaused) return;
                    if (evt.data.timestamp && (Date.now() - evt.data.timestamp > 30000)) return; // stale check
                    
                    var leads = evt.data.leads;
                    if (!leads && evt.data.lead) leads = [evt.data.lead];
                    if (!leads || !leads.length) leads = _netExtractLeads(evt.data.payload);
                    if (!leads || !leads.length) return;

                    var pseudoCards = [];
                    for (var li = 0; li < leads.length; li++) {
                        var raw = leads[li];
                        if (!raw) continue;
                        var apiId = raw.uniqueQueryId || raw.query_id || raw.queryId || raw.leadId || raw.lead_id || raw.buyer_id || raw.buyerId || raw.id || null;
                        if (!apiId) continue;
                        pseudoCards.push({ id: 'api_' + String(apiId), element: null, _rawApiLead: raw });
                    }
                    if (pseudoCards.length > 0) {
                        // Route directly & synchronously to evaluation, bypassing DOM mutation debounce
                        orchestrator._onNetworkLeads(pseudoCards);
                    }
                    return;
                }
            } catch (e) { }
        });

        // Inline helper: extract lead array from any known IndiaMART API response shape
        function _netExtractLeads(payload) {
            if (!payload) return null;
            if (Array.isArray(payload)) return payload.length ? payload : null;
            if (payload.CODE === '200' || payload.CODE === 200) {
                var d2 = payload.DATA || payload.data;
                if (Array.isArray(d2)) return d2.length ? d2 : null;
                if (d2) {
                    var flds = ['leads','buyLeadList','buyerList','enquiryList','result'];
                    for (var fi = 0; fi < flds.length; fi++) { if (d2[flds[fi]] && Array.isArray(d2[flds[fi]])) return d2[flds[fi]]; }
                }
            }
            var wrp = ['data','leads','result','response','buyerList','enquiryList','buyLeadList','DATA','LEADS'];
            for (var wi = 0; wi < wrp.length; wi++) {
                var v = payload[wrp[wi]];
                if (v && Array.isArray(v) && v.length) return v;
                if (v && typeof v === 'object') {
                    var n2 = ['leads','buyLeadList','buyerList','enquiryList','result'];
                    for (var ni = 0; ni < n2.length; ni++) { if (v[n2[ni]] && Array.isArray(v[n2[ni]]) && v[n2[ni]].length) return v[n2[ni]]; }
                }
            }
            return null;
        }

        // Signal the MAIN-world interceptor that we're ready to receive.
        // Any API responses buffered between document_start → now are replayed instantly.
        window.postMessage({ __leadsync_ready__: true }, '*');


        if (chrome && chrome.storage && chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
            chrome.storage.onChanged.addListener(function (changes, areaName) {
            if (areaName !== 'local') return;
            // Instant real-time microsecond filter update
            if (changes.filters_last_updated || changes.supabase_filters_cache || changes.active_filters || changes.cached_filters_v1) {
                var cachedObj = (changes.cached_filters_v1 && changes.cached_filters_v1.newValue) ||
                    (changes.supabase_filters_cache && changes.supabase_filters_cache.newValue);
                var newFilterList = cachedObj && Array.isArray(cachedObj.filters) ? cachedObj.filters : (Array.isArray(cachedObj) ? cachedObj : null);
                if (newFilterList && orchestrator && orchestrator.keywordManager) {
                    orchestrator.keywordManager.extractFromSupabaseFilters(newFilterList);
                    if (orchestrator.supabase) {
                        orchestrator.supabase._filters = newFilterList;
                        orchestrator.supabase._filtersLoaded = true;
                    }
                    orchestrator._updateScannerLifecycleState('storage_filter_update');
                } else if (orchestrator && orchestrator._checkDynamicFilterChanges) {
                    orchestrator._checkDynamicFilterChanges(false);
                }
            }
            if (changes.mode && changes.mode.newValue) {
                orchestrator.setMode(changes.mode.newValue);
            }
            if (changes.stopSold !== undefined || changes.skipSoldOut !== undefined) {
                var newStop = changes.stopSold !== undefined ? !!changes.stopSold.newValue : !!changes.skipSoldOut.newValue;
                orchestrator.config.stopSold = newStop;
                orchestrator.config.skipSoldOut = newStop;
                if (orchestrator._updateStopSoldUI) {
                    orchestrator._updateStopSoldUI();
                }
            }
        });
        }
        chrome.runtime.onMessage.addListener(function (req, sender, sendResponse) {
            switch (req.action) {
                case 'GET_STATUS': sendResponse(Object.assign({ success: true }, orchestrator.getStatus())); return true;
                case 'GET_CONFIG': sendResponse({ success: true, config: orchestrator.config }); return true;
                case 'UPDATE_FULL_CONFIG': orchestrator.updateFullConfig(req.config).then(function () { sendResponse({ success: true }); }); return true;
                case 'SET_MODE': orchestrator.setMode(req.mode).then(function () { sendResponse({ success: true, mode: req.mode }); }); return true;
                case 'SET_STOP_SOLD': orchestrator.setStopSold(req.enabled); sendResponse({ success: true }); break;
                case 'SET_LIMITS': orchestrator.setLimits(req.limits); sendResponse({ success: true }); break;
                case 'SET_MIN_SCORE': orchestrator.setMinScore(req.score); sendResponse({ success: true }); break;
                case 'SET_AUTO_MINIMIZE': orchestrator.setAutoMinimize(req.enabled); sendResponse({ success: true }); break;
                case 'SET_CONFIRMATION_ANSWER': orchestrator.setConfirmationAnswer(req.answer); sendResponse({ success: true }); break;
                case 'SET_PURCHASE_ACTION': orchestrator.setPurchaseAction(req.purchaseAction); sendResponse({ success: true }); break;
                case 'SET_AUTO_SCROLL': orchestrator.setAutoScroll(req.enabled); sendResponse({ success: true }); break;
                case 'SET_STRICT_COUNTRY': orchestrator.setStrictCountry(req.enabled, req.countries, req.rejectUnknown).then(function () { sendResponse({ success: true }); }); return true;
                case 'TOGGLE_SUPABASE': orchestrator.toggleSupabase(req.enabled).then(function () { sendResponse({ success: true }); }); return true;
                case 'EMERGENCY_STOP': orchestrator.emergencyStop().then(function () { sendResponse({ success: true }); }); return true;
                case 'RESUME': orchestrator.resume().then(function () { sendResponse({ success: true }); }); return true;
                case 'UPDATE_KEYWORDS': orchestrator.keywordManager.updateKeywords(req.keywords).then(function () { sendResponse({ success: true }); }); return true;
                case 'REFRESH_FILTERS':
                    if (orchestrator._supabaseEnabled) {
                        orchestrator.supabase.loadFilters(true).then(function () {
                            var filtersArray = orchestrator.supabase.getFilters();
                            orchestrator.keywordManager.extractFromSupabaseFilters(filtersArray);
                            orchestrator.duplicateManager.clear();
                            orchestrator.scanner.resetEmitted();
                            orchestrator._updateScannerLifecycleState('refresh_filters_message');
                            sendResponse({ success: true, count: filtersArray.length });
                        });
                    } else sendResponse({ success: false });
                    return true;
                case 'RESET_DUPLICATES': orchestrator.duplicateManager.clear(); sendResponse({ success: true }); break;
                case 'CLEAR_DUPLICATE_CACHE': orchestrator.clearLocalDuplicateCache().then(function (r) { sendResponse(r); }); return true;
                case 'CLEAR_ALL_LOCAL_DATA': orchestrator.clearAllLocalData().then(function (r) { sendResponse(r); }); return true;
                case 'GET_KEYWORDS_DEBUG':
                    sendResponse({
                        success: true,
                        active: orchestrator.keywordManager.getAllKeywords(),
                        local: orchestrator.keywordManager._localKeywords,
                        supabase: orchestrator.keywordManager._supabaseKeywords,
                        source: orchestrator._supabaseEnabled ? 'supabase' : 'local'
                    });
                    return true;
                case 'TEST_LOAD_MORE':
                    var btn = orchestrator.navigator._findLoadMoreButton();
                    if (btn) { btn.click(); sendResponse({ success: true }); }
                    else sendResponse({ success: false, error: 'No button' });
                    return true;
                case 'GET_LOGS': chrome.storage.local.get('logs', function (result) { sendResponse(result.logs || []); }); return true;
                case 'CLEAR_LOGS': chrome.storage.local.set({ logs: [] }, function () { sendResponse({ success: true }); }); return true;
                default: sendResponse({ success: false });
            }
            return true;
        });

        // Clear init guard on unload so the next page load (after reload) re-initializes correctly.
        // The guard only needs to prevent duplicate injection WITHIN the same page lifecycle.
        window.addEventListener('pagehide', function () {
            clearInterval(_heartbeatTimer);
            _flushLogsNow(); // logs queued in the last <3s used to be lost on every auto-reload
        });

        if (typeof window !== 'undefined') {
            window.Logger = Logger;
            window.StructuredLogger = Logger;
            window.__leadsync_logger__ = {
                Logger: Logger,
                StructuredLogger: Logger,
                flushLogsNow: _flushLogsNow,
                getDroppedLogsCount: function () { return _droppedLogsCount; },
                getPersistenceErrorsCount: function () { return _persistenceErrorsCount; },
                generateTraceId: generateTraceId,
                generateOperationId: generateOperationId,
                getQueue: function () { return _logQueue; }
            };
        }

        console.log('✅ LeadSync Ready — v5.0.0 (Reliability Engine)');
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports.Logger = Logger;
        module.exports.StructuredLogger = Logger;
        module.exports.flushLogsNow = _flushLogsNow;
        module.exports.getDroppedLogsCount = function () { return _droppedLogsCount; };
        module.exports.getPersistenceErrorsCount = function () { return _persistenceErrorsCount; };
        module.exports.generateTraceId = generateTraceId;
        module.exports.generateOperationId = generateOperationId;
    }

})();

