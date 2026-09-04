const assert = require('assert');
const {
  classifyAttemptBehavior,
  computeConfidenceScore,
  isKnownCorrectness,
  normalizeCorrectness,
  updateBehaviorSignals,
} = require('../src/services/behaviorAnalytics');
const { updateAbilityEstimate, updateItemDifficulty } = require('../src/services/irtLite');

function run() {
  const fastGuess = classifyAttemptBehavior(300, false, 2200);
  assert.strictEqual(fastGuess, 'fast_guess_wrong');

  const slowStruggle = classifyAttemptBehavior(5000, 'false', 2200);
  assert.strictEqual(slowStruggle, 'slow_struggle_wrong');

  const confident = classifyAttemptBehavior(700, true, 2200);
  assert.strictEqual(confident, 'confident_correct');

  const confidence = computeConfidenceScore({ behavior: 'fast_guess_wrong', accuracy: 0, latencyRatio: 0.2 });
  assert.ok(confidence < 0.3, `expected low confidence for fast guesses, got ${confidence}`);

  assert.strictEqual(normalizeCorrectness('TRUE'), true);
  assert.strictEqual(normalizeCorrectness('false'), false);
  assert.strictEqual(normalizeCorrectness('maybe'), false);
  assert.strictEqual(isKnownCorrectness('maybe'), false);
  assert.strictEqual(isKnownCorrectness('true'), true);

  const abilityState = { adaptiveProfile: { abilityScore: 50, difficultyBand: { min: 1, max: 2 }, behaviorSignals: { baselineLatencyMs: 2200 } } };
  const abilityResult = updateAbilityEstimate(abilityState, { correctness: 'false', itemDifficulty: 50 }, 3000);
  assert.ok(abilityResult.nextAbility <= 50, `expected ability to stay flat or drop for false answers, got ${abilityResult.nextAbility}`);

  const wordState = { difficulty: 3, adaptiveMetrics: { itemDifficulty: 50 } };
  const itemResult = updateItemDifficulty(wordState, 'false', { correctRate: 0.2, sampleSize: 2 });
  assert.ok(itemResult.nextDifficulty >= 50, `expected item difficulty to increase for false answers, got ${itemResult.nextDifficulty}`);

  const userState = {
    userId: 'user-1',
    adaptiveProfile: {
      behaviorSignals: {
        baselineLatencyMs: 2200,
        confidenceScore: 0.6,
        fastGuessRate: 0,
        slowStruggleRate: 0,
        recentBehaviors: [],
        updatedAt: null,
      },
    },
  };

  const signals = updateBehaviorSignals(userState, {
    attempts: [
      { latencyMs: 250, correctness: false },
      { latencyMs: 5000, correctness: 'false' },
      { latencyMs: 1200, correctness: 1 },
    ],
  });

  assert.ok(signals.confidenceScore < 0.6, `confidence should drop for risky patterns, got ${signals.confidenceScore}`);
  assert.ok(signals.fastGuessRate > 0, `expected fastGuessRate to increase, got ${signals.fastGuessRate}`);
  assert.ok(signals.slowStruggleRate > 0, `expected slowStruggleRate to increase, got ${signals.slowStruggleRate}`);
  assert.ok(Array.isArray(signals.recentBehaviors) && signals.recentBehaviors.length > 0);

  const stableSignalsBefore = {
    baselineLatencyMs: 2100,
    confidenceScore: 0.72,
    fastGuessRate: 0.1,
    slowStruggleRate: 0.05,
    recentBehaviors: ['steady_correct'],
    updatedAt: '2026-08-07T00:00:00.000Z',
  };
  const malformedState = {
    userId: 'user-2',
    adaptiveProfile: {
      behaviorSignals: { ...stableSignalsBefore },
    },
  };
  const malformedUpdate = updateBehaviorSignals(malformedState, {
    attempts: [
      { latencyMs: 100, correctness: null },
      { latencyMs: 200, correctness: 'maybe' },
      { latencyMs: 300, correctness: '' },
    ],
  });

  assert.deepStrictEqual(
    malformedUpdate,
    stableSignalsBefore,
    'malformed correctness payloads should be ignored and keep prior behavior signals'
  );

  console.log('behavior analytics tests passed');
}

run();
