// src/supabase-service.js
// Complete Supabase integration with data management
// Developed by Keyn Labs
// Version 4.9.0
// ============================================================================
// CHANGELOG v4.9.0
//   • insertLead returns { data, conflict, existingId } on 409 (no throw)
//   • getRecentLeads(limit, statuses) — optional status filter
//   • _flushStats early-returns if no filters cached
//   • Filters cache TTL: 30s → 10s
//   • updateFilterStatus debounced (5s coalesce window)
//   • markLeadContacted fires history insert in parallel (non-blocking)
//   • AbortController timeouts on all mutating fetches
//   • getFilterById() + getActiveFilterCount() helpers added
//   • healthCheck gets 5s timeout
//   • More robust _extractCount across PostgREST versions
// ============================================================================

const SUPABASE_URL = 'https://zvhuromubukylsxrsfiz.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp2aHVyb211YnVreWxzeHJzZml6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgwODI4MDYsImV4cCI6MjEwMzY1ODgwNn0.29J2uGHxFhPtEqRZvnXjaYpL-x4I0uEc2TT8u9d5PVw';

// Default network timeouts (ms)
const TIMEOUT_READ   = 8000;
const TIMEOUT_WRITE  = 15000;
const TIMEOUT_HEALTH = 5000;

class SupabaseService {
    constructor() {
        this.url = SUPABASE_URL;
        this.key = SUPABASE_KEY;
        this.headers = {
            'apikey': this.key,
            'Authorization': 'Bearer ' + this.key,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
        };
        this.logger = null;
                this._filters = [];
        this._filtersLoaded = false;
        this._filtersLastFetch = 0;
        this._filtersTTL = 10000; // 10 seconds (in-memory TTL)
        this._filtersCacheKey = 'cached_filters_v1';
        this._filtersCacheTTL = 60000; // 60 seconds — how long storage cache stays "fresh"
        this._clientId = 'default';
        this._statsBuffer = { scanned: 0, matched: 0, clicked: 0 };
        this._statsFlushTimer = null;
        this._statsPending = false;
        this._filterStatusLastPushed = 0;
        this._filterStatusPending = null;
    }

    // ============================================================
    // LOGGING
    // ============================================================
    setLogger(logger) {
        this.logger = logger;
    }

    _log(level, msg, data) {
        if (this.logger && typeof this.logger[level] === 'function') {
            this.logger[level](msg, data);
        }
    }

    // ============================================================
    // FETCH HELPERS (AbortController timeouts)
    // ============================================================
    async _fetchWithTimeout(url, options, timeoutMs) {
        timeoutMs = timeoutMs || TIMEOUT_READ;
        var controller = new AbortController();
        var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
        try {
            var opts = Object.assign({}, options || {}, { signal: controller.signal });
            var res = await fetch(url, opts);
            clearTimeout(timer);
            return res;
        } catch (err) {
            clearTimeout(timer);
            if (err.name === 'AbortError') {
                throw new Error('Timeout after ' + timeoutMs + 'ms');
            }
            throw err;
        }
    }

    // ============================================================
    // FILTERS - Fetch and cache
    // ============================================================
    /**
     * Load active filters. Cached for _filtersTTL ms.
     * @param {boolean} forceRefresh
     * @returns {Promise<Array>}
     */
            async loadFilters(forceRefresh) {
        var self = this;
        var now = Date.now();

        // 1) In-memory cache — fastest
        if (!forceRefresh && this._filtersLoaded && (now - this._filtersLastFetch) < this._filtersTTL) {
            return true;
        }

        // 2) Storage cache — instant, no network
        if (!forceRefresh) {
            var cached = await this._readFiltersCache();
            if (cached && Array.isArray(cached.filters)) {
                this._filters = cached.filters;
                this._filtersLoaded = true;
                this._filtersLastFetch = cached.timestamp;
                this._log('info', '📦 Filters loaded from cache', {
                    count: this._filters.length,
                    ageSec: Math.round((now - cached.timestamp) / 1000)
                });
                if (this._filters.length > 0 && this._filters[0].client_id) {
                    this._clientId = this._filters[0].client_id;
                }
                // Stale? Refresh in background (don't block scanner)
                if (now - cached.timestamp > this._filtersCacheTTL) {
                    this._refreshFiltersInBackground();
                }
                return true;
            }
        }

        // 3) Network fetch (first ever load, or forced refresh, or cache miss)
        return this._fetchFiltersFromNetwork();
    }

