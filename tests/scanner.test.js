var assert = require('assert');

// Incremental Scanner with Top-7 Window Logic
function TopSevenScanner(idGenFn) {
    this._knownIds = new Map(); // id -> timestamp
    this._topWindowIds = [];
    this._maxWindowSize = 7;
}

TopSevenScanner.prototype.processFeedCards = function(cardElements, idExtractor) {
    var rawCards = [];
    for (var i = 0; i < cardElements.length; i++) {
        var el = cardElements[i];
        var id = idExtractor(el);
        if (id) {
            rawCards.push({ id: id, element: el, index: i });
        }
    }

    // Window: only newest 7 cards in feed order
    var topSeven = rawCards.slice(0, this._maxWindowSize);
    var newOrUpdatedCards = [];
    var currentWindowIds = [];

    for (var k = 0; k < topSeven.length; k++) {
        var card = topSeven[k];
        currentWindowIds.push(card.id);

        if (!this._knownIds.has(card.id)) {
            // Genuinely new card in top-7 window!
            this._knownIds.set(card.id, Date.now());
            newOrUpdatedCards.push(card);
        }
    }

    this._topWindowIds = currentWindowIds;
    return {
        topSevenWindow: topSeven,
        newCardsToProcess: newOrUpdatedCards
    };
};

// Unit tests for TopSevenScanner
console.log('\n=== RUNNING SCANNER TOP-7 TESTS ===\n');

var scanner = new TopSevenScanner();
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

// Test 1: Initial feed of 9 cards only yields top 7
var r1 = scanner.processFeedCards(mockFeed, mockIdExtractor);
assert.strictEqual(r1.topSevenWindow.length, 7);
assert.strictEqual(r1.newCardsToProcess.length, 7);
assert.strictEqual(r1.topSevenWindow[0].id, 'c1');
assert.strictEqual(r1.topSevenWindow[6].id, 'c7');
console.log('  ✅ PASS: Top-7 window isolates exactly newest 7 leads, leaves c8 & c9 out');

// Test 2: Unchanged feed returns 0 new cards
var r2 = scanner.processFeedCards(mockFeed, mockIdExtractor);
assert.strictEqual(r2.newCardsToProcess.length, 0);
console.log('  ✅ PASS: Repeated scan without mutations emits 0 new cards');

// Test 3: New lead c0 arrives dynamically at the top
var updatedFeed = [{ id: 'c0', title: 'Brand New Lead' }].concat(mockFeed);
var r3 = scanner.processFeedCards(updatedFeed, mockIdExtractor);
assert.strictEqual(r3.topSevenWindow.length, 7);
assert.strictEqual(r3.newCardsToProcess.length, 1);
assert.strictEqual(r3.newCardsToProcess[0].id, 'c0');
assert.strictEqual(r3.topSevenWindow[0].id, 'c0');
assert.strictEqual(r3.topSevenWindow[6].id, 'c6'); // c7 was pushed to position 8
console.log('  ✅ PASS: Newly prepended lead c0 enters top-7 window and is emitted immediately');

console.log('\nAll Scanner tests passed successfully!\n');
