function clampNumber(value, min, max, fallback = min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function asBoundedNumber(value, min, max, fallback = 0) {
  const n = Number(value);
  if (Number.isNaN(n) || !Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function asNonNegativeNumber(value, fallback = 0) {
  const n = Number(value);
  if (Number.isNaN(n) || !Number.isFinite(n)) return fallback;
  return Math.max(n, 0);
}

function normalizeCorrectness(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'correct', 'correctly'].includes(trimmed)) return true;
    if (['false', '0', 'no', 'n', 'incorrect', 'wrong'].includes(trimmed)) return false;
  }
  return false;
}

function isKnownCorrectness(value) {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return false;
    return ['true', '1', 'yes', 'y', 'correct', 'correctly', 'false', '0', 'no', 'n', 'incorrect', 'wrong'].includes(trimmed);
  }
  return false;
}

function normalizeCorrectRate(value, fallback = 0.5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return asBoundedNumber(fallback, 0, 1, 0.5);
  if (n > 1) return asBoundedNumber(n / 100, 0, 1, fallback);
  return asBoundedNumber(n, 0, 1, fallback);
}

function inferTargetLevelFromAbilityScore(abilityScore) {
  const score = asBoundedNumber(abilityScore, 0, 100, 0);
  if (score < 50) return 'A1';
  if (score < 65) return 'A2';
  if (score < 80) return 'B1';
  if (score < 90) return 'B2';
  if (score < 96) return 'C1';
  return 'C2';
}

function difficultyBandFromAbilityScore(abilityScore) {
  const score = asBoundedNumber(abilityScore, 0, 100, 0);
  if (score < 50) return { min: 1, max: 2 };
  if (score < 65) return { min: 2, max: 3 };
  if (score < 80) return { min: 3, max: 4 };
  if (score < 90) return { min: 3, max: 5 };
  if (score < 96) return { min: 4, max: 5 };
  return { min: 5, max: 5 };
}

function normalizeItemDifficulty(itemDifficulty) {
  const bounded = asBoundedNumber(itemDifficulty, 1, 5, 3);
  return Number((((bounded - 1) / 4) * 100).toFixed(2));
}

function expectedSuccess(ability, itemDifficulty) {
  const a = asBoundedNumber(ability, 0, 100, 0);
  const d = asBoundedNumber(itemDifficulty, 0, 100, 50);
  const z = (a - d) / 12;
  const p = 1 / (1 + Math.exp(-z));
  return Number(clampNumber(p, 0.01, 0.99, 0.5).toFixed(4));
}

function updateAbilityEstimate(userState, answerQuality = {}, latencyMs = 0) {
  if (!userState || typeof userState !== 'object') return null;
  const adaptive = userState.adaptiveProfile && typeof userState.adaptiveProfile === 'object'
    ? userState.adaptiveProfile
    : {
        targetLevel: 'A1',
        abilityScore: 0,
        difficultyBand: { min: 1, max: 2 },
        behaviorSignals: { baselineLatencyMs: 2200 },
      };

  const previousAbility = asBoundedNumber(adaptive.abilityScore, 0, 100, 0);
  const itemDifficulty = asBoundedNumber(answerQuality.itemDifficulty, 0, 100, 50);
  if (!isKnownCorrectness(answerQuality.correctness)) {
    return {
      previousAbility,
      nextAbility: Number(previousAbility.toFixed(2)),
      delta: 0,
      expected: expectedSuccess(previousAbility, itemDifficulty),
      observed: null,
      itemDifficulty,
      ignored: true,
    };
  }

  const probability = expectedSuccess(previousAbility, itemDifficulty);
  const observed = normalizeCorrectness(answerQuality.correctness) ? 1 : 0;
  const baselineLatency = Math.max(asNonNegativeNumber(adaptive?.behaviorSignals?.baselineLatencyMs, 2200), 400);
  const safeLatency = Math.max(0, Number(latencyMs || 0));
  const latencyRatio = safeLatency > 0 ? safeLatency / baselineLatency : 1;

  let observedQuality = observed;
  if (observed && latencyRatio >= 1.35) observedQuality -= 0.12;
  if (!observed && latencyRatio <= 0.6) observedQuality -= 0.08;

  const learningRate = clampNumber(answerQuality.learningRate, 0.04, 0.22, 0.11);
  const residual = observedQuality - probability;
  const delta = residual * (learningRate * 18);
  const nextAbility = asBoundedNumber(previousAbility + delta, 0, 100, previousAbility);
  const nextBand = difficultyBandFromAbilityScore(nextAbility);

  userState.adaptiveProfile = {
    ...adaptive,
    targetLevel: inferTargetLevelFromAbilityScore(nextAbility),
    abilityScore: Number(nextAbility.toFixed(2)),
    difficultyBand: nextBand,
  };

  return {
    previousAbility,
    nextAbility: Number(nextAbility.toFixed(2)),
    delta: Number(delta.toFixed(4)),
    expected: probability,
    observed: Number(observedQuality.toFixed(4)),
    itemDifficulty,
  };
}

function updateItemDifficulty(wordState, answerCorrectness, populationStats = {}) {
  if (!wordState || typeof wordState !== 'object') return null;

  const hasNormalized = Number.isFinite(Number(wordState?.adaptiveMetrics?.itemDifficulty));
  const previousDifficulty = hasNormalized
    ? asBoundedNumber(wordState.adaptiveMetrics.itemDifficulty, 0, 100, 50)
    : normalizeItemDifficulty(wordState.difficulty);

  if (!isKnownCorrectness(answerCorrectness)) {
    return {
      previousDifficulty,
      nextDifficulty: Number(previousDifficulty.toFixed(2)),
      delta: 0,
      observedCorrect: null,
      referenceCorrectRate: Number(normalizeCorrectRate(populationStats.correctRate, 0.5).toFixed(4)),
      ignored: true,
    };
  }

  const observedCorrect = normalizeCorrectness(answerCorrectness) ? 1 : 0;
  const referenceCorrectRate = normalizeCorrectRate(
    populationStats.correctRate,
    observedCorrect ? 0.7 : 0.3
  );
  const sampleSize = asNonNegativeNumber(populationStats.sampleSize, 1);
  const confidence = clampNumber(sampleSize / 80, 0.05, 1);

  // If learners underperform relative to expectation, increase item difficulty.
  const residual = referenceCorrectRate - observedCorrect;
  const delta = residual * (10 * confidence);
  const nextDifficulty = asBoundedNumber(previousDifficulty + delta, 0, 100, previousDifficulty);
  const mappedDifficulty = Number((1 + (nextDifficulty / 100) * 4).toFixed(2));

  wordState.difficulty = asBoundedNumber(mappedDifficulty, 1, 5, 3);
  wordState.adaptiveMetrics = {
    ...(wordState.adaptiveMetrics && typeof wordState.adaptiveMetrics === 'object' ? wordState.adaptiveMetrics : {}),
    itemDifficulty: Number(nextDifficulty.toFixed(2)),
  };

  return {
    previousDifficulty,
    nextDifficulty: Number(nextDifficulty.toFixed(2)),
    delta: Number(delta.toFixed(4)),
    observedCorrect,
    referenceCorrectRate: Number(referenceCorrectRate.toFixed(4)),
  };
}

module.exports = {
  inferTargetLevelFromAbilityScore,
  difficultyBandFromAbilityScore,
  isKnownCorrectness,
  normalizeItemDifficulty,
  expectedSuccess,
  updateAbilityEstimate,
  updateItemDifficulty,
};
