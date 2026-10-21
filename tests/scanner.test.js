var assert = require('assert');

// Incremental Scanner with Top-5 Window Logic
function TopFiveScanner(idGenFn) {
    this._knownIds = new Map(); // id -> timestamp
    this._topWindowIds = [];
    this._maxWindowSize = 5;
}
var TopSevenScanner = TopFiveScanner;

TopFiveScanner.prototype.processFeedCards = function(cardElements, idExtractor) {
    var rawCards = [];
    for (var i = 0; i < cardElements.length; i++) {
        var el = cardElements[i];
        var id = idExtractor(el);
        if (id) {
            rawCards.push({ id: id, element: el, index: i });
        }
    }

    // Window: only newest 5 cards in feed order
    var topFive = rawCards.slice(0, this._maxWindowSize);
    var newOrUpdatedCards = [];
    var currentWindowIds = [];

    for (var k = 0; k < topFive.length; k++) {
        var card = topFive[k];
        currentWindowIds.push(card.id);

        if (!this._knownIds.has(card.id)) {
            // Genuinely new card in top-5 window!
            this._knownIds.set(card.id, Date.now());
            newOrUpdatedCards.push(card);
        }
    }

    this._topWindowIds = currentWindowIds;
    return {
        topFiveWindow: topFive,
        topSevenWindow: topFive,
        newCardsToProcess: newOrUpdatedCards
    };
};

// Unit tests for TopFiveScanner
console.log('\n=== RUNNING SCANNER TOP-5 TESTS ===\n');

var scanner = new TopFiveScanner();
var mockFeed = [
    { id: 'c1', title: 'Lead 1' },
    { id: 'c2', title: 'Lead 2' },
    { id: 'c3', title: 'Lead 3' },
    { id: 'c4', title: 'Lead 4' },
    { id: 'c5', title: 'Lead 5' },
    { id: 'c6', title: 'Lead 6' },
    { id: 'c7', title: 'Lead 7' },
    { id: 'c8', title: 'Lead 8' },
    { id: 'c9', title: 'Lead 9' }
];

function mockIdExtractor(el) { return el.id; }

// Test 1: Initial feed of 9 cards only yields top 5
var r1 = scanner.processFeedCards(mockFeed, mockIdExtractor);
assert.strictEqual(r1.topFiveWindow.length, 5);
assert.strictEqual(r1.newCardsToProcess.length, 5);
assert.strictEqual(r1.topFiveWindow[0].id, 'c1');
assert.strictEqual(r1.topFiveWindow[4].id, 'c5');
console.log('  ✅ PASS: Top-5 window isolates exactly newest 5 leads, leaves c6-c9 out');

// Test 2: Unchanged feed returns 0 new cards
var r2 = scanner.processFeedCards(mockFeed, mockIdExtractor);
assert.strictEqual(r2.newCardsToProcess.length, 0);
console.log('  ✅ PASS: Repeated scan without mutations emits 0 new cards');

// Test 3: New lead c0 arrives dynamically at the top
var updatedFeed = [{ id: 'c0', title: 'Brand New Lead' }].concat(mockFeed);
var r3 = scanner.processFeedCards(updatedFeed, mockIdExtractor);
assert.strictEqual(r3.topFiveWindow.length, 5);
assert.strictEqual(r3.newCardsToProcess.length, 1);
assert.strictEqual(r3.newCardsToProcess[0].id, 'c0');
assert.strictEqual(r3.topFiveWindow[0].id, 'c0');
assert.strictEqual(r3.topFiveWindow[4].id, 'c4'); // c5 was pushed to position 6
console.log('  ✅ PASS: Newly prepended lead c0 enters top-5 window and is emitted immediately');

console.log('\nAll Scanner tests passed successfully!\n');
