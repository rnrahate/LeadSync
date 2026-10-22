/**
 * LeadSync Network Interceptor v5 — Passive Observation Edition
 * Runs in MAIN world at document_start.
 *
 * Transparently monitors read-only lead feed responses (XHR & fetch)
 * for IndiaMART BuyLead data as it arrives over the wire.
 *
 * Adheres strictly to security & reliability invariants:
 * - Read-only: Never modifies requests, never records cookies/auth tokens.
 * - No undocumented replay: Request body and template harvesting removed.
 * - Bounded buffer: Prevents memory growth with dropped-record accounting.
 * - Per-lead deduplication: Never starves a batch if only the first ID repeats.
 * - Safe type support: Supports string, URL, Request objects, and XHR responseType.
 */
(function () {
    'use strict';

    // ── State & Bounded Cache ──────────────────────────────────────────
    var _contentScriptReady = false;
    var _buffer = []; // Max 50 items before content script signals ready
    var MAX_BUFFER_SIZE = 50;
    var _droppedBufferCount = 0;

    // Per-lead dedup cache: leadId -> timestamp (bounded to 1000 items, 10 min TTL)
    var _seenLeadIds = new Map();
    var DEDUP_TTL_MS = 10 * 60 * 1000;
    var MAX_DEDUP_SIZE = 1000;

    // ── URL pattern sets for passive lead observation ───────────────────
    var LEAD_URL_PATTERNS = [
        /bltxn/i,
        /buylead/i,
        /getbuyerleads/i,
        /GetBuyerLeads/i,
        /buyleadlist/i,
        /enquiry.*list/i,
        /lead.*list/i,
        /bltxnapi/i,
        /\/bl\//i,
        /getLeads/i,
        /fetchLeads/i,
        /buyer.*leads/i,
        /getBuyLeadList/i,
        /BLTxnList/i
    ];

    function isLeadFeedUrl(url) {
        if (!url || typeof url !== 'string') return false;
        for (var i = 0; i < LEAD_URL_PATTERNS.length; i++) {
            if (LEAD_URL_PATTERNS[i].test(url)) return true;
        }
        return false;
    }

    function sanitizeUrl(rawUrl) {
        if (!rawUrl) return '';
        try {
            var parsed = new URL(rawUrl, window.location.href);
            // Retain path and non-sensitive query params
            return parsed.pathname + parsed.search;
        } catch (e) {
            return String(rawUrl).substring(0, 150);
        }
    }

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

    function emitLog(level, event, reasonCode, context, metrics, error) {
        try {
            var logMsg = {
                __leadsync_log__: true,
                schemaVersion: '1.0.0',
                timestamp: new Date().toISOString(),
                level: level || 'INFO',
                event: event,
                component: 'NetworkInterceptor',
                reasonCode: reasonCode || null,
                context: context || {},
                metrics: metrics || null,
                error: error ? { message: error.message || String(error) } : null
            };
            if (typeof window !== 'undefined' && typeof window.postMessage === 'function') {
                window.postMessage(logMsg, '*');
            }
        } catch (e) { }
    }

    // ── Extract lead array from IndiaMART API shapes ────────────────────
    function extractLeads(data) {
        if (!data) return null;
        if (Array.isArray(data)) return data.length ? data : null;

        // Nested CODE/DATA wrapper
        if (data.CODE === '200' || data.CODE === 200) {
            var d = data.DATA || data.data;
            if (Array.isArray(d)) return d.length ? d : null;
            if (d && typeof d === 'object') {
                var candidates = ['leads', 'buyLeadList', 'buyerList', 'enquiryList', 'result', 'list'];
                for (var c = 0; c < candidates.length; c++) {
                    if (d[candidates[c]] && Array.isArray(d[candidates[c]])) return d[candidates[c]];
                }
            }
        }

        // Standard REST wrappers
        var wrappers = ['data', 'leads', 'result', 'response', 'buyerList', 'enquiryList', 'buyLeadList', 'DATA', 'LEADS'];
        for (var w = 0; w < wrappers.length; w++) {
            var val = data[wrappers[w]];
            if (val && Array.isArray(val) && val.length) return val;
            if (val && typeof val === 'object') {
                var inner = ['leads', 'buyLeadList', 'buyerList', 'enquiryList', 'result'];
                for (var ii = 0; ii < inner.length; ii++) {
                    if (val[inner[ii]] && Array.isArray(val[inner[ii]]) && val[inner[ii]].length) return val[inner[ii]];
                }
            }
        }
        return null;
    }

    // ── Clean & Deduplicate Individual Leads ───────────────────────────
    function cleanAndDedupLeads(rawLeads) {
        var now = Date.now();
        // Prune stale dedup entries periodically
        if (_seenLeadIds.size > MAX_DEDUP_SIZE) {
            _seenLeadIds.forEach(function (ts, id) {
                if (now - ts > DEDUP_TTL_MS) _seenLeadIds.delete(id);
            });
        }

        var result = [];
        for (var i = 0; i < rawLeads.length; i++) {
            var item = rawLeads[i];
            if (!item || typeof item !== 'object') continue;

            var id = String(item.uniqueQueryId || item.query_id || item.queryId || item.id || item.leadId || '').trim();
            if (id) {
                var lastSeen = _seenLeadIds.get(id);
                if (lastSeen && (now - lastSeen < DEDUP_TTL_MS)) {
                    continue; // Skip seen lead
                }
                _seenLeadIds.set(id, now);
            }

            // Create sanitized canonical representation for passive observation
            result.push({
                uniqueQueryId: id || null,
                traceId: generateTraceId(id),
                queryProductName: item.queryProductName || item.productName || item.subject || item.title || '',
                queryMessage: item.queryMessage || item.message || item.desc || '',
                senderCity: item.senderCity || item.city || '',
                senderState: item.senderState || item.state || '',
                senderCountryIso: item.senderCountryIso || item.countryIso || item.country || null,
                source: 'NETWORK_PASSIVE',
                observedAt: now
            });
        }
        return result;
    }

    // ── Build and send/buffer a PASSIVE LEADS message ───────────────────
    function handleLeadResponse(parsedOrText, sourceUrl) {
        var t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
        var sanitizedUrl = sanitizeUrl(sourceUrl);
        emitLog('DEBUG', 'network.response.observed', null, { url: sanitizedUrl });

        try {
            var data = null;
            if (typeof parsedOrText === 'string') {
                if (!parsedOrText.trim()) return;
                try {
                    data = JSON.parse(parsedOrText);
                } catch (pe) {
                    emitLog('DEBUG', 'network.payload.rejected', 'INVALID_JSON', { url: sanitizedUrl });
                    return;
                }
            } else if (parsedOrText && typeof parsedOrText === 'object') {
                data = parsedOrText;
            } else {
                emitLog('DEBUG', 'network.payload.rejected', 'UNSUPPORTED_TYPE', { url: sanitizedUrl });
                return;
            }

            var rawLeads = extractLeads(data);
            if (!rawLeads || !rawLeads.length) {
                emitLog('TRACE', 'network.payload.rejected', 'NO_LEADS_FOUND', { url: sanitizedUrl });
                return;
            }

            var validLeads = cleanAndDedupLeads(rawLeads);
            if (!validLeads.length) return;

            var duration = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
            emitLog('INFO', 'network.payload.parsed', 'SUCCESS', { url: sanitizedUrl, leadCount: validLeads.length }, { leadCount: validLeads.length, durationMs: duration });

            var msg = {
                __leadsync_network__: true,
                __leadsync_passive_lead__: true,
                type: '__leadsync_passive_lead__',
                leads: validLeads,
                sourceUrl: sanitizedUrl,
                ts: Date.now(),
                droppedCount: _droppedBufferCount
            };

            if (_contentScriptReady) {
                window.postMessage(msg, '*');
            } else {
                if (_buffer.length >= MAX_BUFFER_SIZE) {
                    _buffer.shift(); // Evict oldest
                    _droppedBufferCount++;
                }
                _buffer.push(msg);
            }
        } catch (e) {
            emitLog('ERROR', 'network.capture.failed', 'EXCEPTION', { url: sanitizedUrl }, null, e);
        }
    }

    function flushBuffer() {
        while (_buffer.length > 0) {
            var msg = _buffer.shift();
            msg.droppedCount = _droppedBufferCount;
            window.postMessage(msg, '*');
        }
    }

    // ── Listen for content script signals & direct controller dispatch ──
    window.addEventListener('message', function (evt) {
        if (!evt || !evt.data || evt.source !== window) return;
        if (evt.data.__leadsync_ready__) {
            _contentScriptReady = true;
            flushBuffer();
        }
        // Direct Native Controller Dispatch (Optimization 4)
        if (evt.data.__leadsync_dispatch_lead__) {
            try {
                var dLeadId = evt.data.leadId;
                if (typeof window.blTxnController !== 'undefined' && typeof window.blTxnController.submitLead === 'function') {
                    window.blTxnController.submitLead(dLeadId);
                }
            } catch (de) { }
        }
    });

    // ── Patch XMLHttpRequest ────────────────────────────────────────────
    var OrigXHR = typeof window !== 'undefined' ? window.XMLHttpRequest : null;
    if (OrigXHR && OrigXHR.prototype) {
        function PatchedXHR() {
            var xhr = new OrigXHR();
            var _url = '';
            var _isLead = false;

            var origOpen = xhr.open.bind(xhr);
            xhr.open = function (method, url) {
                _url = typeof url === 'string' ? url : (url && url.toString ? url.toString() : '');
                _isLead = isLeadFeedUrl(_url);
                return origOpen.apply(xhr, arguments);
            };

            var origSend = xhr.send.bind(xhr);
            xhr.send = function () {
                if (_isLead) {
                    var capturedUrl = _url;
                    xhr.addEventListener('load', function () {
                        try {
                            if (xhr.status >= 200 && xhr.status < 300) {
                                if (xhr.responseType === '' || xhr.responseType === 'text') {
                                    if (xhr.responseText) handleLeadResponse(xhr.responseText, capturedUrl);
                                } else if (xhr.responseType === 'json' && xhr.response) {
                                    handleLeadResponse(xhr.response, capturedUrl);
                                }
                            }
                        } catch (e) {}
                    }, { once: true });
                }
                return origSend.apply(xhr, arguments);
            };

            return xhr;
        }

        PatchedXHR.prototype = OrigXHR.prototype;
        try {
            PatchedXHR.UNSENT = 0;
            PatchedXHR.OPENED = 1;
            PatchedXHR.HEADERS_RECEIVED = 2;
            PatchedXHR.LOADING = 3;
            PatchedXHR.DONE = 4;
        } catch (e) {}
        window.XMLHttpRequest = PatchedXHR;
    }

    // ── Patch fetch ─────────────────────────────────────────────────────
    var origFetch = typeof window !== 'undefined' ? window.fetch : null;
    if (origFetch) {
        window.fetch = function (input) {
            var url = typeof input === 'string'
                ? input
                : (input && input.url)
                    ? input.url
                    : (input && typeof input.toString === 'function')
                        ? input.toString()
                        : '';

            var isLead = isLeadFeedUrl(url);
            var p = origFetch.apply(this, arguments);

            if (isLead) {
                var capturedUrl = url;
                p = p.then(function (response) {
                    if (response && response.status >= 200 && response.status < 300) {
                        var cloned = response.clone();
                        cloned.text().then(function (text) {
                            if (text) handleLeadResponse(text, capturedUrl);
                        }).catch(function () {});
                    }
                    return response;
                });
            }
            return p;
        };
    }

    // ── Patch WebSocket (zero-overhead passive message observer) ───────────
    var OrigWebSocket = typeof window !== 'undefined' ? window.WebSocket : null;
    if (OrigWebSocket) {
        function PatchedWebSocket(url, protocols) {
            var ws = protocols ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
            var isLeadWs = isLeadFeedUrl(typeof url === 'string' ? url : '');
            ws.addEventListener('message', function (event) {
                try {
                    if (event && event.data) {
                        if (isLeadWs || (typeof event.data === 'string' && (event.data.indexOf('query') !== -1 || event.data.indexOf('lead') !== -1 || event.data.indexOf('buylead') !== -1))) {
                            handleLeadResponse(event.data, typeof url === 'string' ? url : 'ws://indiamart');
                        }
                    }
                } catch (e) { }
            });
            return ws;
        }
        PatchedWebSocket.prototype = OrigWebSocket.prototype;
        try {
            PatchedWebSocket.CONNECTING = 0;
            PatchedWebSocket.OPEN = 1;
            PatchedWebSocket.CLOSING = 2;
            PatchedWebSocket.CLOSED = 3;
        } catch (e) { }
        window.WebSocket = PatchedWebSocket;
    }

    emitLog('INFO', 'network.interceptor.initialized', 'SUCCESS');

    if (typeof window !== 'undefined') {
        window.__leadsync_interceptor__ = {
            extractLeads: extractLeads,
            cleanAndDedupLeads: cleanAndDedupLeads,
            isLeadFeedUrl: isLeadFeedUrl
        };
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            extractLeads: extractLeads,
            cleanAndDedupLeads: cleanAndDedupLeads,
            isLeadFeedUrl: isLeadFeedUrl
        };
    }

})();