    async _fetchFiltersFromNetwork() {
        try {
            var url = this.url + '/rest/v1/filters?is_active=eq.true&select=*&order=id.asc';
            var response = await this._fetchWithTimeout(url, { headers: this.headers }, TIMEOUT_READ);
            if (!response.ok) throw new Error('HTTP ' + response.status);

            var data = await response.json();
            this._filters = Array.isArray(data) ? data : [];
            this._filtersLoaded = true;
            this._filtersLastFetch = Date.now();

            if (this._filters.length > 0 && this._filters[0].client_id) {
                this._clientId = this._filters[0].client_id;
            }

            // Write to storage cache
            await this._writeFiltersCache(this._filters);

            this._log('info', '📥 Filters loaded from Supabase', { count: this._filters.length });
            return true;
        } catch (err) {
            this._log('error', '❌ Failed to load filters', { error: err.message });
            return false;
        }
    }

    _refreshFiltersInBackground() {
        var self = this;
        this._log('info', '🔄 Refreshing filters in background...');
        // Fire and forget — do not await
        this._fetchFiltersFromNetwork().catch(function() {});
    }

    _readFiltersCache() {
        var self = this;
        return new Promise(function(resolve) {
            try {
                chrome.storage.local.get(self._filtersCacheKey, function(result) {
                    var cached = result && result[self._filtersCacheKey];
                    if (cached && typeof cached.timestamp === 'number') {
                        resolve(cached);
                    } else {
                        resolve(null);
                    }
                });
            } catch (e) {
                resolve(null);
            }
        });
    }

    _writeFiltersCache(filters) {
        var self = this;
        return new Promise(function(resolve) {
            try {
                var payload = {};
                payload[self._filtersCacheKey] = {
                    filters: filters,
                    timestamp: Date.now()
                };
                chrome.storage.local.set(payload, function() { resolve(); });
            } catch (e) {
                resolve();
            }
        });
    }

    /** @returns {Array} Currently cached filters */
    getFilters() {
        return this._filters;
    }

    /**
     * Fetch a single filter by id. Always hits the network (no cache).
     * @param {number|string} id
     * @returns {Promise<Object|null>}
     */
    async getFilterById(id) {
        try {
            var url = this.url + '/rest/v1/filters?id=eq.' + encodeURIComponent(id) + '&select=*&limit=1';
            var response = await this._fetchWithTimeout(url, { headers: this.headers }, TIMEOUT_READ);
            if (!response.ok) throw new Error('HTTP ' + response.status);
            var arr = await response.json();
            return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
        } catch (err) {
            this._log('warn', 'getFilterById failed', { id: id, error: err.message });
            return null;
        }
    }

    /**
     * Count of currently active filters.
     * @returns {Promise<number>}
     */
    async getActiveFilterCount() {
        try {
            var url = this.url + '/rest/v1/filters?is_active=eq.true&select=id';
            var response = await this._fetchWithTimeout(url, { headers: this.headers }, TIMEOUT_READ);
            if (!response.ok) throw new Error('HTTP ' + response.status);
            var arr = await response.json();
            return Array.isArray(arr) ? arr.length : 0;
        } catch (err) {
            return 0;
        }
    }

