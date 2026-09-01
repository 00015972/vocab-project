const test = require('node:test');
const assert = require('node:assert/strict');

const studyRouter = require('../src/routes/study');
const fsrsScheduler = require('../src/utils/fsrsScheduler');
const CardState = require('../src/models/CardState');
const Word = require('../src/models/Word');

const { normalizeGrade, resolveReviewGrade, markLapse, scheduleNextReview, queueDueCards } = studyRouter.__internals;

test('normalizeGrade accepts numeric and verbal grades', () => {
  assert.equal(normalizeGrade('again'), '1');
  assert.equal(normalizeGrade('hard'), '2');
  assert.equal(normalizeGrade('good'), '3');
  assert.equal(normalizeGrade('easy'), '4');
  assert.equal(normalizeGrade('4'), '4');
  assert.equal(normalizeGrade('unknown', '2'), '2');
});

test('resolveReviewGrade never upgrades incorrect answers to success grades', () => {
  assert.equal(resolveReviewGrade({ correct: false, grade: 'easy' }), '1');
  assert.equal(resolveReviewGrade({ correct: false, grade: 'good' }), '1');
  assert.equal(resolveReviewGrade({ correct: false, grade: '2' }), '1');
});

test('resolveReviewGrade normalizes successful answers and avoids fail grade', () => {
  assert.equal(resolveReviewGrade({ correct: true, grade: 'hard' }), '2');
  assert.equal(resolveReviewGrade({ correct: true, grade: 'again' }), '3');
  assert.equal(resolveReviewGrade({ correct: true, grade: 'unknown' }), '3');
});

test('markLapse increments lapses and resets streak', () => {
  const card = { lapses: 2, streak: 5 };
  markLapse(card);

  assert.equal(card.lapses, 3);
  assert.equal(card.streak, 0);
});

test('scheduleNextReview applies a successful review update', () => {
  const card = {
    stability: 2,
    difficulty: 4,
    state: 'review',
    reps: 3,
    repetitionCount: 3,
    lapses: 1,
    totalCorrect: 2,
    totalAttempts: 4,
    streak: 2,
    easeFactor: 2.5,
  };

  const before = Date.now();
  scheduleNextReview(card, 'good');

  assert.equal(card.reps, 4);
  assert.equal(card.repetitionCount, 4);
  assert.equal(card.totalAttempts, 5);
  assert.equal(card.totalCorrect, 3);
  assert.equal(card.lapses, 1);
  assert.equal(card.streak, 3);
  assert.ok(card.nextReviewAt instanceof Date);
  assert.ok(card.nextReview instanceof Date);
  assert.ok(card.nextReviewAt.getTime() > before);
  assert.ok(card.easeFactor >= 1.3 && card.easeFactor <= 3.2);
});

test('scheduleNextReview failure marks lapse and does not increment totalCorrect', () => {
  const card = {
    stability: 5,
    difficulty: 6,
    state: 'review',
    reps: 1,
    repetitionCount: 1,
    lapses: 0,
    totalCorrect: 1,
    totalAttempts: 1,
    streak: 1,
    easeFactor: 2.4,
  };

  scheduleNextReview(card, 'again');

  assert.equal(card.reps, 2);
  assert.equal(card.repetitionCount, 2);
  assert.equal(card.totalAttempts, 2);
  assert.equal(card.totalCorrect, 1);
  assert.equal(card.lapses, 1);
  assert.equal(card.streak, 0);
});

test('scheduleNextReview handles zero-valued FSRS updates safely', () => {
  const original = fsrsScheduler.calculateNextInterval;
  fsrsScheduler.calculateNextInterval = () => ({
    nextInterval: 1,
    newStability: 0,
    newDifficulty: 0,
    state: 'learning',
  });

  try {
    const card = {
      stability: 4,
      difficulty: 7,
      state: 'review',
      reps: 0,
      repetitionCount: 0,
      lapses: 0,
      totalCorrect: 0,
      totalAttempts: 0,
      streak: 0,
      easeFactor: 2.5,
    };

    scheduleNextReview(card, 'again');

    assert.equal(card.stability, 0);
    assert.equal(card.difficulty, 0);
  } finally {
    fsrsScheduler.calculateNextInterval = original;
  }
});

