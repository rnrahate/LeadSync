// LeadLifecycle — Verified terminal states & transition guards
// States: DETECTED -> MATCHED -> ACQUISITION_PENDING -> ACQUIRED -> CONTACT_PENDING -> CONTACTED
// Terminal Failure/Retry states: ACQUISITION_FAILED, CONTACT_FAILED, RETRY_SCHEDULED, BLOCKED, SKIPPED

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
    'CONTACTED': [], // Terminal success
    'BLOCKED': ['RETRY_SCHEDULED'],
    'SKIPPED': []
};

function LeadLifecycleManager() {
    this._states = new Map(); // leadId -> { state, history: [], updatedAt }
    this._inFlight = new Set(); // leadIds currently undergoing acquisition or contact
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

    // Idempotency: same state transition is allowed as a no-op
    if (currentState === newState) {
        return { ok: true, previousState: currentState, currentState: newState, noop: true };
    }

    // Check transition validity
    var allowed = VALID_TRANSITIONS[currentState] || [];
    if (allowed.indexOf(newState) === -1) {
        return {
            ok: false,
            error: 'Illegal state transition from ' + currentState + ' to ' + newState
        };
    }

    // Guard in-flight status
    if (newState === LEAD_STATES.ACQUISITION_PENDING || newState === LEAD_STATES.CONTACT_PENDING) {
        this._inFlight.add(leadId);
    } else if (newState === LEAD_STATES.CONTACTED || newState === LEAD_STATES.ACQUISITION_FAILED || newState === LEAD_STATES.CONTACT_FAILED || newState === LEAD_STATES.SKIPPED) {
        this._inFlight.delete(leadId);
    }

    currentEntry.state = newState;
    currentEntry.updatedAt = Date.now();
    currentEntry.history.push({ state: newState, at: Date.now(), meta: meta || {} });

    return { ok: true, previousState: currentState, currentState: newState };
};

LeadLifecycleManager.prototype.isInFlight = function(leadId) {
    if (leadId) return this._inFlight.has(leadId);
    return this._inFlight.size > 0;
};

LeadLifecycleManager.prototype.getHistory = function(leadId) {
    var entry = this._states.get(leadId);
    return entry ? entry.history : [];
};

LeadLifecycleManager.prototype.isTerminal = function(leadId) {
    var state = this.getState(leadId);
    return state === LEAD_STATES.CONTACTED || state === LEAD_STATES.SKIPPED;
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        LEAD_STATES: LEAD_STATES,
        LeadLifecycleManager: LeadLifecycleManager
    };
}
