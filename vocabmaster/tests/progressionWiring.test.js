const test = require('node:test');
const assert = require('node:assert/strict');
const progressRouter = require('../src/routes/progress');

const { buildProgressionUnlockState, isMasteredPlanWord, selectPlanWordsWithMix, summarizeQueueSources } = progressRouter.__internals;

test('isMasteredPlanWord recognizes mastered learning states from multiple sources', () => {
  assert.equal(isMasteredPlanWord({ learningStatus: 'mastered' }), true);
  assert.equal(isMasteredPlanWord({ masteryStatus: 'mastered' }), true);
  assert.equal(isMasteredPlanWord({ adaptiveMetrics: { masteredAt: '2026-01-01T00:00:00.000Z' } }), true);
  assert.equal(isMasteredPlanWord({ learningStatus: 'locked' }), false);
});

test('buildProgressionUnlockState includes the next module unlock result', () => {
  const snapshot = {
    completedLessons: [
      { date: '2026-01-01T00:00:00.000Z', accuracy: 90, type: 'study', duration: 600 },
      { date: '2026-01-02T00:00:00.000Z', accuracy: 88, type: 'study', duration: 620 },
      { date: '2026-01-03T00:00:00.000Z', accuracy: 92, type: 'study', duration: 640 },
    ],
  };

  const words = [
    { learningStatus: 'mastered', adaptiveMetrics: { masteredAt: '2026-01-01T00:00:00.000Z' } },
    { masteryStatus: 'mastered' },
    { adaptiveMetrics: { masteredAt: '2026-01-02T00:00:00.000Z' } },
    { learningStatus: 'review' },
  ];

  const result = buildProgressionUnlockState(snapshot, words, { targetWordCount: 12 });

  assert.equal(result.moduleId, 'module-2');
  assert.equal(result.completedLessonCount, 3);
  assert.equal(result.masteredWordCount, 3);
  assert.equal(result.totalWordCount, 4);
  assert.equal(result.currentModuleIndex, 2);
  assert.ok(result.reason);
  assert.equal(typeof result.unlocked, 'boolean');
});

test('selectPlanWordsWithMix applies 70/20/10 queue composition when data supports it', () => {
  const words = [];
  for (let i = 0; i < 14; i += 1) {
    words.push({
      _id: `current-${i}`,
      word: `current-${i}`,
      difficulty: 2,
      timesReviewed: 0,
      timesCorrect: 0,
      learningStatus: 'locked',
      adaptiveMetrics: { attempts: 0, correct: 0, itemDifficulty: 40 },
    });
  }
  for (let i = 0; i < 4; i += 1) {
    words.push({
      _id: `stretch-${i}`,
      word: `stretch-${i}`,
      difficulty: 5,
      timesReviewed: 5,
      timesCorrect: 4,
      learningStatus: 'mastered',
      adaptiveMetrics: { attempts: 5, correct: 4, itemDifficulty: 95 },
    });
  }
  for (let i = 0; i < 2; i += 1) {
    words.push({
      _id: `review-${i}`,
      word: `review-${i}`,
      difficulty: 3,
      timesReviewed: 6,
      timesCorrect: 3,
      learningStatus: 'in_progress',
      adaptiveMetrics: {
        attempts: 6,
        correct: 3,
        itemDifficulty: 55,
        dueAt: '2020-01-01T00:00:00.000Z',
      },
    });
  }

  const result = selectPlanWordsWithMix(
    words,
    20,
    { min: 1, max: 3 },
    { abilityScore: 55, heartState: { lowHearts: false }, snapshot: { userId: 'u-mix' } }
  );

  assert.equal(result.selectedWords.length, 20);
  assert.deepEqual(result.queueMix.targetCounts, { current: 14, stretch: 4, review: 2 });
  assert.deepEqual(result.queueMix.counts, { current: 14, stretch: 4, review: 2 });
  assert.equal(result.queueMix.totalRequested, 20);
  const sourceSummary = summarizeQueueSources(result.selectedWords);
  assert.equal(sourceSummary.dueReviewCount + sourceSummary.remediationCount, 2);
});