    // ============================================================
    // FILTER STATUS (debounced — coalesces rapid calls)
    // ============================================================
    /**
     * Mark all active filters as running/not-running.
     * Debounced: rapid calls within 5s collapse into a single PATCH.
     * @param {boolean} isRunning
     * @returns {Promise<boolean>}
     */
    async updateFilterStatus(isRunning) {
        var now = Date.now();
        this._filterStatusPending = isRunning;

        // If a call was made < 5s ago with the same value, skip entirely
        if (this._filterStatusLastPushed &&
            (now - this._filterStatusLastPushed) < 5000 &&
            this._filterStatusLastPushed_value === isRunning) {
            return true;
        }

        // Coalesce: if we just fired, debounce
        if (this._filterStatusLastPushed && (now - this._filterStatusLastPushed) < 5000) {
            var self = this;
            if (this._filterStatusDebounceTimer) clearTimeout(this._filterStatusDebounceTimer);
            this._filterStatusDebounceTimer = setTimeout(function() {
                self._filterStatusDebounceTimer = null;
                self._doFilterStatusPush(self._filterStatusPending);
            }, 5000 - (now - this._filterStatusLastPushed));
            return true;
        }

        return this._doFilterStatusPush(isRunning);
    }

    async _doFilterStatusPush(isRunning) {
        try {
            var url = this.url + '/rest/v1/filters?is_active=eq.true';
            var body = {
                is_running: isRunning,
                last_poll_time: new Date().toISOString()
            };
            var response = await this._fetchWithTimeout(url, {
                method: 'PATCH',
                headers: this.headers,
                body: JSON.stringify(body)
            }, TIMEOUT_WRITE);

            if (!response.ok) throw new Error('HTTP ' + response.status);

            this._filterStatusLastPushed = Date.now();
            this._filterStatusLastPushed_value = isRunning;
            this._log('debug', '📡 Filter status updated', { isRunning: isRunning });
            return true;
        } catch (err) {
            this._log('warn', 'Failed to update filter status', { error: err.message });
            return false;
        }
    }

    // ============================================================
    // LEADS - Check if exists
    // ============================================================
    /**
     * @param {string} uniqueQueryId
     * @returns {Promise<Object|null>}
     */
    async leadExists(uniqueQueryId) {
        try {
            var url = this.url + '/rest/v1/leads?unique_query_id=eq.' +
                encodeURIComponent(uniqueQueryId) +
                '&select=id,status,is_contacted&limit=1';
            var response = await this._fetchWithTimeout(url, { headers: this.headers }, TIMEOUT_READ);
            if (!response.ok) throw new Error('HTTP ' + response.status);
            var data = await response.json();
            return data.length > 0 ? data[0] : null;
        } catch (err) {
            this._log('warn', 'Failed to check lead existence', { error: err.message, uniqueQueryId: uniqueQueryId });
            return null;
        }
    }

    // ============================================================
    // LEADS - Insert (409-aware)
    // ============================================================
    /**
     * Insert a lead. On 409 conflict, returns the existing row instead of throwing.
     * @param {Object} lead
     * @returns {Promise<{data: Object|null, conflict: boolean, existingId: number|string|null}>}
     */
    async insertLead(lead) {
        var body = {
            unique_query_id: lead.uniqueQueryId,
            query_type: lead.queryType || 'BUY_LEAD',
            query_time: lead.queryTime || new Date().toISOString(),
            sender_name: lead.senderName || null,
            sender_mobile: lead.senderMobile || null,
            sender_mobile_alt: lead.senderMobileAlt || null,
            sender_phone: lead.senderPhone || null,
            sender_phone_alt: lead.senderPhoneAlt || null,
            sender_email: lead.senderEmail || null,
            sender_email_alt: lead.senderEmailAlt || null,
            sender_company: lead.senderCompany || null,
            sender_address: lead.senderAddress || null,
            sender_city: lead.senderCity || null,
            sender_state: lead.senderState || null,
            sender_pincode: lead.senderPincode || null,
            sender_country_iso: lead.senderCountryIso || null,
            subject: lead.subject || null,
            query_product_name: lead.queryProductName || null,
            query_message: lead.queryMessage || null,
            query_mcat_name: lead.queryMcatName || null,
            call_duration: lead.callDuration || null,
            receiver_mobile: lead.receiverMobile || null,
            is_matched: lead.isMatched || false,
            is_contacted: false,
            status: 'new'
        };

        try {
            var url = this.url + '/rest/v1/leads';
            var response = await this._fetchWithTimeout(url, {
                method: 'POST',
                headers: this.headers,
                body: JSON.stringify(body)
            }, TIMEOUT_WRITE);

            if (response.status === 409) {
                // Conflict — fetch existing row so caller can recover id
                this._log('debug', '🔁 Lead already exists (409)', { uniqueQueryId: lead.uniqueQueryId });
                var existing = await this.leadExists(lead.uniqueQueryId);
                return {
                    data: existing,
                    conflict: true,
                    existingId: existing ? existing.id : null
                };
            }

            if (!response.ok) {
                var errorText = await response.text();
                throw new Error('HTTP ' + response.status + ': ' + errorText.substring(0, 200));
            }

            var data = await response.json();
            var row = data[0] || null;
            this._log('info', '💾 Lead inserted', { uniqueQueryId: lead.uniqueQueryId, id: row && row.id });
            return { data: row, conflict: false, existingId: null };
        } catch (err) {
            this._log('error', '❌ Failed to insert lead', { error: err.message, uniqueQueryId: lead.uniqueQueryId });
            return { data: null, conflict: false, existingId: null, error: err.message };
        }
    }