test('queueDueCards preserves due-order and applies deck filter', async () => {
  const originalCardFind = CardState.find;
  const originalWordFind = Word.find;

  const dueCards = [
    { wordId: 'w2', nextReviewAt: new Date('2026-01-01T00:00:00Z'), stability: 3, difficulty: 4, easeFactor: 2.4, reps: 2, repetitionCount: 2, lapses: 1, state: 'review' },
    { wordId: 'w1', nextReviewAt: new Date('2026-01-01T01:00:00Z'), stability: 2, difficulty: 5, easeFactor: 2.5, reps: 1, repetitionCount: 1, lapses: 0, state: 'learning' },
    { wordId: 'w3', nextReviewAt: new Date('2026-01-01T02:00:00Z'), stability: 1, difficulty: 6, easeFactor: 2.3, reps: 4, repetitionCount: 4, lapses: 2, state: 'review' },
  ];

  const words = [
    { _id: 'w1', word: 'alpha', deckId: 'deck-a' },
    { _id: 'w2', word: 'beta', deckId: 'deck-a' },
    { _id: 'w3', word: 'gamma', deckId: 'deck-b' },
  ];

  CardState.find = () => {
    const chain = {
      _limit: null,
      sort() { return this; },
      limit(value) { this._limit = value; return this; },
      async lean() {
        return this._limit ? dueCards.slice(0, this._limit) : dueCards;
      },
    };
    return chain;
  };

  Word.find = () => ({
    async lean() {
      // Intentionally shuffled to verify due-card order is respected.
      return [words[2], words[0], words[1]];
    },
  });

  try {
    const result = await queueDueCards('user-1', 'not-a-date', { deckId: 'deck-a', limit: 2 });

    assert.equal(result.count, 2);
    assert.equal(result.cards[0].word, 'beta');
    assert.equal(result.cards[1].word, 'alpha');
    assert.ok(result.cards[0].cardState.nextReviewAt);
  } finally {
    CardState.find = originalCardFind;
    Word.find = originalWordFind;
  }
});

test('queueDueCards query protects against null nextReviewAt false-positives', async () => {
  const originalCardFind = CardState.find;
  const originalWordFind = Word.find;

  let capturedQuery = null;

  CardState.find = (query) => {
    capturedQuery = query;
    return {
      sort() { return this; },
      limit() { return this; },
      async lean() { return []; },
    };
  };

  Word.find = () => ({
    async lean() {
      return [];
    },
  });

  try {
    await queueDueCards('user-1', new Date('2026-01-01T00:00:00Z'), { limit: 5 });

    assert.ok(capturedQuery);
    assert.ok(Array.isArray(capturedQuery.$or));
    assert.equal(capturedQuery.$or[0].nextReviewAt.$type, 'date');
    assert.equal(capturedQuery.$or[1].$and[1].nextReview.$type, 'date');
  } finally {
    CardState.find = originalCardFind;
    Word.find = originalWordFind;
  }
});

test('queueDueCards orders by effective due date when nextReviewAt is missing', async () => {
  const originalCardFind = CardState.find;
  const originalWordFind = Word.find;

  const dueCards = [
    { wordId: 'wa', nextReviewAt: null, nextReview: new Date('2026-01-01T03:00:00Z'), stability: 1, difficulty: 4, reps: 1, repetitionCount: 1, lapses: 0, state: 'review' },
    { wordId: 'wb', nextReviewAt: new Date('2026-01-01T01:00:00Z'), nextReview: new Date('2026-01-01T04:00:00Z'), stability: 2, difficulty: 4, reps: 2, repetitionCount: 2, lapses: 0, state: 'review' },
    { wordId: 'wc', nextReviewAt: null, nextReview: new Date('2026-01-01T02:00:00Z'), stability: 3, difficulty: 4, reps: 3, repetitionCount: 3, lapses: 0, state: 'review' },
  ];

  const words = [
    { _id: 'wa', word: 'a' },
    { _id: 'wb', word: 'b' },
    { _id: 'wc', word: 'c' },
  ];

  CardState.find = () => ({
    sort() { return this; },
    limit() { return this; },
    async lean() { return dueCards; },
  });

  Word.find = () => ({
    async lean() {
      return words;
    },
  });

  try {
    const result = await queueDueCards('user-1', new Date('2026-01-01T05:00:00Z'), { limit: 3 });
    assert.equal(result.count, 3);
    assert.equal(result.cards[0].word, 'b');
    assert.equal(result.cards[1].word, 'c');
    assert.equal(result.cards[2].word, 'a');
  } finally {
    CardState.find = originalCardFind;
    Word.find = originalWordFind;
  }
});
