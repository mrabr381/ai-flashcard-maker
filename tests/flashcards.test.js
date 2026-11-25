const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../flashcards.js');

// --- notes -> cards parsing ---------------------------------------------

test('parseNotes: Q:/A: blocks', () => {
  const cards = F.parseNotes('Q: Who wrote Pride and Prejudice?\nA: Jane Austen.\nQ: When was it published?\nA: 1813.');
  assert.equal(cards.length, 2);
  assert.deepEqual(cards[0], { front: 'Who wrote Pride and Prejudice?', back: 'Jane Austen.' });
  assert.deepEqual(cards[1], { front: 'When was it published?', back: '1813.' });
});

test('parseNotes: "Question:" / "Answer:" long forms', () => {
  const cards = F.parseNotes('Question: Capital of France?\nAnswer: Paris.');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].back, 'Paris.');
});

test('parseNotes: Term - definition lines', () => {
  const cards = F.parseNotes('Mitochondria - the powerhouse of the cell\nPhotosynthesis — how plants make food');
  assert.equal(cards.length, 2);
  assert.equal(cards[0].front, 'Mitochondria');
  assert.equal(cards[1].front, 'Photosynthesis');
});

test('parseNotes: Term: definition and Front | Back', () => {
  const cards = F.parseNotes('Osmosis: movement of water across a membrane\nBonjour | Hello');
  assert.equal(cards.length, 2);
  assert.equal(cards[0].front, 'Osmosis');
  assert.equal(cards[1].front, 'Bonjour');
  assert.equal(cards[1].back, 'Hello');
});

test('parseNotes: plain prose becomes cloze cards', () => {
  const cards = F.parseNotes('The mitochondria is the powerhouse of the cell and produces energy for the organism.');
  assert.equal(cards.length, 1);
  assert.match(cards[0].front, /________/);
  assert.match(cards[0].back, /mitochondria/i);
});

test('parseNotes: empty input gives no cards', () => {
  assert.deepEqual(F.parseNotes(''), []);
  assert.deepEqual(F.parseNotes('   \n  '), []);
});

test('parseNotes: sample notes parse into the 10-card sample deck', () => {
  const cards = F.parseNotes(F.SAMPLE_NOTES);
  assert.equal(cards.length, 10);
  assert.equal(cards[0].back, 'Jane Austen.');
  assert.match(cards[2].back, /universally acknowledged/);
});

// --- Anki CSV export ----------------------------------------------------

test('toAnkiCSV: basic two-column output', () => {
  const csv = F.toAnkiCSV([{ front: 'Q1', back: 'A1' }, { front: 'Q2', back: 'A2' }]);
  assert.equal(csv, '"Q1","A1"\n"Q2","A2"\n');
});

test('toAnkiCSV: quotes, commas and newlines are escaped', () => {
  const csv = F.toAnkiCSV([{ front: 'He said "hi", then left', back: 'line one\nline two' }]);
  assert.equal(csv, '"He said ""hi"", then left","line one<br>line two"\n');
});

test('toAnkiCSV: empty deck gives empty string', () => {
  assert.equal(F.toAnkiCSV([]), '');
});

test('toAnkiCSV: every sample-deck card exports on exactly one line', () => {
  const lines = F.toAnkiCSV(F.SAMPLE_DECK).trim().split('\n');
  assert.equal(lines.length, 10);
  for (const line of lines) assert.match(line, /^".*",".*"$/);
});

// --- deck navigation / flip state ---------------------------------------

test('deck: next/prev wrap around, flip resets on move', () => {
  const deck = F.createDeck([{ front: 'a', back: 'A' }, { front: 'b', back: 'B' }, { front: 'c', back: 'C' }]);
  assert.equal(F.current(deck).front, 'a');
  F.next(deck); assert.equal(F.current(deck).front, 'b');
  F.flip(deck); assert.equal(deck.flipped, true);
  F.next(deck); assert.equal(deck.flipped, false); // moving resets flip
  assert.equal(F.current(deck).front, 'c');
  F.next(deck); assert.equal(F.current(deck).front, 'a'); // wraps
  F.prev(deck); assert.equal(F.current(deck).front, 'c'); // wraps back
});

test('deck: flip toggles', () => {
  const deck = F.createDeck([{ front: 'a', back: 'A' }]);
  F.flip(deck); assert.equal(deck.flipped, true);
  F.flip(deck); assert.equal(deck.flipped, false);
});

test('deck: progress counts 1-based position', () => {
  const deck = F.createDeck([{ front: 'a', back: 'A' }, { front: 'b', back: 'B' }]);
  assert.deepEqual(F.progress(deck), { current: 1, total: 2 });
  F.next(deck);
  assert.deepEqual(F.progress(deck), { current: 2, total: 2 });
});

test('deck: shuffle keeps every card, resets to first', () => {
  const cards = [{ front: 'a', back: 'A' }, { front: 'b', back: 'B' }, { front: 'c', back: 'C' }, { front: 'd', back: 'D' }];
  const deck = F.createDeck(cards);
  F.next(deck); F.next(deck);
  F.shuffle(deck);
  assert.equal(deck.index, 0);
  assert.deepEqual(deck.cards.map((c) => c.front).sort(), ['a', 'b', 'c', 'd']);
});

test('deck: empty deck is safe', () => {
  const deck = F.createDeck([]);
  assert.equal(F.current(deck), null);
  assert.deepEqual(F.progress(deck), { current: 0, total: 0 });
  F.next(deck); F.prev(deck); F.flip(deck); // must not throw
});

// --- manual add-card ------------------------------------------------------

test('addCard: appends a trimmed card', () => {
  const cards = F.addCard([], '  Front  ', ' Back ');
  assert.deepEqual(cards, [{ front: 'Front', back: 'Back' }]);
});

test('addCard: rejects an empty front or back', () => {
  assert.throws(() => F.addCard([], '', 'back'), /Front/);
  assert.throws(() => F.addCard([], 'front', '   '), /Back/);
});

// --- Gemini response parsing ---------------------------------------------

test('parseGeminiResponse: parses a JSON array, drops bad entries', () => {
  const data = { candidates: [{ content: { parts: [{ text: '[{"front":"Q","back":"A"},{"front":"","back":"x"},42]' }] } }] };
  assert.deepEqual(F.parseGeminiResponse(data), [{ front: 'Q', back: 'A' }]);
});

test('parseGeminiResponse: strips markdown fences', () => {
  const data = { candidates: [{ content: { parts: [{ text: '```json\n[{"front":"Q","back":"A"}]\n```' }] } }] };
  assert.deepEqual(F.parseGeminiResponse(data), [{ front: 'Q', back: 'A' }]);
});

test('parseGeminiResponse: rejects non-JSON and empty results', () => {
  const bad = { candidates: [{ content: { parts: [{ text: 'not json' }] } }] };
  assert.throws(() => F.parseGeminiResponse(bad), /valid JSON/);
  assert.throws(() => F.parseGeminiResponse({}), /Unexpected/);
  const empty = { candidates: [{ content: { parts: [{ text: '[]' }] } }] };
  assert.throws(() => F.parseGeminiResponse(empty), /no usable cards/);
});