    // ============================================================
    // LEADS - Update
    // ============================================================
    async updateLead(uniqueQueryId, updates) {
        try {
            var url = this.url + '/rest/v1/leads?unique_query_id=eq.' + encodeURIComponent(uniqueQueryId);
            var body = Object.assign({}, updates, { updated_at: new Date().toISOString() });

            var response = await this._fetchWithTimeout(url, {
                method: 'PATCH',
                headers: this.headers,
                body: JSON.stringify(body)
            }, TIMEOUT_WRITE);

            if (!response.ok) throw new Error('HTTP ' + response.status);

            this._log('debug', '✏️ Lead updated', { uniqueQueryId: uniqueQueryId, updates: updates });
            return true;
        } catch (err) {
            this._log('error', '❌ Failed to update lead', { error: err.message, uniqueQueryId: uniqueQueryId });
            return false;
        }
    }

    async markLeadMatched(uniqueQueryId) {
        return this.updateLead(uniqueQueryId, { is_matched: true, status: 'matched' });
    }

    async markLeadContacted(uniqueQueryId) {
        return this.updateLead(uniqueQueryId, {
            is_contacted: true,
            status: 'contacted',
            updated_at: new Date().toISOString()
        });
    }

    // ============================================================
    // LEAD HISTORY
    // ============================================================
    /**
     * Insert a lead_history row. Non-blocking wrapper is provided by caller.
     * @returns {Promise<boolean>}
     */
    async insertLeadHistory(leadId, action, details, contactedAt) {
        try {
            var url = this.url + '/rest/v1/lead_history';
            var body = {
                lead_id: leadId,
                action: action,
                action_details: typeof details === 'string' ? details : JSON.stringify(details || {}),
                contacted_at: contactedAt || null
            };

            var response = await this._fetchWithTimeout(url, {
                method: 'POST',
                headers: this.headers,
                body: JSON.stringify(body)
            }, TIMEOUT_WRITE);

            if (!response.ok) throw new Error('HTTP ' + response.status);

            this._log('debug', '📝 History added', { leadId: leadId, action: action });
            return true;
        } catch (err) {
            this._log('warn', 'Failed to add history', { error: err.message });
            return false;
        }
    }

    // ============================================================
    // STATS - Buffered updates
    // ============================================================
    /**
     * Update filter stats. Buffered for 10s to avoid PATCH storms.
     */
    async updateFilterStats(scanned, matched, clicked) {
        this._statsBuffer.scanned = scanned;
        this._statsBuffer.matched = matched;
        this._statsBuffer.clicked = clicked;

        if (this._statsFlushTimer) return;
        if (this._statsPending) return;

        var self = this;
        this._statsFlushTimer = setTimeout(function() {
            self._statsFlushTimer = null;
            self._flushStats();
        }, 10000);
    }

