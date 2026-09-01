const test = require('node:test');
const assert = require('node:assert/strict');
const {
  expectedSuccess,
  isKnownCorrectness,
  normalizeItemDifficulty,
  updateAbilityEstimate,
  updateItemDifficulty,
  difficultyBandFromAbilityScore,
} = require('../src/services/irtLite');

test('expectedSuccess increases when ability is higher than item difficulty', () => {
  const low = expectedSuccess(25, 75);
  const high = expectedSuccess(75, 25);

  assert.ok(high > low);
  assert.ok(high <= 0.99);
  assert.ok(low >= 0.01);
});

test('normalizeItemDifficulty maps 1..5 to 0..100 scale', () => {
  assert.equal(normalizeItemDifficulty(1), 0);
  assert.equal(normalizeItemDifficulty(3), 50);
  assert.equal(normalizeItemDifficulty(5), 100);
});

test('updateAbilityEstimate raises ability after a strong correct answer', () => {
  const state = {
    userId: 'u-1',
    adaptiveProfile: {
      abilityScore: 40,
      targetLevel: 'A1',
      difficultyBand: { min: 1, max: 2 },
      behaviorSignals: { baselineLatencyMs: 2200 },
    },
  };

  const result = updateAbilityEstimate(state, {
    correctness: true,
    itemDifficulty: 50,
  }, 900);

  assert.ok(result);
  assert.ok(result.nextAbility > result.previousAbility);
  assert.ok(state.adaptiveProfile.abilityScore > 40);
});

test('updateAbilityEstimate lowers ability after a fast incorrect answer', () => {
  const state = {
    userId: 'u-2',
    adaptiveProfile: {
      abilityScore: 70,
      targetLevel: 'B1',
      difficultyBand: { min: 3, max: 4 },
      behaviorSignals: { baselineLatencyMs: 2200 },
    },
  };

  const result = updateAbilityEstimate(state, {
    correctness: false,
    itemDifficulty: 45,
  }, 500);

  assert.ok(result);
  assert.ok(result.nextAbility < result.previousAbility);
  assert.ok(state.adaptiveProfile.abilityScore < 70);
});

test('difficultyBandFromAbilityScore returns expected cutoffs', () => {
  assert.deepEqual(difficultyBandFromAbilityScore(49), { min: 1, max: 2 });
  assert.deepEqual(difficultyBandFromAbilityScore(50), { min: 2, max: 3 });
  assert.deepEqual(difficultyBandFromAbilityScore(80), { min: 3, max: 5 });
  assert.deepEqual(difficultyBandFromAbilityScore(96), { min: 5, max: 5 });
});

test('updateItemDifficulty increases difficulty after an incorrect answer when expected correct rate is high', () => {
  const word = {
    word: 'abate',
    difficulty: 2,
    adaptiveMetrics: { itemDifficulty: 20 },
  };

  const result = updateItemDifficulty(word, false, { correctRate: 0.8, sampleSize: 120 });

  assert.ok(result);
  assert.ok(result.nextDifficulty > result.previousDifficulty);
  assert.ok(word.adaptiveMetrics.itemDifficulty > 20);
  assert.ok(word.difficulty >= 1 && word.difficulty <= 5);
});

test('updateItemDifficulty lowers difficulty after a correct answer when expected correct rate is low', () => {
  const word = {
    word: 'obfuscate',
    difficulty: 4.5,
    adaptiveMetrics: { itemDifficulty: 85 },
  };

  const result = updateItemDifficulty(word, true, { correctRate: 0.35, sampleSize: 150 });

  assert.ok(result);
  assert.ok(result.nextDifficulty < result.previousDifficulty);
  assert.ok(word.adaptiveMetrics.itemDifficulty < 85);
  assert.ok(word.difficulty >= 1 && word.difficulty <= 5);
});

test('updateItemDifficulty accepts percentage-style correctRate values', () => {
  const word = {
    word: 'lucid',
    difficulty: 3,
    adaptiveMetrics: { itemDifficulty: 50 },
  };

  const result = updateItemDifficulty(word, false, { correctRate: 80, sampleSize: 120 });

  assert.ok(result);
  assert.equal(result.referenceCorrectRate, 0.8);
  assert.ok(result.nextDifficulty > result.previousDifficulty);
});

test('updateItemDifficulty falls back to mapped base difficulty when adaptiveMetrics.itemDifficulty is missing', () => {
  const word = {
    word: 'steady',
    difficulty: 4,
  };

  const result = updateItemDifficulty(word, true, { correctRate: 0.6, sampleSize: 60 });

  assert.ok(result);
  assert.equal(result.previousDifficulty, normalizeItemDifficulty(4));
  assert.ok(typeof word.adaptiveMetrics.itemDifficulty === 'number');
});

test('isKnownCorrectness distinguishes supported correctness values', () => {
  assert.equal(isKnownCorrectness(true), true);
  assert.equal(isKnownCorrectness('false'), true);
  assert.equal(isKnownCorrectness(1), true);
  assert.equal(isKnownCorrectness('maybe'), false);
  assert.equal(isKnownCorrectness(null), false);
});

test('updateAbilityEstimate ignores malformed correctness payloads', () => {
  const state = {
    userId: 'u-3',
    adaptiveProfile: {
      abilityScore: 63,
      targetLevel: 'A2',
      difficultyBand: { min: 2, max: 3 },
      behaviorSignals: { baselineLatencyMs: 2200 },
    },
  };

  const result = updateAbilityEstimate(state, {
    correctness: 'maybe',
    itemDifficulty: 52,
  }, 900);

  assert.ok(result);
  assert.equal(result.ignored, true);
  assert.equal(result.delta, 0);
  assert.equal(result.nextAbility, 63);
  assert.equal(state.adaptiveProfile.abilityScore, 63);
});

test('updateItemDifficulty ignores malformed correctness payloads', () => {
  const word = {
    word: 'stable',
    difficulty: 3.4,
    adaptiveMetrics: { itemDifficulty: 61 },
  };

  const result = updateItemDifficulty(word, 'unknown', { correctRate: 0.45, sampleSize: 40 });

  assert.ok(result);
  assert.equal(result.ignored, true);
  assert.equal(result.delta, 0);
  assert.equal(result.nextDifficulty, 61);
  assert.equal(word.adaptiveMetrics.itemDifficulty, 61);
  assert.equal(word.difficulty, 3.4);
});
