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
        panelCollapsed: false
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
        var dataId = element.getAttribute('data-lead-id');
        if (dataId) return 'dm_' + dataId;
        var id = element.getAttribute('id');
        if (id && id.length > 3) return 'id_' + id;
        var links = element.querySelectorAll('a[href]');
        for (var i = 0; i < links.length; i++) {
            var href = links[i].getAttribute('href') || '';
            var match = href.match(/(?:buyerid|leadid|blid|queryid)[=\/](\d+)/i);
            if (match) return 'lnk_' + match[1];
        }
        // Fall back to product + location hash
        var productEl = element.querySelector('[class*="BuyLdC"] span.SLC_f18, span.SLC_f18');
        var productText = productEl ? productEl.textContent.trim() : '';
        var locEl = element.querySelector('[class*="BuyLdC_time_loc"] strong, [class*="BuyLdC_time_loc"]');
        var locationText = locEl ? locEl.textContent.trim() : '';
        var combined = productText + '|' + locationText;
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
        setTimeout(function() { self._startLoop(); }, 800);
    };

    PageNavigator.prototype.stop = function() {
        this._running = false;
        this._loopInProgress = false;
        if (this._loopTimer) { clearTimeout(this._loopTimer); this._loopTimer = null; }
        this.logger.info('⏹ Bottom-loop navigator stopped');
    };

        PageNavigator.prototype._startLoop = function() {
        var self = this;
        if (!this._running || this._loopInProgress) return;
        this._loopInProgress = true;

        // LIVE MODE: no scroll, no "Show more".
        // Wait for scanner to process top cards, then reload for fresh leads.
        setTimeout(function() {
            if (!self._running) { self._loopInProgress = false; return; }
            self.logger.info('🔄 Live scan wait complete — reloading');
            self._running = false;
            self._loopInProgress = false;
            self.orchestrator.stats.loopsCompleted++;
            if (self._settings.autoReloadOnComplete) self._autoReloadPage();
            else self._showFinalBanner();
        }, self._settings.liveScanWaitMs);
    };

    PageNavigator.prototype._scheduleNextLoop = function() {
        var self = this;
        if (!this._running) return;
        this._loopTimer = setTimeout(function() { self._startLoop(); }, this._settings.loopIntervalMs);
    };

    // Fast scroll: single rAF batch, minimal DOM reads.
    PageNavigator.prototype._fastScrollToBottom = function(done) {
        var self = this;
        var lastY = -1;
        var sameCount = 0;
        var maxSame = 4;

        function step() {
            if (!self._running) { done(); return; }
            var docHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
            var maxY = Math.max(0, docHeight - window.innerHeight);
            var curY = window.scrollY;

            if (curY >= maxY - 5) { done(); return; }

            var newY = Math.min(curY + self._settings.scrollSpeed, maxY);
            try { window.scrollTo(0, newY); } catch (e) {}

            if (Math.abs(newY - lastY) < 5) {
                sameCount++;
                if (sameCount >= maxSame) { done(); return; }
            } else { sameCount = 0; }
            lastY = newY;
            setTimeout(step, self._settings.scrollDelayMs);
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
    // KEYWORD MANAGER — WORD-BOUNDARY MATCHING (v6.2)
    // ============================================================
    function KeywordManager() {
        this.logger = new Logger('KeywordManager');
        this.keywords = { product: [], negative: [], location: [], required: [] };
        this._localKeywords    = { product: [], negative: [], location: [], required: [] };
        this._supabaseKeywords = { product: [], negative: [], location: [], required: [] };
        this._supabaseEnabled = true;
    }

    KeywordManager.prototype.setSupabaseEnabled = function(enabled) {
        this._supabaseEnabled = enabled;
        this._rebuildKeywords();
    };

    KeywordManager.prototype._normalize = function(text) {
        if (!text) return '';
        return String(text)
            .toLowerCase()
            .replace(/[^\w\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    };

    // WORD-BOUNDARY MATCHING
    // Single-word kw: exact token, or token startsWith kw when kw.length >= 4,
    //                 or plural form (kw+s / kw+es).
    // Multi-word kw: every kw token must appear as a token (any order).
    KeywordManager.prototype._textMatches = function(text, keyword) {
        if (!text || !keyword) return false;
        var normText = this._normalize(text);
        var normKw   = this._normalize(keyword);
        if (!normText || !normKw) return false;

        var words  = normText.split(' ').filter(function(w) { return w.length > 0; });
        var kwWords = normKw.split(' ').filter(function(w) { return w.length > 0; });

        if (kwWords.length === 1) {
            var kw = kwWords[0];
            for (var i = 0; i < words.length; i++) {
                var w = words[i];
                if (w === kw) return true;
                if (w === kw + 's' || w === kw + 'es') return true;
                if (kw.length >= 4 && w.length > kw.length && w.indexOf(kw) === 0) return true;
            }
            return false;
        } else {
            for (var k = 0; k < kwWords.length; k++) {
                var found = false;
                for (var j = 0; j < words.length; j++) {
                    var w2 = words[j];
                    if (w2 === kwWords[k]) { found = true; break; }
                    if (w2 === kwWords[k] + 's' || w2 === kwWords[k] + 'es') { found = true; break; }
                    if (kwWords[k].length >= 4 && w2.length > kwWords[k].length && w2.indexOf(kwWords[k]) === 0) { found = true; break; }
                }
                if (!found) return false;
            }
            return true;
        }
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
            return String(t == null ? '' : t).toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
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
                        rules.push({
                id: f.id,
                name: f.filter_name || ('filter_' + f.id),
                keywords:         uniqNorm(cfg.product_names),
                matchMode:        cfg.match_mode === 'all' ? 'all' : 'any',
                negativeKeywords: uniqNorm(cfg.negative_keywords),
                locations: uniqNorm([].concat(
                    Array.isArray(cfg.countries) ? cfg.countries : [],
                    Array.isArray(cfg.states)    ? cfg.states    : [],
                    Array.isArray(cfg.cities)    ? cfg.cities    : []
                )),
                restrictedCountries: uniqNorm(cfg.restricted_countries),
                               requireMobile:   cfg.require_mobile   === true,
                requireWhatsapp: cfg.require_whatsapp === true,
                requireEmail:    cfg.require_email    === true,
                quantityUnit:    typeof cfg.quantity_unit === 'string' ? cfg.quantity_unit.toLowerCase() : '',
                minQuantity:     (typeof cfg.min_quantity === 'number' && cfg.min_quantity > 0) ? cfg.min_quantity : 0,
                _indianStates: INDIAN_STATES
            });
        }
        this._activeFilters = rules;

        // Also keep legacy flat lists for local-mode fallback
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
        this.logger.info('📥 Supabase filters built', { rules: rules.length, product: product.length });
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

        KeywordManager.prototype.evaluateFilters = function(lead) {
        var self = this;
        var rules = this._activeFilters || [];
        if (rules.length === 0) {
            return { passed: false, reason: 'no_active_filter', matchedProducts: [], matchedRequired: [], matchedNegative: [] };
        }

        function normForMatch(t) {
            return String(t == null ? '' : t).toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
        }

        var normProduct = normForMatch(lead.productName || '');
        var rawProduct  = lead.productName || '';
        var contact = lead.contact || {};
        var leadCountryIso = (lead.countryIso || '').toUpperCase().trim();

        // Location parts from lead
        var locParts = [];
        if (lead.city)  locParts.push(normForMatch(lead.city));
        if (lead.state) locParts.push(normForMatch(lead.state));
        if (leadCountryIso === 'IN') locParts.push('india');

        function locationMatches(rule) {
            if (rule.locations.length === 0) return true;
            for (var i = 0; i < rule.locations.length; i++) {
                var entry = rule.locations[i];
                if (entry === 'india') {
                    if (leadCountryIso === 'IN') return true;
                    for (var p = 0; p < locParts.length; p++) {
                        if (rule._indianStates[locParts[p]]) return true;
                    }
                    continue;
                }
                for (var q = 0; q < locParts.length; q++) {
                    if (locParts[q] === entry) return true;
                }
            }
            return false;
        }

        for (var i = 0; i < rules.length; i++) {
            var r = rules[i];

            // 1) NEGATIVE KEYWORDS — agar koi bhi match kare productName se, skip
            if (r.negativeKeywords && r.negativeKeywords.length > 0) {
                var negHit = false;
                for (var ni = 0; ni < r.negativeKeywords.length; ni++) {
                    if (self._textMatches(rawProduct, r.negativeKeywords[ni])) { negHit = true; break; }
                }
                if (negHit) continue;
            }

            // 2) KEYWORD MATCH — word-level, productName ke against
            if (r.keywords.length > 0) {
                var matched = [];
                for (var ki = 0; ki < r.keywords.length; ki++) {
                    if (self._textMatches(rawProduct, r.keywords[ki])) {
                        matched.push(r.keywords[ki]);
                    }
                }
                if (r.matchMode === 'all') {
                    if (matched.length !== r.keywords.length) continue;
                } else {
                    if (matched.length === 0) continue;
                }
            }

            // 3) RESTRICTED COUNTRIES — agar lead ka country restrict list mein hai, skip to remove the country while creating lead
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

            // 4) LOCATION (include list)
            if (!locationMatches(r)) continue;

                        // 5) CONTACT REQUIREMENTS — OR logic
            //    Client ne jo bhi select kiya, un mein se at least 1 lead mein hona chahiye.
            var anyRequired = r.requireMobile || r.requireWhatsapp || r.requireEmail;
            if (anyRequired) {
                var has = false;
                if (r.requireMobile   && contact.mobile) has = true;
                if (r.requireWhatsapp && contact.phone)  has = true;
                if (r.requireEmail    && contact.email)  has = true;
                if (!has) continue;
            }

            // 6) QUANTITY FILTER — only if filter has both unit + minimum
            if (r.quantityUnit && r.minQuantity > 0) {
                var q = lead.quantity;
                if (!q) continue;                           // card mein quantity nahi mili → skip
                if (q.unit !== r.quantityUnit) continue;    // unit mismatch → skip
                if (q.max < r.minQuantity) continue;        // minimum se kam → skip
            }

            // Passed
            return {
                passed: true, reason: null,
                filterId: r.id, filterName: r.name,
                matchedProducts: normProduct ? [normProduct] : [],
                matchedRequired: [], matchedNegative: []
            };
        }

        return { passed: false, reason: 'no_filter_matched', matchedProducts: [], matchedRequired: [], matchedNegative: [] };
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
        // Load contacted + recently rejected leads so re-reloads don't rescans
        return this.supabase.getRecentLeads(500).then(function(leads) {
            var loaded = 0;
            for (var i = 0; i < leads.length; i++) {
                if (leads[i].is_contacted || leads[i].status === 'rejected' || leads[i].status === 'skipped') {
                    self._seen.add(leads[i].unique_query_id);
                    loaded++;
                }
            }
            self._loadedFromDb = true;
            console.log('[Dup] Loaded ' + loaded + ' leads from DB');
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
        this._scanTimer = null;
        this._knownLeads = {};
        this._debounceMs = 60;
        this._fallbackMs = 500;
        this._idGen = new LeadIdGenerator();
        this._scanning = false;
        this._scanPending = false;
    }
    Scanner.prototype.startWatching = function(cb) {
        if (this._running) return;
        this._callback = cb;
        this._running = true;
        var container = document.querySelector('[class*="BuyLdC_cont"]');
        if (!container) { var self = this; setTimeout(function() { self.startWatching(cb); }, 800); return; }
        container = container.parentElement;
        var self2 = this;
        this._observer = new MutationObserver(function() {
            if (self2._scanPending) return;
            self2._scanPending = true;
            setTimeout(function() { self2._scanPending = false; self2._scan(); }, self2._debounceMs);
        });
        this._observer.observe(container, { childList: true, subtree: true });
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
            var cards = document.querySelectorAll('[class*="BuyLdC_cont"]');
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
                if (!currentIds[key] && age > 30000) delete known[key];
                else if (age > 600000) delete known[key];
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
                if (labelText === 'quantity' || labelText === 'qty') {
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
            var productEl = el.querySelector('[class*="BuyLdC"] span.SLC_f18, span.SLC_f18');
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

                                 // --- LOCATION ---
            // India card has TWO <strong> for city/state, PLUS one <strong> for time ("11 hrs ago").
            // Location strongs have a tooltip span (.BuyLdC_tltp); time strong does NOT.
            var locEls = el.querySelectorAll('[class*="BuyLdC_time_loc"] strong');
            var locParts = [];
            for (var li = 0; li < locEls.length; li++) {
                // Skip time strong — it has no tooltip span
                if (!locEls[li].querySelector('.BuyLdC_tltp')) continue;
                var cleaned = cleanRawLocation(locEls[li].textContent);
                if (cleaned) locParts.push(cleaned);
            }
            var location = locParts.length > 0 ? locParts.join(', ') : null;

                        // --- COUNTRY ---
            var countryIso = null;

            // 1) flag alt attribute
            try {
                var flagImg = el.querySelector('img[src*="country-flags"], img[src*="flag"]');
                if (flagImg && flagImg.alt) {
                    var alt = flagImg.alt.trim().toUpperCase();
                    if (/^[A-Z]{2}$/.test(alt)) countryIso = alt;
                }
                // 2) fallback: parse ISO from flag image src (e.g. .../in_flag_s.png → IN)
                if (!countryIso && flagImg && flagImg.src) {
                    var srcMatch = flagImg.src.match(/\/([a-z]{2})_flag[_s]*\.png/i);
                    if (srcMatch) countryIso = srcMatch[1].toUpperCase();
                }
            } catch (e) {}

            // 2) word-boundary match on location
            if (!countryIso && location) {
                var countryMap = {
                    'india': 'IN', 'usa': 'US', 'united states': 'US', 'america': 'US',
                    'united kingdom': 'GB', 'uk': 'GB', 'britain': 'GB',
                    'uae': 'AE', 'united arab emirates': 'AE',
                    'saudi arabia': 'SA', 'russia': 'RU', 'china': 'CN',
                    'australia': 'AU', 'canada': 'CA', 'germany': 'DE', 'france': 'FR',
                    'japan': 'JP', 'brazil': 'BR', 'mexico': 'MX', 'italy': 'IT',
                    'spain': 'ES', 'south korea': 'KR', 'korea': 'KR',
                    'netherlands': 'NL', 'south africa': 'ZA', 'singapore': 'SG',
                    'thailand': 'TH', 'vietnam': 'VN', 'indonesia': 'ID',
                    'malaysia': 'MY', 'philippines': 'PH', 'turkey': 'TR',
                    'egypt': 'EG', 'israel': 'IL', 'pakistan': 'PK',
                    'bangladesh': 'BD', 'sri lanka': 'LK', 'nepal': 'NP'
                };
                var segments = location.toLowerCase().split(',').map(function(s) { return s.trim(); });
                for (var s = 0; s < segments.length; s++) {
                    for (var name in countryMap) {
                        if (segments[s] === name) { countryIso = countryMap[name]; break; }
                    }
                    if (countryIso) break;
                }
            }

            // --- CONTACT AVAILABILITY ---
            var contact = { mobile: null, email: null, phone: null };
            var availSec = el.querySelector('[class*="Available"], [class*="SLC_aifs"]');
            if (availSec) {
                var at = availSec.textContent.toLowerCase();
                if (at.indexOf('mobile') !== -1 || at.indexOf('call') !== -1) contact.mobile = 'available';
                if (at.indexOf('email') !== -1) contact.email = 'available';
                if (at.indexOf('whatsapp') !== -1) contact.phone = 'available';
            }

            // --- MESSAGE TEXT (buyer's requirement only — NOT title) ---
            var messageText = '';
            var msgEl = el.querySelector('[class*="BuyLdC_msg"], [class*="SLC_f14"], [class*="SLC_f13"]');
            if (msgEl) messageText = msgEl.textContent.trim();

            // --- CATEGORY (informational, never matched against) ---
            var mcatEl = el.querySelector('[class*="BuyLdC_mcat"], [class*="mcat"]');
            var mcatName = mcatEl ? mcatEl.textContent.trim() : '';

            // Optional contact detail extraction (mobile numbers, emails)
            var senderMobile = null, senderEmail = null;
            try {
                var textNodes = el.textContent.match(/\+?\d[\d\s\-]{8,}\d/g);
                if (textNodes && textNodes.length) senderMobile = textNodes[0].replace(/\s+/g, '');
                var emails = el.textContent.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
                if (emails && emails.length) senderEmail = emails[0];
            } catch (e) {}

            // --- COMPOSE LEAD ---
            var subject = productName + (location ? ' - ' + location : '');

                        // Build content-based unique ID so position-based card IDs
            // don't collide across sessions (id_BLCard1 today ≠ id_BLCard1 tomorrow)
            var contentKey = leadId + '|' +
                (productName || '').toLowerCase().replace(/[^\w]/g, '_').substring(0, 40) + '|' +
                ((location || '') + '').toLowerCase().replace(/[^\w]/g, '_').substring(0, 30);

            return {
                leadId: leadId,
                uniqueQueryId: contentKey,
                queryType: 'BUY_LEAD',
                queryTime: new Date().toISOString(),

                productName: productName,
                queryProductName: productName,

                messageText: messageText,
                queryMessage: messageText,

                mcatName: mcatName || null,
                queryMcatName: mcatName || null,

                               location: location,
                city: location ? location.split(',')[0].trim() : null,
                state: location ? location.split(',').pop().trim() : null,
                countryIso: countryIso,

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
                var buttons = el.querySelectorAll('button');
                for (var i = 0; i < buttons.length; i++) {
                    var t = buttons[i].textContent || '';
                    if (t.indexOf('Contact Buyer Now') !== -1) { button = buttons[i]; break; }
                }
                if (!button) {
                    for (var j = 0; j < buttons.length; j++) {
                        if ((buttons[j].textContent || '').indexOf('Contact') !== -1) { button = buttons[j]; break; }
                    }
                }
                if (!button) button = el.querySelector('[class*="BuyLdC_btn"], [class*="SLC_FillCTA"]');
                if (!button) { resolve({ success: false, message: 'No button' }); return; }

                self._clicked[lead.leadId] = true;
                button.click();
                log.info('✅ Clicked', { leadId: lead.leadId });

                var start = Date.now();
                var interval = setInterval(function() {
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
                        log.info('⏱️ Popup detected in ' + (Date.now() - start) + 'ms', { leadId: lead.leadId });
                        var text = (popup.textContent || '').toLowerCase();
                        var isPurchase = text.indexOf('purchase buylead') !== -1 ||
                            text.indexOf("to view buyer's contact details") !== -1 ||
                            text.indexOf('per buylead') !== -1 ||
                            (text.indexOf('buy') !== -1 && text.indexOf('₹') !== -1);

                        if (isPurchase) {
                            var closeBtn = popup.querySelector('.SLC_pa.SLC_cp, [class*="SLC_pa"][class*="SLC_cp"]');
                            if (!closeBtn) {
                                var allBtns = popup.querySelectorAll('button, span');
                                for (var b = 0; b < allBtns.length; b++) {
                                    var bt = (allBtns[b].textContent || '').trim();
                                    if (bt === '×' || bt === '✕' || bt === 'X') { closeBtn = allBtns[b]; break; }
                                }
                            }
                            if (closeBtn) { try { closeBtn.click(); } catch(e) {} }
                            document.body.style.overflow = '';
                            resolve({ success: true, action: 'purchase_closed', popup: { success: true } });
                            return;
                        }

                        var confBtns = popup.querySelectorAll('button, [role="button"]');
                        var yesBtn = null;
                        for (var cb = 0; cb < confBtns.length; cb++) {
                            var ct = (confBtns[cb].textContent || '').trim().toLowerCase();
                            if (ct === 'yes' || ct === 'ok' || ct === 'confirm' || ct === 'proceed') { yesBtn = confBtns[cb]; break; }
                        }
                        if (yesBtn) { try { yesBtn.click(); } catch(e) {} }
                        else { try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true })); } catch(e) {} }
                        document.body.style.overflow = '';
                        resolve({ success: true, action: 'confirmed', popup: { success: true } });
                        return;
                    }

                                        if (Date.now() - start > 1000) {
                        clearInterval(interval);
                        resolve({ success: true, action: 'timeout_no_popup', popup: { success: true } });
                    }
                }, 80);

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
    // ORCHESTRATOR
    // ============================================================
    function Orchestrator() {
        this.logger = new Logger('Orchestrator');
        this.logger.info('🚀 Initializing v6.2.0');

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

        this.stats = {
            discovered: 0, parsed: 0, validated: 0, scored: 0,
            queued: 0, acquired: 0, rejected: 0, duplicate: 0, failed: 0,
            countryBlocked: 0,
            dbSynced: 0, popupsHandled: 0, loopsCompleted: 0, loadMoreClicks: 0
        };

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

    Orchestrator.prototype._startPeriodicTasks = function() {
        var self = this;
        this._statsTimer = setInterval(function() {
            if (self._supabaseEnabled) {
                self.supabase.updateFilterStats(self.stats.discovered, self.stats.acquired, self.stats.acquired);
            }
        }, 30000);
        this._cleanupTimer = setInterval(function() { self.duplicateManager.cleanup(); }, 120000);
    };

    Orchestrator.prototype._setupUI = function() {
        var existing = document.getElementById('bl-safety-status');
        if (existing) existing.remove();
        var self = this;
        var panel = document.createElement('div');
        panel.id = 'bl-safety-status';
        var savedPos = this._savedPanelPosition;
        var defaultStyle = 'bottom:20px;left:20px;';
        if (savedPos && savedPos.top !== undefined) {
            var maxX = window.innerWidth - 200, maxY = window.innerHeight - 150;
            defaultStyle = 'top:' + Math.max(0, Math.min(savedPos.top, maxY)) + 'px;left:' + Math.max(0, Math.min(savedPos.left, maxX)) + 'px;';
        }
        panel.style.cssText = 'position:fixed;' + defaultStyle + 'background:#fff;border:2px solid #02A699;border-radius:8px;padding:0;z-index:2147483647;font-family:-apple-system,Arial,sans-serif;font-size:11px;box-shadow:0 4px 16px rgba(0,0,0,0.15);width:250px;user-select:none;overflow:hidden;';
        var iconUrl = '';
        try { iconUrl = chrome.runtime.getURL('plugin.png'); } catch (e) {}
        panel.innerHTML =
            '<div id="bl-panel-header" style="display:flex;align-items:center;gap:6px;padding:8px 10px;background:#02A699;color:#fff;cursor:move;touch-action:none;">' +
                '<div style="width:18px;height:18px;">' + (iconUrl ? '<img src="' + iconUrl + '" style="width:18px;height:18px;object-fit:contain;border-radius:3px;" />' : '🎯') + '</div>' +
                '<span style="font-weight:700;font-size:12px;flex:1;">BuyLead</span>' +
                '<span id="bl-status-dot" style="width:8px;height:8px;border-radius:50%;background:#fff;"></span>' +
                '<button id="bl-panel-toggle" style="background:rgba(255,255,255,0.2);border:none;color:#fff;width:18px;height:18px;border-radius:3px;cursor:pointer;font-size:12px;padding:0;">−</button>' +
            '</div>' +
            '<div id="bl-panel-body" style="padding:8px 10px;">' +
                '<div style="color:#666;font-size:10px;" id="bl-status-text">Init...</div>' +
                '<div style="color:#666;font-size:10px;" id="bl-stats-text">Scanned: 0 | Acquired: 0</div>' +
                '<div style="color:#999;font-size:9px;"  id="bl-connection-text">☁️ CRM</div>' +
                '<div style="color:#999;font-size:9px;"  id="bl-country-text">🌍 Any</div>' +
                '<div style="color:#999;font-size:9px;"  id="bl-rate-text">📊 0/60 min</div>' +
                '<div style="color:#999;font-size:9px;"  id="bl-kw-text">KW: 0</div>' +
                '<div style="color:#999;font-size:9px;"  id="bl-queue-text">Queue: 0</div>' +
                '<div id="bl-warning-text" style="display:none;color:#ef7076;font-size:10px;font-weight:700;padding:4px 6px;background:#2a0e10;border-radius:4px;margin-top:6px;text-align:center;">⚠️ Filters not loaded — acquiring disabled</div>' +
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
            var stats = document.getElementById('bl-stats-text');
            var conn = document.getElementById('bl-connection-text');
            var countryEl = document.getElementById('bl-country-text');
            var rateEl = document.getElementById('bl-rate-text');
            var kwEl = document.getElementById('bl-kw-text');
            var qEl  = document.getElementById('bl-queue-text');

            if (dot) dot.style.background = s.emergencyStop ? '#ef7076' : (s.cooldown ? '#fff5cc' : '#fff');
            if (text) {
                var t = s.mode;
                if (s.emergencyStop) t = '🚨 EMERGENCY';
                else if (s.cooldown) t = '⏳ Cooldown';
                else if (self.navigator._running) t = '▶ Loop Running';
                else if (self.scanner._running) t = '▶ Running';
                else t = '⏹ Stopped';
                text.textContent = t;
            }
            if (stats) stats.textContent = 'Scanned: ' + self.stats.discovered + ' | Acquired: ' + self.stats.acquired;
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
                    warnEl.style.display = 'block';
                } else {
                    warnEl.style.display = 'none';
                }
            }

            self._broadcastStatus();
        }, 800);
    };

    // ============================================================
    // STRICT COUNTRY
    // ============================================================
    Orchestrator.prototype._checkStrictCountry = function(lead) {
        if (!this.config.strictCountryMode) return { allowed: true };
        var allowed = (this.config.allowedCountries || []).map(function(c) {
            return String(c).toUpperCase().trim();
        }).filter(function(c) { return c.length > 0; });

        if (allowed.length === 0) {
            return { allowed: false, reason: 'STRICT_COUNTRY_NO_ALLOWED_LIST', details: { leadCountry: lead.countryIso || null, allowed: [] } };
        }

        var leadCountry = (lead.countryIso || '').toUpperCase().trim();
        if (!leadCountry) {
            if (this.config.strictCountryRejectUnknown) {
                return { allowed: false, reason: 'STRICT_COUNTRY_UNKNOWN', details: { allowed: allowed } };
            }
            this.logger.warn('🌍 UNKNOWN COUNTRY PASSED', { leadId: lead.leadId });
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

                // === STEP 0: STRICT COUNTRY ===
                var countryCheck = self._checkStrictCountry(lead);
                if (!countryCheck.allowed) {
                    self.stats.countryBlocked++;
                    self.logger.info('🌍 COUNTRY BLOCK [' + countryCheck.reason + ']: ' + card.id + ' | got=' + (lead.countryIso || 'unknown'));
                    continue;
                }

                                                // === STEP 1: DUPLICATE ===
                if (self.duplicateManager.isDuplicate(lead.uniqueQueryId)) {
                    self.stats.duplicate++;
                    self.logger.debug('🔁 Duplicate skip: ' + card.id + ' | "' + (lead.productName || '').substring(0, 50) + '"');
                    continue;
                }

                // === STEP 2: FILTER MATCH ===
                // If Supabase is enabled but filters not yet loaded, skip this card (don't mark seen — retry after load)
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
                    self.duplicateManager.markSeen(lead.uniqueQueryId);
                    continue;
                }

                self.stats.validated++;

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
        if (!this._supabaseEnabled) return;
        var self = this;
        this.supabase.insertLead({
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
        }).catch(function() { /* swallow */ });
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

            self.actionAdapter.acquire(lead).then(function(result) {
                var isSuccess = result.success || (result.popup && result.popup.action === 'timeout_no_popup');
                if (isSuccess) {
                    self.stats.acquired++;
                    self.stateMachine.setState(lead.leadId, 'ACQUIRED');
                    self.safety.recordAcquisition();
                    if (result.popup && result.popup.success) self.stats.popupsHandled++;
                    self.logger.info('🎉 ACQUIRED', { leadId: lead.leadId });
                    if (self._supabaseEnabled) {
                        self.supabase.markLeadContacted(lead.uniqueQueryId).catch(function() {});
                        if (lead._dbId) {
                            self.supabase.insertLeadHistory(lead._dbId, 'CONTACTED', { score: 'auto', mode: self.config.mode }, new Date().toISOString()).catch(function() {});
                        }
                    }
                } else if (result.simulated) {
                    self.stateMachine.setState(lead.leadId, 'DRY_RUN');
                } else {
                    self.stats.failed++;
                    self.stateMachine.setState(lead.leadId, 'FAILED', { error: result.message });
                    self.logger.error('❌ Failed: ' + result.message, { leadId: lead.leadId });
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
        card.style.cssText = 'position:fixed;bottom:20px;right:20px;background:white;border:2px solid #02A699;border-radius:8px;padding:15px;max-width:350px;z-index:2147483646;box-shadow:0 4px 20px rgba(0,0,0,0.2);font-family:-apple-system,Arial,sans-serif;';
        card.innerHTML = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' +
            (iconUrl ? '<img src="' + iconUrl + '" style="width:20px;height:20px;object-fit:contain;border-radius:4px;" />' : '') +
            '<span style="font-weight:bold;color:#02A699;">⭐ Lead Ready</span></div>' +
            '<div style="font-size:14px;font-weight:bold;">' + this._esc(lead.productName) + '</div>' +
            '<div style="font-size:11px;color:#666;margin:4px 0;">🌍 ' + this._esc(lead.countryIso || 'Unknown') + '</div>' +
            '<div style="display:flex;gap:8px;margin-top:8px;">' +
            '<button style="flex:1;padding:8px;background:#02A699;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;" data-a="acq">✅ Acquire</button>' +
            '<button style="flex:1;padding:8px;background:#e8ecf1;color:#333;border:none;border-radius:4px;cursor:pointer;font-weight:600;" data-a="skip">✖ Skip</button></div>';
        document.body.appendChild(card);
        var self = this;
        card.querySelector('[data-a="acq"]').addEventListener('click', function() {
            self.actionAdapter.acquire(lead).then(function(r) {
                if (r.success) { self.stats.acquired++; self.stateMachine.setState(lead.leadId, 'ACQUIRED'); }
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
        this.safety.emergencyStopFn();
        if (this.popupManager) this.popupManager.cancel();
        if (this.navigator) this.navigator.stop();
        if (this._supabaseEnabled) this.supabase.updateFilterStatus(false);
        return Promise.resolve(true);
    };
    Orchestrator.prototype.resume = function() {
        this.safety.resume();
        this.queue.resume();
        if (this.config.autoScroll && this.navigator) this.navigator.start();
        if (this._supabaseEnabled) this.supabase.updateFilterStatus(true);
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

        chrome.runtime.onMessage.addListener(function(req, sender, sendResponse) {
            switch (req.action) {
                case 'GET_STATUS':              sendResponse(Object.assign({ success: true }, orchestrator.getStatus())); return true;
                case 'GET_CONFIG':              sendResponse({ success: true, config: orchestrator.config }); return true;
                case 'UPDATE_FULL_CONFIG':      orchestrator.updateFullConfig(req.config).then(function() { sendResponse({ success: true }); }); return true;
                case 'SET_MODE':                orchestrator.setMode(req.mode).then(function() { sendResponse({ success: true, mode: req.mode }); }); return true;
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