    async _flushStats() {
        // Skip if no filters cached — PATCH would match zero rows
        if (!this._filters || this._filters.length === 0) {
            this._statsPending = false;
            return;
        }

        this._statsPending = true;
        try {
            var url = this.url + '/rest/v1/filters?is_active=eq.true';
            var body = {
                stats_scanned: this._statsBuffer.scanned,
                stats_matched: this._statsBuffer.matched,
                stats_clicked: this._statsBuffer.clicked,
                updated_at: new Date().toISOString()
            };

            var response = await this._fetchWithTimeout(url, {
                method: 'PATCH',
                headers: this.headers,
                body: JSON.stringify(body)
            }, TIMEOUT_WRITE);

            if (response.ok) {
                this._log('debug', '📊 Stats flushed to DB', this._statsBuffer);
            }
        } catch (err) {
            this._log('warn', 'Stats flush failed', { error: err.message });
        } finally {
            this._statsPending = false;
        }
    }

    // ============================================================
    // BATCH - Fetch recent leads (for dedup cache)
    // ============================================================
    /**
     * Fetch recent leads. Optionally filter by status.
     * @param {number} limit
     * @param {string[]} [statuses] - e.g. ['rejected','skipped']
     * @returns {Promise<Array>}
     */
    async getRecentLeads(limit, statuses) {
        limit = limit || 100;
        try {
            var url = this.url + '/rest/v1/leads?select=unique_query_id,status,is_contacted&order=created_at.desc&limit=' + limit;
            if (Array.isArray(statuses) && statuses.length > 0) {
                url += '&status=in.(' + statuses.map(function(s) { return encodeURIComponent(s); }).join(',') + ')';
            }
            var response = await this._fetchWithTimeout(url, { headers: this.headers }, TIMEOUT_READ);
            if (!response.ok) throw new Error('HTTP ' + response.status);
            var data = await response.json();
            return Array.isArray(data) ? data : [];
        } catch (err) {
            this._log('warn', 'Failed to fetch recent leads', { error: err.message });
            return [];
        }
    }

    // ============================================================
    // DATA MANAGEMENT — CLEAR OPERATIONS
    // ============================================================

    async clearAllLeads() {
        try {
            var url = this.url + '/rest/v1/leads?id=gte.0';
            var response = await this._fetchWithTimeout(url, {
                method: 'DELETE',
                headers: {
                    'apikey': this.key,
                    'Authorization': 'Bearer ' + this.key,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal'
                }
            }, TIMEOUT_WRITE);

            if (!response.ok) {
                var errorText = await response.text();
                throw new Error('HTTP ' + response.status + ': ' + errorText.substring(0, 200));
            }

            this._log('warn', '🗑️ All leads deleted');
            return { success: true, message: 'All leads deleted' };
        } catch (err) {
            this._log('error', '❌ Failed to clear leads', { error: err.message });
            return { success: false, error: err.message };
        }
    }

    async clearAllHistory() {
        try {
            var url = this.url + '/rest/v1/lead_history?id=gte.0';
            var response = await this._fetchWithTimeout(url, {
                method: 'DELETE',
                headers: {
                    'apikey': this.key,
                    'Authorization': 'Bearer ' + this.key,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal'
                }
            }, TIMEOUT_WRITE);

            if (!response.ok) {
                var errorText = await response.text();
                throw new Error('HTTP ' + response.status + ': ' + errorText.substring(0, 200));
            }

            this._log('warn', '🗑️ All history deleted');
            return { success: true, message: 'All history deleted' };
        } catch (err) {
            this._log('error', '❌ Failed to clear history', { error: err.message });
            return { success: false, error: err.message };
        }
    }

