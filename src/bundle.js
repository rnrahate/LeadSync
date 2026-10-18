
// src/bundle.js
// IndiaMART BuyLead Assistant - v6.2.0
// ============================================================================
// CHANGELOG v6.2.0
// ----------------------------------------------------------------------------
// ACCURACY
//   • Parser now emits productName / messageText / mcatName as SEPARATE fields.
//     The old `searchableText` concatenation is gone — it was the single
//     biggest source of false positives (product matcher saw the entire card).
//   • Product keyword gate matches against productName ONLY.
//   • Negative keyword gate matches against productName ONLY.
//   • Required keyword gate = OR across productName + messageText.
//   • _textMatches rewritten with word-boundary tokenisation (no more
//     `spf` matching `sputum`, `used` matching `unused`, `in` matching `Berlin`).
//   • Country extraction: flag `alt` first, then word-boundary name match.
//
// SPEED
//   • Queue drains immediately after acquire() — no waiting on popup timeout.
//   • Scroll: 900px step / 40ms delay (was 400/100).
//   • Loop interval: 250ms (was 1200ms).
//   • Load-More wait: 900ms (was 3000ms); button clicked immediately.
//   • Popup poll: 60ms / 5s timeout (was 100ms / 10s), MutationObserver-gated.
//   • Scanner debounce: 60ms / 500ms fallback (was 150/1000).
//   • ActionAdapter retry: 1.5s, skipped when a dialog is already open.
//   • Cooldown default: 400ms (was 2000ms).
//   • Panel refresh: 800ms (was 1500ms).
// ============================================================================
// Developed by Keyn Labs
// ============================================================================

console.log('🎯 IndiaMART BuyLead Assistant v6.2.0');
console.log('📦 Developed by Keyn Labs');
console.log('🔗 https://keynlabs.vercel.app/');

