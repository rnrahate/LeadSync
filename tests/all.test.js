// Comprehensive Unit & Benchmark Test Suite for LeadSync Refactor

var assert = require('assert');
var { normalizeText, extractAttributes, LeadMatcher } = require('./matcher');
var { PerformanceMetrics } = require('./metrics');
var { LeadLifecycleManager, LEAD_STATES } = require('./lifecycle');

var passed = 0;
var failed = 0;

function it(name, fn) {
    try {
        fn();
        console.log('  ✅ PASS: ' + name);
        passed++;
    } catch (e) {
        console.error('  ❌ FAIL: ' + name);
        console.error('     ' + e.message);
        failed++;
    }
}

console.log('\n=== RUNNING UNIT TESTS ===\n');

// ------------------------------------------------------------
// 1. NORMALIZATION & ATTRIBUTES
// ------------------------------------------------------------
console.log('--- 1. Normalization & Attribute Extraction ---');

it('normalizes units and casing correctly', function() {
    assert.strictEqual(normalizeText('SPF 50 Gel Sunscreen 50 g'), 'spf50 gel sunscreen 50g');
    assert.strictEqual(normalizeText('Amoxicillin 500 mg Capsules (10 x 10 Tabs)'), 'amoxicillin 500mg capsules 10 x 10tabs');
    assert.strictEqual(normalizeText('PARACETAMOL 650MG'), 'paracetamol 650mg');
    assert.strictEqual(normalizeText('Vitamin C 100 ml Serum'), 'vitamin c 100ml serum');
});

it('extracts SPF, strengths, sizes, and forms', function() {
    var a1 = extractAttributes(normalizeText('SPF 50 Gel Sunscreen 50 g'));
    assert.strictEqual(a1.spf, 'spf50');
    assert.ok(a1.sizes.indexOf('50g') !== -1);
    assert.ok(a1.forms.indexOf('gel') !== -1);
    assert.ok(a1.forms.indexOf('sunscreen') !== -1);

    var a2 = extractAttributes(normalizeText('SPF 30 Lotion 100ml'));
    assert.strictEqual(a2.spf, 'spf30');
    assert.ok(a2.sizes.indexOf('100ml') !== -1);
    assert.ok(a2.forms.indexOf('lotion') !== -1);
});

// ------------------------------------------------------------
// 2. PHASE 3.4 USER TEST CASES
// ------------------------------------------------------------
console.log('\n--- 2. Phase 3.4 User Specified Matcher Scenarios ---');

var testFilter = {
    id: 101,
    name: 'Sunscreen Gel SPF50 Filter',
    keywords: ['Sunscreen 50g', 'SPF 50 Gel'],
    negativeKeywords: ['soap', 'repellent']
};

var matcher = new LeadMatcher();

it('Scenario A: High rank candidate with matching product and attributes', function() {
    var leadA = {
        leadId: 'lead_1',
        productName: 'SPF 50 Gel Sunscreen 50 g'
    };
    var res = matcher.evaluate(leadA, testFilter);
    assert.strictEqual(res.passed, true);
    assert.ok(res.score >= 80, 'Expected high score >= 80, got ' + res.score);
});

it('Scenario B: Evaluates candidate with missing size without false acceptance or crash', function() {
    var leadB = {
        leadId: 'lead_2',
        productName: 'SPF 50 Gel for oily skin'
    };
    var resA = matcher.evaluate({ productName: 'SPF 50 Gel Sunscreen 50 g' }, testFilter);
    var resB = matcher.evaluate(leadB, testFilter);
    assert.strictEqual(resB.passed, true);
    assert.ok(resB.score < resA.score, 'Candidate missing 50g should rank lower than full candidate');
});

it('Scenario C: Rejects candidate violating mandatory SPF constraint (SPF 30 vs SPF 50)', function() {
    var leadC = {
        leadId: 'lead_3',
        productName: 'SPF 30 Lotion 50g'
    };
    var res = matcher.evaluate(leadC, testFilter);
    assert.strictEqual(res.passed, false);
    assert.strictEqual(res.stage, 'A_ELIGIBILITY');
    assert.ok(res.reason.indexOf('conflict') !== -1, 'Expected attribute conflict, got ' + res.reason);
});