    async resetFilterStats() {
        try {
            var url = this.url + '/rest/v1/filters?is_active=eq.true';
            var body = {
                stats_scanned: 0,
                stats_matched: 0,
                stats_clicked: 0,
                is_running: false,
                updated_at: new Date().toISOString()
            };

            var response = await this._fetchWithTimeout(url, {
                method: 'PATCH',
                headers: this.headers,
                body: JSON.stringify(body)
            }, TIMEOUT_WRITE);

            if (!response.ok) throw new Error('HTTP ' + response.status);

            this._log('warn', '🔄 Filter stats reset');
            return { success: true, message: 'Stats reset' };
        } catch (err) {
            this._log('error', 'Failed to reset stats', { error: err.message });
            return { success: false, error: err.message };
        }
    }

    async clearLeadsBefore(dateISO) {
        if (!dateISO || typeof dateISO !== 'string') {
            return { success: false, error: 'Missing date' };
        }
        if (!/^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/.test(dateISO)) {
            return { success: false, error: 'Invalid date format (expected YYYY-MM-DD or ISO)' };
        }

        try {
            var url = this.url + '/rest/v1/leads?created_at=lt.' + encodeURIComponent(dateISO);
            var response = await this._fetchWithTimeout(url, {
                method: 'DELETE',
                headers: {
                    'apikey': this.key,
                    'Authorization': 'Bearer ' + this.key,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal'
                }
            }, TIMEOUT_WRITE);

            if (!response.ok) {
                var errorText = await response.text();
                throw new Error('HTTP ' + response.status + ': ' + errorText.substring(0, 200));
            }

            this._log('warn', '🗑️ Old leads deleted before ' + dateISO);
            return { success: true, message: 'Old leads deleted' };
        } catch (err) {
            this._log('error', 'Failed to delete old leads', { error: err.message });
            return { success: false, error: err.message };
        }
    }

    async getTableCounts() {
        try {
            var countHeaders = {
                'apikey': this.key,
                'Authorization': 'Bearer ' + this.key,
                'Range': '0-0',
                'Prefer': 'count=exact'
            };

            var results = await Promise.all([
                this._fetchWithTimeout(this.url + '/rest/v1/leads?select=id',        { headers: countHeaders }, TIMEOUT_READ),
                this._fetchWithTimeout(this.url + '/rest/v1/lead_history?select=id', { headers: countHeaders }, TIMEOUT_READ),
                this._fetchWithTimeout(this.url + '/rest/v1/filters?select=id',      { headers: countHeaders }, TIMEOUT_READ)
            ]);

            return {
                success: true,
                leads:   this._extractCount(results[0]),
                history: this._extractCount(results[1]),
                filters: this._extractCount(results[2])
            };
        } catch (err) {
            this._log('warn', 'Failed to get table counts', { error: err.message });
            return { success: false, error: err.message };
        }
    }

    /**
     * Extract count from a PostgREST response header.
     * Handles both `Range: 0-0` + `Prefer: count=exact` and plain `content-range`.
     * Returns '?' if header is missing/malformed.
     */
    _extractCount(response) {
        try {
            if (!response || !response.headers || typeof response.headers.get !== 'function') return '?';
            var range = response.headers.get('content-range') || response.headers.get('Content-Range');
            if (range) {
                // Format: "0-0/123" or "*/123" or "0-9/*"
                var parts = range.split('/');
                if (parts[1] && parts[1] !== '*') {
                    var n = parseInt(parts[1], 10);
                    return isNaN(n) ? '?' : n;
                }
            }
            return '?';
        } catch (e) {
            return '?';
        }
    }

    // ============================================================
    // HEALTH CHECK
    // ============================================================
    /**
     * Ping the REST endpoint. 5s timeout.
     * @returns {Promise<boolean>}
     */
    async healthCheck() {
        try {
            var response = await this._fetchWithTimeout(
                this.url + '/rest/v1/filters?select=id&limit=1',
                { headers: this.headers },
                TIMEOUT_HEALTH
            );
            return response.ok;
        } catch (err) {
            return false;
        }
    }

    /**
     * Force-refresh filters cache.
     * @returns {Promise<Array>}
     */
    async refresh() {
        this._filtersLastFetch = 0;
        this._filtersLoaded = false;
        return await this.loadFilters(true);
    }
}

// Export to window for content-script consumption
window.SupabaseService = SupabaseService;