(function() {
    'use strict';

    // ============================================================
    // DEFAULT CONFIG
    // ============================================================
    var DEFAULT_CONFIG = {
        mode: 'AUTOMATIC',
        minScore: 60,

        // ---- SPEED TUNING (v6.2) ----
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

        // ---- NAVIGATOR (v6.2 speed) ----
        autoScroll: true,
        scrollSpeed: 900,
        scrollDelayMs: 40,
        bottomWaitMs: 500,
        loopIntervalMs: 250,
        loadMoreWaitMs: 900,
        maxStuckLoops: 3,
        maxReloadsPerSession: 999999,
        autoReloadOnComplete: true,
        autoReloadDelayMs: 100,
        liveScanWaitMs: 2000,

        // ---- POPUP (v6.2 speed) ----
        autoMinimize: true,
        popupTimeoutMs: 5000,
        confirmationAnswer: 'yes',
        purchaseAction: 'close',

        supabaseEnabled: true,
        panelPosition: null,
        panelCollapsed: false,
        stopSold: true,
        skipSoldOut: true
    };

    // ============================================================
    // LOGGER (batched storage writes, unchanged)
    // ============================================================
    var LEVELS = { TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4, FATAL: 5 };
    var LEVEL_NAMES = { 0: 'TRACE', 1: 'DEBUG', 2: 'INFO', 3: 'WARN', 4: 'ERROR', 5: 'FATAL' };
    var _logQueue = [];
    var _logFlushTimer = null;

    function Logger(module) {
        this.module = module;
        this.minLevel = LEVELS.DEBUG;
        this._correlationId = null;
    }
    Logger.prototype.getCorrelationId = function() {
        return this._correlationId || 'op_' + Date.now().toString(36);
    };
    Logger.prototype._log = function(level, message, data) {
        data = data || {};
        var entry = {
            timestamp: new Date().toISOString(),
            level: LEVEL_NAMES[level],
            module: this.module,
            correlationId: this.getCorrelationId(),
            message: message,
            data: data
        };
        var prefix = '[' + entry.timestamp + '] [' + entry.level + '] [' + this.module + ']';
        if (level >= LEVELS.ERROR) console.error(prefix, message, data);
        else if (level >= LEVELS.WARN) console.warn(prefix, message, data);
        else if (level >= LEVELS.INFO) console.info(prefix, message, data);
        else console.log(prefix, message, data);

        _logQueue.push(entry);
        if (_logQueue.length > 300) _logQueue = _logQueue.slice(-200);
        if (!_logFlushTimer) {
            _logFlushTimer = setTimeout(function() {
                _logFlushTimer = null;
                var batch = _logQueue.splice(0, _logQueue.length);
                if (batch.length === 0) return;
                try {
                    chrome.storage.local.get('logs', function(result) {
                        var logs = result.logs || [];
                        logs = logs.concat(batch);
                        if (logs.length > 500) logs = logs.slice(-500);
                        chrome.storage.local.set({ logs: logs });
                    });
                } catch (e) {}
            }, 3000);
        }
    };
    Logger.prototype.trace = function(m, d) { this._log(LEVELS.TRACE, m, d); };
    Logger.prototype.debug = function(m, d) { this._log(LEVELS.DEBUG, m, d); };
    Logger.prototype.info  = function(m, d) { this._log(LEVELS.INFO,  m, d); };
    Logger.prototype.warn  = function(m, d) { this._log(LEVELS.WARN,  m, d); };
    Logger.prototype.error = function(m, d) { this._log(LEVELS.ERROR, m, d); };
    Logger.prototype.fatal = function(m, d) { this._log(LEVELS.FATAL, m, d); };

    // ============================================================
    // LEAD ID GENERATOR
    // ============================================================
    function LeadIdGenerator() {}
LeadIdGenerator.prototype.generateFromElement = function(element) {
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
    var productEl = element.querySelector('.BLbp_title')
                 || element.querySelector('[class*="BuyLdC"] span.SLC_f18')
                 || element.querySelector('span.SLC_f18');
    var productText = productEl ? productEl.textContent.trim() : '';

    var locEl = element.querySelector('.BLbp_hdrLeft strong.BuyLdC_tltpw')
             || element.querySelector('[class*="BuyLdC_time_loc"] strong');
    var locationText = locEl ? locEl.textContent.trim() : '';

    var sellerEl = element.querySelector('.BLbp_byrName, .BLbp_buyer, [class*="buyer"], [class*="byr_name"], [class*="buyerName"], [class*="company"], [class*="comp_name"], [class*="senderName"], .BLbp_member, .BLbp_byrInfo, .SLC_byr, [class*="byrInfo"]');
    var sellerText = sellerEl ? sellerEl.textContent.trim() : '';

    var descEl = element.querySelector('.BLbp_desc, [class*="BuyLdC_msg"], [class*="desc"]');
    var descText = descEl ? descEl.textContent.trim() : '';

    var qtyEl = element.querySelector('.BLbp_qty, [class*="quantity"], [class*="qty"]');
    var qtyText = qtyEl ? qtyEl.textContent.trim() : '';

    var combined = productText + '|' + locationText + '|' + sellerText + '|' + qtyText + '|' + descText.substring(0, 60);
    if (combined.length < 5) return null;

    var hash = 0;
    for (var j = 0; j < combined.length; j++) {
        var chr = combined.charCodeAt(j);
        hash = ((hash << 5) - hash) + chr;
        hash = hash & hash;
    }
    return 'hash_' + Math.abs(hash).toString(36);
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
        this._loopInProgress = false;
        this._noMoreCount = 0;
        this._lastLeadCount = 0;
        this._stuckCount = 0;
        this._settings = {
            scrollSpeed: 900, scrollDelayMs: 40, bottomWaitMs: 500,
            loopIntervalMs: 250, loadMoreWaitMs: 900, maxStuckLoops: 3,
            autoReloadOnComplete: true, autoReloadDelayMs: 100, maxReloadsPerSession: 999999,
            liveScanWaitMs: 2000
        };
        this.RELOAD_STORAGE_KEY = 'bl_auto_reload_count';
    }

    PageNavigator.prototype.applySettings = function(config) {
        if (config.scrollSpeed)          this._settings.scrollSpeed = config.scrollSpeed;
        if (config.scrollDelayMs)        this._settings.scrollDelayMs = config.scrollDelayMs;
        if (config.bottomWaitMs)         this._settings.bottomWaitMs = config.bottomWaitMs;
        if (config.loopIntervalMs)       this._settings.loopIntervalMs = config.loopIntervalMs;
        if (config.loadMoreWaitMs)       this._settings.loadMoreWaitMs = config.loadMoreWaitMs;
        if (config.maxStuckLoops)        this._settings.maxStuckLoops = config.maxStuckLoops;
        if (config.autoReloadOnComplete !== undefined) this._settings.autoReloadOnComplete = config.autoReloadOnComplete;
        if (config.autoReloadDelayMs)    this._settings.autoReloadDelayMs = config.autoReloadDelayMs;
        if (config.maxReloadsPerSession) this._settings.maxReloadsPerSession = config.maxReloadsPerSession;
    };

    PageNavigator.prototype.start = function() {
        if (this._running) return;
        this._running = true;
        var self = this;
        this.logger.info('▶ Bottom-loop navigator started');
        if (this._startTimer) { clearTimeout(this._startTimer); }
        this._startTimer = setTimeout(function() { self._startLoop(); }, 400);
    };

    PageNavigator.prototype.stop = function() {
        this._running = false;
        this._loopInProgress = false;
        if (this._loopTimer)     { clearTimeout(this._loopTimer);     this._loopTimer = null; }
        if (this._startTimer)    { clearTimeout(this._startTimer);    this._startTimer = null; }
        if (this._cooldownTimer) { clearTimeout(this._cooldownTimer); this._cooldownTimer = null; }
        if (this._settleTimer)   { clearTimeout(this._settleTimer);   this._settleTimer = null; }
        if (this._stepTimer)     { clearTimeout(this._stepTimer);     this._stepTimer = null; }
        this.logger.info('⏹ Bottom-loop navigator cleanly stopped (all timers cleared)');
    };

    PageNavigator.prototype.restart = function() {
        this.stop();
        this._running = true;
        this._loopInProgress = false;
        var self = this;
        this.logger.info('🔄 Bottom-loop navigator restarted cleanly from top');
        try {
            window.scrollTo(0, 0);
            window.dispatchEvent(new Event('scroll'));
        } catch (e) {}
        this._startTimer = setTimeout(function() {
            self._startLoop();
        }, 200);
    };

    PageNavigator.prototype._startLoop = function() {
        var self = this;
        if (!this._running || this._loopInProgress) return;
        this._loopInProgress = true;

        // Check for dynamic filter changes before starting scan pass
        var filterPromise = (self.orchestrator && self.orchestrator._checkDynamicFilterChanges)
            ? self.orchestrator._checkDynamicFilterChanges()
            : Promise.resolve(false);

        filterPromise.then(function() {
            if (!self._running) { self._loopInProgress = false; return; }

            // Ensure scanner resets per-pass cache so all unacquired leads in feed are evaluated
            if (self.orchestrator && self.orchestrator.scanner) {
                self.orchestrator.scanner.resetEmitted();
                self.orchestrator.scanner._scan();
            }

            // Phase 1: Fast continuous scroll from topmost to bottom-most, scanning all leads
            self._fastScrollToBottom(function(result) {
                if (!self._running) { self._loopInProgress = false; return; }
                var reason = result && result.reason;

                if (reason === 'age_limit_reached') {
                    self.logger.info('⏳ Max lead age reached (' + (result.ageText || '') + '). Pausing 2s before rescanning top.');
                    if (self.orchestrator && self.orchestrator.showTopToast) {
                        self.orchestrator.showTopToast('info', 'Max Age Reached', 'Hit older leads (' + (result.ageText || '') + '). Rescanning top in 2s...', 2000);
                    }
                } else {
                    self.logger.info('🏁 Reached end of active leads list. Pausing 2s before rescanning top.');
                    if (self.orchestrator && self.orchestrator.showTopToast) {
                        self.orchestrator.showTopToast('info', 'End of Feed Reached', 'Scanned all available leads. Rescanning top in 2s...', 2000);
                    }
                }

                // Phase 2: Pause 2 seconds at bottom for real-time cooldown, then jump to top and rescan
                self._cooldownTimer = setTimeout(function() {
                    if (!self._running) { self._loopInProgress = false; return; }
                    try {
                        window.scrollTo(0, 0);
                        window.dispatchEvent(new Event('scroll'));
                    } catch (e) {}

                    // Allow 200ms to settle at top
                    self._settleTimer = setTimeout(function() {
                        if (!self._running) { self._loopInProgress = false; return; }

                        // Scan at utmost top for new arrivals & click any new leads banner
                        if (self.orchestrator && self.orchestrator.scanner) {
                            self.orchestrator.scanner.resetEmitted();
                            self.orchestrator.scanner._scan();
                        }

                        self._loopInProgress = false;
                        if (self.orchestrator && self.orchestrator.stats) {
                            self.orchestrator.stats.loopsCompleted++;
                        }
                        // Continuous scanning: immediately schedule next loop till user pauses
                        self._scheduleNextLoop();
                    }, 200);
                }, self._settings.liveScanWaitMs || 2000);
            });
        });
    };

    PageNavigator.prototype._scheduleNextLoop = function() {
        var self = this;
        if (!this._running) return;
        this._loopTimer = setTimeout(function() { self._startLoop(); }, this._settings.loopIntervalMs);
    };

    // Fast scroll: continuous downward pass till end of active feed
    PageNavigator.prototype._fastScrollToBottom = function(done) {
        var self = this;
        var lastY = -1;
        var sameCount = 0;
        var maxSame = 8;

        function step() {
            if (!self._running) { done({ reason: 'stopped' }); return; }

            // SCAN on every downward step so all leads from utmost top to bottom-most are scanned!
            if (self.orchestrator && self.orchestrator.scanner) {
                self.orchestrator.scanner._scan();
            }

            var docHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
            var maxY = Math.max(0, docHeight - window.innerHeight);
            var curY = window.scrollY;

            // When near the bottom of currently loaded content
            if (curY >= maxY - 40) {
                // Final scan at current bottom
                if (self.orchestrator && self.orchestrator.scanner) {
                    self.orchestrator.scanner._scan();
                }

                // Try clicking "Show More / Load More" to continue scrolling further
                var clicked = self._clickLoadMore();
                if (clicked) {
                    if (self.orchestrator && self.orchestrator.stats) self.orchestrator.stats.loadMoreClicks++;
                    setTimeout(step, self._settings.loadMoreWaitMs || 800);
                    return;
                }

                sameCount++;
                if (sameCount >= maxSame) {
                    done({ reason: 'end_of_list' });
                    return;
                }
                setTimeout(step, 300);
                return;
            }

            var newY = Math.min(curY + self._settings.scrollSpeed, maxY);
            try {
                window.scrollTo(0, newY);
                window.dispatchEvent(new Event('scroll'));
            } catch (e) {}

            if (Math.abs(newY - lastY) < 5) {
                sameCount++;
                if (sameCount >= maxSame) {
                    var loadMoreBtn = self._clickLoadMore();
                    if (loadMoreBtn) {
                        sameCount = 0;
                        setTimeout(step, self._settings.loadMoreWaitMs || 800);
                        return;
                    }
                    done({ reason: 'end_of_list' });
                    return;
                }
            } else {
                sameCount = 0;
            }
            lastY = newY;
            self._stepTimer = setTimeout(step, self._settings.scrollDelayMs || 40);
        }
        step();
    };

    PageNavigator.prototype._findLoadMoreButton = function() {
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

    PageNavigator.prototype._clickLoadMore = function() {
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

    PageNavigator.prototype._countLeads = function() {
        try { return document.querySelectorAll('[class*="BuyLdC_cont"]').length; } catch (e) { return 0; }
    };

    PageNavigator.prototype._autoReloadPage = function() {
        var self = this;
        var reloadCount = 0;
        try { reloadCount = parseInt(sessionStorage.getItem(this.RELOAD_STORAGE_KEY) || '0', 10) || 0; } catch (e) {}
        if (reloadCount >= this._settings.maxReloadsPerSession) {
            this.logger.warn('🛑 Max auto-reloads reached');
            this._showFinalBanner(); return;
        }
        try { sessionStorage.setItem(this.RELOAD_STORAGE_KEY, String(reloadCount + 1)); } catch (e) {}
        var nextCount = reloadCount + 1;
        this.logger.info('🔄 Auto-reloading (#' + nextCount + '/' + this._settings.maxReloadsPerSession + ')');
        this._showReloadOverlay(nextCount);
        setTimeout(function() { try { window.location.reload(); } catch (e) {} }, this._settings.autoReloadDelayMs);
    };

        PageNavigator.prototype._showReloadOverlay = function(n) {
        // Overlay removed — silent reload
    };

    PageNavigator.prototype._showFinalBanner = function() {
        try {
            var existing = document.getElementById('bl-final-banner');
            if (existing) existing.remove();
            var banner = document.createElement('div');
            banner.id = 'bl-final-banner';
            banner.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#fff8e8;border:2px solid #f5a623;border-radius:8px;padding:14px 20px;z-index:2147483646;font-family:-apple-system,Arial,sans-serif;font-size:13px;color:#1a1a2e;max-width:400px;';
            banner.innerHTML = '<div style="font-weight:700;color:#f5a623;margin-bottom:4px;">🛑 Session Limit Reached</div>' +
                '<div style="font-size:11px;color:#666;">Auto-reloaded ' + this._settings.maxReloadsPerSession + ' times. Please refresh manually.</div>';
            document.body.appendChild(banner);
        } catch (e) {}
    };

    PageNavigator.prototype._isInDOM = function(el) {
        if (!el) return false;
        try {
            var r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return false;
            var s = window.getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) !== 0;
        } catch (e) { return false; }
    };

    PageNavigator.prototype.getStatus = function() {
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

    PopupManager.prototype._classifyPopup = function(el) {
        var text = (el.textContent || '').toLowerCase();

        // Count visible Yes/No buttons
        var buttons = el.querySelectorAll('button, [role="button"], a[role="button"], input[type="button"], input[type="submit"]');
        var hasYes = false, hasNo = false;
        for (var i = 0; i < buttons.length; i++) {
            var bt = (buttons[i].textContent || buttons[i].value || '').trim().toLowerCase();
            if (bt === 'yes' || bt === 'ok' || bt === 'confirm' || bt === 'proceed') hasYes = true;
            if (bt === 'no'  || bt === 'cancel' || bt === 'dismiss')                    hasNo  = true;
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

    PopupManager.prototype.watchForPopup = function(callback, options) {
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
        if (this._observer) { try { this._observer.disconnect(); } catch (e) {} }
        try {
            this._observer = new MutationObserver(function() { self._mutationSeen = true; });
            this._observer.observe(document.body, { childList: true, subtree: true });
        } catch (e) {}

        if (this._watchInterval) clearInterval(this._watchInterval);

        this._watchInterval = setInterval(function() {
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

    PopupManager.prototype._cleanup = function() {
        this._active = false;
        if (this._watchInterval) { clearInterval(this._watchInterval); this._watchInterval = null; }
        if (this._observer) { try { this._observer.disconnect(); } catch (e) {} this._observer = null; }
    };

    PopupManager.prototype._finish = function(result) {
        var cb = this._onHandled;
        this._cleanup();
        if (cb) cb(result);
    };

    PopupManager.prototype._findAllPopups = function() {
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
        } catch (e) {}

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
            } catch (e) {}
        }

        return found;
    };

    PopupManager.prototype._handlePopup = function(popup, type) {
        this.logger.info('Handling ' + type + ' popup');
        if (type === 'PURCHASE') this._handlePurchase(popup);
        else if (type === 'CONFIRMATION') this._handleConfirmation(popup);
        else if (type === 'NAVIGATION') this._handleNavigation(popup);
        else this._handleUnknown(popup);
    };

    PopupManager.prototype._handlePurchase = function(popup) {
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
                try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true })); } catch (e) {}
                document.body.style.overflow = '';
                this._handledCount++;
                this._finish({ success: true, action: 'purchase_closed', type: 'PURCHASE' });
                return;
            } catch (err) {}
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

    PopupManager.prototype._handleConfirmation = function(popup) {
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
            } catch (err) {}
        }
        this._finish({ success: false, reason: 'no_button', action: 'confirm_failed', type: 'CONFIRMATION' });
    };

    PopupManager.prototype._handleNavigation = function(popup) {
        var btn = this._findCloseButton(popup);
        if (btn) { try { btn.click(); } catch (e) {} }
        else {
            try {
                document.body.click();
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
            } catch (e) {}
        }
        this._finish({ success: true, action: 'nav_closed', type: 'NAVIGATION' });
    };

    PopupManager.prototype._handleUnknown = function(popup) {
        var btn = this._findCloseButton(popup);
        if (btn) {
            try { btn.click(); } catch (e) {}
            this._finish({ success: true, action: 'closed', type: 'UNKNOWN' });
            return;
        }
        this._finish({ success: false, reason: 'unknown', action: 'unknown', type: 'UNKNOWN' });
    };

    PopupManager.prototype._findCloseButton = function(popup) {
        var slc = popup.querySelector('.SLC_pa.SLC_cp, [class*="SLC_pa"][class*="SLC_cp"]');
        if (slc && this._isVisible(slc)) return slc;
        var sels = ['[class*="close"]', '[aria-label*="close" i]', '[title*="close" i]', '[class*="cross"]'];
        for (var i = 0; i < sels.length; i++) {
            try { var el = popup.querySelector(sels[i]); if (el && this._isVisible(el)) return el; } catch (e) {}
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

    PopupManager.prototype._isVisible = function(el) {
        if (!el) return false;
        try {
            var r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return false;
            var s = window.getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) !== 0;
        } catch (e) { return false; }
    };

    PopupManager.prototype.cancel = function() { this._cleanup(); };
    PopupManager.prototype.getCount = function() { return this._handledCount; };

    // ============================================================
    // MATCHING ENGINE & KEYWORD NORMALIZATION (v6.3 - GRAVITAS)
    // ============================================================
    function normalizeText(text) {
        if (!text) return '';
        return String(text)
            .normalize('NFKC')
            .toLowerCase()
            .replace(/(\d+)\s*(g|gm|gms|gram|grams|kg|kgs|ml|ltr|l|mg|mcg|oz|tab|tabs|tablet|tablets|cap|caps|capsule|capsules|pc|pcs|piece|pieces|box|boxes|strip|strips|vial|vials|bottle|bottles|pack|packs)\b/gi, '$1$2')
            .replace(/\bspf\s*(\d+)\b/gi, 'spf$1')
            .replace(/[^\w\s\-\.]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function tokenize(normalizedText) {
        if (!normalizedText) return [];
        return normalizedText.split(/\s+/).filter(function(t) { return t.length > 0; });
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

    function wordBoundaryMatch(haystackNorm, needleNorm) {
        if (!haystackNorm || !needleNorm) return false;
        var needleTokens = tokenize(needleNorm);
        var haystackTokens = tokenize(haystackNorm);
        if (needleTokens.length === 0 || haystackTokens.length === 0) return false;

        if (needleTokens.length === 1) {
            var n = needleTokens[0];
            for (var i = 0; i < haystackTokens.length; i++) {
                var h = haystackTokens[i];
                if (h === n) return true;
                if (h === n + 's' || h === n + 'es') return true;
                if (n.length >= 5 && h.length > n.length && h.indexOf(n) === 0) return true;
            }
            return false;
        } else {
            for (var k = 0; k < needleTokens.length; k++) {
                var found = false;
                var req = needleTokens[k];
                for (var j = 0; j < haystackTokens.length; j++) {
                    var tok = haystackTokens[j];
                    if (tok === req || tok === req + 's' || tok === req + 'es') {
                        found = true;
                        break;
                    }
                }
                if (!found) return false;
            }
            return true;
        }
    }

    function LeadMatcher() {
        this.minConfidenceScore = 60;
    }

    // Stage A: Hard Eligibility Constraints
    LeadMatcher.prototype.checkEligibility = function(lead, filter) {
        var rawProd = lead.productName || '';
        var normProd = normalizeText(rawProd);
        var leadAttrs = extractAttributes(normProd);

        // 1. Negative keywords rejection
        var negKws = filter.negativeKeywords || filter.negative_keywords || [];
        for (var i = 0; i < negKws.length; i++) {
            var negNorm = normalizeText(negKws[i]);
            if (negNorm && wordBoundaryMatch(normProd, negNorm)) {
                return { eligible: false, reason: 'negative_keyword_match', detail: 'Matched negative: ' + negKws[i] };
            }
        }

        // 2. Hard attribute conflicts
        var prodKws = filter.keywords || filter.product_keywords || (filter.filter_config && filter.filter_config.product_names) || [];
        for (var j = 0; j < prodKws.length; j++) {
            var kwNorm = normalizeText(prodKws[j]);
            var kwAttrs = extractAttributes(kwNorm);

            // SPF conflict
            if (kwAttrs.spf && leadAttrs.spf && kwAttrs.spf !== leadAttrs.spf) {
                return { eligible: false, reason: 'attribute_conflict_spf', detail: 'Filter requires ' + kwAttrs.spf + ' but lead specifies ' + leadAttrs.spf };
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
                    return { eligible: false, reason: 'attribute_conflict_size', detail: 'Filter requires ' + kwAttrs.sizes.join('/') + ' but lead specifies ' + leadAttrs.sizes.join('/') };
                }
            }

            // Form conflict (e.g. lotion vs gel)
            var conflictingForms = [
                ['gel', 'lotion'],
                ['gel', 'cream'],
                ['tablet', 'syrup'],
                ['capsule', 'syrup']
            ];
            for (var c = 0; c < conflictingForms.length; c++) {
                var pair = conflictingForms[c];
                if (kwAttrs.forms.indexOf(pair[0]) !== -1 && leadAttrs.forms.indexOf(pair[1]) !== -1) {
                    return { eligible: false, reason: 'attribute_conflict_form', detail: 'Filter requires ' + pair[0] + ' but lead specifies conflicting form ' + pair[1] };
                }
                if (kwAttrs.forms.indexOf(pair[1]) !== -1 && leadAttrs.forms.indexOf(pair[0]) !== -1) {
                    return { eligible: false, reason: 'attribute_conflict_form', detail: 'Filter requires ' + pair[1] + ' but lead specifies conflicting form ' + pair[0] };
                }
            }
        }

        return { eligible: true, reason: null };
    };

    // Stage B: Relevance Scoring (0 - 100)
    LeadMatcher.prototype.computeScore = function(lead, filter) {
        var rawProd = lead.productName || '';
        var normLead = normalizeText(rawProd);
        var leadTokens = tokenize(normLead);
        var leadAttrs = extractAttributes(normLead);

        var prodKws = filter.keywords || filter.product_keywords || (filter.filter_config && filter.filter_config.product_names) || [];
        if (prodKws.length === 0) {
            return { score: 0, matchedKeyword: null, confidence: 0, reasons: ['No product keywords configured'] };
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

            // Factor 1: Exact phrase match (+30)
            if (normLead.indexOf(normKw) !== -1) {
                score += 30;
                reasons.push('exact_phrase_match (+30)');
            }

            // Factor 2: Token coverage (+25 max)
            var matchedTokensCount = 0;
            for (var t = 0; t < kwTokens.length; t++) {
                var tok = kwTokens[t];
                var matchedTok = false;
                for (var lt = 0; lt < leadTokens.length; lt++) {
                    var lTok = leadTokens[lt];
                    if (lTok === tok || lTok === tok + 's' || lTok === tok + 'es') {
                        matchedTok = true;
                        break;
                    }
                }
                if (matchedTok) matchedTokensCount++;
            }
            var coverage = matchedTokensCount / kwTokens.length;
            var coveragePoints = Math.round(coverage * 25);
            score += coveragePoints;
            reasons.push('token_coverage (' + Math.round(coverage * 100) + '%: +' + coveragePoints + ')');

            if (coverage >= 0.7) totalKeywordsMatched++;

            // Factor 3: Attribute agreement (+15 SPF, +15 size, +10 form)
            if (kwAttrs.spf && leadAttrs.spf && kwAttrs.spf === leadAttrs.spf) {
                score += 15;
                reasons.push('spf_agreement (+15)');
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
                        if (normLead.indexOf(syns[synIdx]) !== -1) {
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

    LeadMatcher.prototype.evaluate = function(lead, filter) {
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

    LeadMatcher.prototype.rankCandidates = function(candidates) {
        return candidates.slice().sort(function(a, b) {
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
        this._localKeywords    = { product: [], negative: [], location: [], required: [] };
        this._supabaseKeywords = { product: [], negative: [], location: [], required: [] };
        this._supabaseEnabled = true;
        this.matcher = new LeadMatcher();
        this._activeFilters = [];
    }

    KeywordManager.prototype.getActiveFilterCount = function() {
        if (this._activeFilters && this._activeFilters.length > 0) {
            return this._activeFilters.filter(function(f) { return f.isActive !== false; }).length;
        }
        if (this._supabaseKeywords && this._supabaseKeywords.product && this._supabaseKeywords.product.length > 0) {
            return this._supabaseKeywords.product.length;
        }
        if (this._localKeywords && this._localKeywords.product && this._localKeywords.product.length > 0) {
            return this._localKeywords.product.length;
        }
        return 0;
    };

    KeywordManager.prototype.setSupabaseEnabled = function(enabled) {
        this._supabaseEnabled = enabled;
        this._rebuildKeywords();
    };

    KeywordManager.prototype._normalize = function(text) {
        return normalizeText(text);
    };

    KeywordManager.prototype._textMatches = function(text, keyword) {
        return wordBoundaryMatch(normalizeText(text), normalizeText(keyword));
    };

    KeywordManager.prototype.loadKeywords = function() {
        var self = this;
        return new Promise(function(resolve) {
            chrome.storage.local.get(['keywords', 'supabaseEnabled'], function(result) {
                self._localKeywords = {
                    product:  (result.keywords && result.keywords.product)  || [],
                    negative: (result.keywords && result.keywords.negative) || [],
                    location: (result.keywords && result.keywords.location) || [],
                    required: (result.keywords && result.keywords.required) || []
                };
                self._supabaseEnabled = result.supabaseEnabled !== false;
                self._rebuildKeywords();
                self.logger.info('Local keywords loaded', {
                    product: self._localKeywords.product.length,
                    supabaseEnabled: self._supabaseEnabled
                });
                resolve(self.keywords);
            });
        });
    };

    KeywordManager.prototype.extractFromSupabaseFilters = function(filters) {
        this._activeFilters = [];
        if (!filters || filters.length === 0) {
            this._supabaseKeywords = { product: [], negative: [], location: [], required: [] };
            this._rebuildKeywords();
            this.logger.info('📥 No active filters');
            return;
        }

        var INDIAN_STATES = {
            'andhra pradesh':1,'arunachal pradesh':1,'assam':1,'bihar':1,'chhattisgarh':1,
            'goa':1,'gujarat':1,'haryana':1,'himachal pradesh':1,'jharkhand':1,'karnataka':1,
            'kerala':1,'madhya pradesh':1,'maharashtra':1,'manipur':1,'meghalaya':1,
            'mizoram':1,'nagaland':1,'odisha':1,'orissa':1,'punjab':1,'rajasthan':1,
            'sikkim':1,'tamil nadu':1,'telangana':1,'tripura':1,'uttar pradesh':1,
            'uttarakhand':1,'uttaranchal':1,'west bengal':1,'delhi':1,'new delhi':1,
            'jammu and kashmir':1,'jammu kashmir':1,'ladakh':1,'chandigarh':1,
            'puducherry':1,'pondicherry':1,'andaman and nicobar islands':1,'lakshadweep':1,
            'dadra and nagar haveli':1,'daman and diu':1
        };

        function normForMatch(t) {
            return normalizeText(t);
        }

        var rules = [];
        for (var i = 0; i < filters.length; i++) {
            var f = filters[i];
            var cfg = f.filter_config || {};
            var uniqNorm = function(arr) {
                var seen = {}, out = [];
                if (!Array.isArray(arr)) return out;
                for (var x = 0; x < arr.length; x++) {
                    if (typeof arr[x] !== 'string') continue;
                    var v = normForMatch(arr[x]);
                    if (v && !seen[v]) { seen[v] = 1; out.push(v); }
                }
                return out;
            };

            var prodNames = [].concat(
                Array.isArray(cfg.product_names) ? cfg.product_names : [],
                Array.isArray(f.product_keywords) ? f.product_keywords : []
            );
            var negNames = [].concat(
                Array.isArray(cfg.negative_keywords) ? cfg.negative_keywords : [],
                Array.isArray(f.negative_keywords) ? f.negative_keywords : []
            );

            rules.push({
                id: f.id,
                name: f.filter_name || ('filter_' + f.id),
                keywords:         uniqNorm(prodNames),
                matchMode:        cfg.match_mode === 'all' ? 'all' : 'any',
                negativeKeywords: uniqNorm(negNames),
                locations: uniqNorm([].concat(
                    Array.isArray(cfg.countries) ? cfg.countries : [],
                    Array.isArray(cfg.states)    ? cfg.states    : [],
                    Array.isArray(cfg.cities)    ? cfg.cities    : [],
                    Array.isArray(f.location_keywords) ? f.location_keywords : []
                )),
                restrictedCountries: uniqNorm(cfg.restricted_countries),
                requireMobile:   cfg.require_mobile   === true,
                requireWhatsapp: cfg.require_whatsapp === true,
                requireEmail:    cfg.require_email    === true,
                quantityUnit:    typeof cfg.quantity_unit === 'string' ? cfg.quantity_unit.toLowerCase() : '',
                minQuantity:     (typeof cfg.min_quantity === 'number' && cfg.min_quantity > 0) ? cfg.min_quantity : 0,
                isActive:        f.is_active !== false,
                rawFilter:       f,
                _indianStates:   INDIAN_STATES
            });
        }
        this._activeFilters = rules;

        // Keep flat lists for backward compatibility and status text
        var product = [], negative = [], location = [], required = [];
        var addUnique = function(arr, item) {
            if (!item || typeof item !== 'string') return;
            var lower = item.toLowerCase().trim();
            if (lower && arr.indexOf(lower) === -1) arr.push(lower);
        };
        for (var j = 0; j < filters.length; j++) {
            var ff = filters[j];
            var cc = ff.filter_config || {};
            if (Array.isArray(ff.product_keywords))  for (var a = 0; a < ff.product_keywords.length;  a++) addUnique(product,  ff.product_keywords[a]);
            if (Array.isArray(ff.negative_keywords)) for (var b = 0; b < ff.negative_keywords.length; b++) addUnique(negative, ff.negative_keywords[b]);
            if (Array.isArray(ff.required_keywords)) for (var c = 0; c < ff.required_keywords.length; c++) addUnique(required, ff.required_keywords[c]);
            if (Array.isArray(ff.location_keywords)) for (var d = 0; d < ff.location_keywords.length; d++) addUnique(location, ff.location_keywords[d]);
            if (Array.isArray(cc.product_names))     for (var e = 0; e < cc.product_names.length;     e++) addUnique(product,  cc.product_names[e]);
            if (Array.isArray(cc.negative_keywords)) for (var g = 0; g < cc.negative_keywords.length; g++) addUnique(negative, cc.negative_keywords[g]);
            if (Array.isArray(cc.required_keywords)) for (var h = 0; h < cc.required_keywords.length; h++) addUnique(required, cc.required_keywords[h]);
            if (Array.isArray(cc.countries))         for (var k1 = 0; k1 < cc.countries.length; k1++) addUnique(location, cc.countries[k1]);
        }
        this._supabaseKeywords = { product: product, negative: negative, location: location, required: required };
        this._rebuildKeywords();
        this.logger.info('📥 Supabase filters built', { rules: rules.length, product: product.length, activeCount: this.getActiveFilterCount() });
    };

    KeywordManager.prototype._rebuildKeywords = function() {
        if (this._supabaseEnabled && (
            this._supabaseKeywords.product.length > 0 ||
            this._supabaseKeywords.negative.length > 0 ||
            this._supabaseKeywords.required.length > 0)) {
            this.keywords = {
                product:  this._supabaseKeywords.product.slice(),
                negative: this._supabaseKeywords.negative.slice(),
                location: this._supabaseKeywords.location.slice(),
                required: this._supabaseKeywords.required.slice()
            };
        } else {
            this.keywords = {
                product:  this._localKeywords.product.slice(),
                negative: this._localKeywords.negative.slice(),
                location: this._localKeywords.location.slice(),
                required: this._localKeywords.required.slice()
            };
        }
    };

    KeywordManager.prototype.updateKeywords = function(newKeywords) {
        var self = this;
        return new Promise(function(resolve) {
            for (var k in newKeywords) {
                if (newKeywords.hasOwnProperty(k) && self._localKeywords.hasOwnProperty(k)) {
                    self._localKeywords[k] = newKeywords[k];
                }
            }
            chrome.storage.local.set({ keywords: self._localKeywords }, function() {
                self._rebuildKeywords();
                resolve(true);
            });
        });
    };

    // Evaluates a candidate lead against all active filters with Stage A eligibility & Stage B candidate ranking
    KeywordManager.prototype.evaluateFilters = function(lead) {
        var self = this;
        var rules = this._activeFilters || [];
        var activeRules = rules.filter(function(r) { return r.isActive !== false; });
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
            if (!rule.locations || rule.locations.length === 0) return true;
            for (var i = 0; i < rule.locations.length; i++) {
                var entry = rule.locations[i];
                if (entry === 'india' || entry === 'in') {
                    if (leadCountryIso === 'IN') return true;
                    for (var p = 0; p < locParts.length; p++) {
                        if (rule._indianStates && rule._indianStates[locParts[p]]) return true;
                    }
                    continue;
                }
                for (var q = 0; q < locParts.length; q++) {
                    if (locParts[q] === entry || locParts[q].indexOf(entry) !== -1 || entry.indexOf(locParts[q]) !== -1) return true;
                }
            }
            return false;
        }

        var candidateMatches = [];

        for (var i = 0; i < activeRules.length; i++) {
            var r = activeRules[i];

            // 1. Restricted countries check
            if (r.restrictedCountries && r.restrictedCountries.length > 0) {
                var restricted = false;
                if (leadCountryIso) {
                    for (var ri = 0; ri < r.restrictedCountries.length; ri++) {
                        if (r.restrictedCountries[ri] === leadCountryIso.toLowerCase()) { restricted = true; break; }
                    }
                }
                if (!restricted) {
                    for (var li = 0; li < r.restrictedCountries.length; li++) {
                        for (var lp = 0; lp < locParts.length; lp++) {
                            if (r.restrictedCountries[li] === locParts[lp]) { restricted = true; break; }
                        }
                        if (restricted) break;
                    }
                }
                if (restricted) continue;
            }

            // 2. Location include check
            if (!locationMatches(r)) continue;

            // 3. Contact requirements
            var anyRequired = r.requireMobile || r.requireWhatsapp || r.requireEmail;
            if (anyRequired) {
                var has = false;
                if (r.requireMobile && (contact.mobile || lead.senderMobile)) has = true;
                if (r.requireWhatsapp && (contact.phone || lead.senderMobile)) has = true;
                if (r.requireEmail && (contact.email || lead.senderEmail)) has = true;
                if (!has) continue;
            }

            // 4. Quantity filter
            if (r.quantityUnit && r.minQuantity > 0) {
                var q = lead.quantity;
                if (!q || q.unit !== r.quantityUnit || q.max < r.minQuantity) continue;
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
            }
        }

        if (candidateMatches.length === 0) {
            return { passed: false, reason: 'no_filter_matched', matchedProducts: [], matchedRequired: [], matchedNegative: [] };
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

    KeywordManager.prototype.getKeywords    = function(type) { return this.keywords[type] || []; };
    KeywordManager.prototype.getAllKeywords = function() { return this.keywords; };

    // ============================================================
    // CHECK KEYWORDS — v6.2 SIGNATURE
    // ------------------------------------------------------------
    // checkKeywords(productName, messageText)
    //   • product keyword  → must match productName (OR list, pass if list empty)
    //   • negative keyword → reject if matches productName
    //   • required keyword → at least one must match productName OR messageText
    // ============================================================
    KeywordManager.prototype.checkKeywords = function(productName, messageText) {
        productName = productName || '';
        messageText = messageText || '';

        var req  = this.keywords.required || [];
        var neg  = this.keywords.negative || [];
        var prod = this.keywords.product  || [];

        // --- NEGATIVE GATE (productName only) ---
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

        // --- PRODUCT GATE (productName only) ---
        var prodMatched = [];
        if (prod.length > 0) {
            for (var k = 0; k < prod.length; k++) {
                if (this._textMatches(productName, prod[k])) prodMatched.push(prod[k]);
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
    function SafetyController() {
    this.mode = 'AUTOMATIC';
    this._emergencyStop = false;
    this.counters = { minute: 0, hour: 0, day: 0, session: 0 };
    this.limits = { perMinute: 60, perHour: 400, perDay: 2000, perSession: 1000 };
    this._lastMin = Date.now();
    this._lastHour = Date.now();
    this._lastDay = Date.now();
}
SafetyController.prototype._reset = function() {
    var now = Date.now();
    if (now - this._lastMin  > 60000)    { this.counters.minute = 0;  this._lastMin  = now; }
    if (now - this._lastHour > 3600000)  { this.counters.hour   = 0;  this._lastHour = now; }
    if (now - this._lastDay  > 86400000) { this.counters.day    = 0;  this._lastDay  = now; }
};
SafetyController.prototype.setMode = function(m) { this.mode = m; };
SafetyController.prototype.setLimits = function(l) {
    for (var k in l) if (l.hasOwnProperty(k) && this.limits.hasOwnProperty(k)) this.limits[k] = l[k];
};
SafetyController.prototype.canAcquire = function() {
    this._reset();
    if (this._emergencyStop) return { allowed: false, reason: 'EMERGENCY_STOP' };
    if (this.mode === 'MONITOR') return { allowed: false, reason: 'MONITOR_MODE' };
    if (this.mode === 'DRY_RUN') return { allowed: false, reason: 'DRY_RUN', dryRun: true };
    if (this.counters.minute  >= this.limits.perMinute)  return { allowed: false, reason: 'MINUTE_LIMIT',  details: { used: this.counters.minute,  limit: this.limits.perMinute  } };
    if (this.counters.hour    >= this.limits.perHour)    return { allowed: false, reason: 'HOUR_LIMIT',    details: { used: this.counters.hour,    limit: this.limits.perHour    } };
    if (this.counters.day     >= this.limits.perDay)     return { allowed: false, reason: 'DAY_LIMIT',     details: { used: this.counters.day,     limit: this.limits.perDay     } };
    if (this.counters.session >= this.limits.perSession) return { allowed: false, reason: 'SESSION_LIMIT', details: { used: this.counters.session, limit: this.limits.perSession } };
    return { allowed: true };
};
SafetyController.prototype.recordAcquisition = function() {
    this.counters.minute++; this.counters.hour++; this.counters.day++; this.counters.session++;
};
SafetyController.prototype.emergencyStopFn = function() { this._emergencyStop = true; };
SafetyController.prototype.resume = function() { this._emergencyStop = false; };
SafetyController.prototype.getStatus = function() {
    return { mode: this.mode, emergencyStop: this._emergencyStop, counters: this.counters, limits: this.limits, cooldown: false, cooldownMs: 0 };
};

    // ============================================================
    // DUPLICATE MANAGER
    // ============================================================
    function DuplicateManager(supabase) {
        this.supabase = supabase;
        this._seen = new Set();
        this._loadedFromDb = false;
    }
    DuplicateManager.prototype.loadFromDb = function() {
        var self = this;
        if (this._loadedFromDb) return Promise.resolve();
        // Only load contacted / acquired leads — un-acquired leads are NEVER duplicates
        return this.supabase.getRecentLeads(500).then(function(leads) {
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
        }).catch(function() { return 0; });
    };
    DuplicateManager.prototype.isDuplicate = function(leadId) { return this._seen.has(leadId); };
    DuplicateManager.prototype.markSeen   = function(leadId) { this._seen.add(leadId); };
    DuplicateManager.prototype.clear      = function() { this._seen = new Set(); };
    DuplicateManager.prototype.cleanup    = function() {
        if (this._seen.size > 5000) {
            var arr = Array.from(this._seen);
            this._seen = new Set(arr.slice(-3000));
        }
    };

    // ============================================================
    // STATE MACHINE
    // ============================================================
    function LeadStateMachine() { this._states = {}; }
    LeadStateMachine.prototype.setState = function(id, state) {
        this._states[id] = state;
        return Promise.resolve(state);
    };
    LeadStateMachine.prototype.getStats = function() {
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
    }
    LeadQueue.prototype.setProcessor = function(p) {
        this.processor = p;
        this.logger.info('Processor set');
        this._process();
    };
    LeadQueue.prototype.enqueue = function(lead) {
        if (this.processing && this._currentId === lead.leadId) return false;
        for (var i = 0; i < this.queue.length; i++) {
            if (this.queue[i].leadId === lead.leadId) return false;
        }
        this.queue.push(lead);
        // Kick the pump immediately
        this._process();
        return true;
    };
    LeadQueue.prototype._process = function() {
        var self = this;
        if (!this._running || !this.processor || this.queue.length === 0) return;
        var MAX_PARALLEL = 3;
        if (this.processing >= MAX_PARALLEL) return;
        var lead = this.queue.shift();
        this.processing++;
        this.processor(lead).then(function() {
            self.processing--;
            if (self.queue.length > 0) self._process();
        }).catch(function(err) {
            self.logger.error('Processor error', { leadId: lead.leadId, error: err.message });
            self.processing--;
            if (self.queue.length > 0) self._process();
        });
    };
    LeadQueue.prototype.getStatus = function() { return { size: this.queue.length, processing: this.processing, running: this._running }; };
    LeadQueue.prototype.pause  = function() { this._running = false; };
    LeadQueue.prototype.resume = function() { this._running = true; this._process(); };

    // ============================================================
    // SCANNER (FASTER DEBOUNCE)
    // ============================================================
    function Scanner() {
        this.logger = new Logger('Scanner');
        this._running = false;
        this._callback = null;
        this._observer = null;
        this._topSentinel = null;
        this._scanTimer = null;
        this._knownLeads = {};
        this._debounceMs = 25; // ultra-low latency reaction
        this._fallbackMs = 800; // fast fallback poll
        this._idGen = new LeadIdGenerator();
        this._scanning = false;
        this._scanPending = false;
    }
    Scanner.prototype._attachTopSentinel = function() {
        if (this._topSentinel) return;
        var s = document.createElement('div');
        s.id = 'bl-top-sentinel';
        s.style.cssText = 'height:1px;width:100%;pointer-events:none;opacity:0;';
        if (document.body) document.body.insertBefore(s, document.body.firstChild);
        this._topSentinel = s;
    };
    Scanner.prototype._checkNewLeadsBanner = function() {
        try {
            var banners = document.querySelectorAll(
                '[class*="new_lead"], [class*="newLead"], .bl_new_toast, [id*="newLead"], ' +
                '[class*="newBuyLead"], [class*="new_buylead"], .bl_toast_wrap, [class*="alert_new"], ' +
                '[class*="toast"], button, a, div'
            );
            for (var i = 0; i < banners.length; i++) {
                var b = banners[i];
                if (b.id && b.id.indexOf('bl-') === 0) continue; // Skip extension panel UI
                var t = (b.textContent || '').trim().toLowerCase();
                if ((t.indexOf('new buylead') !== -1 || t.indexOf('new lead') !== -1 || t.indexOf('new enquiry') !== -1)
                    && (t.indexOf('click') !== -1 || t.indexOf('refresh') !== -1 || t.indexOf('available') !== -1 || t.indexOf('view') !== -1 || t.indexOf('load') !== -1)) {
                    if (b.offsetWidth > 0 && b.offsetHeight > 0) {
                        b.click();
                        this.logger.info('⚡ Clicked IndiaMART New Leads banner: "' + t.substring(0, 40) + '"');
                        return true;
                    }
                }
            }
        } catch (e) {}
        return false;
    };
    Scanner.prototype.startWatching = function(cb) {
        if (this._running) return;
        this._callback = cb;
        this._running = true;
        var container = document.querySelector('#bl_listing, [class*="bl_listing"], [class*="BuyLdC_cont"], [class*="BLbp_card"]');
        var targetNode = container ? (container.parentElement || container) : (document.body || document.documentElement);
        var self2 = this;
        this._observer = new MutationObserver(function() {
            if (self2._scanPending) return;
            self2._scanPending = true;
            setTimeout(function() { self2._scanPending = false; self2._scan(); }, self2._debounceMs);
        });
        if (targetNode) {
            this._observer.observe(targetNode, { childList: true, subtree: true });
        }
        this._scanTimer = setInterval(function() { self2._scan(); }, this._fallbackMs);
        this.logger.info('✅ Scanner started');
        setTimeout(function() { self2._scan(); }, 200);
    };
    Scanner.prototype.stopWatching = function() {
        this._running = false;
        if (this._observer) { this._observer.disconnect(); this._observer = null; }
        if (this._scanTimer) { clearInterval(this._scanTimer); this._scanTimer = null; }
    };
    Scanner.prototype._scan = function() {
        if (this._scanning || !this._running) return;
        this._scanning = true;
        try {
            // Auto-detect and click any "New Leads Available" banner to bring dynamic leads into portal DOM
            this._checkNewLeadsBanner();

            var allCards = document.querySelectorAll('[class*="BuyLdC_cont"], [class*="BLbp_card"], .BLbp_card, [class*="BuyLdC_Card"], div[id*="id_BLCard"]');
            // Incremental scanning focused strictly on the seven newest eligible cards in the feed
            var cards = Array.prototype.slice.call(allCards, 0, 7);
            var currentIds = {};
            var newCards = [];
            var idGen = this._idGen;
            var known = this._knownLeads;
            for (var i = 0; i < cards.length; i++) {
                var el = cards[i];
                var id = idGen.generateFromElement(el);
                if (!id) continue;
                currentIds[id] = 1;
                if (!known[id]) { known[id] = Date.now(); newCards.push({ element: el, id: id }); }
                else { known[id] = Date.now(); }
            }
            var now = Date.now();
            for (var key in known) {
                var age = now - known[key];
                if (age > 1800000) delete known[key];
            }
            if (newCards.length > 0) this._callback(newCards);
        } catch (e) {}
        this._scanning = false;
    };
    Scanner.prototype.resetEmitted = function() {
    this._knownLeads = {};
    this.logger.info('🔄 Scanner emitted-cache cleared — next scan will re-emit all DOM cards');
};
    Scanner.prototype.getStatus = function() { return { running: this._running, knownLeads: Object.keys(this._knownLeads).length }; };

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
        } catch (e) {}
        return null;
    }

    function extractQuantityFromTitle(title) {
        if (!title) return null;
        var m = title.match(/\bqty\s*[:\-]\s*([^\|]+)/i);
        if (!m) return null;
        return parseQuantityString(m[1]);
    }

    function Parser() { this.logger = new Logger('Parser'); }

    Parser.prototype.parseCard = function(el, leadId) {
        try {
            // --- PRODUCT NAME (title only) ---
           var productEl = el.querySelector('.BLbp_title')
             || el.querySelector('[class*="BuyLdC"] span.SLC_f18');
            if (!productEl) {
            productEl = el.querySelector('[class*="BuyLdC"] .SLC_f18');
           }
            var productName = productEl ? productEl.textContent.trim() : '';
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
            var isTimeText = function(txt) {
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
            } catch (e) {}

            // 2) CSS Flag elements (e.g. <span class="flags flags_us">, <i class="flag flag-ae">)
            if (!countryIso) {
                try {
                    var cssFlags = el.querySelectorAll('[class*="flag"], [class*="country"]');
                    for (var cf = 0; cf < cssFlags.length; cf++) {
                        var cls = cssFlags[cf].className || '';
                        var m = cls.match(/flag[s]?[_-]([a-z]{2})/i);
                        if (m) { countryIso = m[1].toUpperCase(); break; }
                    }
                } catch (e) {}
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
                var segments = location.toLowerCase().split(',').map(function(s) { return s.trim(); });
                for (var s = 0; s < segments.length; s++) {
                    for (var name in countryMap) {
                        if (segments[s] === name) { countryIso = countryMap[name]; break; }
                    }
                    if (countryIso) break;
                }
            }

            // 4) Check for IndiaMART Foreign Lead Badges / Text
            var cardFullText = (el.textContent || '');
            if (/(?:foreign\s*buylead|foreign\s*lead|export\s*buylead|international\s*buylead|overseas)/i.test(cardFullText) ||
                el.querySelector('[class*="foreign"], [class*="export"], [class*="international"]')) {
                isForeignLead = true;
                if (!countryIso) countryIso = 'FOREIGN';
                if (!location) location = 'Foreign';
            }

            if (countryIso && countryIso !== 'IN') {
                isForeignLead = true;
            }

            // --- CONTACT AVAILABILITY ---
            var contact = { mobile: null, email: null, phone: null };
            // New UI: chips in .BLbp_chips
var chips = el.querySelectorAll('.BLbp_chip');
if (chips.length > 0) {
    for (var ci = 0; ci < chips.length; ci++) {
        var chipText = (chips[ci].textContent || '').toLowerCase();
        if (chipText.indexOf('phone') !== -1 || chipText.indexOf('mobile') !== -1) contact.mobile = 'available';
        if (chipText.indexOf('email') !== -1) contact.email = 'available';
        if (chipText.indexOf('whatsapp') !== -1) contact.phone = 'available';
    }
}
// Fallback: old UI
if (!contact.mobile && !contact.email && !contact.phone) {
    var availSec = el.querySelector('[class*="Available"], [class*="SLC_aifs"]');
    if (availSec) {
        var at = availSec.textContent.toLowerCase();
        if (at.indexOf('mobile') !== -1 || at.indexOf('call') !== -1) contact.mobile = 'available';
        if (at.indexOf('email') !== -1) contact.email = 'available';
        if (at.indexOf('whatsapp') !== -1) contact.phone = 'available';
    }
}

            // --- MESSAGE TEXT (buyer's requirement only — NOT title) ---
            var messageText = '';
var msgEl = el.querySelector('.BLbp_desc')
         || el.querySelector('[class*="BuyLdC_msg"]');
if (msgEl) {
    var emEl = msgEl.querySelector('em');
    messageText = (emEl ? emEl.textContent : msgEl.textContent).trim();
    // Strip "Buyer Searched for " prefix if present
    messageText = messageText.replace(/^buyer\s+searched\s+for\s+/i, '').trim();
}

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
            } catch (e) {}

            // --- SENDER / SELLER / BUYER DETAILS ---
            var senderEl = el.querySelector('.BLbp_byrName, .BLbp_buyer, [class*="buyer"], [class*="byr_name"], [class*="buyerName"], [class*="company"], [class*="comp_name"], [class*="senderName"], .BLbp_member, .BLbp_byrInfo, .SLC_byr, [class*="byrInfo"]');
            var senderName = senderEl ? senderEl.textContent.trim() : '';

            // --- COMPOSE LEAD ---
            var subject = productName + (location ? ' - ' + location : '');

            // Build unique lead ID distinguishing seller, product, location, quantity & requirement
            // Ensures multiple leads for the exact same product from different sellers are NOT treated as duplicates
            var queryIdPart = (leadId && leadId.indexOf('hash_') === -1) ? leadId : '';
            var sellerPart  = (senderName || senderMobile || senderEmail || '').toLowerCase().replace(/[^\w]/g, '_').substring(0, 30);
            var prodPart    = (productName || '').toLowerCase().replace(/[^\w]/g, '_').substring(0, 40);
            var locPart     = (location || '').toLowerCase().replace(/[^\w]/g, '_').substring(0, 30);
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
                uniqueQueryId: contentKey,
                queryType: 'BUY_LEAD',
                queryTime: new Date().toISOString(),

                productName: productName,
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

    Parser.prototype.normalize = function(lead) {
        if (!lead) return null;
        lead.productName = (lead.productName || '').toLowerCase();
        lead.state       = (lead.state || '').toLowerCase();
        lead.city        = (lead.city || '').toLowerCase();
        return lead;
    };

    // ============================================================
    // ACTION ADAPTER (FAST + GUARDED RETRY)
    // ============================================================
    function ActionAdapter(popupMgr) {
        this.logger = new Logger('ActionAdapter');
        this._dryRun = false;
        this._clicked = {};
        this.popupManager = popupMgr;
        this._autoMinimize = true;
        this._confirmationAnswer = 'yes';
        this._purchaseAction = 'close';
        this._timeout = 5000;
    }
    ActionAdapter.prototype.setDryRun            = function(v) { this._dryRun = v; };
    ActionAdapter.prototype.setAutoMinimize      = function(v) { this._autoMinimize = v; };
    ActionAdapter.prototype.setConfirmationAnswer= function(v) { this._confirmationAnswer = v; };
    ActionAdapter.prototype.setPurchaseAction    = function(v) { this._purchaseAction = v; };
    ActionAdapter.prototype.setPopupTimeout      = function(v) { this._timeout = v; };

    function simulateClick(el) {
        if (!el) return;
        try {
            if (typeof el.scrollIntoView === 'function') {
                el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }
        } catch (e) {}

        var rect = el.getBoundingClientRect();
        var cx = rect.left + rect.width / 2;
        var cy = rect.top + rect.height / 2;
        var eventOpts = {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            detail: 1,
            clientX: cx,
            clientY: cy,
            screenX: cx,
            screenY: cy,
            buttons: 1
        };

        try { el.dispatchEvent(new PointerEvent('pointerdown', eventOpts)); } catch (e) {}
        try { el.dispatchEvent(new MouseEvent('mousedown', eventOpts)); } catch (e) {}
        try { el.focus(); } catch (e) {}
        try { el.dispatchEvent(new PointerEvent('pointerup', eventOpts)); } catch (e) {}
        try { el.dispatchEvent(new MouseEvent('mouseup', eventOpts)); } catch (e) {}
        try { el.dispatchEvent(new MouseEvent('click', eventOpts)); } catch (e) {}
        try { el.click(); } catch (e) {}
    }

    ActionAdapter.prototype.acquire = function(lead) {
        var self = this;
        var log = this.logger;
        return new Promise(function(resolve) {
            if (self._dryRun) { resolve({ success: false, simulated: true, message: 'DRY_RUN' }); return; }
            if (!lead.raw || !lead.raw.element) { resolve({ success: false, message: 'No element' }); return; }
            if (self._clicked[lead.leadId]) { resolve({ success: false, message: 'Already clicked' }); return; }

            try {
                var el = lead.raw.element;
                var button = null;
                var buttons = el.querySelectorAll('button, a, [role="button"], [class*="BuyLdC_btn"], [class*="SLC_FillCTA"], [class*="BuyLdC_Cta"], [class*="BuyLdC_cta"], [class*="btn"]');
                for (var i = 0; i < buttons.length; i++) {
                    var t = (buttons[i].textContent || '').trim().toLowerCase();
                    if (t.indexOf('contact buyer') !== -1 || t.indexOf('contact now') !== -1 ||
                        t.indexOf('connect with buyer') !== -1 || t.indexOf('send enquiry') !== -1 ||
                        t.indexOf('view contact') !== -1 || t.indexOf('reply now') !== -1) {
                        button = buttons[i];
                        break;
                    }
                }
                if (!button) {
                    for (var j = 0; j < buttons.length; j++) {
                        var t2 = (buttons[j].textContent || '').trim().toLowerCase();
                        if (t2.indexOf('contact') !== -1 || t2.indexOf('connect') !== -1 || t2.indexOf('enquiry') !== -1) {
                            button = buttons[j];
                            break;
                        }
                    }
                }
                if (!button) button = el.querySelector('[class*="BuyLdC_btn"], [class*="SLC_FillCTA"], [class*="BuyLdC_Cta"], [class*="BuyLdC_cta"], button.BuyLdC_Cta, [class*="contact"]');
                if (!button) { resolve({ success: false, message: 'No button' }); return; }

                self._clicked[lead.leadId] = true;
                simulateClick(button);
                log.info('⚡ Clicked acquisition button', { leadId: lead.leadId });

                var start = Date.now();
                var maxTimeout = self._timeout || 3000;
                var interval = setInterval(function() {
                    // Check if card button itself transitioned to contacted state in DOM
                    var btnText = (button.textContent || '').trim().toLowerCase();
                    var isCardContacted = button.hasAttribute('disabled') ||
                        button.classList.contains('disabled') ||
                        btnText.indexOf('contacted') !== -1 ||
                        btnText.indexOf('already contact') !== -1 ||
                        btnText.indexOf('enquiry sent') !== -1 ||
                        btnText.indexOf('view contact') !== -1 ||
                        btnText.indexOf('view number') !== -1;

                    if (isCardContacted) {
                        clearInterval(interval);
                        if (el) {
                            try {
                                el.setAttribute('data-leadsync-acquired', 'true');
                                el.classList.add('bl-acquired-card');
                            } catch (e) {}
                        }
                        log.info('✅ Acquisition verified directly on card button', { leadId: lead.leadId, status: btnText });
                        resolve({ success: true, action: 'card_updated', popup: { success: true } });
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
                        var isPurchase = text.indexOf('purchase buylead') !== -1 ||
                            text.indexOf("to view buyer's contact details") !== -1 ||
                            text.indexOf('per buylead') !== -1 ||
                            (text.indexOf('buy') !== -1 && text.indexOf('₹') !== -1);

                        if (isPurchase) {
                            // Paywall popup: points needed, do NOT treat as acquired
                            var closeBtn = popup.querySelector('.SLC_pa.SLC_cp, [class*="SLC_pa"][class*="SLC_cp"], button[class*="close"], [aria-label="Close"], [class*="close"]');
                            if (!closeBtn) {
                                var allBtns = popup.querySelectorAll('button, span');
                                for (var b = 0; b < allBtns.length; b++) {
                                    var bt = (allBtns[b].textContent || '').trim();
                                    if (bt === '×' || bt === '✕' || bt === 'X' || bt.toLowerCase() === 'close') { closeBtn = allBtns[b]; break; }
                                }
                            }
                            if (closeBtn) { try { simulateClick(closeBtn); } catch(e) {} }
                            document.body.style.overflow = '';
                            log.warn('⚠️ BuyLead purchase required (paywall modal detected)', { leadId: lead.leadId });
                            resolve({ success: false, action: 'points_required', message: 'BuyLead purchase points required' });
                            return;
                        }

                        // PAID ACCOUNT / ENQUIRY POPUP: look for Send/Submit/Confirm button
                        var actionBtns = popup.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"], a[class*="btn"], [class*="submit"], [class*="send"]');
                        var sendBtn = null;
                        for (var cb = 0; cb < actionBtns.length; cb++) {
                            var ct = (actionBtns[cb].textContent || actionBtns[cb].value || '').trim().toLowerCase();
                            if (ct === 'send' || ct === 'send now' || ct === 'send reply' || ct === 'send message' ||
                                ct === 'contact buyer' || ct === 'submit' || ct === 'confirm' || ct === 'yes' ||
                                ct === 'ok' || ct === 'proceed' || ct.indexOf('send') === 0) {
                                sendBtn = actionBtns[cb];
                                break;
                            }
                        }

                        if (sendBtn) {
                            try { simulateClick(sendBtn); } catch(e) {}
                            log.info('⚡ Clicked Send/Confirm in popup', { leadId: lead.leadId });
                            if (el) {
                                try {
                                    el.setAttribute('data-leadsync-acquired', 'true');
                                    el.classList.add('bl-acquired-card');
                                } catch (e) {}
                            }
                            setTimeout(function() {
                                document.body.style.overflow = '';
                                resolve({ success: true, action: 'sent', popup: { success: true } });
                            }, 50);
                            return;
                        }

                        // Close secondary prompt
                        var closeBtn2 = popup.querySelector('.SLC_pa.SLC_cp, [class*="SLC_pa"][class*="SLC_cp"], button[class*="close"], [aria-label="Close"], [class*="close"]');
                        if (closeBtn2) {
                            try { simulateClick(closeBtn2); } catch(e) {}
                        } else {
                            try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true })); } catch(e) {}
                        }
                        document.body.style.overflow = '';
                        resolve({ success: true, action: 'confirmed', popup: { success: true } });
                        return;
                    }

                    // Timeout condition: check if card verified; if not, return failure (no fake success)
                    if (Date.now() - start > maxTimeout) {
                        clearInterval(interval);
                        var finalBtnText = (button.textContent || '').trim().toLowerCase();
                        var finalVerified = button.hasAttribute('disabled') ||
                            button.classList.contains('disabled') ||
                            finalBtnText.indexOf('contacted') !== -1 ||
                            finalBtnText.indexOf('already contact') !== -1 ||
                            finalBtnText.indexOf('enquiry sent') !== -1;

                        if (finalVerified) {
                            if (el) {
                                try {
                                    el.setAttribute('data-leadsync-acquired', 'true');
                                    el.classList.add('bl-acquired-card');
                                } catch (e) {}
                            }
                            resolve({ success: true, action: 'card_updated', popup: { success: true } });
                        } else {
                            resolve({ success: false, action: 'timeout_no_confirmation', message: 'No confirmation or popup response received' });
                        }
                    }
                }, 25);

            } catch (err) {
                resolve({ success: false, message: err.message });
            }
        });
    };

    // ============================================================
    // SCORER
    // ============================================================
    function LeadScorer() {
        this.minimumScore = 60;
        this.weights = {
            base: 50,
            perProductKeyword: 10, maxProductBonus: 30,
            preferredState: 15, countryMatch: 15,
            hasMobile: 10, hasEmail: 8, hasPhone: 5,
            detailedRequirement: 5, requirementLengthThreshold: 100
        };
        this.penalties = { wrongCountry: -20, wrongState: -10, noContact: -5 };
        this.preferredStates = ['maharashtra'];
        this.preferredCountries = ['IN'];
    }
    LeadScorer.prototype.setWeights = function(weights) {
        if (!weights) return;
        for (var k in weights) if (weights.hasOwnProperty(k) && this.weights.hasOwnProperty(k)) this.weights[k] = weights[k];
    };
    LeadScorer.prototype.setPenalties = function(penalties) {
        if (!penalties) return;
        for (var k in penalties) if (penalties.hasOwnProperty(k) && this.penalties.hasOwnProperty(k)) this.penalties[k] = penalties[k];
    };
    LeadScorer.prototype.setPreferredStates = function(states) {
        if (Array.isArray(states)) this.preferredStates = states.map(function(s) { return String(s).toLowerCase().trim(); });
    };
    LeadScorer.prototype.setPreferredCountries = function(countries) {
        if (Array.isArray(countries)) this.preferredCountries = countries.map(function(c) { return String(c).toUpperCase().trim(); });
    };

    LeadScorer.prototype.scoreLead = function(lead, matchRes) {
        var score = this.weights.base;
        var reasons = [];

        // Product keywords — capped at 3 to prevent score inflation
        var mp = (matchRes && matchRes.matchedProducts) || [];
        if (mp.length > 0) {
            var mpCount = Math.min(mp.length, 3);
            var bonus = Math.min(this.weights.maxProductBonus, mpCount * this.weights.perProductKeyword);
            score += bonus;
            reasons.push('product+' + bonus);
        }

        // Message keyword bonus (soft signal, +2 each, cap +6)
        var msgBonus = 0;
        if (lead.messageText && this._lastProductKeywords) {
            for (var i = 0; i < this._lastProductKeywords.length; i++) {
                if (lead.messageText.toLowerCase().indexOf(this._lastProductKeywords[i]) !== -1) {
                    msgBonus += 2;
                    if (msgBonus >= 6) break;
                }
            }
        }
        score += msgBonus;

        var country = (lead.countryIso || '').toUpperCase();
        if (country && this.preferredCountries.length > 0) {
            if (this.preferredCountries.indexOf(country) !== -1) {
                score += this.weights.countryMatch;
                reasons.push('country+' + this.weights.countryMatch);
            } else {
                score += this.penalties.wrongCountry;
                reasons.push('country' + this.penalties.wrongCountry);
            }
        }

        var state = (lead.state || '').toLowerCase();
        if (state && this.preferredStates.length > 0) {
            var stateMatch = false;
            for (var s = 0; s < this.preferredStates.length; s++) {
                if (state.indexOf(this.preferredStates[s]) !== -1) { stateMatch = true; break; }
            }
            if (stateMatch) {
                score += this.weights.preferredState;
                reasons.push('state+' + this.weights.preferredState);
            } else {
                score += this.penalties.wrongState;
                reasons.push('state' + this.penalties.wrongState);
            }
        }

        var hasContact = false;
        if (lead.contact) {
            if (lead.contact.mobile) { score += this.weights.hasMobile; hasContact = true; reasons.push('mobile+' + this.weights.hasMobile); }
            if (lead.contact.email)  { score += this.weights.hasEmail;  hasContact = true; reasons.push('email+' + this.weights.hasEmail); }
            if (lead.contact.phone && !lead.contact.mobile) { score += this.weights.hasPhone; hasContact = true; reasons.push('phone+' + this.weights.hasPhone); }
        }
        if (!hasContact) {
            score += this.penalties.noContact;
            reasons.push('noContact' + this.penalties.noContact);
        }

        if (lead.messageText && lead.messageText.length > this.weights.requirementLengthThreshold) {
            score += this.weights.detailedRequirement;
            reasons.push('detail+' + this.weights.detailedRequirement);
        }

        score = Math.max(0, Math.min(100, score));
        return { score: score, eligible: score >= this.minimumScore, reasons: reasons };
    };

    LeadScorer.prototype.isEligible       = function(r) { return r.eligible; };
    LeadScorer.prototype.setMinimumScore  = function(s) { this.minimumScore = s; };

    // ============================================================
    // CENTRALIZED PERFORMANCE METRICS SERVICE (v6.3 - GRAVITAS)
    // ============================================================
    function PerformanceMetrics() {
        this._activeFiltersCount = 0;
        this._detections = new Map(); // leadId -> timestamp
        this._matches = new Map();    // leadId -> timestamp
        this._attempts = 0;           // total eligible acquisition attempts
        this._acquisitions = [];      // [{ leadId, durationMs, timestamp }]
        this._failedAttempts = 0;
        this._contacts = [];          // [{ leadId, durationMs, timestamp }]
        this._failedContacts = 0;
        this._sampleLimit = 20;
    }

    PerformanceMetrics.prototype.setActiveFiltersCount = function(count) {
        this._activeFiltersCount = Math.max(0, parseInt(count, 10) || 0);
    };

    PerformanceMetrics.prototype.getActiveFiltersCount = function() {
        return this._activeFiltersCount;
    };

    PerformanceMetrics.prototype.recordDetection = function(leadId, timestamp) {
        if (!leadId) return;
        var t = timestamp || (typeof performance !== 'undefined' ? performance.now() : Date.now());
        if (!this._detections.has(leadId)) {
            this._detections.set(leadId, t);
        }
    };

    PerformanceMetrics.prototype.recordMatch = function(leadId, timestamp) {
        if (!leadId) return;
        var t = timestamp || (typeof performance !== 'undefined' ? performance.now() : Date.now());
        this._matches.set(leadId, t);
    };

    PerformanceMetrics.prototype.recordAcquisitionAttempt = function(leadId) {
        this._attempts++;
    };

    PerformanceMetrics.prototype.recordAcquisitionSuccess = function(leadId, timestamp) {
        var now = timestamp || (typeof performance !== 'undefined' ? performance.now() : Date.now());
        var detectedAt = this._detections.get(leadId);
        var durationMs = detectedAt ? Math.max(0, now - detectedAt) : 0;

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

    PerformanceMetrics.prototype.recordAcquisitionFailure = function(leadId, reason) {
        this._failedAttempts++;
        this._detections.delete(leadId);
    };

    PerformanceMetrics.prototype.recordContactSuccess = function(leadId, timestamp) {
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

    PerformanceMetrics.prototype.recordContactFailure = function(leadId, reason) {
        this._failedContacts++;
        this._matches.delete(leadId);
    };

    PerformanceMetrics.prototype.getSpeedPerAcquisition = function() {
        if (this._acquisitions.length === 0) {
            return {
                averageMs: null,
                formatted: '---',
                sampleCount: 0
            };
        }
        var sample = this._acquisitions.slice(-this._sampleLimit);
        var total = 0;
        for (var i = 0; i < sample.length; i++) {
            total += sample[i].durationMs;
        }
        var avgMs = Math.round(total / sample.length);
        var formatted = avgMs < 1000 ? (avgMs + 'ms') : ((avgMs / 1000).toFixed(1) + 's');
        return {
            averageMs: avgMs,
            formatted: formatted,
            sampleCount: sample.length
        };
    };

    PerformanceMetrics.prototype.getAcceptanceRate = function() {
        if (this._attempts === 0) {
            return {
                ratePercent: null,
                formatted: '---',
                successes: 0,
                attempts: 0
            };
        }
        var successes = this._acquisitions.length;
        var rate = (successes / this._attempts) * 100;
        return {
            ratePercent: Math.min(100, Math.round(rate * 10) / 10),
            formatted: Math.min(100, Math.round(rate * 10) / 10).toFixed(1) + '%',
            successes: successes,
            attempts: this._attempts
        };
    };

    PerformanceMetrics.prototype.getSummary = function() {
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

    LeadLifecycleManager.prototype.getState = function(leadId) {
        var entry = this._states.get(leadId);
        return entry ? entry.state : null;
    };

    LeadLifecycleManager.prototype.transition = function(leadId, newState, meta) {
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

    LeadLifecycleManager.prototype.isInFlight = function(leadId) {
        return this._inFlight.has(leadId);
    };

    LeadLifecycleManager.prototype.getSummary = function() {
        var counts = {};
        this._states.forEach(function(val) {
            counts[val.state] = (counts[val.state] || 0) + 1;
        });
        return {
            totalTracked: this._states.size,
            inFlightCount: this._inFlight.size,
            counts: counts
        };
    };

    // ============================================================
    // ORCHESTRATOR
    // ============================================================
    function Orchestrator() {
        this.logger = new Logger('Orchestrator');
        this.logger.info('🚀 Initializing v6.3.0 (Gravitas Refactor)');

        this.supabase = new window.SupabaseService();
        this.supabase.setLogger(this.logger);

        this.safety = new SafetyController();
        this.stateMachine = new LeadStateMachine();
        this.queue = new LeadQueue();
        this.duplicateManager = new DuplicateManager(this.supabase);
        this.keywordManager = new KeywordManager();
        this.scanner = new Scanner();
        this.parser = new Parser();
        this.popupManager = new PopupManager();
        this.actionAdapter = new ActionAdapter(this.popupManager);
        this.scorer = new LeadScorer();
        this.navigator = new PageNavigator(this);
        this.metrics = new PerformanceMetrics();
        this.lifecycle = new LeadLifecycleManager();

        this.stats = {
            discovered: 0, parsed: 0, validated: 0, scored: 0,
            queued: 0, acquired: 0, rejected: 0, duplicate: 0, failed: 0,
            countryBlocked: 0, unique: 0, filtered: 0, contactFailed: 0,
            dbSynced: 0, popupsHandled: 0, loopsCompleted: 0, loadMoreClicks: 0
        };

        this._uniqueSeenIds = new Set();
        this._isPaused = false;
        this._acquiredLeadIds = new Set();
        this._acquiredRecords = [];
        var selfAcq = this;
        try {
            chrome.storage.local.get(['acquiredLeadIds', 'acquiredRecords'], function(res) {
                if (res && Array.isArray(res.acquiredLeadIds)) {
                    res.acquiredLeadIds.forEach(function(id) { selfAcq._acquiredLeadIds.add(String(id)); });
                }
                if (res && Array.isArray(res.acquiredRecords)) {
                    selfAcq._acquiredRecords = res.acquiredRecords;
                }
                selfAcq.logger.info('Loaded ' + selfAcq._acquiredLeadIds.size + ' previously acquired leads and ' + selfAcq._acquiredRecords.length + ' seller verification records.');
            });
        } catch (e) {}

        this.config = Object.assign({}, DEFAULT_CONFIG);
        this._initialized = false;
        this._statsTimer = null;
        this._cleanupTimer = null;
        this._statusPanelTimer = null;
                        this._supabaseEnabled = true;
        this._initTime = Date.now();
        this._syncRetryAttempt = 0;
        this._syncRetryNextAt = 0;

        var self = this;
        this._loadConfig().then(function() { self._init(); });
    }

    Orchestrator.prototype._loadConfig = function() {
        var self = this;
        return new Promise(function(resolve) {
            chrome.storage.local.get(DEFAULT_CONFIG, function(c) {
                self.config = Object.assign({}, DEFAULT_CONFIG, c);
                if (c.scoreWeights)   self.config.scoreWeights   = Object.assign({}, DEFAULT_CONFIG.scoreWeights,   c.scoreWeights);
                if (c.scorePenalties) self.config.scorePenalties = Object.assign({}, DEFAULT_CONFIG.scorePenalties, c.scorePenalties);

                self.config.strictCountryMode = self.config.strictCountryMode === true;
                self.config.allowedCountries = (self.config.allowedCountries || ['IN']).map(function(x) {
                    return String(x).toUpperCase().trim();
                }).filter(function(x) { return x; });
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
                    perMinute:  self.config.maxPerMinute,
                    perHour:    self.config.maxPerHour,
                    perDay:     self.config.maxPerDay,
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

                self.navigator.applySettings(self.config);
                self.keywordManager.setSupabaseEnabled(self._supabaseEnabled);

                resolve();
            });
        });
    };
        Orchestrator.prototype._init = function() {
    var self = this;
    this._injectPanelStyles();
    this.logger.info('Mode: ' + this.config.mode);
        this.logger.info('Supabase mode: ' + (this._supabaseEnabled ? 'ON' : 'OFF'));
        if (this.config.strictCountryMode) {
            this.logger.info('🌍 STRICT COUNTRY ON — allowed: ' + this.config.allowedCountries.join(', '));
        }

        this.duplicateManager.clear();

                this.keywordManager.loadKeywords().then(function() {
            // Setup UI + periodic tasks IMMEDIATELY so panel shows during retries
            self.queue.setProcessor(function(lead) { return self._processLead(lead); });
            self._startPeriodicTasks();
            self._setupUI();
            self._broadcastStatus();

            // Now wait for Supabase filters (with retry) before starting scanner
            if (self._supabaseEnabled) {
                return self._syncSupabaseKeywords();
            }
            return Promise.resolve();
        }).then(function() {
            self.scanner.startWatching(function(cards) { self._onCardsDetected(cards); });

            if (self.config.autoScroll) self.navigator.start();

            self._initialized = true;
            self.logger.info('✅ Ready — scanner started after filters loaded');
            self._broadcastStatus();
        });
    };

               Orchestrator.prototype._syncSupabaseKeywords = function(retryAttempt) {
        var self = this;
        retryAttempt = retryAttempt || 0;
        var MAX_RETRIES = 5;
        var DELAYS_MS = [2000, 5000, 15000, 30000, 60000];

        if (retryAttempt === 0) {
            this.logger.info('🔄 Syncing keywords from Supabase...');
        } else {
            this.logger.info('🔄 Retry ' + retryAttempt + '/' + MAX_RETRIES + ' — syncing keywords from Supabase...');
        }

        return this.supabase.loadFilters(false).then(function(success) {
            if (!success) {
                throw new Error('Supabase fetch failed (network/server)');
            }

            var filtersArray = self.supabase.getFilters();
            self.logger.info('📥 Loaded ' + filtersArray.length + ' filters');
            self.keywordManager.extractFromSupabaseFilters(filtersArray);
            self.supabase.updateFilterStatus(true);

            // Success — clear retry state
            self._syncRetryAttempt = 0;
            self._syncRetryNextAt = 0;

            return self.duplicateManager.loadFromDb();
        }).then(function() {
            
            self._broadcastStatus();
        }).catch(function(err) {
            self.logger.error('❌ Sync failed: ' + err.message);

            // Schedule retry (only if Supabase still enabled)
            if (retryAttempt < MAX_RETRIES && self._supabaseEnabled) {
                var delay = DELAYS_MS[retryAttempt] || DELAYS_MS[DELAYS_MS.length - 1];
                self._syncRetryAttempt = retryAttempt + 1;
                self._syncRetryNextAt = Date.now() + delay;
                self.logger.warn('⏳ Retry ' + (retryAttempt + 1) + '/' + MAX_RETRIES + ' in ' + Math.round(delay / 1000) + 's');
                self._broadcastStatus();

                return new Promise(function(resolve) {
                    setTimeout(function() {
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
          Orchestrator.prototype._injectPanelStyles = function() {
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
                gap: 5px;
                font-size: 11px;
                line-height: 1.4;
                white-space: nowrap;
            }
            .bl-stat-group {
                display: inline-flex;
                align-items: center;
                gap: 3px;
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
            .bl-ctrl-row { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; padding: 4px 0; }
            .bl-ctrl-btn {
                font-size: 10px; font-weight: 700; padding: 4px 8px; border-radius: 4px;
                border: none; cursor: pointer; transition: all 0.15s ease; line-height: 1.4;
            }
            .bl-ctrl-stop   { background: #ef4444; color: #fff; }
            .bl-ctrl-stop:hover { background: #dc2626; }
            .bl-ctrl-resume { background: #22c55e; color: #fff; }
            .bl-ctrl-resume:hover { background: #16a34a; }
            .bl-ctrl-refresh {
                background: #eff6ff !important;
                color: #2563eb !important;
                border: 1px solid #bfdbfe !important;
            }
            .bl-ctrl-refresh:hover {
                background: #dbeafe !important;
                color: #1d4ed8 !important;
            }
            .bl-ctrl-filters {
                background: #18181b !important;
                color: #ffffff !important;
                border: 1px solid #27272a !important;
                display: inline-flex !important;
                align-items: center !important;
                gap: 4px !important;
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
            }

            /* Performance metrics cards below Resume */
            .bl-metrics-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 5px;
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
    Orchestrator.prototype._startPeriodicTasks = function() {
        var self = this;
        this._statsTimer = setInterval(function() {
            if (self._supabaseEnabled) {
                self.supabase.updateFilterStats(self.stats.discovered, self.stats.acquired, self.stats.acquired);
            }
        }, 30000);
        this._cleanupTimer = setInterval(function() { self.duplicateManager.cleanup(); }, 120000);

        // Check for dynamic filter changes from Supabase every 3.5s while scanning
        this._filterWatchTimer = setInterval(function() {
            if (!self._isPaused) {
                self._checkDynamicFilterChanges();
            }
        }, 1200);
    };

        Orchestrator.prototype._setupUI = function() {
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
        try { iconUrl = chrome.runtime.getURL('plugin.png'); } catch (e) {}

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
                '<div class="bl-row"><span id="bl-country-text" class="bl-dim">Any country</span></div>' +
                '<div class="bl-row"><span id="bl-rate-text" class="bl-dim">0/60 min</span></div>' +
                '<div class="bl-row"><span id="bl-kw-text" class="bl-dim">KW: 0</span></div>' +
                '<div class="bl-row"><span id="bl-queue-text" class="bl-dim">Queue: 0</span></div>' +
                '<div class="bl-row bl-ctrl-row">' +
                    '<button id="bl-stop-btn" class="bl-ctrl-btn bl-ctrl-stop" type="button">⏸ Pause</button>' +
                    '<button id="bl-resume-btn" class="bl-ctrl-btn bl-ctrl-resume" type="button" style="display:none">▶ Resume</button>' +
                    '<button id="bl-refresh-btn" class="bl-ctrl-btn bl-ctrl-refresh" type="button" title="Restart scan from top without reloading webpage">🔄 Refresh</button>' +
                    '<button id="bl-filters-btn" class="bl-ctrl-btn bl-ctrl-filters" type="button" title="Open CRM Filters">⚡ Filters (<span id="bl-filters-count">0</span>)</button>' +
                '</div>' +
                '<div class="bl-row bl-metrics-row">' +
                    '<div class="bl-metric-card" title="Average elapsed time between lead detection and verified acquisition">' +
                        '<span class="bl-metric-label">Acq Speed:</span>' +
                        '<span id="bl-stat-speed" class="bl-metric-val">---</span>' +
                    '</div>' +
                    '<div class="bl-metric-card" title="Verified successful acquisitions divided by eligible acquisition attempts">' +
                        '<span class="bl-metric-label">Acceptance:</span>' +
                        '<span id="bl-stat-acceptance" class="bl-metric-val">---</span>' +
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
            toggleBtn.addEventListener('click', function(e) {
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
            stopSoldBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                var current = self.config.stopSold !== false;
                self.setStopSold(!current);
            });
        }

        // ── Stop / Resume buttons ──
        var stopBtn   = document.getElementById('bl-stop-btn');
        var resumeBtn = document.getElementById('bl-resume-btn');
        if (stopBtn) {
            stopBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                self.emergencyStop();
            });
        }
        if (resumeBtn) {
            resumeBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                self.resume();
            });
        }

        // ── Refresh scan button ──
        var refreshBtn = document.getElementById('bl-refresh-btn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                if (e.shiftKey) {
                    self.showTopToast('refresh', 'Reloading Webpage', 'Full portal reload with automatic scan resume...', 2000);
                    sessionStorage.setItem('bl_last_reload_flag', 'from_reload');
                    setTimeout(function() { window.location.reload(); }, 200);
                    return;
                }
                self.restartScan();
            });
            refreshBtn.addEventListener('dblclick', function(e) {
                e.stopPropagation();
                self.showTopToast('refresh', 'Reloading Webpage', 'Full portal reload with automatic scan resume...', 2000);
                sessionStorage.setItem('bl_last_reload_flag', 'from_reload');
                setTimeout(function() { window.location.reload(); }, 200);
            });
        }

        // ── Filters CRM button ──
        var filtersBtn = document.getElementById('bl-filters-btn');
        if (filtersBtn) {
            filtersBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                var crmFiltersUrl = 'https://ind-prtx-test.vercel.app/filters';
                try {
                    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
                        chrome.runtime.sendMessage({ action: 'OPEN_TAB', url: crmFiltersUrl }, function() {
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

        window.addEventListener('resize', function() { self._keepPanelInView(); });
        this._startStatusUpdates();
    };

    Orchestrator.prototype._setPanelCollapsed = function(c) {
        var body = document.getElementById('bl-panel-body');
        var btn  = document.getElementById('bl-panel-toggle');
        if (!body || !btn) return;
        body.style.display = c ? 'none' : 'block';
        btn.textContent = c ? '+' : '−';
        this._panelCollapsed = c;
    };

    Orchestrator.prototype._setupDrag = function(panel) {
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
            raf = requestAnimationFrame(function() { panel.style.left = nl + 'px'; panel.style.top = nt + 'px'; });
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

    Orchestrator.prototype._keepPanelInView = function() {
        if (!this._safetyPanel) return;
        var r = this._safetyPanel.getBoundingClientRect();
        var nl = Math.max(0, Math.min(r.left, window.innerWidth - r.width));
        var nt = Math.max(0, Math.min(r.top, window.innerHeight - r.height));
        if (nl !== r.left || nt !== r.top) {
            this._safetyPanel.style.left = nl + 'px';
            this._safetyPanel.style.top  = nt + 'px';
        }
    };

    Orchestrator.prototype._startStatusUpdates = function() {
        var self = this;
        this._statusPanelTimer = setInterval(function() {
            var s = self.safety.getStatus();
            if (!self._safetyPanel) return;
            var dot = document.getElementById('bl-status-dot');
            var text = document.getElementById('bl-status-text');
            var statsScanned = document.getElementById('bl-stat-scanned');
            var statsAcquired = document.getElementById('bl-stat-acquired');
            var conn = document.getElementById('bl-connection-text');
            var countryEl = document.getElementById('bl-country-text');
            var rateEl = document.getElementById('bl-rate-text');
            var kwEl = document.getElementById('bl-kw-text');
            var qEl  = document.getElementById('bl-queue-text');

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
            if (statsScanned)  statsScanned.textContent  = self.stats.unique || self.stats.discovered;
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
            if (countryEl) {
                if (self.config.strictCountryMode) {
                    countryEl.textContent = '🌍 STRICT: ' + (self.config.allowedCountries.join(', ') || '—');
                    countryEl.style.color = '#02A699';
                    countryEl.style.fontWeight = '700';
                } else {
                    countryEl.textContent = '🌍 Any country';
                    countryEl.style.color = '#999';
                    countryEl.style.fontWeight = '400';
                }
            }
            if (rateEl) {
                var c = s.counters;
                var lim = s.limits;
                rateEl.textContent = '📊 ' + c.minute + '/' + lim.perMinute + ' min | ' + c.hour + '/' + lim.perHour + ' hr';
                var nearLimit = (c.minute >= lim.perMinute) || (c.hour >= lim.perHour);
                rateEl.style.color = nearLimit ? '#f5a623' : '#999';
                rateEl.style.fontWeight = nearLimit ? '700' : '400';
            }
            if (kwEl) {
                var k2 = self.keywordManager.getAllKeywords();
                kwEl.textContent = 'KW: P' + k2.product.length + ' N' + k2.negative.length + ' R' + k2.required.length;
            }
            if (qEl) {
                var q = self.queue.getStatus();
                qEl.textContent = 'Queue: ' + q.size + (q.processing ? ' (1 active)' : '');
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
    // STRICT COUNTRY
    // ============================================================
    Orchestrator.prototype._checkStrictCountry = function(lead) {
        // When Supabase filters are active, country restrictions are dynamically enforced per filter
        // (allows leads from any country when no country filter is specified in that filter)
        if (this._supabaseEnabled) {
            return { allowed: true };
        }
        if (!this.config.strictCountryMode) return { allowed: true };
        var allowed = (this.config.allowedCountries || []).map(function(c) {
            return String(c).toUpperCase().trim();
        }).filter(function(c) { return c.length > 0; });

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
    // CARD PROCESSING — v6.2 pipeline
    // ============================================================
    Orchestrator.prototype._onCardsDetected = function(cards) {
        var self = this;
        this.logger.info('📋 Processing ' + cards.length + ' new cards');

        var kws = this.keywordManager.getAllKeywords();
        this.logger.info('Keywords: P=' + kws.product.length + ' N=' + kws.negative.length + ' R=' + kws.required.length);

        for (var i = 0; i < cards.length; i++) {
            try {
                var card = cards[i];
                var raw = self.parser.parseCard(card.element, card.id);
                if (!raw) { self.stats.failed++; continue; }
                var lead = self.parser.normalize(raw);
                if (!lead) { self.stats.failed++; continue; }

                self.stats.discovered++;
                if (self.metrics) self.metrics.recordDetection(card.id, Date.now());
                if (self.lifecycle) self.lifecycle.transition(card.id, 'DETECTED');

                // === STEP 0: EXCLUDE ALREADY ACQUIRED LEADS (SELLER-DISTINCT DUPLICATE CHECK) ===
                // Only leads that were PREVIOUSLY ACQUIRED with the SAME SELLER are treated as duplicates!
                // Unacquired leads are NEVER marked as duplicates and remain eligible on rescans.
                if (self._isLeadAcquired(lead, card)) {
                    self.stats.duplicate++;
                    self.logger.debug('🔒 Acquired lead excluded (same seller duplicate): ' + card.id + ' | "' + (lead.productName || '') + '"');
                    continue;
                }

                // === STEP 0.1: STOP SOLD CHECK ===
                // When Stop Sold is enabled (default: true), stop or exclude sold-out leads.
                // When disabled, this restriction is not applied and eligible leads continue.
                if (self.config.stopSold !== false && self._isLeadSoldOut(lead, card)) {
                    self.stats.rejected++;
                    if (self.lifecycle) self.lifecycle.transition(card.id, 'SKIPPED', { reason: 'sold_out' });
                    self.logger.info('🛑 Sold-out lead skipped (Stop Sold enabled): ' + card.id + ' | "' + (lead.productName || '') + '"');
                    continue;
                }

                // === STEP 0.5: STRICT COUNTRY CHECK (Only when strict country mode is explicitly enabled) ===
                var countryCheck = self._checkStrictCountry(lead);
                if (!countryCheck.allowed) {
                    self.stats.countryBlocked++;
                    self.logger.info('🌍 COUNTRY BLOCK [' + countryCheck.reason + ']: ' + card.id + ' | got=' + (lead.countryIso || 'unknown'));
                    continue;
                }

                // === STEP 2: FILTER MATCH ===
                // If Supabase is enabled but filters not yet loaded, skip this card (retry after load)
                if (self._supabaseEnabled && !self.supabase._filtersLoaded) {
                    self.logger.debug('⏳ Filters not loaded yet, skipping: ' + card.id);
                    continue;
                }
                var kw = self._supabaseEnabled
                    ? self.keywordManager.evaluateFilters(lead)
                    : self.keywordManager.checkKeywords(lead.productName, lead.messageText);
                if (!kw.passed) {
                    self.stats.rejected++;
                    self.logger.debug('❌ Filter [' + kw.reason + ']: ' + card.id + ' | "' + (lead.productName || '').substring(0, 60) + '"');
                    // NOTE: Do NOT markSeen() in duplicateManager — unacquired leads must remain available for rescan!
                    continue;
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
                    // Do NOT mark seen — will retry when safety allows
                    continue;
                }

                                // === STEP 5: ENQUEUE ===
                self.duplicateManager.markSeen(lead.uniqueQueryId);
                                var enqueued = self.queue.enqueue(lead);
                if (enqueued) {
                    self.stats.queued++;
                    self.logger.info('✅ Queued ' + card.id + ' (match=' + (kw.matchedProducts || []).join(',') + ')');
                }
                if (self._supabaseEnabled) self._saveLeadToDb(lead, true);
            } catch (e) {
                self.stats.failed++;
                this.logger.error('❌ Card error: ' + e.message + ' | ' + (cards[i] && cards[i].id));
            }
        }
    };

    Orchestrator.prototype._saveLeadToDb = function(lead, isMatched) {
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
        }).then(function(dbLead) {
            if (dbLead) {
                self.stats.dbSynced++;
                lead._dbId = dbLead.id || (dbLead.data && dbLead.data.id);
                if (dbLead.conflict && dbLead.existingId) lead._dbId = dbLead.existingId;
            }
            return dbLead;
        }).catch(function(err) {
            self.logger.error('Failed to save lead: ' + (err && err.message));
            return null;
        });
        return lead._savePromise;
    };

    Orchestrator.prototype._processLead = function(lead) {
        var self = this;
        return new Promise(function(resolve) {
            self.stateMachine.setState(lead.leadId, 'PROCESSING');

            var safety = self.safety.canAcquire();
            if (!safety.allowed) { resolve(); return; }
            if (self.config.mode === 'MONITOR') { self.stateMachine.setState(lead.leadId, 'MONITORED'); resolve(); return; }
            if (self.config.mode === 'ASSISTED') {
                self.stateMachine.setState(lead.leadId, 'AWAITING_APPROVAL');
                self._showApprovalUI(lead);
                resolve();
                return;
            }

            if (self.lifecycle) self.lifecycle.transition(lead.leadId, 'ACQUISITION_PENDING');
            if (self.metrics) self.metrics.recordAcquisitionAttempt(lead.leadId);

            if (self.showTopToast) {
                self.showTopToast('acquiring', 'Acquiring Lead', 'Contacting buyer for: ' + (lead.productName || 'Lead'));
            }
            self.actionAdapter.acquire(lead).then(function(result) {
                var isSuccess = result && result.success === true;
                if (isSuccess) {
                    self.stats.acquired++;
                    self.stateMachine.setState(lead.leadId, 'ACQUIRED');
                    if (self.lifecycle) self.lifecycle.transition(lead.leadId, 'ACQUIRED');
                    if (self.metrics) self.metrics.recordAcquisitionSuccess(lead.leadId, Date.now());
                    self.safety.recordAcquisition();
                    if (result.popup && result.popup.success) self.stats.popupsHandled++;
                    self.logger.info('🎉 ACQUIRED', { leadId: lead.leadId });
                    self._recordLeadAcquired(lead);

                    if (self.lifecycle) self.lifecycle.transition(lead.leadId, 'CONTACT_PENDING');

                    if (self.showTopToast) {
                        self.showTopToast('contacted', 'Lead Acquired & Contacted', (lead.productName || 'Lead') + ' (' + (lead.senderMobile || 'Contacted') + ')', 2000);
                    }

                    if (self.lifecycle) self.lifecycle.transition(lead.leadId, 'CONTACTED');
                    if (self.metrics) self.metrics.recordContactSuccess(lead.leadId, Date.now());

                    if (self._supabaseEnabled) {
                        var savePromise = lead._savePromise || self._saveLeadToDb(lead, true);
                        Promise.resolve(savePromise).then(function() {
                            return self.supabase.markLeadContacted(lead._dbId || lead.uniqueQueryId);
                        }).then(function() {
                            if (lead._dbId) {
                                return self.supabase.insertLeadHistory(lead._dbId, 'CONTACTED', { score: 'auto', mode: self.config.mode }, new Date().toISOString());
                            }
                        }).catch(function(err) {
                            self.logger.warn('Failed to update lead contacted status', { error: err && err.message });
                        });
                    }
                } else if (result && result.simulated) {
                    self.stateMachine.setState(lead.leadId, 'DRY_RUN');
                } else {
                    self.stats.failed++;
                    var errMsg = (result && result.message) || 'Acquisition failed';
                    self.stateMachine.setState(lead.leadId, 'FAILED', { error: errMsg });
                    if (self.lifecycle) self.lifecycle.transition(lead.leadId, 'ACQUISITION_FAILED');
                    if (self.metrics) self.metrics.recordAcquisitionFailure(lead.leadId, errMsg);
                    self.logger.error('❌ Failed: ' + errMsg, { leadId: lead.leadId });
                    if (self.showTopToast) {
                        self.showTopToast('failed', 'Contact Dropped / Failed', (lead.productName || 'Lead') + ' — ' + errMsg);
                    }
                }
                self._broadcastStatus();
                resolve();
            });
        });
    };

        Orchestrator.prototype._showApprovalUI = function(lead) {
        var existing = document.getElementById('bl_approval_' + lead.leadId);
        if (existing) existing.remove();
        var iconUrl = '';
        try { iconUrl = chrome.runtime.getURL('plugin.png'); } catch (e) {}

        var card = document.createElement('div');
        card.id = 'bl_approval_' + lead.leadId;
        card.className = 'bl-approval';

        var countryFlag = '';
        if (lead.countryIso && lead.countryIso.length === 2) {
            try {
                var codePoints = lead.countryIso.toUpperCase().split('').map(function(c) { return 127397 + c.charCodeAt(0); });
                countryFlag = String.fromCodePoint.apply(null, codePoints);
            } catch (e) {}
        }

        card.innerHTML =
            '<div class="bl-approval-header">' +
                (iconUrl ? '<img src="' + iconUrl + '" alt="logo" />' : '') +
                '<span class="bl-approval-badge">' +
                    '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>' +
                    'Lead Ready' +
                '</span>' +
            '</div>' +
            '<div class="bl-approval-product">' + this._esc(lead.productName) + '</div>' +
            '<div class="bl-approval-country">' + (countryFlag ? countryFlag + ' ' : '') + this._esc(lead.countryIso || 'Unknown') + '</div>' +
            '<div class="bl-approval-actions">' +
                '<button class="bl-btn bl-btn-acquire" type="button" data-a="acq">' +
                    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' +
                    'Acquire' +
                '</button>' +
                '<button class="bl-btn bl-btn-skip" type="button" data-a="skip">' +
                    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg>' +
                    'Skip' +
                '</button>' +
            '</div>';

        document.body.appendChild(card);

        var self = this;
        card.querySelector('[data-a="acq"]').addEventListener('click', function() {
            self.actionAdapter.acquire(lead).then(function(r) {
                if (r.success) {
                    self.stats.acquired++;
                    self.stateMachine.setState(lead.leadId, 'ACQUIRED');
                    self._recordLeadAcquired(lead);
                    if (self.showTopToast) {
                        self.showTopToast('contacted', 'Lead Acquired & Contacted', (lead.productName || 'Lead') + ' (' + (lead.senderMobile || 'Contacted') + ')', 2000);
                    }
                }
            });
            card.remove();
        });
        card.querySelector('[data-a="skip"]').addEventListener('click', function() {
            self.stateMachine.setState(lead.leadId, 'SKIPPED');
            card.remove();
        });
    };

    Orchestrator.prototype._esc = function(t) { if (!t) return ''; var d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
        Orchestrator.prototype._broadcastStatus = function() {
        try {
            var p = chrome.runtime.sendMessage({ action: 'UPDATE_STATUS', status: this.getStatus() });
            if (p && typeof p.catch === 'function') p.catch(function() {});
        } catch (e) {}
    };

    Orchestrator.prototype.updateFullConfig = function(newConfig) {
        var merged = Object.assign({}, DEFAULT_CONFIG, newConfig || {});
        if (newConfig && newConfig.scoreWeights)   merged.scoreWeights   = Object.assign({}, DEFAULT_CONFIG.scoreWeights,   newConfig.scoreWeights);
        if (newConfig && newConfig.scorePenalties) merged.scorePenalties = Object.assign({}, DEFAULT_CONFIG.scorePenalties, newConfig.scorePenalties);

        merged.strictCountryMode = merged.strictCountryMode === true;
        merged.allowedCountries = (merged.allowedCountries || ['IN']).map(function(x) {
            return String(x).toUpperCase().trim();
        }).filter(function(x) { return x; });
        merged.strictCountryRejectUnknown = merged.strictCountryRejectUnknown !== false;

        this.config = merged;
        chrome.storage.local.set(merged);

        this.safety.setLimits({
            perMinute:  merged.maxPerMinute,
            perHour:    merged.maxPerHour,
            perDay:     merged.maxPerDay,
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
        if (merged.autoScroll && !this.navigator._running) this.navigator.start();
        else if (!merged.autoScroll && this.navigator._running) this.navigator.stop();

        this.logger.info('Config updated. Rate limits: ' + merged.maxPerMinute + '/min, ' + merged.maxPerHour + '/hr');
        this._broadcastStatus();
        return Promise.resolve(true);
    };

    Orchestrator.prototype.setMode = function(m) {
        this.config.mode = m;
        this.safety.setMode(m);
        this.actionAdapter.setDryRun(m === 'DRY_RUN');
        chrome.storage.local.set({ mode: m, userSetMode: true });
        return Promise.resolve(true);
    };
        Orchestrator.prototype.setLimits = function(l) {
        if (l.perMinute)  this.config.maxPerMinute  = l.perMinute;
        if (l.perHour)    this.config.maxPerHour    = l.perHour;
        if (l.perDay)     this.config.maxPerDay     = l.perDay;
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
    Orchestrator.prototype.setMinScore = function(s) { this.config.minScore = s; this.scorer.setMinimumScore(s); chrome.storage.local.set({ minScore: s }); };
    Orchestrator.prototype.setAutoMinimize = function(v) { this.config.autoMinimize = v; this.actionAdapter.setAutoMinimize(v); chrome.storage.local.set({ autoMinimize: v }); };
    Orchestrator.prototype.setConfirmationAnswer = function(a) { this.config.confirmationAnswer = a; this.actionAdapter.setConfirmationAnswer(a); chrome.storage.local.set({ confirmationAnswer: a }); };
    Orchestrator.prototype.setPurchaseAction = function(a) { this.config.purchaseAction = a; this.actionAdapter.setPurchaseAction(a); chrome.storage.local.set({ purchaseAction: a }); };
    Orchestrator.prototype.setStopSold = function(enabled) {
        var val = !!enabled;
        this.config.stopSold = val;
        this.config.skipSoldOut = val;
        this.logger.info('🛑 Stop Sold setting updated: ' + (val ? 'ENABLED' : 'DISABLED'));
        chrome.storage.local.set({ stopSold: val, skipSoldOut: val });
        this._updateStopSoldUI();
        return Promise.resolve(val);
    };

    Orchestrator.prototype._updateStopSoldUI = function() {
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

    Orchestrator.prototype._isLeadSoldOut = function(lead, card) {
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
        } catch (e) {}

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
        } catch (e) {}

        return false;
    };

    // ============================================================
    // TOP-CENTER LIVE TELEMETRY TOASTS
    // ============================================================
    Orchestrator.prototype._ensureToastContainer = function() {
        var c = document.getElementById('bl-toast-container');
        if (!c) {
            c = document.createElement('div');
            c.id = 'bl-toast-container';
            document.body.appendChild(c);
        }
        return c;
    };

    Orchestrator.prototype.showTopToast = function(type, title, message, durationMs) {
        try {
            var container = this._ensureToastContainer();
            var toast = document.createElement('div');
            toast.className = 'bl-top-toast bl-toast-' + (type || 'info');

            var iconMap = {
                'found': '🔍',
                'acquiring': '⚡',
                'contacted': '✅',
                'failed': '⚠️',
                'refresh': '🔄',
                'info': '⏳'
            };
            var icon = iconMap[type] || '🔔';

            toast.innerHTML =
                '<span class="bl-toast-icon">' + icon + '</span>' +
                '<div class="bl-toast-content">' +
                    '<div class="bl-toast-title">' + (title || 'Update') + '</div>' +
                    '<div class="bl-toast-message">' + (message || '') + '</div>' +
                '</div>';

            container.appendChild(toast);

            var timeout = durationMs || 2000;
            setTimeout(function() {
                toast.classList.add('bl-toast-leave');
                setTimeout(function() {
                    if (toast.parentNode) toast.parentNode.removeChild(toast);
                }, 300);
            }, timeout);
        } catch (e) {}
    };

    // ============================================================
    // UNMATCHED PRODUCTS TRACKING
    // ============================================================
    Orchestrator.prototype._recordLeadAcquired = function(lead) {
        if (!lead) return;
        var qid = lead.uniqueQueryId || lead.leadId;
        if (qid) this._acquiredLeadIds.add(String(qid));
        if (lead.leadId) this._acquiredLeadIds.add(String(lead.leadId));

        if (!this._acquiredRecords) this._acquiredRecords = [];
        var norm = function(s) { return String(s || '').trim().toLowerCase().replace(/[^\w]/g, '_'); };
        var rec = {
            uniqueQueryId: String(qid || ''),
            leadId: String(lead.leadId || ''),
            productName: norm(lead.productName),
            sellerName: norm(lead.senderName || lead.sellerName),
            phone: String(lead.senderMobile || '').replace(/[^\d]/g, ''),
            location: norm(lead.location),
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
        } catch (e) {}
        this.logger.info('🔒 Lead permanently marked ACQUIRED & ignored for future scans: ' + (qid || lead.productName) + ' [Seller: ' + (lead.senderName || 'unknown') + ']');
    };

    Orchestrator.prototype._isLeadAcquired = function(lead, card) {
        if (!this._acquiredLeadIds) return false;

        // 1. Check card DOM element directly for contacted indicators
        if (card && card.element) {
            if (card.element.getAttribute('data-leadsync-acquired') === 'true') return true;
            var btn = card.element.querySelector('button, a, [class*="BuyLdC_Cta"], [class*="BuyLdC_btn"], [class*="SLC_FillCTA"]');
            if (btn) {
                if (btn.hasAttribute('disabled') || btn.classList.contains('disabled')) return true;
                var bt = (btn.textContent || '').trim().toLowerCase();
                if (bt.indexOf('contacted') !== -1 || bt.indexOf('already contact') !== -1 ||
                    bt.indexOf('acquired') !== -1 || bt.indexOf('message sent') !== -1 ||
                    bt.indexOf('enquiry sent') !== -1 || bt.indexOf('view number') !== -1 ||
                    bt.indexOf('view contact') !== -1) {
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
                var norm = function(s) { return String(s || '').trim().toLowerCase().replace(/[^\w]/g, '_'); };
                var curProd = norm(lead.productName);
                var curSeller = norm(lead.senderName || lead.sellerName);
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

    Orchestrator.prototype._checkDynamicFilterChanges = function() {
        if (!this._supabaseEnabled || !this.supabase) return Promise.resolve(false);
        var self = this;
        return this.supabase.loadFilters(true).then(function(success) {
            if (!success) return false;
            var newFilters = self.supabase.getFilters() || [];
            var newSignature = JSON.stringify(newFilters.map(function(f) {
                return {
                    id: f.id,
                    name: f.name,
                    keywords: f.product_keywords,
                    neg: f.negative_keywords,
                    loc: f.sender_locations,
                    act: f.is_active,
                    mode: f.match_mode,
                    upd: f.updated_at
                };
            }));

            if (self._lastFiltersSignature === undefined) {
                self._lastFiltersSignature = newSignature;
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
                        self._acquiredLeadIds.forEach(function(id) {
                            self.duplicateManager.markSeen(id);
                        });
                    }
                }
                // Reset scanner cache so all unacquired cards in DOM are evaluated against new filters
                if (self.scanner) {
                    self.scanner.resetEmitted();
                    self.scanner._scan();
                }
                return true;
            }
            return false;
        }).catch(function() {
            return false;
        });
    };

    // ============================================================
    // REFRESH SCAN WITHOUT WEBPAGE RELOAD
    // ============================================================
    Orchestrator.prototype.restartScan = function() {
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
                    try { refEl.click(); refreshedInPage = true; } catch(e) {}
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
                    try { tab.click(); refreshedInPage = true; } catch(e) {}
                    break;
                }
            }
        } catch(e) {}

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
                this._acquiredLeadIds.forEach(function(id) { selfDup.markSeen(id); });
            }
        }

        // 4. Reset display counters
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

        // 5. Jump to top instantly (instantaneous, no smooth-scroll delay)
        try {
            window.scrollTo(0, 0);
            window.dispatchEvent(new Event('scroll'));
        } catch (e) {}

        this._isPaused = false;
        this._broadcastStatus();

        var toastMsg = refreshedInPage
            ? 'Portal refreshed & continuous scan restarted from top'
            : 'Continuous scan restarted from top';
        this.showTopToast('refresh', 'Scanner Refreshed', toastMsg, 2000);

        // 6. Force-refresh filters from Supabase in background
        if (this._checkDynamicFilterChanges) {
            this._checkDynamicFilterChanges(true);
        }

        // 7. Restart continuous scanning pass cleanly
        var self = this;
        setTimeout(function() {
            if (self.scanner) {
                self.scanner._scan();
            }
            if (self.navigator) {
                self.navigator.restart();
            }
        }, 200);
    };

    Orchestrator.prototype.setAutoScroll = function(e) {
        this.config.autoScroll = e;
        chrome.storage.local.set({ autoScroll: e });
        if (e) this.navigator.start(); else this.navigator.stop();
    };

    Orchestrator.prototype.setStrictCountry = function(enabled, countries, rejectUnknown) {
        this.config.strictCountryMode = enabled === true;
        if (Array.isArray(countries)) {
            this.config.allowedCountries = countries.map(function(c) { return String(c).toUpperCase().trim(); }).filter(function(c) { return c; });
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

    Orchestrator.prototype.toggleSupabase = function(enabled) {
        var self = this;
        this._supabaseEnabled = enabled;
        this.config.supabaseEnabled = enabled;
        this.keywordManager.setSupabaseEnabled(enabled);
        chrome.storage.local.set({ supabaseEnabled: enabled });
        if (enabled) {
            return this.supabase.loadFilters(true).then(function() {
                var filtersArray = self.supabase.getFilters();
                self.keywordManager.extractFromSupabaseFilters(filtersArray);
                self.supabase.updateFilterStatus(true);
                return self.duplicateManager.loadFromDb();
            }).then(function() { return true; });
        } else {
            this.supabase._filters = [];
            this.supabase._filtersLoaded = false;
            return Promise.resolve(true);
        }
    };

    Orchestrator.prototype.clearLocalDuplicateCache = function() {
        this.duplicateManager.clear();
        return Promise.resolve({ success: true, message: 'Duplicate cache cleared' });
    };

    Orchestrator.prototype.clearAllLocalData = function() {
        var self = this;
        return new Promise(function(resolve) {
            chrome.storage.local.get(['keywords', 'mode', 'supabaseEnabled', 'scoreWeights', 'scorePenalties', 'preferredStates', 'preferredCountries', 'minScore', 'maxPerMinute', 'maxPerHour', 'maxPerDay', 'maxPerSession', 'cooldownMs', 'strictCountryMode', 'allowedCountries', 'strictCountryRejectUnknown'], function(keep) {
                chrome.storage.local.clear(function() {
                    chrome.storage.local.set(keep, function() {
                        self.duplicateManager.clear();
                        resolve({ success: true });
                    });
                });
            });
        });
    };

    Orchestrator.prototype.emergencyStop = function() {
        this._isPaused = true;
        this.safety.emergencyStopFn ? this.safety.emergencyStopFn() : this.safety.emergencyStop();
        if (this.scanner) this.scanner.stopWatching();
        if (this.popupManager) this.popupManager.cancel();
        if (this.navigator) this.navigator.stop();
        if (this._supabaseEnabled) this.supabase.updateFilterStatus(false);
        this.logger.warn('🚨 EMERGENCY STOP ACTIVATED — Scanner & Navigator halted');
        this._broadcastStatus();
        return Promise.resolve(true);
    };

    Orchestrator.prototype.resume = function() {
        this._isPaused = false;
        this.safety.resume();
        var self = this;
        if (this.scanner) {
            this.scanner.startWatching(function(cards) {
                self._onCardsDetected(cards);
            });
            this.scanner._scan();
        }
        if (this.navigator) this.navigator.start();
        if (this._supabaseEnabled) this.supabase.updateFilterStatus(true);
        this.logger.info('▶ RESUMED — Scanner & Navigator active');
        this._broadcastStatus();
        return Promise.resolve(true);
    };

    Orchestrator.prototype.getStatus = function() {
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

    Orchestrator.prototype.shutdown = function() {
        this.scanner.stopWatching();
        this.queue.pause();
        if (this.popupManager) this.popupManager.cancel();
        if (this.navigator) this.navigator.stop();
        if (this._statsTimer) clearInterval(this._statsTimer);
        if (this._cleanupTimer) clearInterval(this._cleanupTimer);
        if (this._statusPanelTimer) clearInterval(this._statusPanelTimer);
        if (this._filterWatchTimer) clearInterval(this._filterWatchTimer);
        if (this._supabaseEnabled) this.supabase.updateFilterStatus(false);
    };

    // ============================================================
    // INIT
    // ============================================================
    if (window.__BUY_LEAD_ASSISTANT_V6__) {
        console.warn('Already initialized');
    } else {
        window.__BUY_LEAD_ASSISTANT_V6__ = true;
        console.log('🚀 IndiaMART BuyLead Assistant v6.2.0');

        try {
            var reloadFlag = sessionStorage.getItem('bl_last_reload_flag');
            if (reloadFlag === 'from_reload') sessionStorage.removeItem('bl_last_reload_flag');
            else sessionStorage.removeItem('bl_auto_reload_count');
        } catch (e) {}
        try { sessionStorage.setItem('bl_last_reload_flag', 'from_reload'); } catch (e) {}

        var orchestrator = new Orchestrator();
        window.orchestrator = orchestrator;

                // Storage-level instant synchronization across popup and portal tabs
        chrome.storage.onChanged.addListener(function(changes, areaName) {
            if (areaName !== 'local') return;
            // Instant real-time microsecond filter update
            if (changes.filters_last_updated || changes.supabase_filters_cache || changes.active_filters) {
                if (orchestrator && orchestrator._checkDynamicFilterChanges) {
                    orchestrator._checkDynamicFilterChanges(true);
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
        chrome.runtime.onMessage.addListener(function(req, sender, sendResponse) {
            switch (req.action) {
                case 'GET_STATUS':              sendResponse(Object.assign({ success: true }, orchestrator.getStatus())); return true;
                case 'GET_CONFIG':              sendResponse({ success: true, config: orchestrator.config }); return true;
                case 'UPDATE_FULL_CONFIG':      orchestrator.updateFullConfig(req.config).then(function() { sendResponse({ success: true }); }); return true;
                case 'SET_MODE':                orchestrator.setMode(req.mode).then(function() { sendResponse({ success: true, mode: req.mode }); }); return true;
                case 'SET_STOP_SOLD':           orchestrator.setStopSold(req.enabled); sendResponse({ success: true }); break;
                case 'SET_LIMITS':              orchestrator.setLimits(req.limits); sendResponse({ success: true }); break;
                case 'SET_MIN_SCORE':           orchestrator.setMinScore(req.score); sendResponse({ success: true }); break;
                case 'SET_AUTO_MINIMIZE':       orchestrator.setAutoMinimize(req.enabled); sendResponse({ success: true }); break;
                case 'SET_CONFIRMATION_ANSWER': orchestrator.setConfirmationAnswer(req.answer); sendResponse({ success: true }); break;
                case 'SET_PURCHASE_ACTION':     orchestrator.setPurchaseAction(req.purchaseAction); sendResponse({ success: true }); break;
                case 'SET_AUTO_SCROLL':         orchestrator.setAutoScroll(req.enabled); sendResponse({ success: true }); break;
                case 'SET_STRICT_COUNTRY':      orchestrator.setStrictCountry(req.enabled, req.countries, req.rejectUnknown).then(function() { sendResponse({ success: true }); }); return true;
                case 'TOGGLE_SUPABASE':         orchestrator.toggleSupabase(req.enabled).then(function() { sendResponse({ success: true }); }); return true;
                case 'EMERGENCY_STOP':          orchestrator.emergencyStop().then(function() { sendResponse({ success: true }); }); return true;
                case 'RESUME':                  orchestrator.resume().then(function() { sendResponse({ success: true }); }); return true;
                case 'UPDATE_KEYWORDS':         orchestrator.keywordManager.updateKeywords(req.keywords).then(function() { sendResponse({ success: true }); }); return true;
                                case 'REFRESH_FILTERS':
                    if (orchestrator._supabaseEnabled) {
                        orchestrator.supabase.loadFilters(true).then(function() {
                            var filtersArray = orchestrator.supabase.getFilters();
                            orchestrator.keywordManager.extractFromSupabaseFilters(filtersArray);
                            orchestrator.duplicateManager.clear();
                            orchestrator.scanner.resetEmitted();
                            sendResponse({ success: true, count: filtersArray.length });
                        });
                    } else sendResponse({ success: false });
                    return true;
                case 'RESET_DUPLICATES':        orchestrator.duplicateManager.clear(); sendResponse({ success: true }); break;
                case 'CLEAR_DUPLICATE_CACHE':   orchestrator.clearLocalDuplicateCache().then(function(r) { sendResponse(r); }); return true;
                case 'CLEAR_ALL_LOCAL_DATA':    orchestrator.clearAllLocalData().then(function(r) { sendResponse(r); }); return true;
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
                case 'GET_LOGS':                chrome.storage.local.get('logs', function(result) { sendResponse(result.logs || []); }); return true;
                case 'CLEAR_LOGS':              chrome.storage.local.set({ logs: [] }, function() { sendResponse({ success: true }); }); return true;
                default:                        sendResponse({ success: false });
            }
            return true;
        });

        console.log('✅ Ready — v6.2.0');
    }

})();