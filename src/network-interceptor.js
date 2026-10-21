/**
 * LeadSync Network Interceptor v3 — Bot-Speed Edition
 * Runs in MAIN world at document_start.
 *
 * Patches XHR & fetch BEFORE any page JS runs so IndiaMART's BuyLead
 * API responses are captured and forwarded to the content-script the
 * instant they arrive over the wire — before the React/Angular layer
 * even begins diffing the virtual DOM.
 *
 * Also intercepts the "contact buyer" API call to give us instant
 * confirmation that an acquisition succeeded without relying on
 * slow DOM mutation polling.
 */
(function () {
    'use strict';

    // ── State ──────────────────────────────────────────────────────────
    var _contentScriptReady = false;
    var _buffer = [];           // messages queued before content script is ready
    var _seenLeadUrls = {};     // dedup: dedupKey → ts of first send
    var _seenAcqUrls  = {};     // dedup for acquisition confirmations
    var _acqTemplateSent = false; // only send the template once

    // ── URL pattern sets ────────────────────────────────────────────────
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

    // Patterns that indicate an "acquire / contact buyer" API call
    var ACQ_URL_PATTERNS = [
        /contactbuyer/i,
        /contact_buyer/i,
        /acquirelead/i,
        /acquire_lead/i,
        /sendEnquiry/i,
        /send_enquiry/i,
        /blacquire/i,
        /buyerlead.*contact/i,
        /contact.*buylead/i,
        /connectBuyer/i
    ];

    function testPatterns(patterns, url) {
        if (!url) return false;
        for (var i = 0; i < patterns.length; i++) {
            if (patterns[i].test(url)) return true;
        }
        return false;
    }

    // ── Extract a stable dedup key from url + first-lead id ────────────
    function dedupKey(url, firstId) {
        // Strip query string params that change per-poll (timestamp, page)
        var base = (url || '').replace(/[?&](ts|_t|page|pg|offset|rand|_)=[^&]*/gi, '');
        return base + '|' + (firstId || '');
    }

    // ── Extract lead array from any known IndiaMART API shape ───────────
    function extractLeads(data) {
        if (!data) return null;
        // Direct array
        if (Array.isArray(data)) return data.length ? data : null;
        // Nested CODE/DATA wrapper (most common IndiaMART pattern)
        if (data.CODE === '200' || data.CODE === 200) {
            var d = data.DATA || data.data;
            if (Array.isArray(d)) return d.length ? d : null;
            if (d) {
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
            // One level deeper
            if (val && typeof val === 'object') {
                var inner = ['leads', 'buyLeadList', 'buyerList', 'enquiryList', 'result'];
                for (var ii = 0; ii < inner.length; ii++) {
                    if (val[inner[ii]] && Array.isArray(val[inner[ii]]) && val[inner[ii]].length) return val[inner[ii]];
                }
            }
        }
        return null;
    }

    // ── Build and send/buffer a LEADS message ───────────────────────────
    function handleLeadResponse(rawText, sourceUrl) {
        try {
            var data = JSON.parse(rawText);
            var leads = extractLeads(data);
            if (!leads || !leads.length) return;

            // Stable dedup: use first lead's uniqueQueryId so a re-poll
            // of the same batch doesn't create duplicates
            var firstId = leads[0] && (leads[0].uniqueQueryId || leads[0].query_id || leads[0].queryId || leads[0].id || '');
            var key = dedupKey(sourceUrl, firstId);
            var now = Date.now();
            if (_seenLeadUrls[key] && (now - _seenLeadUrls[key]) < 4000) return; // same batch within 4s
            _seenLeadUrls[key] = now;

            var msg = {
                __leadsync_network__: true,
                leads: leads,          // pre-extracted — saves content script work
                payload: data,         // full payload for fallback
                sourceUrl: sourceUrl,
                ts: now
            };

            if (_contentScriptReady) {
                window.postMessage(msg, '*');
            } else {
                _buffer.push(msg);
            }
        } catch (e) {}
    }

    // ── Build and send/buffer an ACQUISITION CONFIRMATION message ───────
    function handleAcqResponse(rawText, sourceUrl) {
        try {
            var data = JSON.parse(rawText);
            // IndiaMART returns CODE:"200" on success, "500"/other on failure
            var ok = data.CODE === '200' || data.CODE === 200
                  || data.code === 200 || data.status === 'success'
                  || data.success === true || data.STATUS === 'SUCCESS';
            var key = sourceUrl + '_acq';
            if (_seenAcqUrls[key]) return;
            _seenAcqUrls[key] = true;
            // Auto-clear after 500ms so the same URL can confirm again next lead
            setTimeout(function () { delete _seenAcqUrls[key]; }, 500);

            var msg = {
                __leadsync_acq_confirm__: true,
                ok: ok,
                code: data.CODE || data.code || '',
                message: data.MESSAGE || data.message || data.msg || '',
                sourceUrl: sourceUrl,
                ts: Date.now()
            };

            if (_contentScriptReady) {
                window.postMessage(msg, '*');
            } else {
                _buffer.push(msg);
            }
        } catch (e) {}
    }

    // ── Build and send/buffer an ACQUISITION TEMPLATE message ──────────
    // Captures the first real acquisition request (body + URL + method) so the
    // content script can replicate it directly for future leads — no DOM click needed.
    function handleAcqTemplate(method, url, body, contentType) {
        if (_acqTemplateSent) return; // only capture once
        _acqTemplateSent = true;
        var msg = {
            __leadsync_acq_template__: true,
            method: method || 'POST',
            url: url,
            body: body || '',
            contentType: contentType || 'application/x-www-form-urlencoded',
            ts: Date.now()
        };
        if (_contentScriptReady) window.postMessage(msg, '*');
        else _buffer.push(msg);
    }


    function flushBuffer() {
        for (var i = 0; i < _buffer.length; i++) {
            window.postMessage(_buffer[i], '*');
        }
        _buffer = [];
    }

    // ── Listen for content script ready signal ──────────────────────────
    window.addEventListener('message', function (evt) {
        if (!evt.data) return;
        if (evt.data.__leadsync_ready__) {
            _contentScriptReady = true;
            flushBuffer();
        }
    });

    // ── Patch XMLHttpRequest ────────────────────────────────────────────
    var OrigXHR = window.XMLHttpRequest;

    function PatchedXHR() {
        var xhr = new OrigXHR();
        var _url  = '';
        var _isLead = false;
        var _isAcq  = false;

        var _method  = 'GET';
        var _body    = null;
        var _contentType = '';

        var origOpen = xhr.open.bind(xhr);
        xhr.open = function (method, url) {
            _url    = url || '';
            _method = (method || 'GET').toUpperCase();
            _isLead = testPatterns(LEAD_URL_PATTERNS, _url);
            _isAcq  = testPatterns(ACQ_URL_PATTERNS, _url);
            return origOpen.apply(xhr, arguments);
        };

        var origSetHeader = xhr.setRequestHeader.bind(xhr);
        xhr.setRequestHeader = function(name, value) {
            if (name && name.toLowerCase() === 'content-type') _contentType = value || '';
            return origSetHeader.apply(xhr, arguments);
        };

        var origSend = xhr.send.bind(xhr);
        xhr.send = function (body) {
            if (_isLead || _isAcq) {
                if (_isAcq && body != null) _body = body;
                var capturedUrl  = _url;
                var capturedLead = _isLead;
                var capturedAcq  = _isAcq;
                var capturedBody = _body;
                var capturedMethod = _method;
                var capturedContentType = _contentType;
                xhr.addEventListener('load', function () {
                    try {
                        if (xhr.status >= 200 && xhr.status < 300 && xhr.responseText) {
                            if (capturedLead) handleLeadResponse(xhr.responseText, capturedUrl);
                            if (capturedAcq) {
                                handleAcqResponse(xhr.responseText, capturedUrl);
                                // Capture template from first successful ACQ request
                                handleAcqTemplate(capturedMethod, capturedUrl, capturedBody, capturedContentType);
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
        PatchedXHR.UNSENT           = 0;
        PatchedXHR.OPENED           = 1;
        PatchedXHR.HEADERS_RECEIVED = 2;
        PatchedXHR.LOADING          = 3;
        PatchedXHR.DONE             = 4;
    } catch (e) {}
    window.XMLHttpRequest = PatchedXHR;

    // ── Patch fetch ─────────────────────────────────────────────────────
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
        var url = typeof input === 'string' ? input
                : (input && input.url) ? input.url : '';

        var isLead = testPatterns(LEAD_URL_PATTERNS, url);
        var isAcq  = testPatterns(ACQ_URL_PATTERNS, url);

        // Capture ACQ request details before fetch consumes them
        var acqBody        = init && init.body        ? init.body        : null;
        var acqMethod      = init && init.method      ? init.method.toUpperCase() : 'POST';
        var acqContentType = '';
        if (init && init.headers) {
            try {
                var hdrs = init.headers;
                acqContentType = (hdrs instanceof Headers ? hdrs.get('content-type') : hdrs['content-type']) || '';
            } catch (e) {}
        }

        var p = origFetch.apply(this, arguments);

        if (isLead || isAcq) {
            var capturedUrl   = url;
            var capturedLead  = isLead;
            var capturedAcq   = isAcq;
            var capturedBody  = acqBody;
            var capturedMethod = acqMethod;
            var capturedCT    = acqContentType;
            p = p.then(function (response) {
                var cloned = response.clone();
                cloned.text().then(function (text) {
                    if (!text) return;
                    if (capturedLead) handleLeadResponse(text, capturedUrl);
                    if (capturedAcq) {
                        handleAcqResponse(text, capturedUrl);
                        // Capture template from first successful ACQ fetch
                        try {
                            var d = JSON.parse(text);
                            var ok = d.CODE === '200' || d.CODE === 200 || d.code === 200;
                            if (ok) handleAcqTemplate(capturedMethod, capturedUrl, capturedBody, capturedCT);
                        } catch (e) {}
                    }
                }).catch(function () {});
                return response;
            });
        }

        return p;
    };

})();