it('Scenario D: Rejects negative keyword match', function() {
    var leadD = {
        leadId: 'lead_4',
        productName: 'Sunscreen 50g Soap Bar'
    };
    var res = matcher.evaluate(leadD, testFilter);
    assert.strictEqual(res.passed, false);
    assert.strictEqual(res.reason, 'negative_keyword_match');
});

it('Scenario E: Candidate ranking correctly prefers the strongest valid candidate', function() {
    var leads = [
        { leadId: 'weak', productName: 'SPF 50 Gel for oily skin', queryTime: 100 },
        { leadId: 'invalid', productName: 'SPF 30 Lotion 50g', queryTime: 300 },
        { leadId: 'strong', productName: 'SPF 50 Gel Sunscreen 50 g', queryTime: 200 }
    ];
    var ranked = matcher.rankCandidates(leads, testFilter);
    assert.strictEqual(ranked.length, 2, 'Invalid SPF30 lead must be excluded');
    assert.strictEqual(ranked[0].lead.leadId, 'strong', 'Strongest match must rank first');
    assert.strictEqual(ranked[1].lead.leadId, 'weak');
});

it('Scenario F: Match Mode "all" (AND) requires all configured keywords to be present', function() {
    var multiFilter = {
        id: 102,
        name: 'Voltfast Multi-keyword Filter',
        keywords: ['Voltfast', '50mg Powder'],
        matchMode: 'all'
    };
    var partialLead = { leadId: 'lead_part', productName: 'Voltfast Sachets' };
    var fullLead = { leadId: 'lead_full', productName: 'Voltfast 50mg Powder Sachets' };

    var resPartial = matcher.evaluate(partialLead, multiFilter);
    assert.strictEqual(resPartial.passed, false);
    assert.strictEqual(resPartial.reason, 'missing_mandatory_keyword');

    var resFull = matcher.evaluate(fullLead, multiFilter);
    assert.strictEqual(resFull.passed, true);
    assert.ok(resFull.score >= 70);
});

it('Scenario G: Enforces requiredKeywords / mustHaveKeywords regardless of product keywords', function() {
    var reqFilter = {
        id: 103,
        name: 'Amoxicillin with required brand',
        keywords: ['Amoxicillin 500mg'],
        requiredKeywords: ['Novamox']
    };
    var unbrandedLead = { leadId: 'lead_generic', productName: 'Amoxicillin 500mg Capsules' };
    var brandedLead = { leadId: 'lead_branded', productName: 'Novamox Amoxicillin 500mg Capsules' };

    var resUnbranded = matcher.evaluate(unbrandedLead, reqFilter);
    assert.strictEqual(resUnbranded.passed, false);
    assert.strictEqual(resUnbranded.reason, 'missing_required_keyword');

    var resBranded = matcher.evaluate(brandedLead, reqFilter);
    assert.strictEqual(resBranded.passed, true);
});

it('Scenario H: Foreign country matching and restricted countries with ISO normalization', function() {
    var countryFilter = {
        id: 104,
        name: 'India Only Sunscreen Filter',
        keywords: ['Sunscreen 50g'],
        restrictedCountries: ['Bangladesh', 'Pakistan']
    };
    var bdLead = { leadId: 'lead_bd', productName: 'Sunscreen 50g Cream', countryIso: 'BD' };
    var inLead = { leadId: 'lead_in', productName: 'Sunscreen 50g Cream', countryIso: 'IN' };

    var resBd = matcher.evaluate(bdLead, countryFilter);
    assert.strictEqual(resBd.passed, false);
    assert.strictEqual(resBd.reason, 'country_restricted');

    var resIn = matcher.evaluate(inLead, countryFilter);
    assert.strictEqual(resIn.passed, true);
});

