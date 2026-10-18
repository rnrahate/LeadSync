// LeadMatchingEngine — Deterministic, Explainable Two-Stage Matching
// Stage A: Hard Eligibility Constraints (attribute conflicts, negative keywords, location, quantity)
// Stage B: Relevance Scoring (exact match, token coverage, attribute agreement, synonyms)

function normalizeText(text) {
    if (!text) return '';
    return String(text)
        .normalize('NFKC')
        .toLowerCase()
        // Standardize units spacing: "50 g" -> "50g", "100 ml" -> "100ml"
        .replace(/(\d+)\s*(g|gm|gms|gram|grams|kg|kgs|ml|ltr|l|mg|mcg|oz|tab|tabs|tablet|tablets|cap|caps|capsule|capsules|pc|pcs|piece|pieces|box|boxes|strip|strips|vial|vials|bottle|bottles|pack|packs)\b/gi, '$1$2')
        // Standardize SPF format: "spf 50" -> "spf50"
        .replace(/\bspf\s*(\d+)\b/gi, 'spf$1')
        // Normalize common punctuation to space while preserving alphanumeric, hyphens, and periods
        .replace(/[^\w\s\-\.]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenize(normalizedText) {
    if (!normalizedText) return [];
    return normalizedText.split(/\s+/).filter(function(t) { return t.length > 0; });
}

// Extract attributes: strengths (spf50, 500mg), sizes (50g, 100ml), forms (gel, lotion, cream, tablet, etc.)
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
    var attrs = {
        spf: null,
        strengths: [],
        sizes: [],
        forms: []
    };
    if (!normText) return attrs;

    // SPF
    var spfMatch = normText.match(/\bspf(\d+)\b/);
    if (spfMatch) attrs.spf = 'spf' + spfMatch[1];

    // Strengths (e.g. 500mg, 100mcg, 10%, 500iu)
    var strengthMatches = normText.match(/\b\d+(?:mg|mcg|iu|%)\b/g);
    if (strengthMatches) attrs.strengths = strengthMatches;

    // Sizes (e.g. 50g, 100ml, 1kg, 200gm)
    var sizeMatches = normText.match(/\b\d+(?:g|gm|kg|ml|l|ltr|oz)\b/g);
    if (sizeMatches) attrs.sizes = sizeMatches;

    // Forms
    for (var i = 0; i < COMMON_FORMS.length; i++) {
        var f = COMMON_FORMS[i];
        var rx = new RegExp('\\b' + f + '\\b', 'i');
        if (rx.test(normText)) {
            attrs.forms.push(f);
        }
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
            // Exact prefix only if keyword is >= 5 characters
            if (n.length >= 5 && h.length > n.length && h.indexOf(n) === 0) return true;
        }
        return false;
    } else {
        // Multi-word needle: all tokens must appear
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

// Stage A: Hard Eligibility Check
LeadMatcher.prototype.checkEligibility = function(lead, filter) {
    var rawProd = lead.productName || '';
    var normProd = normalizeText(rawProd);
    var leadAttrs = extractAttributes(normProd);

    // 1. Negative keywords rejection
    var negKws = filter.negativeKeywords || filter.negative_keywords || [];
    for (var i = 0; i < negKws.length; i++) {
        var negNorm = normalizeText(negKws[i]);
        if (negNorm && wordBoundaryMatch(normProd, negNorm)) {
            return {
                eligible: false,
                reason: 'negative_keyword_match',
                detail: 'Matched negative keyword: ' + negKws[i]
            };
        }
    }

    // 2. Check each product keyword / filter requirement for attribute conflicts
    var prodKws = filter.keywords || filter.product_keywords || (filter.filter_config && filter.filter_config.product_names) || [];
    var hasAnyAttrConflictAcrossAll = false;
    var matchedAtLeastOneCompatibleSpec = false;

    for (var j = 0; j < prodKws.length; j++) {
        var kwNorm = normalizeText(prodKws[j]);
        var kwAttrs = extractAttributes(kwNorm);

        // Check SPF conflict: if filter requires spf50, and lead specifies a conflicting spf (e.g. spf30)
        if (kwAttrs.spf && leadAttrs.spf && kwAttrs.spf !== leadAttrs.spf) {
            return {
                eligible: false,
                reason: 'attribute_conflict_spf',
                detail: 'Filter requires ' + kwAttrs.spf + ' but lead specifies ' + leadAttrs.spf
            };
        }

        // Check size conflict: if filter specifies a size (e.g. 50g) and lead explicitly has a conflicting size (e.g. 100g)
        if (kwAttrs.sizes.length > 0 && leadAttrs.sizes.length > 0) {
            var sizeConflict = true;
            for (var s1 = 0; s1 < kwAttrs.sizes.length; s1++) {
                if (leadAttrs.sizes.indexOf(kwAttrs.sizes[s1]) !== -1) {
                    sizeConflict = false;
                    break;
                }
            }
            if (sizeConflict) {
                return {
                    eligible: false,
                    reason: 'attribute_conflict_size',
                    detail: 'Filter requires ' + kwAttrs.sizes.join('/') + ' but lead specifies ' + leadAttrs.sizes.join('/')
                };
            }
        }

        // Check form conflict: if filter requires Lotion and lead is Gel
        var conflictingForms = [
            ['gel', 'lotion'],
            ['gel', 'cream'],
            ['tablet', 'syrup'],
            ['capsule', 'syrup']
        ];
        for (var c = 0; c < conflictingForms.length; c++) {
            var pair = conflictingForms[c];
            if (kwAttrs.forms.indexOf(pair[0]) !== -1 && leadAttrs.forms.indexOf(pair[1]) !== -1) {
                return {
                    eligible: false,
                    reason: 'attribute_conflict_form',
                    detail: 'Filter requires ' + pair[0] + ' but lead specifies conflicting form ' + pair[1]
                };
            }
            if (kwAttrs.forms.indexOf(pair[1]) !== -1 && leadAttrs.forms.indexOf(pair[0]) !== -1) {
                return {
                    eligible: false,
                    reason: 'attribute_conflict_form',
                    detail: 'Filter requires ' + pair[1] + ' but lead specifies conflicting form ' + pair[0]
                };
            }
        }
    }

    // 3. Location / Country checks
    var allowedCountries = filter.restrictedCountries || (filter.filter_config && filter.filter_config.restricted_countries) || [];
    if (allowedCountries.length > 0 && lead.countryIso) {
        var cIso = lead.countryIso.toUpperCase().trim();
        for (var rc = 0; rc < allowedCountries.length; rc++) {
            if (allowedCountries[rc].toUpperCase() === cIso) {
                return {
                    eligible: false,
                    reason: 'country_restricted',
                    detail: 'Country ' + cIso + ' is restricted for this filter'
                };
            }
        }
    }

    // 4. Contact requirements
    var reqMobile = filter.requireMobile || (filter.filter_config && filter.filter_config.require_mobile);
    var reqWhatsapp = filter.requireWhatsapp || (filter.filter_config && filter.filter_config.require_whatsapp);
    var reqEmail = filter.requireEmail || (filter.filter_config && filter.filter_config.require_email);
    if (reqMobile || reqWhatsapp || reqEmail) {
        var contact = lead.contact || {};
        var hasContact = (reqMobile && (contact.mobile || lead.senderMobile)) ||
                         (reqWhatsapp && (contact.phone || lead.senderMobile)) ||
                         (reqEmail && (contact.email || lead.senderEmail));
        if (!hasContact) {
            return {
                eligible: false,
                reason: 'missing_contact_info',
                detail: 'Lead does not satisfy required contact channels'
            };
        }
    }

    return { eligible: true, reason: null };
};

// Stage B: Candidate Scoring (Deterministic relevance score 0 - 100)
LeadMatcher.prototype.computeScore = function(lead, filter) {
    var rawProd = lead.productName || '';
    var normLead = normalizeText(rawProd);
    var leadTokens = tokenize(normLead);
    var leadAttrs = extractAttributes(normLead);

    var prodKws = filter.keywords || filter.product_keywords || (filter.filter_config && filter.filter_config.product_names) || [];
    if (prodKws.length === 0) {
        return { score: 0, matchedKeyword: null, confidence: 0, reasons: ['No product keywords configured'] };
    }

    // Filter-wide attribute requirements
    var filterAllSizes = [];
    var filterAllSpf = null;
    for (var fIdx = 0; fIdx < prodKws.length; fIdx++) {
        var fAttrs = extractAttributes(normalizeText(prodKws[fIdx]));
        if (fAttrs.spf) filterAllSpf = fAttrs.spf;
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

        // Factor 1: Exact phrase match in lead product name (+30 points)
        if (normLead.indexOf(normKw) !== -1) {
            score += 30;
            reasons.push('exact_phrase_match (+30)');
        }

        // Factor 2: Query term coverage (+25 points max proportional to matched tokens)
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

        if (coverage >= 0.7) {
            totalKeywordsMatched++;
        }

        // Factor 3: Attribute agreement (+15 points for strength/SPF, +15 points for size, +10 points for form)
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
                for (var si = 0; si < syns.length; si++) {
                    if (normLead.indexOf(syns[si]) !== -1) {
                        score += 5;
                        reasons.push('synonym_match (' + syns[si] + ': +5)');
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

    // Filter-wide bonus/penalty adjustments:
    // Multi-keyword match bonus: if lead matches multiple criteria in the filter (+15)
    if (totalKeywordsMatched > 1) {
        bestScore += 15;
        bestReasons.push('multi_keyword_coverage (+15)');
    }

    // Filter-wide missing size penalty: if the filter requests specific size (e.g. 50g) and lead has NO size (-15)
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
        return {
            passed: false,
            stage: 'A_ELIGIBILITY',
            reason: elig.reason,
            detail: elig.detail,
            score: 0
        };
    }

    var scoring = this.computeScore(lead, filter);
    if (!scoring.accepted) {
        return {
            passed: false,
            stage: 'B_SCORING',
            reason: 'low_confidence_score',
            score: scoring.score,
            confidence: scoring.confidence,
            reasons: scoring.reasons
        };
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

// Rank candidates: when multiple leads are available, rank by eligibility, relevance score, tie-breaking
LeadMatcher.prototype.rankCandidates = function(leads, filter) {
    var self = this;
    var candidates = [];

    for (var i = 0; i < leads.length; i++) {
        var lead = leads[i];
        var result = self.evaluate(lead, filter);
        if (result.passed) {
            candidates.push({
                lead: lead,
                evaluation: result,
                score: result.score
            });
        }
    }

    // Sort descending by score; tie-break deterministically
    candidates.sort(function(a, b) {
        if (b.score !== a.score) return b.score - a.score;
        // Tie-breaker 1: newest query time / lead age if available
        var tA = a.lead.queryTime || a.lead.detectedAt || 0;
        var tB = b.lead.queryTime || b.lead.detectedAt || 0;
        if (tB !== tA) return tB - tA;
        // Tie-breaker 2: stable ID alphabetical
        return String(a.lead.leadId || a.lead.uniqueQueryId || '').localeCompare(String(b.lead.leadId || b.lead.uniqueQueryId || ''));
    });

    return candidates;
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        normalizeText: normalizeText,
        extractAttributes: extractAttributes,
        tokenize: tokenize,
        wordBoundaryMatch: wordBoundaryMatch,
        LeadMatcher: LeadMatcher
    };
}
