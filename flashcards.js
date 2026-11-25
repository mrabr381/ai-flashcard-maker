// ai-flashcard-maker — core logic.
// Pure functions, no DOM. Works in the browser (window.Flashcards)
// and in Node (module.exports) so the same code is tested in CI.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Flashcards = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function clean(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  // Split prose into sentences (keeps the trailing punctuation).
  function splitSentences(text) {
    return String(text)
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  // Cloze fallback: blank the longest word (>= 4 letters) in a sentence.
  function clozeCard(sentence) {
    const words = sentence.split(' ');
    let best = -1;
    for (let i = 0; i < words.length; i++) {
      const w = words[i].replace(/[^A-Za-z']/g, '');
      if (w.length >= 4 && w.length > (best < 0 ? 0 : words[best].replace(/[^A-Za-z']/g, '').length)) best = i;
    }
    if (best < 0) return null;
    const answer = words[best].replace(/[^A-Za-z']/g, '');
    const blanked = words.slice();
    blanked[best] = words[best].replace(/[A-Za-z']+/g, '________');
    return { front: 'Fill in the blank: ' + blanked.join(' '), back: answer + ' — ' + sentence };
  }

  // Parse pasted notes into [{ front, back }].
  // Understands, in order:
  //   Q: ... / A: ... blocks (also "Question:" / "Answer:")
  //   Term | Definition   or   Term <TAB> Definition
  //   Term - Definition / Term — Definition / Term :: Definition
  //   Term: Definition   (term must be short)
  // Anything left over becomes cloze cards from its sentences.
  function parseNotes(text) {
    const cards = [];
    const lines = String(text == null ? '' : text).split(/\r?\n/);
    const prose = [];
    let pendingQ = null;

    function flushQ() { pendingQ = null; }

    for (let raw of lines) {
      const line = raw.trim();
      if (!line) { flushQ(); continue; }

      let m = line.match(/^(?:Q|Question)\s*[:.\-]\s*(.+)$/i);
      if (m) { pendingQ = clean(m[1]); continue; }

      m = line.match(/^(?:A|Answer)\s*[:.\-]\s*(.+)$/i);
      if (m && pendingQ) {
        cards.push({ front: pendingQ, back: clean(m[1]) });
        pendingQ = null;
        continue;
      }
      if (m) { prose.push(line); continue; }

      // "Front | Back" or tab-separated.
      m = line.match(/^(.+?)\s*[|\t]\s*(.+)$/);
      if (m && clean(m[1]) && clean(m[2])) {
        cards.push({ front: clean(m[1]), back: clean(m[2]) });
        continue;
      }

      // "1. Term - definition" / "Term — definition" / "Term :: definition"
      m = line.match(/^(?:\d+[.)]\s*)?(.+?)\s*(?:—|–|::|\s+-\s+)\s*(.+)$/);
      if (m && clean(m[1]).split(' ').length <= 6 && clean(m[1]).length <= 60 && clean(m[2]).length >= 2) {
        cards.push({ front: clean(m[1]), back: clean(m[2]) });
        continue;
      }

      // "Term: definition" — term must be short, no sentence-ending punctuation.
      m = line.match(/^([^:;.!?]{1,60})\s*:\s+(.+)$/);
      if (m && clean(m[1]).split(' ').length <= 6 && clean(m[2]).length >= 2) {
        cards.push({ front: clean(m[1]), back: clean(m[2]) });
        continue;
      }

      prose.push(line);
    }

    // Fallback: cloze cards from leftover prose sentences.
    if (prose.length) {
      const sentences = splitSentences(prose.join(' '));
      for (const s of sentences) {
        if (s.split(' ').length < 5) continue;
        const card = clozeCard(s);
        if (card) cards.push(card);
        if (cards.length >= 50) break;
      }
    }
    return cards;
  }

  // --- Anki CSV export -------------------------------------------------
  // Anki's text import reads CSV with " as the quote char; a doubled ""
  // is a literal quote. Fields are always quoted, newlines become <br>
  // so one card stays on one line.
  function csvEscape(field) {
    return '"' + String(field).replace(/\r?\n/g, '<br>').replace(/"/g, '""') + '"';
  }

  function toAnkiCSV(cards) {
    return cards
      .map(function (c) { return csvEscape(c.front) + ',' + csvEscape(c.back); })
      .join('\n') + (cards.length ? '\n' : '');
  }

  // --- Deck state -------------------------------------------------------
  function createDeck(cards) {
    return { cards: cards.slice(), index: 0, flipped: false };
  }

  function current(deck) {
    return deck.cards.length ? deck.cards[deck.index] : null;
  }

  function flip(deck) { deck.flipped = !deck.flipped; return deck; }

  function next(deck) {
    if (!deck.cards.length) return deck;
    deck.index = (deck.index + 1) % deck.cards.length;
    deck.flipped = false;
    return deck;
  }

  function prev(deck) {
    if (!deck.cards.length) return deck;
    deck.index = (deck.index - 1 + deck.cards.length) % deck.cards.length;
    deck.flipped = false;
    return deck;
  }

  function shuffle(deck) {
    for (let i = deck.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = deck.cards[i]; deck.cards[i] = deck.cards[j]; deck.cards[j] = t;
    }
    deck.index = 0;
    deck.flipped = false;
    return deck;
  }

  function progress(deck) {
    return { current: deck.cards.length ? deck.index + 1 : 0, total: deck.cards.length };
  }

  function addCard(cards, front, back) {
    const f = clean(front);
    const b = clean(back);
    if (!f) throw new Error('Front of card is empty.');
    if (!b) throw new Error('Back of card is empty.');
    return cards.concat([{ front: f, back: b }]);
  }

  // --- Gemini BYO-key response parsing ----------------------------------
  // Expects the model reply text to be a JSON array of {front, back}.
  function parseGeminiResponse(data) {
    const parts = data && data.candidates && data.candidates[0] &&
      data.candidates[0].content && data.candidates[0].content.parts;
    if (!parts || !parts.length || typeof parts[0].text !== 'string') {
      throw new Error('Unexpected Gemini response format.');
    }
    let text = parts[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { throw new Error('Gemini did not return valid JSON.'); }
    if (!Array.isArray(parsed)) throw new Error('Gemini did not return a list of cards.');
    const cards = parsed
      .filter(function (c) { return c && typeof c.front === 'string' && typeof c.back === 'string'; })
      .map(function (c) { return { front: clean(c.front), back: clean(c.back) }; })
      .filter(function (c) { return c.front && c.back; });
    if (!cards.length) throw new Error('Gemini returned no usable cards.');
    return cards;
  }

  function geminiPrompt(notes) {
    return 'Turn these study notes into flashcards. Reply with ONLY a JSON array, ' +
      'no other text, no markdown fences, of objects like {"front": "question", "back": "answer"}. ' +
      'Make 8-15 cards, one clear fact per card, front short, back one or two sentences.\n\nNotes:\n' + notes;
  }

  // Sample deck: 10 real cards from Pride and Prejudice (Jane Austen, 1813,
  // public domain). The opening line is quoted verbatim from the novel.
  const SAMPLE_DECK = [
    { front: 'Who wrote Pride and Prejudice?', back: 'Jane Austen.' },
    { front: 'When was Pride and Prejudice published?', back: '1813.' },
    { front: 'What is the opening line of Pride and Prejudice?', back: '"It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife."' },
    { front: 'Who is the heroine of Pride and Prejudice?', back: 'Elizabeth Bennet, the second of five Bennet sisters.' },
    { front: 'Who is the hero of Pride and Prejudice?', back: 'Mr Fitzwilliam Darcy.' },
    { front: 'What is the name of the Bennet family home?', back: 'Longbourn, in Hertfordshire.' },
    { front: 'What is the name of Darcy\u2019s estate?', back: 'Pemberley, in Derbyshire.' },
    { front: 'Who is Elizabeth Bennet\u2019s closest friend?', back: 'Charlotte Lucas, who later marries Mr Collins.' },
    { front: 'How many Bennet sisters are there?', back: 'Five: Jane, Elizabeth, Mary, Kitty (Catherine) and Lydia.' },
    { front: 'Who does Lydia Bennet run away with?', back: 'George Wickham.' }
  ];

  const SAMPLE_NOTES = SAMPLE_DECK.map(function (c) {
    return 'Q: ' + c.front + '\nA: ' + c.back;
  }).join('\n');

  return {
    parseNotes: parseNotes,
    clozeCard: clozeCard,
    csvEscape: csvEscape,
    toAnkiCSV: toAnkiCSV,
    createDeck: createDeck,
    current: current,
    flip: flip,
    next: next,
    prev: prev,
    shuffle: shuffle,
    progress: progress,
    addCard: addCard,
    parseGeminiResponse: parseGeminiResponse,
    geminiPrompt: geminiPrompt,
    SAMPLE_DECK: SAMPLE_DECK,
    SAMPLE_NOTES: SAMPLE_NOTES
  };
});