it('Scenario I: Contact requirements enforce ALL specified contact channels (AND logic)', function() {
    var contactFilter = {
        id: 105,
        name: 'Strict Contact Filter',
        keywords: ['Paracetamol 650mg'],
        requireMobile: true,
        requireEmail: true
    };
    var onlyMobileLead = {
        leadId: 'lead_mob_only',
        productName: 'Paracetamol 650mg',
        senderMobile: '9876543210'
    };
    var bothContactLead = {
        leadId: 'lead_both_contact',
        productName: 'Paracetamol 650mg',
        senderMobile: '9876543210',
        senderEmail: 'buyer@example.com'
    };

    var resMobOnly = matcher.evaluate(onlyMobileLead, contactFilter);
    assert.strictEqual(resMobOnly.passed, false);
    assert.strictEqual(resMobOnly.reason, 'missing_contact_info');

    var resBoth = matcher.evaluate(bothContactLead, contactFilter);
    assert.strictEqual(resBoth.passed, true);
});

// ------------------------------------------------------------
// 3. CENTRALIZED PERFORMANCE METRICS
// ------------------------------------------------------------
console.log('\n--- 3. Centralized Performance Metrics ---');

it('manages active filter counts reliably', function() {
    var metrics = new PerformanceMetrics();
    assert.strictEqual(metrics.getActiveFiltersCount(), 0);
    metrics.setActiveFiltersCount(15);
    assert.strictEqual(metrics.getActiveFiltersCount(), 15);
});

it('measures speed per acquisition from real timestamps', function() {
    var metrics = new PerformanceMetrics();
    assert.strictEqual(metrics.getSpeedPerAcquisition().hasData, false);

    metrics.recordDetection('lead_1', 1000);
    metrics.recordAcquisitionSuccess('lead_1', 1450); // 450ms

    metrics.recordDetection('lead_2', 2000);
    metrics.recordAcquisitionSuccess('lead_2', 2550); // 550ms

    var speed = metrics.getSpeedPerAcquisition();
    assert.strictEqual(speed.hasData, true);
    assert.strictEqual(speed.avgMs, 500);
    assert.strictEqual(speed.lastMs, 550);
    assert.strictEqual(speed.sampleSize, 2);
});

it('calculates acceptance rate with consistent denominator', function() {
    var metrics = new PerformanceMetrics();
    assert.strictEqual(metrics.getAcceptanceRate().hasData, false);

    // 4 attempts, 3 successes, 1 failure
    metrics.recordDetection('l1', 100);
    metrics.recordAcquisitionAttempt('l1');
    metrics.recordAcquisitionSuccess('l1', 200);

    metrics.recordDetection('l2', 300);
    metrics.recordAcquisitionAttempt('l2');
    metrics.recordAcquisitionSuccess('l2', 400);

    metrics.recordDetection('l3', 500);
    metrics.recordAcquisitionAttempt('l3');
    metrics.recordAcquisitionFailure('l3', 'user_rejected');

    metrics.recordDetection('l4', 700);
    metrics.recordAcquisitionAttempt('l4');
    metrics.recordAcquisitionSuccess('l4', 800);

    var rate = metrics.getAcceptanceRate();
    assert.strictEqual(rate.hasData, true);
    assert.strictEqual(rate.successful, 3);
    assert.strictEqual(rate.attempts, 4);
    assert.strictEqual(rate.percentage, 75);
});

// ------------------------------------------------------------
// 4. LEAD LIFECYCLE & STATE TRANSITIONS
// ------------------------------------------------------------
console.log('\n--- 4. Lead Lifecycle & State Transitions ---');

