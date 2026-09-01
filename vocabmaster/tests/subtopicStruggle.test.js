const test = require('node:test');
const assert = require('node:assert/strict');

const { detectSubtopicStruggle } = require('../src/services/subtopicStruggle');
const progressRouter = require('../src/routes/progress');

const { buildSubtopicPerfWindow } = progressRouter.__internals;

test('detectSubtopicStruggle flags subtopic below 50% with enough recent attempts', () => {
  const perfWindow = [
    { subtopic: 'verbs', correctCount: 0, totalCount: 2, at: '2026-08-06T10:00:00.000Z' },
    { subtopic: 'verbs', correctCount: 1, totalCount: 2, at: '2026-08-06T09:59:00.000Z' },
    { subtopic: 'nouns', correctCount: 2, totalCount: 2, at: '2026-08-06T09:58:00.000Z' },
  ];

  const result = detectSubtopicStruggle(perfWindow, {
    accuracyThresholdPct: 50,
    recentWindow: 12,
    minAttempts: 4,
  });

  assert.equal(result.active, true);
  assert.equal(result.primarySubtopic.subtopic, 'verbs');
  assert.equal(result.primarySubtopic.accuracyPct < 50, true);
  assert.equal(result.primarySubtopic.attempts, 4);
});

test('detectSubtopicStruggle does not flag low sample-size subtopic', () => {
  const perfWindow = [
    { subtopic: 'idioms', correctCount: 0, totalCount: 1, at: '2026-08-06T10:00:00.000Z' },
    { subtopic: 'idioms', correctCount: 0, totalCount: 1, at: '2026-08-06T09:58:00.000Z' },
    { subtopic: 'idioms', correctCount: 1, totalCount: 1, at: '2026-08-06T09:57:00.000Z' },
  ];

  const result = detectSubtopicStruggle(perfWindow, {
    accuracyThresholdPct: 50,
    recentWindow: 12,
    minAttempts: 4,
  });

  assert.equal(result.active, false);
  assert.equal(result.strugglingSubtopics.length, 0);
});

test('detectSubtopicStruggle obeys recency window and can ignore stale failures', () => {
  const perfWindow = [
    { subtopic: 'collocations', correctCount: 1, totalCount: 1, at: '2026-08-06T10:00:00.000Z' },
    { subtopic: 'collocations', correctCount: 1, totalCount: 1, at: '2026-08-06T09:59:00.000Z' },
    { subtopic: 'collocations', correctCount: 0, totalCount: 2, at: '2026-08-04T08:00:00.000Z' },
    { subtopic: 'collocations', correctCount: 0, totalCount: 2, at: '2026-08-04T07:00:00.000Z' },
  ];

  const recentOnly = detectSubtopicStruggle(perfWindow, {
    accuracyThresholdPct: 50,
    recentWindow: 2,
    minAttempts: 2,
  });

  const widerWindow = detectSubtopicStruggle(perfWindow, {
    accuracyThresholdPct: 50,
    recentWindow: 8,
    minAttempts: 2,
  });

  assert.equal(recentOnly.active, false);
  assert.equal(widerWindow.active, true);
});

test('buildSubtopicPerfWindow extracts tag/domain subtopics from words', () => {
  const words = [
    {
      word: 'abate',
      tags: ['grammar', 'verbs'],
      domain: 'academic',
      adaptiveMetrics: { attempts: 6, correct: 2, lastAttemptAt: '2026-08-06T09:00:00.000Z' },
      timesReviewed: 6,
      timesCorrect: 2,
    },
    {
      word: 'novice',
      tags: ['nouns'],
      domain: 'general',
      adaptiveMetrics: { attempts: 3, correct: 3, lastAttemptAt: '2026-08-06T09:05:00.000Z' },
      timesReviewed: 3,
      timesCorrect: 3,
    },
  ];

  const perfWindow = buildSubtopicPerfWindow(words, { maxAttemptsPerWord: 3 });

  assert.equal(Array.isArray(perfWindow), true);
  assert.equal(perfWindow.length >= 4, true);
  const labels = new Set(perfWindow.map((row) => row.subtopic));
  assert.equal(labels.has('verbs'), true);
  assert.equal(labels.has('academic'), true);
  assert.equal(labels.has('nouns'), true);
});

test('detectSubtopicStruggle applies recency window per subtopic, not globally', () => {
  const perfWindow = [
    { subtopic: 'nouns', correctCount: 1, totalCount: 1, at: '2026-08-06T10:00:00.000Z' },
    { subtopic: 'nouns', correctCount: 1, totalCount: 1, at: '2026-08-06T09:59:00.000Z' },
    { subtopic: 'nouns', correctCount: 1, totalCount: 1, at: '2026-08-06T09:58:00.000Z' },
    { subtopic: 'nouns', correctCount: 1, totalCount: 1, at: '2026-08-06T09:57:00.000Z' },
    { subtopic: 'verbs', correctCount: 0, totalCount: 2, at: '2026-08-06T09:00:00.000Z' },
    { subtopic: 'verbs', correctCount: 1, totalCount: 2, at: '2026-08-06T08:59:00.000Z' },
  ];

  const result = detectSubtopicStruggle(perfWindow, {
    accuracyThresholdPct: 50,
    recentWindow: 4,
    minAttempts: 4,
  });

  assert.equal(result.active, true);
  assert.equal(result.primarySubtopic.subtopic, 'verbs');
  assert.equal(result.primarySubtopic.accuracyPct, 25);
});
