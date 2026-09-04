const test = require('node:test');
const assert = require('node:assert/strict');

const progressRouter = require('../src/routes/progress');

const {
  normalizeProgressSnapshot,
  buildDailyPlanFromProfile,
  normalizeDifficultyBand,
  selectPlanWordsWithMix,
} = progressRouter.__internals;

function mkWord(id, source) {
  const base = {
    _id: String(id),
    word: String(id),
    definition: `definition-${id}`,
    adaptiveMetrics: { attempts: 0, correct: 0, itemDifficulty: 50 },
    timesReviewed: 0,
    timesCorrect: 0,
    difficulty: 3,
    learningStatus: 'new',
  };

  if (source === 'current') {
    return {
      ...base,
      difficulty: 2,
      learningStatus: 'locked',
      adaptiveMetrics: { attempts: 0, correct: 0, itemDifficulty: 25 },
    };
  }

  if (source === 'stretch') {
    return {
      ...base,
      difficulty: 5,
      learningStatus: 'mastered',
      timesReviewed: 5,
      timesCorrect: 4,
      adaptiveMetrics: { attempts: 5, correct: 4, itemDifficulty: 95 },
    };
  }

  return {
    ...base,
    difficulty: 3,
    learningStatus: 'review',
    timesReviewed: 6,
    timesCorrect: 3,
    adaptiveMetrics: {
      attempts: 6,
      correct: 3,
      itemDifficulty: 55,
      dueAt: '2020-01-01T00:00:00.000Z',
    },
  };
}

function buildSufficientPool() {
  const words = [];
  for (let i = 0; i < 14; i += 1) words.push(mkWord(`current-${i}`, 'current'));
  for (let i = 0; i < 4; i += 1) words.push(mkWord(`stretch-${i}`, 'stretch'));
  for (let i = 0; i < 2; i += 1) words.push(mkWord(`review-${i}`, 'review'));
  return words;
}

test('Part1: diagnostic level assigns the expected difficulty band', () => {
  const cases = [
    { targetLevel: 'A1', expected: { min: 1, max: 2, label: 'A1 Beginner' } },
    { targetLevel: 'A2', expected: { min: 2, max: 3, label: 'A2 Elementary' } },
    { targetLevel: 'B1', expected: { min: 3, max: 4, label: 'B1 Intermediate' } },
    { targetLevel: 'B2', expected: { min: 3, max: 5, label: 'B2 Upper-Intermediate' } },
    { targetLevel: 'C1', expected: { min: 4, max: 5, label: 'C1 Advanced' } },
    { targetLevel: 'C2', expected: { min: 5, max: 5, label: 'C2 Proficient' } },
  ];

  for (const entry of cases) {
    const rawProgress = {
      userId: `u-${entry.targetLevel}`,
      adaptiveProfile: {
        targetLevel: entry.targetLevel,
        abilityScore: 55,
      },
    };

    const snapshot = normalizeProgressSnapshot(rawProgress, rawProgress.userId);
    const plan = buildDailyPlanFromProfile(snapshot, { minutes: 20, wordCount: 16, hearts: 5 });
    const band = normalizeDifficultyBand({
      targetLevel: plan.diagnosticLevel,
      inferredLevel: 10,
    });

    assert.equal(plan.diagnosticLevel, entry.targetLevel);
    assert.equal(band.level, entry.targetLevel);
    assert.equal(band.min, entry.expected.min);
    assert.equal(band.max, entry.expected.max);
    assert.equal(band.label, entry.expected.label);
  }
});

test('Part1: AUTO band honors inferred diagnostic CEFR level', () => {
  const band = normalizeDifficultyBand({
    targetLevel: 'AUTO',
    inferredLevel: 'B2',
  });

  assert.equal(band.level, 'B2');
  assert.equal(band.label, 'B2 Upper-Intermediate');
  assert.equal(band.min, 3);
  assert.equal(band.max, 5);
});

test('Part1: 70/20/10 queue distribution is respected when supply is sufficient', () => {
  const words = buildSufficientPool();
  const band = normalizeDifficultyBand({ targetLevel: 'A2', inferredLevel: 8 });
  const planProfile = {
    abilityScore: 58,
    heartState: { lowHearts: false },
    snapshot: { userId: 'u-part1' },
  };

  const result = selectPlanWordsWithMix(words, 20, band, planProfile);

  assert.equal(result.selectedWords.length, 20);
  assert.deepEqual(result.queueMix.targetCounts, { current: 14, stretch: 4, review: 2 });
  assert.deepEqual(result.queueMix.counts, { current: 14, stretch: 4, review: 2 });
  assert.equal(result.queueMix.totalRequested, 20);
  assert.equal(result.queueMix.ratios.current, 0.7);
  assert.equal(result.queueMix.ratios.stretch, 0.2);
  assert.equal(result.queueMix.ratios.review, 0.1);
});