it('enforces explicit step-by-step lifecycle transitions', function() {
    var lifecycle = new LeadLifecycleManager();

    // 1. Detection
    var r1 = lifecycle.transition('lead_10', LEAD_STATES.DETECTED);
    assert.strictEqual(r1.ok, true);

    // 2. Matching
    var r2 = lifecycle.transition('lead_10', LEAD_STATES.MATCHED);
    assert.strictEqual(r2.ok, true);

    // 3. Acquisition Pending
    var r3 = lifecycle.transition('lead_10', LEAD_STATES.ACQUISITION_PENDING);
    assert.strictEqual(r3.ok, true);
    assert.strictEqual(lifecycle.isInFlight('lead_10'), true);

    // 4. Acquired
    var r4 = lifecycle.transition('lead_10', LEAD_STATES.ACQUIRED);
    assert.strictEqual(r4.ok, true);

    // 5. Contact Pending
    var r5 = lifecycle.transition('lead_10', LEAD_STATES.CONTACT_PENDING);
    assert.strictEqual(r5.ok, true);

    // 6. Contacted (Verified terminal state)
    var r6 = lifecycle.transition('lead_10', LEAD_STATES.CONTACTED);
    assert.strictEqual(r6.ok, true);
    assert.strictEqual(lifecycle.isTerminal('lead_10'), true);
    assert.strictEqual(lifecycle.isInFlight('lead_10'), false);

    // Illegal skip transition directly from DETECTED to CONTACTED must fail
    lifecycle.transition('lead_bad', LEAD_STATES.DETECTED);
    var badTransition = lifecycle.transition('lead_bad', LEAD_STATES.CONTACTED);
    assert.strictEqual(badTransition.ok, false);
});

// ------------------------------------------------------------
// 5. BENCHMARKING (Phase 7: 20, 50, 100 filters with 7 leads)
// ------------------------------------------------------------
console.log('\n--- 5. Low-Latency Matching Benchmark (7 leads x N filters) ---');

function runBenchmark(numFilters) {
    var sampleProducts = [
        'Paracetamol 650mg Tablets',
        'Azithromycin 500mg Strip',
        'Sunscreen SPF 50 Gel 50g',
        'Vitamin C 100ml Serum',
        'Cetirizine 10mg Box',
        'Ibuprofen 400mg Caps',
        'Cough Syrup 100ml Bottle'
    ];

    var filters = [];
    for (var f = 0; f < numFilters; f++) {
        var baseProduct = sampleProducts[f % sampleProducts.length];
        filters.push({
            id: f + 1,
            name: 'Filter ' + (f + 1),
            keywords: [baseProduct, 'Alternative ' + baseProduct],
            negativeKeywords: ['defective', 'expired']
        });
    }

    var leads = sampleProducts.map(function(p, idx) {
        return {
            leadId: 'bench_lead_' + (idx + 1),
            productName: p + ' Batch ' + (idx + 1),
            detectedAt: performance.now()
        };
    });

    var matcher = new LeadMatcher();
    var iterations = 50;
    var latencies = [];

    for (var it = 0; it < iterations; it++) {
        var start = performance.now();
        for (var l = 0; l < leads.length; l++) {
            for (var fi = 0; fi < filters.length; fi++) {
                matcher.evaluate(leads[l], filters[fi]);
            }
        }
        var elapsed = performance.now() - start;
        latencies.push(elapsed);
    }

    latencies.sort(function(a, b) { return a - b; });
    var median = latencies[Math.floor(latencies.length / 2)];
    var p95 = latencies[Math.floor(latencies.length * 0.95)];

    return { numFilters: numFilters, numLeads: leads.length, medianMs: median.toFixed(3), p95Ms: p95.toFixed(3) };
}

[20, 50, 100].forEach(function(count) {
    var result = runBenchmark(count);
    console.log('  ⚡ ' + result.numLeads + ' leads vs ' + result.numFilters + ' active filters: Median = ' + result.medianMs + 'ms, p95 = ' + result.p95Ms + 'ms');
    assert.ok(parseFloat(result.p95Ms) < 1000, 'Latency must be under 1000ms');
});

console.log('\n=== TEST RESULTS SUMMARY ===');
console.log('Passed: ' + passed + ' | Failed: ' + failed);
if (failed > 0) {
    process.exit(1);
}
