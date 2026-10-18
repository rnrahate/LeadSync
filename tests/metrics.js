// Centralized PerformanceMetrics Service
// Tracks:
// 1. Active Filters Count (live, accurate, excludes disabled/deleted)
// 2. Speed per Acquisition (detection-to-acquisition latency, monotonic clock, rolling sample)
// 3. Acceptance Rate (verified successful acquisitions / eligible acquisition attempts * 100)
// 4. Matching Precision (verified relevant leads / accepted matches * 100)
// 5. Latency breakdown (detection, match, acquisition, contact)

function PerformanceMetrics() {
    this._activeFiltersCount = 0;
    this._detections = new Map(); // leadId -> monotonic timestamp
    this._matches = new Map();    // leadId -> monotonic timestamp
    this._attempts = 0;           // total eligible acquisition attempts
    this._acquisitions = [];      // [{ leadId, durationMs, timestamp }]
    this._failedAttempts = 0;     // failed attempts
    this._contacts = [];          // [{ leadId, durationMs, timestamp }]
    this._failedContacts = 0;
    this._sampleLimit = 20;
    this._evaluations = 0;
    this._acceptedMatches = 0;
    this._verifiedRelevant = 0;
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
    this._acceptedMatches++;
};

PerformanceMetrics.prototype.recordMatchEvaluation = function(accepted, verifiedRelevant) {
    this._evaluations++;
    if (accepted) {
        if (verifiedRelevant) this._verifiedRelevant++;
    }
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

PerformanceMetrics.prototype.resetCycle = function(cycleId) {
    this._currentCycleId = cycleId || ('cycle_' + Date.now());
    this._acquisitions = [];
    this._attempts = 0;
    this._failedAttempts = 0;
    this._contacts = [];
    this._failedContacts = 0;
    this._completedAttempts = 0;
    this._completedSuccesses = 0;
};

PerformanceMetrics.prototype.recordLeadAttemptCompleted = function(leadId, success) {
    this._completedAttempts = (this._completedAttempts || 0) + 1;
    if (success) {
        this._completedSuccesses = (this._completedSuccesses || 0) + 1;
    }
};

PerformanceMetrics.prototype.getSpeedPerAcquisition = function() {
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
    var sum = 0;
    for (var i = 0; i < sample.length; i++) {
        sum += sample[i].durationMs;
    }
    var avg = Math.round(sum / sample.length);
    var last = Math.round(sample[sample.length - 1].durationMs);

    var formatDuration = function(ms) {
        if (ms < 1000) return ms + 'ms';
        return (ms / 1000).toFixed(1) + 's';
    };

    return {
        hasData: true,
        avgMs: avg,
        lastMs: last,
        averageMs: avg,
        sampleSize: sample.length,
        sampleCount: sample.length,
        formatted: formatDuration(avg),
        formattedAvg: formatDuration(avg),
        formattedLast: formatDuration(last),
        text: formatDuration(avg)
    };
};

PerformanceMetrics.prototype.getAcceptanceRate = function() {
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

    var successful = this._completedSuccesses !== undefined && this._completedAttempts ? this._completedSuccesses : this._acquisitions.length;
    var rate = (successful / totalAttempts) * 100;
    var pct = Math.min(100, Math.max(0, rate));
    var rounded = Math.round(pct * 10) / 10;

    return {
        hasData: true,
        percentage: parseFloat(rounded.toFixed(1)),
        ratePercent: rounded,
        successful: successful,
        successes: successful,
        attempts: totalAttempts,
        formatted: rounded.toFixed(1) + '%',
        text: rounded.toFixed(1) + '%'
    };
};

PerformanceMetrics.prototype.getMatchingPrecision = function() {
    if (this._acceptedMatches === 0) {
        return {
            hasData: false,
            percentage: 0,
            verified: 0,
            accepted: 0,
            text: '--'
        };
    }
    var rate = (this._verifiedRelevant / this._acceptedMatches) * 100;
    return {
        hasData: true,
        percentage: parseFloat(rate.toFixed(1)),
        verified: this._verifiedRelevant,
        accepted: this._acceptedMatches,
        text: rate.toFixed(1) + '%'
    };
};

PerformanceMetrics.prototype.getSnapshot = function() {
    return {
        activeFiltersCount: this.getActiveFiltersCount(),
        speed: this.getSpeedPerAcquisition(),
        acceptanceRate: this.getAcceptanceRate(),
        matchingPrecision: this.getMatchingPrecision()
    };
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        PerformanceMetrics: PerformanceMetrics
    };
}
